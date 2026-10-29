/**
 * The global focus outline in app/accessibility.css.
 *
 * jsdom does not apply stylesheets or match :focus-visible, so the test takes
 * the selectors of the outline rule, drops the focus pseudo-class and checks
 * which elements the rest of each selector matches.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const css = readFileSync(path.join(process.cwd(), 'app', 'accessibility.css'), 'utf8');

/** Selectors of the first top-level rule whose body contains `declaration`. */
function selectorsOf(declaration: string): string[] {
  const at = css.indexOf(declaration);
  expect(at).toBeGreaterThan(-1);
  const open = css.lastIndexOf('{', at);
  const prevClose = css.lastIndexOf('}', open);
  const prelude = css.slice(prevClose + 1, open).replace(/\/\*[\s\S]*?\*\//g, '');
  // Split on top-level commas only (the :not() lists have commas too).
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of prelude) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}

const outlined = selectorsOf('outline: var(--focus-ring-width) solid var(--focus-ring-color)')
  .find((s) => s.startsWith(':focus-visible'))!
  .replace(/^:focus-visible/, '*');

function el(html: string): Element {
  const host = document.createElement('div');
  host.innerHTML = html;
  return host.firstElementChild!;
}

describe('global focus outline', () => {
  it.each([
    ['a menu item', '<div role="menuitem" tabindex="-1">Reply</div>'],
    ['a listbox option', '<div role="option" tabindex="-1">Inbox</div>'],
    ['a grid cell', '<div role="gridcell" tabindex="-1">12</div>'],
    ['a tab', '<button role="tab" tabindex="-1">All</button>'],
    ['a row', '<div role="row" tabindex="-1"></div>'],
    ['a tree item', '<div role="treeitem" tabindex="-1">Work</div>'],
    ['a button in a toolbar', '<button tabindex="-1">Bold</button>'],
    ['a link', '<a href="#x" tabindex="-1">Open</a>'],
    ['a plain button', '<button>Send</button>'],
  ])('draws on %s, even with tabindex -1', (_name, html) => {
    expect(el(html).matches(outlined)).toBe(true);
  });

  it.each([
    ['a message list container', '<div id="message-list" tabindex="-1"></div>'],
    ['a dialog', '<div role="dialog" tabindex="-1"></div>'],
    ['main', '<main tabindex="-1"></main>'],
    ['a heading focused after navigation', '<h1 tabindex="-1">Inbox</h1>'],
    ['a menu container', '<div role="menu" tabindex="-1"></div>'],
  ])('skips %s that only takes focus from script', (_name, html) => {
    expect(el(html).matches(outlined)).toBe(false);
  });

  it('takes its colour from the ring token, which themes keep at 3:1', () => {
    expect(css).toMatch(/--focus-ring-color:\s*var\(--color-ring\)/);
  });
});
