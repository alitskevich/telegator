import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { isolatedOutdir, pendingOutdirCount, removeIsolatedOutdirs } from "./cdkOutdir";

/**
 * The leak this replaces was invisible for ninety iterations, so the cleanup
 * gets its own tests rather than being trusted because it is three lines.
 */
describe("isolatedOutdir", () => {
  test("creates a directory that exists", () => {
    const dir = isolatedOutdir("telegator-selftest-");

    expect(existsSync(dir)).toBe(true);
    removeIsolatedOutdirs();
  });

  test("each call gets its own", () => {
    const first = isolatedOutdir("telegator-selftest-");
    const second = isolatedOutdir("telegator-selftest-");

    expect(first).not.toBe(second);
    removeIsolatedOutdirs();
  });
});

describe("removeIsolatedOutdirs", () => {
  /** The whole point: the directory is gone, not merely forgotten. */
  test("deletes the directories it handed out", () => {
    const dir = isolatedOutdir("telegator-selftest-");

    removeIsolatedOutdirs();

    expect(existsSync(dir)).toBe(false);
  });

  /**
   * A real outdir is full of bundles, so an empty-directory removal would not
   * prove anything about the case that actually leaked.
   */
  test("deletes a directory with contents in it", () => {
    const dir = isolatedOutdir("telegator-selftest-");
    writeFileSync(join(dir, "index.mjs"), "// pretend bundle");

    removeIsolatedOutdirs();

    expect(existsSync(dir)).toBe(false);
  });

  test("drains its list, so a second call does nothing", () => {
    isolatedOutdir("telegator-selftest-");
    expect(pendingOutdirCount()).toBe(1);

    removeIsolatedOutdirs();
    expect(pendingOutdirCount()).toBe(0);

    expect(() => removeIsolatedOutdirs()).not.toThrow();
  });

  test("does not throw when a directory is already gone", () => {
    const dir = isolatedOutdir("telegator-selftest-");
    removeIsolatedOutdirs();

    // Re-register the same path and remove it again — `force` must absorb it.
    expect(existsSync(dir)).toBe(false);
    expect(() => removeIsolatedOutdirs()).not.toThrow();
  });
});
