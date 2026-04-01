"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  buildCppMainTemplate,
  buildMainJavaTemplate,
  buildPythonMainTemplate,
  hasCppMainMethod,
  hasJavaMainMethod,
  inferJavaClassName,
  countTests,
  CPP_FILENAME_PATTERN,
  JAVA_FILENAME_PATTERN,
  PYTHON_FILENAME_PATTERN,
  type FileRole,
} from "@/lib/languages";

import type {
  Activity,
  Problem,
  CodeFiles,
  ProblemStatus,
  FeedbackState,
  JudgeResult,
  RunResult,
  PersistedTimerStateV1,
} from "./types";

import {
  clampNumber,
  requireActivitiesApi,
  requireJudgeApi,
  getProblemLanguage,
  isJudgeResult,
  formatTime,
} from "./utils";

import LeftPane from "./components/LeftPane";
import CenterPane from "./components/CenterPane";
import RightPane from "./components/RightPane";

/* ─── Layout constants ─── */
const LAYOUT_DEFAULTS = { leftWidth: 320, rightWidth: 340, rightTopHeight: 190 };
const SPLITTER_W = 10;
const MIN_LEFT = 280;
const MIN_RIGHT = 300;
const MIN_CENTER = 520;

export default function ActivityPage() {
  const params = useParams<{ id: string }>();
  const activityId = params.id;
  const router = useRouter();

  /* ─── Refs ─── */
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);

  /* ─── Core state ─── */
  const [activity, setActivity] = useState<Activity | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedProblemId, setSelectedProblemId] = useState<string | null>(null);
  const [files, setFiles] = useState<CodeFiles>({
    "Solution.java": "public class Solution {\n}\n",
    "Main.java": buildMainJavaTemplate("Solution"),
  });
  const [fileRoles, setFileRoles] = useState<Record<string, FileRole>>({
    "Solution.java": "support",
    "Main.java": "entry",
  });
  const [activeFilename, setActiveFilename] = useState<string>("Solution.java");
  const [entrypointClass, setEntrypointClass] = useState<string>("Main");
  const [problemStatusById, setProblemStatusById] = useState<Record<string, ProblemStatus>>({});
  const [feedback, setFeedback] = useState<FeedbackState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [running, setRunning] = useState(false);

  /* ─── Timer state ─── */
  const [timeLimitSeconds, setTimeLimitSeconds] = useState<number | null>(null);
  const [timerMode, setTimerMode] = useState<"countup" | "countdown">("countup");
  const [isTimerRunning, setIsTimerRunning] = useState(false);
  const [timerBaseSeconds, setTimerBaseSeconds] = useState(0);
  const [timerStartedAtMs, setTimerStartedAtMs] = useState<number | null>(null);
  const [timerSeconds, setTimerSeconds] = useState(0);

  /* ─── Layout state ─── */
  const [leftPaneWidth, setLeftPaneWidth] = useState<number>(LAYOUT_DEFAULTS.leftWidth);
  const [rightPaneWidth, setRightPaneWidth] = useState<number>(LAYOUT_DEFAULTS.rightWidth);

  const dragRef = useRef<{
    kind: "left" | "right";
    startX: number;
    startLeft: number;
    startRight: number;
  } | null>(null);

  /* ─── File management modals ─── */
  const [addFileOpen, setAddFileOpen] = useState(false);
  const [addFileName, setAddFileName] = useState("");
  const [addFileError, setAddFileError] = useState<string | null>(null);
  const addFileInputRef = useRef<HTMLInputElement | null>(null);
  const [deleteFileOpen, setDeleteFileOpen] = useState(false);
  const [deleteFileName, setDeleteFileName] = useState<string>("");
  const [deleteFileError, setDeleteFileError] = useState<string | null>(null);

  /* ─── Workspace refs (perf) ─── */
  const workspacesRef = useRef<
    Record<string, { files: CodeFiles; fileRoles: Record<string, FileRole>; activeFilename: string; entrypointClass: string }>
  >({});
  const selectedProblemIdRef = useRef<string | null>(null);
  const filesRef = useRef<CodeFiles>(files);
  const fileRolesRef = useRef<Record<string, FileRole>>(fileRoles);
  const activeFilenameRef = useRef<string>(activeFilename);
  const entrypointClassRef = useRef<string>(entrypointClass);
  const userCreatedFilesByProblemIdRef = useRef<Record<string, Set<string>>>({});

  /* ─── Ref sync ─── */
  useEffect(() => { selectedProblemIdRef.current = selectedProblemId; }, [selectedProblemId]);
  useEffect(() => { filesRef.current = files; }, [files]);
  useEffect(() => { fileRolesRef.current = fileRoles; }, [fileRoles]);
  useEffect(() => { activeFilenameRef.current = activeFilename; }, [activeFilename]);
  useEffect(() => { entrypointClassRef.current = entrypointClass; }, [entrypointClass]);

  /* ─── Layout persistence ─── */
  useEffect(() => {
    if (!activityId) return;
    const key = `codemm-activity-layout:v1:${activityId}`;
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.v !== 1) return;
      if (typeof parsed.leftWidth === "number" && Number.isFinite(parsed.leftWidth)) setLeftPaneWidth(parsed.leftWidth);
      if (typeof parsed.rightWidth === "number" && Number.isFinite(parsed.rightWidth)) setRightPaneWidth(parsed.rightWidth);
    } catch { /* ignore */ }
  }, [activityId]);

  useEffect(() => {
    if (!activityId) return;
    const key = `codemm-activity-layout:v1:${activityId}`;
    const id = window.setTimeout(() => {
      try {
        localStorage.setItem(key, JSON.stringify({
          v: 1,
          leftWidth: Math.round(leftPaneWidth),
          rightWidth: Math.round(rightPaneWidth),
        }));
      } catch { /* ignore */ }
    }, 150);
    return () => window.clearTimeout(id);
  }, [activityId, leftPaneWidth, rightPaneWidth]);

  /* ─── Modal focus / cleanup ─── */
  useEffect(() => {
    if (!addFileOpen) return;
    const id = window.setTimeout(() => addFileInputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [addFileOpen]);

  useEffect(() => {
    setAddFileOpen(false); setAddFileName(""); setAddFileError(null);
    setDeleteFileOpen(false); setDeleteFileName(""); setDeleteFileError(null);
  }, [selectedProblemId]);

  /* ─── Workspace helpers ─── */
  function ensureUserCreatedSet(problemId: string) {
    if (!userCreatedFilesByProblemIdRef.current[problemId]) {
      userCreatedFilesByProblemIdRef.current[problemId] = new Set<string>();
    }
    return userCreatedFilesByProblemIdRef.current[problemId]!;
  }

  function loadProblemIntoWorkspace(problem: Problem) {
    const lang = getProblemLanguage(problem);
    const starterCode =
      problem.starter_code ||
      problem.classSkeleton ||
      (lang === "python"
        ? "def solve(x):\n    # TODO: implement\n    raise NotImplementedError\n"
        : lang === "cpp"
        ? "#include <bits/stdc++.h>\n\n// Implement solve(...) below.\nauto solve(auto x) { (void)x; return 0; }\n"
        : lang === "sql"
        ? "-- Write a single SELECT query.\nSELECT 1;\n"
        : "public class Solution {\n}\n");

    if (problem.workspace && Array.isArray(problem.workspace.files) && problem.workspace.files.length > 0) {
      const nextFiles: CodeFiles = {};
      const nextRoles: Record<string, FileRole> = {};
      for (const f of problem.workspace.files) {
        nextFiles[f.path] = f.content;
        nextRoles[f.path] = f.role;
      }
      const entryClass = problem.workspace.entrypoint ?? "Main";
      const firstEditable = problem.workspace.files.find((f) => f.role !== "readonly")?.path ?? problem.workspace.files[0]!.path;
      return { files: nextFiles, fileRoles: nextRoles, entrypointClass: entryClass, activeFilename: firstEditable };
    }

    if (lang === "python") {
      return {
        files: { "solution.py": starterCode, "main.py": buildPythonMainTemplate() },
        fileRoles: { "solution.py": "support" as FileRole, "main.py": "entry" as FileRole },
        entrypointClass: "main.py",
        activeFilename: "solution.py",
      };
    }
    if (lang === "cpp") {
      return {
        files: { "solution.cpp": starterCode, "main.cpp": buildCppMainTemplate() },
        fileRoles: { "solution.cpp": "support" as FileRole, "main.cpp": "entry" as FileRole },
        entrypointClass: "main.cpp",
        activeFilename: "solution.cpp",
      };
    }
    if (lang === "sql") {
      return {
        files: { "solution.sql": starterCode },
        fileRoles: { "solution.sql": "support" as FileRole },
        entrypointClass: "solution.sql",
        activeFilename: "solution.sql",
      };
    }
    const primaryClassName = inferJavaClassName(starterCode, "Solution");
    const primaryFilename = `${primaryClassName}.java`;
    return {
      files: { [primaryFilename]: starterCode, "Main.java": buildMainJavaTemplate(primaryClassName) },
      fileRoles: { [primaryFilename]: "support" as FileRole, "Main.java": "entry" as FileRole },
      entrypointClass: "Main",
      activeFilename: primaryFilename,
    };
  }

  function saveActiveWorkspace(problemId: string) {
    workspacesRef.current[problemId] = {
      files: filesRef.current,
      fileRoles: fileRolesRef.current,
      activeFilename: activeFilenameRef.current,
      entrypointClass: entrypointClassRef.current,
    };
  }

  function restoreWorkspace(problem: Problem) {
    const existing = workspacesRef.current[problem.id];
    const ws = existing ?? loadProblemIntoWorkspace(problem);
    if (!existing) workspacesRef.current[problem.id] = ws;
    setFiles(ws.files);
    setFileRoles(ws.fileRoles);
    setActiveFilename(ws.activeFilename);
    setEntrypointClass(ws.entrypointClass);
  }

  /* ─── Timer ─── */
  function timerStorageKey(problemId: string): string {
    return `codem-activity-timer:v1:${activityId}:${problemId}`;
  }

  function persistTimer(problemId: string, next: PersistedTimerStateV1) {
    try { localStorage.setItem(timerStorageKey(problemId), JSON.stringify(next)); } catch { /* ignore */ }
  }

  function computeTimerSeconds(nowMs: number): number {
    if (!isTimerRunning || timerStartedAtMs == null) return timerBaseSeconds;
    const elapsed = Math.max(0, Math.floor((nowMs - timerStartedAtMs) / 1000));
    return timerMode === "countdown" ? Math.max(0, timerBaseSeconds - elapsed) : timerBaseSeconds + elapsed;
  }

  function loadOrStartTimer(problemId: string, limitSeconds: number | null, mode: "countup" | "countdown") {
    const now = Date.now();
    const key = timerStorageKey(problemId);

    let stored: PersistedTimerStateV1 | null = null;
    try { const raw = localStorage.getItem(key); if (raw) stored = JSON.parse(raw); } catch { stored = null; }

    const valid =
      stored && stored.v === 1 &&
      (stored.mode === "countup" || stored.mode === "countdown") &&
      typeof stored.baseSeconds === "number" && Number.isFinite(stored.baseSeconds) &&
      (stored.startedAtMs == null || (typeof stored.startedAtMs === "number" && Number.isFinite(stored.startedAtMs))) &&
      (stored.limitSeconds == null || (typeof stored.limitSeconds === "number" && Number.isFinite(stored.limitSeconds))) &&
      stored.mode === mode && (stored.limitSeconds ?? null) === (limitSeconds ?? null);

    const nextBaseSeconds = valid && typeof stored!.baseSeconds === "number"
      ? Math.max(0, Math.trunc(stored!.baseSeconds))
      : mode === "countdown" && typeof limitSeconds === "number" && limitSeconds > 0 ? limitSeconds : 0;

    const nextStartedAtMs = valid && typeof stored!.startedAtMs === "number" ? Math.trunc(stored!.startedAtMs) : now;

    setTimerMode(mode);
    setTimeLimitSeconds(limitSeconds);
    setTimerBaseSeconds(nextBaseSeconds);
    setTimerStartedAtMs(nextStartedAtMs);
    setIsTimerRunning(true);

    const computed = (() => {
      const elapsed = Math.max(0, Math.floor((now - nextStartedAtMs) / 1000));
      return mode === "countdown" ? Math.max(0, nextBaseSeconds - elapsed) : nextBaseSeconds + elapsed;
    })();
    setTimerSeconds(computed);

    if (mode === "countdown" && computed <= 0) {
      setIsTimerRunning(false);
      setTimerBaseSeconds(0);
      setTimerStartedAtMs(null);
      persistTimer(problemId, { v: 1, mode, limitSeconds, baseSeconds: 0, startedAtMs: null });
      return;
    }
    persistTimer(problemId, { v: 1, mode, limitSeconds, baseSeconds: nextBaseSeconds, startedAtMs: nextStartedAtMs });
  }

  /* ─── Problem selection ─── */
  function selectProblem(problem: Problem) {
    const prevId = selectedProblemIdRef.current;
    if (prevId && prevId !== problem.id) saveActiveWorkspace(prevId);
    setSelectedProblemId(problem.id);
    restoreWorkspace(problem);
    const limit = typeof timeLimitSeconds === "number" ? timeLimitSeconds : null;
    const mode: "countup" | "countdown" = typeof limit === "number" && limit > 0 ? "countdown" : "countup";
    loadOrStartTimer(problem.id, limit, mode);
  }

  /* ─── Load activity ─── */
  useEffect(() => {
    async function load() {
      try {
        setLoadError(null);
        workspacesRef.current = {};
        userCreatedFilesByProblemIdRef.current = {};
        setFeedback(null);

        const data = await requireActivitiesApi().get({ id: activityId });
        const act = data?.activity as Activity | undefined;
        if (!act) { setLoadError("Activity not found."); return; }

        setActivity(act);
        setProblemStatusById(Object.fromEntries(act.problems.map((p) => [p.id, "not_started" as ProblemStatus])));
        if (act.problems.length > 0) {
          const first = act.problems[0];
          setSelectedProblemId(first.id);
          restoreWorkspace(first);
        }

        const limit = typeof act.timeLimitSeconds === "number" ? act.timeLimitSeconds : null;
        const mode: "countup" | "countdown" = typeof limit === "number" && limit > 0 ? "countdown" : "countup";
        if (act.problems.length > 0) {
          loadOrStartTimer(act.problems[0]!.id, limit, mode);
        } else {
          setTimeLimitSeconds(limit);
          setTimerMode(mode);
          setTimerBaseSeconds(0);
          setTimerSeconds(0);
          setIsTimerRunning(false);
        }
      } catch (e) {
        console.error(e);
        setLoadError("Failed to load activity.");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [activityId]);

  /* ─── Timer tick ─── */
  useEffect(() => {
    if (!isTimerRunning) return;
    const tick = () => {
      const now = Date.now();
      const next = computeTimerSeconds(now);
      setTimerSeconds(next);
      if (timerMode === "countdown" && next <= 0) {
        setIsTimerRunning(false);
        setTimerBaseSeconds(0);
        setTimerStartedAtMs(null);
        if (selectedProblemId) {
          persistTimer(selectedProblemId, { v: 1, mode: "countdown", limitSeconds: timeLimitSeconds ?? null, baseSeconds: 0, startedAtMs: null });
        }
      }
    };
    tick();
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [isTimerRunning, timerMode, timerStartedAtMs, timerBaseSeconds, selectedProblemId, timeLimitSeconds]);

  /* ─── Derived ─── */
  const selectedProblem = activity?.problems.find((p) => p.id === selectedProblemId);
  const isGuidedActivity = Boolean(activity?.problems.some((p) => p.pedagogy && typeof p.pedagogy.scaffold_level === "number"));
  const selectedLanguage = getProblemLanguage(selectedProblem);
  const testSuite = selectedProblem?.test_suite || selectedProblem?.testSuite || "";
  const activeCode = files[activeFilename] ?? "";
  const entryFile =
    selectedLanguage === "python" ? "main.py"
    : selectedLanguage === "cpp" ? "main.cpp"
    : selectedLanguage === "sql" ? "solution.sql"
    : Object.entries(fileRoles).find(([, role]) => role === "entry")?.[0] ?? "Main.java";
  const entrySource = files[entryFile] ?? "";
  const canRunMain =
    selectedLanguage === "python" ? true
    : selectedLanguage === "cpp" ? hasCppMainMethod(entrySource)
    : selectedLanguage === "sql" ? false
    : hasJavaMainMethod(entrySource);
  const isActiveReadonly = fileRoles[activeFilename] === "readonly";

  const problemIndex = activity ? Math.max(0, activity.problems.findIndex((p) => p.id === selectedProblemId)) : 0;
  const currentStatus: ProblemStatus = (selectedProblemId && problemStatusById[selectedProblemId]) || "not_started";

  /* ─── Handlers ─── */
  async function handleRun() {
    if (!selectedProblem) return;
    if (selectedLanguage === "sql") {
      setFeedback({ problemId: selectedProblem.id, kind: "run", atIso: new Date().toISOString(), result: { stdout: "", stderr: 'SQL activities are graded via "Check Code".' } });
      return;
    }
    if (!canRunMain && selectedLanguage !== "python") {
      const mainSig = selectedLanguage === "cpp" ? "int main(...)" : "`public static void main(String[] args)`";
      setFeedback({ problemId: selectedProblem.id, kind: "run", atIso: new Date().toISOString(), result: { stdout: "", stderr: `No ${mainSig} detected in ${entryFile}.\n\nUse "Check Code" to run tests, or add a main() entrypoint.` } });
      return;
    }
    setRunning(true);
    try {
      const sampleIns = selectedProblem.sample_inputs || selectedProblem.sampleInputs || [];
      const stdin = sampleIns.length > 0 ? String(sampleIns[0]) : undefined;
      const data = await requireJudgeApi().run({
        files,
        ...(selectedLanguage === "java" ? { mainClass: entrypointClass || "Main" } : {}),
        ...(typeof stdin === "string" ? { stdin } : {}),
        language: selectedLanguage,
      });
      if (!data || typeof data !== "object") {
        setFeedback({ problemId: selectedProblem.id, kind: "run", atIso: new Date().toISOString(), result: { stdout: "", stderr: "Failed to run code (invalid response)." } });
        return;
      }
      const runResult: RunResult = {
        stdout: typeof data.stdout === "string" ? data.stdout : "",
        stderr: typeof data.stderr === "string" ? data.stderr : typeof data.error === "string" ? data.error : "",
      };
      setFeedback({ problemId: selectedProblem.id, kind: "run", atIso: new Date().toISOString(), result: runResult });
      setProblemStatusById((prev) => {
        const cur = prev[selectedProblem.id] ?? "not_started";
        if (cur === "not_started") return { ...prev, [selectedProblem.id]: "in_progress" };
        return prev;
      });
    } catch (e) {
      console.error(e);
      setFeedback({ problemId: selectedProblem.id, kind: "run", atIso: new Date().toISOString(), result: { stdout: "", stderr: "Failed to run code. Please try again." } });
    } finally {
      setRunning(false);
    }
  }

  async function handleRunTests() {
    if (!selectedProblem) return;
    setSubmitting(true);
    try {
      const ts = selectedProblem.test_suite || selectedProblem.testSuite || "";
      const filesForTests = Object.fromEntries(
        Object.entries(files).filter(([filename]) => {
          if (fileRoles[filename] === "readonly") return false;
          if (selectedLanguage !== "cpp") return true;
          if (filename.endsWith(".cpp")) return filename === "solution.cpp";
          return true;
        })
      );
      const data = await requireJudgeApi().submit({
        files: filesForTests,
        testSuite: ts,
        activityId,
        problemId: selectedProblem.id,
        language: selectedLanguage,
      });
      const safeResult: JudgeResult = {
        success: Boolean(data.success),
        passedTests: Array.isArray(data.passedTests) ? data.passedTests : [],
        failedTests: Array.isArray(data.failedTests) ? data.failedTests : [],
        stdout: typeof data.stdout === "string" ? data.stdout : "",
        stderr: typeof data.stderr === "string" ? data.stderr : typeof data.error === "string" ? data.error : "",
        executionTimeMs: typeof data.executionTimeMs === "number" ? data.executionTimeMs : 0,
        exitCode: typeof data.exitCode === "number" ? data.exitCode : undefined,
        timedOut: typeof data.timedOut === "boolean" ? data.timedOut : undefined,
        testCaseDetails: Array.isArray(data.testCaseDetails) ? data.testCaseDetails : undefined,
      };
      setFeedback({ problemId: selectedProblem.id, kind: "tests", atIso: new Date().toISOString(), result: safeResult });
      setProblemStatusById((prev) => ({
        ...prev,
        [selectedProblem.id]: safeResult.success && !safeResult.timedOut ? "passed" : "failed",
      }));
      setIsTimerRunning(false);
    } catch (e) {
      console.error(e);
    } finally {
      setSubmitting(false);
    }
  }

  /* ─── File management ─── */
  function tryAddFile(name: string): { ok: true } | { ok: false; error: string } {
    const pattern =
      selectedLanguage === "python" ? PYTHON_FILENAME_PATTERN
      : selectedLanguage === "cpp" ? CPP_FILENAME_PATTERN
      : JAVA_FILENAME_PATTERN;
    if (!pattern.test(name)) {
      const error =
        selectedLanguage === "python" ? 'Invalid filename. Use something like "utils.py".'
        : selectedLanguage === "cpp" ? 'Invalid filename. Use something like "helper.hpp" or "helper.cpp".'
        : 'Invalid filename. Use something like "Helper.java".';
      return { ok: false, error };
    }
    if (Object.prototype.hasOwnProperty.call(files, name)) {
      activeFilenameRef.current = name;
      setActiveFilename(name);
      return { ok: true };
    }
    const className = name.replace(/\.[A-Za-z0-9_]+$/i, "");
    const skeleton =
      selectedLanguage === "python" ? `# ${className}.py\n\n`
      : selectedLanguage === "cpp" ? (name.endsWith(".cpp") ? `#include <bits/stdc++.h>\n\n` : `#pragma once\n\n`)
      : `public class ${className} {\n\n}\n`;
    setFiles((prev) => { const n = { ...prev, [name]: skeleton }; filesRef.current = n; return n; });
    setFileRoles((prev) => { const n: Record<string, FileRole> = { ...prev, [name]: "support" }; fileRolesRef.current = n; return n; });
    activeFilenameRef.current = name;
    setActiveFilename(name);
    const pid = selectedProblemIdRef.current;
    if (pid) ensureUserCreatedSet(pid).add(name);
    return { ok: true };
  }

  function handleConfirmAddFile() {
    const name = addFileName.trim();
    if (!name) { setAddFileError("Enter a filename."); return; }
    const res = tryAddFile(name);
    if (res.ok) { setAddFileOpen(false); setAddFileName(""); setAddFileError(null); return; }
    setAddFileError(res.error);
  }

  function isFileDeletable(filename: string): boolean {
    const pid = selectedProblemIdRef.current;
    if (!pid) return false;
    const role = fileRolesRef.current[filename];
    if (role === "entry" || role === "readonly") return false;
    return ensureUserCreatedSet(pid).has(filename);
  }

  function commitDeleteFile() {
    const pid = selectedProblemIdRef.current;
    const name = deleteFileName.trim();
    if (!pid || !name) { setDeleteFileError("Nothing to delete."); return; }
    if (!isFileDeletable(name)) { setDeleteFileError("You can only delete files you created."); return; }
    const prevFiles = filesRef.current;
    const prevRoles = fileRolesRef.current;
    if (!Object.prototype.hasOwnProperty.call(prevFiles, name)) { setDeleteFileOpen(false); return; }
    const nextFiles: CodeFiles = { ...prevFiles }; delete nextFiles[name];
    const nextRoles: Record<string, FileRole> = { ...prevRoles }; delete nextRoles[name];
    filesRef.current = nextFiles; fileRolesRef.current = nextRoles;
    setFiles(nextFiles); setFileRoles(nextRoles);
    const remaining = Object.keys(nextFiles);
    const currentActive = activeFilenameRef.current;
    let nextActive = currentActive;
    if (!Object.prototype.hasOwnProperty.call(nextFiles, currentActive)) {
      nextActive = remaining.find((f) => nextRoles[f] === "support") ?? remaining.find((f) => nextRoles[f] === "entry") ?? remaining[0] ?? "";
    }
    if (nextActive) { activeFilenameRef.current = nextActive; setActiveFilename(nextActive); }
    ensureUserCreatedSet(pid).delete(name);
    setDeleteFileOpen(false); setDeleteFileName(""); setDeleteFileError(null);
  }

  /* ─── Drag handlers ─── */
  function beginDrag(kind: "left" | "right", e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { kind, startX: e.clientX, startLeft: leftPaneWidth, startRight: rightPaneWidth };
  }

  function onDrag(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const containerWidth = layoutRef.current?.getBoundingClientRect().width ?? window.innerWidth;
    if (drag.kind === "left") {
      const deltaX = e.clientX - drag.startX;
      const maxLeft = Math.max(MIN_LEFT, containerWidth - MIN_CENTER - drag.startRight - SPLITTER_W * 2);
      setLeftPaneWidth(clampNumber(drag.startLeft + deltaX, MIN_LEFT, maxLeft));
    } else {
      const deltaX = e.clientX - drag.startX;
      const maxRight = Math.max(MIN_RIGHT, containerWidth - MIN_CENTER - drag.startLeft - SPLITTER_W * 2);
      setRightPaneWidth(clampNumber(drag.startRight - deltaX, MIN_RIGHT, maxRight));
    }
  }

  function endDrag(e: React.PointerEvent) {
    if (!dragRef.current) return;
    e.preventDefault(); e.stopPropagation();
    dragRef.current = null;
  }

  /* ─── CenterPane callbacks ─── */
  const handleFileSelect = useCallback((filename: string) => {
    activeFilenameRef.current = filename;
    setActiveFilename(filename);
  }, []);

  const handleCodeChange = useCallback((filename: string, value: string) => {
    if (fileRolesRef.current[filename] === "readonly") return;
    setFiles((prev) => { const n = { ...prev, [filename]: value }; filesRef.current = n; return n; });
    const pid = selectedProblemIdRef.current;
    if (pid) {
      setProblemStatusById((prev) => {
        const cur = prev[pid] ?? "not_started";
        if (cur === "passed" || cur === "failed" || cur === "not_started") return { ...prev, [pid]: "in_progress" };
        return prev;
      });
    }
  }, []);

  const handleAddFileClick = useCallback(() => {
    setAddFileError(null); setAddFileName(""); setAddFileOpen(true);
  }, []);

  const handleDeleteFileClick = useCallback((filename: string) => {
    if (!isFileDeletable(filename)) return;
    setDeleteFileError(null); setDeleteFileName(filename); setDeleteFileOpen(true);
  }, []);

  /* ─── Loading / error states ─── */
  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50 text-slate-900">
        <div className="rounded-lg bg-white px-4 py-3 text-sm shadow">Loading activity...</div>
      </div>
    );
  }

  if (!activity) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50 text-slate-900">
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-4 shadow">
          <div className="text-sm font-semibold text-slate-900">Couldn't open this activity</div>
          <div className="mt-1 text-sm text-slate-600">{loadError ?? "Activity not found."}</div>
          <div className="mt-4 flex gap-2">
            <button onClick={() => (window.location.href = "/")} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
              Home
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* ─── RENDER ─── */
  return (
    <div className="h-screen w-full overflow-hidden bg-slate-50 text-slate-900">
      <style jsx global>{`
        .codem-student-todo-bg { background: rgba(250, 204, 21, 0.12); }
        .codem-student-todo-gutter { border-left: 3px solid rgba(250, 204, 21, 0.9); }
      `}</style>

      <div className="flex h-screen w-full flex-col">
        {/* ─── Header ─── */}
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2.5">
          <div className="flex items-center gap-3">
            <button
              onClick={() => (window.location.href = "/")}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              Home
            </button>
            <div className="h-4 w-px bg-slate-200" />
            <div>
              <h1 className="text-sm font-semibold tracking-tight text-slate-900">{activity.title}</h1>
              <p className="text-[11px] text-slate-500">
                {isGuidedActivity ? "Guided" : "Practice"} &middot; {activity.problems.length} problems
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {activity.status === "DRAFT" && (
              <button
                onClick={() => router.push(`/activity/${activityId}/review`)}
                className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
              >
                Draft
              </button>
            )}
            <div className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-700">
              {problemIndex + 1}/{activity.problems.length}
            </div>
            <div className={`rounded-lg px-3 py-1.5 text-xs font-mono font-medium ${
              timerMode === "countdown" && timerSeconds < 60
                ? "bg-rose-50 text-rose-700"
                : "bg-slate-100 text-slate-700"
            }`}>
              {timerMode === "countdown" ? "Left " : ""}{formatTime(timerSeconds)}
            </div>
          </div>
        </header>

        {/* ─── Three-pane layout ─── */}
        <main ref={layoutRef} className="flex flex-1 min-h-0">
          {/* Left pane */}
          <section
            className="min-h-0 overflow-hidden border-r border-slate-200 bg-white p-4"
            style={{ width: leftPaneWidth }}
          >
            <LeftPane
              problem={selectedProblem}
              problemIndex={problemIndex}
              totalProblems={activity.problems.length}
              status={currentStatus}
            />
          </section>

          {/* Drag: left/center */}
          <div
            className="group flex w-[8px] shrink-0 cursor-col-resize items-stretch bg-slate-50 hover:bg-blue-50 transition-colors"
            onPointerDown={(e) => beginDrag("left", e)}
            onPointerMove={onDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <div className="mx-auto my-6 w-[2px] rounded-full bg-slate-200 group-hover:bg-blue-400 transition-colors" />
          </div>

          {/* Center pane */}
          <section className="flex min-h-0 min-w-[520px] flex-1 flex-col bg-white p-4">
            <CenterPane
              files={files}
              fileRoles={fileRoles}
              activeFilename={activeFilename}
              selectedLanguage={selectedLanguage}
              isActiveReadonly={isActiveReadonly}
              canRunMain={canRunMain}
              entryFile={entryFile}
              running={running}
              submitting={submitting}
              feedback={feedback}
              onFileSelect={handleFileSelect}
              onCodeChange={handleCodeChange}
              onRun={handleRun}
              onCheckCode={handleRunTests}
              onAddFile={handleAddFileClick}
              onDeleteFile={handleDeleteFileClick}
              isFileDeletable={isFileDeletable}
            />
          </section>

          {/* Drag: center/right */}
          <div
            className="group flex w-[8px] shrink-0 cursor-col-resize items-stretch bg-slate-50 hover:bg-blue-50 transition-colors"
            onPointerDown={(e) => beginDrag("right", e)}
            onPointerMove={onDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <div className="mx-auto my-6 w-[2px] rounded-full bg-slate-200 group-hover:bg-blue-400 transition-colors" />
          </div>

          {/* Right pane */}
          <section
            className="min-h-0 overflow-hidden border-l border-slate-200 bg-white p-4"
            style={{ width: rightPaneWidth }}
          >
            <RightPane
              activity={activity}
              selectedProblemId={selectedProblemId}
              problemStatusById={problemStatusById}
              feedback={feedback}
              selectedLanguage={selectedLanguage}
              testSuite={testSuite}
              onSelectProblem={selectProblem}
              onClearFeedback={() => setFeedback(null)}
              onRunAllTests={handleRunTests}
              submitting={submitting}
            />
          </section>
        </main>
      </div>

      {/* ─── Add file modal ─── */}
      {addFileOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => { if (e.target === e.currentTarget) { setAddFileOpen(false); setAddFileName(""); setAddFileError(null); } }}
          onKeyDown={(e) => { if (e.key === "Escape") { setAddFileOpen(false); setAddFileName(""); setAddFileError(null); } }}
        >
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-4 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-900">Add file</div>
                <div className="mt-1 text-xs text-slate-600">
                  {selectedLanguage === "python" ? 'Example: "utils.py"' : selectedLanguage === "cpp" ? 'Example: "helper.hpp"' : 'Example: "Helper.java"'}
                </div>
              </div>
              <button
                type="button"
                className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                onClick={() => { setAddFileOpen(false); setAddFileName(""); setAddFileError(null); }}
              >
                Close
              </button>
            </div>
            <div className="mt-4">
              <label className="text-xs font-semibold text-slate-700">Filename</label>
              <input
                ref={addFileInputRef}
                className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
                value={addFileName}
                onChange={(e) => { setAddFileName(e.target.value); if (addFileError) setAddFileError(null); }}
                placeholder={selectedLanguage === "python" ? "utils.py" : selectedLanguage === "cpp" ? "helper.hpp" : "Helper.java"}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleConfirmAddFile(); } }}
                autoCapitalize="none" autoCorrect="off" spellCheck={false}
              />
              {addFileError ? (
                <div className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{addFileError}</div>
              ) : (
                <div className="mt-2 text-[11px] text-slate-500">Letters, numbers, and underscore only.</div>
              )}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                onClick={() => { setAddFileOpen(false); setAddFileName(""); setAddFileError(null); }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-blue-700"
                onClick={handleConfirmAddFile}
              >
                Create file
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Delete file modal ─── */}
      {deleteFileOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => { if (e.target === e.currentTarget) { setDeleteFileOpen(false); setDeleteFileName(""); setDeleteFileError(null); } }}
          onKeyDown={(e) => { if (e.key === "Escape") { setDeleteFileOpen(false); setDeleteFileName(""); setDeleteFileError(null); } }}
        >
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-4 shadow-xl">
            <div className="text-sm font-semibold text-slate-900">Delete file</div>
            <div className="mt-2 text-xs text-slate-600">
              Delete <span className="font-mono">{deleteFileName}</span> from this problem?
            </div>
            {deleteFileError && <div className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{deleteFileError}</div>}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                onClick={() => { setDeleteFileOpen(false); setDeleteFileName(""); setDeleteFileError(null); }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-rose-700"
                onClick={commitDeleteFile}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
