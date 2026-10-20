import { describe, expect, test } from "vitest";
import { ariaSort, num, share, sortIcon, statusTone, UNKNOWN } from "./functions";

describe("template helpers", () => {
  /** §8.5 — an unread number is never shown as a reassuring 0. */
  test("num shows unknown for anything that is not a number", () => {
    expect(num(null)).toBe(UNKNOWN);
    expect(num(undefined)).toBe(UNKNOWN);
    expect(num(Number.NaN)).toBe(UNKNOWN);
    expect(num(0)).toBe("0");
    expect(num(12345)).toBe("12,345");
  });

  test("a small but real share reads <1%, not 0%", () => {
    expect(share(0.003)).toBe("<1%");
    expect(share(0.25)).toBe("25%");
    expect(share(0)).toBe("0%");
  });

  test("an unknown status is neutral, not an alarm", () => {
    expect(statusTone("error")).toBe("badge-error");
    expect(statusTone("something-new")).toBe("badge-ghost");
  });

  test("only the sorted column reports its direction", () => {
    const sort = { column: "id", direction: "desc" };

    expect(sortIcon(sort, "id")).toBe("arrow-down");
    expect(sortIcon(sort, "title")).toBe("arrow-up-down");
    expect(ariaSort(sort, "id")).toBe("descending");
    expect(ariaSort(sort, "title")).toBeNull();
    expect(ariaSort(undefined, "id")).toBeNull();
  });

  /** The phone's flip button asks about the sorted column, which is absent when nothing is sorted. */
  test("no sort and no column is unsorted, not an error", () => {
    expect(sortIcon(undefined, undefined)).toBe("arrow-up-down");
    expect(ariaSort(null, undefined)).toBeNull();
  });
});
