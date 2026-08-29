import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");

/**
 * Every source directory that ends up in a bundle or a type-check, minus the
 * tests.
 *
 * Non-test only, for the reason `test/boundaries.test.ts` gives about its own
 * scan: this reads file *text* looking for a banned substring, and a test that
 * names what it forbids matches itself. It is also the honest scope — the rule
 * below exists because of what a bundler does to shipped code, and no bundler
 * ever sees a `.test.ts`.
 */
function shippedSources(): string[] {
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

  return ["app", "actions", "components", "lib", "handlers", "infra", "scripts"]
    .map((directory) => join(repoRoot, directory))
    .flatMap(walk);
}

/**
 * `import`/`export ... from "x"`, side-effect `import "x"`, and `import("x")` —
 * the same forms `test/support/moduleGraph.ts` reads, including `import type`,
 * which is erased at build time but still has to resolve for `tsc`.
 */
const SPECIFIER_PATTERNS = [
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s[^"';]*?from\s*["']([^"']+)["']/g,
  /\bexport\s[^"';]*?from\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
] as const;

function relativeSpecifiersIn(source: string): string[] {
  const found = new Set<string>();

  for (const pattern of SPECIFIER_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier?.startsWith(".")) found.add(specifier);
    }
  }

  return [...found];
}

describe("relative import specifiers carry no extension", () => {
  /**
   * The dashboard is bundled by Turbopack, and Turbopack does not perform
   * TypeScript's extension substitution: `"../lib/clock.js"` is looked up as
   * that literal path, which does not exist, and every route 500s with
   * `Module not found`.
   *
   * This was invisible for the whole build because the other four consumers of
   * this source all *do* substitute — `tsc` under `moduleResolution: "bundler"`,
   * Vite under vitest, esbuild under `NodejsFunction`, and tsx under
   * `cdk synth`. All four gates were green against an app that could not serve
   * a single page.
   *
   * Turbopack offers no way back: its `tsconfig.json` support is `paths` and
   * `baseUrl`, `resolveAlias` and `resolveExtensions` are next.config options
   * for other problems, and `experimental.extensionAlias` — webpack's answer —
   * is on Turbopack's explicit unsupported list. Extensionless is what
   * `moduleResolution: "bundler"` means, and it is what every one of the five
   * resolvers accepts.
   */
  test("no shipped source imports a relative path with a .js extension", () => {
    const offenders = shippedSources().flatMap((path) =>
      relativeSpecifiersIn(readFileSync(path, "utf8"))
        .filter((specifier) => /\.[cm]?js$/.test(specifier))
        .map((specifier) => `${relative(repoRoot, path)} → ${specifier}`),
    );

    expect(offenders).toEqual([]);
  });

  /**
   * The other half of the same rule. `moduleResolution: "bundler"` also permits
   * `"../lib/clock.ts"`, which `tsc` rejects without `allowImportingTsExtensions`
   * and which no bundler here would keep in an emitted specifier — a second way
   * to write a path that resolves in one tool and not the next.
   */
  test("nor one with a .ts or .tsx extension", () => {
    const offenders = shippedSources().flatMap((path) =>
      relativeSpecifiersIn(readFileSync(path, "utf8"))
        .filter((specifier) => /\.tsx?$/.test(specifier))
        .map((specifier) => `${relative(repoRoot, path)} → ${specifier}`),
    );

    expect(offenders).toEqual([]);
  });
});
