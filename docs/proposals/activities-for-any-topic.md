# Proposal: activities for any topic

Status: draft for the owner's review, 31 Oct 2026, revised after an Opus review the same day. Nothing here is built. Progression changes need the owner's review before code (1.0.1 rule), so this goes first.

## 1. The problem

A learner asked for a Harness Engineering course. The roadmap came back as 15 concepts, such as "Task contracts and explicit acceptance criteria" and "Calibrating autonomy, human review, and merge gates". Codemm can't practise most of them well today, for three reasons.

1. **The only activity is code.** An exercise is a starter, a reference, 2 to 4 wrong solutions and hidden tests, run in a track's sandbox (DESIGN §6). A concept that is mostly judgment either gets a toy coding task or is skipped. A skipped concept never counts as mastered, so the course never finishes.
2. **Research ends at the roadmap.** The research brief says only "You may research the topic first" (`src/templates.ts:144`). The roadmap keeps up to 10 `sources`, and `get_roadmap` returns them (`src/app/roadmaps.ts:59`), but nothing records what the research found per concept: the practice, the common mistakes, or how the concept is practised. Lessons and activities are written from the model's memory.
3. **Activities adapt pacing, not content.** The learner model reads one number per attempt, `passed/total` (`src/learner.ts:136`). The `check` event stores no per-test results and no code (`src/schemas.ts:262`). The author gets the count as `last` and is told "after a struggle, practise the same idea again" (`src/templates.ts:73`), but it can't see which idea failed. What adapts is which concept comes next, a difficulty from 1 to 3 that sets the scaffolding, review dates, and a new prerequisite when a learner is stuck.

## 2. Goals and non-goals

Goals:

- Any topic, including agentic engineering, gets activities that are graded deterministically.
- The learner chooses how to practise: code, quiz or no activities at all (lessons only), and later both. They can change it at any time.
- Research records each concept's practice and pitfalls, and lessons and activities use them.
- The next activity targets what the learner got wrong.

Non-goals:

- Codemm calling a model, or a model grading an answer. Grades stay deterministic.
- Changing the mastery bar. The owner kept it at 4 perfect checks (26 Oct 2026). `src/learner.ts`'s rules stay unchanged.
- Proving a statement or a quiz is right. DESIGN §1 already says the gates don't; that stays true and stays said.

## 3. Design

Each part ships alone, in the order of §7.

### 3.1 Research records practice and pitfalls

Each roadmap concept gains two optional fields:

```yaml
concepts:
  - id: retry.bounded
    title: "Bounded retry and repair loops"
    requires: [feedback.loops]
    practice: "Fix a loop that retries forever so it stops after a budget and only retries transient errors"
    pitfalls:
      - "Retrying every error, including ones that will never succeed"
      - "No budget, so a stuck agent loops until it times out"
      - "Retrying without feeding the error back, so each try repeats the last"
```

- `practice`: at most 300 characters. How the concept is practised in a graded activity.
- `pitfalls`: at most 5, each at most 200 characters. Common mistakes from the sources.
- Both are checked for structure only, like a lesson's text.

**Research brief.**

- Research the practice and the anti-patterns, not only the order. Prefer primary sources: official docs and engineering write-ups by the people who do the work.
- Give every concept a `practice` line. If no graded activity can practise a concept, it isn't a concept: fold it into a neighbouring concept's lesson.
- Fill `pitfalls` from the sources, not from memory.
- For a topic about building tools or systems rather than a language, `practice` names one of these shapes:
  - build the piece against a scripted fake;
  - fix an anti-pattern from `pitfalls`;
  - write a policy or grader that recorded cases are replayed through;
  - write a schema or config a scripted consumer reads;
  - make the smallest change that turns a recorded failure into a pass.

  The shapes live here, in the brief that runs once per course, not in every author job.

**Where the fields go.**

- The lesson job reads them through `get_roadmap`, which returns the raw concepts. Its brief adds: name the common mistakes from `pitfalls` and show one.
- The author job has no `get_roadmap` (`desktop/src/main/agent/jobs.ts:32`). So `next_step`'s author step adds the concept's `practice` and `pitfalls` beside `title` (`src/app/exercises.ts:83`). Its brief adds: practise the `practice` line, and write the wrong solutions from `pitfalls`.
- The setup brief adds one line: for such a topic, the image may hold a small kit the activities use, such as a scripted fake service, recorded cases and a sample project, written like any track file.

**The desktop keeps them.** `roadmapView` maps concepts to `{ id, title, requires }` (`desktop/src/main/views.ts:60`). Approve, draft saves and revisions all re-save those concepts through `saveConcepts` (`desktop/src/main/live.ts:266`). Today that would drop the new fields before any lesson is written. `saveConcepts` merges the learner's edits onto `get_roadmap`'s concepts by id, so fields the app doesn't show survive.

### 3.2 Quiz as a style

**The learner chooses.** The new-course screen asks how to practise, Code or Quiz, and the research brief carries the choice.

- **Code:** as today.
- **Quiz:** the roadmap's `style` is `quiz` and `track` is absent. No setup, no Docker and no WASI. `next_step` never returns `setup` (`src/app/exercises.ts:75`).

**A separate exercise style.** `Style` stays `io | unit`, because tracks and lessons use it too (`src/schemas.ts:9`, `:85`, `:338`). A new `ExerciseStyle` is `Style | "quiz"`, used only by `exercise.yaml`, `exercise.json` and, through `CourseStyle` (§3.5), the roadmap. A track can't offer `quiz`, and a quiz never reaches `trackContract`.

**An activity.** A quiz is an exercise saved through `save_exercise`:

```
exercise.yaml     { slug, style: quiz, concepts, difficulty, hint? }
README.md         the scenario and instructions
quiz.yaml         the questions, with the key (store only)
```

```yaml
questions:
  - text: "An agent's test tool returns the full 2 MB log on every run. What should change?"
    choices:
      - { text: "Return a capped summary with the failing tests first", correct: true }
      - { text: "Raise the model's context limit", why: "Treats the symptom; the noise still crowds out the signal" }
      - { text: "Tell the agent to read less of it", why: "An instruction the tool's output still overrides" }
      - { text: "Retry until the log is shorter", why: "The log won't change between runs" }
```

The workspace gets `README.md` and `answers.yaml`, the learner file:

```yaml
1: null
2: null
```

- The learner writes a choice number for each question, in a file or on the app's quiz screen through `writeLearnerFile`. For a quiz, `answers.yaml` is the only learner file.
- Codemm shuffles each question's choices once, after the gates pass and before the commit point. The stored order is the only order, so the right answer's position gives nothing away and every view shows the same order.
- `get_exercise` returns the questions and shuffled choices, never `correct` or `why`.

**Gates.** No sandbox. These replace gates 2 to 7 for a quiz.

1. The schema validates, the slug is new and the concepts exist.
2. 5 to 10 questions. Each has 3 to 5 choices, exactly one `correct`, and a `why` on every other choice.
3. No two choices in a question have the same text, ignoring case and spacing.
4. No question's text matches a question in an earlier quiz in the course, ignoring case and spacing. This is best effort: a reworded question passes.

The `why` is the quiz's wrong solution: each wrong choice names the mistake it represents, taken from `pitfalls`. As with a code exercise, the gates can't prove the key is right (§1). A quiz save takes the course lock only, since there is no track.

**Difficulty**, in the author brief:

- 1: pick the right term or rule for a short situation.
- 2: apply an idea to a scenario.
- 3: diagnose a trace or a design that combines this concept with earlier ones.

**Grading.**

- `passed` is the number of right answers, and `total` the number of questions.
- The result shows each question as right or wrong and, for a wrong one, the chosen choice's `why`. It never shows which choice was right.
- **Test is refused on a quiz.** A quiz has no hidden set, so Test would let a learner try answers and then check once for a perfect score.

**One recorded check per quiz.**

- A check is recorded only when every question is answered. Otherwise it is graded and shown with `recorded: false`, as an unedited starter is today (`src/app/exercises.ts:309`).
- After the first recorded check, later checks of that quiz are graded and shown with `recorded: false`. The remaining choices narrow quickly, so they aren't evidence.
- **No dead end.** `next_step` offers `practice` for any exercise at the concept's difficulty with no perfect check (`src/learner.ts:195`). A quiz with a recorded imperfect check would be offered forever and could never pass. So `pickFor` (`src/app/exercises.ts:70`) leaves out every quiz that already has a recorded check before calling `learner.nextStep`. The concept then gets a new quiz, and two failed quizzes at difficulty 1 make it `stuck`, as two failed code checks do. DESIGN §7 step 6 says so.

**The learner model is unchanged.** A recorded quiz check is a `check` event with `passed` and `total`, so mastery, difficulty, reviews, "stuck" and skips work as they do for code.

**The tutor never gives the key.** The tutor and `AGENTS_SECTION` get a rule: never say which choice is right, only why a picked choice is wrong. The app's reply filter matches text (`desktop/src/main/views.ts:116`), so it can't catch "it's B", and `hiddenMaterial` (`src/app/lessons.ts:124`) doesn't cover a quiz key. This is the same honor-system line as "never give the learner a solution".

**The terminal.** `codemm check` works on `answers.yaml` like any learner file. `codemm test` refuses a quiz.

**Where the code assumes a track.** The quiz path is one early branch in `app/exercises` (save, load, check), plus an optional track in the roadmap and exercise schemas. These sites assume a track today and need the branch or a guard:

| Site | Assumes |
|---|---|
| `src/schemas.ts:151`, `:244` | `track` is required on the roadmap and `exercise.json` |
| `src/app/roadmaps.ts:20` | `parseTrackRef(roadmap.track)` and the track lock |
| `src/app/roadmaps.ts:27` | no track change once exercises exist |
| `src/app/exercises.ts:75` | `next_step` reads the track and its styles |
| `src/app/exercises.ts:97` | `saveExercise` takes the track lock, `installedTrack` and `ensureImage` |
| `src/app/exercises.ts:131`, `:152` | learner files come from `track.files`; `loadExercise` needs the installed track |
| `src/app/exercises.ts:203` | `writeLearnerFile` accepts only `track.files` |
| `src/app/exercises.ts:251` | `judge` calls `ensureImage` |
| `src/gates.ts:354` | gate 1 requires the track to offer the style |
| `desktop/src/main/live.ts:174`, `:495`, `:720` | setup, track and Docker flow |
| `desktop/src/main/views.ts:97` | `activityView` is an editor over track files |

A Quiz course can't become a Code course later, because a course can't change track once it has exercises. That stays: start a new course.

### 3.3 What the learner missed reaches the author

The `check` event gains an optional `missed`, at most 50 entries:

- io and unit: the visible tests that didn't pass, by name, and the hidden ones, by index only, as `check` already shows them;
- quiz: the question numbers that were wrong and the choice picked.

`lastCheck` returns it, and `next_step`'s author step carries it in `last`. The author brief changes "after a struggle, practise the same idea again" to: find the mistake from what they missed, and write the next activity at it; a "fix the mistake" task fits a code course.

This reverses a deliberate choice. `last` holds counts only because the tutor calls `next_step` too (`src/app/exercises.ts:36`). `missed` adds nothing hidden: hidden tests stay an index and a status, and the tutor already sees the same in `check`. It still needs the owner's sign-off and a DESIGN §8 update.

The learner's files and the last statement stay out for now: the workspace holds the current files, not the attempt that was checked, so they could disagree with `missed`. They are deferred (§9).

### 3.4 Open-ended work is feedback only

The tutor already reads the learner's work and question, so it can review an AGENTS.md or a task split today. The lesson brief adds one line: a lesson may end with one "try it" prompt for the tutor to review. That is never recorded and never moves mastery.

### 3.5 Lessons only

Activities are optional. The new-course screen offers a third choice, **Lessons only**: the roadmap's `style` is `none` and `track` is absent. Lessons are written and read as today, and nothing is graded.

**Styles.** `none` is a course style only, never an exercise's. Following §3.2's split: `Style` stays `io | unit` (tracks and lessons), `ExerciseStyle` is `Style | "quiz"`, and the roadmap's `CourseStyle` is `ExerciseStyle | "none"`.

**Progress is reading.** A new pure function in `learner`, `nextLesson(roadmap, log, lessons)`, steps through such a course. `nextStep` stays as it is, and `app/exercises` calls one or the other by the course's style.

- A concept is covered when it has at least one lesson and every lesson for it is read (`read` events, as today).
- The candidates are the concepts not yet covered whose prerequisites are all covered, in topological order with ties broken by roadmap order.
- It returns `{ kind: "learn", concept, lesson }`, where `lesson` is `null` when the concept has no lesson yet (the app writes one, as it does now) or the id of the earliest unread lesson.
- It returns `done` when every concept is covered.
- No mastery, difficulty, reviews or "stuck": those come only from checks. "Come back later" still defers a concept: it is skipped while anything else is open and comes back at the end.

The app shows lessons read, not mastery.

**Switching.** The learner can turn activities on or off at any time, from the course's settings. The app re-saves the roadmap with the new style, which the roadmap rules allow today.

- **Lessons only to Quiz:** always allowed, since neither has a track.
- **Lessons only to Code:** sets a track as well. That is allowed because a lessons-only course has no exercises, and `next_step` then returns `setup` as for any new code course.
- **Code or Quiz to Lessons only:** keeps the track, since a course with exercises can't change track. The event log is untouched, so mastery is still there when activities come back on.

Lessons read in lessons-only mode still count as read afterwards, so `next_step` doesn't teach them again.

### 3.6 A quality bar for roadmaps and lessons

Owner, 31 Oct 2026: "the quality of the roadmap and its teachings matter so always always use the best practices." Two kinds of best practice apply: the subject's own, from its primary sources, and proven teaching practice. Codemm can't judge either; it can make the agent show its work and check the structure.

**Sources the research trusts.**

- Primary sources first: official docs, standards, and engineering write-ups by the people who do the work. Use tutorials and summaries only to find primary sources.
- In a fast-moving field (agentic engineering, a framework's new major version), prefer sources from the last two years. Say in the lesson when a practice is contested or new.
- Order the roadmap from established curricula or official learning paths where they exist.

**Every concept traces to a source.** Each concept gains an optional `refs`: the indexes (from 0) of the roadmap's `sources` that its `practice` and `pitfalls` come from.

- Gate (structure only): when a roadmap has `sources`, every concept with `practice` or `pitfalls` has at least one ref, and every ref is in range.
- With at most 10 sources, a ref is a small number.
- The app can show a lesson's sources from its concept's refs.

**A roadmap review.** After the research job saves the roadmap, a review job checks it before the learner sees it. The review job is the learner's agent in a fresh session, as every job is, and Codemm calls no model. It reads the roadmap and its sources and reports:

- a core topic that is missing;
- an order that teaches a topic before what it needs;
- a pitfall or practice that no listed source supports;
- a concept nobody could practise.

The research job then revises once, in its own session. This costs one more agent run per course, not per activity. The owner put quality first, so this proposal runs it on every new course (§8 question 5).

**Lessons follow proven teaching practice.** The lesson brief's "what it is, why it matters, and one small worked example" becomes:

1. What the learner will be able to do, in one line (from `practice`).
2. Why it matters.
3. The idea, in small steps (Rosenshine's principles of instruction).
4. A worked example, step by step (the worked-example effect).
5. The common mistakes from `pitfalls`, with one shown and corrected.
6. Two self-check questions. In a lessons-only course, they matter most, since there's no activity: give the answers under a final "Answers" heading. Practice testing is one of the two techniques Dunlosky et al. rate most useful.
7. The sources it used, from the concept's `refs`.

**Activities follow assessment practice.**

- Code activities already do: wrong solutions from `pitfalls`, edge cases in the hidden tests.
- The quiz author brief adds the multiple-choice item-writing guidelines (Haladyna, Downing and Rodriguez):
  - one idea per question;
  - plausible wrong choices taken from real misconceptions;
  - no "all of the above" or "none of the above";
  - no trick wording or negatives;
  - choices of similar length.

**Already in Codemm, and kept.** Spaced review at 1, 3, 7, 21 and 60 days (the other technique Dunlosky et al. rate most useful). Mastery before moving on (Bloom's mastery learning). Difficulty 3 combines a concept with earlier ones.

**References.**

- Rosenshine, B. (2012). Principles of Instruction. *American Educator*.
- Sweller, J., et al. on the worked-example effect, in cognitive load theory.
- Dunlosky, J., et al. (2013). Improving students' learning with effective learning techniques. *Psychological Science in the Public Interest*.
- Haladyna, T., Downing, S., and Rodriguez, M. (2002). A review of multiple-choice item-writing guidelines. *Applied Measurement in Education*.
- Bloom, B. (1984). The 2 Sigma Problem. *Educational Researcher*.

## 4. Invariants

| Invariant | Holds because |
|---|---|
| Codemm ships no languages | `quiz` is an exercise style, never a track's, and kits are track files the agent writes. |
| Codemm never calls a model | A quiz is graded by comparing choice numbers. Reviews are the learner's own tutor. |
| Untrusted code runs only in a sandbox | A quiz runs nothing. |
| Hidden data never leaves | The key and the `why` of unpicked choices stay in the store. `missed` holds hidden tests by index only. |
| Infrastructure failures record nothing | Unchanged. A quiz check has no infrastructure. |
| Persistence | `quiz.yaml` is part of the exercise folder, written by the same atomic rename (`commitFolder`). `missed` is an optional field on an append-only event. A quiz save holds the course lock. |

**Older versions.** Events stay readable: the event schema strips unknown fields (`src/store.ts:431`). Courses and exercises don't. Concept objects are strict (`src/schemas.ts:154`) and `CourseRecord` extends them (`:235`), so an older Codemm, such as a terminal CLI older than the app, reports a course with `practice`, `pitfalls` or a quiz as damaged. The release notes say so, as DESIGN §4.5 does for a WASI `track.json`.

## 5. Changes by module

| Module | Change |
|---|---|
| `schemas` | `practice`, `pitfalls` and `refs` on concepts, with the `refs` gate; `ExerciseStyle` and `CourseStyle`; `track` optional for a quiz or lessons-only course and a quiz exercise; `quiz.yaml` and `answers.yaml`; `missed` on `check` |
| `gates` | Quiz gates 1 to 4 |
| `grading` | Grade `answers.yaml` against the key, with `missed` |
| `learner` | `lastCheck` returns `missed`; `nextLesson` for a lessons-only course |
| `app/exercises` | The quiz branch: save, load, check, Test refused, one recorded check; `pickFor` leaves out checked quizzes; `setup` only with a track; `nextLesson` when the style is `none`; `practice`, `pitfalls` and `missed` on the author step |
| `app/roadmaps` | A quiz course needs no track or track lock |
| `templates` | Research, review, lesson, author, setup and tutor briefs, and `AGENTS_SECTION` |
| desktop | A `review` job after research, then one revision; `saveConcepts` merges by id; Code, Quiz or Lessons only on the new-course screen, and a switch in the course's settings; a quiz screen; lessons read in place of mastery for a lessons-only course; no setup without a track |
| docs | DESIGN §2, §5, §6, §7 and §8 (including the `sources` that §8 leaves out of `get_roadmap` today); desktop DESIGN |

## 6. Tests

Test-first, per part:

- **3.1:** the roadmap schema accepts and limits `practice` and `pitfalls`; `get_roadmap` and the author step return them; the desktop's Approve keeps them.
- **3.2:**
  - each quiz gate rejects its case;
  - a quiz course saves with no track, and `next_step` never says `setup`;
  - a track can't declare `quiz`;
  - `get_exercise` never returns `correct` or `why`;
  - choices keep one order across reads;
  - unanswered counts as wrong, and a partly answered check isn't recorded;
  - a second check is `recorded: false`;
  - Test is refused;
  - after a failed quiz, `next_step` asks for a new one, and two failed quizzes at difficulty 1 are `stuck`;
  - the packed MCP test saves and checks a quiz.
- **3.3:** `missed` holds hidden tests by index only (the hidden-data scan covers it); an older event schema parses an event with `missed`.
- **3.6:** the `refs` gate rejects a missing or out-of-range ref; the review job runs once after research, and its revision runs once; the lesson brief names every step.
- **3.5:**
  - a lessons-only course saves with no track;
  - `nextLesson` asks for a lesson, waits on unread ones, follows prerequisites, defers a skipped concept, and is `done` when everything is read;
  - `get_exercise` and `check` refuse in such a course;
  - switching to Quiz or Code and back keeps the log, mastery and reads.
- **Briefs:** they name no language (the A1 scan).
- **Journey:** a Harness Engineering course as Code and as Quiz with a real agent, first activity passed, reviewed by an Opus agent.

## 7. Phases

1. **3.1 and 3.6:** the research fields, `refs`, the quality bar in every brief, the roadmap review, and the desktop merge. It improves every course's roadmap, lessons and activities, harness engineering's included.
2. **3.5:** lessons only. Small: a pure function, a style value and a desktop switch, and it sets up the "no track" path the quiz reuses.
3. **3.3:** `missed` to the author, after the owner signs off on reversing counts-only.
4. **3.2:** the quiz style. The biggest part: core, desktop screen and briefs.
5. **Both:** a Code course whose concepts may set `style: quiz`, chosen by research. It adds per-concept style, style resolution in `next_step` and a third choice on the new-course screen, and its quiz concepts still wait on the track's setup, so it comes after Quiz alone has shipped.
6. **3.4:** one lesson brief line.

## 8. Questions for the owner

1. **Weight.** Should a recorded quiz check move mastery the same as a code check? This proposal says yes, now that Test is refused and only one check per quiz counts. One gap remains: help from the tutor while answering isn't recorded as assistance, because assistance is recorded from edits. Accept that, or record a quiz as assisted when the tutor was asked during it?
2. **The key.** Should a quiz show the right answer after its recorded check? This proposal says no: the picked choice's `why` and the tutor teach instead, and the key stays hidden like hidden tests.
3. **`missed`.** Sign off on reversing counts-only `last` (§3.3)?
4. **Both.** Per concept, as in phase 5, or alternating within a concept (a quiz, then code)? Alternating gives one concept both kinds of evidence, but needs `next_step` to choose a style per activity.
5. **Roadmap review.** Run it on every new course, at one more agent run each (this proposal says yes), or only when the learner asks?

## 9. Deferred

- The learner's files and the last statement in `last` (§3.3), once a check can save the files it graded.
- A placement quiz that sets a concept's starting difficulty (already deferred in DESIGN §2). Quizzes make it cheap later.
- Quiz question types other than single choice, such as ordering or multiple answers.
- Per-question concept tags (the same as the deferred per-test tags).
