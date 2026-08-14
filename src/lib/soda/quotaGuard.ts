/**
 * Rolling 1-hour request quota guard for live SODA refresh.
 *
 * The browser client shares one Socrata app token across all visitors.
 * The anonymous Socrata limit is low, and an app token raises it.
 * The guard caps this client at 40 requests per rolling hour. That
 * keeps headroom under the token limit for the whole site.
 *
 * Storage contract: timestamps live in localStorage as one JSON array.
 * Every read prunes entries older than one hour. A 429 response sets a
 * disabled flag with an expiry 15 minutes in the future. Budget
 * exhaustion also blocks requests: the block lifts when the oldest
 * timestamp leaves the rolling window.
 *
 * This module is self-contained. It imports nothing. Node runs it
 * directly with type stripping (see scripts/soda/demo_quota.mjs).
 */

/** Minimal localStorage shape. Keeps this module SSR-safe and testable. */
export interface QuotaStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** In-memory storage fallback. Used when localStorage is absent (SSR, tests). */
export class MemoryQuotaStorage implements QuotaStorage {
  private readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }
}

/** Max requests per rolling hour. Socrata anon limit is low; an app
 * token raises it; 40 keeps headroom. */
export const HOURLY_BUDGET = 40;

/** Length of the rolling window: one hour in ms. */
export const WINDOW_MS = 60 * 60 * 1000;

/** Backoff after any 429: 15 minutes in ms. */
export const BACKOFF_MS = 15 * 60 * 1000;

const REQUEST_LOG_KEY = 'robotability.soda.requestLog';
const DISABLED_UNTIL_KEY = 'robotability.soda.disabledUntil';

export interface QuotaGuardOptions {
  /** Defaults to globalThis.localStorage when present, else memory. */
  storage?: QuotaStorage;
  /** Injectable clock. Defaults to Date.now. Tests must inject. */
  now?: () => number;
}

export interface QuotaGuardState {
  requestsLastHour: number;
  budget: number;
  disabled: boolean;
  disabledUntil: number | null;
}

export interface QuotaGuard {
  canRequest(): boolean;
  recordRequest(): void;
  notify429(): void;
  getState(): QuotaGuardState;
}

function defaultStorage(): QuotaStorage {
  // The DOM lib types localStorage. Node and SSR have none. Fall back
  // to memory so the guard still works server-side.
  if (typeof localStorage !== 'undefined') {
    return localStorage;
  }
  return new MemoryQuotaStorage();
}

function readLog(storage: QuotaStorage): number[] {
  const raw = storage.getItem(REQUEST_LOG_KEY);
  if (raw === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const out: number[] = [];
    for (const item of parsed) {
      if (typeof item === 'number' && Number.isFinite(item)) {
        out.push(item);
      }
    }
    return out;
  } catch {
    // A corrupt log must never break the guard. Start fresh.
    return [];
  }
}

function writeLog(storage: QuotaStorage, log: number[]): void {
  storage.setItem(REQUEST_LOG_KEY, JSON.stringify(log));
}

function readDisabledUntil(storage: QuotaStorage): number | null {
  const raw = storage.getItem(DISABLED_UNTIL_KEY);
  if (raw === null) {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Create a quota guard. Inject storage and clock for tests. */
export function createQuotaGuard(options: QuotaGuardOptions = {}): QuotaGuard {
  const storage = options.storage ?? defaultStorage();
  const now = options.now ?? Date.now;

  function prune(log: number[], atMs: number): number[] {
    const cutoff = atMs - WINDOW_MS;
    return log.filter((timestamp) => timestamp > cutoff);
  }

  function canRequest(): boolean {
    const atMs = now();
    const disabledUntil = readDisabledUntil(storage);
    if (disabledUntil !== null) {
      if (atMs < disabledUntil) {
        return false;
      }
      // The backoff expired. Clear the flag.
      storage.removeItem(DISABLED_UNTIL_KEY);
    }
    const log = prune(readLog(storage), atMs);
    return log.length < HOURLY_BUDGET;
  }

  function recordRequest(): void {
    const atMs = now();
    const log = prune(readLog(storage), atMs);
    log.push(atMs);
    writeLog(storage, log);
  }

  function notify429(): void {
    const atMs = now();
    storage.setItem(DISABLED_UNTIL_KEY, String(atMs + BACKOFF_MS));
  }

  function getState(): QuotaGuardState {
    const atMs = now();
    const disabledUntil = readDisabledUntil(storage);
    const disabled = disabledUntil !== null && atMs < disabledUntil;
    const log = prune(readLog(storage), atMs);
    return {
      requestsLastHour: log.length,
      budget: HOURLY_BUDGET,
      disabled,
      disabledUntil: disabled ? disabledUntil : null,
    };
  }

  return { canRequest, recordRequest, notify429, getState };
}
