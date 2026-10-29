import { describe, expect, it } from 'vitest';
import { applyMailTextSize, mailTextFactor, plainBodyFontSize, scaledTextSize } from '@/lib/mail-reading';

describe('mailTextFactor', () => {
  it('follows the app text size when the mail size is 0', () => {
    expect(mailTextFactor(0, 'medium')).toBe(1);
    expect(mailTextFactor(0, 'xx-large')).toBe(1.5);
  });
  it('uses the mail size when one is set', () => {
    expect(mailTextFactor(1.25, 'huge')).toBe(1.25);
  });
});

describe('plainBodyFontSize', () => {
  it('stays at the old size by default', () => {
    expect(plainBodyFontSize(14, 0, 'medium', 0)).toBe('0.875rem');
  });
  it('relies on rem for the app size and multiplies only what the mail size adds', () => {
    // rem already carries 1.25, so 1.5 needs another 1.2.
    expect(plainBodyFontSize(14, 1.5, 'x-large', 0)).toBe('calc(0.875rem * 1.2)');
    expect(plainBodyFontSize(14, 0, 'x-large', 0)).toBe('0.875rem');
  });
  it('puts a floor under it', () => {
    expect(plainBodyFontSize(13, 0, 'medium', 16)).toBe('max(0.8125rem, 16px)');
  });
});

describe('scaledTextSize', () => {
  it('scales font and px line height together', () => {
    expect(scaledTextSize(10, 15, { factor: 1.5, minPx: 0 })).toEqual({ font: 15, lineHeight: 22.5 });
  });
  it('raises text below the minimum, with its line height', () => {
    expect(scaledTextSize(9, 12, { factor: 1, minPx: 18 })).toEqual({ font: 18, lineHeight: 24 });
    expect(scaledTextSize(20, null, { factor: 1, minPx: 18 })).toEqual({ font: 20, lineHeight: null });
  });
  it('applies the minimum after scaling', () => {
    expect(scaledTextSize(10, null, { factor: 2, minPx: 16 }).font).toBe(20);
    expect(scaledTextSize(6, null, { factor: 2, minPx: 16 }).font).toBe(16);
  });
});

function mailDoc(html: string): Document {
  // A frame's document, so it has a window for getComputedStyle.
  const frame = document.createElement('iframe');
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.body.innerHTML = html;
  return doc;
}

describe('applyMailTextSize', () => {
  it('leaves a mail alone at 100 % with no minimum', () => {
    const doc = mailDoc('<p style="font-size: 10px">tiny</p>');
    expect(applyMailTextSize(doc, { factor: 1, minPx: 0 })).toBe(false);
    expect(doc.querySelector('p')!.style.fontSize).toBe('10px');
  });

  it('enlarges small text to the minimum and pins the rest', () => {
    const doc = mailDoc('<div style="font-size: 20px"><span style="font-size: 9px">fine print</span></div>');
    doc.body.style.fontSize = '14px';
    expect(applyMailTextSize(doc, { factor: 1, minPx: 12 })).toBe(true);
    expect(doc.querySelector('span')!.style.getPropertyValue('font-size')).toBe('12px');
    expect(doc.querySelector('span')!.style.getPropertyPriority('font-size')).toBe('important');
    expect(doc.querySelector('div')!.style.getPropertyValue('font-size')).toBe('20px');
  });

  it('scales every text size and runs once per document', () => {
    const doc = mailDoc('<p style="font-size: 16px; line-height: 20px">a</p>');
    doc.body.style.fontSize = '14px';
    applyMailTextSize(doc, { factor: 1.5, minPx: 0 });
    const p = doc.querySelector('p')!;
    expect(p.style.getPropertyValue('font-size')).toBe('24px');
    expect(p.style.getPropertyValue('line-height')).toBe('30px');
    expect(doc.body.style.getPropertyValue('font-size')).toBe('21px');
    expect(applyMailTextSize(doc, { factor: 1.5, minPx: 0 })).toBe(false);
    expect(p.style.getPropertyValue('font-size')).toBe('24px');
  });
});
