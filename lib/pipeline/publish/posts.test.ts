import { describe, expect, test } from "vitest";
import { isCurrent, postFor } from "./posts";

const legacy = { tgChannel: "a, @b", tgId: "4711", tgAt: 900 };

describe("postFor — multi-target#5.2", () => {
  test("a recorded post wins over the legacy pair", () => {
    expect(postFor(legacy, { a: { tgId: "1", tgAt: 5 } }, "a")).toEqual({ tgId: "1", tgAt: 5 });
  });

  test("the first target falls back to the legacy tgId/tgAt", () => {
    expect(postFor(legacy, {}, "a")).toEqual({ tgId: "4711", tgAt: 900 });
  });

  test("a later target never inherits the legacy post", () => {
    expect(postFor(legacy, {}, "b")).toBeUndefined();
  });

  test("a legacy post with no tgAt is dated 0, so it is never current", () => {
    expect(postFor({ tgChannel: "a", tgId: "4711" }, {}, "a")).toEqual({ tgId: "4711", tgAt: 0 });
  });

  test("an empty or absent tgId is no post", () => {
    expect(postFor({ tgChannel: "a", tgId: "" }, {}, "a")).toBeUndefined();
    expect(postFor({ tgChannel: "a" }, {}, "a")).toBeUndefined();
  });

  test("an empty list's first target is the default channel", () => {
    expect(postFor({ tgChannel: "", tgId: "9" }, {}, "telegator_news")).toEqual({
      tgId: "9",
      tgAt: 0,
    });
  });
});

describe("isCurrent — multi-target D4", () => {
  test("a post at or after the message's ts is current; before it is not", () => {
    expect(isCurrent({ tgId: "1", tgAt: 10 }, { ts: 10 })).toBe(true);
    expect(isCurrent({ tgId: "1", tgAt: 9 }, { ts: 10 })).toBe(false);
  });
});
