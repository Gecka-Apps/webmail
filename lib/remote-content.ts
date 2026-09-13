/**
 * Server side of the remote-content proxy: fetches an image a message body
 * references, on the user's behalf, and prepares a response the browser can
 * render but never execute. Used by /api/remote-content/[b64].
 *
 * Only raster images come out, checked against their magic bytes; whatever
 * the origin's Content-Type says, the bytes decide. SVG is refused: it is a
 * document, not a picture, and sanitizing it server-side would need a DOM
 * the production image does not ship. The route never serves CSS (the
 * iframe drops <link> and its CSP allows no @import), fonts or media.
 */

import { DisallowedUrlError, fetchPublicUrl, type PublicFetchResponse } from '@/lib/security/url-guard';

/** Largest body the proxy relays. */
export const MAX_BYTES = 10 * 1024 * 1024;
/** Whole fetch, redirects included. */
export const FETCH_TIMEOUT_MS = 15_000;
export const MAX_REDIRECTS = 5;
/** Fixed identity: the origin learns nothing about the user's browser. */
export const USER_AGENT = 'Bulwark-Webmail/1.0 remote-content';

export type FetchOutcome =
  | { kind: 'ok'; status: 200; contentType: string; body: Uint8Array; headers: Record<string, string> }
  | { kind: 'not-modified'; headers: Record<string, string> }
  | { kind: 'error'; reason: 'blocked' | 'unreachable' | 'status' | 'type' | 'too-large' | 'redirect' };

/** Request headers the browser sent that are worth forwarding for caching. */
export const CONDITIONAL_HEADERS = ['if-none-match', 'if-modified-since'] as const;
/** Response headers relayed from the origin so the browser can cache. */
export const CACHE_HEADERS = ['etag', 'last-modified', 'cache-control', 'expires'] as const;

function sniffRaster(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if (b.length >= 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return 'image/x-icon';
  // ISO BMFF with an AVIF brand: "ftyp" at offset 4, brand at offset 8.
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!);
    if (brand === 'avif' || brand === 'avis') return 'image/avif';
  }
  return null;
}

/**
 * Decide what the browser gets for an origin response body: the sniffed
 * raster type and the bytes as they are, or null when the body is not an
 * image the proxy serves.
 */
export function classifyImage(bytes: Uint8Array): { contentType: string; body: Uint8Array } | null {
  const raster = sniffRaster(bytes);
  return raster ? { contentType: raster, body: bytes } : null;
}

async function readCapped(response: PublicFetchResponse): Promise<Uint8Array | null> {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > MAX_BYTES) return null;
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function pickHeaders(response: PublicFetchResponse, names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const v = response.headers.get(name);
    if (v) out[name] = v;
  }
  return out;
}

/**
 * Fetch `url` the way a mail client should: every hop through the egress
 * guard, no cookies, no Referer, fixed User-Agent, a hard size cap, and the
 * browser's conditional headers forwarded so a 304 from the origin becomes a
 * 304 for the browser.
 */
export async function fetchRemoteImage(url: string, conditional: Record<string, string>): Promise<FetchOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let current = url;
    let response: PublicFetchResponse | undefined;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      try {
        response = await fetchPublicUrl(current, {
          signal: controller.signal,
          headers: { Accept: 'image/*,*/*;q=0.5', 'User-Agent': USER_AGENT, ...conditional },
        });
      } catch (err) {
        if (err instanceof DisallowedUrlError) return { kind: 'error', reason: 'blocked' };
        return { kind: 'error', reason: 'unreachable' };
      }
      if (response.status === 304) break;
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return { kind: 'error', reason: 'redirect' };
        try {
          current = new URL(location, current).toString();
        } catch {
          return { kind: 'error', reason: 'redirect' };
        }
        continue;
      }
      break;
    }
    if (!response) return { kind: 'error', reason: 'redirect' };
    if (response.status === 304) return { kind: 'not-modified', headers: pickHeaders(response, CACHE_HEADERS) };
    if (!response.ok) return { kind: 'error', reason: 'status' };

    const bytes = await readCapped(response);
    if (!bytes) return { kind: 'error', reason: 'too-large' };
    const image = classifyImage(bytes);
    if (!image) return { kind: 'error', reason: 'type' };
    return {
      kind: 'ok',
      status: 200,
      contentType: image.contentType,
      body: image.body,
      headers: pickHeaders(response, CACHE_HEADERS),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Headers every response of the route carries, whatever it contains.
 * Served content is a raster image for an <img> inside the render iframe
 * and nothing else: even if a browser were talked into treating the bytes
 * as a document, nothing may run in the app's origin, and no other site may
 * embed the route.
 */
export function protectiveHeaders(contentType: string): Record<string, string> {
  return {
    'Content-Type': contentType,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
  };
}

/**
 * Per-user request budget, in memory. A newsletter loads a few dozen images
 * at once, so the window is sized for bursts of reading, not for scripted
 * use of the route as a general fetcher.
 */
export const RATE_LIMIT = { max: 600, windowMs: 60_000 };

const budgets = new Map<string, { count: number; resetAt: number }>();
setInterval(() => {
  const now = Date.now();
  for (const [key, b] of budgets) if (b.resetAt <= now) budgets.delete(key);
}, 60_000).unref();

/** Whether `key` (a username) may make one more request in the current window. */
export function consumeBudget(key: string, now = Date.now()): boolean {
  const b = budgets.get(key);
  if (!b || b.resetAt <= now) {
    budgets.set(key, { count: 1, resetAt: now + RATE_LIMIT.windowMs });
    return true;
  }
  if (b.count >= RATE_LIMIT.max) return false;
  b.count++;
  return true;
}

/** Cache-Control the browser gets: private, the route needs a session. */
export function cacheControlFor(origin: Record<string, string>): string {
  const theirs = origin['cache-control'];
  if (theirs && /no-store/i.test(theirs)) return 'no-store';
  const maxAge = theirs && /max-age=(\d+)/i.exec(theirs)?.[1];
  // Between an hour and a day: long enough to spare the origin on re-reads,
  // short enough that a replaced image shows up.
  const seconds = Math.min(86_400, Math.max(3_600, maxAge ? Number(maxAge) : 86_400));
  return `private, max-age=${seconds}`;
}
