/* eslint-disable no-console */
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function listTestFiles(kind, filter) {
  const root = path.join(__dirname, "..", "test");
  const bases =
    kind === "all"
      ? [path.join(root, "unit"), path.join(root, "integration")]
      : [path.join(root, kind)];

  const files = [];
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    const baseFiles = walk(base);
    if (!filter) {
      files.push(...baseFiles);
      continue;
    }

    const normalizedFilter = filter.replace(/[\\/]+/g, path.sep);
    const filtered = baseFiles.filter((file) => {
      const rel = path.relative(base, file);
      return rel === normalizedFilter || rel.startsWith(`${normalizedFilter}${path.sep}`);
    });
    files.push(...filtered);
  }

  return files.filter((p) => p.endsWith(".test.js")).sort((a, b) => a.localeCompare(b));
}

function main(argv) {
  const kind = argv[2];
  if (!kind || (kind !== "unit" && kind !== "integration" && kind !== "all")) {
    console.error("Usage: node scripts/runTests.js <all|unit|integration> [componentPath]");
    return 2;
  }

  const filter = argv[3];
  const files = listTestFiles(kind, filter);
  if (files.length === 0) {
    console.error(filter ? `No ${kind} tests found for '${filter}'.` : `No ${kind} test files found.`);
    return 1;
  }

  const contractsBuild = spawnSync("npm", ["--workspace", "@codemm/shared-contracts", "run", "build"], {
    stdio: "inherit",
  });
  if ((contractsBuild.status ?? 1) !== 0) {
    return contractsBuild.status ?? 1;
  }

  // ts-node compilation dominates cost when Node runs each file in an isolated worker.
  // Running with no isolation keeps a single module cache and is significantly faster.
  // Note: Node's test runner flags vary across Node versions. Prefer broad compatibility.
  const nodeArgs = ["--test", "--test-concurrency=1", ...files];
  const res = spawnSync(process.execPath, nodeArgs, { stdio: "inherit" });
  return res.status ?? 1;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { listTestFiles, main };
