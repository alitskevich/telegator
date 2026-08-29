import { z } from "zod";
import type { Clock } from "../clock.js";

/**
 * The pipeline's date key, `YYYY-MM-DD`.
 *
 * §2.2 L127: this is "the scrape date, not the post date". It carries two jobs
 * at once — it partitions deduplication and it is the FIFO `MessageGroupId` —
 * and §3.3 L276 is explicit that the first of those is "not an optimisation, it
 * is a correctness rule": without it an anniversary story merges into a message
 * published days earlier.
 *
 * The spec never names a timezone. **UTC** is the recorded choice (Phase 0
 * conventions), applied in exactly one place so two parts of the pipeline can
 * never disagree about what day it is and split one story across two groups.
 */
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Rejects calendar-invalid values the pattern alone lets through, e.g. 2026-02-30. */
const isRealCalendarDate = (value: string): boolean => {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed) && toDateKey(parsed) === value;
};

export const DateKeySchema = z
  .string()
  .regex(DATE_KEY_PATTERN, "expected a date of the form YYYY-MM-DD")
  .refine(isRealCalendarDate, "not a real calendar date");

export type DateKey = z.infer<typeof DateKeySchema>;

/** Formats an epoch-millisecond instant as a UTC date key. */
export function toDateKey(epochMs: number): DateKey {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** §3.1 L212's `date = today`, read from the injected clock. */
export function todayKey(clock: Clock): DateKey {
  return toDateKey(clock.now());
}
