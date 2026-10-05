import { apiFetch } from '@/lib/browser-navigation';
import { IS_LITE } from '@/lib/lite';
import type { IJMAPClient } from '@/lib/jmap/client-interface';
import type { SignatureImageResolver } from '@/lib/signature-inline-images';

// Signature images are the same few logos on every send; the bytes are kept
// for the page's lifetime so a busy session does not refetch them each time.
const MAX_CACHED_IMAGES = 32;
const cache = new Map<string, Promise<Blob>>();

/** False in the static Lite build, which has no /api/inline-image route. */
export const SIGNATURE_IMAGE_EMBEDDING = !IS_LITE;

/**
 * The bytes behind a signature image URL, fetched server-side through
 * /api/inline-image (the browser cannot read a cross-origin image without
 * CORS headers). A failed fetch is not cached. In the Lite build every image
 * stays a remote link.
 */
export function fetchSignatureImage(url: string): Promise<Blob> {
  if (!SIGNATURE_IMAGE_EMBEDDING) return Promise.reject(new Error('No image fetcher in the Lite build'));
  const cached = cache.get(url);
  if (cached) return cached;

  const pending = apiFetch('/api/inline-image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  }).then(async (res) => {
    if (!res.ok) throw new Error(`Signature image ${url} answered ${res.status}`);
    return res.blob();
  });
  pending.catch(() => cache.delete(url));

  if (cache.size >= MAX_CACHED_IMAGES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(url, pending);
  return pending;
}

/**
 * Resolver for embedSignatureImages: fetch the image, then upload it as a
 * blob of the account the message is sent from.
 */
export function signatureImageResolver(client: IJMAPClient): SignatureImageResolver {
  return async (url) => {
    const blob = await fetchSignatureImage(url);
    const file = new File([blob], 'signature-image', { type: blob.type });
    return client.uploadBlob(file);
  };
}
