import { describe, expect, test } from "vitest";
import { formatItemId, ItemIdSchema, parseItemId, sourceIdOf } from "./ids";

describe("formatItemId", () => {
  test("joins the source and Telegram message id with a slash (§2.2 L121)", () => {
    expect(formatItemId("yigal_levin", "12345")).toBe("yigal_levin/12345");
  });

  /**
   * §2.4 L175: ids are used verbatim as SQS fields, DynamoDB map keys and
   * partition keys. "Both encoders are deleted. No encode/decode layer exists."
   * So the slash must survive intact — percent-encoding it here would silently
   * break every id in the system.
   */
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
   * §6 L522 takes the channel as `item.id.split("/")[0]`. That is only correct
   * while the source segment contains no slash — otherwise the channel is
   * silently truncated and §3.4 L321 renders a broken @mention link.
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
  test("returns the channel segment §6 L522 needs for the @mention", () => {
    expect(sourceIdOf("yigal_levin/12345")).toBe("yigal_levin");
  });

  test("throws rather than returning undefined for a malformed id", () => {
    // A silent undefined would reach MemberBlock.channel and render as
    // "@undefined" in a published Telegram message (§3.4 L321).
    expect(() => sourceIdOf("nonsense")).toThrow();
  });
});

describe("defect D2 is structurally dead (§2.3 L169)", () => {
  test("abc/1 and abc/12 are distinct ids", () => {
    expect(formatItemId("abc", "1")).not.toBe(formatItemId("abc", "12"));
  });

  /**
   * The source system comma-joined member ids into one string and
   * substring-matched it, so `abc/1` matched inside `abc/12`. Keying a map by
   * the id makes the lookup exact. AC-4.3 (L351) asserts the rendered
   * consequence; this asserts the property it rests on.
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
