import { describe, it, expect, vi } from 'vitest';
import {
  SIGNATURE_EMBED_CLASS,
  embedSignatureImages,
  setSignatureImageEmbedding,
  signatureImageEmbedding,
} from '@/lib/signature-inline-images';
import { buildEmbeddedSignatureHtml } from '@/components/email/compose-format';

const LOGO = 'https://www.example.com/img/logo.png';
const ICON = 'https://cdn.example.com/icon.gif';

function resolverFor(ok: Record<string, number>) {
  return vi.fn(async (url: string) => {
    if (!(url in ok)) throw new Error(`unreachable ${url}`);
    return { blobId: `blob-${ok[url]}`, type: 'image/png', size: 100 + ok[url] };
  });
}

function srcs(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return Array.from(doc.querySelectorAll('img')).map((img) => img.getAttribute('src') || '');
}

describe('signatureImageEmbedding', () => {
  it('counts only https images', () => {
    const html = `<img src="${LOGO}"><img src="data:image/png;base64,AAAA">`;
    expect(signatureImageEmbedding(html)).toEqual({ images: 1, embedded: false });
  });

  it('is embedded only when every https image carries the marker', () => {
    const one = `<img src="${LOGO}" class="${SIGNATURE_EMBED_CLASS}"><img src="${ICON}">`;
    const both = `<img src="${LOGO}" class="${SIGNATURE_EMBED_CLASS}"><img src="${ICON}" class="round ${SIGNATURE_EMBED_CLASS}">`;
    expect(signatureImageEmbedding(one).embedded).toBe(false);
    expect(signatureImageEmbedding(both).embedded).toBe(true);
  });

  it('reports nothing for an empty signature', () => {
    expect(signatureImageEmbedding('')).toEqual({ images: 0, embedded: false });
  });
});

describe('setSignatureImageEmbedding', () => {
  it('marks every https image and leaves other classes alone', () => {
    const out = setSignatureImageEmbedding(`<p>Jane</p><img src="${LOGO}" class="round"><img src="${ICON}">`, true);
    const doc = new DOMParser().parseFromString(out, 'text/html');
    const [logo, icon] = Array.from(doc.querySelectorAll('img'));
    expect(logo.className).toBe(`round ${SIGNATURE_EMBED_CLASS}`);
    expect(icon.className).toBe(SIGNATURE_EMBED_CLASS);
  });

  it('removes the marker without leaving an empty class attribute', () => {
    const out = setSignatureImageEmbedding(`<img src="${LOGO}" class="${SIGNATURE_EMBED_CLASS}">`, false);
    expect(out).toBe(`<img src="${LOGO}">`);
  });

  it('returns a signature without https images unchanged', () => {
    const html = '<b>Jane</b><br/>ACME';
    expect(setSignatureImageEmbedding(html, true)).toBe(html);
  });
});

describe('embedSignatureImages, signature scope', () => {
  it('rewrites marked images to cid: parts, one per distinct URL', async () => {
    const html = `<img src="${LOGO}" class="${SIGNATURE_EMBED_CLASS}"><img src="${LOGO}" class="${SIGNATURE_EMBED_CLASS}">`;
    const resolve = resolverFor({ [LOGO]: 1 });
    const out = await embedSignatureImages(html, resolve, { scope: 'signature' });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(out.failed).toEqual([]);
    expect(out.attachments).toHaveLength(1);
    const [part] = out.attachments;
    expect(part).toMatchObject({ blobId: 'blob-1', type: 'image/png', size: 101, name: 'logo.png', disposition: 'inline' });
    expect(srcs(out.html)).toEqual([`cid:${part.cid}`, `cid:${part.cid}`]);
    expect(out.html).not.toContain(SIGNATURE_EMBED_CLASS);
  });

  it('keeps the link of an image that cannot be fetched and reports it', async () => {
    const html = `<img src="${LOGO}" class="${SIGNATURE_EMBED_CLASS}"><img src="${ICON}" class="${SIGNATURE_EMBED_CLASS}">`;
    const out = await embedSignatureImages(html, resolverFor({ [LOGO]: 1 }), { scope: 'signature' });

    expect(out.failed).toEqual([ICON]);
    expect(out.attachments).toHaveLength(1);
    expect(srcs(out.html)).toEqual([`cid:${out.attachments[0].cid}`, ICON]);
    expect(out.html).not.toContain(SIGNATURE_EMBED_CLASS);
  });

  it('leaves unmarked images and HTML without the marker untouched', async () => {
    const html = `<p>Jane</p><img src="${LOGO}">`;
    const resolve = resolverFor({});
    const out = await embedSignatureImages(html, resolve, { scope: 'signature' });
    expect(out).toEqual({ html, attachments: [], failed: [] });
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('embedSignatureImages, body scope', () => {
  const marked = `<img src="${LOGO}" class="${SIGNATURE_EMBED_CLASS}">`;
  const quoted = `<blockquote><img src="${ICON}" class="${SIGNATURE_EMBED_CLASS}"></blockquote>`;

  it('embeds the images of the locked signature atom only', async () => {
    const signature = buildEmbeddedSignatureHtml({ htmlSignature: marked }, { embed: true, separator: true });
    const body = `<p>Hello</p>${signature}${quoted}`;
    const resolve = resolverFor({ [LOGO]: 1, [ICON]: 2 });
    const out = await embedSignatureImages(body, resolve, { scope: 'body' });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(LOGO);
    expect(srcs(out.html)).toEqual([`cid:${out.attachments[0].cid}`, ICON]);
  });

  it('finds the images of an unlocked signature between the range markers', async () => {
    const body =
      `<p>Hello</p><p data-signature-block="start"></p><p>Jane ${marked}</p>` +
      `<p data-signature-block="end"></p>${quoted}`;
    const out = await embedSignatureImages(body, resolverFor({ [LOGO]: 1, [ICON]: 2 }), { scope: 'body' });

    expect(out.attachments).toHaveLength(1);
    expect(srcs(out.html)).toEqual([`cid:${out.attachments[0].cid}`, ICON]);
  });

  it('ignores a signature carried inside a quote', async () => {
    const theirs = buildEmbeddedSignatureHtml({ htmlSignature: marked }, { embed: true, separator: true });
    const body = `<p>Hello</p><div data-quoted-html="">${theirs}</div><blockquote>${theirs}</blockquote>`;
    const resolve = resolverFor({ [LOGO]: 1 });
    const out = await embedSignatureImages(body, resolve, { scope: 'body' });

    expect(resolve).not.toHaveBeenCalled();
    expect(out.attachments).toEqual([]);
  });

  it('still finds an unlocked own signature placed after a quote with markers', async () => {
    const theirs = buildEmbeddedSignatureHtml({ htmlSignature: marked }, { embed: true, separator: true });
    const own =
      `<p data-signature-block="separator">-- </p>` +
      `<p>Jane <img src="${ICON}" class="${SIGNATURE_EMBED_CLASS}"></p><p data-signature-block="end"></p>`;
    const body = `<div data-quoted-html="">${theirs}</div>${own}`;
    const resolve = resolverFor({ [LOGO]: 1, [ICON]: 2 });
    const out = await embedSignatureImages(body, resolve, { scope: 'body' });

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(ICON);
    expect(out.attachments).toHaveLength(1);
  });

  it('ignores marked images outside any signature', async () => {
    const body = `<p>Hello ${marked}</p>${quoted}`;
    const resolve = resolverFor({ [LOGO]: 1, [ICON]: 2 });
    const out = await embedSignatureImages(body, resolve, { scope: 'body' });

    expect(resolve).not.toHaveBeenCalled();
    expect(out.html).toBe(body);
  });
});
