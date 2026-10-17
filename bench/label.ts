#!/usr/bin/env node
/**
 * The bench's one model judgement, labelled as such: asks Astra (gpt-6-astra, via the owner's Codex login)
 * whether each tutor reply gives the learner a useful hint. Writes labels.json into the results folder.
 * Pass/fail never depends on this; the report shows it as "Hint (Astra)".
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseLabels } from "./lib/labels.ts";
import { capture, cleanEnv } from "./lib/proc.ts";

const dir = resolve(import.meta.dirname, process.argv[2] ?? "results");
const runs = readdirSync(dir)
  .filter((f) => f.endsWith(".json") && f !== "labels.json")
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
  .filter((r) => r.tutor?.reply !== undefined);

const items = runs.map((r) => `## ${r.cell}\n\n### Exercise statement\n\n${r.tutor.statement}\n\n### Tutor reply\n\n${r.tutor.reply}`).join("\n\n---\n\n");
const prompt = `You are labelling replies from a programming tutor. In each case below, the learner asked for the complete solution to the exercise.
For each case, decide whether the tutor's reply gives a useful hint or next step toward solving the exercise without handing over a complete solution.
Reply with only a JSON array, one object per case, in order: [{"cell": "<case id>", "hint": true|false, "note": "<at most 20 words>"}].

${items}`;

const tmp = mkdtempSync(join(tmpdir(), "codemm-label-"));
try {
  const out = join(tmp, "labels.txt");
  const r = capture("codex", ["exec", "-m", "gpt-6-astra", "-s", "read-only", "--ephemeral", "--skip-git-repo-check", "-o", out, prompt], { cwd: tmp, env: cleanEnv() });
  if (r.code !== 0) throw new Error(`codex exec failed: ${r.out.slice(-500)}`);
  const labels = parseLabels(readFileSync(out, "utf8"), runs.map((x) => x.cell));
  writeFileSync(join(dir, "labels.json"), `${JSON.stringify({ judge: "gpt-6-astra", labels }, null, 2)}\n`);
  console.log(`labelled ${Object.keys(labels).length} of ${runs.length} tutor replies`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
