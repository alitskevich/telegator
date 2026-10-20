import { describe, expect, test } from "vitest";
import {
  addToast,
  createToast,
  dismissToast,
  expireToasts,
  TOAST_LIMIT,
  TOAST_TTL_MS,
  type Toast,
} from "./toasts";

const at = (ms: number) => 1_770_000_000_000 + ms;

const ok = (text: string, now: number): Toast => createToast("ok", text, now);

const failure = (text: string, now: number): Toast => createToast("error", text, now);

describe("addToast", () => {
  test("puts the newest first, so the answer to the last press is on top", () => {
    const one = addToast([], ok("Scraped 7 items", at(0)));
    const two = addToast(one, ok("Reset 12 sources", at(1)));

    expect(two.map((toast) => toast.text)).toEqual(["Reset 12 sources", "Scraped 7 items"]);
  });

  test("gives every toast a distinct id, including two with the same text", () => {
    const twice = addToast(addToast([], ok("Exported", at(0))), ok("Exported", at(1)));

    expect(new Set(twice.map((toast) => toast.id)).size).toBe(2);
  });

  /** A stack that grows without bound covers the table it is reporting on. */
  test("keeps at most TOAST_LIMIT, dropping the oldest", () => {
    let toasts: Toast[] = [];
    for (let n = 0; n <= TOAST_LIMIT; n += 1) {
      toasts = addToast(toasts, ok(`press ${n}`, at(n)));
    }

    expect(toasts).toHaveLength(TOAST_LIMIT);
    expect(toasts.map((toast) => toast.text)).not.toContain("press 0");
  });

  /**
   * An error is the one thing an operator must not miss, so the cap drops an
   * older *success* before it drops any failure.
   */
  test("drops a success before an error when it has to drop something", () => {
    let toasts = addToast([], failure("Scrape failed", at(0)));
    for (let n = 1; n <= TOAST_LIMIT; n += 1) {
      toasts = addToast(toasts, ok(`press ${n}`, at(n)));
    }

    expect(toasts).toHaveLength(TOAST_LIMIT);
    expect(toasts.map((toast) => toast.text)).toContain("Scrape failed");
  });
});

describe("expireToasts", () => {
  test("retires a success once its time is up", () => {
    const toasts = addToast([], ok("Scraped 7 items", at(0)));

    expect(expireToasts(toasts, at(TOAST_TTL_MS - 1))).toHaveLength(1);
    expect(expireToasts(toasts, at(TOAST_TTL_MS))).toEqual([]);
  });

  /**
   * A failure stays until it is dismissed. It is the answer to something the
   * operator just did, and a message that vanishes on its own is one they can
   * miss entirely by looking at the table instead of the corner.
   */
  test("never retires an error on its own", () => {
    const toasts = addToast([], failure("Lambda unreachable", at(0)));

    expect(expireToasts(toasts, at(TOAST_TTL_MS * 1000))).toHaveLength(1);
  });

  test("returns the same array when nothing expired, so React does not re-render", () => {
    const toasts = addToast([], ok("Scraped", at(0)));

    expect(expireToasts(toasts, at(1))).toBe(toasts);
  });
});

describe("dismissToast", () => {
  test("removes one by id and leaves the rest", () => {
    const toasts = addToast(addToast([], ok("first", at(0))), failure("second", at(1)));
    const target = toasts[0];
    if (target === undefined) throw new Error("expected a toast");

    expect(dismissToast(toasts, target.id).map((toast) => toast.text)).toEqual(["first"]);
  });

  test("an unknown id changes nothing", () => {
    const toasts = addToast([], ok("first", at(0)));

    expect(dismissToast(toasts, "nope")).toBe(toasts);
  });
});
