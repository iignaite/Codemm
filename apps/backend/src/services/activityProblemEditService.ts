import type { GeneratedProblem, GeneratedProblemDraft } from "../contracts/problem";
import { GeneratedProblemDraftSchema, GeneratedProblemSchema } from "../contracts/problem";
import { getLanguageProfile } from "../languages/profiles";
import { createCodemmCompletion } from "../infra/llm";
import { tryParseJson } from "../utils/jsonParser";
import { discardReferenceArtifacts } from "../generation/services/normalizationService";
import { validateDraftArtifacts } from "../generation/services/validationService";
import { traceText } from "../utils/trace";

const MAX_TOKENS = 5000;
const TEMPERATURE = 0.25;

function isJavaWorkspaceProblem(problem: GeneratedProblem): boolean {
  return problem.language === "java" && "workspace" in problem;
}

function buildEditPrompt(args: { existing: GeneratedProblem; instruction: string }): string {
  const existing = args.existing;
  const locked = JSON.stringify(
    {
      id: existing.id,
      language: existing.language,
      difficulty: existing.difficulty,
      topic_tag: existing.topic_tag,
      constraints: existing.constraints,
    },
    null,
    2
  );

  const baseReq = `You are editing an EXISTING draft problem.

User request:
${args.instruction.trim()}

Locked fields (do not change):
${locked}

Existing problem JSON (student-facing):
${JSON.stringify(existing, null, 2)}
`;

  if (existing.language === "java") {
    if (isJavaWorkspaceProblem(existing)) {
      return `${baseReq}
Return a JSON object (not array) with these exact fields:
{
  "language": "java",
  "id": "${existing.id}",
  "title": "Problem Title",
  "description": "Detailed problem description...",
  "test_suite": "import org.junit.jupiter.api.Test; ...",
  "workspace": {
    "files": [
      { "path": "Main.java", "role": "entry", "content": "public class Main { public static void main(String[] args) { ... } }" },
      { "path": "ClassName.java", "role": "support", "content": "public class ClassName { /* TODO */ }" }
    ],
    "entrypoint": "Main"
  },
  "reference_workspace": {
    "files": [
      { "path": "Main.java", "role": "entry", "content": "public class Main { public static void main(String[] args) { ... } }" },
      { "path": "ClassName.java", "role": "support", "content": "public class ClassName { /* complete implementation */ }" }
    ],
    "entrypoint": "Main"
  },
  "constraints": "${existing.constraints}",
  "sample_inputs": ["input1", "input2"],
  "sample_outputs": ["output1", "output2"],
  "difficulty": "${existing.difficulty}",
  "topic_tag": "${existing.topic_tag}"
}

Critical rules:
- test_suite must have exactly 8 @Test methods
- test_suite MUST test the target class (NOT Main)
- reference_workspace must compile and pass all tests
- All Java code must have NO package declarations
- Test class must import org.junit.jupiter.api.Test and static org.junit.jupiter.api.Assertions.*

Respond ONLY with JSON. NO markdown. NO code fences. NO extra text.`;
    }

    return `${baseReq}
Return a JSON object (not array) with these exact fields:
{
  "language": "java",
  "id": "${existing.id}",
  "title": "Problem Title",
  "description": "Detailed problem description...",
  "starter_code": "public class ClassName { ... }",
  "test_suite": "import org.junit.jupiter.api.Test; ...",
  "reference_solution": "public class ClassName { /* complete implementation */ }",
  "constraints": "${existing.constraints}",
  "sample_inputs": ["input1", "input2"],
  "sample_outputs": ["output1", "output2"],
  "difficulty": "${existing.difficulty}",
  "topic_tag": "${existing.topic_tag}"
}

Critical rules:
- test_suite must have exactly 8 @Test methods
- reference_solution must compile and pass all tests
- starter_code should include TODOs (incomplete), with method signatures matching reference_solution
- All Java code must have NO package declarations
- Test class must import org.junit.jupiter.api.Test and static org.junit.jupiter.api.Assertions.*

Respond ONLY with JSON. NO markdown. NO code fences. NO extra text.`;
  }

  if (existing.language === "python") {
    return `${baseReq}
Return a JSON object (not array) with these exact fields:
{
  "language": "python",
  "id": "${existing.id}",
  "title": "Problem Title",
  "description": "Detailed problem description...",
  "starter_code": "def solve(...):\\n    # TODO\\n    raise NotImplementedError\\n",
  "test_suite": "import pytest\\nfrom solution import solve\\n\\n...\\n",
  "reference_solution": "def solve(...):\\n    ...\\n",
  "constraints": "${existing.constraints}",
  "sample_inputs": ["input1", "input2"],
  "sample_outputs": ["output1", "output2"],
  "difficulty": "${existing.difficulty}",
  "topic_tag": "${existing.topic_tag}"
}

Critical rules:
- starter_code and reference_solution must define solve(...)
- solve(...) must be pure (no input(), no print())
- test_suite must import solve via: from solution import solve
- test_suite must define exactly 8 tests named test_case_1..test_case_8
- Each test must assert solve(...) == expected

Respond ONLY with JSON. NO markdown. NO code fences. NO extra text.`;
  }

  if (existing.language === "cpp") {
    return `${baseReq}
Return a JSON object (not array) with these exact fields:
{
  "language": "cpp",
  "id": "${existing.id}",
  "title": "Problem Title",
  "description": "Detailed problem description...",
  "starter_code": "#include <bits/stdc++.h>\\n\\n...\\n",
  "test_suite": "#include <bits/stdc++.h>\\n#include \\\"solution.cpp\\\"\\n...\\n",
  "reference_solution": "#include <bits/stdc++.h>\\n\\n...\\n",
  "constraints": "${existing.constraints}",
  "sample_inputs": ["input1", "input2"],
  "sample_outputs": ["output1", "output2"],
  "difficulty": "${existing.difficulty}",
  "topic_tag": "${existing.topic_tag}"
}

Critical rules:
- test_suite MUST include exactly 8 tests named test_case_1..test_case_8 (RUN_TEST calls)
- test_suite MUST be deterministic and compile against solution.cpp

Respond ONLY with JSON. NO markdown. NO code fences. NO extra text.`;
  }

  return `${baseReq}
Return a JSON object (not array) with these exact fields:
{
  "language": "sql",
  "id": "${existing.id}",
  "title": "Problem Title",
  "description": "Detailed problem description...",
  "starter_code": "SELECT ...;",
  "test_suite": "{\\"schema_sql\\": \\"...\\", \\"cases\\": [{\\"name\\":\\"test_case_1\\",...}, ...]}",
  "reference_solution": "SELECT ...;",
  "constraints": "${existing.constraints}",
  "sample_inputs": ["input1", "input2"],
  "sample_outputs": ["output1", "output2"],
  "difficulty": "${existing.difficulty}",
  "topic_tag": "${existing.topic_tag}"
}

Critical rules:
- test_suite must be JSON with schema_sql and exactly 8 cases named test_case_1..test_case_8

Respond ONLY with JSON. NO markdown. NO code fences. NO extra text.`;
}

function coerceLockedFields(raw: unknown, existing: GeneratedProblem): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  return {
    ...(raw as Record<string, unknown>),
    id: existing.id,
    language: existing.language,
    difficulty: existing.difficulty,
    topic_tag: existing.topic_tag,
    constraints: existing.constraints,
  };
}

function requireShapeMatchesExisting(args: { existing: GeneratedProblem; draft: GeneratedProblemDraft }) {
  if (args.existing.language !== "java") return;
  const existingIsWorkspace = isJavaWorkspaceProblem(args.existing);
  const draftIsWorkspace = "reference_workspace" in args.draft;
  if (existingIsWorkspace !== draftIsWorkspace) {
    throw new Error(
      existingIsWorkspace
        ? "Edited draft must use workspace/reference_workspace (to match existing problem)."
        : "Edited draft must use starter_code/reference_solution (to match existing problem)."
    );
  }
}

export async function editDraftProblemWithAi(args: {
  existing: GeneratedProblem;
  instruction: string;
  deps?: {
    createCompletion?: typeof createCodemmCompletion;
    validateReferenceSolution?: typeof validateDraftArtifacts;
  };
}): Promise<GeneratedProblem> {
  const parsedExisting = GeneratedProblemSchema.safeParse(args.existing);
  if (!parsedExisting.success) {
    throw new Error("Existing problem is invalid.");
  }
  const existing = parsedExisting.data;

  const profile = getLanguageProfile(existing.language);
  if (!profile.generator) {
    throw new Error(`No generator configured for language "${existing.language}".`);
  }

  const system = profile.generator.systemPrompt;
  const user = buildEditPrompt({ existing, instruction: args.instruction });
  const createCompletion = args.deps?.createCompletion ?? createCodemmCompletion;
  const validateFn = args.deps?.validateReferenceSolution ?? validateDraftArtifacts;

  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const completion = await createCompletion({
        system,
        user: attempt === 1 ? user : `${user}\n\nPrevious attempt failed. Return ONLY valid JSON matching the schema exactly.`,
        temperature: TEMPERATURE,
        maxTokens: MAX_TOKENS,
      });

      const text = completion.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
      traceText("activity.problemEdit.raw", text, { extra: { problemId: existing.id, language: existing.language } });

      const maybe = tryParseJson(text);
      const locked = coerceLockedFields(maybe, existing);
      const draftRes = GeneratedProblemDraftSchema.safeParse(locked);
      if (!draftRes.success) {
        throw new Error(draftRes.error.issues[0]?.message ?? "Edited draft does not match contract.");
      }
      requireShapeMatchesExisting({ existing, draft: draftRes.data });

      await validateFn(draftRes.data);
      return discardReferenceArtifacts(draftRes.data);
    } catch (err) {
      lastErr = err;
    }
  }

  if (lastErr instanceof Error) throw lastErr;
  throw new Error("Failed to edit problem.");
}
