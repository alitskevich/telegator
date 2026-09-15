import { describe, expect, test } from "vitest";
import { canonicalId } from "./ids";

describe("canonicalId", () => {
  test("strips one leading @ and trims whitespace", () => {
    expect(canonicalId("@a")).toBe("a");
    expect(canonicalId(" a ")).toBe("a");
    expect(canonicalId("a")).toBe("a");
  });

  test("rejects an empty value, and the message names it", () => {
    expect(() => canonicalId("")).toThrow("not a single id: ");
  });

  test("rejects a bare @, and the message names it", () => {
    expect(() => canonicalId("@")).toThrow("not a single id: @");
  });

  test("rejects a separator with nothing either side, and the message names it", () => {
    expect(() => canonicalId(" , ")).toThrow("not a single id:  , ");
  });

  test("rejects a value with more than one id, and the message names it", () => {
    expect(() => canonicalId("a,b")).toThrow("not a single id: a,b");
  });
});
