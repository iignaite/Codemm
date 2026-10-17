#!/usr/bin/env node
/**
 * Recomputes the host-derived numbers (tool calls, denials, turns, tokens) of every result in a folder
 * from the raw host logs in bench/runs/, after a parser fix. Store-derived checks are left as they were.
 * Usage: node bench/rescore.ts [results/<set>] [runs/<set>]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { claude } from "./lib/claude.ts";
import { codex } from "./lib/codex.ts";

const dir = resolve(import.meta.dirname, process.argv[2] ?? "results");
const runs = resolve(import.meta.dirname, process.argv[3] ?? "runs");
for (const f of readdirSync(dir).filter((n) => n.endsWith(".json") && n !== "labels.json")) {
  const result = JSON.parse(readFileSync(join(dir, f), "utf8"));
  const adapter = result.host === "codex" ? codex : claude;
  for (const journey of ["author", "tutor"] as const) {
    const log = join(runs, result.cell, `${journey}.jsonl`);
    if (!result[journey] || !existsSync(log)) continue;
    const run = adapter.parse(readFileSync(log, "utf8"));
    Object.assign(result[journey], { toolCalls: run.tools.length, denials: run.denials, turns: run.turns, tokens: run.tokens });
    if (run.serverFailed) Object.assign(result[journey], { infraFailure: true, success: false });
  }
  writeFileSync(join(dir, f), `${JSON.stringify(result, null, 2)}\n`);
  console.log(`rescored ${f}`);
}
