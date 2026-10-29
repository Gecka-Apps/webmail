import { render, waitFor } from '@testing-library/react';
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
