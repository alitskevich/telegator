import { describe, expect, test } from "vitest";
import { DEFAULT_TG_CHANNEL } from "./message";
import {
  DEFAULT_TARGET_TYPE,
  parseTargets,
  resolveTargets,
  TARGET_SEPARATOR,
  TARGET_TYPES,
  TargetConfigInput,
  TargetSchema,
} from "./target";

describe("parseTargets — multi-target#5.3", () => {
  test("MT-1: trims, strips one leading @, drops empties and duplicates, keeps order", () => {
    expect(parseTargets("a, @b,,b , @a")).toEqual(["a", "b"]);
  });

  test("undefined is an empty list", () => {
    expect(parseTargets(undefined)).toEqual([]);
  });

  test("a single id needs no separator", () => {
    expect(parseTargets("@only")).toEqual(["only"]);
  });

  test("only one @ is stripped, so a doubled one stays visible", () => {
    expect(parseTargets("@@odd")).toEqual(["@odd"]);
  });

  test("the separator is a comma (multi-target#2.1)", () => {
    expect(TARGET_SEPARATOR).toBe(",");
  });
});

describe("resolveTargets — multi-target#5.3", () => {
  test("MT-2: undefined and a blank list fall back to the default channel", () => {
    expect(resolveTargets(undefined)).toEqual([DEFAULT_TG_CHANNEL]);
    expect(resolveTargets(" , ")).toEqual([DEFAULT_TG_CHANNEL]);
  });

  test("a non-empty list is returned as parsed", () => {
    expect(resolveTargets("a,b")).toEqual(["a", "b"]);
  });

  test("the default channel itself parses to itself", () => {
    expect(resolveTargets(`@${DEFAULT_TG_CHANNEL}`)).toEqual([DEFAULT_TG_CHANNEL]);
  });
});

describe("TargetSchema — target-table#2.2", () => {
  test("TT-1: a bare id parses with the default type and no template", () => {
    const row = TargetSchema.parse({ id: "a" });

    expect(row).toEqual({ id: "a", type: DEFAULT_TARGET_TYPE });
    expect(row.messageTemplate).toBeUndefined();
  });

  test("TT-1: an unknown type fails to parse", () => {
    expect(() => TargetSchema.parse({ id: "a", type: "sms" })).toThrow();
  });

  test("the enum has exactly the one member the draft names (D2)", () => {
    expect(TARGET_TYPES).toEqual(["telegram_channel"]);
    expect(TARGET_TYPES).toContain(DEFAULT_TARGET_TYPE);
  });

  test("carries the two mirror fields, the template and the soft-delete flag", () => {
    const row = TargetSchema.parse({
      id: "a",
      type: "telegram_channel",
      lastPostedDate: "2026-09-08T10:00:00.000Z",
      lastPostedMessageId: "chan_a/1",
      messageTemplate: "{header}\n\n{body}",
      deleted: true,
    });

    expect(row.lastPostedDate).toBe("2026-09-08T10:00:00.000Z");
    expect(row.lastPostedMessageId).toBe("chan_a/1");
    expect(row.messageTemplate).toBe("{header}\n\n{body}");
    expect(row.deleted).toBe(true);
  });

  test("an empty id is not a row anything can address", () => {
    expect(() => TargetSchema.parse({ id: "" })).toThrow();
  });
});

describe("TargetConfigInput — target-table#2.2", () => {
  test("TT-2: accepts either operator-writable field, and both", () => {
    expect(TargetConfigInput.parse({ type: "telegram_channel" })).toEqual({
      type: "telegram_channel",
    });
    expect(TargetConfigInput.parse({ messageTemplate: "{body}" })).toEqual({
      messageTemplate: "{body}",
    });
    expect(
      TargetConfigInput.parse({ type: "telegram_channel", messageTemplate: "{body}" }),
    ).toEqual({ type: "telegram_channel", messageTemplate: "{body}" });
  });

  test.each([
    { lastPostedDate: "2026-09-08T10:00:00.000Z" },
    { lastPostedMessageId: "chan_a/1" },
    { id: "b" },
    {},
  ])("TT-2: rejects %o", (delta) => {
    expect(() => TargetConfigInput.parse(delta)).toThrow();
  });

  test("TT-2: rejects a type outside the enum", () => {
    expect(() => TargetConfigInput.parse({ type: "sms" })).toThrow();
  });
});
