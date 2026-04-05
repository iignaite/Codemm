"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSpecBuilderUX, type BackendSpecResponse } from "@/lib/specBuilderUx";
import { threadsClient, type GenerationDiagnosticsState, type ThreadSummary } from "@/lib/bridge/threadsClient";
import type { LearningMode } from "@/lib/bridge/codemmBridge";
import type { GenerationProgressEvent } from "@codemm/shared-contracts";
import { reduceGenerationProgress, type GenerationProgressState } from "@/lib/threads/progressReducer";

export type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  tone?: "question" | "hint" | "info";
  summary?: string;
  assumptions?: string[];
};

export function useThread() {
  const router = useRouter();
  const { interpretResponse, formatSlotPrompt, normalizeInput, activeSlot } = useSpecBuilderUX();
  const [loading, setLoading] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [hasInteracted, setHasInteracted] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
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
  const [generationDiagnostics, setGenerationDiagnostics] = useState<GenerationDiagnosticsState | null>(null);
  const progressRef = useRef<null | { unsubscribe: () => Promise<void> }>(null);

  const [instructionsOpen, setInstructionsOpen] = useState(false);
  const [instructionsSaved, setInstructionsSaved] = useState<string>("");
  const [instructionsDraft, setInstructionsDraft] = useState<string>("");
  const [instructionsSaving, setInstructionsSaving] = useState(false);
  const [instructionsError, setInstructionsError] = useState<string | null>(null);

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
      setGenerationDiagnostics(null);
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

      const data = (await threadsClient.create({ learning_mode: mode })) as Record<string, unknown>;

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
      specReadyRef.current = false;
      setProgress(null);
      setProgressHint(null);
      setGenerationRunId(null);
      setGenerationDiagnostics(null);
      setGenerationLocked(false);
      generationLoadingRef.current = false;
      setMessages([]);
      setChatInput("");
      setHasInteracted(false);
      setInstructionsOpen(false);
      setInstructionsSaved("");
      setInstructionsDraft("");
      setInstructionsError(null);

      const data = (await threadsClient.get({ threadId: existingSessionId })) as Record<string, unknown>;

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
          .map((message) => {
            const record = typeof message === "object" && message !== null ? (message as Record<string, unknown>) : null;
            const role = record?.role === "assistant" ? "assistant" : "user";
            const content = typeof record?.content === "string" ? record.content : "";
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
      await threadsClient.setInstructions({ threadId, instructions_md: normalized });
      setInstructionsSaved(trimmed);
      setInstructionsDraft(trimmed);
    } catch (error) {
      setInstructionsError(error instanceof Error ? error.message : "Failed to save instructions.");
    } finally {
      setInstructionsSaving(false);
    }
  }

  async function fetchSessionHistory(limit: number = 30) {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const data = (await threadsClient.list({ limit })) as Record<string, unknown>;
      setThreadHistory(Array.isArray(data?.threads) ? data.threads : []);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "Failed to load chat history");
    } finally {
      setHistoryLoading(false);
    }
  }

  useEffect(() => {
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

  async function refreshGenerationDiagnostics(runId?: string | null) {
    if (!threadId) return null;
    const diagnostics = await threadsClient.getGenerationDiagnostics({
      threadId,
      ...(runId ? { runId } : {}),
    });
    setGenerationDiagnostics(diagnostics);
    if (typeof diagnostics?.runId === "string" && diagnostics.runId) {
      setGenerationRunId(diagnostics.runId);
    }
    return diagnostics;
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
      const data = (await threadsClient.postMessage({
        threadId,
        message: normalized.value,
      })) as BackendSpecResponse & Record<string, unknown>;

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
        const assistantContent = data.accepted ? data.nextQuestion : [data.error, data.nextQuestion].filter(Boolean).join("\n\n");
        const summary = typeof data.assistant_summary === "string" ? data.assistant_summary : undefined;
        const assumptions = Array.isArray(data.assumptions) ? data.assumptions : undefined;

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
            content: "Sorry, something went wrong processing your answer. Please try again in the expected format.",
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

      setProgress(null);
      setProgressHint(null);
      setGenerationRunId(null);
      setGenerationDiagnostics(null);

      const hintTimer = window.setTimeout(
        () => setProgressHint("Preparing generation... local models can take longer to emit the first update."),
        4000,
      );

      const sub = await threadsClient.subscribeGeneration({
        threadId,
        onEvent: (event: GenerationProgressEvent) => {
          window.clearTimeout(hintTimer);
          setProgressHint((prev) =>
            prev === "Preparing generation... local models can take longer to emit the first update." ? null : prev,
          );
          try {
            setProgress((prev) => {
              const reduced = reduceGenerationProgress({ progress: prev, event });
              if (typeof reduced.hint === "string") {
                setProgressHint(reduced.hint);
              }
              return reduced.progress;
            });
          } catch {
            // ignore parse errors
          }
        },
      });
      progressRef.current = { unsubscribe: sub.unsubscribe };

      const data = (await threadsClient.generateLatest({ threadId })) as Record<string, unknown>;
      window.clearTimeout(hintTimer);
      if (typeof data?.runId === "string") {
        runIdForDiagnostics = data.runId;
        setGenerationRunId(data.runId);
        await refreshGenerationDiagnostics(data.runId).catch(() => {});
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
        const diag = await refreshGenerationDiagnostics(runIdForDiagnostics ?? generationRunId);
        const latest = diag?.latestFailure;
        if (latest && typeof latest.message === "string") {
          const actions = Array.isArray(latest.remediation) ? latest.remediation.slice(0, 2).join(" | ") : "";
          diagnosticMessage = actions
            ? `Latest failure: ${latest.message} Next actions: ${actions}.`
            : `Latest failure: ${latest.message}`;
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

  return {
    loading,
    chatInput,
    setChatInput,
    hasInteracted,
    setHasInteracted,
    messages,
    chatLoading,
    threadHistory,
    historyLoading,
    historyError,
    threadId,
    learningMode,
    setLearningMode,
    generationLocked,
    specReady,
    progress,
    progressHint,
    generationRunId,
    generationDiagnostics,
    instructionsOpen,
    setInstructionsOpen,
    instructionsSaved,
    instructionsDraft,
    setInstructionsDraft,
    instructionsSaving,
    instructionsError,
    startNewSession,
    loadSession,
    saveInstructions,
    fetchSessionHistory,
    handleChatSend,
    handleGenerate,
    refreshGenerationDiagnostics,
  };
}
