import { NextRequest, NextResponse } from 'next/server';
import { rejectCrossOriginRequest } from '@/lib/security/same-origin';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { DisallowedUrlError, fetchPublicUrl, type PublicFetchResponse } from '@/lib/security/url-guard';

const DEFAULT_MAX_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 10000;
const MAX_REDIRECTS = 5;

/** Response cap from INLINE_IMAGE_MAX_BYTES (bytes), read per request. */
function getMaxBytes(): number {
  const raw = process.env.INLINE_IMAGE_MAX_BYTES;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES;
}

/**
 * The raster types a signature image may have, from the leading bytes. The
 * declared Content-Type is not trusted: whatever comes back here ends up as a
 * MIME part of an outgoing message.
 */
function sniffRasterType(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif';
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

/** Reads the body up to `maxBytes`, or returns null as soon as it goes past. */
async function readCapped(response: PublicFetchResponse, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function tooLarge(maxBytes: number) {
  const limitKb = Math.round(maxBytes / 1024);
  return NextResponse.json(
    { error: `Image is larger than the ${limitKb} KB limit (INLINE_IMAGE_MAX_BYTES)` },
    { status: 413 },
  );
}

/**
 * POST /api/inline-image
 *
 * Fetches a signature image so the composer can attach it as an inline cid:
 * part: the browser cannot read the bytes of a cross-origin image without
 * CORS headers. Only logged-in users may use it, only https URLs are taken
 * (redirect targets included), every hop goes through `fetchPublicUrl`
 * (rebinding-safe, redirects checked one by one), and only PNG, JPEG, GIF or
 * WebP bytes come back.
 */
export async function POST(request: NextRequest) {
  const crossOrigin = rejectCrossOriginRequest(request);
  if (crossOrigin) return crossOrigin;
  const creds = await getStalwartCredentials(request);
  if (!creds) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
  }

  let body: { url?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }
  const { url } = body;
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) {
    return NextResponse.json({ error: 'An https URL is required' }, { status: 400 });
  }

  const maxBytes = getMaxBytes();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    let currentUrl = url;
    let response: PublicFetchResponse | undefined;

    for (let i = 0; i <= MAX_REDIRECTS; i++) {
      try {
        response = await fetchPublicUrl(currentUrl, {
          signal: controller.signal,
          headers: {
            'Accept': 'image/png, image/jpeg, image/gif, image/webp',
            'User-Agent': 'JMAP-Webmail/1.0 Inline-Image-Fetcher',
          },
        });
      } catch (error) {
        if (error instanceof DisallowedUrlError) {
          return NextResponse.json(
            { error: i === 0 ? 'Invalid or disallowed URL' : 'Redirect to disallowed URL' },
            { status: 400 },
          );
        }
        throw error;
      }

      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location) {
          return NextResponse.json({ error: 'Redirect without Location header' }, { status: 502 });
        }
        currentUrl = new URL(location, currentUrl).toString();
        // A plain-http hop would let anyone on the path swap the bytes that
        // end up in the user's outgoing message.
        if (!currentUrl.startsWith('https://')) {
          return NextResponse.json({ error: 'Redirect to disallowed URL' }, { status: 400 });
        }
        response = undefined;
        continue;
      }
      break;
    }

    if (!response) {
      return NextResponse.json({ error: 'Too many redirects' }, { status: 502 });
    }
    if (!response.ok) {
      return NextResponse.json({ error: `Remote server returned ${response.status}` }, { status: 502 });
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > maxBytes) {
      return tooLarge(maxBytes);
    }
    const bytes = await readCapped(response, maxBytes);
    if (!bytes) return tooLarge(maxBytes);

    const type = sniffRasterType(bytes);
    if (!type) {
      return NextResponse.json({ error: 'Not a PNG, JPEG, GIF or WebP image' }, { status: 415 });
    }

    return new NextResponse(bytes, {
      status: 200,
      headers: {
        'Content-Type': type,
        'Content-Length': bytes.byteLength.toString(),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      return NextResponse.json({ error: 'Request timed out' }, { status: 504 });
    }
    return NextResponse.json({ error: 'Failed to fetch image' }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}
