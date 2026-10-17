// Job briefs (DESIGN §3.2, §8). The brief itself is core's JOB_BRIEFS
// (src/templates.ts), so the terminal and the app say the same thing; the app
// adds only the job's details: the goal, request, concept or track.
import type { JobKind } from './jobs';

/** Learner code given to the tutor, at most this many characters. */
const CODE_MAX = 64 * 1024;

/** What the author job writes: the exact next_step target, and the installed track's learner files. */
export interface AuthorTarget {
  concept: string;
  title: string;
  difficulty: number;
  style: string;
  track: string;
  files: string[];
}

export function briefsFrom(base: Record<JobKind, string>) {
  const brief = (kind: JobKind, ...details: (string | false | undefined)[]) => [base[kind], ...details.filter(Boolean)].join('\n\n');
  return {
    research: (course: string, topic: string, known: string) =>
      brief('research', `Course id: ${course}`, `The learner wants to learn: ${topic}`, known ? `They already know: ${known}` : 'They know nothing about it yet.'),
    roadmap: (request: string) => brief('roadmap', `The learner asks: ${request}`),
    easier: (concept: string, title: string) => brief('roadmap', `Make "${title}" (${concept}) easier: add one smaller topic that it requires.`),
    setup: (track: string, problem?: string) => brief('setup', `Track: ${track}`, problem && `The last proposal failed its checks: ${problem}`),
    lesson: (concept: string, title: string) => brief('lesson', `Concept: ${concept} (${title})`),
    author: (t: AuthorTarget) =>
      brief('author', `Concept: \`${t.concept}\` (${t.title}), difficulty ${t.difficulty}`, `Track: \`${t.track}\`, style \`${t.style}\``, `Learner files: ${t.files.map((f) => `\`${f}\``).join(', ')}`),
    tutor: (place: string, question: string, files?: Record<string, string>) => {
      const code = files && Object.entries(files).map(([path, text]) => `${path}:\n\`\`\`\n${text}\n\`\`\``).join('\n\n').slice(0, CODE_MAX);
      return brief('tutor', `The learner is on ${place}.`, code && `Their code:\n\n${code}`, `They ask: ${question}`);
    },
  };
}

export type Briefs = ReturnType<typeof briefsFrom>;

/** A new course id for a topic, in core's id format. `n` keeps it unique. */
export function courseId(topic: string, n: number): string {
  const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return `${slug || 'course'}-${n.toString(36)}`;
}
