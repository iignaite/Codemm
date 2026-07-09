"use client";

import Link from "next/link";
import { ArrowLeft, Moon, RefreshCw, Sun } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { LearningPathDto, LearningPathModuleDto, ModuleStatusDto } from "@codemm/shared-contracts";
import { learningClient, type PathLanguage } from "@/lib/bridge/learningClient";
import { useThemeMode } from "@/lib/useThemeMode";

const LANGUAGES: { value: PathLanguage; label: string }[] = [
  { value: "java", label: "Java" },
  { value: "python", label: "Python" },
  { value: "cpp", label: "C++" },
  { value: "sql", label: "SQL" },
];

const STATUS_LABEL: Record<ModuleStatusDto, string> = {
  in_progress: "In progress",
  not_started: "Not started",
  mastered: "Mastered",
};

function statusBadgeClass(status: ModuleStatusDto, darkMode: boolean): string {
  switch (status) {
    case "mastered":
      return darkMode ? "bg-emerald-900/50 text-emerald-300" : "bg-emerald-100 text-emerald-700";
    case "in_progress":
      return darkMode ? "bg-amber-900/50 text-amber-300" : "bg-amber-100 text-amber-700";
    default:
      return darkMode ? "bg-slate-800 text-slate-400" : "bg-slate-100 text-slate-500";
  }
}

function masteryPercent(mastery: number): number {
  return Math.round(Math.max(0, Math.min(1, mastery)) * 100);
}

export default function RoadmapPage() {
  const { darkMode, toggleDarkMode } = useThemeMode();
  const [language, setLanguage] = useState<PathLanguage>("java");
  const [path, setPath] = useState<LearningPathDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (lang: PathLanguage) => {
    setLoading(true);
    setError(null);
    try {
      const res = await learningClient.getPath({ language: lang });
      setPath(res.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load your roadmap.");
      setPath(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(language);
  }, [language, load]);

  const empty = path && path.totalCount === 0;

  return (
    <div className={darkMode ? "min-h-screen bg-slate-950 text-slate-100" : "min-h-screen bg-slate-50 text-slate-900"}>
      <div className="mx-auto max-w-3xl px-6 py-8">
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className={`inline-flex items-center gap-2 rounded-full px-3 py-2 text-sm font-medium transition ${
                darkMode ? "bg-slate-800 text-slate-300 hover:bg-slate-700" : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              <ArrowLeft className="h-4 w-4" />
              Home
            </Link>
            <h1 className="text-lg font-semibold">Your roadmap</h1>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void load(language)}
              className={`inline-flex items-center gap-2 rounded-full px-3 py-2 text-sm font-medium transition ${
                darkMode ? "bg-slate-800 text-slate-300 hover:bg-slate-700" : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </button>
            <button
              onClick={toggleDarkMode}
              className={`flex h-10 w-10 items-center justify-center rounded-full transition ${darkMode ? "text-slate-200 hover:text-white" : "text-slate-600 hover:text-slate-900"}`}
              aria-label="Toggle dark mode"
            >
              {darkMode ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </button>
          </div>
        </header>

        <p className={`mt-2 text-sm ${darkMode ? "text-slate-400" : "text-slate-600"}`}>
          Your skill map is built from the concepts you have practiced and how well your submissions passed. Work down the
          list &mdash; the concept that needs the most attention is at the top.
        </p>

        <div className="mt-5 flex flex-wrap gap-2">
          {LANGUAGES.map((l) => (
            <button
              key={l.value}
              onClick={() => setLanguage(l.value)}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
                language === l.value
                  ? "bg-sky-600 text-white"
                  : darkMode
                    ? "bg-slate-800 text-slate-300 hover:bg-slate-700"
                    : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              {l.label}
            </button>
          ))}
        </div>

        {error && (
          <div className={`mt-5 rounded-xl border p-4 text-sm ${darkMode ? "border-rose-900 bg-rose-950/40 text-rose-300" : "border-rose-200 bg-rose-50 text-rose-700"}`}>
            {error}
          </div>
        )}

        {path && !empty && (
          <section className={`mt-6 rounded-2xl border p-5 ${darkMode ? "border-slate-800 bg-slate-900" : "border-slate-200 bg-white"}`}>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">Overall mastery</div>
                <div className="text-2xl font-semibold">{masteryPercent(path.overallMastery)}%</div>
              </div>
              <div className={`text-sm ${darkMode ? "text-slate-400" : "text-slate-600"}`}>
                {path.masteredCount} of {path.totalCount} mastered
              </div>
            </div>
            <div className={`mt-3 h-2 w-full overflow-hidden rounded-full ${darkMode ? "bg-slate-800" : "bg-slate-100"}`}>
              <div className="h-full rounded-full bg-sky-500" style={{ width: `${masteryPercent(path.overallMastery)}%` }} />
            </div>
            {path.recommendedConcept ? (
              <p className="mt-4 text-sm">
                <span className={darkMode ? "text-slate-400" : "text-slate-600"}>Work on next: </span>
                <span className="font-semibold">{path.recommendedConcept}</span>
              </p>
            ) : (
              <p className="mt-4 text-sm font-medium text-emerald-500">You have mastered every tracked concept. 🎉</p>
            )}
          </section>
        )}

        {empty && (
          <div className={`mt-6 rounded-2xl border p-6 text-sm ${darkMode ? "border-slate-800 bg-slate-900 text-slate-300" : "border-slate-200 bg-white text-slate-600"}`}>
            No concepts tracked for {LANGUAGES.find((l) => l.value === language)?.label} yet. Generate an activity and check
            your solutions &mdash; your mastery and roadmap build up automatically from there.{" "}
            <Link href="/" className="font-semibold text-sky-500 underline">
              Start an activity
            </Link>
          </div>
        )}

        {path && !empty && (
          <ul className="mt-4 space-y-2">
            {path.modules.map((m: LearningPathModuleDto) => (
              <li
                key={m.concept}
                className={`rounded-xl border p-4 ${
                  m.recommended
                    ? darkMode
                      ? "border-sky-700 bg-sky-950/30"
                      : "border-sky-300 bg-sky-50"
                    : darkMode
                      ? "border-slate-800 bg-slate-900"
                      : "border-slate-200 bg-white"
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{m.concept}</span>
                    {m.recommended && (
                      <span className="rounded-full bg-sky-600 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-white">
                        Next
                      </span>
                    )}
                  </div>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${statusBadgeClass(m.status, darkMode)}`}>
                    {STATUS_LABEL[m.status]}
                  </span>
                </div>
                <div className={`mt-2 flex items-center gap-3 text-xs ${darkMode ? "text-slate-400" : "text-slate-500"}`}>
                  <span>{masteryPercent(m.mastery)}% mastery</span>
                  <span>·</span>
                  <span>
                    {m.passes}/{m.attempts} attempts passed
                  </span>
                </div>
                <div className={`mt-2 h-1.5 w-full overflow-hidden rounded-full ${darkMode ? "bg-slate-800" : "bg-slate-100"}`}>
                  <div
                    className={`h-full rounded-full ${m.status === "mastered" ? "bg-emerald-500" : "bg-sky-500"}`}
                    style={{ width: `${masteryPercent(m.mastery)}%` }}
                  />
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
