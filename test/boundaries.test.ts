import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");

/**
 * Shipped dashboard source only. The scan reads file *text* looking for banned
 * substrings, so a test file naming what it forbids would match itself — an
 * assertion that fails on its own vocabulary and passes once someone renames a
 * variable proves nothing about the code. The boundary being defended is what
 * Amplify deploys, and that is exactly the non-test tree.
 */
function dashboardSources(): string[] {
  const walk = (dir: string): string[] => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }
    return entries.flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return walk(path);
      return /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) ? [path] : [];
    });
  };

  return [join(repoRoot, "app"), join(repoRoot, "actions")].flatMap(walk);
}

describe("the §8.2 L734 boundary", () => {
  /**
   * "**`lib/pipeline/` holds the single implementation of every stage.** The
   * Lambda handlers are thin wrappers around it... The dashboard does **not**
   * import it — manual triggers call `lambda:InvokeFunction` on the deployed
   * function, so 'run this now' executes the exact deployed artefact."
   *
   * A dashboard that imported a stage would run its *own copy* of that code,
   * bundled by Amplify at a different time from the Lambda artefact. "Run this
   * now" would quietly stop meaning what §8.2 says it means, and every test in
   * this build would still pass.
   */
  test("no dashboard source imports lib/pipeline/", () => {
    const offenders = dashboardSources().filter((path) =>
      /\bfrom\s+["'][^"']*lib\/pipeline\//.test(readFileSync(path, "utf8")),
    );

    expect(offenders).toEqual([]);
  });

  /**
   * §8.1 L707-711 is a deletion, and it is the point of the section: the
   * offline-first layer is gone, "**Removed:** IndexedDB schema and stores, the
   * `downstream`/`since` protocol, `upsertBatch` reconciliation, soft-delete
   * tombstone propagation, `resetDb`, and the client cache-invalidation
   * surface." Each is a named artefact that must not come back.
   */
  test("no dashboard source rebuilds the client cache §8.1 deleted", () => {
    const banned = ["indexedDB", "IDBDatabase", "upsertBatch", "resetDb"];
    const offenders = dashboardSources().flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return banned.filter((token) => source.includes(token)).map((token) => `${path}: ${token}`);
    });

    expect(offenders).toEqual([]);
  });

  /**
   * Both rules above are vacuously true against an empty tree, so they would
   * have passed on the day before the dashboard existed and every day after
   * someone deleted it. This is what makes them mean something.
   */
  test("the dashboard tree exists to be constrained", () => {
    expect(dashboardSources().length).toBeGreaterThan(0);
  });
});
