#!/usr/bin/env node
/**
 * Manual QA demo for the SODA quota guard.
 *
 * Exercises the guard with the in-memory storage fallback and an
 * injected clock. Prints the state after 39, 40, and 41 requests,
 * then after a simulated 1h + 1s expiry. No network. No localStorage.
 *
 * Usage: node scripts/soda/demo_quota.mjs
 *
 * Node 24 strips TypeScript types natively, so this script imports the
 * .ts module directly with an explicit extension. quotaGuard.ts is
 * self-contained on purpose: it imports nothing.
 */

import {
  BACKOFF_MS,
  HOURLY_BUDGET,
  MemoryQuotaStorage,
  WINDOW_MS,
  createQuotaGuard,
} from '../../src/lib/soda/quotaGuard.ts';

let time = 1_000_000_000_000;
const guard = createQuotaGuard({
  storage: new MemoryQuotaStorage(),
  now: () => time,
});

function printState(label) {
  const state = guard.getState();
  console.log(
    `${label}: canRequest=${guard.canRequest()} ` +
      `requestsLastHour=${state.requestsLastHour}/${state.budget} ` +
      `disabled=${state.disabled} disabledUntil=${state.disabledUntil}`,
  );
}

console.log(`budget=${HOURLY_BUDGET} windowMs=${WINDOW_MS} backoffMs=${BACKOFF_MS}`);

for (let i = 1; i <= 39; i += 1) {
  guard.recordRequest();
}
printState('after 39 requests');

guard.recordRequest();
printState('after 40 requests');

console.log(`41st request allowed: ${guard.canRequest()} (expect false)`);
printState('after 41st request attempt');

time += WINDOW_MS + 1000;
printState('after 1h + 1s expiry');
console.log(`request allowed after expiry: ${guard.canRequest()} (expect true)`);

guard.notify429();
printState('after notify429');
const blockedBy429 = !guard.canRequest();
console.log(`request blocked by 429 backoff: ${blockedBy429} (expect true)`);

time += BACKOFF_MS + 1000;
printState('after 15min backoff expiry');
const clearedAfterBackoff = guard.canRequest();
console.log(`request allowed after backoff: ${clearedAfterBackoff} (expect true)`);

if (!blockedBy429 || !clearedAfterBackoff) {
  console.error('FAIL: guard state transitions are wrong.');
  process.exit(1);
}
console.log('PASS: guard blocks the 41st request and clears after expiry.');
