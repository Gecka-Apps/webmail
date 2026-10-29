import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useKeyboardShortcuts } from '../use-keyboard-shortcuts';

// MO-05: with focus inside the shortcuts help or the Create folder dialog,
// Delete, #, e, j, k and ArrowDown acted on the message behind the dialog.

function handlers() {
  return {
    onDelete: vi.fn(),
    onArchive: vi.fn(),
    onNextEmail: vi.fn(),
    onPreviousEmail: vi.fn(),
    onCompose: vi.fn(),
    onSelectAll: vi.fn(),
    onGoToMailbox: vi.fn(),
    onShowHelp: vi.fn(),
    onCloseEmail: vi.fn(),
  };
}
type Handlers = ReturnType<typeof handlers>;

function press(target: EventTarget, key: string, code: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function mount(attrs: Record<string, string>) {
  const layer = document.createElement('div');
  for (const [k, v] of Object.entries(attrs)) layer.setAttribute(k, v);
  const button = document.createElement('button');
  layer.appendChild(button);
  document.body.appendChild(layer);
  return button;
}

function messageList() {
  const list = document.createElement('div');
  list.id = 'message-list';
  list.tabIndex = -1;
  document.body.appendChild(list);
  return list;
}

const KEYS: [string, string, KeyboardEventInit, keyof Handlers][] = [
  ['Delete', 'Delete', {}, 'onDelete'],
  ['#', 'Digit3', { shiftKey: true }, 'onDelete'],
  ['e', 'KeyE', {}, 'onArchive'],
  ['j', 'KeyJ', {}, 'onNextEmail'],
  ['k', 'KeyK', {}, 'onPreviousEmail'],
];

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useKeyboardShortcuts: open dialogs and menus own the keyboard', () => {
  it.each(KEYS)('ignores %s with focus in a modal dialog', (key, code, init, handler) => {
    const h = handlers();
    renderHook(() => useKeyboardShortcuts({ emails: [], selectedEmailId: 'e1', handlers: h }));
    const button = mount({ role: 'dialog', 'aria-modal': 'true' });
    press(button, key, code, init);
    expect(h[handler]).not.toHaveBeenCalled();
  });

  it('ignores ArrowDown in the list while a modal dialog is open', () => {
    const h = handlers();
    renderHook(() => useKeyboardShortcuts({ emails: [], selectedEmailId: 'e1', handlers: h }));
    mount({ role: 'dialog', 'aria-modal': 'true' });
    press(messageList(), 'ArrowDown', 'ArrowDown');
    expect(h.onNextEmail).not.toHaveBeenCalled();
  });

  it('ignores keys while a menu is open', () => {
    const h = handlers();
    renderHook(() => useKeyboardShortcuts({ emails: [], selectedEmailId: 'e1', handlers: h }));
    const item = mount({ role: 'menu' });
    press(item, 'Delete', 'Delete');
    press(document, 'e', 'KeyE');
    expect(h.onDelete).not.toHaveBeenCalled();
    expect(h.onArchive).not.toHaveBeenCalled();
  });

  it('ignores keys while a listbox popup is expanded', () => {
    const h = handlers();
    renderHook(() => useKeyboardShortcuts({ emails: [], selectedEmailId: 'e1', handlers: h }));
    mount({ 'aria-haspopup': 'listbox', 'aria-expanded': 'true' });
    press(document, 'j', 'KeyJ');
    expect(h.onNextEmail).not.toHaveBeenCalled();
  });

  it('does not count a hidden menu as open', () => {
    const h = handlers();
    renderHook(() => useKeyboardShortcuts({ emails: [], selectedEmailId: 'e1', handlers: h }));
    const wrapper = document.createElement('div');
    wrapper.setAttribute('hidden', '');
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    wrapper.appendChild(menu);
    document.body.appendChild(wrapper);
    press(document, 'e', 'KeyE');
    expect(h.onArchive).toHaveBeenCalledTimes(1);
  });

  it('ignores an event someone already handled', () => {
    const h = handlers();
    renderHook(() => useKeyboardShortcuts({ emails: [], selectedEmailId: 'e1', handlers: h }));
    const el = document.createElement('div');
    document.body.appendChild(el);
    el.addEventListener('keydown', (e) => e.preventDefault());
    press(el, 'Delete', 'Delete');
    expect(h.onDelete).not.toHaveBeenCalled();
  });

  it('still acts when nothing is open', () => {
    const h = handlers();
    renderHook(() => useKeyboardShortcuts({ emails: [], selectedEmailId: 'e1', handlers: h }));
    press(document, 'Delete', 'Delete');
    press(document, 'e', 'KeyE');
    expect(h.onDelete).toHaveBeenCalledTimes(1);
    expect(h.onArchive).toHaveBeenCalledTimes(1);
  });
});

describe('useKeyboardShortcuts: arrows only in the message list', () => {
  it('leaves ArrowDown alone outside the list', () => {
    const h = handlers();
    renderHook(() => useKeyboardShortcuts({ emails: [], selectedEmailId: 'e1', handlers: h }));
    const reader = document.createElement('div');
    reader.tabIndex = 0;
    document.body.appendChild(reader);
    const event = press(reader, 'ArrowDown', 'ArrowDown');
    expect(h.onNextEmail).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('moves with ArrowDown from inside the list', () => {
    const h = handlers();
    renderHook(() => useKeyboardShortcuts({ emails: [], selectedEmailId: 'e1', handlers: h }));
    const list = messageList();
    const checkbox = document.createElement('span');
    list.appendChild(checkbox);
    press(checkbox, 'ArrowDown', 'ArrowDown');
    expect(h.onNextEmail).toHaveBeenCalledTimes(1);
  });

  it('keeps j working page-wide', () => {
    const h = handlers();
    renderHook(() => useKeyboardShortcuts({ emails: [], selectedEmailId: 'e1', handlers: h }));
    press(document, 'j', 'KeyJ');
    expect(h.onNextEmail).toHaveBeenCalledTimes(1);
  });
});
