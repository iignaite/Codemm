#!/usr/bin/env node
/** Prints the results table and gate-rejection counts for every result in a folder (default bench/results), as Markdown. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type CellResult, rejectionCounts, renderTable } from "./lib/report.ts";

const dir = resolve(import.meta.dirname, process.argv[2] ?? "results");
const results: CellResult[] = readdirSync(dir)
  .filter((f) => f.endsWith(".json") && f !== "labels.json")
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));

const labelFile = join(dir, "labels.json");
const labels = existsSync(labelFile) ? JSON.parse(readFileSync(labelFile, "utf8")).labels : {};
console.log(renderTable(results, labels));
console.log("\n| Gate | Rejections |\n|---|---|");
for (const [gate, n] of rejectionCounts(results)) console.log(`| ${gate} | ${n} |`);
