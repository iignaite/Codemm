"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { OnboardingTour, type TourStep } from "@/components/OnboardingTour";

type Problem = {
  id: string;
  title: string;
  description: string;
  language?: string;
  difficulty?: string;
  topic_tag?: string;
};

type Activity = {
  id: string;
  title: string;
  prompt: string;
  problems: Problem[];
  createdAt: string;
  status?: "DRAFT" | "INCOMPLETE" | "PUBLISHED";
  timeLimitSeconds?: number | null;
};

function requireActivitiesApi() {
  const api = (window as any)?.codemm?.activities;
  if (!api) throw new Error("IDE bridge unavailable. Launch this UI inside Codemm-Desktop.");
  return api;
}

function clampInt(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function getErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && typeof err.message === "string" && err.message.trim()) return err.message;
  if (typeof err === "string" && err.trim()) return err;
  return fallback;
}

export default function ActivityReviewPage() {
  const params = useParams<{ id: string }>();
  const activityId = params.id;
  const router = useRouter();

  const [loading, setLoading] = useState(true);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [timeLimitMinutes, setTimeLimitMinutes] = useState<string>("0");

  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [editingProblemId, setEditingProblemId] = useState<string | null>(null);
  const [editInstruction, setEditInstruction] = useState<string>("");
  const [editing, setEditing] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [tourOpen, setTourOpen] = useState(false);

  const isEditableDraft = ["DRAFT", "INCOMPLETE"].includes(activity?.status ?? "PUBLISHED");

  const tourSteps: TourStep[] = [
    {
      id: "settings",
      selector: '[data-tour="draft-settings"]',
      title: "Edit the draft settings",
      body: "Change the title and timer anytime before publishing.",
    },
    {
      id: "save",
      selector: '[data-tour="draft-save"]',
      title: "Save your draft",
      body: "Save after making edits so they’re persisted.",
    },
    {
      id: "ai-edit",
      selector: '[data-tour="draft-ai-edit"]',
      title: "Edit a problem with AI",
      body: "Use AI edit to regenerate that specific problem and update its test cases.",
    },
    {
      id: "publish",
      selector: '[data-tour="draft-publish"]',
      title: "Publish when ready",
      body: "Publishing makes the activity shareable. Incomplete activities stay blocked until all failed slots are repaired.",
    },
  ];

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isEditableDraft) return;
    const key = "codem-tutorial-draft-review-v1";
    if (localStorage.getItem(key) === "1") return;
    const t = window.setTimeout(() => setTourOpen(true), 600);
    return () => window.clearTimeout(t);
  }, [isEditableDraft]);

  const shareUrl = useMemo(() => {
    if (typeof window === "undefined") return null;
    if (!activityId) return null;
    return `${window.location.origin}/activity/${activityId}`;
  }, [activityId]);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const data = await requireActivitiesApi().get({ id: activityId });

        const act = data?.activity as Activity | undefined;
        if (!act) throw new Error("Failed to load activity.");

        setActivity(act);
        setTitle(act.title ?? "");
        const mins =
          typeof act.timeLimitSeconds === "number" && act.timeLimitSeconds > 0
            ? String(Math.max(1, Math.round(act.timeLimitSeconds / 60)))
            : "0";
        setTimeLimitMinutes(mins);
      } catch (e: unknown) {
        setError(getErrorMessage(e, "Failed to load activity."));
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, [activityId, router]);

  async function saveDraft(): Promise<Activity | null> {
    const mins = clampInt(Number.parseInt(timeLimitMinutes || "0", 10), 0, 8 * 60);
    const timeLimitSeconds = mins > 0 ? mins * 60 : null;

    setSaving(true);
    setToast(null);
    try {
      const data = await requireActivitiesApi().patch({
        id: activityId,
        title: title.trim() || "Untitled activity",
        timeLimitSeconds,
      });
      const act = data?.activity as Activity | undefined;
      if (act) setActivity(act);
      setToast("Saved.");
      return act ?? null;
    } finally {
      setSaving(false);
    }
  }

  async function publish() {
    setPublishing(true);
    setToast(null);
    try {
      await saveDraft();

      await requireActivitiesApi().publish({ id: activityId });

      setActivity((prev) => (prev ? { ...prev, status: "PUBLISHED" } : prev));
      setToast("Published. You can share the link now.");
    } catch (e: unknown) {
      setError(getErrorMessage(e, "Failed to publish."));
    } finally {
      setPublishing(false);
    }
  }

  async function copyShareLink() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setToast("Link copied.");
    } catch {
      setToast("Could not copy link.");
    }
  }

  async function editProblemWithAi(problemId: string) {
    const instruction = editInstruction.trim();
    if (!instruction) {
      setEditError("Tell the AI what to change.");
      return;
    }

    setEditing(true);
    setEditError(null);
    setToast(null);
    try {
      const data = await requireActivitiesApi().aiEdit({ id: activityId, problemId, instruction });

      const act = data?.activity as Activity | undefined;
      if (act) {
        setActivity(act);
        setToast("Problem updated.");
        setEditingProblemId(null);
        setEditInstruction("");
      }
    } catch (e: unknown) {
      setEditError(getErrorMessage(e, "Failed to edit problem."));
    } finally {
      setEditing(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100 text-slate-900">
        <div className="rounded-lg bg-white px-4 py-3 text-sm shadow">Loading…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100 text-slate-900">
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-4 shadow">
          <div className="text-sm font-semibold text-slate-900">Couldn’t open this activity</div>
          <div className="mt-1 text-sm text-slate-600">{error}</div>
          <div className="mt-4 flex gap-2">
            <button
              onClick={() => router.push("/")}
              className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Home
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!activity) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-100 text-slate-900">
        <div className="rounded-lg bg-white px-4 py-3 text-sm shadow">Activity not found.</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white text-slate-900">
      <div className="mx-auto flex min-h-screen max-w-4xl flex-col px-4 py-6">
        <OnboardingTour
          open={tourOpen}
          steps={tourSteps}
          onClose={() => {
            setTourOpen(false);
            try {
              localStorage.setItem("codem-tutorial-draft-review-v1", "1");
            } catch {
              // ignore
            }
          }}
        />
        <header className="mb-5 flex flex-col gap-3 border-b border-slate-200 pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Activity Review</p>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold tracking-tight">{activity.title}</h1>
              <span
                className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
                  activity.status === "INCOMPLETE"
                    ? "bg-rose-100 text-rose-800"
                    : isEditableDraft
                      ? "bg-amber-100 text-amber-800"
                      : "bg-emerald-100 text-emerald-800"
                }`}
              >
                {activity.status === "INCOMPLETE" ? "Incomplete" : isEditableDraft ? "Draft" : "Published"}
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              {activity.status === "INCOMPLETE"
                ? "Generation only partially succeeded. Review the surviving problems here; standard learner flow stays blocked."
                : "Preview and edit before publishing. Timer applies per problem."}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => router.push("/")}
              className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Home
            </button>
            <button
              onClick={() => router.push(`/activity/${activityId}`)}
              className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              disabled={activity.status === "INCOMPLETE"}
            >
              Open
            </button>
          </div>
        </header>

        <main className="grid gap-4 md:grid-cols-[1.2fr_1fr]">
          <section
            className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
            data-tour="draft-settings"
          >
            <h2 className="text-sm font-semibold text-slate-900">Settings</h2>

            <label className="mt-3 block text-xs font-medium text-slate-700">Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={!isEditableDraft || saving || publishing}
              className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 disabled:bg-slate-50"
              placeholder="Activity title"
            />

            <label className="mt-3 block text-xs font-medium text-slate-700">Timer per problem (minutes)</label>
            <input
              value={timeLimitMinutes}
              onChange={(e) => setTimeLimitMinutes(e.target.value)}
              disabled={!isEditableDraft || saving || publishing}
              inputMode="numeric"
              className="mt-1 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-500 disabled:bg-slate-50"
              placeholder="0"
            />
            <p className="mt-1 text-xs text-slate-500">Use 0 for no timer (stopwatch).</p>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button
                onClick={() => void saveDraft()}
                disabled={!isEditableDraft || saving || publishing}
                data-tour="draft-save"
                className="rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
              >
                {saving ? "Saving…" : activity.status === "INCOMPLETE" ? "Save incomplete activity" : "Save draft"}
              </button>
              <button
                onClick={() => void publish()}
                disabled={!isEditableDraft || saving || publishing || activity.status === "INCOMPLETE"}
                data-tour="draft-publish"
                className="rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-60"
              >
                {publishing ? "Publishing…" : "Publish"}
              </button>
              {toast && <span className="text-sm text-slate-600">{toast}</span>}
            </div>

            {activity.status === "INCOMPLETE" && (
              <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
                Publishing is disabled for incomplete activities until the failed generation slots are repaired.
              </div>
            )}

          {!isEditableDraft && shareUrl && (
              <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Share link</div>
                <div className="mt-1 flex items-center gap-2">
                  <code className="flex-1 overflow-x-auto rounded-lg bg-white px-2 py-1 text-xs text-slate-800">
                    {shareUrl}
                  </code>
                  <button
                    onClick={() => void copyShareLink()}
                    className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    Copy
                  </button>
                </div>
              </div>
            )}

          </section>

          <section className="rounded-2xl border border-slate-200 bg-slate-50 p-4 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-900">Preview</h2>
            <p className="mt-1 text-xs text-slate-600">
              {activity.problems.length} problems
            </p>
            <div className="mt-3 space-y-2">
              {activity.problems.map((p) => (
                <details key={p.id} className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                  <summary className="cursor-pointer text-sm font-medium text-slate-900">
                    {p.title}
                    <span className="ml-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                      {(p.language ?? "java").toUpperCase()}
                    </span>
                    {isEditableDraft && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          setEditError(null);
                          setToast(null);
                          setEditingProblemId((cur) => (cur === p.id ? null : p.id));
                          setEditInstruction("");
                        }}
                        data-tour="draft-ai-edit"
                        className="ml-3 rounded-full border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-slate-700 hover:bg-slate-50"
                      >
                        AI edit
                      </button>
                    )}
                  </summary>
                  <div className="mt-2 text-sm text-slate-700 whitespace-pre-line">{p.description}</div>

                  {isEditableDraft && editingProblemId === p.id && (
                    <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
                      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Edit with AI
                      </div>
                      <p className="mt-1 text-xs text-slate-600">
                        Describe what to change. The AI will regenerate the problem and its tests.
                      </p>
                      <textarea
                        value={editInstruction}
                        onChange={(e) => setEditInstruction(e.target.value)}
                        rows={4}
                        className="mt-2 w-full resize-none rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-slate-400 focus:outline-none"
                        placeholder='Example: "Make it accept duplicates and add edge cases for empty input."'
                      />
                      {editError && <div className="mt-2 text-xs text-red-600">{editError}</div>}
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={editing}
                          onClick={() => void editProblemWithAi(p.id)}
                          className="rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60"
                        >
                          {editing ? "Updating…" : "Update problem"}
                        </button>
                        <button
                          type="button"
                          disabled={editing}
                          onClick={() => {
                            setEditingProblemId(null);
                            setEditInstruction("");
                            setEditError(null);
                          }}
                          className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </details>
              ))}
            </div>
          </section>
        </main>
      </div>
    </div>
  );
}
