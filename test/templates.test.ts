import { describe, expect, it } from "vitest";
import { AGENTS_SECTION, AUTHOR_AGENT } from "../src/templates.js";

// Each rule below closes a failure the cross-model bench observed (docs/bench/results.md).
describe("tutor instructions (AGENTS.md section)", () => {
  it("forbids the solution in chat as well as in files, and asks for a hint about the actual exercise", () => {
    expect(AGENTS_SECTION).toMatch(/not in chat/i);
    expect(AGENTS_SECTION).toMatch(/call `get_exercise` and give one hint/);
  });

  it("says which tools the tutor calls itself and which go through the author subagent", () => {
    expect(AGENTS_SECTION).toMatch(/Only `save_track` and `save_exercise` go through the `codemm-author` subagent/);
  });

  it("shows how a roadmap pins its track", () => {
    expect(AGENTS_SECTION).toMatch(/exactly as `list_tracks` shows it/);
  });
});

describe("author instructions (codemm-author subagent)", () => {
  it("never asks for an invented image digest", () => {
    expect(AUTHOR_AGENT).toMatch(/never make one up/i);
  });

  it("keeps a retry limit: without one, haiku made about 65 track attempts in one run", () => {
    expect(AUTHOR_AGENT).toMatch(/up to 3 tries, then report what still fails/);
  });

  it("shows a valid unit report and the exact statuses", () => {
    expect(AUTHOR_AGENT).toContain('{"tests":[{"name":"test_sum.test_basic","status":"pass"}');
  });

  it("explains how to write a mutant the visible tests miss, and that io output ignores trailing whitespace", () => {
    expect(AUTHOR_AGENT).toMatch(/edge cases .* hidden tests/);
    expect(AUTHOR_AGENT).toMatch(/trailing whitespace/);
  });

  it("starts track versions at 1", () => {
    expect(AUTHOR_AGENT).toMatch(/starting at 1/);
  });
});
