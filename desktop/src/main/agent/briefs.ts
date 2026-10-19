// Job briefs (DESIGN §3.2, §8). The brief itself is core's JOB_BRIEFS
// (src/templates.ts), so the terminal and the app say the same thing; the app
// adds only the job's details: the goal, request, concept or track.
import type { Depth } from '../../shared/api';
import type { JobKind } from './jobs';

/**
 * The most characters of learner code a tutor brief carries, and of a failed proposal's problem a setup brief
 * carries. A brief is one command-line argument, and Windows takes 32,767 characters for a whole command line, which
 * quoting can double, so there they are smaller (§3.1).
 */
const ROOM = { code: 64 * 1024, problem: 16 * 1024 };
const WINDOWS_ROOM = { code: 8 * 1024, problem: 4 * 1024 };

/** The learner's chosen depth, as the research brief says it. */
const DEPTH: Record<Depth, string> = {
  overview: 'an overview, about 8 topics',
  standard: 'standard, about 15 topics',
  'in-depth': 'in depth, about 25 to 30 topics',
};

export function briefsFrom(base: Record<JobKind, string>, platform: NodeJS.Platform = process.platform) {
  const room = platform === 'win32' ? WINDOWS_ROOM : ROOM;
  const brief = (kind: JobKind, ...details: (string | false | undefined)[]) => [base[kind], ...details.filter(Boolean)].join('\n\n');
  return {
    research: (course: string, topic: string, known: string, depth: Depth) =>
      brief('research', `Course id: ${course}`, `The learner wants to learn: ${topic}`, known ? `They already know: ${known}` : 'They know nothing about it yet.', `Depth: ${DEPTH[depth]}. Each topic is one skill.`),
    roadmap: (request: string) => brief('roadmap', `The learner asks: ${request}`),
    easier: (concept: string, title: string) => brief('roadmap', `Make "${title}" (${concept}) easier: add one smaller topic that it requires.`),
    setup: (track: string, style: string, problem?: string) => {
      const [id, version] = track.split('@');
      return brief('setup', `Propose exactly the track \`${track}\`: id \`${id}\`, version ${version}, offering style \`${style}\`.`, problem && `The last proposal failed its checks: ${problem.slice(0, room.problem)}`);
    },
    lesson: (concept: string, title: string) => brief('lesson', `Concept: ${concept} (${title})`),
    author: () => brief('author'),
    tutor: (place: string, question: string, files?: Record<string, string>) => {
      const code = files && Object.entries(files).map(([path, text]) => `${path}:\n\`\`\`\n${text}\n\`\`\``).join('\n\n').slice(0, room.code);
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
