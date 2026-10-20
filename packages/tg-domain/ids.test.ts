import { describe, expect, test } from "vitest";
import { formatItemId, ItemIdSchema, parseItemId, sourceIdOf } from "./ids";

describe("formatItemId", () => {
  test("joins the source and Telegram message id with a slash", () => {
    expect(formatItemId("yigal_levin", "12345")).toBe("yigal_levin/12345");
  });

  /** Ids are used verbatim in payloads and map keys, so the slash must survive intact. */
  test("does not encode the separator", () => {
    expect(formatItemId("abc", "1")).not.toContain("%2F");
    expect(formatItemId("abc", "1")).toBe("abc/1");
  });
});

describe("parseItemId", () => {
  test("round-trips what formatItemId produced", () => {
    expect(parseItemId(formatItemId("nexta_live", "98765"))).toEqual({
      sourceId: "nexta_live",
      tgMessageId: "98765",
    });
  });

  test("rejects an id with no separator", () => {
    expect(() => parseItemId("yigal_levin")).toThrow();
  });

  /**
   * The channel is taken as `id.split("/")[0]`; a slash in the source segment
   * would truncate it and render a broken @mention link.
   */
  test("rejects a source segment containing a slash", () => {
    expect(() => parseItemId("a/b/1")).toThrow();
  });

  test("rejects a non-numeric Telegram message id", () => {
    expect(() => parseItemId("yigal_levin/abc")).toThrow();
  });

  test("rejects an empty source segment", () => {
    expect(() => parseItemId("/12345")).toThrow();
  });
});

describe("sourceIdOf", () => {
  test("returns the channel segment the @mention needs", () => {
    expect(sourceIdOf("yigal_levin/12345")).toBe("yigal_levin");
  });

  test("throws rather than returning undefined for a malformed id", () => {
    // A silent undefined would reach MemberBlock.channel and render as
    // "@undefined" in a published Telegram message.
    expect(() => sourceIdOf("nonsense")).toThrow();
  });
});

describe("member ids never match by substring", () => {
  test("abc/1 and abc/12 are distinct ids", () => {
    expect(formatItemId("abc", "1")).not.toBe(formatItemId("abc", "12"));
  });

  /**
   * The original system substring-matched a comma-joined id string, so `abc/1`
   * matched inside `abc/12`. Keying a map by the id makes the lookup exact.
   */
  test("a members map keyed by abc/12 does not answer for abc/1", () => {
    const members: Record<string, string> = { [formatItemId("abc", "12")]: "twelve" };

    expect(members[formatItemId("abc", "1")]).toBeUndefined();
    expect(members[formatItemId("abc", "12")]).toBe("twelve");
  });

  test("an id is a usable object key even though it contains a slash", () => {
    const id = formatItemId("abc", "1");
    const members: Record<string, string> = { [id]: "one" };

    expect(Object.keys(members)).toEqual(["abc/1"]);
    expect(members[id]).toBe("one");
  });
});

describe("ItemIdSchema", () => {
  test("accepts a well-formed composite id", () => {
    expect(ItemIdSchema.parse("yigal_levin/12345")).toBe("yigal_levin/12345");
  });

  test.each(["", "yigal_levin", "/1", "a/b/1", "yigal_levin/", "yigal_levin/12a"])(
    "rejects %o",
    (bad) => {
      expect(ItemIdSchema.safeParse(bad).success).toBe(false);
    },
  );
});
