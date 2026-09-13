import { describe, it, expect, vi, beforeEach } from 'vitest';

// /api/remote-content/[b64]: images a message references, fetched by the
// server for a logged-in user. The switch, the session check and the
// budget answer before anything is fetched; what comes back is decided by
// the bytes, never by the origin's Content-Type; and every response carries
// the headers that keep served content from running in the app's origin.

vi.mock('next/server', () => {
  class NextResponse {
    status: number;
    headers: Map<string, string>;
    private payload: unknown;
    constructor(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      this.payload = body;
      this.status = init?.status ?? 200;
      this.headers = new Map(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    }
    async json() {
      return JSON.parse(String(this.payload));
    }
    body() {
      return this.payload as Buffer | null;
    }
    static json(data: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new NextResponse(JSON.stringify(data), init);
    }
  }
  return { NextResponse };
});

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

const configValues: Record<string, unknown> = {};
vi.mock('@/lib/admin/config-manager', () => ({
  configManager: {
    ensureLoaded: vi.fn().mockResolvedValue(undefined),
    get: (key: string, def: unknown) => (key in configValues ? configValues[key] : def),
  },
}));

const getStalwartCredentials = vi.fn();
vi.mock('@/lib/stalwart/credentials', () => ({
  getStalwartCredentials: (...args: unknown[]) => getStalwartCredentials(...args),
}));

class DisallowedUrlError extends Error {}
const fetchPublicUrl = vi.fn();
vi.mock('@/lib/security/url-guard', () => ({
  DisallowedUrlError,
  fetchPublicUrl: (...args: unknown[]) => fetchPublicUrl(...args),
}));

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

function upstream(body: Buffer | string | null, init: { status?: number; headers?: Record<string, string> } = {}) {
  const payload = Buffer.isBuffer(body) ? new Uint8Array(body) : body;
  return new Response(payload, { status: init.status ?? 200, headers: init.headers ?? {} });
}

async function call(url: string, headers: Record<string, string> = {}) {
  const { encodeRemoteContentUrl } = await import('@/lib/remote-content-url');
  const { GET } = await import('@/app/api/remote-content/[b64]/route');
  const request = { headers: { get: (k: string) => headers[k.toLowerCase()] ?? null } };
  const res = (await GET(
    request as unknown as Parameters<typeof GET>[0],
    { params: Promise.resolve({ b64: encodeRemoteContentUrl(url) }) },
  )) as unknown as { status: number; headers: Map<string, string>; body: () => Buffer | null };
  return res;
}

describe('GET /api/remote-content/[b64]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(configValues)) delete configValues[key];
    configValues.remoteContentProxyEnabled = true;
    getStalwartCredentials.mockResolvedValue({ username: `u-${Math.random()}`, serverUrl: 'https://mail.example', authHeader: 'Basic x' });
    // A fresh Response per call: a body stream can only be read once.
    fetchPublicUrl.mockImplementation(async () => upstream(PNG, { headers: { 'content-type': 'image/png', etag: '"abc"' } }));
  });

  it('answers 404 while the proxy is off, before any credential lookup', async () => {
    configValues.remoteContentProxyEnabled = false;
    const res = await call('https://cdn.example/a.png');
    expect(res.status).toBe(404);
    expect(getStalwartCredentials).not.toHaveBeenCalled();
    expect(fetchPublicUrl).not.toHaveBeenCalled();
  });

  it('answers 401 without a session and fetches nothing', async () => {
    getStalwartCredentials.mockResolvedValue(null);
    const res = await call('https://cdn.example/a.png');
    expect(res.status).toBe(401);
    expect(fetchPublicUrl).not.toHaveBeenCalled();
  });

  it('serves a raster image with the protective headers', async () => {
    const res = await call('https://cdn.example/a.png');
    expect(res.status).toBe(200);
    expect(res.body()).toEqual(PNG);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("default-src 'none'; sandbox");
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    expect(res.headers.get('cache-control')).toMatch(/^private, max-age=\d+$/);
    expect(res.headers.get('etag')).toBe('"abc"');
    // The origin never learns about the user: fixed UA, no cookies forwarded.
    const [, init] = fetchPublicUrl.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers['User-Agent']).toMatch(/^Bulwark-Webmail/);
    expect(Object.keys(init.headers).map((k) => k.toLowerCase())).not.toContain('cookie');
  });

  it('trusts the bytes, not the declared type', async () => {
    fetchPublicUrl.mockResolvedValue(upstream(PNG, { headers: { 'content-type': 'text/html' } }));
    expect((await call('https://cdn.example/a')).headers.get('content-type')).toBe('image/png');

    fetchPublicUrl.mockResolvedValue(upstream('<html><script>1</script>', { headers: { 'content-type': 'image/png' } }));
    const res = await call('https://cdn.example/b.png');
    expect(res.status).toBe(200);
    expect(res.body()).toEqual(GIF);
    expect(res.headers.get('content-type')).toBe('image/gif');
  });

  it('refuses SVG', async () => {
    fetchPublicUrl.mockResolvedValue(upstream('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>', { headers: { 'content-type': 'image/svg+xml' } }));
    const res = await call('https://cdn.example/a.svg');
    expect(res.body()).toEqual(GIF);
    expect(res.headers.get('content-type')).toBe('image/gif');
  });

  it('answers a transparent pixel when the origin fails or the URL is blocked', async () => {
    fetchPublicUrl.mockResolvedValue(upstream('nope', { status: 500 }));
    const failed = await call('https://cdn.example/a.png');
    expect(failed.status).toBe(200);
    expect(failed.body()).toEqual(GIF);
    expect(failed.headers.get('cache-control')).toBe('private, max-age=300');

    fetchPublicUrl.mockRejectedValue(new DisallowedUrlError('blocked'));
    const blocked = await call('http://10.0.0.1/a.png');
    expect(blocked.body()).toEqual(GIF);
    expect(blocked.headers.get('cache-control')).toBe('private, max-age=3600');
  });

  it('follows redirects through the guard and stops at the cap', async () => {
    fetchPublicUrl
      .mockResolvedValueOnce(upstream('', { status: 302, headers: { location: '/moved.png' } }))
      .mockResolvedValueOnce(upstream(PNG, { headers: { 'content-type': 'image/png' } }));
    const res = await call('https://cdn.example/a.png');
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(fetchPublicUrl.mock.calls[1]![0]).toBe('https://cdn.example/moved.png');

    fetchPublicUrl.mockReset();
    fetchPublicUrl.mockResolvedValue(upstream('', { status: 302, headers: { location: 'https://cdn.example/loop.png' } }));
    const loop = await call('https://cdn.example/loop.png');
    expect(loop.body()).toEqual(GIF);
    expect(fetchPublicUrl).toHaveBeenCalledTimes(6);
  });

  it('forwards conditional headers and relays a 304', async () => {
    fetchPublicUrl.mockResolvedValue(upstream(null, { status: 304, headers: { etag: '"abc"' } }));
    const res = await call('https://cdn.example/a.png', { 'if-none-match': '"abc"' });
    expect(res.status).toBe(304);
    const [, init] = fetchPublicUrl.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(init.headers['if-none-match']).toBe('"abc"');
  });

  it('rejects an oversized body', async () => {
    fetchPublicUrl.mockResolvedValue(upstream(PNG, { headers: { 'content-type': 'image/png', 'content-length': String(11 * 1024 * 1024) } }));
    const res = await call('https://cdn.example/big.png');
    expect(res.body()).toEqual(GIF);
    expect(res.headers.get('cache-control')).toBe('private, max-age=3600');
  });

  it('rejects an undecodable resource', async () => {
    const { GET } = await import('@/app/api/remote-content/[b64]/route');
    const request = { headers: { get: () => null } };
    const res = (await GET(request as unknown as Parameters<typeof GET>[0], { params: Promise.resolve({ b64: '!!' }) })) as unknown as { status: number };
    expect(res.status).toBe(400);
    expect(fetchPublicUrl).not.toHaveBeenCalled();
  });

  it('caps the per-user budget', async () => {
    const { RATE_LIMIT } = await import('@/lib/remote-content');
    getStalwartCredentials.mockResolvedValue({ username: 'budget', serverUrl: 'https://mail.example', authHeader: 'Basic x' });
    for (let i = 0; i < RATE_LIMIT.max; i++) {
      expect((await call(`https://cdn.example/${i}.png`)).status).toBe(200);
    }
    const res = await call('https://cdn.example/over.png');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('60');
  });
});
