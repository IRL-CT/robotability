/**
 * Tests for the SODA fetch wrapper and its SoQL helpers.
 *
 * All network access is mocked. No test reaches the real network.
 * PUBLIC_SODA_TOKEN is unset in this environment, so the tokenless
 * path is the default path under test.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  MemoryCache,
  SODAError,
  SodaClient,
  buildQuery,
  createDefaultCache,
  withinBox,
  withinCircle,
  wktPoint,
} from './client.ts';

/** Read a header from a mocked fetch call. The client passes a plain object. */
function headerAt(
  calls: ReadonlyArray<ReadonlyArray<unknown>>,
  callIndex: number,
  name: string,
): string | undefined {
  const call = calls[callIndex];
  const init = call?.[1] as { headers?: Record<string, string> } | undefined;
  return init?.headers?.[name];
}

function jsonResponse(body: string, status = 200, etag: string | null = null): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (etag !== null) {
    headers['etag'] = etag;
  }
  return new Response(body, { status, headers });
}

describe('buildQuery', () => {
  it('maps every SoQL key exactly', () => {
    const params = buildQuery({
      where: "dws_conditions = 'Good Condition'",
      select: 'rampid, dws_conditions',
      limit: 50,
      group: 'dws_conditions',
      order: 'rampid DESC',
    });
    expect(params.get('$where')).toBe("dws_conditions = 'Good Condition'");
    expect(params.get('$select')).toBe('rampid, dws_conditions');
    expect(params.get('$limit')).toBe('50');
    expect(params.get('$group')).toBe('dws_conditions');
    expect(params.get('$order')).toBe('rampid DESC');
    expect([...params.keys()].sort()).toEqual([
      '$group',
      '$limit',
      '$order',
      '$select',
      '$where',
    ]);
  });

  it('omits keys that are not provided', () => {
    const params = buildQuery({ limit: 10 });
    expect(params.get('$limit')).toBe('10');
    expect(params.has('$where')).toBe(false);
    expect(params.has('$select')).toBe(false);
    expect(params.has('$group')).toBe(false);
    expect(params.has('$order')).toBe(false);
  });
});

describe('WKT and geospatial SoQL coordinate order', () => {
  it('wktPoint puts LONGITUDE first', () => {
    // WKT order is (lon lat). Do not swap these arguments.
    expect(wktPoint(-73.99, 40.74)).toBe('POINT (-73.99 40.74)');
  });

  it('withinCircle emits LATITUDE first per Socrata docs', () => {
    // Socrata geospatial functions take (lat, lon). WKT takes (lon, lat).
    // This exact-match assertion fails if anyone swaps the arguments.
    expect(withinCircle('the_geom', -73.99, 40.74, 15.24)).toBe(
      'within_circle(the_geom, 40.74, -73.99, 15.24)',
    );
  });

  it('withinBox emits lat/lon pairs in Socrata order', () => {
    // within_box(col, minLat, minLon, maxLat, maxLon). Lat comes first.
    expect(withinBox('the_geom', -73.99, 40.7, -73.98, 40.75)).toBe(
      'within_box(the_geom, 40.7, -73.99, 40.75, -73.98)',
    );
  });

  it('coordinate-order trap: a swapped withinCircle must not match', () => {
    // If a future edit emits (lon, lat) here, this exact string check breaks.
    const soql = withinCircle('location', -74.1, 40.9, 7.62);
    expect(soql).toBe('within_circle(location, 40.9, -74.1, 7.62)');
    expect(soql).not.toBe('within_circle(location, -74.1, 40.9, 7.62)');
  });
});

describe('SodaClient URLs and app token', () => {
  it('builds the resource URL for json and geojson formats', () => {
    const client = new SodaClient({ token: undefined });
    expect(client.buildUrl('ufzp-rrqu')).toBe(
      'https://data.cityofnewyork.us/resource/ufzp-rrqu.json',
    );
    expect(client.buildUrl('ufzp-rrqu', undefined, 'geojson')).toBe(
      'https://data.cityofnewyork.us/resource/ufzp-rrqu.geojson',
    );
  });

  it('adds no $$app_token when no token exists', () => {
    // PUBLIC_SODA_TOKEN is unset in this test environment.
    const client = new SodaClient();
    const url = new URL(client.buildUrl('h9gi-nx95', buildQuery({ limit: 1 })));
    expect(url.searchParams.has('$$app_token')).toBe(false);
  });

  it('appends $$app_token when a token is provided', () => {
    const client = new SodaClient({ token: 'test-token-123' });
    const url = new URL(client.buildUrl('h9gi-nx95'));
    expect(url.searchParams.get('$$app_token')).toBe('test-token-123');
  });

  it('appends SoQL params to the request URL', () => {
    const client = new SodaClient({ token: undefined });
    const url = new URL(
      client.buildUrl('5mad-ntua', buildQuery({ where: 'postvz_sl > 25', limit: 5 })),
    );
    expect(url.searchParams.get('$where')).toBe('postvz_sl > 25');
    expect(url.searchParams.get('$limit')).toBe('5');
  });
});

describe('SodaClient ETag caching', () => {
  it('sends If-None-Match on the second request and reuses the body on 304', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse('[{"rampid": 1}]', 200, 'etag-abc'))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));

    const client = new SodaClient({ fetchImpl, cache: new MemoryCache(), token: undefined });
    const first = await client.query('ufzp-rrqu');
    const second = await client.query('ufzp-rrqu');

    // Both responses carry the same parsed body.
    expect(first).toEqual([{ rampid: 1 }]);
    expect(second).toEqual([{ rampid: 1 }]);

    // The network was hit exactly twice. A 304 is still a fetch call.
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // The first request carried no conditional header.
    expect(headerAt(fetchImpl.mock.calls, 0, 'If-None-Match')).toBeUndefined();
    // The second request carried the cached ETag.
    expect(headerAt(fetchImpl.mock.calls, 1, 'If-None-Match')).toBe('etag-abc');
  });

  it('stores a fresh ETag when the server returns a new body', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse('[{"v": 1}]', 200, 'etag-1'))
      .mockResolvedValueOnce(jsonResponse('[{"v": 2}]', 200, 'etag-2'));

    const cache = new MemoryCache();
    const client = new SodaClient({ fetchImpl, cache, token: undefined });
    await client.query('ufzp-rrqu');
    await client.query('ufzp-rrqu');

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(headerAt(fetchImpl.mock.calls, 1, 'If-None-Match')).toBe('etag-1');
    expect(cache.get('https://data.cityofnewyork.us/resource/ufzp-rrqu.json')?.etag).toBe(
      'etag-2',
    );
  });

  it('MemoryCache round-trips body and etag', () => {
    const cache = new MemoryCache();
    expect(cache.get('k')).toBeUndefined();
    cache.put('k', '[1,2]', 'e1');
    expect(cache.get('k')).toEqual({ body: '[1,2]', etag: 'e1' });
  });

  it('createDefaultCache falls back to memory when the Cache API is absent', () => {
    // The node test environment has no `caches` global.
    expect(typeof (globalThis as { caches?: unknown }).caches).toBe('undefined');
    const cache = createDefaultCache();
    expect(cache).toBeInstanceOf(MemoryCache);
  });

  it('uses the Cache API when it exists', async () => {
    const backing = new Map<string, Response>();
    const fakeCaches = {
      open: vi.fn(async () => ({
        match: async (req: Request) => backing.get(req.url),
        put: async (req: Request, res: Response) => {
          backing.set(req.url, res);
        },
      })),
    };
    vi.stubGlobal('caches', fakeCaches);
    try {
      const cache = createDefaultCache();
      expect(cache).not.toBeInstanceOf(MemoryCache);
      cache.put('https://example.test/x.json', '[3]', 'etag-x');
      // Allow the async put to settle before the read.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(await Promise.resolve(cache.get('https://example.test/x.json'))).toEqual({
        body: '[3]',
        etag: 'etag-x',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('SodaClient errors', () => {
  it('throws SODAError with dataset id and status on HTTP failure', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    const client = new SodaClient({ fetchImpl, cache: new MemoryCache(), token: undefined });
    const error = await client.query('h9gi-nx95').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SODAError);
    expect((error as SODAError).dataset).toBe('h9gi-nx95');
    expect((error as SODAError).status).toBe(500);
    expect((error as SODAError).name).toBe('SODAError');
  });

  it('throws SODAError with status 429 on rate limiting', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('slow down', { status: 429 }));
    const client = new SodaClient({ fetchImpl, cache: new MemoryCache(), token: undefined });
    const error = await client.query('52n9-sdep').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SODAError);
    expect((error as SODAError).status).toBe(429);
    expect((error as SODAError).dataset).toBe('52n9-sdep');
  });

  it('throws SODAError when the network rejects', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const client = new SodaClient({ fetchImpl, cache: new MemoryCache(), token: undefined });
    const error = await client.query('kdig-pewd').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SODAError);
    expect((error as SODAError).dataset).toBe('kdig-pewd');
    expect((error as SODAError).status).toBeUndefined();
  });
});

describe('SodaClient with a stubbed global fetch', () => {
  it('defaults to globalThis.fetch when no fetch impl is injected', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse('[{"ok": true}]'));
    vi.stubGlobal('fetch', fetchImpl);
    try {
      const client = new SodaClient({ cache: new MemoryCache(), token: undefined });
      const rows = await client.query('mzxg-pwib');
      expect(rows).toEqual([{ ok: true }]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
