"use client";

import Link from "next/link";
import { ArrowLeft, Moon, RefreshCw, Search, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import type { ActivitySummaryDto } from "@codemm/shared-contracts";
import { activitiesClient } from "@/lib/bridge/activitiesClient";
import { useThemeMode } from "@/lib/useThemeMode";

type ActivitySummary = ActivitySummaryDto;

function formatTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

export default function ActivitiesPage() {
  const { darkMode, toggleDarkMode } = useThemeMode();
  const [items, setItems] = useState<ActivitySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  async function load(limit: number = 100) {
    setLoading(true);
    setError(null);
    try {
      const data = await activitiesClient.list({ limit });
      setItems(Array.isArray(data.activities) ? data.activities : []);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to load activities.";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = q
    ? items.filter((a) => {
        const title = String(a.title ?? "").toLowerCase();
        const id = String(a.id ?? "").toLowerCase();
        const status = String(a.status ?? "").toLowerCase();
        return title.includes(q) || id.includes(q) || status.includes(q);
      })
    : items;

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
          <div className="absolute inset-4 rounded-[32px] opacity-60" />
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-6 py-8">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <h1 className={`text-xl font-semibold ${darkMode ? "text-white" : "text-slate-900"}`}>Your activities</h1>
            <div className={`text-sm ${darkMode ? "text-slate-300" : "text-slate-600"}`}>
              Local-only drafts you generated in this workspace.
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/"
              className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition ${
                darkMode
                  ? "border border-slate-800 bg-slate-900/60 text-slate-200 hover:bg-slate-800"
                  : "border border-slate-200 bg-white/80 text-slate-700 hover:bg-slate-100"
              }`}
            >
              <ArrowLeft className="h-4 w-4" />
              Back
            </Link>
            <button
              type="button"
              onClick={() => void load()}
              className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 ${
                darkMode
                  ? "bg-slate-800 text-slate-300 hover:bg-slate-700"
                  : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              }`}
              disabled={loading}
            >
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              {loading ? "Loading..." : "Refresh"}
            </button>
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

        <div className="flex items-center gap-2">
          <div className={`flex w-full items-center gap-2 rounded-full border px-4 py-2 ${
            darkMode ? "border-slate-800 bg-slate-900/60" : "border-slate-200 bg-white/85"
          }`}>
            <Search className={`h-4 w-4 ${darkMode ? "text-slate-400" : "text-slate-500"}`} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search title, status, or ID…"
              className={`w-full bg-transparent text-sm outline-none ${
                darkMode ? "text-slate-100 placeholder-slate-500" : "text-slate-900 placeholder-slate-400"
              }`}
            />
          </div>
        </div>

        {error && (
          <div
            className={`rounded-xl border px-4 py-3 text-sm ${
              darkMode ? "border-rose-900/50 bg-rose-900/20 text-rose-200" : "border-rose-200 bg-rose-50 text-rose-800"
            }`}
          >
            {error}
          </div>
        )}

        <div
          className={`overflow-hidden rounded-[28px] border shadow-xl backdrop-blur transition-all duration-300 ${
            darkMode ? "border-slate-800 bg-slate-900/70" : "border-slate-200 bg-white/85"
          }`}
        >
          {filtered.length === 0 && !loading ? (
            <div className={`px-5 py-6 text-sm ${darkMode ? "text-slate-300" : "text-slate-600"}`}>
              {items.length === 0 ? (
                <>
                  No activities yet. Go back and click <span className="font-semibold">Generate</span>.
                </>
              ) : (
                <>No matches for “{query.trim()}”.</>
              )}
            </div>
          ) : (
            <div className={darkMode ? "divide-y divide-slate-800" : "divide-y divide-slate-200"}>
              {filtered.map((a) => (
                <div key={a.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div
                      className={`truncate text-sm font-semibold ${darkMode ? "text-slate-100" : "text-slate-900"}`}
                      title={a.title || "Untitled activity"}
                    >
                      {a.title || "Untitled activity"}
                    </div>
                    <div className={`mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs ${darkMode ? "text-slate-400" : "text-slate-500"}`}>
                      <div>Status: {a.status || "DRAFT"}</div>
                      <div>Created: {formatTs(a.created_at)}</div>
                      {typeof a.time_limit_seconds === "number" ? <div>Timer: {a.time_limit_seconds}s</div> : null}
                      <div className="truncate">ID: {a.id}</div>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Link
                      href={`/activity/${a.id}`}
                      className={`rounded-full px-4 py-2 text-sm font-semibold text-white shadow-sm transition ${
                        darkMode ? "bg-sky-600 hover:bg-sky-500" : "bg-slate-900 hover:bg-black"
                      }`}
                    >
                      Practice
                    </Link>
                    <Link
                      href={`/activity/${a.id}/review`}
                      className={`rounded-full border px-4 py-2 text-sm font-semibold transition ${
                        darkMode
                          ? "border-slate-800 bg-slate-900/60 text-slate-200 hover:bg-slate-800"
                          : "border-slate-200 bg-white/80 text-slate-700 hover:bg-slate-100"
                      }`}
                    >
                      Review
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
