// jsdom does no layout, so the rules that keep the page from scrolling are checked as written. The bug they stop was
// seen in the app: a long tutor chat made the workspace's row as tall as the chat, and Check's scrollIntoView then
// scrolled the whole window, top bar and sidebar included.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, 'app.css'), 'utf8');
const rule = (selector: string) => css.split('\n').find((line) => line.startsWith(`${selector} {`)) ?? '';

describe('the page never scrolls', () => {
  it("gives the workspace one row as tall as the window, so a long column scrolls inside itself", () => {
    expect(rule('.ws')).toContain('grid-template-rows: minmax(0, 1fr)');
    // Stacked in a narrow window, the rows are as tall as their content and the workspace scrolls.
    expect(css).toMatch(/\.ws, \.ws\.lesson \{[^}]*grid-template-rows: none; overflow-y: auto;/);
  });

  it('clips the window, which a scrollIntoView cannot scroll', () => {
    expect(rule('.win')).toContain('overflow: clip');
  });
});

describe("the learner's own words", () => {
  it('keep their line breaks and wrap a long word, in a note and in the chat', () => {
    for (const selector of ['.my-note span', '.you']) {
      expect(rule(selector)).toContain('white-space: pre-wrap');
      expect(rule(selector)).toContain('overflow-wrap: anywhere');
      expect(rule(selector)).toContain('min-width: 0');
    }
  });
});
