import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");

/**
 * §8.2 L725–732 names these five directories. The tree is not decoration: §8.2
 * makes `lib/pipeline/` the single implementation of every stage, with the
 * Lambda handlers as thin wrappers over it. A second copy of a stage growing
 * inside `handlers/` is the failure this layout exists to prevent.
 */
const SPEC_LIB_DIRS = ["lib/db", "lib/queues", "lib/pipeline", "lib/telegram", "lib/ai"];

/** Extensions this build adds, recorded in the Phase 0 conventions. */
const BUILD_DIRS = [
  "lib/domain",
  "lib/dedup",
  "lib/metrics",
  "lib/logging",
  "handlers",
  "actions",
  "scripts",
  "test/fakes",
  "test/fixtures",
];

const isDirectory = (relative: string): boolean => {
  const absolute = resolve(repoRoot, relative);
  return existsSync(absolute) && statSync(absolute).isDirectory();
};

describe("repository layout", () => {
  test.each(SPEC_LIB_DIRS)("§8.2 requires %s", (dir) => {
    expect(isDirectory(dir)).toBe(true);
  });

  test.each(BUILD_DIRS)("the Phase 0 conventions require %s", (dir) => {
    expect(isDirectory(dir)).toBe(true);
  });

  test("there is no src/ — §8.2 puts library code under lib/", () => {
    expect(isDirectory("src")).toBe(false);
  });
});
