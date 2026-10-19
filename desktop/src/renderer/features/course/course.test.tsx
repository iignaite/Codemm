import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SIGNED_OUT, type CodemmApi, type Concept, type JobProgress, type Roadmap, type RoadmapChange } from '../../../shared/api';
import type { MockOptions } from '../../../main/mock';
import { mockWithRoadmap, renderApp } from '../../test-utils';

const names = () => within(screen.getByRole('list')).getAllByRole('listitem').map((li) => li.getAttribute('aria-label'));

async function open(options?: MockOptions, before?: (api: CodemmApi) => void): Promise<{ api: CodemmApi; roadmap: Roadmap; user: ReturnType<typeof userEvent.setup> }> {
  const { api, roadmap } = await mockWithRoadmap(options);
  before?.(api);
  const small = { ...roadmap, concepts: roadmap.concepts.filter((c) => ['javascript-basics', 'jsx', 'lists-and-keys', 'forms'].includes(c.id)) };
  renderApp({ to: 'course', roadmap: small }, api);
  await screen.findByRole('heading', { name: 'React' });
  return { api, roadmap: small, user: userEvent.setup() };
}

describe('roadmap sources', () => {
  it('lists the sources as links that open outside the app, and shows nothing when there are none', async () => {
    const { api, roadmap } = await mockWithRoadmap();
    const view = renderApp({ to: 'course', roadmap: { ...roadmap, sources: [{ title: 'React docs', url: 'https://react.dev/learn' }] } }, api);
    const sources = await screen.findByRole('region', { name: 'Sources' });
    const link = within(sources).getByRole('link', { name: 'React docs' });
    expect(link).toHaveAttribute('href', 'https://react.dev/learn');
    expect(link).toHaveAttribute('target', '_blank');
    // Under the heading, above the topics, so a long roadmap doesn't push them out of view.
    expect(sources.compareDocumentPosition(screen.getByRole('list', { name: 'Roadmap' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    view.unmount();
    renderApp({ to: 'course', roadmap: { ...roadmap, sources: [] } }, api);
    await screen.findByRole('heading', { name: 'React' });
    expect(screen.queryByRole('region', { name: 'Sources' })).not.toBeInTheDocument();
  });
});

describe('course editor', () => {
  it('saves each edit as it happens, so leaving keeps the draft', async () => {
    const { api, user } = await open();
    await user.click(screen.getByRole('button', { name: 'Remove Lists and keys' }));
    await waitFor(async () => expect((await api.draft())!.concepts.map((c) => c.title)).toEqual(['JavaScript basics', 'JSX', 'Forms']));
  });

  it('renames, removes, adds and reorders topics without dragging', async () => {
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: 'Rename Forms' }));
    const name = screen.getByRole('textbox', { name: 'Topic name' });
    await user.clear(name);
    await user.type(name, 'Forms and inputs');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(names()).toEqual(['JavaScript basics', 'JSX', 'Lists and keys', 'Forms and inputs']);

    await user.click(screen.getByRole('button', { name: 'Remove Lists and keys' }));
    expect(names()).toEqual(['JavaScript basics', 'JSX', 'Forms and inputs']);

    await user.click(screen.getByRole('button', { name: 'Move Forms and inputs' }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Move up' })).toHaveFocus();
    await user.click(within(menu).getByRole('menuitem', { name: 'Move up' }));
    expect(names()).toEqual(['JavaScript basics', 'Forms and inputs', 'JSX']);

    await user.click(screen.getByRole('button', { name: 'Move JavaScript basics' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add a topic' }));
    await user.type(screen.getByRole('textbox', { name: 'Topic name' }), 'Hooks{Enter}');
    expect(names()).toEqual(['JavaScript basics', 'Forms and inputs', 'JSX', 'Hooks']);
  });

  it('refuses edits that would break a prerequisite, and says why', async () => {
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: 'Move JSX' }));
    await user.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Move up' }));
    expect(within(screen.getByRole('main')).getByRole('status')).toHaveTextContent('Needs JavaScript basics first');
    expect(names()).toEqual(['JavaScript basics', 'JSX', 'Lists and keys', 'Forms']);

    await user.click(screen.getByRole('button', { name: 'Remove JavaScript basics' }));
    expect(within(screen.getByRole('main')).getByRole('status')).toHaveTextContent('JSX needs this topic');
  });

  it('cannot approve while a topic is being renamed', async () => {
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: 'Rename Forms' }));
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  it('goes deeper on one topic: Codemm splits it into its smaller skills', async () => {
    const asked: string[] = [];
    const { api, user } = await open();
    const revise = api.reviseRoadmap;
    api.reviseRoadmap = (concepts, request) => (asked.push(request), revise(concepts, request));
    await user.click(screen.getByRole('button', { name: 'Go deeper on JSX' }));
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]).toContain('Go deeper on "JSX"');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled());
  });

  it('labels Go deeper in words, and names the other row buttons on hover', async () => {
    await open();
    expect(screen.getByRole('button', { name: 'Go deeper on JSX' })).toHaveTextContent('Go deeper');
    expect(screen.getByRole('button', { name: 'Rename JSX' })).toHaveAttribute('title', 'Rename');
    expect(screen.getByRole('button', { name: 'Remove JSX' })).toHaveAttribute('title', 'Remove');
    expect(screen.getByRole('button', { name: 'Move JSX' })).toHaveAttribute('title', 'Move');
  });

  it("keeps the learner's title on the topic it splits, even when the agent renames it", async () => {
    const asked: string[] = [];
    const saved: Concept[][] = [];
    const { api, roadmap, user } = await open();
    api.saveDraft = async (concepts) => void saved.push(concepts);
    api.reviseRoadmap = async (concepts, request) => {
      asked.push(request);
      // The agent splits JSX: it keeps the id for the first piece but retitles it, and adds the next piece.
      const split = concepts.flatMap((c) => (c.id === 'jsx' ? [{ ...c, title: 'What is JSX?' }, { id: 'jsx-expressions', title: 'JSX expressions', requires: ['jsx'] }] : [c]));
      return { roadmap: { ...roadmap, concepts: split }, changed: true, text: '' };
    };
    await user.click(screen.getByRole('button', { name: 'Rename JSX' }));
    await user.clear(screen.getByRole('textbox', { name: 'Topic name' }));
    await user.type(screen.getByRole('textbox', { name: 'Topic name' }), 'JSX basics{Enter}');
    await user.click(screen.getByRole('button', { name: 'Go deeper on JSX basics' }));
    expect(await screen.findByRole('listitem', { name: 'JSX expressions' })).toBeInTheDocument();
    expect(names()).toContain('JSX basics');
    expect(names()).not.toContain('What is JSX?');
    expect(asked[0]).toContain('"JSX basics"');
    expect(saved.at(-1)!.find((c) => c.id === 'jsx')!.title).toBe('JSX basics');
  });

  it('keeps a topic name and a requested change within their limits, and says so', async () => {
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: 'Rename JSX' }));
    const name = screen.getByRole('textbox', { name: 'Topic name' });
    await user.clear(name);
    await user.paste('n'.repeat(250));
    expect(name).toHaveValue('n'.repeat(200));
    expect(screen.getByText('Up to 200 characters.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    const request = screen.getByRole('textbox', { name: 'Ask Codemm for changes' });
    await user.click(request);
    await user.paste('r'.repeat(2500));
    expect(request).toHaveValue('r'.repeat(2000));
    expect(screen.getByText('Up to 2,000 characters.')).toBeInTheDocument();
  });

  it("locks the learner's own edits while Codemm changes the roadmap, so its change can't overwrite them", async () => {
    const { api, roadmap, user } = await open();
    let finish: (c: RoadmapChange) => void = () => undefined;
    api.reviseRoadmap = () => new Promise((r) => (finish = r));
    await user.click(screen.getByRole('button', { name: 'Rename Forms' }));
    await user.click(screen.getByRole('button', { name: 'Go deeper on JSX' }));
    // An open rename closes unsaved, and every edit waits for the change.
    expect(screen.queryByRole('textbox', { name: 'Topic name' })).not.toBeInTheDocument();
    const locked = ['Move JSX', 'Go deeper on Forms', 'Rename JSX', 'Remove JSX', 'Add a topic'];
    for (const name of locked) expect(screen.getByRole('button', { name })).toBeDisabled();
    for (const li of within(screen.getByRole('list')).getAllByRole('listitem')) expect(li).toHaveAttribute('draggable', 'false');
    await act(async () => finish({ roadmap, changed: false, text: 'No change.' }));
    for (const name of locked) expect(screen.getByRole('button', { name })).toBeEnabled();
  });

  it('shows the change job\'s stages and latest step while Codemm changes the roadmap', async () => {
    let hear: (p: JobProgress) => void = () => undefined;
    const { api, roadmap, user } = await open(undefined, (a) => (a.onJobProgress = (listener) => ((hear = listener), () => undefined)));
    let finish: (c: RoadmapChange) => void = () => undefined;
    api.reviseRoadmap = () => new Promise((r) => (finish = r));
    await user.type(screen.getByRole('textbox', { name: 'Ask Codemm for changes' }), 'Testing{Enter}');
    act(() => hear({ job: 'j1', kind: 'roadmap', stage: 1, steps: [{ kind: 'step', label: 'Reading the roadmap' }], count: 1, thinking: true, elapsedMs: 3000, idleMs: 0 }));
    const bar = await screen.findByRole('group', { name: 'Changing the roadmap' });
    expect(within(bar).getByText('Reading the roadmap')).toBeInTheDocument();
    expect(within(bar).getByRole('listitem', { current: 'step' })).toHaveTextContent('Changing the roadmap');
    await act(async () => finish({ roadmap, changed: false, text: 'No change.' }));
    expect(screen.queryByRole('group', { name: 'Changing the roadmap' })).not.toBeInTheDocument();
  });

  it('asks Codemm for changes', async () => {
    const { user } = await open();
    await user.type(screen.getByRole('textbox', { name: 'Ask Codemm for changes' }), 'Testing{Enter}');
    expect(await screen.findByRole('listitem', { name: 'Testing' })).toBeInTheDocument();
  });

  it('applies a typed request with Apply, and Approve waits until it is applied', async () => {
    const { api, user } = await open();
    const revise = api.reviseRoadmap;
    let finish!: () => void;
    api.reviseRoadmap = (concepts, request) => new Promise((resolve) => (finish = () => resolve(revise(concepts, request))));
    await user.type(screen.getByRole('textbox', { name: 'Ask Codemm for changes' }), 'Testing');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('Updating the roadmap…')).toBeInTheDocument();
    finish();
    expect(await screen.findByRole('listitem', { name: 'Testing' })).toBeInTheDocument();
    expect(screen.queryByText('Updating the roadmap…')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  it("keeps the learner's edits when sign-in expires during a request", async () => {
    const options: MockOptions = {};
    const { user } = await open(options);
    await user.click(screen.getByRole('button', { name: 'Remove Forms' }));
    options.agentProblem = 'signed-out';
    await user.type(screen.getByRole('textbox', { name: 'Ask Codemm for changes' }), 'Testing{Enter}');
    const claude = await screen.findByRole('listitem', { name: 'Claude Code' });
    await user.click(within(claude).getByRole('button', { name: 'Try again' }));
    // A ready computer passes by itself.
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await screen.findByRole('heading', { name: 'React' });
    expect(names()).toEqual(['JavaScript basics', 'JSX', 'Lists and keys']);
  });

  it('keeps sources a change brought when sign-in expires on the next request', async () => {
    const options: MockOptions = {};
    const { api, roadmap, user } = await open(options);
    let calls = 0;
    api.reviseRoadmap = async () => {
      calls++;
      if (calls > 1) throw new Error(SIGNED_OUT);
      return { roadmap: { ...roadmap, sources: [{ title: 'New source', url: 'https://example.com/new' }] }, changed: true, text: '' };
    };
    const ask = async (text: string) => user.type(screen.getByRole('textbox', { name: 'Ask Codemm for changes' }), `${text}{Enter}`);
    await ask('Add sources');
    await screen.findByRole('link', { name: 'New source' });
    options.agentProblem = 'signed-out';
    await ask('More');
    const claude = await screen.findByRole('listitem', { name: 'Claude Code' });
    await user.click(within(claude).getByRole('button', { name: 'Try again' }));
    // A ready computer passes by itself.
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('link', { name: 'New source' })).toBeInTheDocument();
  });

  it('approves, then opens the first topic while setup is prepared', async () => {
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('heading', { name: 'JavaScript basics' })).toBeInTheDocument();
    expect(await screen.findByRole('dialog', { name: 'Set up React on this computer?' })).toBeInTheDocument();
  });
});

describe('a long roadmap', () => {
  it('scrolls its topics above a footer of its own, so Approve never covers the Ask box', async () => {
    // The real stylesheet (tests run from desktop/), so the computed style is the one the window uses.
    const sheet = document.createElement('style');
    sheet.textContent = readFileSync(resolve('src/renderer/styles/app.css'), 'utf8');
    document.head.append(sheet);
    const { roadmap } = await mockWithRoadmap();
    renderApp({ to: 'course', roadmap });
    const approve = await screen.findByRole('button', { name: 'Approve' });
    const body = screen.getByRole('list').closest('.editor-body')!;
    expect(getComputedStyle(body).overflowY).toBe('auto');
    const foot = approve.closest('footer')!;
    expect(body.contains(foot)).toBe(false);
    expect(foot).toContainElement(screen.getByRole('textbox', { name: 'Ask Codemm for changes' }));
    sheet.remove();
  });
});
