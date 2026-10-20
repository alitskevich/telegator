import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");

/**
 * R62 — §8.2 L782–790's `lib/` directories, as npm workspaces under
 * `packages/`. The tree is still not decoration: `tg-pipeline` is the single
 * implementation of every stage, with the Lambda handlers as thin wrappers
 * beside it, and a second copy of a stage growing anywhere else is the failure
 * this layout exists to prevent.
 */
const PACKAGES = [
  "tg-enums",
  "tg-rc",
  "tg-configs",
  "tg-utils",
  "tg-domain",
  "tg-ports",
  "tg-dedup",
  "tg-aws",
  "tg-ai",
  "tg-telegram",
  "tg-auth",
  "tg-pipeline",
  "tg-actions",
  "tg-web",
  "tg-infra",
  "tg-mcp",
  "tg-ops",
];

/** What stays at the root: the operator entry points and the cross-cutting suite. */
const ROOT_DIRS = ["scripts", "test/fakes", "test/fixtures", "test/support"];

/** The flat layout R62 replaced. A file landing here would be outside every workspace. */
const RETIRED_DIRS = ["lib", "handlers", "actions", "app", "components", "infra", "src"];

const isDirectory = (relative: string): boolean => {
  const absolute = resolve(repoRoot, relative);
  return existsSync(absolute) && statSync(absolute).isDirectory();
};

interface Manifest {
  readonly name: string;
  readonly dependencies?: Record<string, string>;
}

const manifest = (name: string): Manifest =>
  JSON.parse(readFileSync(resolve(repoRoot, "packages", name, "package.json"), "utf8"));

describe("repository layout", () => {
  test.each(PACKAGES)("packages/%s is a workspace of that name", (name) => {
    expect(manifest(name).name).toBe(name);
  });

  test("every directory under packages/ is a listed workspace", () => {
    const found = readdirSync(resolve(repoRoot, "packages")).filter((entry) =>
      isDirectory(`packages/${entry}`),
    );

    expect(found.sort()).toEqual([...PACKAGES].sort());
  });

  test.each(ROOT_DIRS)("%s stays at the root", (dir) => {
    expect(isDirectory(dir)).toBe(true);
  });

  test.each(RETIRED_DIRS)("there is no %s/ at the root", (dir) => {
    expect(isDirectory(dir)).toBe(false);
  });
});

describe("the package graph (R62)", () => {
  /**
   * Runtime dependencies only: a cycle between workspaces means neither can be
   * understood, built or tested without the other, which is what splitting
   * them was for. A test may reach upward — its `devDependencies` are excluded.
   */
  test("has no cycle", () => {
    const visiting = new Set<string>();
    const done = new Set<string>();
    const cycles: string[] = [];

    const visit = (name: string, path: readonly string[]): void => {
      if (done.has(name)) return;
      if (visiting.has(name)) {
        cycles.push([...path.slice(path.indexOf(name)), name].join(" → "));
        return;
      }
      visiting.add(name);
      for (const dependency of Object.keys(manifest(name).dependencies ?? {})) {
        if (PACKAGES.includes(dependency)) visit(dependency, [...path, name]);
      }
      visiting.delete(name);
      done.add(name);
    };

    for (const name of PACKAGES) visit(name, []);

    expect(cycles).toEqual([]);
  });

  /**
   * Across packages by name, inside one relatively (§28). A `../../tg-x/…`
   * path compiles everywhere and quietly bypasses the manifest, so the edge
   * goes undeclared and the cycle check above never sees it.
   */
  test("no source reaches another package by a relative path", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        if (entry === "node_modules" || entry === ".next") return [];
        const path = resolve(dir, entry);
        if (statSync(path).isDirectory()) return walk(path);
        return /\.tsx?$/.test(entry) ? [path] : [];
      });

    const offenders = PACKAGES.flatMap((name) => {
      const root = resolve(repoRoot, "packages", name);
      return walk(root).flatMap((file) =>
        [...readFileSync(file, "utf8").matchAll(/\bfrom\s*["'](\.\.?\/[^"']+)["']/g)]
          .map((match) => resolve(dirname(file), match[1] ?? ""))
          .filter((target) => target.startsWith(resolve(repoRoot, "packages")))
          .filter((target) => !target.startsWith(`${root}/`))
          .map((target) => `${relative(repoRoot, file)} → ${relative(repoRoot, target)}`),
      );
    });

    expect(offenders).toEqual([]);
  });

  /** One export map for all, and no root entry: nothing can import a barrel. */
  test.each(PACKAGES.filter((name) => name !== "tg-web"))(
    "%s exports its files and nothing else",
    (name) => {
      const { exports } = JSON.parse(
        readFileSync(resolve(repoRoot, "packages", name, "package.json"), "utf8"),
      );

      expect(exports).toEqual({ "./*": "./*.ts" });
    },
  );

  /** §8.2 L792 at package level: only the Lambda bundles may contain a stage. */
  test("no workspace depends on tg-pipeline", () => {
    const dependents = PACKAGES.filter(
      (name) => manifest(name).dependencies?.["tg-pipeline"] !== undefined,
    );

    expect(dependents).toEqual([]);
  });
});

describe("the nav (target-table#3.2)", () => {
  /** A page nothing links to is a page nobody finds. */
  test("TT-22: lists Targets between Sources and Messages", () => {
    const layout = readFileSync(resolve(repoRoot, "packages/tg-web/app/layout.tsx"), "utf8");
    const order = ["/sources", "/targets", "/messages"].map((href) =>
      layout.indexOf(`href: "${href}"`),
    );

    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
