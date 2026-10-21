// Roadmap edits in the app (DESIGN §4.2). Ids stay stable, and prerequisites
// are never rewritten: an edit that would break one is refused with a reason.
// Core's save_roadmap enforces the same rules; these give the learner the
// reason at once.
import type { Concept } from './api';

const title = (concepts: Concept[], id: string) => concepts.find((c) => c.id === id)?.title ?? id;

export function renameTopic(concepts: Concept[], id: string, newTitle: string): Concept[] {
  return concepts.map((c) => (c.id === id ? { ...c, title: newTitle } : c));
}

export function addTopic(concepts: Concept[], newTitle: string): Concept[] {
  const base = newTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'topic';
  let id = base;
  for (let n = 2; concepts.some((c) => c.id === id); n++) id = `${base}-${n}`;
  return [...concepts, { id, title: newTitle, requires: [] }];
}

/** Moves a topic to index `to`. Refused if it would come before a topic it requires, or after one that requires it. */
export function moveTopic(concepts: Concept[], id: string, to: number): Concept[] {
  const next = concepts.filter((c) => c.id !== id);
  const moved = concepts.find((c) => c.id === id)!;
  next.splice(to, 0, moved);
  const at = (cid: string) => next.findIndex((c) => c.id === cid);
  const missing = moved.requires.find((r) => at(r) > to);
  if (missing) throw new Error(`Needs ${title(concepts, missing)} first.`);
  const dependent = next.find((c) => c.requires.includes(id) && at(c.id) < to);
  if (dependent) throw new Error(`${dependent.title} needs this topic.`);
  return next;
}

export function removeTopic(concepts: Concept[], id: string): Concept[] {
  const dependent = concepts.find((c) => c.requires.includes(id));
  if (dependent) throw new Error(`${dependent.title} needs this topic.`);
  return concepts.filter((c) => c.id !== id);
}
