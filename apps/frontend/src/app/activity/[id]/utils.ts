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

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
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

export function parseJUnitTree(stdout: string): { passed: string[]; failed: string[] } {
  const clean = stripAnsi(stdout);
  const passed: string[] = [];
  const failed: string[] = [];
  const seen = new Set<string>();

  for (const line of clean.split(/\r?\n/)) {
    const m = line.match(/([A-Za-z_][A-Za-z0-9_]*)\(\)\s+\[(OK|X)\]/);
    if (!m) continue;
    const name = m[1]!;
    const status = m[2]!;
    const key = `${name}:${status}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (status === "OK") passed.push(name);
    if (status === "X") failed.push(name);
  }

  return { passed, failed };
}

export function parseExpectedActual(message: string): { expected: string; actual: string } | null {
  const m = message.match(/expected:\s*<([\s\S]*?)>\s*but\s+was:\s*<([\s\S]*?)>/i);
  if (!m) return null;
  return { expected: m[1] ?? "", actual: m[2] ?? "" };
}

export function parseJUnitFailures(stdout: string): Record<string, { message: string; location?: string }> {
  const clean = stripAnsi(stdout);
  const failures: Record<string, { message: string; location?: string }> = {};

  const re =
    /JUnit Jupiter:[^:\n]+:([A-Za-z_][A-Za-z0-9_]*)\(\)\s*\n[\s\S]*?=>\s*([^\n]+)(?:[\s\S]*?\(([A-Za-z0-9_]+\.java:\d+)\))?/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(clean)) !== null) {
    const testName = match[1]!;
    const message = match[2]!.trim();
    const location = match[3]?.trim();
    failures[testName] = { message, location };
  }

  return failures;
}

export function normalizeDiagnostics(text: string): string {
  const clean = stripAnsi(text);
  const lines = clean.split(/\r?\n/);

  const filtered: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("WARNING: Delegated to the 'execute' command.")) {
      i += 2;
      continue;
    }
    filtered.push(line);
  }

  return filtered.join("\n").trim();
}

export type SqlSuite = {
  schema_sql: string;
  cases: Array<{
    name: string;
    seed_sql: string;
    expected: { columns: string[]; rows: Array<Array<string | number | null>> };
    order_matters?: boolean;
  }>;
};

export function tryParseSqlSuite(testSuite: string): SqlSuite | null {
  if (!testSuite.trim()) return null;
  try {
    const parsed = JSON.parse(testSuite);
    if (!parsed || typeof parsed !== "object") return null;
    const schema_sql = typeof (parsed as any).schema_sql === "string" ? (parsed as any).schema_sql : "";
    const cases = Array.isArray((parsed as any).cases) ? (parsed as any).cases : null;
    if (!schema_sql || !cases) return null;
    const normalized: SqlSuite["cases"] = [];
    for (const c of cases) {
      if (!c || typeof c !== "object") continue;
      const name = typeof (c as any).name === "string" ? (c as any).name : "";
      const seed_sql = typeof (c as any).seed_sql === "string" ? (c as any).seed_sql : "";
      const expected = (c as any).expected;
      if (!name || !seed_sql || !expected || typeof expected !== "object") continue;
      const columns = Array.isArray(expected.columns) ? expected.columns : [];
      const rows = Array.isArray(expected.rows) ? expected.rows : [];
      if (columns.length === 0) continue;
      normalized.push({
        name,
        seed_sql,
        expected: { columns, rows },
        ...(typeof (c as any).order_matters === "boolean" ? { order_matters: (c as any).order_matters } : {}),
      });
    }
    return { schema_sql, cases: normalized };
  } catch {
    return null;
  }
}

export function formatSqlExpected(columns: string[], rows: Array<Array<string | number | null>>): string {
  const header = columns.join("\t");
  const body = rows.map((r) => r.map((v) => (v == null ? "NULL" : String(v))).join("\t")).join("\n");
  return [header, body].filter(Boolean).join("\n");
}

export function parseSqlMismatchBlocks(stderr: string): Array<{
  actual?: string;
  message: string;
}> {
  const text = normalizeDiagnostics(stderr);
  if (!text) return [];

  const blocks = text
    .split(/Expected columns\/rows did not match\.\s*/g)
    .map((b) => b.trim())
    .filter(Boolean);

  const parsePyList = (s: string | undefined): any => {
    if (!s) return undefined;
    const jsonish = s
      .replace(/\bNone\b/g, "null")
      .replace(/\bTrue\b/g, "true")
      .replace(/\bFalse\b/g, "false")
      .replace(/'/g, '"');
    try {
      return JSON.parse(jsonish);
    } catch {
      return undefined;
    }
  };

  const out: Array<{ actual?: string; message: string }> = [];
  for (const b of blocks) {
    const actualColumnsRaw = b.match(/Actual columns:\s*([^\n]+)/)?.[1];
    const actualRowsRaw = b.match(/Actual rows:\s*([^\n]+)/)?.[1];
    const actualColumns = parsePyList(actualColumnsRaw);
    const actualRows = parsePyList(actualRowsRaw);
    const actual =
      Array.isArray(actualColumns) && Array.isArray(actualRows)
        ? formatSqlExpected(actualColumns, actualRows)
        : undefined;
    out.push({ actual, message: b });
  }
  return out;
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
