/**
 * The pipeline's only source of wall-clock time. Injected rather than read from
 * `Date.now()`, so tests can prove that a replay leaves a message unchanged even
 * though every write stamps `ts: now()`.
 */
export interface Clock {
  /** Epoch milliseconds, the unit every stored timestamp uses. */
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};
