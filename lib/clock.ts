/**
 * The pipeline's only source of wall-clock time.
 *
 * Time is injected rather than read from `Date.now()` because two normative
 * properties depend on controlling it: §6 L522 stamps `ts: now()` into every
 * member block, and §11.2 E2E-5 requires a replay to leave the record
 * unchanged. Code that reaches for the global clock cannot be held to either.
 */
export interface Clock {
  /** Epoch milliseconds — the unit §2.1 L109, §2.3 L151 and L152 all use. */
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};
