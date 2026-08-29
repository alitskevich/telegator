import { describe, expect, test } from "vitest";
import { advancingClock, fixedClock } from "../test/fakes/clock.js";
import { type Clock, systemClock } from "./clock.js";

describe("systemClock", () => {
  test("reports the current time in epoch milliseconds", () => {
    const before = Date.now();
    const observed = systemClock.now();
    const after = Date.now();

    expect(observed).toBeGreaterThanOrEqual(before);
    expect(observed).toBeLessThanOrEqual(after);
  });
});

describe("fixedClock", () => {
  test("returns the instant it was built with", () => {
    expect(fixedClock(1_700_000_000_000).now()).toBe(1_700_000_000_000);
  });

  test("returns the same instant on every call, so a replay is byte-identical", () => {
    const clock = fixedClock(1_700_000_000_000);

    expect(clock.now()).toBe(clock.now());
  });
});

describe("advancingClock", () => {
  // R11: replay idempotency must be proven under a clock that moves. A frozen
  // clock makes `ts: now()` (spec §6 L522) look idempotent when it is not.
  test("returns a later instant on each call", () => {
    const clock = advancingClock(1_000, 5);

    expect(clock.now()).toBe(1_000);
    expect(clock.now()).toBe(1_005);
    expect(clock.now()).toBe(1_010);
  });

  test("defaults to advancing one millisecond per call", () => {
    const clock = advancingClock(1_000);

    expect(clock.now()).toBe(1_000);
    expect(clock.now()).toBe(1_001);
  });
});

describe("Clock", () => {
  test("every clock is interchangeable at the injection point", () => {
    const clocks: Clock[] = [systemClock, fixedClock(42), advancingClock(42)];

    for (const clock of clocks) {
      expect(typeof clock.now()).toBe("number");
    }
  });
});
