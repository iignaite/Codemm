import type { ActivityLanguage } from "../contracts/activitySpec";
import type { JudgeResult } from "../types";

export type JudgeTestCaseDetail = {
  name: string;
  passed: boolean;
  input?: string;
  expectedOutput?: string;
  actualOutput?: string;
  message?: string;
  location?: string;
};

export type FormattedJudgeResult = {
  formattedStdout: string;
  formattedStderr: string;
  testCaseDetails: JudgeTestCaseDetail[];
};

type SqlSuite = {
  schema_sql: string;
  cases: Array<{
    name: string;
    seed_sql: string;
    expected: { columns: string[]; rows: Array<Array<string | number | null>> };
    order_matters?: boolean;
  }>;
};

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
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

function sortTestCaseNames(names: string[]): string[] {
  const uniq = Array.from(new Set(names)).filter(Boolean);
  const score = (value: string) => {
    const match = value.match(/\btest_case_(\d+)\b/i);
    return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
  };
  return uniq.sort((a, b) => {
    const scoreA = score(a);
    const scoreB = score(b);
    if (scoreA !== scoreB) return scoreA - scoreB;
    return a.localeCompare(b);
  });
}

function parseExpectedActual(message: string): { expected: string; actual: string } | null {
  const match = message.match(/expected:\s*<([\s\S]*?)>\s*but\s+was:\s*<([\s\S]*?)>/i);
  if (!match) return null;
  return { expected: match[1] ?? "", actual: match[2] ?? "" };
}

function parseJUnitFailures(stdout: string): Record<string, { message: string; location?: string }> {
  const clean = stripAnsi(stdout);
  const failures: Record<string, { message: string; location?: string }> = {};
  const regex =
    /JUnit Jupiter:[^:\n]+:([A-Za-z_][A-Za-z0-9_]*)\(\)\s*\n[\s\S]*?=>\s*([^\n]+)(?:[\s\S]*?\(([A-Za-z0-9_]+\.java:\d+)\))?/g;

  let match: RegExpExecArray | null;
  while ((match = regex.exec(clean)) !== null) {
    const testName = match[1]!;
    const message = match[2]!.trim();
    const location = match[3]?.trim();
    failures[testName] = { message, ...(location ? { location } : {}) };
  }
  return failures;
}

function tryParseSqlSuite(testSuite: string): SqlSuite | null {
  if (!testSuite.trim()) return null;
  try {
    const parsed = JSON.parse(testSuite);
    if (!parsed || typeof parsed !== "object") return null;
    const schema_sql = typeof (parsed as any).schema_sql === "string" ? (parsed as any).schema_sql : "";
    const cases = Array.isArray((parsed as any).cases) ? (parsed as any).cases : null;
    if (!schema_sql || !cases) return null;

    const normalized: SqlSuite["cases"] = [];
    for (const candidate of cases) {
      if (!candidate || typeof candidate !== "object") continue;
      const name = typeof (candidate as any).name === "string" ? (candidate as any).name : "";
      const seed_sql = typeof (candidate as any).seed_sql === "string" ? (candidate as any).seed_sql : "";
      const expected = (candidate as any).expected;
      if (!name || !seed_sql || !expected || typeof expected !== "object") continue;

      const columns = Array.isArray(expected.columns) ? expected.columns : [];
      const rows = Array.isArray(expected.rows) ? expected.rows : [];
      if (columns.length === 0) continue;

      normalized.push({
        name,
        seed_sql,
        expected: { columns, rows },
        ...(typeof (candidate as any).order_matters === "boolean" ? { order_matters: (candidate as any).order_matters } : {}),
      });
    }

    return { schema_sql, cases: normalized };
  } catch {
    return null;
  }
}

function formatSqlExpected(columns: string[], rows: Array<Array<string | number | null>>): string {
  const header = columns.join("\t");
  const body = rows.map((row) => row.map((value) => (value == null ? "NULL" : String(value))).join("\t")).join("\n");
  return [header, body].filter(Boolean).join("\n");
}

function parseSqlMismatchBlocks(stderr: string): Array<{ actual?: string; message: string }> {
  const text = normalizeDiagnostics(stderr);
  if (!text) return [];

  const blocks = text
    .split(/Expected columns\/rows did not match\.\s*/g)
    .map((block) => block.trim())
    .filter(Boolean);

  const parsePyList = (value: string | undefined): unknown => {
    if (!value) return undefined;
    const jsonish = value
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

  const output: Array<{ actual?: string; message: string }> = [];
  for (const block of blocks) {
    const actualColumnsRaw = block.match(/Actual columns:\s*([^\n]+)/)?.[1];
    const actualRowsRaw = block.match(/Actual rows:\s*([^\n]+)/)?.[1];
    const actualColumns = parsePyList(actualColumnsRaw);
    const actualRows = parsePyList(actualRowsRaw);
    const actual =
      Array.isArray(actualColumns) && Array.isArray(actualRows)
        ? formatSqlExpected(actualColumns as string[], actualRows as Array<Array<string | number | null>>)
        : undefined;
    output.push({ ...(actual ? { actual } : {}), message: block });
  }
  return output;
}

export function formatRunResult(result: { stdout?: string; stderr?: string }): { formattedStdout: string; formattedStderr: string } {
  return {
    formattedStdout: stripAnsi(String(result.stdout ?? "")),
    formattedStderr: normalizeDiagnostics(String(result.stderr ?? "")),
  };
}

export function formatJudgeResult(args: {
  language: ActivityLanguage;
  testSuite: string;
  result: JudgeResult;
}): FormattedJudgeResult {
  const formattedStdout = stripAnsi(String(args.result.stdout ?? ""));
  const formattedStderr = normalizeDiagnostics(String(args.result.stderr ?? ""));
  const passedTests = sortTestCaseNames(Array.isArray(args.result.passedTests) ? args.result.passedTests : []);
  const failedTests = sortTestCaseNames(Array.isArray(args.result.failedTests) ? args.result.failedTests : []);
  const allTests = sortTestCaseNames([...passedTests, ...failedTests]);

  if (args.language === "sql") {
    const suite = tryParseSqlSuite(args.testSuite);
    const sqlByName = new Map<string, { input: string; expected: string }>();
    if (suite) {
      for (const testCase of suite.cases) {
        sqlByName.set(testCase.name, {
          input: [`-- schema_sql`, suite.schema_sql.trim(), `\n-- seed_sql`, testCase.seed_sql.trim()]
            .filter(Boolean)
            .join("\n"),
          expected: formatSqlExpected(testCase.expected.columns, testCase.expected.rows),
        });
      }
    }

    const mismatchBlocks = parseSqlMismatchBlocks(args.result.stderr ?? "");
    const mismatchByName = new Map<string, { actual?: string; message?: string }>();
    for (let i = 0; i < Math.min(failedTests.length, mismatchBlocks.length); i++) {
      const name = failedTests[i]!;
      const block = mismatchBlocks[i]!;
      mismatchByName.set(name, {
        ...(block.actual ? { actual: block.actual } : {}),
        ...(block.message ? { message: block.message } : {}),
      });
    }

    return {
      formattedStdout,
      formattedStderr,
      testCaseDetails: allTests.map((name) => {
        const suiteInfo = sqlByName.get(name);
        const mismatch = mismatchByName.get(name);
        return {
          name,
          passed: passedTests.includes(name),
          ...(suiteInfo?.input ? { input: suiteInfo.input } : {}),
          ...(suiteInfo?.expected ? { expectedOutput: suiteInfo.expected } : {}),
          ...(mismatch?.actual ? { actualOutput: mismatch.actual } : {}),
          ...(mismatch?.message ? { message: mismatch.message } : {}),
        };
      }),
    };
  }

  const junitFailures = parseJUnitFailures(args.result.stdout ?? "");
  return {
    formattedStdout,
    formattedStderr,
    testCaseDetails: allTests.map((name) => {
      const failure = junitFailures[name];
      const parsed = failure?.message ? parseExpectedActual(failure.message) : null;
      return {
        name,
        passed: passedTests.includes(name),
        ...(parsed?.expected ? { expectedOutput: parsed.expected } : {}),
        ...(parsed?.actual ? { actualOutput: parsed.actual } : {}),
        ...(failure?.message ? { message: failure.message } : {}),
        ...(failure?.location ? { location: failure.location } : {}),
      };
    }),
  };
}
