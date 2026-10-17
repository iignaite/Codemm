import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { Rail } from './Rail';

describe('Dialog', () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <Button onClick={() => setOpen(true)}>Open</Button>
        {open && (
          <Dialog title="Let Codemm edit this activity?" onClose={() => setOpen(false)}>
            <Button onClick={() => setOpen(false)}>Keep trying</Button>
            <Button>Let Codemm edit</Button>
          </Dialog>
        )}
      </>
    );
  }

  it('is a modal dialog that traps focus, closes on Escape and restores focus', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Let Codemm edit this activity?' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(opener.closest('[inert]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Keep trying' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Let Codemm edit' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Keep trying' })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Let Codemm edit' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.querySelector('[inert]')).toBeNull();
    expect(opener).toHaveFocus();
  });
});

describe('Rail', () => {
  it('logs the conversation and sends questions to Codemm', async () => {
    const onAsk = vi.fn();
    render(
      <Rail
        messages={[
          { from: 'you', text: 'Just fix it for me.' },
          { from: 'codemm', text: 'In practice mode, you write the code.' },
          { from: 'codemm', text: 'Look at `setCount`.' },
        ]}
        onAsk={onAsk}
      />,
    );
    const log = screen.getByRole('log');
    expect(log).toHaveTextContent('You: Just fix it for me.');
    expect(log).toHaveTextContent('In practice mode, you write the code.');
    expect(log.querySelector('code')).toHaveTextContent('setCount');
    await userEvent.type(screen.getByRole('textbox', { name: 'Ask Codemm' }), 'Why?{Enter}');
    expect(onAsk).toHaveBeenCalledWith('Why?');
    expect(screen.getByRole('textbox', { name: 'Ask Codemm' })).toHaveValue('');
  });
});
