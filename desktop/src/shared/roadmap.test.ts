import { describe, expect, it } from 'vitest';
import { addTopic, moveTopic, removeTopic, renameTopic } from './roadmap';

const concepts = [
  { id: 'values', title: 'Values', requires: [] },
  { id: 'functions', title: 'Functions', requires: ['values'] },
  { id: 'state', title: 'State', requires: [] },
];

describe('roadmap edits (§4.2)', () => {
  it('renames without changing the id', () => {
    expect(renameTopic(concepts, 'state', 'Component state')[2]).toEqual({ id: 'state', title: 'Component state', requires: [] });
  });

  it('adds a topic with a unique kebab-case id and no prerequisites', () => {
    const added = addTopic(concepts, 'State');
    expect(added.at(-1)).toEqual({ id: 'state-2', title: 'State', requires: [] });
    expect(addTopic(concepts, 'Lists and Keys!').at(-1)?.id).toBe('lists-and-keys');
    expect(addTopic(concepts, '###').at(-1)?.id).toBe('topic');
  });

  it('moves a topic, but never above one it requires', () => {
    expect(moveTopic(concepts, 'state', 0).map((c) => c.id)).toEqual(['state', 'values', 'functions']);
    expect(() => moveTopic(concepts, 'functions', 0)).toThrow('Needs Values first');
    expect(() => moveTopic(concepts, 'values', 1)).toThrow('Functions needs this topic');
  });

  it('removes a topic, but not one another topic requires', () => {
    expect(removeTopic(concepts, 'state').map((c) => c.id)).toEqual(['values', 'functions']);
    expect(() => removeTopic(concepts, 'values')).toThrow('Functions needs this topic');
  });
});
