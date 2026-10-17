import { screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Draft } from '../../../shared/api';
import { renderWith } from '../../test/render';
import { CourseEditor } from './CourseEditor';

const draft = (needsSetup = true): Draft => ({
  title: 'React basics',
  track: 'React',
  needsSetup,
  topics: ['JavaScript basics', 'JSX', 'Components', 'Props'].map((title, i) => ({ id: `t${i}`, title })),
});

const titles = () => within(screen.getByRole('list')).getAllByRole('listitem').map((li) => li.querySelector('.topic-title')?.textContent);

describe('CourseEditor', () => {
  it('renames a topic', async () => {
    const { user } = renderWith(<CourseEditor draft={draft()} />);
    await user.click(screen.getByRole('button', { name: 'Rename Props' }));
    const field = screen.getByRole('textbox', { name: 'Topic name' });
    await user.clear(field);
    await user.type(field, 'Props and children');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(titles()).toContain('Props and children');
  });

  it('removes and adds topics', async () => {
    const { user } = renderWith(<CourseEditor draft={draft()} />);
    await user.click(screen.getByRole('button', { name: 'Remove JSX' }));
    expect(titles()).not.toContain('JSX');
    await user.click(screen.getByRole('button', { name: 'Add a topic' }));
    const field = screen.getByRole('textbox', { name: 'Topic name' });
    expect(document.activeElement).toBe(field);
    await user.type(field, 'Hooks{Enter}');
    expect(titles().at(-1)).toBe('Hooks');
  });

  it('reorders without dragging', async () => {
    const { user } = renderWith(<CourseEditor draft={draft()} />);
    await user.click(screen.getByRole('button', { name: 'Move Components' }));
    await user.click(screen.getByRole('menuitem', { name: 'Move up' }));
    expect(titles()).toEqual(['JavaScript basics', 'Components', 'JSX', 'Props']);
  });

  it('asks Codemm for changes', async () => {
    const { user, api } = renderWith(<CourseEditor draft={draft()} />);
    const revise = vi.spyOn(api, 'reviseDraft');
    await user.type(screen.getByRole('textbox', { name: 'Ask Codemm for changes' }), 'Add testing{Enter}');
    expect(revise).toHaveBeenCalledWith(expect.objectContaining({ title: 'React basics' }), 'Add testing');
    expect(await screen.findByText('Add testing')).toBeTruthy();
  });

  it('asks before setting anything up', async () => {
    const { user, api, go, openCourse } = renderWith(<CourseEditor draft={draft()} />);
    const approve = vi.spyOn(api, 'approveDraft');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(screen.getByRole('dialog', { name: 'Set up React on this computer?' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(approve).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await user.click(screen.getByRole('button', { name: 'Set up' }));
    expect(approve).toHaveBeenCalled();
    const course = await approve.mock.results[0].value;
    expect(openCourse).toHaveBeenCalledWith(course.id);
    expect(go).toHaveBeenCalledWith({ to: 'topic', topicId: course.topics[0].id });
  });

  it('approves straight away when nothing needs setting up', async () => {
    const { user, go } = renderWith(<CourseEditor draft={draft(false)} />);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await vi.waitFor(() => expect(go).toHaveBeenCalled());
  });
});
