import { parseHtmlSafely } from '@/lib/email-sanitization';
import { generateUUID } from '@/lib/utils';
import { SIGNATURE_BLOCK_MARKER, SIGNATURE_RANGE_MARKER } from '@/components/email/signature-block';

/**
 * Class token that marks a signature image as "embed at send time". The
 * signature keeps a plain https URL (a few bytes, well under Stalwart's
 * 2047-byte Identity cap) and the composer turns it into a cid: part when the
 * message leaves. A class rather than a data-* attribute: `class` is on the
 * signature allowlist of every Bulwark client, so the marker survives an
 * edit made from any of them.
 */
export const SIGNATURE_EMBED_CLASS = 'bulwark-embed';

const EMBEDDABLE_SRC = /^https:\/\//i;

export interface EmbeddedImagePart {
  blobId: string;
  name: string;
  type: string;
  size: number;
  disposition: 'inline';
  cid: string;
}

/** Fetches the image behind `url` and uploads it as a JMAP blob. */
export type SignatureImageResolver = (
  url: string,
) => Promise<{ blobId: string; type: string; size: number }>;

export interface EmbedResult {
  html: string;
  attachments: EmbeddedImagePart[];
  /** URLs that could not be embedded and went out as remote links. */
  failed: string[];
}

function embeddableImages(root: ParentNode): HTMLImageElement[] {
  return Array.from(root.querySelectorAll('img')).filter((img) =>
    EMBEDDABLE_SRC.test(img.getAttribute('src') || ''),
  );
}

/**
 * How the signature's images stand: `images` counts the https images that
 * can be embedded, `embedded` is true when every one of them carries the
 * marker.
 */
export function signatureImageEmbedding(html: string): { images: number; embedded: boolean } {
  if (!html.trim()) return { images: 0, embedded: false };
  const images = embeddableImages(parseHtmlSafely(html).body);
  return {
    images: images.length,
    embedded: images.length > 0 && images.every((img) => img.classList.contains(SIGNATURE_EMBED_CLASS)),
  };
}

/** Adds or removes the marker on every https image of the signature. */
export function setSignatureImageEmbedding(html: string, enabled: boolean): string {
  const doc = parseHtmlSafely(html);
  const images = embeddableImages(doc.body);
  if (images.length === 0) return html;
  for (const img of images) {
    img.classList.toggle(SIGNATURE_EMBED_CLASS, enabled);
    if (!img.getAttribute('class')) img.removeAttribute('class');
  }
  return doc.body.innerHTML;
}

const QUOTE_SELECTOR = '[data-quoted-html], blockquote';

function outsideQuotes<T extends Element>(nodes: Iterable<T>): T[] {
  return Array.from(nodes).filter((node) => !node.closest(QUOTE_SELECTOR));
}

/**
 * Images that belong to the signature inside a composed body: those in the
 * locked signature atom, plus those between the range markers once the atom
 * has been unlocked into regular content. Anything else is left alone, and so
 * is anything inside a quote even when it carries signature markers: a marked
 * image quoted from someone else's mail is never fetched on their behalf.
 */
function signatureImagesInBody(doc: Document): HTMLImageElement[] {
  const found = new Set<HTMLImageElement>(
    outsideQuotes(doc.querySelectorAll<HTMLImageElement>(`[${SIGNATURE_BLOCK_MARKER}] img`)),
  );
  const [start] = outsideQuotes(doc.querySelectorAll(
    `[${SIGNATURE_RANGE_MARKER}="separator"], [${SIGNATURE_RANGE_MARKER}="start"]`,
  ));
  const end = start && outsideQuotes(doc.querySelectorAll(`[${SIGNATURE_RANGE_MARKER}="end"]`))
    .find((marker) => start.compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_FOLLOWING);
  if (start && end) {
    const range = doc.createRange();
    range.setStartAfter(start);
    range.setEndBefore(end);
    outsideQuotes(doc.querySelectorAll('img')).forEach((img) => {
      if (range.intersectsNode(img)) found.add(img);
    });
  }
  return Array.from(found);
}

function nameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : 'image';
  } catch {
    return 'image';
  }
}

/**
 * Replaces the marked https images of a signature with cid: references and
 * returns the inline parts to attach. `scope: 'signature'` treats the whole
 * fragment as signature (the HTML appended at send time); `scope: 'body'`
 * only looks inside the signature region of a composed body.
 *
 * An image that cannot be fetched keeps its https URL, so the recipient still
 * gets it as remote content. The marker is stripped from every signature
 * image either way: it means nothing outside this client.
 */
export async function embedSignatureImages(
  html: string,
  resolve: SignatureImageResolver,
  { scope }: { scope: 'body' | 'signature' },
): Promise<EmbedResult> {
  if (!html.includes(SIGNATURE_EMBED_CLASS)) return { html, attachments: [], failed: [] };

  const doc = parseHtmlSafely(html);
  const candidates = scope === 'signature'
    ? Array.from(doc.body.querySelectorAll('img'))
    : signatureImagesInBody(doc);
  const marked = candidates.filter((img) => img.classList.contains(SIGNATURE_EMBED_CLASS));
  if (marked.length === 0) return { html, attachments: [], failed: [] };

  const urls = Array.from(new Set(
    marked.map((img) => img.getAttribute('src') || '').filter((src) => EMBEDDABLE_SRC.test(src)),
  ));
  const settled = await Promise.allSettled(urls.map((url) => resolve(url)));

  const parts = new Map<string, EmbeddedImagePart>();
  const failed: string[] = [];
  settled.forEach((outcome, i) => {
    const url = urls[i];
    if (outcome.status === 'rejected') {
      failed.push(url);
      return;
    }
    parts.set(url, {
      ...outcome.value,
      name: nameFromUrl(url),
      disposition: 'inline',
      cid: `${generateUUID()}@webmail`,
    });
  });

  for (const img of marked) {
    const part = parts.get(img.getAttribute('src') || '');
    if (part) img.setAttribute('src', `cid:${part.cid}`);
    img.classList.remove(SIGNATURE_EMBED_CLASS);
    if (!img.getAttribute('class')) img.removeAttribute('class');
  }

  return { html: doc.body.innerHTML, attachments: Array.from(parts.values()), failed };
}
