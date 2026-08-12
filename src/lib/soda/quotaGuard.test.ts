/**
 * Tests for the rolling 1-hour quota guard.
 *
 * Every test injects a fake clock and an in-memory storage.
 * No test uses real timers or the real localStorage.
 */

import { describe, expect, it } from 'vitest';

import {
  BACKOFF_MS,
  HOURLY_BUDGET,
  MemoryQuotaStorage,
  WINDOW_MS,
  createQuotaGuard,
} from './quotaGuard.ts';

const T0 = 1_000_000_000_000; // Arbitrary fixed epoch in ms.

function makeGuard(startMs = T0) {
  let time = startMs;
  const guard = createQuotaGuard({
    storage: new MemoryQuotaStorage(),
    now: () => time,
  });
  return {
    guard,
    advance: (ms: number) => {
      time += ms;
    },
    time: () => time,
  };
}

describe('budget constants', () => {
  it('exports the documented budget, window, and backoff', () => {
    expect(HOURLY_BUDGET).toBe(40);
    expect(WINDOW_MS).toBe(60 * 60 * 1000);
    expect(BACKOFF_MS).toBe(15 * 60 * 1000);
  });
});

describe('rolling budget', () => {
  it('allows requests up to the budget and blocks the 41st', () => {
    const { guard } = makeGuard();
    for (let i = 0; i < HOURLY_BUDGET; i += 1) {
      expect(guard.canRequest()).toBe(true);
      guard.recordRequest();
    }
    // The 41st request inside the same hour is blocked.
    expect(guard.canRequest()).toBe(false);
    expect(guard.getState().requestsLastHour).toBe(40);
    expect(guard.getState().budget).toBe(HOURLY_BUDGET);
  });

  it('clears the window after one hour passes', () => {
    const { guard, advance } = makeGuard();
    for (let i = 0; i < HOURLY_BUDGET; i += 1) {
      guard.recordRequest();
    }
    expect(guard.canRequest()).toBe(false);
    // Move the clock past the 1-hour window. Every timestamp expires.
    advance(WINDOW_MS + 1);
    expect(guard.canRequest()).toBe(true);
    expect(guard.getState().requestsLastHour).toBe(0);
  });

  it('prunes only entries older than one hour', () => {
    const { guard, advance } = makeGuard();
    for (let i = 0; i < 5; i += 1) {
      guard.recordRequest();
    }
    advance(30 * 60 * 1000); // 30 minutes.
    for (let i = 0; i < 5; i += 1) {
      guard.recordRequest();
    }
    expect(guard.getState().requestsLastHour).toBe(10);
    advance(31 * 60 * 1000); // The first 5 entries now exceed 1 hour.
    expect(guard.getState().requestsLastHour).toBe(5);
    expect(guard.canRequest()).toBe(true);
  });

  it('persists state through the injected storage', () => {
    const storage = new MemoryQuotaStorage();
    let time = T0;
    const first = createQuotaGuard({ storage, now: () => time });
    first.recordRequest();
    first.recordRequest();
    // A second guard on the same storage sees the same log.
    const second = createQuotaGuard({ storage, now: () => time });
    expect(second.getState().requestsLastHour).toBe(2);
  });
});

describe('429 backoff', () => {
  it('disables requests until the backoff expiry', () => {
    const { guard, advance, time } = makeGuard();
    expect(guard.canRequest()).toBe(true);
    guard.notify429();

    const state = guard.getState();
    expect(state.disabled).toBe(true);
    expect(state.disabledUntil).toBe(time() + BACKOFF_MS);
    expect(guard.canRequest()).toBe(false);

    // Still blocked one ms before expiry.
    advance(BACKOFF_MS - 1);
    expect(guard.canRequest()).toBe(false);
    expect(guard.getState().disabled).toBe(true);

    // Re-enabled after the expiry passes.
    advance(2);
    expect(guard.canRequest()).toBe(true);
    expect(guard.getState().disabled).toBe(false);
    expect(guard.getState().disabledUntil).toBeNull();
  });

  it('keeps the request log intact across a backoff', () => {
    const { guard, advance } = makeGuard();
    guard.recordRequest();
    guard.notify429();
    advance(BACKOFF_MS + 1);
    expect(guard.getState().requestsLastHour).toBe(1);
    expect(guard.canRequest()).toBe(true);
  });
});

describe('storage fallback', () => {
  it('MemoryQuotaStorage behaves like a minimal localStorage', () => {
    const storage = new MemoryQuotaStorage();
    expect(storage.getItem('a')).toBeNull();
    storage.setItem('a', 'x');
    expect(storage.getItem('a')).toBe('x');
    storage.removeItem('a');
    expect(storage.getItem('a')).toBeNull();
  });
});
