/**
 * The pipeline's only source of wall-clock time.
 *
 * Time is injected rather than read from `Date.now()` because two normative
 * properties depend on controlling it: §6 L591 stamps `ts: now()` into every
 * member block, and §10.2 E2E-5 requires a replay to leave the record
 * unchanged. Code that reaches for the global clock cannot be held to either.
 */
export interface Clock {
  /** Epoch milliseconds — the unit §2.1 L117, §2.3 L160 and L161 all use. */
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};
