import { describe, expect, it } from "vitest";
import { DRIVER_TOOLS } from "../src/judge.js";
import { AGENTS_SECTION, AUTHOR_AGENT, JOB_BRIEFS, type JobKind } from "../src/templates.js";

// Each rule below closes a failure the cross-model bench observed (docs/bench/results.md).
describe("tutor instructions (AGENTS.md section)", () => {
  it("forbids the solution in chat as well as in files, and asks for a hint about the actual exercise", () => {
    expect(AGENTS_SECTION).toMatch(/not in chat/i);
    expect(AGENTS_SECTION).toMatch(/first call `get_exercise` yourself \(don't ask which exercise\) and read their code\. Then give one hint/);
  });

  it("defines a good hint: name the one problem, ask one question, never state the fix", () => {
    expect(AGENTS_SECTION).toMatch(/name the one thing that's missing or wrong/);
    expect(AGENTS_SECTION).toMatch(/ask one question/);
    expect(AGENTS_SECTION).toMatch(/Don't state the fix, write the code or list the steps/);
  });

  it("keeps a plain tone in every tutor brief: no praise or cheerleading, just what's right or wrong and the next step", () => {
    for (const text of [AGENTS_SECTION, JOB_BRIEFS.tutor]) {
      expect(text).toMatch(/Keep a plain tone: no praise or cheerleading/);
      expect(text).toMatch(/say what's right or wrong and the next step/);
    }
  });

  it("says which tools the tutor calls itself and which go through the author subagent", () => {
    expect(AGENTS_SECTION).toMatch(/Only `save_track` and `save_exercise` go through the `codemm-author` subagent/);
  });

  it("tells a track author its pass probe must pass within a third of time_ms", () => {
    for (const text of [AUTHOR_AGENT, JOB_BRIEFS.setup]) expect(text).toMatch(/pass probe must also pass within a third of `time_ms`/);
  });

  it("tells a track author how heavy toolchains run offline, as another user, within the time limit", () => {
    for (const text of [AUTHOR_AGENT, JOB_BRIEFS.setup]) {
      expect(text).toMatch(/`time_ms` is per io case, or for a unit track's whole `test` command, compiling included, and at most 120000/);
      expect(text).toMatch(/in a folder any user can read \(not `\/root` or `\$HOME`/);
      expect(text).toMatch(/run the track's own build and test commands once in the Dockerfile, on the pass probe/);
      expect(text).toMatch(/must work on a copy in `\/tmp`/);
      expect(text).toMatch(/calling the compiler and test runner directly/);
    }
  });

  it("tells an exercise author to generate big io inputs with NN.gen, seeded", () => {
    for (const text of [AUTHOR_AGENT, JOB_BRIEFS.author]) {
      expect(text).toMatch(/write `NN.gen` instead of `NN.in`, a POSIX `sh` script whose output is input NN/);
      expect(text).toMatch(/fixed seed/);
      expect(text).toMatch(/up to 32 MB/);
    }
  });

  it("tells a track author to COPY its scripts from the track's files, not write them in the Dockerfile", () => {
    for (const text of [AUTHOR_AGENT, JOB_BRIEFS.setup]) {
      expect(text).toMatch(/put any script or config the track needs in the track's own files and \`COPY\` it/i);
      expect(text).toMatch(/never create files inside the Dockerfile with heredocs or long \`echo\` chains/i);
    }
  });

  it("asks every author for a task unlike the course's earlier ones, with its own title", () => {
    for (const text of [AUTHOR_AGENT, JOB_BRIEFS.author]) {
      expect(text).toMatch(/`earlier` lists the exercises this course already has/);
      expect(text).toMatch(/a different problem, not one of them renamed/);
      expect(text).toMatch(/title must differ from the concept's title/);
    }
    expect(AGENTS_SECTION).toMatch(/contract and earlier exercises from `next_step`/);
  });

  it("shows how a roadmap pins its track", () => {
    expect(AGENTS_SECTION).toMatch(/exactly as `list_tracks` shows it/);
  });
});

describe("author instructions (codemm-author subagent)", () => {
  it("tells a unit track to find its tests in $TESTS and never hide its runner's failure, without naming a language", () => {
    for (const text of [AUTHOR_AGENT, JOB_BRIEFS.setup]) {
      expect(text).toMatch(/find the test files in `\$TESTS`/);
      expect(text).toMatch(/Never hide the runner's own failure, such as finding no test files: a report that lists no tests fails/);
      // Exiting 0 with a report is required, so the rule can't also forbid what does that.
      expect(text).not.toMatch(/\|\| true/);
      expect(text).toMatch(/a report that lists no tests fails/);
    }
  });

  it("names every tool the judge's driver needs in a track image, and no other", () => {
    const line = AUTHOR_AGENT.split("\n").find((l) => l.startsWith("- The image must have"))!;
    const named = [...line.replace(/, and must not.*/, "").matchAll(/`([a-z]+)`/g)].map((m) => m[1]);
    expect(named).toEqual(["sh", ...DRIVER_TOOLS]);
  });

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

describe("the 1.0 learning flow in the tutor instructions", () => {
  it("handles setup, and teaches the lesson before the activity", () => {
    expect(AGENTS_SECTION).toMatch(/`setup`: the roadmap's track isn't installed yet/);
    expect(AGENTS_SECTION).toMatch(/`save_lesson`.*`get_lesson`.*call `mark_lesson_read` only after the learner says they've read it/s);
  });
});

describe("desktop job briefs (docs/desktop/DESIGN.md §3.2, §8)", () => {
  const kinds = Object.keys(JOB_BRIEFS) as JobKind[];

  // The desktop checks each brief against its job's tools (desktop/src/main/agent/briefs.test.ts).
  it("has a brief for every job in the spec", () => {
    expect(kinds.sort()).toEqual(["author", "lesson", "research", "roadmap", "setup", "tutor"]);
  });

  it.each(kinds)("keeps the %s brief within 25 lines", (kind) => {
    expect(JOB_BRIEFS[kind].split("\n").length).toBeLessThanOrEqual(25);
  });

  it("gives setup and author the same bench-checked rules as the terminal subagent", () => {
    expect(JOB_BRIEFS.setup).toMatch(/never make one up/i);
    expect(JOB_BRIEFS.setup).toMatch(/only proposes/);
    expect(JOB_BRIEFS.author).toMatch(/edge cases .* hidden tests/);
    expect(JOB_BRIEFS.author).toMatch(/reply with only the exercise id/);
  });

  it("sends a fresh author to next_step for the exact target and the track's contract", () => {
    expect(JOB_BRIEFS.author).toMatch(/`contract\.files`/);
    expect(JOB_BRIEFS.author).toMatch(/`contract\.examples`/);
    expect(AGENTS_SECTION).toMatch(/start the subagent with the concept, title, difficulty, style, track, contract and earlier exercises from `next_step`/);
  });

  it("asks the research job for its sources, and a roadmap change to keep them", () => {
    expect(JOB_BRIEFS.research).toMatch(/`sources`/);
    expect(JOB_BRIEFS.roadmap).toMatch(/Keep `sources`/);
  });

  it("keeps the tutor's hint rule and keeps it away from saves", () => {
    expect(JOB_BRIEFS.tutor).toMatch(/not in chat/);
    expect(JOB_BRIEFS.tutor).toMatch(/Don't state the fix, write the code or list the steps/);
  });
});

describe("roadmap granularity", () => {
  it.each([
    ["the research brief", () => JOB_BRIEFS.research],
    ["the roadmap-change brief", () => JOB_BRIEFS.roadmap],
    ["the terminal tutor", () => AGENTS_SECTION],
  ])("%s makes each concept one skill, with specific prerequisites", (_label, text) => {
    expect(text()).toMatch(/One concept is one skill: what one short lesson teaches and a few small graded exercises cover/);
    expect(text()).toMatch(/"useEffect dependency arrays" and "useEffect cleanup", not "useEffect"/);
    expect(text()).toMatch(/`requires` names the specific earlier skills/);
  });

  it("sets 15 to 30 concepts as the default for a course, unless the learner asks for another depth, and checks real curricula", () => {
    expect(JOB_BRIEFS.research).toMatch(/about 15 to 30 concepts for a language or framework course, unless the learner asks for a different depth/);
    expect(JOB_BRIEFS.research).toMatch(/Split anything that needs more than one lesson/);
    expect(JOB_BRIEFS.research).toMatch(/real curricula or the official docs/);
  });
});
