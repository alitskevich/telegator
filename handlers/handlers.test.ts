import { describe, expect, test } from "vitest";

/**
 * §8.2 L734 makes `lib/pipeline/` the single implementation of every stage and
 * the handlers thin wrappers. These tests assert the wrapper contract only —
 * the stage behaviour is covered where the stage lives.
 */
describe("Lambda entry points", () => {
  /**
   * Importing a handler must not construct an AWS client or read a variable.
   * A Lambda's module scope runs during a cold start, before the invocation
   * that would report the failure — so an eager client turns a missing
   * environment variable into an init crash with no stage context, and makes
   * the module unimportable in a test process at all.
   */
  test.each([
    ["scrape", () => import("./scrape")],
    ["analyze", () => import("./analyze")],
    ["aggregate", () => import("./aggregate")],
    ["publish", () => import("./publish")],
    ["dlqReplay", () => import("./dlqReplay")],
  ])("%s imports without any environment configured", async (_name, load) => {
    await expect(load()).resolves.toBeDefined();
  });

  test.each([
    ["scrape", async () => (await import("./scrape")).handler],
    ["analyze", async () => (await import("./analyze")).handler],
    ["aggregate", async () => (await import("./aggregate")).handler],
    ["publish", async () => (await import("./publish")).handler],
    ["dlqReplay", async () => (await import("./dlqReplay")).handler],
  ])("%s exports a handler function for the CDK entry point", async (_name, load) => {
    expect(typeof (await load())).toBe("function");
  });

  /**
   * The boundary §8.2 L734 draws: a handler wires adapters to a stage and holds
   * no stage logic of its own.
   */
  test.each(["scrape", "analyze", "aggregate", "publish", "dlqReplay"])(
    "%s handler is a thin wrapper",
    async (name) => {
      const { readFileSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const source = readFileSync(resolve(import.meta.dirname, `${name}.ts`), "utf8");

      // A stage's decisions live in lib/pipeline/; a handler that reimplemented
      // one would need these.
      expect(source).not.toMatch(/\bif \(.*status\b/);
      expect(source).not.toContain("MERGE_THRESHOLD");
    },
  );
});
