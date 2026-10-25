// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { TOOL_NAMES } from '../../../../src/mcp';
import { JOB_BRIEFS } from '../../../../src/templates';
import { LIMITS } from '../../shared/limits';
import { codemmServer } from '../server';
import { AGENT_CLIS } from './agents';
import { spawnable } from './bridge';
import { briefsFrom, courseId } from './briefs';
import { JOBS, type JobKind } from './jobs';

const briefs = briefsFrom(JOB_BRIEFS, 'darwin');

/** One argument on a Windows command line, quoted as Node quotes it (libuv's quote_cmd_arg). */
function windowsWord(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"]/.test(arg)) return arg;
  if (!/["\\]/.test(arg)) return `"${arg}"`;
  let out = '"';
  let slashes = 0;
  for (const c of arg) {
    if (c === '\\') slashes++;
    else {
      out += c === '"' ? '\\'.repeat(slashes * 2 + 1) + '"' : '\\'.repeat(slashes) + c;
      slashes = 0;
    }
  }
  return `${out}${'\\'.repeat(slashes * 2)}"`;
}

describe('job briefs', () => {
  it("start with core's brief for the job, then add only the job's details", () => {
    const research = briefs.research('react-1', 'React', 'HTML', 'in-depth');
    expect(research.startsWith(JOB_BRIEFS.research)).toBe(true);
    expect(research).toContain('Course id: react-1');
    expect(research).toContain('React');
    expect(research).toContain('They already know: HTML');
    // The learner chose how deep: the number of single-skill topics follows it.
    expect(research).toContain('Depth: in depth, about 25 to 30 topics');
    expect(briefs.research('r', 'React', '', 'overview')).toContain('Depth: an overview, about 8 topics');
    expect(briefs.research('r', 'React', '', 'standard')).toContain('Depth: standard, about 15 topics');
    expect(briefs.easier('state', 'State').startsWith(JOB_BRIEFS.roadmap)).toBe(true);
    expect(briefs.setup('react@1', 'io', 'no test runner')).toContain('no test runner');
    // The exact track: a proposal for another id or version doesn't set up this course.
    // Found in the macOS journey: a unit-only track for an io course left the course unable to go on.
    expect(briefs.setup('python@3', 'io')).toContain('Propose exactly the track `python@3`: id `python`, version 3, offering style `io`.');
    // The track caches what the whole course will use, so the setup agent hears the course's concepts.
    expect(briefs.setup('django@1', 'unit', undefined, ['Project structure', 'Models and migrations'])).toContain('The course covers: Project structure; Models and migrations.');
    expect(briefs.author()).toBe(JOB_BRIEFS.author);
  });

  it("gives the tutor the learner's own code and question", () => {
    const tutor = briefs.tutor('the activity "count-1"', 'Why?', { 'main.c': 'int main() {}' });
    expect(tutor.startsWith(JOB_BRIEFS.tutor)).toBe(true);
    expect(tutor).toContain('main.c');
    expect(tutor).toContain('int main() {}');
    expect(tutor.endsWith('They ask: Why?')).toBe(true);
  });

  it("keeps every agent's tutor turn within Windows' command-line limit, whatever the learner's code (§3.1)", () => {
    // Windows takes at most 32,767 characters for a whole command line, and quoting can double a brief's.
    const files = { 'src/main.c': '"\\'.repeat(100_000) };
    const question = '"'.repeat(LIMITS.words);
    const brief = briefsFrom(JOB_BRIEFS, 'win32').tutor('the activity "count-1"', question, files);
    const home = 'C:\\Users\\Ann Lee\\AppData\\Local';
    const server = codemmServer({
      runtime: `${home}\\Programs\\Codemm\\Codemm.exe`,
      coreDir: `${home}\\Programs\\Codemm\\resources\\core`,
      ws: 'C:\\Users\\Ann Lee\\Codemm',
      // A long PATH, as on a computer with many tools installed.
      env: { PATH: Array.from({ length: 40 }, (_, i) => `C:\\Program Files\\Tool ${i}\\bin`).join(';'), CODEMM_HOME: 'C:\\Users\\Ann Lee\\.codemm' },
    })('a-course-0', JOBS.tutor.tools, `${home}\\Temp\\codemm-progress\\job.json`);
    for (const [id, cli] of Object.entries(AGENT_CLIS)) {
      const { args } = cli.launch({ prompt: brief, server, tools: JOBS.tutor.tools, model: 'a-model', resume: '0b7d4c2e-9a1f-4e55-8a3e-2f6c1d9e7b10', web: false, toolTimeoutSec: 600 });
      for (const exe of [{ path: `${home}\\..\\..\\.local\\bin\\${cli.bin}.exe`, js: false }, { path: `${home}\\..\\Roaming\\npm\\node_modules\\${cli.bin}\\cli.js`, js: true }]) {
        const target = spawnable(exe, args, server.command);
        const line = [target.file, ...target.args].map(windowsWord).join(' ');
        expect([id, exe.js, line.length < 32_767]).toEqual([id, exe.js, true]);
      }
    }
  });

  it("keeps a setup brief within Windows' limit, whatever the failed proposal's problem says", () => {
    const problem = '"'.repeat(100_000);
    expect(briefsFrom(JOB_BRIEFS, 'win32').setup('c@1', 'io', problem).length).toBeLessThan(JOB_BRIEFS.setup.length + 5000);
    expect(briefsFrom(JOB_BRIEFS, 'darwin').setup('c@1', 'io', problem).length).toBeLessThan(JOB_BRIEFS.setup.length + 17_000);
  });

  it('gives the tutor more code where the command line allows it', () => {
    const code = 'x'.repeat(40_000);
    expect(briefsFrom(JOB_BRIEFS, 'darwin').tutor('here', 'Why?', { 'a.c': code })).toContain(code);
    expect(briefsFrom(JOB_BRIEFS, 'win32').tutor('here', 'Why?', { 'a.c': code })).not.toContain(code);
  });

  it('makes a new course id that core accepts', () => {
    expect(courseId('C++ Pointers & Memory!', 0)).toBe('c-pointers-memory-0');
    expect(courseId('日本語', 35)).toBe('course-z');
    expect(courseId('x'.repeat(100), 1)).toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/);
  });
});

// JOBS is the one list of each job's Codemm tools (DESIGN §3.2); core's briefs must keep to it.
describe('each job\'s tools and its brief', () => {
  const kinds = Object.keys(JOBS) as JobKind[];
  const named = (brief: string) => new Set(brief.match(new RegExp(`\\b(${TOOL_NAMES.join('|')})\\b`, 'g')));

  it('has a core brief for exactly the desktop\'s jobs, so the two JobKinds agree', () => {
    expect(Object.keys(JOB_BRIEFS).sort()).toEqual([...kinds].sort());
  });

  it('gives each job only real Codemm tools', () => {
    for (const k of kinds) for (const t of JOBS[k].tools) expect([k, (TOOL_NAMES as readonly string[]).includes(t)]).toEqual([k, true]);
  });

  it.each(kinds)('the %s brief names only its own tools', (kind) => {
    expect([...named(JOB_BRIEFS[kind])].filter((t) => !JOBS[kind].tools.includes(t))).toEqual([]);
  });

  it('keeps the tutor away from saves', () => {
    expect(JOBS.tutor.tools.filter((t) => t.startsWith('save_'))).toEqual([]);
  });
});
