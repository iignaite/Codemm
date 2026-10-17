import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Dialog } from './Dialog';
import { Menu } from './Menu';
import { Rail } from './Rail';
import { Switch } from './controls';

describe('Switch', () => {
  it('is a labelled switch that reports the next state', async () => {
    const onChange = vi.fn();
    render(<Switch label="Assist" checked={false} onChange={onChange} />);
    const sw = screen.getByRole('switch', { name: 'Assist' });
    expect(sw.getAttribute('aria-checked')).toBe('false');
    await userEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

function DialogHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open</button>
      {open && (
        <Dialog title="Let Codemm edit this activity?" onClose={() => setOpen(false)}>
          <button type="button">Keep trying</button>
          <button type="button">Let Codemm edit</button>
        </Dialog>
      )}
    </>
  );
}

describe('Dialog', () => {
  it('traps focus, closes on Escape and restores focus', async () => {
    const user = userEvent.setup();
    render(<DialogHarness />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Let Codemm edit this activity?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const [first, second] = within(dialog).getAllByRole('button');
    expect(document.activeElement).toBe(first);
    await user.tab();
    expect(document.activeElement).toBe(second);
    await user.tab();
    expect(document.activeElement).toBe(first);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(second);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe('Menu', () => {
  it('opens a keyboard menu and closes after a choice', async () => {
    const user = userEvent.setup();
    const up = vi.fn();
    render(<Menu label="Move Props" button={<span>Move</span>} items={[{ label: 'Move up', onSelect: up }, { label: 'Move down', onSelect: vi.fn(), disabled: true }]} />);
    const trigger = screen.getByRole('button', { name: 'Move Props' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await user.click(trigger);
    const items = within(screen.getByRole('menu')).getAllByRole('menuitem');
    expect(document.activeElement).toBe(items[0]);
    await user.keyboard('{Enter}');
    expect(up).toHaveBeenCalled();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    render(<Menu label="Move Props" button="Move" items={[{ label: 'Move up', onSelect: vi.fn() }]} />);
    await user.click(screen.getByRole('button', { name: 'Move Props' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('Rail', () => {
  it('is a log of notes from Codemm and the learner', () => {
    render(
      <Rail
        notes={[
          { from: 'you', text: 'Just fix it for me.' },
          { from: 'codemm', text: 'In practice mode, you write the code.', lock: true },
          { from: 'codemm', text: 'Look at what you pass to setCount.', line: 7 },
        ]}
        onAsk={vi.fn()}
      />,
    );
    const log = screen.getByRole('log');
    expect(within(log).getByText('Just fix it for me.')).toBeTruthy();
    expect(within(log).getByLabelText('Line 7')).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Codemm' })).toBeTruthy();
  });

  it('sends what the learner asks and clears the field', async () => {
    const user = userEvent.setup();
    const onAsk = vi.fn();
    render(<Rail notes={[]} onAsk={onAsk} />);
    const field = screen.getByRole('textbox', { name: 'Ask Codemm' });
    await user.type(field, 'Why?');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onAsk).toHaveBeenCalledWith('Why?');
    expect((field as HTMLInputElement).value).toBe('');
  });
});
