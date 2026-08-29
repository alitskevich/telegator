import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { isolatedOutdir, removeIsolatedOutdirs } from "./support/cdkOutdir.js";

afterAll(removeIsolatedOutdirs);

import { reachableFrom } from "./support/moduleGraph.js";

const repoRoot = resolve(import.meta.dirname, "..");

const under = (path: string, directory: string) => path.startsWith(join(repoRoot, directory));

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
   * The same rule over the transitive closure, which is what actually ships.
   *
   * The direct check above passes for a dashboard file that imports a module
   * which itself imports a stage — and that is not hypothetical: in item 5.10,
   * `REPLAYABLE_QUEUES` lived in `handlers/dlqReplay.ts`, one hop from
   * `lib/pipeline/dlqReplay.ts`. A bundle contains the closure, so the boundary
   * has to be measured over it.
   */
  test("nothing reachable from the dashboard is a pipeline stage", () => {
    const reached = [...reachableFrom(dashboardSources()).files].filter((path) =>
      under(path, "lib/pipeline"),
    );

    expect(reached).toEqual([]);
  });

  /**
   * The detector must be able to fail, or the assertion above is a statement
   * about the resolver rather than about this repository. A file that violates
   * the rule is written to a temporary directory instead of committed, because a
   * committed one would be a real violation the moment someone widened a glob.
   */
  test("and the rule would catch a violation", () => {
    const scratch = isolatedOutdir("telegator-boundary-");
    const offender = join(scratch, "page.tsx");
    // A relative specifier, because that is the form the resolver handles and
    // the form real source uses. Writing an absolute path here made this test
    // pass vacuously on its first run — the resolver read it as a package name.
    const stage = relative(scratch, join(repoRoot, "lib/pipeline/scrape/index.js"));
    writeFileSync(offender, `import { runScrape } from "${stage}";\nexport default runScrape;\n`);

    const reached = [...reachableFrom([offender]).files].filter((path) =>
      under(path, "lib/pipeline"),
    );

    expect(reached.length).toBeGreaterThan(0);
  });

  /**
   * §9.3 L814 deploys this on Amplify. A CDK import would pull the whole
   * construct library into the server bundle to read a constant — which is what
   * `actions/context.ts` briefly did in item 5.10 for `DASHBOARD_ENV_VARS`, and
   * what moving `ROLE_GROUPS` avoided in item 5.2.
   */
  test("no infrastructure library is reachable from the dashboard", () => {
    const { packages } = reachableFrom(dashboardSources());

    expect([...packages].filter((name) => name.startsWith("aws-cdk-lib"))).toEqual([]);
    expect([...packages].filter((name) => name.startsWith("@aws-cdk/"))).toEqual([]);
    expect(packages.has("constructs")).toBe(false);
  });

  /**
   * A closure no larger than its entries means the resolver stopped resolving,
   * and every assertion above would pass while checking nothing.
   */
  test("the closure actually reaches past the entry files", () => {
    const entries = dashboardSources();
    const { files } = reachableFrom(entries);

    expect(files.size).toBeGreaterThan(entries.length);
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
