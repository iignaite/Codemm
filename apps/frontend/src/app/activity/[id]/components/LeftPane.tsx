"use client";

import { useState } from "react";
import type { Problem, ProblemStatus } from "../types";
import { countStudentTodoMarkers } from "../utils";

type LeftPaneTab = "description" | "hints" | "samples";

type Props = {
  problem: Problem | undefined;
  problemIndex: number;
  totalProblems: number;
  status: ProblemStatus;
};

export default function LeftPane({ problem, problemIndex, totalProblems, status }: Props) {
  const [activeTab, setActiveTab] = useState<LeftPaneTab>("description");

  const statusBadge =
    status === "passed"
      ? "bg-emerald-50 text-emerald-800 border-emerald-200"
      : status === "failed"
      ? "bg-rose-50 text-rose-800 border-rose-200"
      : status === "in_progress"
      ? "bg-blue-50 text-blue-800 border-blue-200"
      : "bg-slate-100 text-slate-700 border-slate-200";

  const statusLabel =
    status === "passed"
      ? "Passed"
      : status === "failed"
      ? "Failed"
      : status === "in_progress"
      ? "In progress"
      : "Not started";

  const tabs: { key: LeftPaneTab; label: string }[] = [
    { key: "description", label: "Description" },
    { key: "hints", label: "Help & Hints" },
    { key: "samples", label: "Sample Cases" },
  ];

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Problem header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Problem {problemIndex + 1} of {totalProblems}
          </div>
          <h2 className="mt-1 truncate text-sm font-semibold text-slate-900">
            {problem?.title ?? "Problem"}
          </h2>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
              {(problem?.language ?? "java").toUpperCase()}
            </span>
            {problem?.difficulty && (
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                problem.difficulty.toLowerCase() === "easy"
                  ? "bg-emerald-50 text-emerald-700"
                  : problem.difficulty.toLowerCase() === "medium"
                  ? "bg-amber-50 text-amber-700"
                  : "bg-rose-50 text-rose-700"
              }`}>
                {problem.difficulty}
              </span>
            )}
            {problem?.topic_tag && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
                {problem.topic_tag}
              </span>
            )}
          </div>
        </div>
        <span className={`shrink-0 rounded-full border px-3 py-1 text-[11px] font-semibold ${statusBadge}`}>
          {statusLabel}
        </span>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-slate-200">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-3 py-2 text-xs font-medium transition-colors ${
              activeTab === tab.key
                ? "border-b-2 border-blue-500 text-blue-700"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="min-h-0 flex-1 overflow-auto">
        {activeTab === "description" && (
          <DescriptionTab problem={problem} />
        )}
        {activeTab === "hints" && (
          <HintsTab problem={problem} />
        )}
        {activeTab === "samples" && (
          <SampleCasesTab problem={problem} />
        )}
      </div>
    </div>
  );
}

function DescriptionTab({ problem }: { problem: Problem | undefined }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-800">
      {problem?.pedagogy && (
        <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-700">
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {typeof problem.pedagogy.learning_goal === "string" &&
              problem.pedagogy.learning_goal.trim() && (
                <span>
                  <span className="font-semibold text-slate-800">Learning goal:</span>{" "}
                  {problem.pedagogy.learning_goal.trim()}
                </span>
              )}
            {typeof problem.pedagogy.scaffold_level === "number" && (
              <span>
                <span className="font-semibold text-slate-800">Scaffold:</span>{" "}
                {problem.pedagogy.scaffold_level}%
              </span>
            )}
            <span>
              <span className="font-semibold text-slate-800">TODO regions:</span>{" "}
              {countStudentTodoMarkers(problem)}
            </span>
          </div>
        </div>
      )}

      <h3 className="text-sm font-semibold text-slate-900">Description</h3>
      <p className="mt-2 whitespace-pre-line text-xs leading-relaxed text-slate-700">
        {problem?.description ?? ""}
      </p>

      {problem?.constraints ? (
        <>
          <h4 className="mt-5 text-xs font-semibold text-slate-900">Constraints</h4>
          <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
            {problem.constraints}
          </div>
        </>
      ) : null}
    </div>
  );
}

function HintsTab({ problem }: { problem: Problem | undefined }) {
  const hintsEnabled = problem?.pedagogy?.hints_enabled;
  const learningGoal = problem?.pedagogy?.learning_goal?.trim();

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-800">
      <h3 className="text-sm font-semibold text-slate-900">Help & Hints</h3>

      {learningGoal && (
        <div className="mt-3 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2">
          <div className="text-[11px] font-semibold text-blue-800">Learning Goal</div>
          <p className="mt-1 text-xs text-blue-700">{learningGoal}</p>
        </div>
      )}

      {problem?.pedagogy && typeof problem.pedagogy.scaffold_level === "number" && (
        <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          <div className="text-[11px] font-semibold text-slate-800">Scaffold Level</div>
          <div className="mt-2 flex items-center gap-2">
            <div className="h-2 flex-1 rounded-full bg-slate-200">
              <div
                className="h-2 rounded-full bg-blue-500 transition-all"
                style={{ width: `${problem.pedagogy.scaffold_level}%` }}
              />
            </div>
            <span className="text-[11px] font-medium text-slate-600">{problem.pedagogy.scaffold_level}%</span>
          </div>
          <p className="mt-1 text-[11px] text-slate-500">
            {problem.pedagogy.scaffold_level > 70
              ? "High scaffolding - most of the code is provided. Focus on the TODO regions."
              : problem.pedagogy.scaffold_level > 30
              ? "Moderate scaffolding - some structure is provided. Implement the logic in TODO regions."
              : "Low scaffolding - you will need to write most of the solution yourself."}
          </p>
        </div>
      )}

      {!hintsEnabled && !learningGoal && !problem?.pedagogy && (
        <p className="mt-3 text-xs text-slate-500">
          No hints available for this problem. Read the description and constraints carefully.
        </p>
      )}

      {problem?.constraints && (
        <div className="mt-3 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2">
          <div className="text-[11px] font-semibold text-amber-800">Key Constraints</div>
          <p className="mt-1 text-xs text-amber-700">{problem.constraints}</p>
        </div>
      )}
    </div>
  );
}

function SampleCasesTab({ problem }: { problem: Problem | undefined }) {
  const sampleIns = problem?.sample_inputs || problem?.sampleInputs || [];
  const sampleOuts = problem?.sample_outputs || problem?.sampleOutputs || [];
  const count = Math.max(1, sampleIns.length, sampleOuts.length);

  if (sampleIns.length === 0 && sampleOuts.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-slate-900">Sample Cases</h3>
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900">
          This problem has no sample cases. New activities include examples by default.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {Array.from({ length: count }).map((_, i) => {
        const input = typeof sampleIns[i] === "string" ? sampleIns[i]! : "";
        const output = typeof sampleOuts[i] === "string" ? sampleOuts[i]! : "";

        return (
          <div key={i} className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="text-xs font-semibold text-slate-900">
              Sample Case {i + 1}
            </div>

            <div className="mt-3 grid gap-3">
              {/* Input */}
              <div>
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Input
                </div>
                <pre className="max-h-48 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-[11px] text-slate-800">
                  {input.trim() || "(empty)"}
                </pre>
              </div>

              {/* Output */}
              <div>
                <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Expected Output
                </div>
                <pre className="max-h-48 overflow-auto rounded-lg border border-emerald-100 bg-emerald-50 p-3 font-mono text-[11px] text-emerald-800">
                  {output.trim() || "(empty)"}
                </pre>
              </div>

              {/* Explanation placeholder */}
              {input.trim() && output.trim() && (
                <div>
                  <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Explanation
                  </div>
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-[11px] text-slate-600">
                    Given the input above, the program should produce the expected output.
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
