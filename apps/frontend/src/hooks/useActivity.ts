"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  buildCppMainTemplate,
  buildMainJavaTemplate,
  buildPythonMainTemplate,
  hasCppMainMethod,
  hasJavaMainMethod,
  inferJavaClassName,
  CPP_FILENAME_PATTERN,
  JAVA_FILENAME_PATTERN,
  PYTHON_FILENAME_PATTERN,
  type FileRole,
} from "@/lib/languages";
import { activitiesClient } from "@/lib/bridge/activitiesClient";
import { judgeClient } from "@/lib/bridge/judgeClient";
import type {
  Activity,
  CodeFiles,
  FeedbackState,
  JudgeResult,
  PersistedTimerStateV1,
  Problem,
  ProblemStatus,
  RunResult,
} from "@/app/activity/[id]/types";
import { clampNumber, formatTime, getProblemLanguage } from "@/app/activity/[id]/utils";

const LAYOUT_DEFAULTS = { leftWidth: 320, rightWidth: 340, rightTopHeight: 190 };
const SPLITTER_W = 10;
const MIN_LEFT = 280;
const MIN_RIGHT = 300;
const MIN_CENTER = 520;

type TimerMode = "countup" | "countdown";
type DragState = {
  kind: "left" | "right";
  startX: number;
  startLeft: number;
  startRight: number;
} | null;

type WorkspaceState = {
  files: CodeFiles;
  fileRoles: Record<string, FileRole>;
  activeFilename: string;
  entrypointClass: string;
};

export function useActivity() {
  const params = useParams<{ id: string }>();
  const activityId = params.id;
  const router = useRouter();

  const layoutRef = useRef<HTMLDivElement | null>(null);
  const addFileInputRef = useRef<HTMLInputElement | null>(null);
  const dragRef = useRef<DragState>(null);
  const workspacesRef = useRef<Record<string, WorkspaceState>>({});
  const selectedProblemIdRef = useRef<string | null>(null);
  const filesRef = useRef<CodeFiles>({
    "Solution.java": "public class Solution {\n}\n",
    "Main.java": buildMainJavaTemplate("Solution"),
  });
  const fileRolesRef = useRef<Record<string, FileRole>>({
    "Solution.java": "support",
    "Main.java": "entry",
  });
  const activeFilenameRef = useRef<string>("Solution.java");
  const entrypointClassRef = useRef<string>("Main");
  const userCreatedFilesByProblemIdRef = useRef<Record<string, Set<string>>>({});

  const [activity, setActivity] = useState<Activity | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedProblemId, setSelectedProblemId] = useState<string | null>(null);
  const [files, setFiles] = useState<CodeFiles>(filesRef.current);
  const [fileRoles, setFileRoles] = useState<Record<string, FileRole>>(fileRolesRef.current);
  const [activeFilename, setActiveFilename] = useState<string>(activeFilenameRef.current);
  const [entrypointClass, setEntrypointClass] = useState<string>(entrypointClassRef.current);
  const [problemStatusById, setProblemStatusById] = useState<Record<string, ProblemStatus>>({});
  const [feedback, setFeedback] = useState<FeedbackState | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [running, setRunning] = useState(false);

  const [timeLimitSeconds, setTimeLimitSeconds] = useState<number | null>(null);
  const [timerMode, setTimerMode] = useState<TimerMode>("countup");
  const [isTimerRunning, setIsTimerRunning] = useState(false);
  const [timerBaseSeconds, setTimerBaseSeconds] = useState(0);
  const [timerStartedAtMs, setTimerStartedAtMs] = useState<number | null>(null);
  const [timerSeconds, setTimerSeconds] = useState(0);

  const [leftPaneWidth, setLeftPaneWidth] = useState<number>(LAYOUT_DEFAULTS.leftWidth);
  const [rightPaneWidth, setRightPaneWidth] = useState<number>(LAYOUT_DEFAULTS.rightWidth);

  const [addFileOpen, setAddFileOpen] = useState(false);
  const [addFileName, setAddFileName] = useState("");
  const [addFileError, setAddFileError] = useState<string | null>(null);
  const [deleteFileOpen, setDeleteFileOpen] = useState(false);
  const [deleteFileName, setDeleteFileName] = useState<string>("");
  const [deleteFileError, setDeleteFileError] = useState<string | null>(null);

  useEffect(() => {
    selectedProblemIdRef.current = selectedProblemId;
  }, [selectedProblemId]);

  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  useEffect(() => {
    fileRolesRef.current = fileRoles;
  }, [fileRoles]);

  useEffect(() => {
    activeFilenameRef.current = activeFilename;
  }, [activeFilename]);

  useEffect(() => {
    entrypointClassRef.current = entrypointClass;
  }, [entrypointClass]);

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
    } catch {
      // ignore
    }
  }, [activityId]);

  useEffect(() => {
    if (!activityId) return;
    const key = `codemm-activity-layout:v1:${activityId}`;
    const timeoutId = window.setTimeout(() => {
      try {
        localStorage.setItem(
          key,
          JSON.stringify({
            v: 1,
            leftWidth: Math.round(leftPaneWidth),
            rightWidth: Math.round(rightPaneWidth),
          }),
        );
      } catch {
        // ignore
      }
    }, 150);
    return () => window.clearTimeout(timeoutId);
  }, [activityId, leftPaneWidth, rightPaneWidth]);

  useEffect(() => {
    if (!addFileOpen) return;
    const timeoutId = window.setTimeout(() => addFileInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [addFileOpen]);

  useEffect(() => {
    setAddFileOpen(false);
    setAddFileName("");
    setAddFileError(null);
    setDeleteFileOpen(false);
    setDeleteFileName("");
    setDeleteFileError(null);
  }, [selectedProblemId]);

  function ensureUserCreatedSet(problemId: string) {
    if (!userCreatedFilesByProblemIdRef.current[problemId]) {
      userCreatedFilesByProblemIdRef.current[problemId] = new Set<string>();
    }
    return userCreatedFilesByProblemIdRef.current[problemId]!;
  }

  function loadProblemIntoWorkspace(problem: Problem): WorkspaceState {
    const language = getProblemLanguage(problem);
    const starterCode =
      problem.starter_code ||
      problem.classSkeleton ||
      (language === "python"
        ? "def solve(x):\n    # TODO: implement\n    raise NotImplementedError\n"
        : language === "cpp"
          ? "#include <bits/stdc++.h>\n\n// Implement solve(...) below.\nauto solve(auto x) { (void)x; return 0; }\n"
          : language === "sql"
            ? "-- Write a single SELECT query.\nSELECT 1;\n"
            : "public class Solution {\n}\n");

    if (problem.workspace && Array.isArray(problem.workspace.files) && problem.workspace.files.length > 0) {
      const nextFiles: CodeFiles = {};
      const nextRoles: Record<string, FileRole> = {};
      for (const file of problem.workspace.files) {
        nextFiles[file.path] = file.content;
        nextRoles[file.path] = file.role;
      }
      const entryClass = problem.workspace.entrypoint ?? "Main";
      const firstEditable = problem.workspace.files.find((file) => file.role !== "readonly")?.path ?? problem.workspace.files[0]!.path;
      return { files: nextFiles, fileRoles: nextRoles, entrypointClass: entryClass, activeFilename: firstEditable };
    }

    if (language === "python") {
      return {
        files: { "solution.py": starterCode, "main.py": buildPythonMainTemplate() },
        fileRoles: { "solution.py": "support", "main.py": "entry" },
        entrypointClass: "main.py",
        activeFilename: "solution.py",
      };
    }
    if (language === "cpp") {
      return {
        files: { "solution.cpp": starterCode, "main.cpp": buildCppMainTemplate() },
        fileRoles: { "solution.cpp": "support", "main.cpp": "entry" },
        entrypointClass: "main.cpp",
        activeFilename: "solution.cpp",
      };
    }
    if (language === "sql") {
      return {
        files: { "solution.sql": starterCode },
        fileRoles: { "solution.sql": "support" },
        entrypointClass: "solution.sql",
        activeFilename: "solution.sql",
      };
    }

    const primaryClassName = inferJavaClassName(starterCode, "Solution");
    const primaryFilename = `${primaryClassName}.java`;
    return {
      files: { [primaryFilename]: starterCode, "Main.java": buildMainJavaTemplate(primaryClassName) },
      fileRoles: { [primaryFilename]: "support", "Main.java": "entry" },
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
    const workspace = existing ?? loadProblemIntoWorkspace(problem);
    if (!existing) workspacesRef.current[problem.id] = workspace;
    setFiles(workspace.files);
    setFileRoles(workspace.fileRoles);
    setActiveFilename(workspace.activeFilename);
    setEntrypointClass(workspace.entrypointClass);
  }

  function timerStorageKey(problemId: string): string {
    return `codem-activity-timer:v1:${activityId}:${problemId}`;
  }

  function persistTimer(problemId: string, next: PersistedTimerStateV1) {
    try {
      localStorage.setItem(timerStorageKey(problemId), JSON.stringify(next));
    } catch {
      // ignore
    }
  }

  function computeTimerSeconds(nowMs: number): number {
    if (!isTimerRunning || timerStartedAtMs == null) return timerBaseSeconds;
    const elapsed = Math.max(0, Math.floor((nowMs - timerStartedAtMs) / 1000));
    return timerMode === "countdown" ? Math.max(0, timerBaseSeconds - elapsed) : timerBaseSeconds + elapsed;
  }

  function loadOrStartTimer(problemId: string, limitSeconds: number | null, mode: TimerMode) {
    const now = Date.now();
    const key = timerStorageKey(problemId);

    let stored: PersistedTimerStateV1 | null = null;
    try {
      const raw = localStorage.getItem(key);
      if (raw) stored = JSON.parse(raw);
    } catch {
      stored = null;
    }

    const valid =
      stored &&
      stored.v === 1 &&
      (stored.mode === "countup" || stored.mode === "countdown") &&
      typeof stored.baseSeconds === "number" &&
      Number.isFinite(stored.baseSeconds) &&
      (stored.startedAtMs == null || (typeof stored.startedAtMs === "number" && Number.isFinite(stored.startedAtMs))) &&
      (stored.limitSeconds == null || (typeof stored.limitSeconds === "number" && Number.isFinite(stored.limitSeconds))) &&
      stored.mode === mode &&
      (stored.limitSeconds ?? null) === (limitSeconds ?? null);

    const persistedTimer = valid ? stored : null;

    const nextBaseSeconds =
      persistedTimer && typeof persistedTimer.baseSeconds === "number"
        ? Math.max(0, Math.trunc(persistedTimer.baseSeconds))
        : mode === "countdown" && typeof limitSeconds === "number" && limitSeconds > 0
          ? limitSeconds
          : 0;

    const nextStartedAtMs =
      persistedTimer && typeof persistedTimer.startedAtMs === "number" ? Math.trunc(persistedTimer.startedAtMs) : now;

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

  const selectProblem = useCallback(
    (problem: Problem) => {
      const previousId = selectedProblemIdRef.current;
      if (previousId && previousId !== problem.id) saveActiveWorkspace(previousId);
      setSelectedProblemId(problem.id);
      restoreWorkspace(problem);
      const limit = typeof timeLimitSeconds === "number" ? timeLimitSeconds : null;
      const mode: TimerMode = typeof limit === "number" && limit > 0 ? "countdown" : "countup";
      loadOrStartTimer(problem.id, limit, mode);
    },
    [timeLimitSeconds],
  );

  useEffect(() => {
    async function load() {
      try {
        setLoadError(null);
        workspacesRef.current = {};
        userCreatedFilesByProblemIdRef.current = {};
        setFeedback(null);

        const data = await activitiesClient.get({ id: activityId });
        const nextActivity = data?.activity as Activity | undefined;
        if (!nextActivity) {
          setLoadError("Activity not found.");
          return;
        }

        setActivity(nextActivity);
        setProblemStatusById(
          Object.fromEntries(nextActivity.problems.map((problem) => [problem.id, "not_started" as ProblemStatus])),
        );
        if (nextActivity.problems.length > 0) {
          const firstProblem = nextActivity.problems[0];
          setSelectedProblemId(firstProblem.id);
          restoreWorkspace(firstProblem);
        }

        const limit = typeof nextActivity.timeLimitSeconds === "number" ? nextActivity.timeLimitSeconds : null;
        const mode: TimerMode = typeof limit === "number" && limit > 0 ? "countdown" : "countup";
        if (nextActivity.problems.length > 0) {
          loadOrStartTimer(nextActivity.problems[0]!.id, limit, mode);
        } else {
          setTimeLimitSeconds(limit);
          setTimerMode(mode);
          setTimerBaseSeconds(0);
          setTimerSeconds(0);
          setIsTimerRunning(false);
        }
      } catch (error) {
        console.error(error);
        setLoadError("Failed to load activity.");
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, [activityId]);

  useEffect(() => {
    if (!isTimerRunning) return;
    const tick = () => {
      const now = Date.now();
      const nextSeconds = computeTimerSeconds(now);
      setTimerSeconds(nextSeconds);
      if (timerMode === "countdown" && nextSeconds <= 0) {
        setIsTimerRunning(false);
        setTimerBaseSeconds(0);
        setTimerStartedAtMs(null);
        if (selectedProblemId) {
          persistTimer(selectedProblemId, {
            v: 1,
            mode: "countdown",
            limitSeconds: timeLimitSeconds ?? null,
            baseSeconds: 0,
            startedAtMs: null,
          });
        }
      }
    };
    tick();
    const intervalId = window.setInterval(tick, 500);
    return () => window.clearInterval(intervalId);
  }, [isTimerRunning, selectedProblemId, timeLimitSeconds, timerBaseSeconds, timerMode, timerStartedAtMs]);

  const selectedProblem = activity?.problems.find((problem) => problem.id === selectedProblemId);
  const isGuidedActivity = Boolean(
    activity?.problems.some((problem) => problem.pedagogy && typeof problem.pedagogy.scaffold_level === "number"),
  );
  const selectedLanguage = getProblemLanguage(selectedProblem);
  const testSuite = selectedProblem?.test_suite || selectedProblem?.testSuite || "";
  const entryFile =
    selectedLanguage === "python"
      ? "main.py"
      : selectedLanguage === "cpp"
        ? "main.cpp"
        : selectedLanguage === "sql"
          ? "solution.sql"
          : Object.entries(fileRoles).find(([, role]) => role === "entry")?.[0] ?? "Main.java";
  const entrySource = files[entryFile] ?? "";
  const canRunMain =
    selectedLanguage === "python"
      ? true
      : selectedLanguage === "cpp"
        ? hasCppMainMethod(entrySource)
        : selectedLanguage === "sql"
          ? false
          : hasJavaMainMethod(entrySource);
  const isActiveReadonly = fileRoles[activeFilename] === "readonly";
  const problemIndex = activity ? Math.max(0, activity.problems.findIndex((problem) => problem.id === selectedProblemId)) : 0;
  const currentStatus: ProblemStatus = (selectedProblemId && problemStatusById[selectedProblemId]) || "not_started";

  async function handleRun() {
    if (!selectedProblem) return;
    if (selectedLanguage === "sql") {
      setFeedback({
        problemId: selectedProblem.id,
        kind: "run",
        atIso: new Date().toISOString(),
        result: { stdout: "", stderr: 'SQL activities are graded via "Check Code".' },
      });
      return;
    }
    if (!canRunMain && selectedLanguage !== "python") {
      const mainSignature = selectedLanguage === "cpp" ? "int main(...)" : "`public static void main(String[] args)`";
      setFeedback({
        problemId: selectedProblem.id,
        kind: "run",
        atIso: new Date().toISOString(),
        result: {
          stdout: "",
          stderr: `No ${mainSignature} detected in ${entryFile}.\n\nUse "Check Code" to run tests, or add a main() entrypoint.`,
        },
      });
      return;
    }
    setRunning(true);
    try {
      const sampleInputs = selectedProblem.sample_inputs || selectedProblem.sampleInputs || [];
      const stdin = sampleInputs.length > 0 ? String(sampleInputs[0]) : undefined;
      const data = await judgeClient.run({
        files,
        ...(selectedLanguage === "java" ? { mainClass: entrypointClass || "Main" } : {}),
        ...(typeof stdin === "string" ? { stdin } : {}),
        language: selectedLanguage,
      });
      if (!data || typeof data !== "object") {
        setFeedback({
          problemId: selectedProblem.id,
          kind: "run",
          atIso: new Date().toISOString(),
          result: { stdout: "", stderr: "Failed to run code (invalid response)." },
        });
        return;
      }
      const runResult: RunResult = {
        stdout: typeof data.stdout === "string" ? data.stdout : "",
        stderr: typeof data.stderr === "string" ? data.stderr : typeof data.error === "string" ? data.error : "",
      };
      setFeedback({ problemId: selectedProblem.id, kind: "run", atIso: new Date().toISOString(), result: runResult });
      setProblemStatusById((prev) => {
        const current = prev[selectedProblem.id] ?? "not_started";
        if (current === "not_started") return { ...prev, [selectedProblem.id]: "in_progress" };
        return prev;
      });
    } catch (error) {
      console.error(error);
      setFeedback({
        problemId: selectedProblem.id,
        kind: "run",
        atIso: new Date().toISOString(),
        result: { stdout: "", stderr: "Failed to run code. Please try again." },
      });
    } finally {
      setRunning(false);
    }
  }

  async function handleRunTests() {
    if (!selectedProblem) return;
    setSubmitting(true);
    try {
      const filesForTests = Object.fromEntries(
        Object.entries(files).filter(([filename]) => {
          if (fileRoles[filename] === "readonly") return false;
          if (selectedLanguage !== "cpp") return true;
          if (filename.endsWith(".cpp")) return filename === "solution.cpp";
          return true;
        }),
      );
      const data = await judgeClient.submit({
        files: filesForTests,
        testSuite,
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
    } catch (error) {
      console.error(error);
    } finally {
      setSubmitting(false);
    }
  }

  function tryAddFile(name: string): { ok: true } | { ok: false; error: string } {
    const pattern =
      selectedLanguage === "python"
        ? PYTHON_FILENAME_PATTERN
        : selectedLanguage === "cpp"
          ? CPP_FILENAME_PATTERN
          : JAVA_FILENAME_PATTERN;
    if (!pattern.test(name)) {
      const error =
        selectedLanguage === "python"
          ? 'Invalid filename. Use something like "utils.py".'
          : selectedLanguage === "cpp"
            ? 'Invalid filename. Use something like "helper.hpp" or "helper.cpp".'
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
      selectedLanguage === "python"
        ? `# ${className}.py\n\n`
        : selectedLanguage === "cpp"
          ? name.endsWith(".cpp")
            ? "#include <bits/stdc++.h>\n\n"
            : "#pragma once\n\n"
          : `public class ${className} {\n\n}\n`;
    setFiles((prev) => {
      const next = { ...prev, [name]: skeleton };
      filesRef.current = next;
      return next;
    });
    setFileRoles((prev) => {
      const next: Record<string, FileRole> = { ...prev, [name]: "support" };
      fileRolesRef.current = next;
      return next;
    });
    activeFilenameRef.current = name;
    setActiveFilename(name);
    const problemId = selectedProblemIdRef.current;
    if (problemId) ensureUserCreatedSet(problemId).add(name);
    return { ok: true };
  }

  function handleConfirmAddFile() {
    const name = addFileName.trim();
    if (!name) {
      setAddFileError("Enter a filename.");
      return;
    }
    const result = tryAddFile(name);
    if (result.ok) {
      closeAddFileModal();
      return;
    }
    setAddFileError(result.error);
  }

  const isFileDeletable = useCallback((filename: string): boolean => {
    const problemId = selectedProblemIdRef.current;
    if (!problemId) return false;
    const role = fileRolesRef.current[filename];
    if (role === "entry" || role === "readonly") return false;
    return ensureUserCreatedSet(problemId).has(filename);
  }, []);

  function commitDeleteFile() {
    const problemId = selectedProblemIdRef.current;
    const name = deleteFileName.trim();
    if (!problemId || !name) {
      setDeleteFileError("Nothing to delete.");
      return;
    }
    if (!isFileDeletable(name)) {
      setDeleteFileError("You can only delete files you created.");
      return;
    }
    const previousFiles = filesRef.current;
    const previousRoles = fileRolesRef.current;
    if (!Object.prototype.hasOwnProperty.call(previousFiles, name)) {
      closeDeleteFileModal();
      return;
    }
    const nextFiles: CodeFiles = { ...previousFiles };
    delete nextFiles[name];
    const nextRoles: Record<string, FileRole> = { ...previousRoles };
    delete nextRoles[name];
    filesRef.current = nextFiles;
    fileRolesRef.current = nextRoles;
    setFiles(nextFiles);
    setFileRoles(nextRoles);
    const remaining = Object.keys(nextFiles);
    const currentActive = activeFilenameRef.current;
    let nextActive = currentActive;
    if (!Object.prototype.hasOwnProperty.call(nextFiles, currentActive)) {
      nextActive =
        remaining.find((filename) => nextRoles[filename] === "support") ??
        remaining.find((filename) => nextRoles[filename] === "entry") ??
        remaining[0] ??
        "";
    }
    if (nextActive) {
      activeFilenameRef.current = nextActive;
      setActiveFilename(nextActive);
    }
    ensureUserCreatedSet(problemId).delete(name);
    closeDeleteFileModal();
  }

  function beginDrag(kind: "left" | "right", event: React.PointerEvent) {
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    dragRef.current = { kind, startX: event.clientX, startLeft: leftPaneWidth, startRight: rightPaneWidth };
  }

  function onDrag(event: React.PointerEvent) {
    const drag = dragRef.current;
    if (!drag) return;
    const containerWidth = layoutRef.current?.getBoundingClientRect().width ?? window.innerWidth;
    if (drag.kind === "left") {
      const deltaX = event.clientX - drag.startX;
      const maxLeft = Math.max(MIN_LEFT, containerWidth - MIN_CENTER - drag.startRight - SPLITTER_W * 2);
      setLeftPaneWidth(clampNumber(drag.startLeft + deltaX, MIN_LEFT, maxLeft));
    } else {
      const deltaX = event.clientX - drag.startX;
      const maxRight = Math.max(MIN_RIGHT, containerWidth - MIN_CENTER - drag.startLeft - SPLITTER_W * 2);
      setRightPaneWidth(clampNumber(drag.startRight - deltaX, MIN_RIGHT, maxRight));
    }
  }

  function endDrag(event: React.PointerEvent) {
    if (!dragRef.current) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = null;
  }

  const handleFileSelect = useCallback((filename: string) => {
    activeFilenameRef.current = filename;
    setActiveFilename(filename);
  }, []);

  const handleCodeChange = useCallback((filename: string, value: string) => {
    if (fileRolesRef.current[filename] === "readonly") return;
    setFiles((prev) => {
      const next = { ...prev, [filename]: value };
      filesRef.current = next;
      return next;
    });
    const problemId = selectedProblemIdRef.current;
    if (problemId) {
      setProblemStatusById((prev) => {
        const current = prev[problemId] ?? "not_started";
        if (current === "passed" || current === "failed" || current === "not_started") {
          return { ...prev, [problemId]: "in_progress" };
        }
        return prev;
      });
    }
  }, []);

  const handleAddFileClick = useCallback(() => {
    setAddFileError(null);
    setAddFileName("");
    setAddFileOpen(true);
  }, []);

  const handleDeleteFileClick = useCallback(
    (filename: string) => {
      if (!isFileDeletable(filename)) return;
      setDeleteFileError(null);
      setDeleteFileName(filename);
      setDeleteFileOpen(true);
    },
    [isFileDeletable],
  );

  function closeAddFileModal() {
    setAddFileOpen(false);
    setAddFileName("");
    setAddFileError(null);
  }

  function closeDeleteFileModal() {
    setDeleteFileOpen(false);
    setDeleteFileName("");
    setDeleteFileError(null);
  }

  function goHome() {
    window.location.href = "/";
  }

  function goToReview() {
    router.push(`/activity/${activityId}/review`);
  }

  return {
    activity,
    activityId,
    addFileError,
    addFileInputRef,
    addFileName,
    addFileOpen,
    activeFilename,
    canRunMain,
    closeAddFileModal,
    closeDeleteFileModal,
    commitDeleteFile,
    currentStatus,
    deleteFileError,
    deleteFileName,
    deleteFileOpen,
    endDrag,
    entryFile,
    feedback,
    fileRoles,
    files,
    formatTime,
    goHome,
    goToReview,
    handleAddFileClick,
    handleCodeChange,
    handleConfirmAddFile,
    handleDeleteFileClick,
    handleFileSelect,
    handleRun,
    handleRunTests,
    isActiveReadonly,
    isFileDeletable,
    isGuidedActivity,
    layoutRef,
    leftPaneWidth,
    loadError,
    loading,
    onDrag,
    problemIndex,
    problemStatusById,
    rightPaneWidth,
    running,
    selectProblem,
    selectedLanguage,
    selectedProblem,
    selectedProblemId,
    setAddFileError,
    setAddFileName,
    setDeleteFileError,
    setDeleteFileName,
    setFeedback,
    submitting,
    testSuite,
    timerMode,
    timerSeconds,
    beginDrag,
  };
}
