import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * A static import graph, used to enforce §8.2 L734 transitively.
 *
 * The first version of `test/boundaries.test.ts` read each file's own text, so a
 * dashboard file importing a module that itself imports `lib/pipeline/` passed —
 * which is exactly what nearly happened through `handlers/dlqReplay.ts` in item
 * 5.10. What ships in a bundle is the transitive closure, so that is what the
 * boundary has to be measured over.
 *
 * Deliberately not a real resolver: it handles the forms this repository uses —
 * extensionless relative specifiers — and records everything else as a package
 * name. A specifier it cannot resolve is ignored rather than thrown on, so an
 * unrelated refactor cannot turn this into a failing gate for the wrong reason.
 */

/**
 * `import`/`export ... from "x"`, side-effect `import "x"`, and `import("x")`.
 *
 * `import type` is excluded: it is erased at build time, so it carries nothing
 * into a bundle, and counting it would forbid the dashboard from naming a
 * pipeline *type* — a restriction §8.2 L734 does not ask for.
 */
const SPECIFIER_PATTERNS = [
  /\bimport\s+type\s[^"']*?from\s*["']([^"']+)["']/g,
  /\bexport\s+type\s[^"']*?from\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\bimport\s+(?!type\s)[^"';]*?from\s*["']([^"']+)["']/g,
  /\bexport\s+(?!type\s)[^"';]*?from\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
] as const;

/** The two patterns above that describe type-only edges. */
const TYPE_ONLY_PATTERN_COUNT = 2;

function specifiersIn(source: string): string[] {
  const found = new Set<string>();
  const typeOnly = new Set<string>();

  SPECIFIER_PATTERNS.forEach((pattern, index) => {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      if (index < TYPE_ONLY_PATTERN_COUNT) typeOnly.add(specifier);
      else found.add(specifier);
    }
  });

  // A specifier imported both for types and for values is a value edge.
  for (const specifier of typeOnly) if (!found.has(specifier)) typeOnly.delete(specifier);

  return [...found];
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * Resolve a relative specifier to a file on disk.
 *
 * Imports are written `./x` for a file that is `x.ts` on disk, because Turbopack
 * does not substitute an extension; `.tsx` covers the components of §8.5.
 *
 * The `.js` branch stays. A specifier written the old way has to be *found* by
 * this scan rather than silently skipped — a skipped edge is a hole in the §8.2
 * L734 boundary, and forbidding the form is `test/importExtensions.test.ts`'s
 * job, not this one's.
 */
function resolveRelative(fromFile: string, specifier: string): string | undefined {
  const base = resolve(dirname(fromFile), specifier);
  const withoutJs = base.replace(/\.js$/, "");

  const candidates = [
    base,
    `${withoutJs}.ts`,
    `${withoutJs}.tsx`,
    `${base}.ts`,
    `${base}.tsx`,
    resolve(base, "index.ts"),
    resolve(base, "index.tsx"),
  ];

  return candidates.find(isFile);
}

/** `@scope/name` keeps both segments; `next/headers` collapses to `next`. */
function packageNameOf(specifier: string): string {
  const segments = specifier.split("/");
  if (specifier.startsWith("@")) return segments.slice(0, 2).join("/");
  return segments[0] ?? specifier;
}

export interface ModuleGraph {
  /** Every file reachable from the entries, including the entries themselves. */
  readonly files: ReadonlySet<string>;
  /** Every package name reachable from them. */
  readonly packages: ReadonlySet<string>;
}

export function reachableFrom(entries: readonly string[]): ModuleGraph {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [...entries];

  while (queue.length > 0) {
    const file = queue.pop();
    // Visited check doubles as the cycle guard: a ↔ b terminates.
    if (file === undefined || files.has(file) || !isFile(file)) continue;
    files.add(file);

    for (const specifier of specifiersIn(readFileSync(file, "utf8"))) {
      if (specifier.startsWith(".")) {
        const resolved = resolveRelative(file, specifier);
        // An unresolvable relative specifier is ignored: a missing file is
        // tsc's complaint, not this gate's.
        if (resolved !== undefined) queue.push(resolved);
        continue;
      }

      if (specifier.startsWith("node:")) continue;
      packages.add(packageNameOf(specifier));
    }
  }

  return { files, packages };
}
