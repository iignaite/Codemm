import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { SIGNED_OUT, type CodemmApi, type Roadmap } from '../../../shared/api';
import type { MockOptions } from '../../../main/mock';
import { mockWithRoadmap, renderApp } from '../../test-utils';

const names = () => within(screen.getByRole('list')).getAllByRole('listitem').map((li) => li.getAttribute('aria-label'));

async function open(options?: MockOptions): Promise<{ api: CodemmApi; roadmap: Roadmap; user: ReturnType<typeof userEvent.setup> }> {
  const { api, roadmap } = await mockWithRoadmap(options);
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
    view.unmount();
    renderApp({ to: 'course', roadmap: { ...roadmap, sources: [] } }, api);
    await screen.findByRole('heading', { name: 'React' });
    expect(screen.queryByRole('region', { name: 'Sources' })).not.toBeInTheDocument();
  });
});

describe('course editor', () => {
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
    expect(screen.getByRole('status')).toHaveTextContent('Needs JavaScript basics first');
    expect(names()).toEqual(['JavaScript basics', 'JSX', 'Lists and keys', 'Forms']);

    await user.click(screen.getByRole('button', { name: 'Remove JavaScript basics' }));
    expect(screen.getByRole('status')).toHaveTextContent('JSX needs this topic');
  });

  it('cannot approve while a topic is being renamed', async () => {
    const { user } = await open();
    await user.click(screen.getByRole('button', { name: 'Rename Forms' }));
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  it('asks Codemm for changes', async () => {
    const { user } = await open();
    await user.type(screen.getByRole('textbox', { name: 'Ask Codemm for changes' }), 'Testing{Enter}');
    expect(await screen.findByRole('listitem', { name: 'Testing' })).toBeInTheDocument();
  });

  it("keeps the learner's edits when sign-in expires during a request", async () => {
    const options: MockOptions = {};
    const { user } = await open(options);
    await user.click(screen.getByRole('button', { name: 'Remove Forms' }));
    options.agentProblem = 'signed-out';
    await user.type(screen.getByRole('textbox', { name: 'Ask Codemm for changes' }), 'Testing{Enter}');
    const claude = await screen.findByRole('listitem', { name: 'Claude Code' });
    await user.click(within(claude).getByRole('button', { name: 'Try again' }));
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
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
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
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
