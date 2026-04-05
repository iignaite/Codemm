function buildStagePayloadFromDraft(draft) {
  const normalized = {
    ...draft,
    language: draft.language,
  };
  return {
    skeleton: {
      language: normalized.language,
      id: normalized.id,
      title: normalized.title,
      description: normalized.description,
      constraints: normalized.constraints,
      sample_inputs: normalized.sample_inputs,
      sample_outputs: normalized.sample_outputs,
      difficulty: normalized.difficulty,
      topic_tag: normalized.topic_tag,
    },
    tests: {
      test_suite: normalized.test_suite,
    },
    reference: {
      reference_solution: normalized.reference_solution,
    },
  };
}

function buildStubResponse(payload) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function installGenerationStub(t, args) {
  const codex = require("../../src/infra/llm/codemmProvider");
  const validator = require("../../src/generation/referenceSolutionValidator");
  const { LANGUAGE_PROFILES } = require("../../src/languages/profiles");

  const originalCreateCodemm = codex.createCodemmCompletion;
  const originalCreateCodex = codex.createCodexCompletion;
  const originalValidate = validator.validateReferenceSolution;
  const originalJudge = LANGUAGE_PROFILES[args.language]?.judgeAdapter?.judge;

  const calls = [];
  let generationCall = 0;

  const stub = async ({ system, user }) => {
    calls.push({ system, user });

    if (String(system).includes("Codemm's dialogue layer")) {
      const match = String(user).match(/Latest user message:\n([\s\S]*)\n\nReturn JSON with this exact shape:/);
      const latestUserMessage = match?.[1]?.trim() ?? "";
      return buildStubResponse(args.buildDialogueResponse(latestUserMessage));
    }

    const stagePayload = buildStagePayloadFromDraft({
      language: args.language,
      ...args.buildDraft(generationCall++),
    });

    if (String(system).includes("skeleton planner")) {
      return buildStubResponse(stagePayload.skeleton);
    }
    if (String(system).includes("test artifact generator")) {
      return buildStubResponse(stagePayload.tests);
    }
    if (String(system).includes("reference artifact") || String(system).includes("reference repair")) {
      return buildStubResponse(stagePayload.reference);
    }

    throw new Error(`Unexpected LLM call in test (system=${String(system).slice(0, 80)})`);
  };

  codex.createCodemmCompletion = stub;
  codex.createCodexCompletion = stub;
  validator.validateReferenceSolution = async () => {};

  if (LANGUAGE_PROFILES[args.language]?.judgeAdapter) {
    LANGUAGE_PROFILES[args.language].judgeAdapter.judge = async () => ({
      success: Boolean(args.judgeResult?.success),
      passedTests: Array.isArray(args.judgeResult?.passedTests) ? args.judgeResult.passedTests : [],
      failedTests: Array.isArray(args.judgeResult?.failedTests) ? args.judgeResult.failedTests : [],
      stdout: "",
      stderr: "",
      executionTimeMs: 1,
      exitCode: args.judgeResult?.success ? 0 : 1,
      timedOut: false,
    });
  }

  t.after(() => {
    codex.createCodemmCompletion = originalCreateCodemm;
    codex.createCodexCompletion = originalCreateCodex;
    validator.validateReferenceSolution = originalValidate;
    if (LANGUAGE_PROFILES[args.language]?.judgeAdapter && typeof originalJudge === "function") {
      LANGUAGE_PROFILES[args.language].judgeAdapter.judge = originalJudge;
    }
  });

  return { calls };
}

module.exports = { installGenerationStub };
