import crypto from "crypto";
import { z } from "zod";
import type { JudgeRunResultDto, JudgeSubmitResultDto } from "@codemm/shared-contracts";
import { activityRepository, submissionRepository } from "../database/repositories/activityRepository";
import { runEventRepository, runRepository } from "../database/repositories/runRepository";
import { ActivityLanguageSchema } from "../contracts/activitySpec";
import {
  getLanguageProfile,
  isLanguageSupportedForExecution,
  isLanguageSupportedForJudge,
} from "../languages/profiles";
import { formatJudgeResult, formatRunResult } from "../judge/resultFormatter";
import { recordAttemptMastery } from "../learning/masteryService";
import { logStructured } from "../infra/observability/logger";
import { bestEffort, requireParams, safeJsonStringify } from "./common";
import type { RpcHandlerDef } from "./types";

const DOCKER_UNAVAILABLE_MESSAGE =
  "Docker is required to run and check code, and it isn't available. Start Docker Desktop and relaunch Codemm. You can still browse and read activities without it.";

function assertDockerAvailable(): void {
  if (process.env.CODEMM_DOCKER_AVAILABLE === "0") {
    throw new Error(DOCKER_UNAVAILABLE_MESSAGE);
  }
}

const MAX_TOTAL_CODE_LENGTH = 200_000;
const MAX_STDIN_LENGTH = 50_000;

type ActivityLanguage = (typeof ActivityLanguageSchema)["_type"];

/** Per-language rules for user-supplied file sets. */
const FILE_RULES: Record<ActivityLanguage, { pattern: RegExp; runMaxFiles: number; submitMaxFiles: number }> = {
  java: { pattern: /^[A-Za-z_][A-Za-z0-9_]*\.java$/, runMaxFiles: 12, submitMaxFiles: 16 },
  python: { pattern: /^[A-Za-z_][A-Za-z0-9_]*\.py$/, runMaxFiles: 20, submitMaxFiles: 30 },
  cpp: { pattern: /^[A-Za-z_][A-Za-z0-9_]*\.(?:cpp|h|hpp)$/, runMaxFiles: 40, submitMaxFiles: 50 },
  sql: { pattern: /^[A-Za-z_][A-Za-z0-9_]*\.sql$/, runMaxFiles: 12, submitMaxFiles: 16 },
};

/** Language-specific requirements on the file set, applied after generic validation. */
const RUN_FILESET_CHECKS: Partial<Record<ActivityLanguage, (files: Record<string, string>) => void>> = {
  python: (files) => {
    if (!("main.py" in files)) throw new Error('Python /run requires a "main.py" file.');
  },
  cpp: (files) => {
    if (!("main.cpp" in files)) throw new Error('C++ /run requires a "main.cpp" file.');
  },
  sql: () => {
    throw new Error("SQL does not support /run yet. Use /submit (Run tests).");
  },
};

const SUBMIT_FILESET_CHECKS: Partial<Record<ActivityLanguage, (files: Record<string, string>) => void>> = {
  python: (files) => {
    if ("test_solution.py" in files) throw new Error('files must not include "test_solution.py".');
    if (!("solution.py" in files)) throw new Error('Python /submit requires a "solution.py" file.');
  },
  cpp: (files) => {
    if ("test.cpp" in files) throw new Error('files must not include "test.cpp".');
    if (!("solution.cpp" in files)) throw new Error('C++ /submit requires a "solution.cpp" file.');
    const extraSources = Object.keys(files).filter((f) => f.endsWith(".cpp") && f !== "solution.cpp");
    if (extraSources.length > 0) {
      throw new Error(`C++ /submit supports "solution.cpp" plus optional headers only. Remove: ${extraSources.join(", ")}`);
    }
  },
  sql: (files) => {
    if (!("solution.sql" in files)) throw new Error('SQL /submit requires a "solution.sql" file.');
    const extras = Object.keys(files).filter((f) => f !== "solution.sql");
    if (extras.length > 0) throw new Error(`SQL /submit supports only solution.sql. Remove: ${extras.join(", ")}`);
  },
};

function validateUserFiles(args: {
  lang: ActivityLanguage;
  files: object;
  maxFiles: number;
  reservedLength: number;
}): Record<string, string> {
  const { pattern } = FILE_RULES[args.lang];
  const entries = Object.entries(args.files as Record<string, unknown>);
  if (entries.length === 0) throw new Error("files must be a non-empty object.");
  if (entries.length > args.maxFiles) throw new Error(`Too many files. Max is ${args.maxFiles}.`);

  let totalLen = args.reservedLength;
  const safeFiles: Record<string, string> = {};
  for (const [filename, source] of entries) {
    if (typeof filename !== "string" || !pattern.test(filename)) {
      throw new Error(`Invalid filename "${String(filename)}".`);
    }
    if (typeof source !== "string" || !source.trim()) {
      throw new Error(`File "${filename}" must be a non-empty string.`);
    }
    totalLen += source.length;
    if (totalLen > MAX_TOTAL_CODE_LENGTH) {
      throw new Error(`Total code exceeds maximum length of ${MAX_TOTAL_CODE_LENGTH} characters.`);
    }
    safeFiles[filename] = source;
  }
  return safeFiles;
}

export function createJudgeHandlers(): Record<string, RpcHandlerDef> {
  return {
    "judge.run": {
      schema: z
        .object({
          language: ActivityLanguageSchema,
          code: z.string().min(1).max(200_000).optional(),
          files: z.record(z.string(), z.string()).optional(),
          mainClass: z.string().min(1).max(256).optional(),
          stdin: z.string().max(50_000).optional(),
        })
        .passthrough()
        .refine((v) => Boolean(v.code) !== Boolean(v.files), { message: 'Provide either "code" or "files".' }),
      handler: async (paramsRaw) => {
        assertDockerAvailable();
        const params = requireParams(paramsRaw);
        const { code, language, files, mainClass, stdin } = params;

        const langParsed = ActivityLanguageSchema.safeParse(language);
        if (!langParsed.success) throw new Error("Invalid language.");
        const lang = langParsed.data;
        if (!isLanguageSupportedForExecution(lang)) throw new Error(`Language "${lang}" is not supported for /run yet.`);
        const profile = getLanguageProfile(lang);
        if (!profile.executionAdapter) throw new Error(`No execution adapter configured for "${lang}".`);

        let safeStdin: string | undefined = undefined;
        if (typeof stdin !== "undefined") {
          if (typeof stdin !== "string") throw new Error("stdin must be a string.");
          if (stdin.length > MAX_STDIN_LENGTH) throw new Error(`stdin exceeds maximum length of ${MAX_STDIN_LENGTH} characters.`);
          safeStdin = stdin;
        }

        const runId = crypto.randomUUID();
        runRepository.create(runId, "judge.run", {
          threadId: null,
          metaJson: safeJsonStringify({
            language: lang,
            kind: files && typeof files === "object" ? "files" : "code",
          }),
        });

        if (files && typeof files === "object") {
          const safeFiles = validateUserFiles({
            lang,
            files,
            maxFiles: FILE_RULES[lang].runMaxFiles,
            reservedLength: safeStdin?.length ?? 0,
          });
          RUN_FILESET_CHECKS[lang]?.(safeFiles);

          const execReq: {
            kind: "files";
            files: Record<string, string>;
            mainClass?: string;
            stdin?: string;
          } = { kind: "files", files: safeFiles };
          if (typeof mainClass === "string" && mainClass.trim()) execReq.mainClass = mainClass.trim();
          if (typeof safeStdin === "string") execReq.stdin = safeStdin;

          const result = await profile.executionAdapter.run(execReq);
          const formatted = formatRunResult(result);
          bestEffort("runlog.result_append_failed", { runId }, () => {
            runEventRepository.append(runId, 1, "result", safeJsonStringify({ stdout: result.stdout, stderr: result.stderr }));
            runRepository.finish(runId, "succeeded");
          });
          const response: JudgeRunResultDto = { stdout: result.stdout, stderr: result.stderr, runId, ...formatted };
          return response;
        }

        if (typeof code !== "string" || !code.trim()) {
          throw new Error("Provide either code (string) or files (object).");
        }
        const total = code.length + (safeStdin?.length ?? 0);
        if (total > MAX_TOTAL_CODE_LENGTH) throw new Error(`Code exceeds maximum length of ${MAX_TOTAL_CODE_LENGTH} characters.`);

        const execReq: { kind: "code"; code: string; stdin?: string } = { kind: "code", code };
        if (typeof safeStdin === "string") execReq.stdin = safeStdin;
        const result = await profile.executionAdapter.run(execReq);
        const formatted = formatRunResult(result);
        bestEffort("runlog.result_append_failed", { runId }, () => {
          runEventRepository.append(runId, 1, "result", safeJsonStringify({ stdout: result.stdout, stderr: result.stderr }));
          runRepository.finish(runId, "succeeded");
        });
        const response: JudgeRunResultDto = { stdout: result.stdout, stderr: result.stderr, runId, ...formatted };
        return response;
      },
    },

    "judge.submit": {
      schema: z
        .object({
          language: ActivityLanguageSchema.optional(),
          testSuite: z.string().min(1).max(200_000),
          code: z.string().min(1).max(200_000).optional(),
          files: z.record(z.string(), z.string()).optional(),
          activityId: z.string().min(1).max(128).optional(),
          problemId: z.string().min(1).max(128).optional(),
        })
        .passthrough()
        .refine((v) => Boolean(v.code) !== Boolean(v.files), { message: 'Provide either "code" or "files".' }),
      handler: async (paramsRaw) => {
        assertDockerAvailable();
        const params = requireParams(paramsRaw);
        const { code, testSuite, activityId, problemId, files, language } = params;

        if (typeof testSuite !== "string" || !testSuite.trim()) {
          throw new Error("testSuite is required for graded execution. Use /run for code-only execution.");
        }

        const langParsed = ActivityLanguageSchema.safeParse(language ?? "java");
        if (!langParsed.success) throw new Error("Invalid language.");
        const lang = langParsed.data;
        if (!isLanguageSupportedForJudge(lang)) throw new Error(`Language "${lang}" is not supported for /submit yet.`);
        const profile = getLanguageProfile(lang);
        if (!profile.judgeAdapter) throw new Error(`No judge adapter configured for "${lang}".`);

        const runId = crypto.randomUUID();
        runRepository.create(runId, "judge.submit", {
          threadId: null,
          metaJson: safeJsonStringify({
            language: lang,
            kind: files && typeof files === "object" ? "files" : "code",
            activityId: typeof activityId === "string" ? activityId : null,
            problemId: typeof problemId === "string" ? problemId : null,
          }),
        });

        let result: any;
        let codeForPersistence: string | null = null;

        if (files && typeof files === "object") {
          const safeFiles = validateUserFiles({
            lang,
            files,
            maxFiles: FILE_RULES[lang].submitMaxFiles,
            reservedLength: testSuite.length,
          });
          SUBMIT_FILESET_CHECKS[lang]?.(safeFiles);

          result = await profile.judgeAdapter.judge({ kind: "files", files: safeFiles, testSuite });
          codeForPersistence = JSON.stringify(safeFiles);
        } else {
          if (typeof code !== "string" || !code.trim()) {
            throw new Error("code is required non-empty string.");
          }
          if (code.length + testSuite.length > MAX_TOTAL_CODE_LENGTH) {
            throw new Error(`Total code exceeds maximum length of ${MAX_TOTAL_CODE_LENGTH} characters.`);
          }
          result = await profile.judgeAdapter.judge({ kind: "code", code, testSuite });
          codeForPersistence = code;
        }

        if (typeof activityId === "string" && typeof problemId === "string") {
          const dbActivity = activityRepository.findById(activityId);
          if (dbActivity) {
            const totalTests = result.passedTests.length + result.failedTests.length;
            submissionRepository.create(
              activityId,
              problemId,
              codeForPersistence ?? "",
              result.success,
              result.passedTests.length,
              totalTests,
              result.executionTimeMs
            );
            try {
              recordAttemptMastery({
                activityProblemsJson: dbActivity.problems,
                problemId,
                fallbackLanguage: lang,
                evidence: {
                  passed: Boolean(result.success),
                  passedTests: result.passedTests.length,
                  totalTests,
                  at: new Date().toISOString(),
                },
              });
            } catch (err) {
              logStructured("error", "learning.mastery.update_failed", {
                problemId,
                message: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }

        bestEffort("runlog.result_append_failed", { runId }, () => {
          runEventRepository.append(
            runId,
            1,
            "result",
            safeJsonStringify({
              success: Boolean(result?.success),
              passedTests: Array.isArray(result?.passedTests) ? result.passedTests : [],
              failedTests: Array.isArray(result?.failedTests) ? result.failedTests : [],
              executionTimeMs: typeof result?.executionTimeMs === "number" ? result.executionTimeMs : null,
              timedOut: typeof result?.timedOut === "boolean" ? result.timedOut : null,
              exitCode: typeof result?.exitCode === "number" ? result.exitCode : null,
            })
          );
          runRepository.finish(runId, "succeeded");
        });

        const formatted = formatJudgeResult({ language: lang, testSuite, result });
        const response: JudgeSubmitResultDto = { ...result, ...formatted, testCaseDetails: formatted.testCaseDetails, runId };
        return response;
      },
    },
  };
}
