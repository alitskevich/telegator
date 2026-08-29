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
