import { describe, expect, test } from "vitest";
import { parseSeedArgs } from "./args.js";

describe("parseSeedArgs — R21", () => {
  /**
   * The export lives outside this repository, so there is no default that could
   * be right. A seed that silently found nothing would look like a successful
   * migration of an empty file.
   */
  test("requires --data-dir", () => {
    expect(() => parseSeedArgs([])).toThrow(/--data-dir/);
  });

  test("reads --data-dir value", () => {
    expect(parseSeedArgs(["--data-dir", "/tmp/export"]).dataDir).toBe("/tmp/export");
  });

  test("reads --data-dir=value", () => {
    expect(parseSeedArgs(["--data-dir=/tmp/export"]).dataDir).toBe("/tmp/export");
  });

  test("rejects --data-dir with no value", () => {
    expect(() => parseSeedArgs(["--data-dir"])).toThrow(/--data-dir/);
    expect(() => parseSeedArgs(["--data-dir="])).toThrow(/--data-dir/);
  });

  /**
   * A migration that writes before anyone has read the diff is hard to undo, so
   * the safe mode is the one you have to opt out of.
   */
  test("is a dry run unless --write is given", () => {
    expect(parseSeedArgs(["--data-dir", "/tmp/export"]).write).toBe(false);
    expect(parseSeedArgs(["--data-dir", "/tmp/export", "--write"]).write).toBe(true);
  });

  /** A typo must not be read as "no flag" and quietly change what runs. */
  test("rejects an unknown flag", () => {
    expect(() => parseSeedArgs(["--data-dir", "/x", "--wirte"])).toThrow(/--wirte/);
  });
});
