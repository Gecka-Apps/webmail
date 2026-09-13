import { NextRequest, NextResponse } from 'next/server';
import { configManager } from '@/lib/admin/config-manager';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { decodeRemoteContentUrl } from '@/lib/remote-content-url';
import {
  CONDITIONAL_HEADERS,
  cacheControlFor,
  consumeBudget,
  fetchRemoteImage,
  protectiveHeaders,
} from '@/lib/remote-content';
import { logger } from '@/lib/logger';

/**
 * GET /api/remote-content/[b64]
 *
 * Serves an image a message body references, fetched by the server on the
 * user's behalf, so the sender only ever sees this host. The body sanitizer
 * rewrites external images to this path when `REMOTE_CONTENT_PROXY` is on
 * and the user's policy allows external content; the render iframe's CSP
 * then only opens img-src to 'self'.
 *
 * The render iframe is a srcdoc with allow-same-origin, so its <img>
 * requests are same-origin and carry the session cookie: only logged-in
 * users get anything, without a token in the URL. Off, the route answers
 * 404 as if it did not exist.
 */

const TRANSPARENT_GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** What the <img> gets when the image cannot be served: layout intact, nothing leaked. */
function placeholder(status: number, cacheSeconds: number): NextResponse {
  return new NextResponse(TRANSPARENT_GIF, {
    status,
    headers: {
      ...protectiveHeaders('image/gif'),
      'Content-Length': String(TRANSPARENT_GIF.byteLength),
      'Cache-Control': `private, max-age=${cacheSeconds}`,
    },
  });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ b64: string }> }) {
  await configManager.ensureLoaded();
  if (!configManager.get<boolean>('remoteContentProxyEnabled', false)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const creds = await getStalwartCredentials(request);
  if (!creds) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  const { b64 } = await params;
  const url = decodeRemoteContentUrl(b64);
  if (!url) {
    return NextResponse.json({ error: 'Invalid resource' }, { status: 400 });
  }

  if (!consumeBudget(creds.username)) {
    return NextResponse.json({ error: 'Too many requests' }, { status: 429, headers: { 'Retry-After': '60' } });
  }

  const conditional: Record<string, string> = {};
  for (const name of CONDITIONAL_HEADERS) {
    const v = request.headers.get(name);
    if (v) conditional[name] = v;
  }

  const outcome = await fetchRemoteImage(url, conditional);

  if (outcome.kind === 'not-modified') {
    return new NextResponse(null, {
      status: 304,
      headers: { ...outcome.headers, 'Cache-Control': cacheControlFor(outcome.headers) },
    });
  }

  if (outcome.kind === 'error') {
    logger.debug('remote-content: not served', { reason: outcome.reason, host: new URL(url).host });
    // A short negative cache keeps a dead tracker from being retried on
    // every scroll; a blocked or oversized resource is not coming back.
    return placeholder(200, outcome.reason === 'unreachable' || outcome.reason === 'status' ? 300 : 3600);
  }

  const { etag, 'last-modified': lastModified } = outcome.headers;
  return new NextResponse(Buffer.from(outcome.body), {
    status: 200,
    headers: {
      ...protectiveHeaders(outcome.contentType),
      'Content-Length': String(outcome.body.byteLength),
      'Cache-Control': cacheControlFor(outcome.headers),
      ...(etag ? { ETag: etag } : {}),
      ...(lastModified ? { 'Last-Modified': lastModified } : {}),
    },
  });
}
