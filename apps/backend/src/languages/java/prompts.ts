import type { ProblemSlot } from "../../planner/types";
import type { SlotPromptContext } from "../types";

function shouldGenerateWorkspace(slot: ProblemSlot): boolean {
  const enabled = process.env.CODEMM_WORKSPACE_GEN === "1";
  if (!enabled) return false;
  // Start small: only easy problems until the pipeline is boring/stable.
  return slot.difficulty === "easy";
}

export const JAVA_V1_GENERATOR_SYSTEM_PROMPT = `
You are Codemm's Java problem generator. Generate exactly 1 Java problem that matches the provided requirements.

Hard requirements:
- Java 17, no package declarations anywhere.
- Return JSON for a SINGLE problem (not an array).
- You MUST follow the exact output shape requested in the user prompt:
  - EITHER the single-file shape (starter_code + reference_solution)
  - OR the workspace shape (workspace + reference_workspace).

Product checking mode (stdout-only):
- Codemm checks ONLY what is printed to stdout.
- reference_solution MUST print the final answer to stdout (System.out.print/println/printf).
- test_suite MUST capture stdout and assert on the printed output (do not rely on return values).
- Prefer deterministic unit-testable methods; avoid stdin/menu loops for OOP structural topics.
- If you DO read from stdin (Scanner/System.in), you MUST:
  - include "public static void main(String[] args)" as the entrypoint,
  - provide at least 8 "sample_inputs" entries (each a full stdin transcript),
  - ensure the program terminates without requiring extra input beyond each sample.

Test suite requirements:
- Exactly 8 @Test methods
- Import org.junit.jupiter.api.Test and static org.junit.jupiter.api.Assertions.*
- No package declarations
- Test class name must match the tested class name + "Test"
- Tests must assert real behavior (no assertTrue(true) placeholders)
- Use assertEquals/assertTrue/assertFalse/assertThrows with meaningful expectations
- Avoid brittle whitespace expectations (do not assertEquals against string literals with leading/trailing spaces).

Reference solution requirements (single-file):
- reference_solution must compile and pass all tests
- starter_code and reference_solution must each declare at most ONE top-level public type (helper types should be non-public).
- JSON formatting: represent newlines as "\n" (single backslash). Do NOT use "\\n" (double backslash).



Reference workspace requirements (workspace):
- reference_workspace must compile and pass all tests
- reference_workspace must contain the same file paths as workspace
- each file must declare at most ONE top-level public type, and if present it must match the filename.

Return ONLY valid JSON. No markdown, no code fences, no prose.
`;

function normalizeTopic(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9\s_-]/g, "");
}

function getTopicStructuralRequirements(topics: string[]): string[] {
  const req: string[] = [];

  const add = (...items: string[]) => req.push(...items);
  const has = (needle: string) => topics.some((t) => normalizeTopic(t).includes(needle));

  if (has("encapsulation")) {
    add(
      "Encapsulation: use private fields + public methods; do not expose mutable internals directly.",
      "Encapsulation: include at least one validation rule (reject invalid state).",
      "Encapsulation: tests should verify state is protected via method behavior (not direct field access)."
    );
  }

  if (has("polymorphism")) {
    add(
      "Polymorphism: include a base type (interface or abstract class) + at least 2 concrete implementations.",
      "Polymorphism: tests must exercise dynamic dispatch through the base type reference.",
      "Polymorphism: implementations must behave meaningfully differently (not just constants)."
    );
  }

  if (has("inheritance")) {
    add(
      "Inheritance: include a base class + subclass that overrides at least one method.",
      "Inheritance: tests must cover overridden behavior and at least one use of super/base behavior."
    );
  }

  if (has("abstraction") || has("abstract")) {
    add(
      "Abstraction: include an abstract class or interface with an abstract method contract.",
      "Abstraction: tests should target behavior via the abstract contract, not concrete-only APIs."
    );
  }

  if (has("composition")) {
    add(
      "Composition: include a class that owns another object and delegates part of its behavior to it.",
      "Composition: tests should validate the collaboration between the composed objects."
    );
  }

  if (has("interface") || has("interfaces")) {
    add(
      "Interfaces: include at least one interface and design code to depend on the interface, not the implementation."
    );
  }

  return Array.from(new Set(req));
}

function buildDiversityHint(ctx?: SlotPromptContext): string {
  const lines: string[] = [];
  if (ctx?.domain) lines.push(`Scenario domain seed: ${ctx.domain}`);

  const avoidOverused = ["BankAccount", "Student", "Shape", "Animal", "Vehicle", "Employee", "Car", "Library"];
  lines.push(`Avoid overused tutorial domains/classes: ${avoidOverused.join(", ")}`);

  if (ctx?.avoidDomains?.length) lines.push(`Avoid repeating domains: ${ctx.avoidDomains.join(", ")}`);
  if (ctx?.avoidTitles?.length) lines.push(`Avoid titles too similar to: ${ctx.avoidTitles.join(" | ")}`);

  return lines.length ? `\nDiversity constraints:\n- ${lines.join("\n- ")}\n` : "";
}

export function buildJavaSlotPrompt(slot: ProblemSlot, ctx?: SlotPromptContext): string {
  const topicsText = slot.topics.join(", ");
  const workspaceMode = shouldGenerateWorkspace(slot);
  const topicReqs = getTopicStructuralRequirements(slot.topics);
  const topicReqBlock = topicReqs.length ? `\nTopic structural requirements:\n- ${topicReqs.join("\n- ")}\n` : "";
  const diversityHint = buildDiversityHint(ctx);
  const custom = typeof ctx?.customInstructionsMd === "string" ? ctx.customInstructionsMd.trim() : "";
  const customBlock = custom ? `\nCustom instructions (user focus; best-effort):\n${custom}\n` : "";

  if (workspaceMode) {
    return `Generate exactly 1 Java problem with the following requirements:

Difficulty: ${slot.difficulty}
Topics: ${topicsText}
Problem style: ${slot.problem_style}
Constraints: ${slot.constraints}
${diversityHint}${topicReqBlock}${customBlock}

Return a JSON object (not array) with these exact fields:
{
  "id": "unique-problem-id",
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
  "constraints": "${slot.constraints}",
  "sample_inputs": ["input1", "input2"],
  "sample_outputs": ["output1", "output2"],
  "difficulty": "${slot.difficulty}",
  "topic_tag": "${slot.topics[0] ?? "oop"}"
}

Critical rules:
- test_suite must have exactly 8 @Test methods
- workspace.files must include exactly 2 files: Main.java + one target class file
- test_suite MUST test the target class (NOT Main)
- reference_workspace must be a complete, working solution workspace that passes all tests
- stdout-only: tests MUST capture System.out and assert on the printed output; reference code MUST print the final answer.
- Avoid whitespace-padding edge cases unless you explicitly define normalization; do not assertEquals against string literals with leading/trailing spaces.
- Each .java file must declare at most ONE top-level public type; if present, it must match the filename.
- All Java code must have NO package declarations
- Test class must import org.junit.jupiter.api.Test and static org.junit.jupiter.api.Assertions.*

Respond ONLY with JSON. NO markdown. NO code fences. NO extra text.`;
  }

  return `Generate exactly 1 Java problem with the following requirements:

Difficulty: ${slot.difficulty}
Topics: ${topicsText}
Problem style: ${slot.problem_style}
Constraints: ${slot.constraints}
${diversityHint}${topicReqBlock}${customBlock}

	Return a JSON object (not array) with these exact fields:
	{
	  "id": "unique-problem-id",
	  "title": "Problem Title",
	  "description": "Detailed problem description...",
	  "starter_code": "public class ClassName { ... }",
	  "test_suite": "import org.junit.jupiter.api.Test; ...",
	  "reference_solution": "public class ClassName { /* complete implementation */ }",
	  "constraints": "${slot.constraints}",
	  "sample_inputs": ["input1", "input2"],
	  "sample_outputs": ["output1", "output2"],
	  "difficulty": "${slot.difficulty}",
	  "topic_tag": "${slot.topics[0] ?? "oop"}"
	}

Critical rules:
- test_suite must have exactly 8 @Test methods
- reference_solution must be a complete, working solution that passes all tests
- starter_code should be the same class with method signatures but TODOs instead of implementation
- stdout-only: tests MUST capture System.out and assert on the printed output; reference_solution MUST print the final answer.
- Prefer avoiding Scanner/System.in for structural OOP topics; use methods + object instances instead.
- Avoid whitespace-padding edge cases unless you explicitly define normalization; do not assertEquals against string literals with leading/trailing spaces.
	- starter_code and reference_solution must declare at most ONE top-level public type.
	- All Java code must have NO package declarations
	- Test class must import org.junit.jupiter.api.Test and static org.junit.jupiter.api.Assertions.*
	- sample_inputs and sample_outputs MUST be non-empty and must have the same length (at least 1).

	Respond ONLY with JSON. NO markdown. NO code fences. NO extra text.`;
	}
