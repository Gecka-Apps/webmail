/**
 * How the reading settings on Settings > Accessibility reach a message body.
 *
 * HTML mail renders in a sandboxed iframe that the app's stylesheet doesn't
 * reach, so the text size, spacing, colours and motion settings have to be
 * carried into that document: as CSS appended after the mail's own (so it
 * wins the cascade) and, for text size, as a pass over the computed styles
 * after the document parsed. Plain-text bodies sit in the app document and
 * only need their own font size.
 */

import { FONT_SIZE_SCALE, type FontSize } from '@/lib/accessibility-settings';

/** Size of body text in a message, in CSS px at 100 %: what mail used to be fixed at. */
export const MAIL_BASE_FONT_PX = 14;

/**
 * The factor message text is drawn at: the mail text size, or the app's text
 * size when that is set to follow it (0).
 */
export function mailTextFactor(mailTextScale: number, fontSize: FontSize): number {
  if (mailTextScale > 0) return mailTextScale;
  return FONT_SIZE_SCALE[fontSize] ?? 1;
}

/**
 * CSS font size for a plain-text body in the app document. Its rem already
 * carries the app's text size, so only the part the mail size adds on top of
 * that is multiplied in. The minimum, when set, is a floor in px.
 */
export function plainBodyFontSize(basePx: number, mailTextScale: number, fontSize: FontSize, minPx: number): string {
  const appFactor = FONT_SIZE_SCALE[fontSize] ?? 1;
  const extra = Math.round((mailTextFactor(mailTextScale, fontSize) / appFactor) * 10000) / 10000;
  const rem = Math.round((basePx / 16) * 10000) / 10000;
  const size = extra === 1 ? `${rem}rem` : `calc(${rem}rem * ${extra})`;
  return minPx > 0 ? `max(${size}, ${minPx}px)` : size;
}

/**
 * One element's text size after scaling by `factor` and raising it to the
 * minimum. A line height in px grows by the same ratio, so the enlarged text
 * doesn't overlap the next line; "normal" (null) needs nothing.
 */
export function scaledTextSize(
  fontPx: number,
  lineHeightPx: number | null,
  { factor, minPx }: { factor: number; minPx: number },
): { font: number; lineHeight: number | null } {
  if (!(fontPx > 0)) return { font: fontPx, lineHeight: lineHeightPx };
  const font = Math.max(fontPx * factor, minPx || 0);
  const ratio = font / fontPx;
  return { font, lineHeight: lineHeightPx === null ? null : lineHeightPx * ratio };
}

/** Elements that draw no text of their own. */
const NO_TEXT = new Set(['IMG', 'BR', 'HR', 'WBR', 'PICTURE', 'SOURCE', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'STYLE', 'SCRIPT', 'TEMPLATE']);

export interface MailTextSizeOptions {
  /** Multiplier on every text size in the mail. */
  factor: number;
  /** Smallest text size, in CSS px; 0 = no minimum. */
  minPx: number;
  /** Turn justified text into start-aligned text. */
  unjustify?: boolean;
  /** Leave sizes alone (the override stylesheet sets them); only unjustify. */
  sizesFromCss?: boolean;
}

const DONE_ATTR = 'data-bulwark-text-size';

/**
 * Scales the text of a rendered mail document and raises text below the
 * minimum, by reading every element's computed font size and writing the new
 * one back inline. Reads all elements first and writes after, so the pass
 * costs one style recalculation. Once one element changes, every element is
 * pinned to its own px size: a child sized in em would otherwise grow a second
 * time with its parent. Runs once per document; returns whether it changed
 * anything.
 *
 * Text size works on the text rather than zooming the whole mail, so a
 * fixed-width newsletter keeps its width and its text wraps inside it instead
 * of pushing the layout off the side of the pane.
 */
export function applyMailTextSize(doc: Document, options: MailTextSizeOptions): boolean {
  const body = doc.body;
  const view = doc.defaultView;
  if (!body || !view || body.hasAttribute(DONE_ATTR)) return false;
  const factor = options.sizesFromCss ? 1 : options.factor;
  const minPx = options.sizesFromCss ? 0 : options.minPx;
  if (factor === 1 && !(minPx > 0) && !options.unjustify) return false;
  body.setAttribute(DONE_ATTR, '');

  const elements: HTMLElement[] = [body];
  body.querySelectorAll<HTMLElement>('*').forEach((el) => {
    if (NO_TEXT.has(el.tagName) || el.closest('svg')) return;
    elements.push(el);
  });

  const writes: Array<() => void> = [];
  const sizes: Array<{ el: HTMLElement; font: number; lineHeight: number | null; changed: boolean }> = [];
  let anySizeChanged = false;
  for (const el of elements) {
    const style = view.getComputedStyle(el);
    if (options.unjustify && style.textAlign === 'justify') {
      writes.push(() => el.style.setProperty('text-align', 'start', 'important'));
    }
    if (factor === 1 && !(minPx > 0)) continue;
    const fontPx = parseFloat(style.fontSize);
    if (!(fontPx > 0)) continue;
    const lineHeightPx = style.lineHeight.endsWith('px') ? parseFloat(style.lineHeight) : null;
    const next = scaledTextSize(fontPx, lineHeightPx, { factor, minPx });
    const changed = Math.abs(next.font - fontPx) > 0.01;
    if (changed) anySizeChanged = true;
    sizes.push({ el, font: next.font, lineHeight: next.lineHeight, changed });
  }
  if (anySizeChanged) {
    for (const { el, font, lineHeight } of sizes) {
      writes.push(() => {
        el.style.setProperty('font-size', `${Math.round(font * 100) / 100}px`, 'important');
        if (lineHeight !== null) el.style.setProperty('line-height', `${Math.round(lineHeight * 100) / 100}px`, 'important');
      });
    }
  }
  for (const write of writes) write();
  return writes.length > 0;
}
