import { describe, expect, it } from "vitest";
import { unpinnedBases } from "../src/gates.js";

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
