import { describe, expect, it } from 'vitest';
import { shownTopic } from './topic';

describe('a typed goal as shown while research runs', () => {
  it.each([
    ['springboot?', 'Springboot'],
    ['  data   structures!? ', 'Data structures'],
    ['react', 'React'],
    ['C++', 'C++'],
    ['éclair', 'Éclair'],
    ['🌱 gardens', '🌱 gardens'],
    ['???', '???'],
  ])('shows %j as %j', (typed, shown) => {
    expect(shownTopic(typed)).toBe(shown);
  });
});
