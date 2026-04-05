import type { LanguageId } from "@/lib/languages";
import type { JudgeResult, RunResult, Problem } from "./types";

export function clampNumber(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function getProblemLanguage(p: Problem | null | undefined): LanguageId {
  if (p?.language === "python") return "python";
  if (p?.language === "cpp") return "cpp";
  if (p?.language === "sql") return "sql";
  return "java";
}

export function isJudgeResult(x: JudgeResult | RunResult | null | undefined): x is JudgeResult {
  if (!x || typeof x !== "object") return false;
  const anyX = x as any;
  return (
    typeof anyX.success === "boolean" &&
    Array.isArray(anyX.passedTests) &&
    Array.isArray(anyX.failedTests) &&
    typeof anyX.stdout === "string" &&
    typeof anyX.stderr === "string"
  );
}

export function countStudentTodoMarkersInText(text: string): number {
  if (!text) return 0;
  return (text.match(/BEGIN STUDENT TODO/g) ?? []).length;
}

export function countStudentTodoMarkers(problem: Problem): number {
  if (problem.workspace?.files?.length) {
    return problem.workspace.files.reduce((sum, f) => sum + countStudentTodoMarkersInText(f.content), 0);
  }
  return countStudentTodoMarkersInText(problem.starter_code ?? problem.classSkeleton ?? "");
}

export function sortTestCaseNames(names: string[]): string[] {
  const uniq = Array.from(new Set(names)).filter(Boolean);
  const score = (s: string) => {
    const m = s.match(/\btest_case_(\d+)\b/i);
    return m ? Number(m[1]) : Number.POSITIVE_INFINITY;
  };
  return uniq.sort((a, b) => {
    const na = score(a);
    const nb = score(b);
    if (na !== nb) return na - nb;
    return a.localeCompare(b);
  });
}

export function formatTime(totalSeconds: number) {
  const m = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const s = (totalSeconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}
