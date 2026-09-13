/**
 * URL encoding shared by the remote-content proxy route and the body
 * sanitizer that rewrites external resources to it. Kept free of DOM and
 * Node-only imports so both sides can use it.
 *
 * The original URL travels as URL-safe base64 without padding, in the path:
 * `${basePath}/api/remote-content/<encoded>`. Query strings are avoided so
 * the encoded value survives every proxy and log untouched.
 */

export const REMOTE_CONTENT_ROUTE = '/api/remote-content/';

/** Longest encoded URL the route accepts (8 KB of URL, well past every browser limit). */
export const MAX_ENCODED_URL_LENGTH = 11_000;

const ENCODED_RE = /^[A-Za-z0-9_-]+$/;

function toBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(base64, 'base64'));
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** URL-safe base64 of the UTF-8 bytes of `url`, no padding. */
export function encodeRemoteContentUrl(url: string): string {
  return toBase64(new TextEncoder().encode(url))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Inverse of {@link encodeRemoteContentUrl}. Returns null for anything that
 * is not well-formed base64url or does not decode to an absolute http(s) URL.
 */
export function decodeRemoteContentUrl(encoded: string): string | null {
  if (!encoded || encoded.length > MAX_ENCODED_URL_LENGTH || !ENCODED_RE.test(encoded)) return null;
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(fromBase64(base64));
  } catch {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(decoded);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return decoded;
}

/**
 * Path a message body references for an external resource. Protocol-relative
 * URLs are pinned to https before encoding: the route only fetches absolute
 * URLs, and an email has no scheme of its own to inherit.
 */
export function remoteContentProxyPath(url: string, basePath = ''): string {
  const absolute = url.startsWith('//') ? `https:${url}` : url;
  return `${basePath.replace(/\/+$/, '')}${REMOTE_CONTENT_ROUTE}${encodeRemoteContentUrl(absolute)}`;
}
