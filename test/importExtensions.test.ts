import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");

/**
 * Every shipped source file. Tests are left out: a scan that names what it
 * forbids would match itself, and no bundler sees a `.test.ts`.
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
      // Installed packages and generated files are not source anyone wrote.
      if (["node_modules", ".next", "next-env.d.ts"].includes(entry)) return [];
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return walk(path);
      return /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path) ? [path] : [];
    });
  };

  return ["packages", "scripts"].map((directory) => join(repoRoot, directory)).flatMap(walk);
}

/**
 * `import`/`export ... from "x"`, side-effect `import "x"`, and `import("x")`,
 * including `import type`, which must still resolve for `tsc`.
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
   * A bundler that does not map `.js` to `.ts` looks the path up literally and
   * fails at runtime while every gate stays green. Extensionless is the one form
   * every resolver here accepts.
   */
  test("no shipped source imports a relative path with a .js extension", () => {
    const offenders = shippedSources().flatMap((path) =>
      relativeSpecifiersIn(readFileSync(path, "utf8"))
        .filter((specifier) => /\.[cm]?js$/.test(specifier))
        .map((specifier) => `${relative(repoRoot, path)} → ${specifier}`),
    );

    expect(offenders).toEqual([]);
  });

  /** `"./clock.ts"` resolves in the bundler but `tsc` rejects it without `allowImportingTsExtensions`. */
  test("nor one with a .ts or .tsx extension", () => {
    const offenders = shippedSources().flatMap((path) =>
      relativeSpecifiersIn(readFileSync(path, "utf8"))
        .filter((specifier) => /\.tsx?$/.test(specifier))
        .map((specifier) => `${relative(repoRoot, path)} → ${specifier}`),
    );

    expect(offenders).toEqual([]);
  });
});
