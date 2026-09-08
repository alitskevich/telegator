import { describe, expect, test } from "vitest";
import { DEFAULT_TG_CHANNEL } from "./message";
import { parseTargets, resolveTargets, TARGET_SEPARATOR } from "./target";

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
