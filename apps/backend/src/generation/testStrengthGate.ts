import type { GeneratedProblemDraft } from "../contracts/problem";
import type { ProblemSlot } from "../planner/types";
import type { JudgeAdapter, JudgeRequest } from "../languages/types";
import { getLanguageProfile } from "../languages/profiles";

export class TestStrengthGateError extends Error {
  baselineId: string;

  constructor(message: string, opts: { baselineId: string }) {
    super(message);
    this.name = "TestStrengthGateError";
    this.baselineId = opts.baselineId;
  }
}

type Baseline = { id: string; request: JudgeRequest };

function normalizeProblemStyle(raw: string): "stdout" | "return" | "mixed" {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "stdout" || s === "return" || s === "mixed") return s;
  if (s.includes("stdout")) return "stdout";
  if (s.includes("mixed")) return "mixed";
  return "return";
}

function extractCppSolveSignature(referenceSolution: string): string | null {
  const src = String(referenceSolution ?? "");
  if (!src.trim()) return null;
  const reSameLine =
    /(^|\n)\s*([A-Za-z_][\w:<>\s*&]+?)\s+solve\s*\(([\s\S]*?)\)\s*(?:const\s*)?\{/m;
  const m = reSameLine.exec(src);
  if (!m) return null;
  const returnType = m[2]?.replace(/\s+/g, " ").trim();
  const params = m[3]?.replace(/\s+/g, " ").trim();
  if (!returnType || params == null) return null;
  return `${returnType} solve(${params})`;
}

function buildCppBaselineFromSignature(args: {
  signature: string;
  style: "stdout" | "return" | "mixed";
}): string {
  const returnType = args.signature.split(" solve(")[0]?.trim() ?? "";
  const isVoid = /\bvoid\b/.test(returnType);
  const wantsStdout = args.style === "stdout" || args.style === "mixed";

  const maybeStdout = wantsStdout ? `  std::cout << 0 << "\\n";\n` : "";
  const body = isVoid
    ? `${maybeStdout}  return;\n`
    : `${maybeStdout}  return {};\n`;

  return `#include <bits/stdc++.h>
using namespace std;

${args.signature} {
${body}}
`;
}

function buildPythonBaseline(style: "stdout" | "return" | "mixed"): string {
  if (style === "stdout") {
    return `def solve(*args, **kwargs):
    print(0)
`;
  }
  if (style === "mixed") {
    return `def solve(*args, **kwargs):
    print(0)
    return 0
`;
  }
  return `def solve(*args, **kwargs):
    return 0
`;
}

function buildSqlBaselineQuery(): string {
  return "SELECT 1;";
}

function buildBaselines(draft: GeneratedProblemDraft, slot: ProblemSlot): Baseline[] {
  const out: Baseline[] = [];
  const style = normalizeProblemStyle(slot.problem_style);

  if (draft.language === "java") {
    if ("workspace" in draft) {
      out.push({
        id: "starter_workspace",
        request: {
          kind: "files",
          files: Object.fromEntries(draft.workspace.files.map((f) => [f.path, f.content])),
          testSuite: draft.test_suite,
        },
      });
    } else {
      out.push({
        id: "starter_code",
        request: { kind: "code", code: draft.starter_code, testSuite: draft.test_suite },
      });
    }
    return out;
  }

  if (draft.language === "python") {
    out.push({
      id: "starter_code",
      request: { kind: "code", code: draft.starter_code, testSuite: draft.test_suite },
    });
    out.push({
      id: "trivial_baseline",
      request: { kind: "code", code: buildPythonBaseline(style), testSuite: draft.test_suite },
    });
    return out;
  }

  if (draft.language === "cpp") {
    out.push({
      id: "starter_code",
      request: { kind: "code", code: draft.starter_code, testSuite: draft.test_suite },
    });
    const sig = extractCppSolveSignature(draft.reference_solution);
    if (sig) {
      out.push({
        id: "trivial_baseline",
        request: { kind: "code", code: buildCppBaselineFromSignature({ signature: sig, style }), testSuite: draft.test_suite },
      });
    }
    return out;
  }

  // sql
  out.push({
    id: "starter_code",
    request: { kind: "code", code: draft.starter_code, testSuite: draft.test_suite },
  });
  out.push({
    id: "trivial_baseline",
    request: { kind: "code", code: buildSqlBaselineQuery(), testSuite: draft.test_suite },
  });
  return out;
}

async function judgeWithAdapter(adapter: JudgeAdapter, req: JudgeRequest) {
  return adapter.judge(req);
}

export async function runTestStrengthGate(draft: GeneratedProblemDraft, slot: ProblemSlot, opts?: { judgeAdapter?: JudgeAdapter }): Promise<void> {
  const profile = getLanguageProfile(draft.language);
  const adapter = opts?.judgeAdapter ?? profile.judgeAdapter;
  if (!adapter) throw new Error(`No judge adapter configured for "${draft.language}".`);

  const baselines = buildBaselines(draft, slot);
  const concurrency = 2;
  for (let index = 0; index < baselines.length; index += concurrency) {
    const batch = baselines.slice(index, index + concurrency);
    const results = await Promise.all(
      batch.map(async (baseline) => ({
        baseline,
        result: await judgeWithAdapter(adapter, baseline.request),
      }))
    );
    for (const item of results) {
      if (item.result.success) {
        throw new TestStrengthGateError(
          `Test strength gate failed: baseline "${item.baseline.id}" passed the test suite.`,
          { baselineId: item.baseline.id }
        );
      }
    }
  }
}

export const __test__ = {
  normalizeProblemStyle,
  extractCppSolveSignature,
  buildCppBaselineFromSignature,
  buildPythonBaseline,
  buildSqlBaselineQuery,
  buildBaselines,
};
