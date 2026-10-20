// highlight.js loads once per test file, so the lesson with nothing to color goes first (§4.3).
const loaded = vi.hoisted(() => vi.fn());
vi.mock('highlight.js/lib/common', async (importActual) => (loaded(), importActual()));

import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CodemmApi } from '../../../shared/api';
import { mockWithCourse, renderApp } from '../../test-utils';

/** The first lesson of a course, saying `markdown`. */
async function lessonSaying(markdown: string): Promise<{ api: CodemmApi; id: string }> {
  const { api, course } = await mockWithCourse({ read: true });
  const id = course.topics[0].lessons[0].id;
  const real = await api.lesson(id);
  api.lesson = async () => ({ ...real, markdown });
  return { api, id };
}

describe("a lesson's code (§4.3)", () => {
  it('loads no highlighter when no fence names its code', async () => {
    const { api, id } = await lessonSaying('# Title\n\nJust words.\n\n```\nplain code\n```\n\n    indented code\n');
    const { container } = renderApp({ to: 'lesson', lessonId: id }, api);
    expect(await screen.findByText('Just words.')).toBeInTheDocument();
    expect(container.querySelector('pre code')).toHaveTextContent('plain code');
    expect(loaded).not.toHaveBeenCalled();
  });

  it("colors a fence whose info string highlight.js knows, and leaves an unknown one plain", async () => {
    const { api, id } = await lessonSaying('# Title\n\n```js\nlet count = 0;\n```\n\n```zzz\nlet other = 1;\n```');
    const { container } = renderApp({ to: 'lesson', lessonId: id }, api);
    await waitFor(() => expect(container.querySelector('code.language-js .hljs-keyword')).toHaveTextContent('let'));
    expect(loaded).toHaveBeenCalledTimes(1);
    expect(container.querySelector('code.language-js')).toHaveTextContent('let count = 0;');
    expect(container.querySelector('code.language-zzz')!.innerHTML).toBe('let other = 1;\n');
  });
});
