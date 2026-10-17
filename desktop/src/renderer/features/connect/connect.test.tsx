import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../../../main/mock';
import { renderWith } from '../../test/render';
import { Connect } from './Connect';
import { Welcome } from './Welcome';

describe('Welcome', () => {
  it('asks for an agent before anything else', async () => {
    const { user, go } = renderWith(<Welcome connected={false} />);
    expect(screen.getByRole('heading', { name: 'Learn anything.' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Connect an agent' }));
    expect(go).toHaveBeenCalledWith({ to: 'connect' });
  });

  it('wakes up once connected', async () => {
    const { user, go } = renderWith(<Welcome connected />);
    expect(screen.getByRole('heading', { name: 'Ready when you are.' })).toBeTruthy();
    expect(screen.getByText('Connected')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Start learning' }));
    expect(go).toHaveBeenCalledWith({ to: 'goal' });
  });
});

describe('Connect', () => {
  it('connects an agent, then continues', async () => {
    const { user, go } = renderWith(<Connect />);
    const cont = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
    expect(cont.disabled).toBe(true);
    await user.click(await screen.findByRole('button', { name: 'Connect Claude Code' }));
    expect(await screen.findByText('Connected')).toBeTruthy();
    expect(cont.disabled).toBe(false);
    await user.click(cont);
    expect(go).toHaveBeenCalledWith({ to: 'ready' });
  });

  it('shows the fix when connecting fails', async () => {
    const api = createMockApi();
    vi.spyOn(api, 'connectAgent').mockResolvedValue({ id: 'codex', name: 'Codex', state: 'failed', problem: 'Not signed in. Sign in to Codex first.' });
    const { user } = renderWith(<Connect />, { api });
    await user.click(await screen.findByRole('button', { name: 'Connect Codex' }));
    expect(await screen.findByText('Not signed in. Sign in to Codex first.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try Codex again' })).toBeTruthy();
  });
});
