import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import React from 'react';
import type { Editor } from '@tiptap/core';

import { RichTextEditor } from '../rich-text-editor';

type Props = Partial<React.ComponentProps<typeof RichTextEditor>>;

async function setup(props: Props = {}) {
  let editor: Editor | null = null;
  const view = render(
    <RichTextEditor
      content="<p>Hello</p>"
      onChange={() => {}}
      onEditorReady={(ed) => { editor = ed as unknown as Editor; }}
      {...props}
    />
  );
  await waitFor(() => expect(editor).not.toBeNull());
  const rerender = (next: Props) => view.rerender(
    <RichTextEditor content="<p>Hello</p>" onChange={() => {}} {...props} {...next} />
  );
  return { ...view, editor: editor as unknown as Editor, rerender };
}

describe('RichTextEditor editing area (SR-07)', () => {
  it('is a named multi-line textbox', async () => {
    const { editor } = await setup({ ariaLabel: 'Message' });
    const dom = editor.view.dom;
    expect(dom).toHaveAttribute('role', 'textbox');
    expect(dom).toHaveAttribute('aria-multiline', 'true');
    expect(dom).toHaveAttribute('aria-label', 'Message');
    expect(dom).not.toHaveAttribute('aria-invalid');
  });

  it('marks the body invalid and points at the error once validation fails', async () => {
    const { editor, rerender } = await setup({ ariaLabel: 'Message', ariaDescribedBy: 'body-error' });
    expect(editor.view.dom).not.toHaveAttribute('aria-describedby');

    rerender({ ariaInvalid: true });
    await waitFor(() => expect(editor.view.dom).toHaveAttribute('aria-invalid', 'true'));
    expect(editor.view.dom).toHaveAttribute('aria-describedby', 'body-error');
    // Still the editor's own class and name.
    expect(editor.view.dom).toHaveClass('tiptap');
    expect(editor.view.dom).toHaveAttribute('aria-label', 'Message');

    rerender({ ariaInvalid: false });
    await waitFor(() => expect(editor.view.dom).not.toHaveAttribute('aria-invalid'));
  });
});

describe('RichTextEditor formatting toolbar (SR-08)', () => {
  const toolbar = () => screen.getByRole('toolbar', { name: 'formatting' });
  const item = (name: string) => toolbar().querySelector<HTMLButtonElement>(`[data-toolbar-item="${name}"]`)!;
  const tabStops = () => Array.from(toolbar().querySelectorAll<HTMLElement>('[data-toolbar-item]')).filter((el) => el.tabIndex === 0);

  it('is one Tab stop and moves with the arrows, Home and End', async () => {
    await setup();
    expect(tabStops()).toEqual([item('font-size')]);

    item('font-size').focus();
    fireEvent.keyDown(item('font-size'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(item('bold'));
    expect(tabStops()).toEqual([item('bold')]);
    fireEvent.keyDown(item('bold'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(item('font-size'));
    // End skips undo and redo while they are disabled.
    fireEvent.keyDown(item('font-size'), { key: 'End' });
    expect(document.activeElement).toBe(item('clear-formatting'));
    fireEvent.keyDown(item('clear-formatting'), { key: 'Home' });
    expect(document.activeElement).toBe(item('font-size'));
  });

  it('says which toggles are on', async () => {
    // As in the composer, a change re-renders the editor through its parent.
    let editor: Editor | null = null;
    function Host() {
      const [html, setHtml] = React.useState('<p>Hello</p>');
      return <RichTextEditor content={html} onChange={setHtml} onEditorReady={(ed) => { editor = ed as unknown as Editor; }} />;
    }
    render(<Host />);
    await waitFor(() => expect(editor).not.toBeNull());
    expect(item('bold')).toHaveAttribute('aria-pressed', 'false');
    act(() => { editor!.chain().selectAll().toggleBold().run(); });
    await waitFor(() => expect(item('bold')).toHaveAttribute('aria-pressed', 'true'));
    expect(item('italic')).toHaveAttribute('aria-pressed', 'false');
  });

  it('opens the font size menu by keyboard, moves inside it and gives the focus back on Escape', async () => {
    await setup();
    const button = item('font-size');
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    expect(button).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('menu', { name: 'font_size' });
    const entries = within(menu).getAllByRole('menuitemradio');
    await waitFor(() => expect(document.activeElement).toBe(entries[0]));
    fireEvent.keyDown(entries[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(entries[1]);

    fireEvent.keyDown(entries[1], { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'font_size' })).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('names the colour swatches and moves through them as a grid', async () => {
    await setup();
    fireEvent.click(item('text-color'));
    const menu = screen.getByRole('menu', { name: 'text_color' });
    const swatches = within(menu).getAllByRole('menuitemradio');
    expect(swatches[0]).toHaveAccessibleName('colors.black');
    await waitFor(() => expect(document.activeElement).toBe(swatches[0]));
    fireEvent.keyDown(swatches[0], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(swatches[8]);
    fireEvent.keyDown(swatches[8], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(swatches[9]);
  });

  it('jumps from the text to the toolbar with Alt+F10', async () => {
    const { editor } = await setup();
    editor.commands.focus();
    fireEvent.keyDown(editor.view.dom, { key: 'F10', altKey: true });
    expect(document.activeElement).toBe(item('font-size'));
  });
});

describe('RichTextEditor default text style (CO-16)', () => {
  it('shows the text in the chosen font and size', async () => {
    const { editor } = await setup({ defaultTextStyle: { fontFamily: 'monospace', fontSize: '20px' } });
    expect(editor.view.dom.style.fontFamily).toBe('monospace');
    expect(editor.view.dom.style.fontSize).toBe('20px');
  });
});
