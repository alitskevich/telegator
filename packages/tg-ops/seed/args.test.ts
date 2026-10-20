import { describe, expect, test } from "vitest";
import { parseReseedArgs, parseSeedArgs } from "./args";

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

describe("parseReseedArgs — §9.5 step 5", () => {
  test("requires --cursors", () => {
    expect(() => parseReseedArgs([])).toThrow(/--cursors/);
  });

  test("reads both spellings", () => {
    expect(parseReseedArgs(["--cursors", "/tmp/c.json"]).cursorsFile).toBe("/tmp/c.json");
    expect(parseReseedArgs(["--cursors=/tmp/c.json"]).cursorsFile).toBe("/tmp/c.json");
  });

  /** Same reasoning as the seed: a cutover step must be read before it is run. */
  test("is a dry run unless --write is given", () => {
    expect(parseReseedArgs(["--cursors", "/tmp/c.json"]).write).toBe(false);
    expect(parseReseedArgs(["--cursors", "/tmp/c.json", "--write"]).write).toBe(true);
  });

  test("rejects an unknown flag", () => {
    expect(() => parseReseedArgs(["--cursors", "/x", "--forse"])).toThrow(/--forse/);
  });
});
