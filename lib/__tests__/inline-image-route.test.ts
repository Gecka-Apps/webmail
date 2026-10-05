import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('next/server', () => {
  class NextResponse {
    status: number;
    headers: Headers;
    body: unknown;
    constructor(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      this.body = body;
      this.status = init?.status ?? 200;
      this.headers = new Headers(init?.headers);
    }
    static json(data: unknown, init?: { status?: number }) {
      const res = new NextResponse(data, init);
      return Object.assign(res, { json: async () => data });
    }
  }
  return { NextResponse, NextRequest: class {} };
});
vi.mock('@/lib/stalwart/credentials', () => ({ getStalwartCredentials: vi.fn() }));

const guardedFetch = vi.fn();
vi.mock('@/lib/security/url-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/security/url-guard')>();
  return {
    ...actual,
    fetchPublicUrl: (...args: unknown[]) => guardedFetch(...args),
  };
});

import { POST } from '@/app/api/inline-image/route';
import { getStalwartCredentials } from '@/lib/stalwart/credentials';
import { DisallowedUrlError } from '@/lib/security/url-guard';

const mockCreds = getStalwartCredentials as unknown as Mock;

type RouteResponse = { status: number; headers: Headers; body: unknown; json?: () => Promise<unknown> };

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 1, 2, 3, 4]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

function makeReq(body: unknown): Parameters<typeof POST>[0] {
  return { method: 'POST', headers: new Headers(), json: async () => body } as unknown as Parameters<typeof POST>[0];
}

function image(bytes: Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) {
  return new Response(bytes, { status: 200, headers: { 'content-type': 'image/png', ...headers } });
}

async function post(url: unknown): Promise<RouteResponse> {
  return (await POST(makeReq({ url }))) as unknown as RouteResponse;
}

describe('POST /api/inline-image', () => {
  beforeEach(() => {
    mockCreds.mockReset();
    guardedFetch.mockReset();
    mockCreds.mockResolvedValue({ serverUrl: 'https://mail.example.com', authHeader: 'Basic x', username: 'u' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects unauthenticated callers before touching the network', async () => {
    mockCreds.mockResolvedValue(null);
    const res = await post('https://www.example.com/logo.png');
    expect(res.status).toBe(401);
    expect(guardedFetch).not.toHaveBeenCalled();
  });

  it.each([undefined, 42, 'http://www.example.com/logo.png', 'data:image/png;base64,AAAA'])(
    'refuses %s as a URL',
    async (url) => {
      const res = await post(url);
      expect(res.status).toBe(400);
      expect(guardedFetch).not.toHaveBeenCalled();
    },
  );

  it('returns the bytes with the type sniffed from them, not the declared one', async () => {
    guardedFetch.mockResolvedValueOnce(image(PNG, { 'content-type': 'application/octet-stream' }));
    const res = await post('https://www.example.com/logo.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Array.from(res.body as Uint8Array)).toEqual(Array.from(PNG));
  });

  it('refuses anything that is not a PNG, JPEG, GIF or WebP', async () => {
    guardedFetch.mockResolvedValueOnce(image(SVG, { 'content-type': 'image/svg+xml' }));
    const res = await post('https://www.example.com/logo.svg');
    expect(res.status).toBe(415);
  });

  it('returns 400 when the guard rejects the URL', async () => {
    guardedFetch.mockRejectedValueOnce(new DisallowedUrlError('https://10.0.0.5/logo.png'));
    const res = await post('https://10.0.0.5/logo.png');
    expect(res.status).toBe(400);
    await expect(res.json?.()).resolves.toEqual({ error: 'Invalid or disallowed URL' });
  });

  it('passes redirect targets back through the guard', async () => {
    guardedFetch
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: '/img/logo.png' } }))
      .mockResolvedValueOnce(image(PNG));
    const res = await post('https://www.example.com/logo.png');
    expect(res.status).toBe(200);
    expect(guardedFetch).toHaveBeenNthCalledWith(2, 'https://www.example.com/img/logo.png', expect.anything());
  });

  it('refuses a redirect to plain http without following it', async () => {
    guardedFetch.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'http://www.example.com/logo.png' } }),
    );
    const res = await post('https://www.example.com/logo.png');
    expect(res.status).toBe(400);
    await expect(res.json?.()).resolves.toEqual({ error: 'Redirect to disallowed URL' });
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });

  it('rejects a redirect to a disallowed host', async () => {
    guardedFetch
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/' } }))
      .mockRejectedValueOnce(new DisallowedUrlError('https://169.254.169.254/'));
    const res = await post('https://www.example.com/logo.png');
    expect(res.status).toBe(400);
    await expect(res.json?.()).resolves.toEqual({ error: 'Redirect to disallowed URL' });
    expect(guardedFetch).toHaveBeenCalledTimes(2);
  });

  it('gives up after too many redirects', async () => {
    guardedFetch.mockImplementation(async () => new Response(null, { status: 302, headers: { location: '/again' } }));
    const res = await post('https://www.example.com/logo.png');
    expect(res.status).toBe(502);
    expect(guardedFetch).toHaveBeenCalledTimes(6);
  });

  it('returns 502 when the remote server fails', async () => {
    guardedFetch.mockResolvedValueOnce(new Response('gone', { status: 404 }));
    const res = await post('https://www.example.com/logo.png');
    expect(res.status).toBe(502);
  });

  it('stops reading a body past the size limit even without Content-Length', async () => {
    vi.stubEnv('INLINE_IMAGE_MAX_BYTES', '10');
    guardedFetch.mockResolvedValueOnce(image(PNG));
    const res = await post('https://www.example.com/logo.png');
    expect(res.status).toBe(413);
  });

  it('refuses early on an announced Content-Length past the limit', async () => {
    vi.stubEnv('INLINE_IMAGE_MAX_BYTES', '10');
    guardedFetch.mockResolvedValueOnce(image(PNG, { 'content-length': '4096' }));
    const res = await post('https://www.example.com/logo.png');
    expect(res.status).toBe(413);
  });
});
