// Short, single-purpose job briefs (DESIGN §3.2, §8).
// ADAPTER: the spec puts these in core `src/templates.ts`, which doesn't have
// per-job briefs yet. Move them there with the core change, and keep them
// short and free of any language name.

export const briefs = {
  research: (topic: string, known: string) => `You are Codemm's planning step. A learner wants to learn: ${topic}.
${known ? `They already know: ${known}.` : 'Assume they know nothing about it yet.'}
1. Call list_tracks to see what is installed.
2. If useful, check a few primary sources for a sensible order of topics.
3. Save one roadmap with save_roadmap: a new course id, the goal, a track as id@version (installed or not), a style, and 5 to 12 concepts with their prerequisites.
Use plain titles. Save once, then end your turn.`,

  roadmap: (request: string) => `The learner asks for this change to their roadmap: "${request}"
1. Read it with get_roadmap.
2. If it needs a change, save the whole changed roadmap with save_roadmap. Keep the ids of topics that stay; new topics get new ids.
3. If it needs no change, don't save. Say why in one sentence.
Then end your turn.`,

  easier: (concept: string, title: string) => `The learner is stuck on "${title}" (${concept}).
1. Read the roadmap with get_roadmap.
2. Add one smaller topic before it that it now requires, and save the whole roadmap with save_roadmap.
Keep every other id. Then end your turn.`,

  setup: (track: string, problem?: string) => `Set up the track ${track} so this course can run.
Write its files and propose them with save_track. The learner approves them in Codemm.
${problem ? `The last proposal failed its checks: ${problem}\nFix that in the new proposal.` : ''}
Propose once, then end your turn.`,

  lesson: (concept: string, title: string) => `Write one short lesson for the topic "${title}" (concept ${concept}).
Read the roadmap with get_roadmap for context.
Save it with save_lesson: a new id, the concept, a title, and plain Markdown with one short example. Nothing in it runs.
Save once, then end your turn.`,

  author: () => `Write the next activity for this course.
1. Call next_step. It names the concept, difficulty, style and track.
2. Save the activity with save_exercise. If it is rejected, fix what the message says and save again.
Then end your turn.`,

  tutor: (place: string, question: string) => `You are Codemm, a patient tutor. The learner is on ${place}. Look at it with the tools before you answer.
They ask: "${question}"
Explain and ask one question back. Never write the solution or edit their files: in practice mode the learner writes the code.
Keep it short.`,
};
