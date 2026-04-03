import { z } from "zod";
import { JavaSourceNoPackageSchema, isValidJUnit5TestSuite, isValidJUnit5TestSuiteCountRange } from "../languages/java/rules";
import { PythonSourceSchema, isValidPytestTestSuite } from "../languages/python/rules";
import { CppSourceSchema, isValidCppTestSuite } from "../languages/cpp/rules";
import { SqlQuerySchema, diagnoseSqlTestSuite, isValidSqlTestSuite } from "../languages/sql/rules";

function stripJavaComments(source: string): string {
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutBlockComments.replace(/\/\/.*$/gm, "");
}

function hasJavaMainMethod(source: string): boolean {
  const s = stripJavaComments(source);
  return /public\s+static\s+void\s+main\s*\(\s*(?:final\s+)?String\s*(?:(?:\[\s*\]|\.\.\.)\s*\w+|\w+\s*\[\s*\])\s*\)/.test(
    s
  );
}

function testSuiteReferencesClass(testSuite: string, className: string): boolean {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Conservative: only flag real type references, not incidental prose.
  const patterns = [
    new RegExp(`\\bnew\\s+${escaped}\\b`),
    new RegExp(`\\b${escaped}\\s*\\.`),
    new RegExp(`\\b${escaped}\\s*\\(`),
    new RegExp(`\\bextends\\s+${escaped}\\b`),
    new RegExp(`\\bimplements\\s+${escaped}\\b`),
  ];
  return patterns.some((re) => re.test(testSuite));
}

/**
 * Optional pedagogy metadata.
 *
 * Phase 1: accepted by schema, not enforced by generation/execution.
 * This is an extension point for Guided Mode UX later.
 */
const PedagogySchema = z
  .object({
    scaffold_level: z.number().int().min(0).max(100).optional(),
    learning_goal: z.string().trim().min(1).max(240).optional(),
    hints_enabled: z.boolean().optional(),
  })
  .strict();

/**
 * Codemm v1.0 Generation output contract for problems.
 *
 * NOTE: reference_solution is required at generation time, validated in Docker,
 * then discarded and MUST NOT be persisted.
 */
const CommonProblemFieldsSchemaBase = z
  .object({
    language: z.enum(["java", "python", "cpp", "sql"]),
    id: z.string().trim().min(1).max(80),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(8000),

    constraints: z.string().trim().min(1).max(2000),

    // Examples are required: every problem must include at least 1 sample.
    // Keep these small: they are for learner context, not for validation.
    sample_inputs: z.array(z.string().trim().min(1).max(4000)).min(1).max(10),
    sample_outputs: z.array(z.string().trim().min(1).max(4000)).min(1).max(10),

    // Planned metadata (derived from ProblemPlan, not user chat).
    difficulty: z.enum(["easy", "medium", "hard"]),
    topic_tag: z.string().trim().min(1).max(40),

    // Optional pedagogy metadata (no safety impact).
    pedagogy: PedagogySchema.optional(),
  })
  .strict();

function refineSamplePairs(
  draft: { sample_inputs: string[]; sample_outputs: string[] },
  ctx: z.RefinementCtx,
) {
  if (draft.sample_inputs.length !== draft.sample_outputs.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "sample_inputs and sample_outputs must have the same length.",
      path: ["sample_outputs"],
    });
  }
}

const JavaTestSuiteSchema = z
  .string()
  .min(1)
  .superRefine((ts, ctx) => {
    if (!isValidJUnit5TestSuiteCountRange(ts, 1, 8)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Invalid test_suite: must have 1 to 8 @Test methods, JUnit 5 imports, no package, and non-trivial assertions.",
      });
    }
  });

const PythonTestSuiteSchema = z
  .string()
  .min(1)
  .superRefine((ts, ctx) => {
    if (!isValidPytestTestSuite(ts, 8)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Invalid test_suite: must use pytest, import solve from solution, define exactly 8 tests named test_case_1..test_case_8, avoid IO/randomness, and use a supported assertion style (return/stdout/mixed).",
      });
    }
  });

const CppTestSuiteSchema = z
  .string()
  .min(1)
  .superRefine((ts, ctx) => {
    if (!isValidCppTestSuite(ts, 8)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'Invalid test_suite: must #include "solution.cpp", define a main(), print [PASS]/[FAIL] lines, and include exactly 8 tests named test_case_1..test_case_8 (RUN_TEST must be variadic).',
      });
    }
  });

const SqlTestSuiteSchema = z
  .string()
  .min(1)
  .superRefine((ts, ctx) => {
    if (!isValidSqlTestSuite(ts, 8)) {
      const issues = diagnoseSqlTestSuite(ts, 8);
      const detail = issues.length ? ` Details: ${issues.slice(0, 2).join(" ")}` : "";
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `Invalid test_suite: must be JSON with schema_sql + exactly 8 cases named test_case_1..test_case_8 including expected columns/rows.${detail}`,
      });
    }
  });

const JavaFilenameSchema = z
  .string()
  .trim()
  // Phase A: keep it compatible with current /run and /submit (root-level files only).
  .regex(/^[A-Za-z_][A-Za-z0-9_]*\.java$/, "Invalid Java file path.");

export const WorkspaceFileSchema = z
  .object({
    path: JavaFilenameSchema,
    role: z.enum(["entry", "support", "readonly"]),
    // For now, workspace problems are Java-only, so we enforce Java source constraints.
    content: JavaSourceNoPackageSchema,
  })
  .strict();

const WorkspaceScaffoldedRegionSchema = z
  .object({
    // File path containing the markers.
    path: JavaFilenameSchema,
    // Optional symbol hint (e.g., method name) for tooling/UI.
    symbol: z.string().trim().min(1).max(120).optional(),
    // Marker lines (language-aware); used for machine detection.
    begin_marker: z.string().trim().min(1).max(80),
    end_marker: z.string().trim().min(1).max(80),
  })
  .strict();

export const WorkspaceSchema = z
  .object({
    files: z.array(WorkspaceFileSchema).min(1).max(20),
    // For Java: the class name to run via `java <entrypoint>`. Optional for test-only workspaces.
    entrypoint: z.string().trim().min(1).max(120).optional(),
    // Optional scaffolding metadata for Guided Mode (additive; no safety impact).
    scaffolded_regions: z.array(WorkspaceScaffoldedRegionSchema).max(200).optional(),
  })
  .strict()
  .superRefine((ws, ctx) => {
    const paths = new Set<string>();
    for (const f of ws.files) {
      if (paths.has(f.path)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate workspace file path "${f.path}".`,
          path: ["files"],
        });
      }
      paths.add(f.path);
    }

    const entryFiles = ws.files.filter((f) => f.role === "entry");
    if (entryFiles.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `workspace.files must include exactly 1 entry file (found ${entryFiles.length}).`,
        path: ["files"],
      });
      return;
    }

    const entryFile = entryFiles[0]!;
    if (!hasJavaMainMethod(entryFile.content)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Entry file "${entryFile.path}" must include public static void main(String[] args).`,
        path: ["files"],
      });
    }

    const entryClassFromFilename = entryFile.path.replace(/\.java$/i, "");
    const entrypoint = ws.entrypoint?.trim();
    if (!entrypoint) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `workspace.entrypoint is required when using workspace problems (expected "${entryClassFromFilename}").`,
        path: ["entrypoint"],
      });
      return;
    }

    // Ensure the entrypoint maps cleanly to a class defined in the entry file.
    const escaped = entrypoint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const content = stripJavaComments(entryFile.content);
    if (!new RegExp(`\\bclass\\s+${escaped}\\b`).test(content)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Entry file "${entryFile.path}" must declare class "${entrypoint}".`,
        path: ["files"],
      });
    }

    if (Array.isArray(ws.scaffolded_regions) && ws.scaffolded_regions.length) {
      const pathSet = new Set(ws.files.map((f) => f.path));
      for (const r of ws.scaffolded_regions) {
        if (!pathSet.has(r.path)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `workspace.scaffolded_regions path "${r.path}" must exist in workspace.files.`,
            path: ["scaffolded_regions"],
          });
          break;
        }
      }
    }
  });

const LegacyDraftSchemaBase = CommonProblemFieldsSchemaBase.extend({
  language: z.literal("java"),
  test_suite: JavaTestSuiteSchema,
  // Starter code the learner edits.
  starter_code: JavaSourceNoPackageSchema,
  // Hidden solution used ONLY for validation.
  reference_solution: JavaSourceNoPackageSchema,
}).strict();

function refineWorkspaceProblem(
  draft: { test_suite: string; workspace: { entrypoint?: string | undefined } },
  ctx: z.RefinementCtx
) {
  const entrypoint = draft.workspace.entrypoint?.trim();
  if (!entrypoint) return;
  if (testSuiteReferencesClass(draft.test_suite, entrypoint)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `test_suite must not reference the entry class "${entrypoint}". Tests must target a non-entry class.`,
      path: ["test_suite"],
    });
  }
}

const WorkspaceDraftSchemaBase = CommonProblemFieldsSchemaBase.extend({
  language: z.literal("java"),
  test_suite: JavaTestSuiteSchema,
  workspace: WorkspaceSchema,
  // Hidden solution workspace used ONLY for validation.
  reference_workspace: WorkspaceSchema,
}).strict();

const LegacyDraftSchema = LegacyDraftSchemaBase.superRefine(refineSamplePairs);

const WorkspaceDraftSchema = WorkspaceDraftSchemaBase.superRefine(refineSamplePairs).superRefine(refineWorkspaceProblem);

const PythonDraftSchemaBase = CommonProblemFieldsSchemaBase.extend({
  language: z.literal("python"),
  test_suite: PythonTestSuiteSchema,
  starter_code: PythonSourceSchema,
  reference_solution: PythonSourceSchema,
}).strict();

const PythonDraftSchema = PythonDraftSchemaBase.superRefine(refineSamplePairs);

const CppDraftSchemaBase = CommonProblemFieldsSchemaBase.extend({
  language: z.literal("cpp"),
  test_suite: CppTestSuiteSchema,
  starter_code: CppSourceSchema,
  reference_solution: CppSourceSchema,
}).strict();

const CppDraftSchema = CppDraftSchemaBase.superRefine(refineSamplePairs);

const SqlDraftSchemaBase = CommonProblemFieldsSchemaBase.extend({
  language: z.literal("sql"),
  test_suite: SqlTestSuiteSchema,
  starter_code: SqlQuerySchema,
  reference_solution: SqlQuerySchema,
}).strict();

const SqlDraftSchema = SqlDraftSchemaBase.superRefine(refineSamplePairs);

export const GeneratedProblemDraftSchema = z.union([
  LegacyDraftSchema,
  WorkspaceDraftSchema,
  PythonDraftSchema,
  CppDraftSchema,
  SqlDraftSchema,
]);

export type GeneratedProblemDraft = z.infer<typeof GeneratedProblemDraftSchema>;

/**
 * Persisted problem shape (reference_solution intentionally omitted).
 */
export const GeneratedProblemSchema = z.union([
  LegacyDraftSchemaBase.omit({ reference_solution: true }).superRefine(refineSamplePairs),
  WorkspaceDraftSchemaBase
    .omit({ reference_workspace: true })
    .superRefine(refineSamplePairs)
    .superRefine(refineWorkspaceProblem),
  PythonDraftSchemaBase.omit({ reference_solution: true }).superRefine(refineSamplePairs),
  CppDraftSchemaBase.omit({ reference_solution: true }).superRefine(refineSamplePairs),
  SqlDraftSchemaBase.omit({ reference_solution: true }).superRefine(refineSamplePairs),
]);

export type GeneratedProblem = z.infer<typeof GeneratedProblemSchema>;
