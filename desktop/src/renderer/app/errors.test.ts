import { describe, expect, it } from 'vitest';
import { AGENT_FAILED, OFFLINE } from '../../shared/api';
import { problemOf, SAY, sayOf } from './errors';

const say = (message: string) => {
  const error = new Error(message);
  const problem = problemOf(error);
  if (problem === 'connect') throw new Error('goes to connect');
  return sayOf(error, problem);
};

describe('what a failure says', () => {
  it("is Codemm's words for a known problem", () => {
    expect(say(OFFLINE)).toBe(SAY.offline);
    expect(say(AGENT_FAILED)).toBe(SAY.agent);
  });

  it("is main's own learner-safe message for any other, so a reason and its next step reach the learner", () => {
    expect(say('Too many programs are running. Stop one, then run again.')).toBe('Too many programs are running. Stop one, then run again.');
    expect(say("That didn't work. Try again.")).toBe(SAY.other);
    expect(say('')).toBe(SAY.other);
  });

  it('shows plain sentences only: no command, path or tool name, and nothing cut short', () => {
    expect(say("The container runtime isn't running. Start Docker Desktop (or `podman machine start`).")).toBe(SAY.other);
    expect(say('exercises/react/state-easy-1/Counter.jsx is missing. Restore it, or run get_exercise.')).toBe(SAY.other);
    expect(say('Bad input')).toBe(SAY.other);
    expect(say('Codemm is busy with another change to this course or track. Retry in a moment.')).toBe('Codemm is busy with another change to this course or track. Retry in a moment.');
  });

  it("never shows an error the window made itself", () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'name').");
    expect(sayOf(bug, problemOf(bug) as 'other')).toBe(SAY.other);
  });

  it('keeps the first line only: a longer message can name exercises', () => {
    expect(say("The rebuilt image behaves differently, so it wasn't accepted:\ndemo/ex-1: results changed")).toBe("The rebuilt image behaves differently, so it wasn't accepted.");
  });
});
