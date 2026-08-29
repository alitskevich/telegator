import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");

const tsconfig = () =>
  JSON.parse(readFileSync(join(repoRoot, "tsconfig.json"), "utf8")) as {
    include?: string[];
    exclude?: string[];
  };

/**
 * `tsc --noEmit` is one of this build's four gates, and a gate that silently
 * skips part of the tree is the failure mode it exists to prevent.
 *
 * The `include` list used to enumerate directories, and four categories of file
 * were therefore never type-checked at all: a root-level `.ts`, a root-level
 * `.tsx`, any `.tsx` under `test/`, and any `.ts` under `components/`. Four
 * deliberately broken files in those positions produced `tsc` exit 0.
 *
 * These assertions are on the configuration rather than on behaviour because the
 * behaviour costs a full type-check to observe. They fail the moment someone
 * scopes `include` back to directories, which is the regression that matters.
 */
describe("the tsc gate covers the whole tree", () => {
  /**
   * Contains the two wide globs, rather than being exactly them.
   *
   * `next dev` rewrites this file — it adds `.next/types/**` to `include`, sets
   * `jsx`, and expands the formatting — so pinning the array made the tree dirty
   * every time anyone started the dev server, and the guard failed for a reason
   * that had nothing to do with coverage. What matters is that no file is left
   * unchecked, and that survives Next's additions.
   */
  test("include carries the two wide globs, whatever else Next adds", () => {
    const include = tsconfig().include ?? [];

    expect(include).toContain("**/*.ts");
    expect(include).toContain("**/*.tsx");
  });

  /**
   * A directory-scoped entry is the shape the old `include` had, and the one
   * that left four categories of file unchecked. Next only ever adds globs
   * under `.next/`, so anything else scoped to a source directory is a
   * regression rather than tooling.
   */
  test("no include entry narrows the tree to a source directory", () => {
    const narrowing = (tsconfig().include ?? []).filter(
      (pattern) => !pattern.startsWith("**/") && !pattern.startsWith(".next/"),
    );

    expect(narrowing).toEqual([]);
  });

  /**
   * Without these, the widened include drags in every generated artefact:
   * `.next/` alone contains thousands of files, and `cdk.out/` holds bundled
   * Lambda output that was never written to be type-checked.
   */
  test("only build output is excluded", () => {
    const exclude = tsconfig().exclude ?? [];

    for (const directory of ["node_modules", "cdk.out", ".next"]) {
      expect(exclude).toContain(directory);
    }
  });

  /**
   * An exclude naming a source directory would reopen the same hole from the
   * other side, and would look deliberate while doing it.
   */
  test("no source directory is excluded", () => {
    const exclude = tsconfig().exclude ?? [];

    for (const source of [
      "lib",
      "handlers",
      "infra",
      "actions",
      "app",
      "components",
      "scripts",
      "test",
    ]) {
      expect(exclude).not.toContain(source);
      expect(exclude).not.toContain(`${source}/**`);
    }
  });
});
