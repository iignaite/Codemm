# Codemm beta plan

A private beta with 5 to 10 learners, one course each, runs before the public 1.0 (DESIGN §1, D28). It checks whether real learners can go from installing the app to passing activities on their own, with their own agent.

## Who

5 to 10 self-learners, selected so that the group includes:

- each verified agent (Claude Code and Codex), and Cursor if it is verified by then;
- macOS, plus Windows and Linux if O3 makes them supported;
- a mix of complete beginners and people learning a second language or framework.

**Screening questions:**

1. Which computer and OS will you use?
2. Which coding agent do you already pay for, and on which plan?
3. Can you install Docker Desktop (or Docker Engine) on that computer?
4. Can you give about 3 hours over two weeks?
5. What would you like to learn?

**Recruiting.** The owner invites people from their own network and from learner communities they already belong to, using a short post or message that links the screening form. No paid ads.

## Consent

Each participant agrees in writing to a plain-language form before installing. The form says:

- **Codemm collects nothing automatically.** It has no telemetry. We learn only from what you tell us and from what you choose to share.
- **What you may share:** your survey answers; notes from our calls; and, if you choose, your usage figures (DESIGN §3.4) and your course progress. You can review anything before sending it.
- **Recordings** of calls need a separate yes, and you can withdraw that yes at any time.
- **Costs.** Codemm uses your own agent and your own plan or account. Lessons and activities use some of it.
- **The builds are unsigned test builds.** Opening them needs an extra step on macOS and Windows, which we show you.
- **You can stop at any time without giving a reason.** We delete what you shared within 30 days after the beta ends, unless you ask us to delete it sooner.

## Setup

We send a one-page guide covering:

- the installer for your OS;
- the unsigned-build step: on macOS, right-click and choose Open; on Windows, choose More info, then Run anyway;
- "Check this computer" (DESIGN §6.1);
- connecting your agent.

## Tasks

| # | Task | Done when |
|---|---|---|
| T1 | Install Codemm and pass "Check this computer" | every row passes |
| T2 | Connect your agent | the app turns to color |
| T3 | Start learning something new: pick a goal, change one topic in the roadmap, and approve the setup | the first lesson opens |
| T4 | Finish one topic: read its lessons and pass its activity | the topic shows as mastered, or the activity passes |
| T5 | Optional: when you're stuck, use one of the help options | you used Reread, Try an easier one, or Let Codemm edit |
| T6 | Come back at least a day later and continue | you pick up where you left off |

**Schedule:**

1. A 30-minute kickoff call, with screen sharing, covers T1 to T3.
2. Two weeks self-paced follow.
3. An optional 20-minute closing call.

## What to observe

- **Time** from installing to the first lesson, and from the first lesson to the first passed activity.
- **Where people hesitate or ask for help**, with the screen and the wording at that moment.
- **Every failure**, mapped to a row in DESIGN §5.
- **Whether a check was ever counted wrongly**: an infrastructure problem recorded as an attempt, or the reverse.
- **Whether the agent ever showed** a solution, a hidden test or anything held back by the reply filter. Any case is a blocker.
- **Lost work**: edits that disappeared, or files overwritten.
- **Usage per topic** (DESIGN §3.4), and whether it felt acceptable.
- **Accessibility**: keyboard use, reduced motion, readability.

## Exit criteria (D28)

The public 1.0 waits until all of these hold:

1. At least 5 learners finish T1 to T4, and at least 70% of those who start do.
2. No hidden-data leak and no lost learner work was seen.
3. No infrastructure failure was recorded as an attempt.
4. Every issue rated blocker is fixed and retested with the learner who hit it, or with the owner if that learner isn't available.
5. The median time from install to the first lesson is 30 minutes or less.

The results go in the release notes, without names.

## Exit survey

Five questions, answered on a 1 to 5 scale plus an optional comment:

1. How easy was it to get from installing to your first lesson?
2. How much did the lessons help you solve the activities?
3. When a check failed, did you understand what to fix?
4. Did you trust that passing meant you had learned it?
5. How likely are you to keep using Codemm?

One open question: what one change would have helped you most?
