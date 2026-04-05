"use client";

import { useState } from "react";
import type { LanguageId } from "@/lib/languages";
import { countTests } from "@/lib/languages";
import type { Activity, Problem, ProblemStatus, FeedbackState, JudgeResult } from "../types";
import { isJudgeResult, sortTestCaseNames, getProblemLanguage } from "../utils";

type RightPaneTab = "testcases" | "results";

type Props = {
  activity: Activity;
  selectedProblemId: string | null;
  problemStatusById: Record<string, ProblemStatus>;
  feedback: FeedbackState | null;
  selectedLanguage: LanguageId;
  testSuite: string;
  onSelectProblem: (problem: Problem) => void;
  onClearFeedback: () => void;
  onRunAllTests: () => void;
  submitting: boolean;
};

export default function RightPane({
  activity,
  selectedProblemId,
  problemStatusById,
  feedback,
  selectedLanguage,
  testSuite,
  onSelectProblem,
  onClearFeedback,
  onRunAllTests,
  submitting,
}: Props) {
  const [bottomTab, setBottomTab] = useState<RightPaneTab>("testcases");

  const passed = activity.problems.filter((p) => problemStatusById[p.id] === "passed").length;
  const total = activity.problems.length;

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Top: Problem navigation list */}
      <div className="min-h-[140px] flex-shrink-0 overflow-auto rounded-xl border border-slate-200 bg-slate-50 p-3">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-semibold text-slate-900">Problems</h2>
          <span className="rounded-full bg-slate-200 px-2.5 py-0.5 text-[10px] font-semibold text-slate-600">
            {passed}/{total} passed
          </span>
        </div>
        <div className="space-y-1.5">
          {activity.problems.map((p, i) => {
            const status: ProblemStatus = problemStatusById[p.id] ?? "not_started";
            const active = selectedProblemId === p.id;
            const lang = getProblemLanguage(p);
            return (
              <button
                key={p.id}
                onClick={() => onSelectProblem(p)}
                className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition ${
                  active
                    ? "border-blue-300 bg-blue-50 ring-1 ring-blue-200"
                    : "border-slate-200 bg-white hover:bg-slate-50"
                }`}
              >
                <StatusIcon status={status} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-slate-900 truncate">
                      {i + 1}. {p.title}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[10px] font-medium text-slate-400 uppercase">{lang}</span>
                    {p.difficulty && (
                      <span
                        className={`rounded px-1.5 py-0.5 text-[9px] font-semibold ${
                          p.difficulty.toLowerCase() === "easy"
                            ? "bg-emerald-50 text-emerald-600"
                            : p.difficulty.toLowerCase() === "medium"
                            ? "bg-amber-50 text-amber-600"
                            : "bg-rose-50 text-rose-600"
                        }`}
                      >
                        {p.difficulty}
                      </span>
                    )}
                    {p.topic_tag && (
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-slate-500">
                        {p.topic_tag}
                      </span>
                    )}
                  </div>
                </div>
                <StatusLabel status={status} />
              </button>
            );
          })}
        </div>
      </div>

      {/* Bottom: Tabbed testcases/results */}
      <div className="flex min-h-0 flex-1 flex-col rounded-xl border border-slate-200 bg-white">
        {/* Tab bar */}
        <div className="flex border-b border-slate-200 px-3">
          <button
            onClick={() => setBottomTab("testcases")}
            className={`px-3 py-2 text-xs font-medium transition-colors ${
              bottomTab === "testcases"
                ? "border-b-2 border-blue-500 text-blue-700"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            Testcases
          </button>
          <button
            onClick={() => setBottomTab("results")}
            className={`px-3 py-2 text-xs font-medium transition-colors ${
              bottomTab === "results"
                ? "border-b-2 border-blue-500 text-blue-700"
                : "text-slate-500 hover:text-slate-700"
            }`}
          >
            Results
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-3">
          {bottomTab === "testcases" && (
            <TestcasesTab
              feedback={feedback}
              selectedLanguage={selectedLanguage}
              testSuite={testSuite}
              onRunAllTests={onRunAllTests}
              submitting={submitting}
            />
          )}
          {bottomTab === "results" && (
            <ResultsTab
              activity={activity}
              feedback={feedback}
              selectedLanguage={selectedLanguage}
              selectedProblemId={selectedProblemId}
              testSuite={testSuite}
              problemStatusById={problemStatusById}
              onClearFeedback={onClearFeedback}
              onSelectProblem={onSelectProblem}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: ProblemStatus }) {
  if (status === "passed") {
    return (
      <div className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
      </div>
    );
  }
  if (status === "failed") {
    return (
      <div className="flex h-6 w-6 items-center justify-center rounded-full bg-rose-100 text-rose-600">
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </div>
    );
  }
  if (status === "in_progress") {
    return (
      <div className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-100 text-blue-600">
        <div className="h-2 w-2 rounded-full bg-current animate-pulse" />
      </div>
    );
  }
  return (
    <div className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-100 text-slate-400">
      <div className="h-2 w-2 rounded-full border-2 border-current" />
    </div>
  );
}

function StatusLabel({ status }: { status: ProblemStatus }) {
  const config: Record<ProblemStatus, { label: string; cls: string }> = {
    passed: { label: "Passed", cls: "text-emerald-600" },
    failed: { label: "Failed", cls: "text-rose-600" },
    in_progress: { label: "In Progress", cls: "text-blue-600" },
    not_started: { label: "Not Started", cls: "text-slate-400" },
  };
  const c = config[status];
  return <span className={`text-[10px] font-semibold ${c.cls}`}>{c.label}</span>;
}

function TestcasesTab({
  feedback,
  selectedLanguage,
  testSuite,
  onRunAllTests,
  submitting,
}: {
  feedback: FeedbackState | null;
  selectedLanguage: LanguageId;
  testSuite: string;
  onRunAllTests: () => void;
  submitting: boolean;
}) {
  const feedbackResult = feedback?.result ?? null;
  const testCount = countTests(selectedLanguage, testSuite);
  const passedTests = isJudgeResult(feedbackResult) ? feedbackResult.passedTests : [];
  const failedTests = isJudgeResult(feedbackResult) ? feedbackResult.failedTests : [];

  const allTests = sortTestCaseNames([...passedTests, ...failedTests]);
  const hasResults = feedback?.kind === "tests" && isJudgeResult(feedbackResult);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium text-slate-500">
          {testCount} {testCount === 1 ? "test case" : "test cases"}
        </span>
        <button
          onClick={onRunAllTests}
          disabled={submitting}
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-[11px] font-semibold text-white shadow-sm hover:bg-blue-700 disabled:opacity-50 transition"
        >
          {submitting ? "Running..." : "Run all testcases"}
        </button>
      </div>

      {!hasResults && (
        <p className="text-[11px] text-slate-400">
          Click "Run all testcases" or "Check Code" to see results.
        </p>
      )}

      {hasResults && allTests.length === 0 && (
        <p className="text-[11px] text-slate-500">
          No individual test names were reported. Check the Results tab for details.
        </p>
      )}

      {hasResults && (
        <div className="space-y-1.5">
          {allTests.map((t) => {
            const passed = passedTests.includes(t);
            return (
              <div
                key={t}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${
                  passed
                    ? "border-emerald-200 bg-emerald-50"
                    : "border-rose-200 bg-rose-50"
                }`}
              >
                <span className={`text-sm font-bold ${passed ? "text-emerald-600" : "text-rose-600"}`}>
                  {passed ? "\u2713" : "\u2717"}
                </span>
                <span className={`text-xs font-medium ${passed ? "text-emerald-800" : "text-rose-800"}`}>
                  {t}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ResultsTab({
  activity,
  feedback,
  selectedLanguage,
  selectedProblemId,
  testSuite,
  problemStatusById,
  onClearFeedback,
  onSelectProblem,
}: {
  activity: Activity;
  feedback: FeedbackState | null;
  selectedLanguage: LanguageId;
  selectedProblemId: string | null;
  testSuite: string;
  problemStatusById: Record<string, ProblemStatus>;
  onClearFeedback: () => void;
  onSelectProblem: (problem: Problem) => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  const feedbackResult = feedback?.result ?? null;

  if (!feedbackResult) {
    return (
      <p className="text-[11px] text-slate-400">
        Run or check your code to see results here.
      </p>
    );
  }

  const passedTests = isJudgeResult(feedbackResult) ? feedbackResult.passedTests : [];
  const failedTests = isJudgeResult(feedbackResult) ? feedbackResult.failedTests : [];
  const judgeTimedOut = Boolean(isJudgeResult(feedbackResult) && feedbackResult.timedOut);
  const judgeExitCode =
    isJudgeResult(feedbackResult) && typeof feedbackResult.exitCode === "number"
      ? feedbackResult.exitCode
      : undefined;

  const totalTests = passedTests.length + failedTests.length;
  const score = totalTests > 0 ? passedTests.length : 0;
  const maxScore = totalTests > 0 ? totalTests : 0;

  const allPassed = isJudgeResult(feedbackResult) && feedbackResult.success && !judgeTimedOut;

  const testCaseDetails = isJudgeResult(feedbackResult) && Array.isArray(feedbackResult.testCaseDetails)
    ? feedbackResult.testCaseDetails
    : [];
  const detailByName = new Map(testCaseDetails.map((detail) => [detail.name, detail]));

  return (
    <div className="space-y-3">
      {/* Run metadata */}
      {feedback && (
        <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          <div className="text-[11px] text-slate-600">
            <span className="font-semibold text-slate-800">Last {feedback.kind === "run" ? "run" : "check"}:</span>{" "}
            {(() => {
              const idx = activity.problems.findIndex((p) => p.id === feedback.problemId);
              return idx >= 0 ? `Problem ${idx + 1}` : "Problem";
            })()}
            <span className="text-slate-400 ml-1">
              {new Date(feedback.atIso).toLocaleTimeString()}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {isJudgeResult(feedbackResult) && feedbackResult.executionTimeMs != null && (
              <span className="text-[10px] font-mono text-slate-500">
                {feedbackResult.executionTimeMs.toFixed(0)}ms
              </span>
            )}
            <button
              onClick={onClearFeedback}
              className="text-[11px] font-medium text-slate-500 hover:text-slate-700"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Score summary */}
      {isJudgeResult(feedbackResult) && (
        <div className={`rounded-xl border p-4 ${
          allPassed
            ? "border-emerald-200 bg-emerald-50"
            : judgeTimedOut
            ? "border-amber-200 bg-amber-50"
            : "border-rose-200 bg-rose-50"
        }`}>
          <div className="flex items-center justify-between">
            <div>
              <div className={`text-sm font-bold ${
                allPassed ? "text-emerald-700" : judgeTimedOut ? "text-amber-700" : "text-rose-700"
              }`}>
                {allPassed ? "All Tests Passed!" : judgeTimedOut ? "Timed Out" : "Tests Failed"}
              </div>
              <div className={`text-xs mt-0.5 ${
                allPassed ? "text-emerald-600" : judgeTimedOut ? "text-amber-600" : "text-rose-600"
              }`}>
                Total Score: {score}/{maxScore}
              </div>
            </div>
            <div className={`text-2xl font-bold ${
              allPassed ? "text-emerald-600" : judgeTimedOut ? "text-amber-600" : "text-rose-600"
            }`}>
              {maxScore > 0 ? Math.round((score / maxScore) * 100) : 0}%
            </div>
          </div>

          {judgeTimedOut && (
            <p className="mt-2 text-[11px] text-amber-700">
              The judge timed out. Check for infinite loops or slow Docker startup.
            </p>
          )}
        </div>
      )}

      {/* Detailed test results */}
      {isJudgeResult(feedbackResult) && (
        <div className="space-y-1.5">
          {sortTestCaseNames([...passedTests, ...failedTests]).map((t) => {
            const passed = passedTests.includes(t);
            const detail = detailByName.get(t);
            const input = detail?.input;
            const expectedOutput = detail?.expectedOutput;
            const actualOutput = detail?.actualOutput;
            const message = detail?.message;

            return (
              <details
                key={t}
                className={`group rounded-lg border ${
                  passed ? "border-emerald-200 bg-emerald-50" : "border-rose-200 bg-rose-50"
                }`}
              >
                <summary className="cursor-pointer list-none select-none px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className={`font-semibold text-xs ${passed ? "text-emerald-800" : "text-rose-800"}`}>
                      {passed ? "\u2713" : "\u2717"} {t}
                    </div>
                    <div className="text-[10px] text-slate-500 group-open:hidden">Show</div>
                    <div className="hidden text-[10px] text-slate-500 group-open:block">Hide</div>
                  </div>
                </summary>
                <div className="px-3 pb-3 space-y-2">
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div className="rounded border border-slate-200 bg-white p-2">
                      <div className="text-[10px] font-semibold text-slate-600 uppercase">Expected Input</div>
                      <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-800">
                        {input || "(not available)"}
                      </pre>
                    </div>
                    <div className="rounded border border-slate-200 bg-white p-2">
                      <div className="text-[10px] font-semibold text-slate-600 uppercase">Your Output</div>
                      <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-800">
                        {actualOutput || "(not available)"}
                      </pre>
                    </div>
                  </div>
                  {expectedOutput && (
                    <div className="rounded border border-slate-200 bg-white p-2">
                      <div className="text-[10px] font-semibold text-slate-600 uppercase">Expected Output</div>
                      <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-800">
                        {expectedOutput}
                      </pre>
                    </div>
                  )}
                  {message && (
                    <div className="rounded border border-slate-200 bg-white p-2">
                      <div className="text-[10px] font-semibold text-slate-600 uppercase">Notes</div>
                      <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 font-mono text-[11px] text-slate-800">
                        {message}
                      </pre>
                      {detail?.location && (
                        <div className="mt-1 text-[10px] text-slate-500">
                          Location: <span className="font-mono">{detail.location}</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </details>
            );
          })}
        </div>
      )}

      {/* Non-judge (run) results */}
      {feedbackResult && !isJudgeResult(feedbackResult) && (
        <div className="space-y-2">
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <div className="text-[11px] font-semibold text-slate-700">Program Output</div>
            <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-white p-2 font-mono text-[11px] text-slate-800">
              {feedbackResult.formattedStdout || feedbackResult.stdout || "(empty)"}
            </pre>
          </div>
          {feedbackResult.stderr && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2">
              <div className="text-[11px] font-semibold text-rose-700">Errors</div>
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-white p-2 font-mono text-[11px] text-rose-800">
                {feedbackResult.formattedStderr || feedbackResult.stderr}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Detail/Diagnostics toggles */}
      {isJudgeResult(feedbackResult) && (
        <>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setShowDetails((v) => !v)}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
            >
              {showDetails ? "Hide details" : "Show details"}
            </button>
            <button
              onClick={() => setShowDiagnostics((v) => !v)}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
            >
              {showDiagnostics ? "Hide diagnostics" : "Show diagnostics"}
            </button>
          </div>
          {showDetails && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-2">
              <div className="text-[11px] font-semibold text-slate-700 mb-1">Test runner output</div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-white p-2 font-mono text-[11px] text-slate-800">
                {feedbackResult.formattedStdout || feedbackResult.stdout || "(empty)"}
              </pre>
            </div>
          )}
          {showDiagnostics && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-2">
              <div className="text-[11px] font-semibold text-rose-700 mb-1">Diagnostics</div>
              {(judgeExitCode != null || judgeTimedOut) && (
                <div className="text-[10px] text-slate-600 mb-1">
                  {judgeExitCode != null && <>Exit code: <span className="font-mono">{judgeExitCode}</span></>}
                  {judgeTimedOut && <>{judgeExitCode != null ? " \u00b7 " : ""}Timed out</>}
                </div>
              )}
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-white p-2 font-mono text-[11px] text-rose-800">
                {feedbackResult.formattedStderr || feedbackResult.stderr || "(empty)"}
              </pre>
            </div>
          )}
        </>
      )}

      {/* View solution button (appears when all passed) */}
      {isJudgeResult(feedbackResult) && feedbackResult.success && !judgeTimedOut && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-center">
          <div className="text-xs font-semibold text-emerald-700">Problem complete!</div>
          <p className="mt-1 text-[11px] text-emerald-600">
            All test cases passed. Great work!
          </p>
        </div>
      )}
    </div>
  );
}
