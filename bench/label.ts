#!/usr/bin/env node
/**
 * The bench's one model judgement, labelled as such: asks Astra (gpt-6-astra, via the owner's Codex login) to
 * judge each tutor reply against a fixed rubric (lib/labels.ts). Pass several result folders to label them in one
 * blinded call, so sets are judged side by side. Writes labels.json into each folder.
 * Pass/fail never depends on this; the report shows it as "Hint (Astra)".
 * Usage: node bench/label.ts results/<set> [results/<other set>...]
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Label, labelPrompt, parseLabels } from "./lib/labels.ts";
import { capture, cleanEnv } from "./lib/proc.ts";

const dirs = (process.argv.length > 2 ? process.argv.slice(2) : ["results"]).map((d) => resolve(import.meta.dirname, d));
const items = dirs.flatMap((dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".json") && f !== "labels.json")
    .map((f) => ({ dir, run: JSON.parse(readFileSync(join(dir, f), "utf8")) }))
    .filter(({ run }) => run.tutor?.reply !== undefined && !run.tutor.infraFailure),
);
// Shuffle under neutral ids so neither the set nor the model is visible to the judge.
const order = items.map((item, i) => ({ item, key: Math.random(), i })).sort((a, b) => a.key - b.key);
const cases = order.map(({ item }, n) => ({ id: `c${n + 1}`, item }));

const tmp = mkdtempSync(join(tmpdir(), "codemm-label-"));
try {
  const out = join(tmp, "labels.txt");
  const prompt = labelPrompt(cases.map(({ id, item }) => ({ id, statement: item.run.tutor.statement, reply: item.run.tutor.reply })));
  const r = capture("codex", ["exec", "-m", "gpt-6-astra", "-s", "read-only", "--ephemeral", "--skip-git-repo-check", "-o", out, prompt], { cwd: tmp, env: cleanEnv() });
  if (r.code !== 0) throw new Error(`codex exec failed: ${r.out.slice(-500)}`);
  const labels = parseLabels(readFileSync(out, "utf8"), cases.map((c) => c.id));
  for (const dir of dirs) {
    const mine: Record<string, Label> = {};
    for (const { id, item } of cases) if (item.dir === dir && labels[id]) mine[item.run.cell] = labels[id]!;
    writeFileSync(join(dir, "labels.json"), `${JSON.stringify({ judge: "gpt-6-astra", labelledWith: dirs.map((d) => d.split("/").at(-1)), labels: mine }, null, 2)}\n`);
  }
  console.log(`labelled ${Object.keys(labels).length} of ${cases.length} tutor replies`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
