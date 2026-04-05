"use client";

import Link from "next/link";
import { History as HistoryIcon, LayoutGrid, Moon, Sun, X } from "lucide-react";
import { useEffect, useState } from "react";
import { OnboardingTour, type TourStep } from "@/components/OnboardingTour";
import { type LearningMode } from "@/lib/bridge/codemmBridge";
import { renderOverallPercent, renderSlotPercent, renderSlotStatus } from "@/lib/threads/progressReducer";
import { useThread } from "@/hooks/useThread";

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

export default function Home() {
  const {
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
  } = useThread();

  const [darkMode, setDarkMode] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("codem-theme") === "dark";
  });
  const [historyOpen, setHistoryOpen] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const key = "codem-tutorial-v1";
    if (localStorage.getItem(key) === "1") return;
    const timeoutId = window.setTimeout(() => setTourOpen(true), 500);
    return () => window.clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!historyOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHistoryOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [historyOpen]);

  const handleLogoClick = () => {
    if (typeof window === "undefined") return;
    if (window.location.pathname === "/") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  const toggleDarkMode = () => {
    const nextMode = !darkMode;
    setDarkMode(nextMode);
    localStorage.setItem("codem-theme", nextMode ? "dark" : "light");
  };

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
                      darkMode
                        ? "border-slate-800 bg-slate-900/60 text-slate-200"
                        : "border-slate-200 bg-slate-50 text-slate-700"
                    }`}
                  >
                    Ask any coding question and Codemm will walk you through it. Start typing below or pick a quick action.
                  </div>
                )}

                {messages.map((message, idx) => (
                  <div key={idx} className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div
                      className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-line ${
                        message.role === "user"
                          ? "bg-slate-900 text-white shadow-sm dark:bg-slate-800"
                          : message.tone === "question"
                            ? darkMode
                              ? "border border-slate-800 bg-slate-900/70 text-slate-100"
                              : "border border-slate-200 bg-white text-slate-900"
                            : message.tone === "hint"
                              ? darkMode
                                ? "border border-amber-700/60 bg-amber-900/30 text-amber-100"
                                : "border border-amber-200 bg-amber-50 text-amber-900"
                              : message.tone === "info"
                                ? darkMode
                                  ? "border border-slate-800 bg-slate-900/60 text-slate-100"
                                  : "border border-blue-100 bg-blue-50 text-slate-900"
                                : darkMode
                                  ? "bg-slate-900/60 text-slate-100"
                                  : "bg-slate-50 text-slate-900"
                      }`}
                    >
                      {message.tone && message.role === "assistant" && (
                        <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide opacity-80">
                          {message.tone === "question" ? "Next step" : message.tone === "hint" ? "Tutor hint" : "Note"}
                        </div>
                      )}
                      {message.content}
                      {message.role === "assistant" && message.summary && (
                        <div
                          className={`mt-2 rounded-lg px-3 py-2 text-[11px] whitespace-pre-line ${
                            darkMode ? "bg-slate-950/40 text-slate-200" : "bg-slate-100 text-slate-700"
                          }`}
                        >
                          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide opacity-70">Summary</div>
                          {message.summary}
                          {Array.isArray(message.assumptions) && message.assumptions.length > 0 && (
                            <div className="mt-2 opacity-80">
                              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide opacity-70">Assumptions</div>
                              <div>{message.assumptions.join(" ")}</div>
                            </div>
                          )}
                        </div>
                      )}
                      {(loading || Boolean(generationDiagnostics)) &&
                        message.role === "assistant" &&
                        message.tone === "info" &&
                        message.content.trim() === "Generating activity... please wait." && (
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
                                  {progress.slots.map((slot, index) => {
                                    const percent = renderSlotPercent(slot);
                                    const active = slot.stage !== "queued" && slot.stage !== "done" && slot.stage !== "failed";
                                    return (
                                      <div key={index} className="space-y-1">
                                        <div className="flex items-center justify-between gap-3 text-[12px]">
                                          <div className={`truncate ${active ? "font-medium" : ""}`}>
                                            Problem {index + 1}/{progress.totalSlots}
                                            {slot.difficulty && slot.topic
                                              ? ` (${slot.difficulty} - ${slot.topic})`
                                              : slot.difficulty
                                                ? ` (${slot.difficulty})`
                                                : ""}
                                          </div>
                                          <div className={`shrink-0 tabular-nums ${active ? "animate-pulse" : "opacity-80"}`}>
                                            {percent}%
                                          </div>
                                        </div>
                                        <div className="flex items-center justify-between gap-3 text-[11px] opacity-80">
                                          <div className={`truncate ${active ? "animate-pulse" : ""}`}>
                                            {renderSlotStatus(slot)}
                                          </div>
                                        </div>
                                        <div
                                          className={`h-1.5 w-full overflow-hidden rounded-full ${
                                            darkMode ? "bg-slate-800" : "bg-slate-200"
                                          }`}
                                        >
                                          <div
                                            className={`h-full rounded-full transition-[width] duration-300 ${
                                              slot.stage === "failed" ? "bg-rose-500" : "bg-emerald-500"
                                            }`}
                                            style={{ width: `${percent}%` }}
                                          />
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>

                                {generationDiagnostics ? (
                                  <div
                                    className={`space-y-3 rounded-xl border p-3 text-[11px] ${
                                      darkMode
                                        ? "border-slate-800 bg-slate-950/60 text-slate-200"
                                        : "border-slate-200 bg-white text-slate-700"
                                    }`}
                                  >
                                    <div className="flex items-center justify-between gap-3">
                                      <div className="font-semibold">Run Details</div>
                                      <button
                                        className={`rounded-md px-2 py-1 ${
                                          darkMode ? "bg-slate-800 hover:bg-slate-700" : "bg-slate-100 hover:bg-slate-200"
                                        }`}
                                        onClick={() => refreshGenerationDiagnostics(generationRunId).catch(() => {})}
                                        type="button"
                                      >
                                        Refresh
                                      </button>
                                    </div>

                                    <div className="grid gap-1 opacity-80">
                                      <div>Attempts: {generationDiagnostics.summary.totalAttempts}</div>
                                      <div>
                                        Timings: LLM {Math.round((generationDiagnostics.summary.llmMs ?? 0) / 1000)}s | Docker{" "}
                                        {Math.round((generationDiagnostics.summary.dockerMs ?? 0) / 1000)}s
                                      </div>
                                      {generationDiagnostics.run?.meta?.routePlan?.modelsByRole ? (
                                        <div>
                                          Route plan:{" "}
                                          {Object.entries(generationDiagnostics.run.meta.routePlan.modelsByRole)
                                            .map(([role, route]) => `${role}:${route?.model || "auto"}${route?.capability ? ` (${route.capability})` : ""}`)
                                            .join(" | ")}
                                        </div>
                                      ) : null}
                                    </div>

                                    {generationDiagnostics.latestFailure ? (
                                      <div
                                        className={`rounded-lg px-3 py-2 ${
                                          darkMode ? "bg-rose-950/50 text-rose-200" : "bg-rose-50 text-rose-800"
                                        }`}
                                      >
                                        <div className="font-medium">Latest failure</div>
                                        <div className="mt-1">{generationDiagnostics.latestFailure.message}</div>
                                        {generationDiagnostics.latestFailure.terminationReason ? (
                                          <div className="mt-1 opacity-80">{generationDiagnostics.latestFailure.terminationReason}</div>
                                        ) : null}
                                      </div>
                                    ) : null}

                                    {generationDiagnostics.stageTimeline.length > 0 ? (
                                      <div className="space-y-1">
                                        <div className="font-medium">Recent stages</div>
                                        {generationDiagnostics.stageTimeline.slice(-6).reverse().map((entry, index) => (
                                          <div
                                            key={`${entry.slotIndex}:${entry.stage}:${entry.attempt}:${entry.status}:${index}`}
                                            className={`rounded-lg px-3 py-2 ${darkMode ? "bg-slate-900/80" : "bg-slate-50"}`}
                                          >
                                            <div className="font-medium">
                                              Slot {entry.slotIndex + 1} {entry.stage} {entry.status}
                                            </div>
                                            <div className="mt-1 opacity-80">
                                              attempt {entry.attempt}
                                              {entry.model ? ` • ${entry.model}` : ""}
                                              {typeof entry.durationMs === "number" ? ` • ${entry.durationMs} ms` : ""}
                                            </div>
                                            {entry.message ? <div className="mt-1 opacity-90">{entry.message}</div> : null}
                                            {entry.reason ? <div className="mt-1 opacity-80">{entry.reason}</div> : null}
                                          </div>
                                        ))}
                                      </div>
                                    ) : null}
                                  </div>
                                ) : null}
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
                        onClick={() => setInstructionsOpen((value) => !value)}
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
                          onChange={(event) => setInstructionsDraft(event.target.value)}
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
                  onChange={(event) => {
                    const nextValue = event.target.value;
                    setChatInput(nextValue);
                    if (nextValue.trim().length > 0) setHasInteracted(true);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      if (chatInput.trim()) {
                        setHasInteracted(true);
                        void handleChatSend();
                      }
                    }
                  }}
                  disabled={isBusy || specReady}
                />

                <div className="mt-3 flex flex-col items-end gap-3 sm:flex-row sm:items-center sm:justify-end">
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => void handleGenerate()}
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
                      onClick={() => void handleChatSend()}
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
                    Activity spec is ready. Click &quot;Generate&quot; to create problems.
                  </div>
                )}
              </div>
            </div>
          </section>
        </main>

        {historyOpen && (
          <div className="fixed inset-0 z-50">
            <div className="absolute inset-0 bg-black/50" onClick={() => setHistoryOpen(false)} aria-hidden="true" />
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
                    darkMode
                      ? "border-slate-800 bg-slate-900/60 text-slate-200 hover:bg-slate-800"
                      : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
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
                    {threadHistory.map((thread) => {
                      const when = thread.last_message_at || thread.updated_at;
                      const whenText = when ? new Date(when).toLocaleDateString() : "";
                      const preview =
                        (typeof thread.last_message === "string" && thread.last_message.trim()
                          ? thread.last_message
                          : `Thread ${thread.id.slice(0, 8)}…`) as string;
                      return (
                        <button
                          key={thread.id}
                          onClick={() => {
                            setHistoryOpen(false);
                            void loadSession(thread.id);
                          }}
                          className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                            darkMode ? "border-slate-800 hover:bg-slate-900/60" : "border-slate-200 hover:bg-slate-50"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className={`text-xs font-semibold ${darkMode ? "text-slate-100" : "text-slate-900"}`}>
                              {thread.learning_mode === "guided" ? "Guided" : "Practice"} • {thread.state}
                            </div>
                            <div className={`text-[11px] ${darkMode ? "text-slate-400" : "text-slate-500"}`}>{whenText}</div>
                          </div>
                          <div className={`mt-1 truncate text-xs ${darkMode ? "text-slate-300" : "text-slate-700"}`}>
                            {preview}
                          </div>
                          <div className={`mt-1 text-[11px] ${darkMode ? "text-slate-500" : "text-slate-500"}`}>
                            {thread.message_count} messages
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
