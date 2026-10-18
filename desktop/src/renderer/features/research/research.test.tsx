import { act, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ResearchProgress } from '../../../shared/api';
import { createMock } from '../../../main/mock';
import { renderApp } from '../../test-utils';

describe('research progress', () => {
  it('lists what research is looking at, the latest first, with a step count', async () => {
    const api = createMock();
    let hear: (p: ResearchProgress) => void = () => undefined;
    api.onResearchProgress = (listener) => ((hear = listener), () => undefined);
    api.research = async () => ({ state: 'running' });
    renderApp({ to: 'research', goal: { topic: 'React', known: '', depth: 'standard' } }, api);
    await screen.findByRole('heading', { name: 'Researching React' });
    act(() => hear({ kind: 'search', query: 'react roadmap 2026' }));
    act(() => hear({ kind: 'read', url: 'roadmap.sh/react' }));
    act(() => hear({ kind: 'step', label: 'Saving the roadmap' }));
    const list = screen.getByRole('list', { name: 'What Codemm is looking at' });
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Saving the roadmap', 'Reading roadmap.sh/react', 'Searching react roadmap 2026']);
    expect(screen.getByText('3 steps')).toBeInTheDocument();
  });
});
