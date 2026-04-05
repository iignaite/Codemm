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
import { requireParams, safeJsonStringify } from "./common";
import type { RpcHandlerDef } from "./types";

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
        const params = requireParams(paramsRaw);
        const { code, language, files, mainClass, stdin } = params;

        const langParsed = ActivityLanguageSchema.safeParse(language);
        if (!langParsed.success) throw new Error("Invalid language.");
        const lang = langParsed.data;
        if (!isLanguageSupportedForExecution(lang)) throw new Error(`Language "${lang}" is not supported for /run yet.`);
        const profile = getLanguageProfile(lang);
        if (!profile.executionAdapter) throw new Error(`No execution adapter configured for "${lang}".`);

        const maxTotalCodeLength = 200_000;
        const maxStdinLength = 50_000;
        const maxFileCount = lang === "python" ? 20 : lang === "cpp" ? 40 : 12;
        const filenamePattern =
          lang === "python"
            ? /^[A-Za-z_][A-Za-z0-9_]*\.py$/
            : lang === "cpp"
              ? /^[A-Za-z_][A-Za-z0-9_]*\.(?:cpp|h|hpp)$/
              : lang === "sql"
                ? /^[A-Za-z_][A-Za-z0-9_]*\.sql$/
                : /^[A-Za-z_][A-Za-z0-9_]*\.java$/;

        let safeStdin: string | undefined = undefined;
        if (typeof stdin !== "undefined") {
          if (typeof stdin !== "string") throw new Error("stdin must be a string.");
          if (stdin.length > maxStdinLength) throw new Error(`stdin exceeds maximum length of ${maxStdinLength} characters.`);
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
          const entries = Object.entries(files as Record<string, unknown>);
          if (entries.length === 0) throw new Error("files must be a non-empty object.");
          if (entries.length > maxFileCount) throw new Error(`Too many files. Max is ${maxFileCount}.`);

          let totalLen = safeStdin?.length ?? 0;
          const safeFiles: Record<string, string> = {};
          for (const [filename, source] of entries) {
            if (typeof filename !== "string" || !filenamePattern.test(filename)) {
              throw new Error(`Invalid filename "${String(filename)}".`);
            }
            if (typeof source !== "string" || !source.trim()) {
              throw new Error(`File "${filename}" must be a non-empty string.`);
            }
            totalLen += source.length;
            if (totalLen > maxTotalCodeLength) {
              throw new Error(`Total code exceeds maximum length of ${maxTotalCodeLength} characters.`);
            }
            safeFiles[filename] = source;
          }

          if (lang === "python") {
            const hasMain = entries.some(([filename]) => filename === "main.py");
            if (!hasMain) throw new Error('Python /run requires a "main.py" file.');
          }
          if (lang === "cpp") {
            const hasMain = entries.some(([filename]) => filename === "main.cpp");
            if (!hasMain) throw new Error('C++ /run requires a "main.cpp" file.');
          }
          if (lang === "sql") {
            throw new Error('SQL does not support /run yet. Use /submit (Run tests).');
          }

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
          try {
            runEventRepository.append(runId, 1, "result", safeJsonStringify({ stdout: result.stdout, stderr: result.stderr }));
            runRepository.finish(runId, "succeeded");
          } catch {
            // ignore
          }
          const response: JudgeRunResultDto = { stdout: result.stdout, stderr: result.stderr, runId, ...formatted };
          return response;
        }

        if (typeof code !== "string" || !code.trim()) {
          throw new Error("Provide either code (string) or files (object).");
        }
        const total = code.length + (safeStdin?.length ?? 0);
        if (total > maxTotalCodeLength) throw new Error(`Code exceeds maximum length of ${maxTotalCodeLength} characters.`);

        const execReq: { kind: "code"; code: string; stdin?: string } = { kind: "code", code };
        if (typeof safeStdin === "string") execReq.stdin = safeStdin;
        const result = await profile.executionAdapter.run(execReq);
        const formatted = formatRunResult(result);
        try {
          runEventRepository.append(runId, 1, "result", safeJsonStringify({ stdout: result.stdout, stderr: result.stderr }));
          runRepository.finish(runId, "succeeded");
        } catch {
          // ignore
        }
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

        const maxTotalCodeLength = 200_000;
        const maxFileCount = lang === "python" ? 30 : lang === "cpp" ? 50 : 16;
        const filenamePattern =
          lang === "python"
            ? /^[A-Za-z_][A-Za-z0-9_]*\.py$/
            : lang === "cpp"
              ? /^[A-Za-z_][A-Za-z0-9_]*\.(?:cpp|h|hpp)$/
              : lang === "sql"
                ? /^[A-Za-z_][A-Za-z0-9_]*\.sql$/
                : /^[A-Za-z_][A-Za-z0-9_]*\.java$/;

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
          const entries = Object.entries(files as Record<string, unknown>);
          if (entries.length === 0) throw new Error("files must be a non-empty object.");
          if (entries.length > maxFileCount) throw new Error(`Too many files. Max is ${maxFileCount}.`);

          let totalLen = testSuite.length;
          const safeFiles: Record<string, string> = {};
          for (const [filename, source] of entries) {
            if (typeof filename !== "string" || !filenamePattern.test(filename)) {
              throw new Error(`Invalid filename "${String(filename)}".`);
            }
            if (typeof source !== "string" || !source.trim()) {
              throw new Error(`File "${filename}" must be a non-empty string.`);
            }
            totalLen += source.length;
            if (totalLen > maxTotalCodeLength) throw new Error(`Total code exceeds maximum length of ${maxTotalCodeLength} characters.`);
            safeFiles[filename] = source;
          }

          if (lang === "python") {
            if (Object.prototype.hasOwnProperty.call(safeFiles, "test_solution.py")) {
              throw new Error('files must not include "test_solution.py".');
            }
            if (!Object.prototype.hasOwnProperty.call(safeFiles, "solution.py")) {
              throw new Error('Python /submit requires a "solution.py" file.');
            }
          }
          if (lang === "cpp") {
            if (Object.prototype.hasOwnProperty.call(safeFiles, "test.cpp")) {
              throw new Error('files must not include "test.cpp".');
            }
            if (!Object.prototype.hasOwnProperty.call(safeFiles, "solution.cpp")) {
              throw new Error('C++ /submit requires a "solution.cpp" file.');
            }
            const cppSources = Object.keys(safeFiles).filter((f) => f.endsWith(".cpp") && f !== "solution.cpp");
            if (cppSources.length > 0) {
              throw new Error(`C++ /submit supports "solution.cpp" plus optional headers only. Remove: ${cppSources.join(", ")}`);
            }
          }
          if (lang === "sql") {
            if (!Object.prototype.hasOwnProperty.call(safeFiles, "solution.sql")) {
              throw new Error('SQL /submit requires a "solution.sql" file.');
            }
            const extras = Object.keys(safeFiles).filter((f) => f !== "solution.sql");
            if (extras.length > 0) {
              throw new Error(`SQL /submit supports only solution.sql. Remove: ${extras.join(", ")}`);
            }
          }

          result = await profile.judgeAdapter.judge({ kind: "files", files: safeFiles, testSuite });
          codeForPersistence = JSON.stringify(safeFiles);
        } else {
          if (typeof code !== "string" || !code.trim()) {
            throw new Error("code is required non-empty string.");
          }
          if (code.length + testSuite.length > maxTotalCodeLength) {
            throw new Error(`Total code exceeds maximum length of ${maxTotalCodeLength} characters.`);
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
          }
        }

        try {
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
        } catch {
          // ignore
        }

        const formatted = formatJudgeResult({ language: lang, testSuite, result });
        const response: JudgeSubmitResultDto = { ...result, ...formatted, testCaseDetails: formatted.testCaseDetails, runId };
        return response;
      },
    },
  };
}
