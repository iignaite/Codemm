require("../../helpers/setupBase");

const test = require("node:test");
const assert = require("node:assert/strict");

const { __test__ } = require("../../../src/pipeline/slotStages");

test("cpp starter synthesis: strips comments before checking for solve()", () => {
  const starter = `#include <bits/stdc++.h>
// Implement solve(int x) below.
// solve(int x) { return 0; }
`;
  const stripped = __test__.stripCppComments(starter);
  assert.equal(/\bsolve\s*\(/.test(stripped), false);
});

test("cpp starter synthesis: extracts solve signature and derives a minimal starter", () => {
  const reference = `#include <bits/stdc++.h>

long long solve(int n, const std::vector<std::tuple<int,int,int>>& edges) {
  return n + (int)edges.size();
}
`;

  const signature = __test__.extractCppSolveSignature(reference);
  assert.equal(signature, "long long solve(int n, const std::vector<std::tuple<int,int,int>>& edges)");

  const starter = __test__.deriveCppStarter(reference, "minimum spanning tree");
  assert.match(starter, /long long solve\s*\(/);
  assert.match(starter, /throw std::runtime_error\("TODO"\);/);
});

test("cpp starter synthesis: falls back to a minimal solve() when no signature is found", () => {
  const starter = __test__.deriveCppStarter("// nothing here", "graphs");
  assert.match(starter, /int solve\(\)/);
  assert.match(starter, /TODO: implement graphs/);
});
