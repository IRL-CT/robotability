/**
 * End-to-end tests for the fetchFeature facade.
 *
 * The facade wires the quota guard to the SODA client:
 * - every network fetch is recorded against the hourly budget;
 * - a 429 response disables further requests through the guard;
 * - a blocked guard stops the request before any fetch call.
 *
 * All network access is mocked. No real timers are used.
 */

import { describe, expect, it, vi } from 'vitest';

import { SODAError } from './client.ts';
import { PROXY_FEATURES, fetchFeature, type SegmentGeometry } from './features.ts';
import { HOURLY_BUDGET, MemoryQuotaStorage, createQuotaGuard } from './quotaGuard.ts';

const SEGMENT: SegmentGeometry = {
  midpoint: { lon: -73.99, lat: 40.74 },
  endpoints: [
    { lon: -73.995, lat: 40.742 },
    { lon: -73.985, lat: 40.738 },
  ],
};

const T0 = 2_000_000_000_000;

function makeGuard() {
  let time = T0;
  return createQuotaGuard({ storage: new MemoryQuotaStorage(), now: () => time });
}

describe('fetchFeature success path', () => {
  it('returns the mapped value and counts exactly one fetch', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('[{"rampid": "1"}, {"rampid": "2"}]', { status: 200 }),
    );
    const guard = makeGuard();
    const value = await fetchFeature(PROXY_FEATURES.curb_ramp_availability, SEGMENT, {
      fetchImpl,
      guard,
    });
    // Assert on the returned value, not just on absence of errors.
    expect(value).toBe(2);
    // Assert on the exact network call count.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(guard.getState().requestsLastHour).toBe(1);
  });

  it('sums one fetch per dataset for multi-dataset features', async () => {
    const rowsByDataset: Record<string, number> = {
      '79sh-heg3': 1,
      'hz4p-9f7s': 2,
      'mqt5-ctec': 3,
      'wqhs-q6wd': 0,
      '8kuj-2n3u': 4,
    };
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      const id = Object.keys(rowsByDataset).find((key) => url.includes(key));
      const count = id ? rowsByDataset[id] : 0;
      const rows = Array.from({ length: count }, (_, i) => ({ n: String(i) }));
      return Promise.resolve(new Response(JSON.stringify(rows), { status: 200 }));
    });
    const guard = makeGuard();
    const value = await fetchFeature(PROXY_FEATURES.traffic_management, SEGMENT, {
      fetchImpl,
      guard,
    });
    expect(value).toBe(10); // 1 + 2 + 3 + 0 + 4.
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(guard.getState().requestsLastHour).toBe(5);
  });
});

describe('fetchFeature 429 handling', () => {
  it('throws SODAError 429, disables the guard, and blocks the next call', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('too many requests', { status: 429 }));
    const guard = makeGuard();
    const spec = PROXY_FEATURES.curb_ramp_availability;

    // First call hits the network and receives a 429.
    const error = await fetchFeature(spec, SEGMENT, { fetchImpl, guard }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SODAError);
    expect((error as SODAError).status).toBe(429);
    expect((error as SODAError).dataset).toBe('ufzp-rrqu');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(guard.getState().disabled).toBe(true);

    // Second call must not reach the network at all.
    const blocked = await fetchFeature(spec, SEGMENT, { fetchImpl, guard }).catch(
      (e: unknown) => e,
    );
    expect(blocked).toBeInstanceOf(SODAError);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // Call count unchanged.
  });
});

describe('fetchFeature budget exhaustion', () => {
  it('refuses to fetch once the hourly budget is used up', async () => {
    const fetchImpl = vi.fn();
    const guard = makeGuard();
    for (let i = 0; i < HOURLY_BUDGET; i += 1) {
      guard.recordRequest();
    }
    const error = await fetchFeature(PROXY_FEATURES.zoning_laws, SEGMENT, {
      fetchImpl,
      guard,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SODAError);
    expect(fetchImpl).toHaveBeenCalledTimes(0); // No network access.
  });
});
