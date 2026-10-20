import type { Clock } from "tg-utils/clock";
import { z } from "zod";

/**
 * The pipeline's date key, `YYYY-MM-DD`: the scrape day, not the post day. It
 * partitions deduplication. It is always UTC and computed here only, so two
 * stages can never disagree about the day and split one story in two.
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

/** Today's date key, read from the injected clock. */
export function todayKey(clock: Clock): DateKey {
  return toDateKey(clock.now());
}

/** An epoch-millisecond instant as a UTC ISO timestamp. */
export function toIsoTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString();
}
