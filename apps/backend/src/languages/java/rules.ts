import { z } from "zod";

export const JavaSourceNoPackageSchema = z
  .string()
  .min(1)
  .refine((s) => !/^\s*package\s+/m.test(s), "Java source must not contain package declarations.");

export function countJUnitTests(testSuite: string): number {
  return (testSuite.match(/@Test\b/g) || []).length;
}

export function hasJUnit5Imports(testSuite: string): boolean {
  const hasTestImport = /org\.junit\.jupiter\.api\.Test/.test(testSuite);
  const hasAssertionsImport = /static\s+org\.junit\.jupiter\.api\.Assertions\.\*/.test(testSuite);
  return hasTestImport && hasAssertionsImport;
}

export function hasNonTrivialAssertions(testSuite: string): boolean {
  const assertionRegex =
    /\bassert(?:Equals|True|False|Throws|ArrayEquals|LinesMatch|IterableEquals|NotNull|Null|Same|NotSame|DoesNotThrow)\b\s*\(([^)]*)\)/g;

  const assertions: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = assertionRegex.exec(testSuite)) !== null) {
    assertions.push(match[0]);
  }

  if (assertions.length === 0) {
    return false;
  }

  return assertions.some((line) => {
    const lower = line.toLowerCase();
    if (lower.includes("asserttrue(true") || lower.includes("assertfalse(false")) {
      return false;
    }
    return true;
  });
}

/**
 * Flags brittle tests that include string literals with leading/trailing
 * whitespace (e.g. " Bob  White " or "Open "). These cases frequently cause
 * generator instability and aren't useful for v1-style problems.
 */
export function hasBrittleWhitespaceStringExpectations(testSuite: string): boolean {
  // Best-effort: scan all standard Java string literals.
  const re = /"((?:\\.|[^"\\])*)"/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(testSuite)) !== null) {
    const literal = match[1] ?? "";
    if (!/\S/.test(literal)) continue; // ignore all-whitespace strings
    if (/^\s/.test(literal) || /\s$/.test(literal)) {
      return true;
    }
  }
  return false;
}

export function isValidJUnit5TestSuite(testSuite: string, expectedTestCount: number): boolean {
  return isValidJUnit5TestSuiteCountRange(testSuite, expectedTestCount, expectedTestCount);
}

export function isValidJUnit5TestSuiteCountRange(
  testSuite: string,
  minTestCount: number,
  maxTestCount: number
): boolean {
  if (!testSuite.trim()) return false;
  if (/^\s*package\s+/m.test(testSuite)) return false;
  const count = countJUnitTests(testSuite);
  if (count < minTestCount || count > maxTestCount) return false;
  if (!hasJUnit5Imports(testSuite)) return false;
  if (!hasNonTrivialAssertions(testSuite)) return false;
  return true;
}

type JUnitTestBlock = {
  name: string;
  start: number;
  end: number;
};

function scanJUnitTestBlocks(testSuite: string): JUnitTestBlock[] {
  const source = String(testSuite ?? "");
  const blocks: JUnitTestBlock[] = [];
  const annotation = /@Test\b/g;
  let match: RegExpExecArray | null;

  while ((match = annotation.exec(source)) !== null) {
    const start = match.index;
    const afterAnnotation = source.slice(start);
    const signature = /(?:public|protected|private)?\s*(?:static\s+)?(?:final\s+)?(?:void|[\w<>\[\]]+)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*(?:throws\s+[^{]+)?\{/m.exec(
      afterAnnotation
    );
    if (!signature || !signature[1]) continue;

    const name = signature[1];
    const relativeOpen = signature.index + signature[0].lastIndexOf("{");
    const openIndex = start + relativeOpen;
    let depth = 0;
    let end = -1;

    for (let i = openIndex; i < source.length; i++) {
      const ch = source[i];
      if (ch === "{") depth++;
      if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end === -1) continue;
    while (end < source.length && /\s/.test(source[end] ?? "")) end++;
    blocks.push({ name, start, end });
  }

  return blocks;
}

export function pruneJUnitTestMethods(
  testSuite: string,
  methodNames: string[]
): { testSuite: string; dropped: string[]; remaining: number } {
  const names = new Set(methodNames.filter(Boolean));
  if (names.size === 0) {
    return { testSuite, dropped: [], remaining: countJUnitTests(testSuite) };
  }

  const blocks = scanJUnitTestBlocks(testSuite);
  const toDrop = blocks.filter((block) => names.has(block.name));
  if (toDrop.length === 0) {
    return { testSuite, dropped: [], remaining: countJUnitTests(testSuite) };
  }

  let next = testSuite;
  for (const block of [...toDrop].sort((a, b) => b.start - a.start)) {
    next = `${next.slice(0, block.start)}${next.slice(block.end)}`;
  }

  return {
    testSuite: next.trim(),
    dropped: toDrop.map((block) => block.name),
    remaining: countJUnitTests(next),
  };
}

export function javaTestSuiteCapturesStdout(testSuite: string): boolean {
  const ts = String(testSuite ?? "");
  // Deterministic, narrow signal: tests should redirect System.out to a buffer and assert on it.
  const captures =
    /\bByteArrayOutputStream\b/.test(ts) ||
    /\bSystem\s*\.\s*setOut\s*\(/.test(ts) ||
    /\bnew\s+PrintStream\s*\(/.test(ts);

  if (!captures) return false;

  // Require evidence that the captured bytes are read (assertions are already required by `isValidJUnit5TestSuite()`).
  return /\btoString\s*\(\s*\)/.test(ts) || /\btoByteArray\s*\(\s*\)/.test(ts);
}

export function javaTestSuiteSetsStdin(testSuite: string): boolean {
  const ts = String(testSuite ?? "");
  // Best-effort detection: stdin-driven programs must provide deterministic stdin.
  return /\bSystem\s*\.\s*setIn\s*\(/.test(ts) || /\bByteArrayInputStream\b/.test(ts);
}
