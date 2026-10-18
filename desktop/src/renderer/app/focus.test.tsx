import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createMock } from '../../main/mock';
import { mockWithCourse, renderApp } from '../test-utils';

describe('focus on a new screen (accessibility)', () => {
  it('leaves focus alone on the first screen', async () => {
    renderApp({ to: 'welcome' }, createMock());
    await screen.findByRole('heading', { level: 1 });
    expect(document.body).toHaveFocus();
  });

  it("moves focus to the new screen's heading, so a screen reader starts there", async () => {
    const user = userEvent.setup();
    renderApp({ to: 'welcome' }, createMock());
    await user.click(await screen.findByRole('button', { name: 'Connect an agent' }));
    const heading = await screen.findByRole('heading', { level: 1, name: 'Connect an agent' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(heading).toHaveAttribute('tabindex', '-1');
  });

  it('waits for a heading that appears once the screen has loaded', async () => {
    const user = userEvent.setup();
    const { api, course } = await mockWithCourse({ read: true });
    renderApp({ to: 'learn' }, api);
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    const heading = await screen.findByRole('heading', { level: 1, name: 'Click Counter' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(course).toBeTruthy();
  });

  it("keeps the focus a screen gives itself, such as the goal's text box", async () => {
    const user = userEvent.setup();
    const api = createMock();
    await api.connect('claude');
    renderApp({ to: 'welcome' }, api);
    await user.click(await screen.findByRole('button', { name: 'Start learning' }));
    const box = await screen.findByRole('textbox', { name: 'What do you want to learn?' });
    await new Promise((r) => setTimeout(r, 50));
    expect(box).toHaveFocus();
  });
});
