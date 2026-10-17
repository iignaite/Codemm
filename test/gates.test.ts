import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readFileMap } from "../src/files.js";
import { checkTrackFiles, unpinnedBases } from "../src/gates.js";

const PINNED = "alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc";

describe("unpinnedBases", () => {
  it("accepts base images pinned by digest", () => {
    expect(unpinnedBases(`FROM ${PINNED}\nRUN true\n`)).toEqual([]);
  });

  it("lists base images pinned only by tag, or not at all", () => {
    expect(unpinnedBases("# base\nfrom alpine:3.20\nFROM --platform=linux/amd64 debian AS tools\n")).toEqual(["alpine:3.20", "debian"]);
  });

  it("resolves ARG defaults in FROM", () => {
    expect(unpinnedBases(`ARG BASE=${PINNED}\nARG TAG="alpine:3.20"\nFROM \${BASE}\nFROM $TAG\n`)).toEqual(["alpine:3.20"]);
  });

  it("joins continued lines", () => {
    expect(unpinnedBases(`FROM \\\n  ${PINNED}\nFROM \\\n  alpine:3.20\n`)).toEqual(["alpine:3.20"]);
  });

  it("ignores scratch and earlier build stages", () => {
    expect(unpinnedBases(`FROM ${PINNED} AS build\nFROM scratch\nFROM build\nCOPY --from=build /a /a\n`)).toEqual([]);
  });
});

describe("checkTrackFiles", () => {
  const track = () => readFileMap(join(import.meta.dirname, "fixtures", "tracks", "custom-unit"));

  it("accepts a track whose probe is small enough to show authors as an example", () => {
    expect(checkTrackFiles(track()).spec.id).toBe("custom-unit");
  });

  it("refuses a probe example over 64 KB, since every author receives it", () => {
    const big = { ...track(), "probe/unit/tests/sums.check": `${"# padding\n".repeat(7_000)}2 3 => 5\n` };
    expect(() => checkTrackFiles(big)).toThrow(/64 KB/);
  });
});
