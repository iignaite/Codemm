import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { OFFLINE, REPAIR } from '../../../shared/api';
import { mockWithCourse, renderApp } from '../../test-utils';

describe('tracks', () => {
  it('lists what Codemm has set up, rebuilds a track, and starts something new', async () => {
    const user = userEvent.setup();
    const { api } = await mockWithCourse();
    renderApp({ to: 'tracks' }, api);
    const react = await screen.findByRole('listitem', { name: 'React' });
    await user.click(within(react).getByRole('button', { name: 'Rebuild' }));
    expect(await within(react).findByRole('button', { name: 'Rebuild' })).toBeEnabled();
    expect(within(react).getByRole('status')).toHaveTextContent('Rebuilt.');

    await user.type(screen.getByRole('textbox', { name: 'Learn something new' }), 'Rust');
    await user.click(screen.getByRole('button', { name: 'Start' }));
    expect(await screen.findByRole('heading', { name: 'Researching Rust' })).toBeInTheDocument();
  });

  it('says on the card that a rebuild failed, and the same button tries again', async () => {
    const user = userEvent.setup();
    const { api } = await mockWithCourse();
    const rebuild = api.rebuild.bind(api);
    api.rebuild = async () => {
      throw new Error('The rebuilt image behaves differently, so it wasn\'t accepted:\ndemo/ex-1: results changed');
    };
    renderApp({ to: 'tracks' }, api);
    const react = await screen.findByRole('listitem', { name: 'React' });
    await user.click(within(react).getByRole('button', { name: 'Rebuild' }));
    // The card says so in Codemm's words, not core's, and the page stays as it is.
    expect(await within(react).findByText("Couldn't rebuild React.")).toBeInTheDocument();
    expect(react).not.toHaveTextContent('ex-1');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(within(react).getByRole('button', { name: 'Rebuild' })).toBeEnabled();

    api.rebuild = rebuild;
    await user.click(within(react).getByRole('button', { name: 'Rebuild' }));
    await waitFor(() => expect(within(react).getByRole('status')).toHaveTextContent('Rebuilt.'));
    expect(react).not.toHaveTextContent("Couldn't rebuild");
  });

  it("says when a rebuild failed because the computer is offline, and sends damaged records to the repair banner", async () => {
    const user = userEvent.setup();
    const { api } = await mockWithCourse();
    api.rebuild = async () => {
      throw new Error(OFFLINE);
    };
    renderApp({ to: 'tracks' }, api);
    const react = await screen.findByRole('listitem', { name: 'React' });
    await user.click(within(react).getByRole('button', { name: 'Rebuild' }));
    expect(await within(react).findByText("You're offline. Connect to the internet, then try again.")).toBeInTheDocument();

    api.rebuild = async () => {
      throw new Error(`${REPAIR}\nRestore the course folder.`);
    };
    await user.click(within(react).getByRole('button', { name: 'Rebuild' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Codemm's records need a repair.");
  });

  it('says a rebuild failed on the banner when the learner has left the page by then', async () => {
    const user = userEvent.setup();
    const { api } = await mockWithCourse();
    let fail!: (error: Error) => void;
    api.rebuild = () => new Promise<void>((_, reject) => (fail = reject));
    renderApp({ to: 'tracks' }, api);
    const react = await screen.findByRole('listitem', { name: 'React' });
    await user.click(within(react).getByRole('button', { name: 'Rebuild' }));
    await user.click(within(screen.getByRole('navigation', { name: 'Main' })).getByRole('button', { name: 'Learn' }));
    await screen.findByRole('heading', { name: 'React' });
    act(() => fail(new Error('Docker stopped')));
    expect(await screen.findByRole('alert')).toHaveTextContent("That didn't work. Try again.");
  });
});
