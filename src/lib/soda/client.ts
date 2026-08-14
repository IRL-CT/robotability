/**
 * SODA 2.1 client for the NYC OpenData proxy features.
 *
 * Fetches `https://data.cityofnewyork.us/resource/<id>.<format>` with
 * SoQL parameters, an optional app token, and ETag revalidation.
 *
 * COORDINATE ORDER WARNING. READ THIS BEFORE YOU EDIT ANYTHING BELOW.
 * Two opposite conventions live in this file:
 * 1. WKT writes LONGITUDE first: `POINT (lon lat)`.
 * 2. Socrata geospatial FUNCTIONS take LATITUDE first:
 *    `within_circle(col, lat, lon, radius)` and
 *    `within_box(col, minLat, minLon, maxLat, maxLon)`.
 * The helpers in this file accept (lon, lat) arguments in that order
 * and do the swap for you. Do not call these helpers with swapped
 * arguments. The tests assert the exact emitted strings.
 */

/** Named error for every failed SODA request. Carries the dataset id
 * and the HTTP status so callers can react to 429 rate limiting. */
export class SODAError extends Error {
  readonly dataset: string;
  readonly status: number | undefined;

  constructor(dataset: string, status: number | undefined, message: string) {
    super(message);
    this.name = 'SODAError';
    this.dataset = dataset;
    this.status = status;
  }
}

/** One cached response body plus its ETag. */
export interface CacheEntry {
  body: string;
  etag: string | null;
}

/** Injectable cache. Implementations may be sync or async. */
export interface ResponseCache {
  get(key: string): CacheEntry | undefined | Promise<CacheEntry | undefined>;
  put(key: string, body: string, etag: string | null): void | Promise<void>;
}

/** In-memory cache fallback. Used when the Cache API is absent (SSR, tests). */
export class MemoryCache implements ResponseCache {
  private readonly map = new Map<string, CacheEntry>();

  get(key: string): CacheEntry | undefined {
    return this.map.get(key);
  }

  put(key: string, body: string, etag: string | null): void {
    this.map.set(key, { body, etag });
  }
}

/** Cache API wrapper for browsers. Keys are full request URLs. */
class BrowserCache implements ResponseCache {
  private readonly storeName: string;

  constructor(storeName = 'robotability-soda') {
    this.storeName = storeName;
  }

  private async open(): Promise<Cache> {
    return caches.open(this.storeName);
  }

  async get(key: string): Promise<CacheEntry | undefined> {
    const store = await this.open();
    const response = await store.match(new Request(key));
    if (!response) {
      return undefined;
    }
    const body = await response.text();
    return { body, etag: response.headers.get('etag') };
  }

  async put(key: string, body: string, etag: string | null): Promise<void> {
    const store = await this.open();
    const headers = new Headers();
    if (etag !== null) {
      headers.set('etag', etag);
    }
    await store.put(new Request(key), new Response(body, { status: 200, headers }));
  }
}

/** Pick the best cache for this environment. Browsers get the Cache
 * API. SSR and tests get the in-memory fallback. */
export function createDefaultCache(): ResponseCache {
  if (typeof caches !== 'undefined') {
    return new BrowserCache();
  }
  return new MemoryCache();
}

/** SoQL clause inputs. Every field is optional. */
export interface SoqlInput {
  where?: string;
  select?: string;
  limit?: number;
  group?: string;
  order?: string;
}

/** Build SoQL URL parameters. Only provided keys appear in the output. */
export function buildQuery(input: SoqlInput): URLSearchParams {
  const params = new URLSearchParams();
  if (input.where !== undefined) {
    params.set('$where', input.where);
  }
  if (input.select !== undefined) {
    params.set('$select', input.select);
  }
  if (input.limit !== undefined) {
    params.set('$limit', String(input.limit));
  }
  if (input.group !== undefined) {
    params.set('$group', input.group);
  }
  if (input.order !== undefined) {
    params.set('$order', input.order);
  }
  return params;
}

/** Build a WKT point. WKT order is LONGITUDE FIRST: `POINT (lon lat)`. */
export function wktPoint(lon: number, lat: number): string {
  return `POINT (${lon} ${lat})`;
}

/**
 * Build a within_circle SoQL predicate.
 * Arguments enter as (col, lon, lat, radius). Socrata wants LATITUDE
 * FIRST, so this function emits `within_circle(col, lat, lon, radius)`.
 */
export function withinCircle(
  col: string,
  lon: number,
  lat: number,
  radiusMeters: number,
): string {
  return `within_circle(${col}, ${lat}, ${lon}, ${radiusMeters})`;
}

/**
 * Build a within_box SoQL predicate.
 * Arguments enter as (col, minLon, minLat, maxLon, maxLat). Socrata
 * wants LATITUDE FIRST in each pair, so this function emits
 * `within_box(col, minLat, minLon, maxLat, maxLon)`.
 */
export function withinBox(
  col: string,
  minLon: number,
  minLat: number,
  maxLon: number,
  maxLat: number,
): string {
  return `within_box(${col}, ${minLat}, ${minLon}, ${maxLat}, ${maxLon})`;
}

/** Injectable fetch. Matches the global fetch signature. */
export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export interface SodaClientOptions {
  /** Defaults to globalThis.fetch. */
  fetchImpl?: FetchImpl;
  /** Defaults to createDefaultCache(). */
  cache?: ResponseCache;
  /** App token. Defaults to import.meta.env.PUBLIC_SODA_TOKEN. The
   * client works without a token. The quota is lower, that is all. */
  token?: string;
  /** Portal base URL. Defaults to the NYC OpenData portal. */
  baseUrl?: string;
}

/** Read the public token from the build environment. Returns undefined
 * when the variable is absent or empty. */
function envToken(): string | undefined {
  const value = import.meta.env.PUBLIC_SODA_TOKEN;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** One row of a SODA JSON response. Values arrive as strings. */
export type SodaRow = Record<string, string | number | null>;

/** Fetch wrapper for one Socrata portal. */
export class SodaClient {
  private readonly fetchImpl: FetchImpl;
  private readonly cache: ResponseCache;
  private readonly token: string | undefined;
  private readonly baseUrl: string;

  constructor(options: SodaClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.cache = options.cache ?? createDefaultCache();
    this.token = options.token ?? envToken();
    this.baseUrl = options.baseUrl ?? 'https://data.cityofnewyork.us';
  }

  /** Build the full request URL, including SoQL params and the token. */
  buildUrl(dataset: string, params?: URLSearchParams, format: 'json' | 'geojson' = 'json'): string {
    const url = new URL(`${this.baseUrl}/resource/${dataset}.${format}`);
    if (params) {
      for (const [key, value] of params) {
        url.searchParams.set(key, value);
      }
    }
    if (this.token !== undefined) {
      url.searchParams.set('$$app_token', this.token);
    }
    return url.toString();
  }

  /**
   * Run one SODA query and return the parsed rows.
   *
   * ETag flow: a cached entry supplies an If-None-Match header. A 304
   * response returns the cached body. A 304 still counts as a fetch
   * call. Quota counting stays at the fetch-call level, in the caller.
   */
  async query(
    dataset: string,
    params?: URLSearchParams,
    format: 'json' | 'geojson' = 'json',
  ): Promise<SodaRow[]> {
    const url = this.buildUrl(dataset, params, format);
    const cached = await this.cache.get(url);
    const headers: Record<string, string> = {};
    if (cached && cached.etag !== null) {
      headers['If-None-Match'] = cached.etag;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new SODAError(dataset, undefined, `network failure for dataset ${dataset}: ${detail}`);
    }

    if (response.status === 304) {
      if (!cached) {
        throw new SODAError(dataset, 304, `304 without a cached body for dataset ${dataset}`);
      }
      return parseRows(dataset, cached.body);
    }

    if (!response.ok) {
      throw new SODAError(
        dataset,
        response.status,
        `SODA request failed for dataset ${dataset} with status ${response.status}`,
      );
    }

    const body = await response.text();
    const etag = response.headers.get('etag');
    await this.cache.put(url, body, etag);
    return parseRows(dataset, body);
  }
}

function parseRows(dataset: string, body: string): SodaRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new SODAError(dataset, undefined, `invalid JSON from dataset ${dataset}`);
  }
  if (!Array.isArray(parsed)) {
    throw new SODAError(dataset, undefined, `unexpected non-array payload from dataset ${dataset}`);
  }
  return parsed as SodaRow[];
}
