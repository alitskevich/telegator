import { z } from "zod";
import type { Clock } from "../clock";

/**
 * The pipeline's date key, `YYYY-MM-DD`.
 *
 * §2.2 L137: "the scrape date, not the post date". It partitions deduplication
 * *and* is the FIFO `MessageGroupId`, and §6 L541 makes the first a correctness
 * rule rather than an optimisation.
 *
 * The document names no timezone. **UTC** is the recorded choice, applied in
 * exactly one place so two parts of the pipeline can never disagree about what
 * day it is and split one story across two groups.
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

/** §3.1 L224's `date = today`, read from the injected clock. */
export function todayKey(clock: Clock): DateKey {
  return toDateKey(clock.now());
}

/**
 * target-table#5.3 — an epoch-millisecond instant as an ISO timestamp.
 *
 * Beside `toDateKey` because it is the same conversion at a different
 * precision, and UTC for the same reason: one place decides what instant a
 * number names, so two parts of the build cannot disagree.
 */
export function toIsoTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString();
}
