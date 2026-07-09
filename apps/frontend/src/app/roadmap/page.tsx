"use client";

import Link from "next/link";
import { ArrowLeft, Check, Moon, RefreshCw, Star, Sun } from "lucide-react";
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

// Winding-path geometry (fixed coordinate space, centered; scrolls on narrow screens).
const COL_W = 340;
const ROW_H = 132;
const TOP_PAD = 64;
const BOTTOM_PAD = 40;
const AMPLITUDE = 104;
const NODE = 68;

function masteryPercent(mastery: number): number {
  return Math.round(Math.max(0, Math.min(1, mastery)) * 100);
}

function nodeX(index: number): number {
  // Serpentine: smooth sine oscillation left/right of center.
  return COL_W / 2 + Math.sin(index * 0.85) * AMPLITUDE;
}

function nodeY(index: number): number {
  return TOP_PAD + ROW_H / 2 + index * ROW_H;
}

/** Smooth vertical-tangent bezier trail through the node centers. */
function buildTrailPath(count: number): string {
  if (count === 0) return "";
  let d = `M ${nodeX(0)} ${nodeY(0)}`;
  for (let i = 1; i < count; i++) {
    const x0 = nodeX(i - 1);
    const y0 = nodeY(i - 1);
    const x1 = nodeX(i);
    const y1 = nodeY(i);
    const c = (y1 - y0) / 2;
    d += ` C ${x0} ${y0 + c} ${x1} ${y1 - c} ${x1} ${y1}`;
  }
  return d;
}

type NodeColors = { ring: string; track: string; fill: string; text: string; border: string };

function nodeColors(status: ModuleStatusDto, recommended: boolean, darkMode: boolean): NodeColors {
  if (recommended) {
    return {
      ring: "#0ea5e9",
      track: darkMode ? "#1e293b" : "#e2e8f0",
      fill: darkMode ? "#0c4a6e" : "#e0f2fe",
      text: darkMode ? "#e0f2fe" : "#075985",
      border: "#0ea5e9",
    };
  }
  if (status === "mastered") {
    return {
      ring: "#10b981",
      track: darkMode ? "#064e3b" : "#d1fae5",
      fill: "#10b981",
      text: "#ffffff",
      border: "#10b981",
    };
  }
  if (status === "in_progress") {
    return {
      ring: "#f59e0b",
      track: darkMode ? "#1e293b" : "#e2e8f0",
      fill: darkMode ? "#78350f" : "#fef3c7",
      text: darkMode ? "#fde68a" : "#92400e",
      border: "#f59e0b",
    };
  }
  return {
    ring: darkMode ? "#475569" : "#cbd5e1",
    track: darkMode ? "#1e293b" : "#e2e8f0",
    fill: darkMode ? "#0f172a" : "#f8fafc",
    text: darkMode ? "#94a3b8" : "#64748b",
    border: darkMode ? "#334155" : "#cbd5e1",
  };
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
  const modules = path?.modules ?? [];
  const canvasH = TOP_PAD + modules.length * ROW_H + BOTTOM_PAD;

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
          Follow the trail. Each stop is a concept &mdash; the ring fills as your submissions pass. Start at the glowing
          stop and work your way down.
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
              <div
                className="rm-bar relative h-full overflow-hidden rounded-full bg-sky-500"
                style={{ width: `${masteryPercent(path.overallMastery)}%` }}
              >
                <span className="rm-shimmer" aria-hidden="true" />
              </div>
            </div>
            {path.recommendedConcept ? (
              <p className="mt-4 text-sm">
                <span className={darkMode ? "text-slate-400" : "text-slate-600"}>Start here: </span>
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
          <div className="mt-4 overflow-x-auto">
            <div className="relative mx-auto" style={{ width: COL_W, height: canvasH }}>
              <svg
                className="absolute inset-0"
                width={COL_W}
                height={canvasH}
                viewBox={`0 0 ${COL_W} ${canvasH}`}
                fill="none"
                aria-hidden="true"
              >
                <path
                  className="rm-trail"
                  d={buildTrailPath(modules.length)}
                  stroke={darkMode ? "#334155" : "#cbd5e1"}
                  strokeWidth={6}
                  strokeLinecap="round"
                  strokeDasharray="2 16"
                />
              </svg>

              {modules.map((m: LearningPathModuleDto, i: number) => {
                const x = nodeX(i);
                const y = nodeY(i);
                const c = nodeColors(m.status, m.recommended, darkMode);
                const pct = masteryPercent(m.mastery);
                return (
                  <div
                    key={`${language}:${m.concept}`}
                    className="rm-node absolute"
                    style={{ left: x, top: y, transform: "translate(-50%, -50%)", animationDelay: `${i * 90}ms` }}
                  >
                    {m.recommended && (
                      <div className="rm-bob absolute -top-11 left-1/2 -translate-x-1/2 whitespace-nowrap">
                        <div className="relative rounded-full bg-sky-600 px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-white shadow-lg">
                          Start
                          <div className="absolute -bottom-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-sky-600" />
                        </div>
                      </div>
                    )}
                    <div
                      className={`rm-circle relative flex items-center justify-center rounded-full ${m.recommended ? "animate-pulse-slow" : ""}`}
                      style={{
                        width: NODE,
                        height: NODE,
                        background: `conic-gradient(${c.ring} ${pct}%, ${c.track} ${pct}% 100%)`,
                        boxShadow: m.recommended ? `0 0 0 6px ${darkMode ? "rgba(14,165,233,0.18)" : "rgba(14,165,233,0.16)"}` : "none",
                      }}
                      title={`${m.concept} · ${STATUS_LABEL[m.status]} · ${pct}%`}
                    >
                      {m.recommended && <span className="rm-sonar" aria-hidden="true" />}
                      <div
                        className="rm-inner flex items-center justify-center rounded-full"
                        style={{ width: NODE - 12, height: NODE - 12, background: c.fill, border: `2px solid ${c.border}`, color: c.text }}
                      >
                        {m.status === "mastered" ? (
                          <Check className="rm-icon h-6 w-6" strokeWidth={3} />
                        ) : m.recommended ? (
                          <Star className="rm-icon rm-twinkle h-6 w-6" fill="currentColor" strokeWidth={0} />
                        ) : (
                          <span className="rm-icon text-sm font-bold">{pct}%</span>
                        )}
                      </div>
                    </div>
                    <div
                      className="absolute left-1/2 top-full mt-1.5 w-40 -translate-x-1/2 text-center"
                      style={{ color: darkMode ? "#cbd5e1" : "#334155" }}
                    >
                      <div className="truncate text-xs font-semibold capitalize" title={m.concept}>
                        {m.concept}
                      </div>
                      <div className={`text-[11px] ${darkMode ? "text-slate-500" : "text-slate-400"}`}>
                        {m.passes}/{m.attempts} passed
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <style>{`
        /* The trail's dots march forward — a gentle "follow me" cue. */
        @keyframes rm-march { to { stroke-dashoffset: -18; } }
        .rm-trail { animation: rm-march 2.6s linear infinite; }

        /* Stops pop onto the trail one by one with a springy overshoot. */
        @keyframes rm-pop {
          0% { opacity: 0; transform: translate(-50%, -50%) scale(0.2); }
          70% { opacity: 1; transform: translate(-50%, -50%) scale(1.12); }
          100% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        }
        .rm-node { animation: rm-pop 480ms cubic-bezier(0.34, 1.56, 0.64, 1) both; }

        /* The recommended stop breathes... */
        @keyframes roadmap-pulse-slow {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.06); }
        }
        .animate-pulse-slow { animation: roadmap-pulse-slow 2.4s ease-in-out infinite; }

        /* ...and radiates a sonar ping. */
        @keyframes rm-sonar {
          0% { opacity: 0.55; transform: scale(1); }
          100% { opacity: 0; transform: scale(1.7); }
        }
        .rm-sonar {
          position: absolute;
          inset: 0;
          border-radius: 9999px;
          border: 3px solid #0ea5e9;
          animation: rm-sonar 1.8s ease-out infinite;
          pointer-events: none;
        }

        /* The Start bubble bobs like it's waving you over. */
        @keyframes rm-bob {
          0%, 100% { transform: translate(-50%, 0); }
          50% { transform: translate(-50%, -6px); }
        }
        .rm-bob { animation: rm-bob 1.6s ease-in-out infinite; }

        /* The star on the next stop twinkles. */
        @keyframes rm-twinkle {
          0%, 100% { transform: scale(1) rotate(0deg); }
          40% { transform: scale(1.18) rotate(8deg); }
          60% { transform: scale(0.94) rotate(-6deg); }
        }
        .rm-twinkle { animation: rm-twinkle 2.8s ease-in-out infinite; }

        /* Hover: the stop leans in; a mastered check takes a victory spin. */
        .rm-inner, .rm-icon { transition: transform 260ms cubic-bezier(0.34, 1.56, 0.64, 1); }
        .rm-node:hover .rm-inner { transform: scale(1.12); }
        .rm-node:hover .rm-icon { transform: rotate(360deg); }

        /* Overall mastery fills in, then a shimmer sweeps across it. */
        @keyframes rm-grow { from { width: 0; } }
        .rm-bar { animation: rm-grow 900ms cubic-bezier(0.22, 1, 0.36, 1) both; }
        @keyframes rm-shimmer-sweep {
          0% { transform: translateX(-100%); }
          60%, 100% { transform: translateX(220%); }
        }
        .rm-shimmer {
          position: absolute;
          inset: 0;
          width: 45%;
          background: linear-gradient(105deg, transparent, rgba(255, 255, 255, 0.55), transparent);
          animation: rm-shimmer-sweep 2.4s ease-in-out 600ms infinite;
        }

        @media (prefers-reduced-motion: reduce) {
          .rm-trail, .rm-node, .rm-sonar, .rm-bob, .rm-twinkle, .rm-bar, .rm-shimmer, .animate-pulse-slow {
            animation: none !important;
          }
          .rm-inner, .rm-icon { transition: none !important; }
          .rm-sonar { display: none; }
        }
      `}</style>
    </div>
  );
}
