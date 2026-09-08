import { describe, expect, test } from "vitest";
import { legacyTargetPatch } from "./targets";

describe("legacyTargetPatch — multi-target#3.7, #8.2", () => {
  test("MT-21: a row with tgChannel and no target is patched", () => {
    expect(legacyTargetPatch({ id: "a", tgChannel: "x" })).toEqual({ target: "x" });
  });

  test("MT-21: a row that already has target is left alone", () => {
    expect(legacyTargetPatch({ id: "a", tgChannel: "x", target: "y" })).toBeUndefined();
  });

  test("MT-21: a row with neither is left alone", () => {
    expect(legacyTargetPatch({ id: "a" })).toBeUndefined();
  });

  /** Plan ruling P5 — a cleared target still published from tgChannel under the old code. */
  test("an empty target counts as absent", () => {
    expect(legacyTargetPatch({ id: "a", tgChannel: "x", target: "" })).toEqual({ target: "x" });
  });

  test("a non-string or empty tgChannel is nothing to copy", () => {
    expect(legacyTargetPatch({ id: "a", tgChannel: 7 })).toBeUndefined();
    expect(legacyTargetPatch({ id: "a", tgChannel: "" })).toBeUndefined();
  });

  test("a non-object row is nothing to copy", () => {
    expect(legacyTargetPatch(null)).toBeUndefined();
    expect(legacyTargetPatch("row")).toBeUndefined();
  });
});
