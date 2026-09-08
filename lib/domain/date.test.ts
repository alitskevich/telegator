import { describe, expect, test } from "vitest";
import { fixedClock } from "../../test/fakes/clock";
import { DateKeySchema, toDateKey, todayKey, toIsoTimestamp } from "./date";

const utc = (y: number, m: number, d: number, h = 0, min = 0, s = 0): number =>
  Date.UTC(y, m - 1, d, h, min, s);

describe("toDateKey", () => {
  test("formats as YYYY-MM-DD with zero padding", () => {
    expect(toDateKey(utc(2026, 1, 5))).toBe("2026-01-05");
  });

  /**
   * §2.2 L137 calls this "the scrape date"; the spec never names a timezone.
   * UTC is the recorded choice (Phase 0 conventions) and it has to be honoured
   * exactly, because §6 L541 makes the date a correctness rule for dedup and
   * §7.3 L647 makes it the FIFO MessageGroupId. Two same-day scrapes that
   * disagree about the date silently split one story into two messages.
   *
   * These two instants straddle UTC midnight, so a local-time implementation
   * fails at least one of them in any timezone that is not UTC.
   */
  test("uses UTC, not the host timezone, just before midnight", () => {
    expect(toDateKey(utc(2026, 1, 5, 23, 30))).toBe("2026-01-05");
  });

  test("uses UTC, not the host timezone, just after midnight", () => {
    expect(toDateKey(utc(2026, 1, 6, 0, 30))).toBe("2026-01-06");
  });

  test("rolls over exactly at UTC midnight", () => {
    expect(toDateKey(utc(2026, 1, 5, 23, 59, 59))).toBe("2026-01-05");
    expect(toDateKey(utc(2026, 1, 6, 0, 0, 0))).toBe("2026-01-06");
  });
});

describe("todayKey", () => {
  test("reads the date from the injected clock", () => {
    expect(todayKey(fixedClock(utc(2026, 8, 29, 12, 0)))).toBe("2026-08-29");
  });

  test("is stable across calls on a stopped clock, so one scrape run stamps one date", () => {
    const clock = fixedClock(utc(2026, 8, 29, 23, 59, 59));

    expect(todayKey(clock)).toBe(todayKey(clock));
  });
});

describe("DateKeySchema", () => {
  test("accepts a well-formed date", () => {
    expect(DateKeySchema.parse("2026-08-29")).toBe("2026-08-29");
  });

  test("accepts a real leap day", () => {
    expect(DateKeySchema.safeParse("2024-02-29").success).toBe(true);
  });

  /**
   * A calendar-invalid value must not reach the table: `date` is the partition
   * key of `date-index` (§7.2 L634) and the FIFO group (§7.3 L647), so garbage
   * creates a partition nothing will ever query again.
   */
  test.each(["2026-02-30", "2023-02-29", "2026-13-01", "2026-00-10", "2026-01-32"])(
    "rejects the calendar-invalid %s",
    (bad) => {
      expect(DateKeySchema.safeParse(bad).success).toBe(false);
    },
  );

  test.each(["", "2026-1-5", "20260105", "2026-01-05T00:00:00Z", "05-01-2026", "yesterday"])(
    "rejects the malformed %o",
    (bad) => {
      expect(DateKeySchema.safeParse(bad).success).toBe(false);
    },
  );
});

describe("toIsoTimestamp — target-table#5.3", () => {
  test("TT-15: the epoch is 1970-01-01T00:00:00.000Z", () => {
    expect(toIsoTimestamp(0)).toBe("1970-01-01T00:00:00.000Z");
  });

  /** D3 — the same shape `sources.lastResult` already carries. */
  test("TT-15: formats in UTC with milliseconds, whatever the host timezone", () => {
    expect(toIsoTimestamp(utc(2026, 9, 8, 10, 30, 15))).toBe("2026-09-08T10:30:15.000Z");
  });

  test("agrees with toDateKey on the day it names", () => {
    const at = utc(2026, 9, 8, 23, 59, 59);

    expect(toIsoTimestamp(at).slice(0, 10)).toBe(toDateKey(at));
  });
});
