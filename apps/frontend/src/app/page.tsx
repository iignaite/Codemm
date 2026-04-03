"use client";

import Link from "next/link";
import { History as HistoryIcon, LayoutGrid, Moon, Sun, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSpecBuilderUX } from "@/lib/specBuilderUx";
import { OnboardingTour, type TourStep } from "@/components/OnboardingTour";
import type {
  Difficulty,
  GenerationLanguage,
  GenerationProgressEvent,
} from "@/types/generationProgress";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  tone?: "question" | "hint" | "info";
  summary?: string;
  assumptions?: string[];
};

type SlotStage = "queued" | "llm" | "contract" | "docker" | "done" | "failed";
type SlotProgress = {
  stage: SlotStage;
  attempt: number;
  difficulty: Difficulty | null;
  topic: string | null;
  language: GenerationLanguage | null;
  stageDone: { llm: boolean; contract: boolean; docker: boolean };
  lastFailure: { stage: "contract" | "docker"; message: string } | null;
};

type GenerationProgressState = {
  totalSlots: number;
  run: number;
  slots: SlotProgress[];
  error: string | null;
  lastHeartbeatTs: string | null;
};

type LearningMode = "practice" | "guided";

type ThreadSummary = {
  id: string;
  state: string;
  learning_mode: LearningMode;
  created_at: string;
  updated_at: string;
  activity_id: string | null;
  last_message: string | null;
  last_message_at: string | null;
  message_count: number;
};

function requireThreadsApi() {
  const api = (window as any)?.codemm?.threads;
  if (!api) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
  return api;
}

export default function Home() {
  const router = useRouter();
  const { interpretResponse, formatSlotPrompt, normalizeInput, activeSlot } = useSpecBuilderUX();
  const [loading, setLoading] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [hasInteracted, setHasInteracted] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [threadHistory, setThreadHistory] = useState<ThreadSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const [threadId, setThreadId] = useState<string | null>(null);
  const [learningMode, setLearningMode] = useState<LearningMode>("practice");
  const [generationLocked, setGenerationLocked] = useState(false);
  const generationLoadingRef = useRef(false);
  const [specReady, setSpecReady] = useState(false);
  const specReadyRef = useRef(false);
  const chatLoadingRef = useRef(false);
  const [progress, setProgress] = useState<GenerationProgressState | null>(null);
  const [progressHint, setProgressHint] = useState<string | null>(null);
  const [generationRunId, setGenerationRunId] = useState<string | null>(null);
  const progressRef = useRef<null | { unsubscribe: () => Promise<void> }>(null);

  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [instructionsSaved, setInstructionsSaved] = useState<string>("");
  const [instructionsDraft, setInstructionsDraft] = useState<string>("");
  const [instructionsSaving, setInstructionsSaving] = useState(false);
  const [instructionsError, setInstructionsError] = useState<string | null>(null);

  const [tourOpen, setTourOpen] = useState(false);
  const tutorialSteps: TourStep[] = [
    {
      id: "mode",
      selector: '[data-tour="mode-toggle"]',
      title: "Pick a learning mode",
      body: "Practice generates problems fast. Guided adds more structure and scaffolding.",
    },
    {
      id: "prompt",
      selector: '[data-tour="chat-input"]',
      title: "Tell it what you want to learn",
      body: 'Example: "SQL grouping and aggregation, 4 problems: 2 easy 2 medium."',
    },
    {
      id: "send",
      selector: '[data-tour="send"]',
      title: "Chat to build the activity spec",
      body: "Answer the follow-up questions until it says the spec is ready.",
    },
    {
      id: "generate",
      selector: '[data-tour="generate"]',
      title: "Generate your problems",
      body: 'Once the spec is ready, click "Generate" to create the draft activity.',
    },
  ];

  useEffect(() => {
    if (typeof window === "undefined") return;
    const key = "codem-tutorial-v1";
    if (localStorage.getItem(key) === "1") return;
    const t = window.setTimeout(() => setTourOpen(true), 500);
    return () => window.clearTimeout(t);
  }, []);

  const handleLogoClick = () => {
    if (typeof window === "undefined") return;
    if (window.location.pathname === "/") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  function cleanupStreams() {
    const unsub = progressRef.current?.unsubscribe;
    progressRef.current = null;
    if (typeof unsub === "function") {
      Promise.resolve()
        .then(() => unsub())
        .catch(() => {});
    }
  }

  async function startNewSession(mode: LearningMode) {
    try {
      cleanupStreams();
      setLearningMode(mode);
      setThreadId(null);
      setSpecReady(false);
      specReadyRef.current = false;
      setProgress(null);
      setProgressHint(null);
      setGenerationRunId(null);
      setGenerationLocked(false);
      generationLoadingRef.current = false;
      setMessages([]);
      setChatInput("");
      setHasInteracted(false);
      chatLoadingRef.current = false;
      setInstructionsOpen(false);
      setInstructionsSaved("");
      setInstructionsDraft("");
      setInstructionsError(null);

      const data = await requireThreadsApi().create({ learning_mode: mode });

      if (typeof data?.threadId === "string") {
        setThreadId(data.threadId);
        localStorage.setItem("codemm-last-thread-id", data.threadId);
        localStorage.setItem("codem-last-learning-mode", mode);
      }

      if (typeof data?.nextQuestion === "string" && data.nextQuestion.trim()) {
        setMessages([
          {
            role: "assistant",
            tone: "question",
            content: data.nextQuestion,
            summary: typeof data.assistant_summary === "string" ? data.assistant_summary : undefined,
            assumptions: Array.isArray(data.assumptions) ? data.assumptions : undefined,
          },
        ]);
      }
    } catch (e) {
      console.error("Failed to create thread:", e);
    }
  }

  async function loadSession(existingSessionId: string) {
    try {
      cleanupStreams();
      setThreadId(null);
      setSpecReady(false);
      setProgress(null);
      setProgressHint(null);
      setGenerationRunId(null);
      setGenerationLocked(false);
      generationLoadingRef.current = false;
      setMessages([]);
      setChatInput("");
      setHasInteracted(false);
      setInstructionsOpen(false);
      setInstructionsSaved("");
      setInstructionsDraft("");
      setInstructionsError(null);

      const data = await requireThreadsApi().get({ threadId: existingSessionId });

      const mode: LearningMode = data?.learning_mode === "guided" ? "guided" : "practice";
      setLearningMode(mode);
      setThreadId(existingSessionId);
      localStorage.setItem("codemm-last-thread-id", existingSessionId);
      localStorage.setItem("codem-last-learning-mode", mode);

      const state = String(data?.state ?? "");
      const ready = state === "READY" || state === "GENERATING" || state === "SAVED";
      setSpecReady(ready);
      specReadyRef.current = ready;
      setGenerationLocked(state === "GENERATING");

      const instr = typeof data?.instructions_md === "string" ? data.instructions_md : "";
      setInstructionsSaved(instr);
      setInstructionsDraft(instr);

      if (Array.isArray(data?.messages)) {
        const loaded: ChatMessage[] = data.messages
          .map((m: any) => {
            const role = m?.role === "assistant" ? "assistant" : "user";
            const content = typeof m?.content === "string" ? m.content : "";
            if (!content.trim()) return null;
            return { role, content } satisfies ChatMessage;
          })
          .filter(Boolean) as ChatMessage[];
        setMessages(loaded);
        setHasInteracted(loaded.length > 0);
      }
    } catch (e) {
      console.error("Failed to load thread:", e);
      const storedMode = localStorage.getItem("codem-last-learning-mode");
      const fallbackMode: LearningMode = storedMode === "guided" ? "guided" : "practice";
      await startNewSession(fallbackMode);
    }
  }

  async function saveInstructions(nextText: string) {
    if (!threadId) return;
    setInstructionsSaving(true);
    setInstructionsError(null);
    try {
      const trimmed = nextText.trim();
      const normalized = trimmed.length ? trimmed : null;
      await requireThreadsApi().setInstructions({ threadId, instructions_md: normalized });
      setInstructionsSaved(trimmed);
      setInstructionsDraft(trimmed);
    } catch (e: any) {
      setInstructionsError(e?.message ?? "Failed to save instructions.");
    } finally {
      setInstructionsSaving(false);
    }
  }

  async function fetchSessionHistory(limit: number = 30) {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const data = await requireThreadsApi().list({ limit });
      setThreadHistory(Array.isArray(data?.threads) ? data.threads : []);
    } catch (e: any) {
      setHistoryError(e?.message ?? "Failed to load chat history");
    } finally {
      setHistoryLoading(false);
    }
  }

  useEffect(() => {
    const stored = localStorage.getItem("codem-theme");
    if (stored === "dark") {
      setDarkMode(true);
    }

    const storedMode = localStorage.getItem("codem-last-learning-mode");
    const initialMode: LearningMode = storedMode === "guided" ? "guided" : "practice";
    setLearningMode(initialMode);

    const storedThreadId = localStorage.getItem("codemm-last-thread-id");
    if (storedThreadId) {
      void loadSession(storedThreadId);
    } else {
      void startNewSession(initialMode);
    }
  }, []);

  useEffect(() => {
    return () => {
      cleanupStreams();
    };
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!historyOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHistoryOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [historyOpen]);

  const toggleDarkMode = () => {
    const newMode = !darkMode;
    setDarkMode(newMode);
    localStorage.setItem("codem-theme", newMode ? "dark" : "light");
  };

  function renderOverallPercent(p: GenerationProgressState): number {
    const done = p.slots.filter((x) => x.stage === "done").length;
    const total = p.totalSlots || 1;
    return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
  }

  function renderSlotStatus(p: SlotProgress): string {
    if (p.stage === "queued") return "Queued";
    if (p.stage === "done") return "Done";
    if (p.stage === "failed") return "Failed";
    if (p.lastFailure) return `Retrying… (attempt ${Math.min(3, p.attempt + 1)}/3)`;
    if (p.stage === "llm") return p.attempt ? `Generating (attempt ${p.attempt}/3)` : "Generating";
    if (p.stage === "contract") return p.attempt ? `Validating contract (attempt ${p.attempt}/3)` : "Validating contract";
    if (p.stage === "docker") return p.attempt ? `Validating in Sandbox (attempt ${p.attempt}/3)` : "Validating in Sandbox";
    return "Queued";
  }

  function renderSlotPercent(p: SlotProgress): number {
    if (p.stage === "done") return 100;
    if (p.stage === "failed") return 100;
    if (p.stage === "queued") return 0;
    if (p.stage === "llm") return 25;
    if (p.stage === "contract") return 50;
    if (p.stage === "docker") return 75;
    return 0;
  }

  async function handleChatSend() {
    if (!threadId || specReadyRef.current || chatLoadingRef.current) return;

    const rawInput = chatInput.trim();
    if (!rawInput) return;

    const normalized = normalizeInput(rawInput);
    if (!normalized.ok) return;
    const userMessage = rawInput;

    setHasInteracted(true);
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    setChatInput("");
    setChatLoading(true);
    chatLoadingRef.current = true;

    try {
      const data = await requireThreadsApi().postMessage({ threadId, message: normalized.value });

      interpretResponse(data);

      const ready = data.done === true || data.state === "READY";
      setSpecReady(ready);
      specReadyRef.current = ready;

      if (ready && data.next_action === "ready") {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            tone: "info",
            content: 'Activity spec is ready. Click "Generate" to create problems.',
          },
        ]);
      } else if (typeof data.nextQuestion === "string" && data.nextQuestion.trim()) {
        const assistantTone: ChatMessage["tone"] = data.accepted ? "question" : "hint";
        const assistantContent =
          data.accepted
            ? data.nextQuestion
            : [data.error, data.nextQuestion].filter(Boolean).join("\n\n");
        const summary = typeof (data as any).assistant_summary === "string" ? (data as any).assistant_summary : undefined;
        const assumptions = Array.isArray((data as any).assumptions) ? (data as any).assumptions : undefined;

        setMessages((prev) => [
          ...prev,
          { role: "assistant", tone: assistantTone, content: assistantContent, summary, assumptions },
        ]);
      } else {
        const fallback = formatSlotPrompt(activeSlot) ?? "Please continue.";
        setMessages((prev) => [
          ...prev,
          { role: "assistant", tone: "question", content: fallback },
        ]);
      }
    } catch (e) {
      console.error(e);
      const message = e instanceof Error ? e.message : String(e ?? "");
      if (/session state is READY/i.test(message)) {
        setSpecReady(true);
        specReadyRef.current = true;
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            tone: "info",
            content: 'Activity spec is already ready. Click "Generate" to create problems.',
          },
        ]);
      } else {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            tone: "hint",
            content:
              "Sorry, something went wrong processing your answer. Please try again in the expected format.",
          },
        ]);
      }
    } finally {
      setChatLoading(false);
      chatLoadingRef.current = false;
    }
  }

  async function handleGenerate() {
    if (!threadId || !specReady || generationLocked || generationLoadingRef.current) {
      return;
    }

    generationLoadingRef.current = true;
    setLoading(true);
    setGenerationLocked(true);
    let runIdForDiagnostics: string | null = null;
    try {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          tone: "info",
          content: "Generating activity... please wait.",
        },
      ]);

      // Open structured progress stream (no prompts, no reasoning, no logs).
      setProgress(null);
      setProgressHint(null);
      setGenerationRunId(null);

      const hintTimer = window.setTimeout(
        () => setProgressHint("Preparing generation... local models can take longer to emit the first update."),
        4000,
      );

      const sub = await requireThreadsApi().subscribeGeneration({
        threadId,
        onEvent: (ev: unknown) => {
          window.clearTimeout(hintTimer);
          setProgressHint((prev) =>
            prev === "Preparing generation... local models can take longer to emit the first update." ? null : prev,
          );
          try {
            if (!ev || typeof (ev as any).type !== "string") return;
            const typed = ev as GenerationProgressEvent;

            setProgress((prev) => {
              if (typed.type === "generation_started") {
                const total = Math.max(1, typed.totalSlots ?? typed.totalProblems ?? 1);
                const slots: SlotProgress[] = Array.from({ length: total }, () => ({
                  stage: "queued",
                  attempt: 0,
                  difficulty: null,
                  topic: null,
                  language: null,
                  stageDone: { llm: false, contract: false, docker: false },
                  lastFailure: null,
                }));
                return { totalSlots: total, run: typed.run ?? 1, slots, error: null, lastHeartbeatTs: null };
              }

              if (!prev) return prev;

              const next: GenerationProgressState = {
                ...prev,
                slots: prev.slots.map((p) => ({
                  ...p,
                  stageDone: { ...p.stageDone },
                  lastFailure: p.lastFailure ? { ...p.lastFailure } : null,
                })),
              };

            if (typed.type === "heartbeat") {
              next.lastHeartbeatTs = typed.ts;
              return next;
            }

            if (typed.type === "generation_soft_fallback_applied") {
              setProgressHint(`Fallback applied: ${typed.reason}`);
              return next;
            }

            const getSlot = (slotIndex: number) => next.slots[slotIndex];

            if (typed.type === "slot_started") {
              const p = getSlot(typed.slotIndex);
              if (p) {
                p.difficulty = typed.difficulty;
                p.topic = typed.topic;
                p.language = typed.language;
                if (p.stage === "queued") p.stage = "llm";
              }
              return next;
            }

            if (typed.type === "slot_llm_attempt_started") {
              const p = getSlot(typed.slotIndex);
              if (p) {
                p.stage = "llm";
                p.attempt = typed.attempt;
                p.stageDone = { llm: false, contract: false, docker: false };
                p.lastFailure = null;
              }
              return next;
            }

            if (typed.type === "slot_contract_validated") {
              const p = getSlot(typed.slotIndex);
              if (p) {
                p.stage = "docker";
                p.attempt = typed.attempt;
                p.stageDone.llm = true;
                p.stageDone.contract = true;
                p.lastFailure = null;
              }
              return next;
            }

            if (typed.type === "slot_contract_failed") {
              const p = getSlot(typed.slotIndex);
              if (p) {
                p.stage = "contract";
                p.attempt = typed.attempt;
                p.lastFailure = { stage: "contract", message: typed.shortError };
              }
              return next;
            }

            if (typed.type === "slot_docker_validation_started") {
              const p = getSlot(typed.slotIndex);
              if (p) {
                p.stage = "docker";
                p.attempt = typed.attempt;
                p.stageDone.llm = true;
                p.stageDone.contract = true;
                p.lastFailure = null;
              }
              return next;
            }

            if (typed.type === "slot_docker_validation_failed") {
              const p = getSlot(typed.slotIndex);
              if (p) {
                p.stage = "docker";
                p.attempt = typed.attempt;
                p.lastFailure = { stage: "docker", message: typed.shortError };
              }
              return next;
            }

            if (typed.type === "slot_attempt_summary") {
              const p = getSlot(typed.slotIndex);
              if (p) {
                p.attempt = typed.attempt;
                if (typed.status === "failed") {
                  p.stage = typed.phase === "validate" ? "docker" : "contract";
                  p.lastFailure = {
                    stage: typed.phase === "validate" ? "docker" : "contract",
                    message: typed.message || "Slot attempt failed.",
                  };
                }
              }
              if (typed.llm?.truncated) {
                const modelLabel = typed.llm.model ? `${typed.llm.provider}/${typed.llm.model}` : typed.llm.provider;
                setProgressHint(`Model output may be truncated (${modelLabel}).`);
              }
              return next;
            }

            if (typed.type === "slot_failure_diagnostic") {
              const p = getSlot(typed.slotIndex);
              if (p) {
                const stage = typed.kind === "compile" || typed.kind === "tests" || typed.kind === "timeout" ? "docker" : "contract";
                p.stage = stage;
                p.attempt = typed.attempt;
                p.lastFailure = {
                  stage,
                  message: typed.message || "Slot failed.",
                };
              }
              if (typed.remediation.length > 0) {
                const prefix = typed.final ? "Final slot failure" : "Slot failure";
                setProgressHint(`${prefix}: ${typed.remediation.slice(0, 2).join(" | ")}`);
              }
              return next;
            }

            if (typed.type === "slot_repair_applied") {
              setProgressHint(`Repair applied on slot ${typed.slotIndex + 1}: ${typed.strategy.replaceAll("_", " ")}.`);
              return next;
            }

            if (typed.type === "slot_completed") {
              const p = getSlot(typed.slotIndex);
              if (p) {
                p.stage = "done";
                p.stageDone = { llm: true, contract: true, docker: true };
                p.lastFailure = null;
              }
              return next;
            }

            if (typed.type === "problem_started") {
              const p = getSlot(typed.index);
              if (p) {
                p.difficulty = typed.difficulty;
                p.stage = "llm";
                p.attempt = 0;
                p.stageDone = { llm: false, contract: false, docker: false };
                p.lastFailure = null;
              }
              return next;
            }

            if (typed.type === "attempt_started") {
              const p = getSlot(typed.index);
              if (p) {
                p.stage = "llm";
                p.attempt = typed.attempt;
                p.stageDone = { llm: false, contract: false, docker: false };
                p.lastFailure = null;
              }
              return next;
            }

            if (typed.type === "validation_started") {
              const p = getSlot(typed.index);
              if (p) {
                p.stage = "docker";
                p.attempt = typed.attempt;
                p.stageDone.llm = true;
                p.stageDone.contract = true;
                p.lastFailure = null;
              }
              return next;
            }

            if (typed.type === "validation_failed") {
              const p = getSlot(typed.index);
              if (p) {
                p.stage = "docker";
                p.attempt = typed.attempt;
                p.lastFailure = { stage: "docker", message: "Docker validation failed." };
              }
              return next;
            }

            if (typed.type === "attempt_failed") {
              const p = getSlot(typed.index);
              if (p) {
                p.attempt = typed.attempt;
                p.lastFailure =
                  typed.phase === "validate"
                    ? { stage: "docker", message: "Docker validation failed." }
                    : { stage: "contract", message: "Contract validation failed." };
              }
              return next;
            }

            if (typed.type === "problem_validated") {
              const p = getSlot(typed.index);
              if (p) {
                p.stage = "done";
                p.stageDone = { llm: true, contract: true, docker: true };
                p.lastFailure = null;
              }
              return next;
            }

            if (typed.type === "problem_failed") {
              const p = getSlot(typed.index);
              if (p) p.stage = "failed";
              return next;
            }

            if (typed.type === "generation_failed") {
              next.error = typed.error || "Generation failed.";
              if (typeof typed.slotIndex === "number") {
                const p = getSlot(typed.slotIndex);
                if (p && p.stage !== "done") p.stage = "failed";
              } else {
                for (const p of next.slots) {
                  if (p.stage !== "done") p.stage = "failed";
                }
              }
              return next;
            }

              return next;
            });
          } catch {
            // ignore parse errors
          }
        },
      });
      progressRef.current = { unsubscribe: sub.unsubscribe };

      const threadsApi = requireThreadsApi() as any;
      const generateFn =
        typeof threadsApi.generateV2 === "function" ? threadsApi.generateV2.bind(threadsApi) : threadsApi.generate.bind(threadsApi);
      const data = await generateFn({ threadId });
      window.clearTimeout(hintTimer);
      if (typeof data?.runId === "string") {
        runIdForDiagnostics = data.runId;
        setGenerationRunId(data.runId);
      }

      if (typeof data.activityId === "string") {
        try {
          await progressRef.current?.unsubscribe?.();
          progressRef.current = null;
        } catch {
          // ignore
        }
        router.push(`/activity/${data.activityId}/review`);
      } else if (data?.error) {
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            tone: "hint",
            content: `Failed to generate activity: ${data.error} ${data.detail ?? ""}`,
          },
        ]);
      }
    } catch (e) {
      console.error(e);
      let diagnosticMessage: string | null = null;
      try {
        const threadsApi = requireThreadsApi() as any;
        if (typeof threadsApi.getGenerationDiagnostics === "function") {
          const diag = await threadsApi.getGenerationDiagnostics({
            threadId,
            ...((runIdForDiagnostics ?? generationRunId) ? { runId: runIdForDiagnostics ?? generationRunId } : {}),
          });
          const latest = diag?.latestFailure;
          if (latest && typeof latest.message === "string") {
            const actions = Array.isArray(latest.remediation) ? latest.remediation.slice(0, 2).join(" | ") : "";
            diagnosticMessage = actions
              ? `Latest failure: ${latest.message} Next actions: ${actions}.`
              : `Latest failure: ${latest.message}`;
          }
        }
      } catch {
        // ignore diagnostics fetch errors
      }
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          tone: "hint",
          content: /session state is GENERATING/i.test(e instanceof Error ? e.message : String(e ?? ""))
            ? "Generation is already running. Please wait for the current attempt to finish."
            : diagnosticMessage
              ? `Failed to generate activity. ${diagnosticMessage}`
              : "Failed to generate activity. Please try again.",
        },
      ]);
    } finally {
      try {
        await progressRef.current?.unsubscribe?.();
        progressRef.current = null;
      } catch {
        // ignore
      }
      setLoading(false);
      setGenerationLocked(false);
      generationLoadingRef.current = false;
    }
  }

  const isBusy = chatLoading || loading;
  const isPromptExpanded = hasInteracted || chatInput.trim().length > 0;

  return (
    <div
      className={`relative min-h-screen overflow-x-hidden transition-colors ${
        darkMode ? "bg-slate-950 text-slate-50" : "bg-slate-50 text-slate-900"
      }`}
    >
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div
          className={`absolute left-1/2 top-10 -z-10 h-[520px] w-[520px] -translate-x-1/2 rotate-6 rounded-[42px] border ${
            darkMode ? "border-sky-900/40 bg-slate-900/60" : "border-sky-100 bg-white"
          } shadow-[0_40px_120px_-60px_rgba(15,23,42,0.55)]`}
        >
          <div
            className="absolute inset-4 rounded-[32px] opacity-60"
            style={{
              backgroundImage:
                "radial-gradient(circle at 1px 1px, rgba(59,130,246,0.25) 1px, transparent 0)",
              backgroundSize: "36px 36px",
            }}
          />
          <div
            className="absolute inset-0 rounded-[42px]"
            style={{
              background:
                "conic-gradient(from 110deg at 50% 50%, rgba(59,130,246,0.09), transparent 40%, rgba(59,130,246,0.14), transparent 70%)",
            }}
          />
        </div>
      </div>

      <div className="relative mx-auto flex min-h-screen max-w-6xl flex-col px-6 pb-16">
        <OnboardingTour
          open={tourOpen}
          steps={tutorialSteps}
          onClose={() => {
            setTourOpen(false);
            try {
              localStorage.setItem("codem-tutorial-v1", "1");
            } catch {
              // ignore
            }
          }}
        />
        <header
          className={`sticky top-0 z-30 flex flex-col gap-4 py-6 lg:flex-row lg:items-center lg:justify-between transition-all duration-300 ${
            isPromptExpanded ? "translate-y-0 opacity-100" : "opacity-100 translate-y-0"
          } ${darkMode ? "bg-slate-950/90" : "bg-slate-50/95"} backdrop-blur`}
        >
          <Link
            href="/"
            onClick={handleLogoClick}
            className="flex items-center gap-3 hover:opacity-90 transition focus:outline-none cursor-pointer"
            aria-label="Go to home"
          >
            <div>
              <div className="logo-font text-xl font-extrabold tracking-tight">Codemm</div>
            </div>
          </Link>



          <div className="flex items-center gap-3">
            <div
              className={`flex items-center rounded-full border p-1 text-xs font-semibold ${
                darkMode ? "border-slate-800 bg-slate-900/60" : "border-slate-200 bg-white/80"
              }`}
              data-tour="mode-toggle"
              role="tablist"
              aria-label="Learning mode"
            >
              {(["practice", "guided"] as LearningMode[]).map((mode) => {
                const active = learningMode === mode;
                return (
                  <button
                    key={mode}
                    role="tab"
                    aria-selected={active}
                    onClick={() => {
                      if (generationLocked) return;
                      if ((hasInteracted || specReady) && mode !== learningMode) {
                        const ok = window.confirm(
                          "Switch learning mode? This will start a new thread and reset the current chat/spec.",
                        );
                        if (!ok) return;
                      }
                      void startNewSession(mode);
                    }}
                    disabled={generationLocked || isBusy}
                    className={`rounded-full px-3 py-2 transition disabled:cursor-not-allowed disabled:opacity-60 ${
                      active
                        ? "bg-sky-600 text-white shadow-sm"
                        : darkMode
                          ? "text-slate-200 hover:bg-slate-800"
                          : "text-slate-700 hover:bg-slate-100"
                    }`}
                  >
                    {mode === "practice" ? "Practice" : "Guided"}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              onClick={() => {
                const next = !historyOpen;
                setHistoryOpen(next);
                if (next) void fetchSessionHistory();
              }}
              className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition ${
                darkMode
                  ? "bg-slate-800 text-slate-300 hover:bg-slate-700"
                  : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              }`}
              aria-haspopup="dialog"
              aria-expanded={historyOpen}
            >
              <HistoryIcon className="h-4 w-4" />
              History
            </button>
            <Link
              href="/activities"
              className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition ${
                darkMode
                  ? "bg-slate-800 text-slate-300 hover:bg-slate-700"
                  : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              <LayoutGrid className="h-4 w-4" />
              Activities
            </Link>
            <Link
              href="/settings/llm"
              className={`rounded-full border px-4 py-2 text-sm font-semibold transition ${
                darkMode
                  ? "border-slate-800 bg-slate-900/60 text-slate-200 hover:bg-slate-800"
                  : "border-slate-200 bg-white/80 text-slate-700 hover:bg-slate-100"
              }`}
            >
              API Key
            </Link>
            <button
              onClick={toggleDarkMode}
              className={`flex h-10 w-10 items-center justify-center rounded-full bg-transparent text-base transition ${
                darkMode ? "text-slate-200 hover:text-white" : "text-slate-600 hover:text-slate-900"
              }`}
              aria-label="Toggle dark mode"
            >
              {darkMode ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </button>
          </div>
        </header>

        <main
          className={`flex flex-1 flex-col justify-start gap-4 ${
            isPromptExpanded ? "pt-4 sm:pt-6" : "py-8"
          } ${isPromptExpanded ? "text-left" : "text-center"} transition-all duration-300`}
        >
          {!isPromptExpanded && (
            <div className="flex flex-col items-center gap-4 transition-all duration-300 opacity-100 translate-y-0">
              <p className={`text-base font-semibold ${darkMode ? "text-sky-200" : "text-sky-600"}`}>Your AI</p>
              <h1
                className={`text-4xl font-semibold leading-tight tracking-tight sm:text-5xl lg:text-6xl ${
                  darkMode ? "text-white" : "text-slate-900"
                }`}
              >
                Coding Exam Buddy
              </h1>
              <p className={`max-w-3xl text-lg ${darkMode ? "text-slate-300" : "text-slate-600"}`}>
                Generate personalized practice problems in seconds. Stop searching, start solving.
              </p>
            </div>
          )}

          <section
            className={`relative w-full max-w-4xl mx-auto text-left transition-all duration-300 ${
              isPromptExpanded ? "mt-2 sm:mt-4 -translate-y-2 sm:-translate-y-3" : "mt-10 translate-y-0"
            }`}
          >
            <div
              className={`rounded-[28px] border shadow-xl backdrop-blur transition-all duration-300 ${
                darkMode ? "border-slate-800 bg-slate-900/70" : "border-slate-200 bg-white/85"
              } ${isPromptExpanded ? "ring-1 ring-slate-200/60 dark:ring-slate-800/60" : ""}`}
            >
              <div
                className={`space-y-3 overflow-y-auto px-5 py-5 ${
                  isPromptExpanded ? "max-h-[65vh] md:max-h-[70vh]" : "max-h-80"
                }`}
              >
                {messages.length === 0 && (
                  <div
                    className={`rounded-2xl border px-4 py-3 text-sm ${
                      darkMode ? "border-slate-800 bg-slate-900/60 text-slate-200" : "border-slate-200 bg-slate-50 text-slate-700"
                    }`}
                  >
                    Ask any coding question and Codemm will walk you through it. Start typing below or pick a quick action.
                  </div>
                )}

                {messages.map((m, idx) => (
                  <div key={idx} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-line ${
                        m.role === "user"
                          ? "bg-slate-900 text-white shadow-sm dark:bg-slate-800"
                          : m.tone === "question"
                            ? darkMode
                              ? "border border-slate-800 bg-slate-900/70 text-slate-100"
                              : "border border-slate-200 bg-white text-slate-900"
                            : m.tone === "hint"
                              ? darkMode
                                ? "border border-amber-700/60 bg-amber-900/30 text-amber-100"
                                : "border border-amber-200 bg-amber-50 text-amber-900"
                              : m.tone === "info"
                                ? darkMode
                                  ? "border border-slate-800 bg-slate-900/60 text-slate-100"
                                  : "border border-blue-100 bg-blue-50 text-slate-900"
                                : darkMode
                                  ? "bg-slate-900/60 text-slate-100"
                                  : "bg-slate-50 text-slate-900"
                      }`}
                    >
                      {m.tone && m.role === "assistant" && (
                        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide opacity-80">
                          {m.tone === "question" ? "Next step" : m.tone === "hint" ? "Tutor hint" : "Note"}
                        </div>
                      )}
                      {m.content}
                      {m.role === "assistant" && m.summary && (
                        <div
                          className={`mt-2 rounded-lg px-3 py-2 text-[11px] whitespace-pre-line ${
                            darkMode ? "bg-slate-950/40 text-slate-200" : "bg-slate-100 text-slate-700"
                          }`}
                        >
                          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide opacity-70">Summary</div>
                          {m.summary}
                          {Array.isArray(m.assumptions) && m.assumptions.length > 0 && (
                            <div className="mt-2 opacity-80">
                              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide opacity-70">Assumptions</div>
                              <div>{m.assumptions.join(" ")}</div>
                            </div>
                          )}
                        </div>
                      )}
                      {loading &&
                        m.role === "assistant" &&
                        m.tone === "info" &&
                        m.content.trim() === "Generating activity... please wait." && (
                          <div className="mt-3 space-y-2">
                            {progressHint && (
                              <div
                                className={`rounded-lg px-3 py-2 text-[11px] ${
                                  darkMode ? "bg-amber-900/30 text-amber-200" : "bg-amber-50 text-amber-900"
                                }`}
                              >
                                {progressHint}
                              </div>
                            )}

                            {progress ? (
                              <>
                                <div className="space-y-1">
                                  <div className="flex items-center justify-between text-[11px] opacity-80">
                                    <div>Overall progress</div>
                                    <div>{renderOverallPercent(progress)}%</div>
                                  </div>
                                  <div
                                    className={`h-2 w-full overflow-hidden rounded-full ${
                                      darkMode ? "bg-slate-800" : "bg-slate-100"
                                    }`}
                                  >
                                    <div
                                      className="h-full rounded-full bg-blue-500 transition-[width] duration-300"
                                      style={{ width: `${renderOverallPercent(progress)}%` }}
                                    />
                                  </div>
                                </div>

                                {progress.error && (
                                  <div
                                    className={`rounded-lg px-3 py-2 text-[11px] ${
                                      darkMode ? "bg-rose-900/30 text-rose-200" : "bg-rose-50 text-rose-900"
                                    }`}
                                  >
                                    {progress.error}
                                  </div>
                                )}

                                <div
                                  className={`space-y-2 rounded-xl border p-3 ${
                                    darkMode ? "border-slate-800 bg-slate-950/40" : "border-slate-200 bg-white"
                                  }`}
                                >
                                  {progress.slots.map((p, i) => {
                                    const percent = renderSlotPercent(p);
                                    const active = p.stage !== "queued" && p.stage !== "done" && p.stage !== "failed";
                                    return (
                                      <div key={i} className="space-y-1">
                                        <div className="flex items-center justify-between gap-3 text-[12px]">
                                          <div className={`truncate ${active ? "font-medium" : ""}`}>
                                            Problem {i + 1}/{progress.totalSlots}
                                            {p.difficulty && p.topic
                                              ? ` (${p.difficulty} - ${p.topic})`
                                              : p.difficulty
                                                ? ` (${p.difficulty})`
                                                : ""}
                                          </div>
                                          <div className={`shrink-0 tabular-nums ${active ? "animate-pulse" : "opacity-80"}`}>
                                            {percent}%
                                          </div>
                                        </div>
                                        <div className="flex items-center justify-between gap-3 text-[11px] opacity-80">
                                          <div className={`truncate ${active ? "animate-pulse" : ""}`}>
                                            {renderSlotStatus(p)}
                                          </div>
                                        </div>
                                        <div
                                          className={`h-1.5 w-full overflow-hidden rounded-full ${
                                            darkMode ? "bg-slate-800" : "bg-slate-200"
                                          }`}
                                        >
                                          <div
                                            className={`h-full rounded-full transition-[width] duration-300 ${
                                              p.stage === "failed" ? "bg-rose-500" : "bg-emerald-500"
                                            }`}
                                            style={{ width: `${percent}%` }}
                                          />
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </>
                            ) : (
                              <div className="text-[11px] opacity-70">Waiting for progress events.</div>
                            )}
                          </div>
                        )}
                    </div>
                  </div>
                ))}

                {chatLoading && (
                  <div className="flex justify-start">
                    <div className={`flex items-center gap-3 rounded-2xl px-4 py-3 ${darkMode ? "bg-slate-900/60" : "bg-slate-100"}`}>
                      <div className="flex items-center gap-2">
                        <span
                          className={`h-1.5 w-1.5 animate-bounce rounded-full ${darkMode ? "bg-slate-500" : "bg-slate-400"}`}
                          style={{ animationDelay: "0ms" }}
                        />
                        <span
                          className={`h-1.5 w-1.5 animate-bounce rounded-full ${darkMode ? "bg-slate-500" : "bg-slate-400"}`}
                          style={{ animationDelay: "150ms" }}
                        />
                        <span
                          className={`h-1.5 w-1.5 animate-bounce rounded-full ${darkMode ? "bg-slate-500" : "bg-slate-400"}`}
                          style={{ animationDelay: "300ms" }}
                        />
                      </div>
                      <span className={`text-xs ${darkMode ? "text-slate-300" : "text-slate-600"}`}>
                        Codemm is preparing a reply
                      </span>
                    </div>
                  </div>
                )}
              </div>
              <div
                className={`rounded-b-[28px] px-5 py-4 ${
                  darkMode ? "border-slate-800" : "border-slate-200"
                }`}
              >
                {threadId && (
                  <div
                    className={`rounded-2xl border px-4 py-3 text-sm ${
                      darkMode
                        ? "border-slate-800 bg-slate-900/60 text-slate-200"
                        : "border-slate-200 bg-slate-50 text-slate-700"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-semibold">Problem focus (optional)</div>
                      <button
                        type="button"
                        onClick={() => setInstructionsOpen((v) => !v)}
                        className={`rounded-full border px-3 py-1 text-xs transition ${
                          darkMode
                            ? "border-slate-800 bg-slate-950/40 text-slate-200 hover:bg-slate-900"
                            : "border-slate-200 bg-white text-slate-700 hover:bg-slate-100"
                        }`}
                        disabled={generationLocked || instructionsSaving}
                      >
                        {instructionsOpen ? "Hide" : "Show"}
                      </button>
                    </div>

                    {instructionsOpen && (
                      <div className="mt-3 space-y-2">
                        <textarea
                          className={`w-full resize-none rounded-xl border px-3 py-2 text-xs outline-none transition focus:ring-1 ${
                            darkMode
                              ? "border-slate-800 bg-slate-950/40 text-slate-100 placeholder-slate-500 focus:border-sky-400 focus:ring-sky-400"
                              : "border-slate-200 bg-white text-slate-900 placeholder-slate-400 focus:border-sky-500 focus:ring-sky-500"
                          }`}
                          placeholder={`Example:\nFocus the problems around this code / API:\n\n\`\`\`java\nclass LRUCache { ... }\n\`\`\`\n\nAvoid graphs. Prefer hash maps and linked lists.`}
                          rows={6}
                          value={instructionsDraft}
                          onChange={(e) => setInstructionsDraft(e.target.value)}
                          disabled={generationLocked || instructionsSaving}
                        />
                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                          <div className="opacity-80">
                            Used during <span className="font-semibold">Generate</span>. Don’t paste API keys.
                          </div>
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => void saveInstructions(instructionsDraft)}
                              disabled={
                                generationLocked ||
                                instructionsSaving ||
                                instructionsDraft.trim() === instructionsSaved.trim()
                              }
                              className={`rounded-full px-3 py-1 font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-60 ${
                                darkMode ? "bg-sky-600 hover:bg-sky-500" : "bg-slate-900 hover:bg-black"
                              }`}
                            >
                              {instructionsSaving ? "Saving..." : "Save"}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setInstructionsDraft("");
                                void saveInstructions("");
                              }}
                              disabled={generationLocked || instructionsSaving}
                              className={`rounded-full border px-3 py-1 transition disabled:cursor-not-allowed disabled:opacity-60 ${
                                darkMode
                                  ? "border-slate-800 bg-slate-950/40 text-slate-200 hover:bg-slate-900"
                                  : "border-slate-200 bg-white text-slate-700 hover:bg-slate-100"
                              }`}
                            >
                              Clear
                            </button>
                          </div>
                        </div>
                        {instructionsError && (
                          <div className={darkMode ? "text-rose-200" : "text-rose-700"}>
                            {instructionsError}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
                <textarea
                  className={`w-full resize-none rounded-2xl border px-4 py-3 text-sm outline-none transition focus:ring-1 ${
                    darkMode
                      ? "border-slate-800 bg-slate-900 text-slate-100 placeholder-slate-500 focus:border-sky-400 focus:ring-sky-400"
                      : "border-slate-200 bg-white text-slate-900 placeholder-slate-400 focus:border-sky-500 focus:ring-sky-500"
                  }`}
                  data-tour="chat-input"
                  placeholder="Start solving..."
                  rows={3}
                  value={chatInput}
                  onChange={(e) => {
                    const next = e.target.value;
                    setChatInput(next);
                    if (next.trim().length > 0) setHasInteracted(true);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      if (chatInput.trim()) {
                        setHasInteracted(true);
                        handleChatSend();
                      }
                    }
                  }}
                  disabled={isBusy || specReady}
                />

                <div className="mt-3 flex flex-col items-end gap-3 sm:flex-row sm:items-center sm:justify-end">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleGenerate}
                      disabled={!specReady || isBusy || generationLocked}
                      data-tour="generate"
                      className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold text-white shadow-sm transition ${
                        darkMode
                          ? "bg-sky-600 hover:bg-sky-500 disabled:bg-slate-800"
                          : "bg-slate-900 hover:bg-black disabled:bg-slate-300"
                      } disabled:cursor-not-allowed disabled:opacity-60`}
                    >
                      {loading ? "Generating..." : "Generate"}
                    </button>
                    <button
                      onClick={handleChatSend}
                      disabled={chatLoading || !chatInput.trim() || specReady}
                      data-tour="send"
                      className={`flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold text-white shadow-sm transition ${
                        darkMode
                          ? "bg-sky-600 hover:bg-sky-500 disabled:bg-slate-800"
                          : "bg-slate-900 hover:bg-black disabled:bg-slate-300"
                      } disabled:cursor-not-allowed disabled:opacity-60`}
                    >
                      <svg className="h-4 w-4 rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                      </svg>
                      Send
                    </button>
                  </div>
                </div>
                {specReady && (
                  <div
                    className={`mt-3 rounded-lg px-4 py-2 text-xs ${
                      darkMode ? "bg-emerald-900/30 text-emerald-200" : "bg-emerald-50 text-emerald-700"
                    }`}
                  >
                    Activity spec is ready. Click "Generate" to create problems.
                  </div>
                )}
              </div>
            </div>
          </section>
        </main>

        {historyOpen && (
          <div className="fixed inset-0 z-50">
            <div
              className="absolute inset-0 bg-black/50"
              onClick={() => setHistoryOpen(false)}
              aria-hidden="true"
            />
            <div
              className={`absolute right-0 top-0 h-full w-full max-w-[420px] overflow-hidden border-l shadow-2xl ${
                darkMode ? "border-slate-800 bg-slate-950 text-slate-50" : "border-slate-200 bg-white text-slate-900"
              }`}
              role="dialog"
              aria-label="Chat history"
              aria-modal="true"
            >
              <div className={`flex items-center justify-between border-b px-4 py-4 ${darkMode ? "border-slate-800" : "border-slate-200"}`}>
                <div className="flex items-center gap-2">
                  <HistoryIcon className={`h-4 w-4 ${darkMode ? "text-slate-200" : "text-slate-700"}`} />
                  <div className={`text-sm font-semibold ${darkMode ? "text-slate-100" : "text-slate-900"}`}>Past chats</div>
                </div>
                <button
                  type="button"
                  onClick={() => setHistoryOpen(false)}
                  className={`rounded-full border p-2 transition ${
                    darkMode ? "border-slate-800 bg-slate-900/60 text-slate-200 hover:bg-slate-800" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                  aria-label="Close history"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="h-full overflow-y-auto px-4 py-4">
                <button
                  onClick={() => {
                    setHistoryOpen(false);
                    void startNewSession(learningMode);
                  }}
                  className={`w-full rounded-2xl px-4 py-3 text-left text-sm font-semibold transition ${
                    darkMode ? "bg-slate-900 text-slate-100 hover:bg-slate-800" : "bg-slate-900 text-white hover:bg-slate-800"
                  }`}
                >
                  New chat
                </button>

                    {historyLoading && (
                      <div className={`mt-4 text-xs ${darkMode ? "text-slate-400" : "text-slate-500"}`}>Loading…</div>
                    )}
                {historyError && (
                  <div
                    className={`mt-4 rounded-2xl border px-4 py-3 text-xs ${
                      darkMode ? "border-rose-900/40 bg-rose-900/20 text-rose-200" : "border-rose-200 bg-rose-50 text-rose-900"
                    }`}
                  >
                    {historyError}
                  </div>
                )}

                {!historyLoading && !historyError && (
                  <div className="mt-4 space-y-2">
                    {threadHistory.length === 0 && (
                      <div
                        className={`rounded-2xl border px-4 py-4 text-xs ${
                          darkMode ? "border-slate-800 text-slate-400" : "border-slate-200 text-slate-600"
                        }`}
                      >
                        No saved threads yet. Start a chat and it will show up here.
                      </div>
                    )}
                    {threadHistory.map((s) => {
                      const when = s.last_message_at || s.updated_at;
                      const whenText = when ? new Date(when).toLocaleDateString() : "";
                      const preview =
                        (typeof s.last_message === "string" && s.last_message.trim()
                          ? s.last_message
                          : `Thread ${s.id.slice(0, 8)}…`) as string;
                      return (
                        <button
                          key={s.id}
                          onClick={() => {
                            setHistoryOpen(false);
                            void loadSession(s.id);
                          }}
                          className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                            darkMode ? "border-slate-800 hover:bg-slate-900/60" : "border-slate-200 hover:bg-slate-50"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className={`text-xs font-semibold ${darkMode ? "text-slate-100" : "text-slate-900"}`}>
                              {s.learning_mode === "guided" ? "Guided" : "Practice"} • {s.state}
                            </div>
                            <div className={`text-[11px] ${darkMode ? "text-slate-400" : "text-slate-500"}`}>{whenText}</div>
                          </div>
                          <div className={`mt-1 truncate text-xs ${darkMode ? "text-slate-300" : "text-slate-700"}`}>
                            {preview}
                          </div>
                          <div className={`mt-1 text-[11px] ${darkMode ? "text-slate-500" : "text-slate-500"}`}>
                            {s.message_count} messages
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
