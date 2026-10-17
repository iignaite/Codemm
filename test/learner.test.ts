import { describe, expect, it } from "vitest";
import { type CheckEvent, type LearnerEvent, MASTERED, nextStep, replay, REVIEW_DAYS, type RetryEvent, type SkipEvent } from "../src/learner.js";

const at = (n: number) => new Date(Date.UTC(2026, 9, 17, 0, n)).toISOString();
/** The same day as every `at`: no review is due yet. */
const NOW = at(59);
const day = (d: number) => new Date(Date.UTC(2026, 9, 17, 1) + d * 86_400_000).toISOString();

function attempt(over: Partial<CheckEvent> & { exercise: string; concepts: string[] }, n: number): CheckEvent {
  return { format_version: 1, kind: "check", at: at(n), difficulty: 1, passed: 1, total: 1, assisted: false, ...over };
}
const skip = (concept: string, n: number): SkipEvent => ({ format_version: 1, kind: "skip", at: at(n), concept });
const retry = (concept: string, n: number): RetryEvent => ({ format_version: 1, kind: "retry", at: at(n), concept });
const read = (lesson: string, concept: string, n: number): LearnerEvent => ({ format_version: 1, kind: "read", at: at(n), lesson, concept });

describe("replay: mastery", () => {
  it("starts at 0.5 and needs four perfect unassisted checks to reach mastery", () => {
    const log = [0, 1, 2, 3].map((n) => attempt({ exercise: `e${n}`, concepts: ["c.loops"] }, n));
    const m = (k: number) => replay(log.slice(0, k)).get("c.loops")?.mastery ?? 0.5;
    expect(m(1)).toBeCloseTo(0.65);
    expect(m(3)).toBeLessThan(MASTERED);
    expect(m(4)).toBeGreaterThanOrEqual(MASTERED);
  });

  it("ignores repeat passes of an exercise that was already passed", () => {
    const log = [0, 1, 2, 3].map((n) => attempt({ exercise: "same", concepts: ["x"] }, n));
    const s = replay(log).get("x")!;
    expect(s.mastery).toBeCloseTo(0.65);
    expect(s.difficulty).toBe(2);
  });

  it("still counts progress on an exercise until its first perfect check", () => {
    const log = [attempt({ exercise: "e", concepts: ["x"], passed: 0, total: 2 }, 0), attempt({ exercise: "e", concepts: ["x"], passed: 2, total: 2 }, 1)];
    expect(replay(log).get("x")!.mastery).toBeCloseTo(0.35 + 0.3 * (1 - 0.35));
  });

  it("ignores identical partial retries so they can't add up to mastery", () => {
    const log = [0, 1, 2, 3, 4, 5].map((n) => attempt({ exercise: "e", concepts: ["x"], passed: 9, total: 10 }, n));
    expect(replay(log).get("x")!.mastery).toBeCloseTo(0.5 + 0.3 * (0.9 - 0.5));
  });

  it("still counts failures toward the staircase when the score doesn't improve", () => {
    const log = [0, 1].map((n) => attempt({ exercise: "e", concepts: ["x"], passed: 0 }, n));
    expect(replay(log).get("x")!.stuck).toBe(true);
  });

  it("treats every check of an exercise with an assist event as assisted", () => {
    const log: LearnerEvent[] = [{ format_version: 1, kind: "assist", at: at(0), exercise: "e" }, attempt({ exercise: "e", concepts: ["x"] }, 1)];
    const s = replay(log).get("x")!;
    expect(s.mastery).toBeCloseTo(0.5 + 0.3 * 0.25 * 0.5);
    expect(s.difficulty).toBe(1);
  });

  it("counts a check once per concept even if the event lists a concept twice", () => {
    const s = replay([attempt({ exercise: "e", concepts: ["x", "x", "x"] }, 0)]).get("x")!;
    expect(s.mastery).toBeCloseTo(0.65);
    expect(s.difficulty).toBe(2);
  });

  it("moves toward the pass ratio", () => {
    const s = replay([attempt({ exercise: "e", concepts: ["x"], passed: 0, total: 4 }, 0)]).get("x")!;
    expect(s.mastery).toBeCloseTo(0.35);
  });

  it("counts an assisted attempt a quarter as much", () => {
    const s = replay([attempt({ exercise: "e", concepts: ["x"], assisted: true }, 0)]).get("x")!;
    expect(s.mastery).toBeCloseTo(0.5 + 0.3 * 0.25 * 0.5);
  });

  it("credits every concept an exercise lists", () => {
    const states = replay([attempt({ exercise: "e", concepts: ["a", "b"] }, 0)]);
    expect(states.get("a")?.mastery).toBeCloseTo(0.65);
    expect(states.get("b")?.mastery).toBeCloseTo(0.65);
  });

  it("skip defers a concept without changing its mastery, until its next check", () => {
    const skipped = replay([attempt({ exercise: "e", concepts: ["x"], passed: 0 }, 0), skip("x", 1)]).get("x")!;
    expect(skipped).toMatchObject({ mastery: 0.35, deferred: true });
    expect(replay([skip("x", 0), attempt({ exercise: "e", concepts: ["x"], passed: 0 }, 1)]).get("x")!.deferred).toBe(false);
  });

  it("retry ends stuck without changing mastery or difficulty", () => {
    const stuck = [0, 1].map((n) => attempt({ exercise: "e", concepts: ["x"], passed: 0 }, n));
    const before = replay(stuck).get("x")!;
    const after = replay([...stuck, retry("x", 2)]).get("x")!;
    expect(before.stuck).toBe(true);
    expect(after).toMatchObject({ stuck: false, failStreak: 0, mastery: before.mastery, difficulty: 1 });
  });

  it("a read changes nothing about mastery", () => {
    expect(replay([read("l1", "x", 0)]).get("x")?.mastery ?? 0.5).toBe(0.5);
  });
});

describe("replay: difficulty staircase", () => {
  it("steps up after a first-try, unassisted, perfect check", () => {
    expect(replay([attempt({ exercise: "e", concepts: ["x"] }, 0)]).get("x")?.difficulty).toBe(2);
  });

  it("doesn't step up on a retry, an assisted check or a partial pass", () => {
    const retry = [attempt({ exercise: "e", concepts: ["x"], passed: 0 }, 0), attempt({ exercise: "e", concepts: ["x"] }, 1)];
    expect(replay(retry).get("x")?.difficulty).toBe(1);
    expect(replay([attempt({ exercise: "e", concepts: ["x"], assisted: true }, 0)]).get("x")?.difficulty).toBe(1);
    expect(replay([attempt({ exercise: "e", concepts: ["x"], passed: 1, total: 2 }, 0)]).get("x")?.difficulty).toBe(1);
  });

  it("caps difficulty at 3", () => {
    const log = [0, 1, 2, 3].map((n) => attempt({ exercise: `e${n}`, concepts: ["x"] }, n));
    expect(replay(log).get("x")?.difficulty).toBe(3);
  });

  it("steps down after two failed checks in a row", () => {
    const log = [
      attempt({ exercise: "e1", concepts: ["x"] }, 0),
      attempt({ exercise: "e2", concepts: ["x"], passed: 0 }, 1),
      attempt({ exercise: "e2", concepts: ["x"], passed: 0 }, 2),
    ];
    const s = replay(log).get("x")!;
    expect(s.difficulty).toBe(1);
    expect(s.failStreak).toBe(0);
  });

  it("marks a concept stuck after two failures at difficulty 1", () => {
    const log = [0, 1].map((n) => attempt({ exercise: "e", concepts: ["x"], passed: 0 }, n));
    expect(replay(log).get("x")?.stuck).toBe(true);
    expect(replay([...log, attempt({ exercise: "e", concepts: ["x"] }, 2)]).get("x")?.stuck).toBe(false);
  });
});

describe("nextStep", () => {
  const roadmap = {
    concepts: [
      { id: "a", requires: [] as string[] },
      { id: "b", requires: ["a"] },
      { id: "c", requires: [] as string[] },
    ],
  };

  it("asks for a new exercise for the first unlocked concept", () => {
    expect(nextStep(roadmap, [], [], [], NOW)).toEqual({ kind: "author", concept: "a", difficulty: 1, lesson: null });
  });

  it("returns an unpassed exercise that already fits", () => {
    const exercises = [{ slug: "a1", concepts: ["a"], difficulty: 1 }];
    expect(nextStep(roadmap, exercises, [], [], NOW)).toEqual({ kind: "practice", exercise: "a1", concept: "a", difficulty: 1, lesson: null });
  });

  it("prefers the lowest mastery among unlocked concepts", () => {
    const log = [attempt({ exercise: "a1", concepts: ["a"] }, 0)];
    expect(nextStep(roadmap, [{ slug: "a1", concepts: ["a"], difficulty: 1 }], log, [], NOW)).toMatchObject({ concept: "c" });
  });

  it("unlocks a concept once its prerequisites are mastered", () => {
    const log = [
      ...[0, 1, 2, 3].map((n) => attempt({ exercise: `a${n}`, concepts: ["a"] }, n)),
      ...[4, 5, 6, 7].map((n) => attempt({ exercise: `c${n}`, concepts: ["c"] }, n)),
    ];
    expect(nextStep(roadmap, [], log, [], NOW)).toMatchObject({ kind: "author", concept: "b" });
  });

  it("reports stuck before offering more practice", () => {
    const stuck = [0, 1].map((n) => attempt({ exercise: "a1", concepts: ["a"], passed: 0 }, n));
    const exercises = [{ slug: "a1", concepts: ["a"], difficulty: 1 }];
    expect(nextStep({ concepts: [{ id: "a", requires: [] }] }, exercises, stuck, [], NOW)).toEqual({ kind: "stuck", concept: "a" });
  });

  it("reports stuck and done", () => {
    const stuck = [0, 1].map((n) => attempt({ exercise: "a1", concepts: ["a"], passed: 0 }, n));
    expect(nextStep({ concepts: [{ id: "a", requires: [] }] }, [], stuck, [], NOW)).toEqual({ kind: "stuck", concept: "a" });
    const done = [0, 1, 2, 3].map((n) => attempt({ exercise: `a${n}`, concepts: ["a"] }, n));
    expect(nextStep({ concepts: [{ id: "a", requires: [] }] }, [], done, [], NOW)).toEqual({ kind: "done" });
  });

  it("never finishes or unlocks through skip", () => {
    expect(nextStep({ concepts: [{ id: "a", requires: [] }] }, [], [skip("a", 0)], [], NOW)).toMatchObject({ kind: "author", concept: "a" });
    expect(nextStep(roadmap, [], [skip("a", 0), skip("c", 1)], [], NOW)).toMatchObject({ concept: "a" });
  });

  it("puts deferred concepts after the others", () => {
    expect(nextStep(roadmap, [], [skip("a", 0)], [], NOW)).toMatchObject({ concept: "c" });
  });

  it("chooses the earliest concept when every candidate is deferred", () => {
    const log = [attempt({ exercise: "c1", concepts: ["c"], passed: 0 }, 0), skip("c", 1), skip("a", 2)];
    expect(nextStep(roadmap, [], log, [], NOW)).toMatchObject({ concept: "a" });
  });

  it("isn't stuck after a retry", () => {
    const stuck = [0, 1].map((n) => attempt({ exercise: "a1", concepts: ["a"], passed: 0 }, n));
    const exercises = [{ slug: "a1", concepts: ["a"], difficulty: 1 }];
    expect(nextStep({ concepts: [{ id: "a", requires: [] }] }, exercises, [...stuck, retry("a", 2)], [], NOW)).toMatchObject({ kind: "practice", exercise: "a1" });
  });
});

describe("nextStep: lessons", () => {
  const roadmap = { concepts: [{ id: "a", requires: [] as string[] }] };
  const lessons = [{ id: "l1", concept: "a" }, { id: "l2", concept: "a" }, { id: "other", concept: "b" }];

  it("asks for a lesson when the concept has none", () => {
    expect(nextStep(roadmap, [], [], [], NOW)).toMatchObject({ kind: "author", lesson: null });
    expect(nextStep(roadmap, [{ slug: "a1", concepts: ["a"], difficulty: 1 }], [], [], NOW)).toMatchObject({ kind: "practice", lesson: null });
  });

  it("names the earliest unread lesson", () => {
    expect(nextStep(roadmap, [], [], lessons, NOW)).toMatchObject({ lesson: "l1" });
    expect(nextStep(roadmap, [], [read("l1", "a", 0)], lessons, NOW)).toMatchObject({ lesson: "l2" });
  });

  it("leaves the field out once every lesson for the concept is read", () => {
    const step = nextStep(roadmap, [], [read("l2", "a", 0), read("l1", "a", 1)], lessons, NOW);
    expect(step).toEqual({ kind: "author", concept: "a", difficulty: 1 });
  });
});

describe("review scheduling", () => {
  const roadmap = { concepts: [{ id: "a", requires: [] as string[] }, { id: "b", requires: [] as string[] }] };
  const read = [{ id: "la", concept: "a" }, { id: "lb", concept: "b" }];
  const reads: LearnerEvent[] = read.map((l, n) => ({ format_version: 1, kind: "read", at: at(n), lesson: l.id, concept: l.concept }));
  // Four first-try passes master "a" at day 0 (its difficulty climbs to 3 on the way).
  const masterA = [0, 1, 2, 3].map((n) => attempt({ exercise: `a${n}`, concepts: ["a"], at: day(0) }, n));
  const check = (exercise: string, d: number, passed = 1): CheckEvent => attempt({ exercise, concepts: ["a"], passed, at: day(d) }, 0);
  const atDay = (d: number) => new Date(Date.parse(day(d)) + 1).toISOString();

  it("schedules the first review a day after the check that mastered the concept", () => {
    expect(REVIEW_DAYS).toEqual([1, 3, 7, 21, 60]);
    expect(replay(masterA).get("a")).toMatchObject({ review: { stage: 0, due: day(1) } });
  });

  it("offers a due review before new concepts, on an unused exercise at the mastered difficulty", () => {
    const exercises = [{ slug: "a0", concepts: ["a"], difficulty: 1 }, { slug: "a9", concepts: ["a"], difficulty: 3 }];
    expect(nextStep(roadmap, exercises, [...reads, ...masterA], read, day(0))).toMatchObject({ concept: "b" });
    expect(nextStep(roadmap, exercises, [...reads, ...masterA], read, atDay(1))).toEqual({ kind: "review", concept: "a", difficulty: 3, exercise: "a9" });
  });

  it("asks for a new review exercise when none is unused", () => {
    expect(nextStep(roadmap, [], [...reads, ...masterA], read, atDay(1))).toEqual({ kind: "author", concept: "a", difficulty: 3, review: true });
  });

  it("moves through 1, 3, 7, 21 and 60 days on passes, then stops", () => {
    let log: LearnerEvent[] = masterA;
    let due = 1;
    for (const [i, gap] of [3, 7, 21, 60].entries()) {
      log = [...log, check(`r${i}`, due)];
      expect(replay(log).get("a")!.review).toEqual({ stage: i + 1, due: day(due + gap) });
      due += gap;
    }
    expect(replay([...log, check("r9", due)]).get("a")!.review).toBeUndefined();
  });

  it("doesn't count a check before the review is due", () => {
    expect(replay([...masterA, check("early", 0.5)]).get("a")!.review).toEqual({ stage: 0, due: day(1) });
  });

  it("drops a failed review below mastery, so the concept is practised again, and restarts at day 1", () => {
    const failed = [...masterA, check("r0", 1, 0)];
    const s = replay(failed).get("a")!;
    expect(s.mastery).toBeLessThan(MASTERED);
    expect(s.review).toBeUndefined();
    expect(nextStep({ concepts: [{ id: "a", requires: [] }] }, [], [...reads, ...failed], read, atDay(30))).toMatchObject({ kind: "author", concept: "a" });
    const again = [...failed, ...[5, 6, 7].map((n) => attempt({ exercise: `again${n}`, concepts: ["a"], at: day(2) }, n))];
    expect(replay(again).get("a")!.review).toEqual({ stage: 0, due: day(3) });
  });
});
