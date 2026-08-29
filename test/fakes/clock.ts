import type { Clock } from "../../lib/clock.js";

/** A clock stopped at one instant. */
export function fixedClock(instant: number): Clock {
  return { now: () => instant };
}

/**
 * A clock that moves on every read.
 *
 * Idempotency tests must run against this, not `fixedClock`: freezing time
 * hides a non-idempotent `ts: now()` write (§6 L522) by making the second
 * write coincidentally equal to the first.
 */
export function advancingClock(start: number, stepMs = 1): Clock {
  let next = start;
  return {
    now: () => {
      const current = next;
      next += stepMs;
      return current;
    },
  };
}

/**
 * A clock that stands still until a test moves it.
 *
 * Session expiry (§8.6) is the case `fixedClock` and `advancingClock` cannot
 * express: the test must hold time still across several reads, then step it
 * over a boundary by an exact amount.
 */
export function manualClock(start: number): Clock & { advance(ms: number): void } {
  let instant = start;
  return {
    now: () => instant,
    advance: (ms) => {
      instant += ms;
    },
  };
}
