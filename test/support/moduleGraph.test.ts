import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { isolatedOutdir, removeIsolatedOutdirs } from "./cdkOutdir.js";

afterAll(removeIsolatedOutdirs);

import { reachableFrom } from "./moduleGraph.js";

/** Builds a throwaway module tree, so the resolver is tested on real files. */
function tree(files: Record<string, string>): { root: string; path: (name: string) => string } {
  const root = isolatedOutdir("telegator-graph-");

  for (const [name, source] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
  }

  return { root, path: (name: string) => join(root, name) };
}

describe("reachableFrom", () => {
  test("includes the entry itself", () => {
    const t = tree({ "a.ts": "export const a = 1;" });
    expect(reachableFrom([t.path("a.ts")]).files).toContain(t.path("a.ts"));
  });

  /**
   * The whole point of item 5.10a. A text scan of `a.ts` sees only `b.js`; the
   * violation is one hop further on, which is exactly how `handlers/dlqReplay.ts`
   * nearly carried `lib/pipeline/` into the dashboard bundle.
   */
  test("follows imports transitively", () => {
    const t = tree({
      "a.ts": 'import { b } from "./b.js";\nexport const a = b;',
      "b.ts": 'import { c } from "./nested/c.js";\nexport const b = c;',
      "nested/c.ts": "export const c = 1;",
    });

    expect(reachableFrom([t.path("a.ts")]).files).toContain(t.path("nested/c.ts"));
  });

  /** ESM in this repo writes `.js` for files that are `.ts` on disk. */
  test("resolves a .js specifier to the .ts on disk", () => {
    const t = tree({ "a.ts": 'import "./b.js";', "b.ts": "export const b = 1;" });
    expect(reachableFrom([t.path("a.ts")]).files).toContain(t.path("b.ts"));
  });

  test("resolves a .js specifier to a .tsx on disk", () => {
    const t = tree({
      "a.ts": 'import "./Comp.js";',
      "Comp.tsx": "export const Comp = () => null;",
    });
    expect(reachableFrom([t.path("a.ts")]).files).toContain(t.path("Comp.tsx"));
  });

  test("survives a cycle rather than recursing forever", () => {
    const t = tree({ "a.ts": 'import "./b.js";', "b.ts": 'import "./a.js";' });
    expect(reachableFrom([t.path("a.ts")]).files.size).toBe(2);
  });

  test("a specifier that resolves to nothing is ignored, not thrown on", () => {
    const t = tree({ "a.ts": 'import "./missing.js";' });
    expect(() => reachableFrom([t.path("a.ts")])).not.toThrow();
  });

  describe("import forms", () => {
    test("named, default, side-effect, star and re-export are all followed", () => {
      const t = tree({
        "a.ts": [
          'import { one } from "./one.js";',
          'import two from "./two.js";',
          'import "./three.js";',
          'import * as four from "./four.js";',
          'export { five } from "./five.js";',
          'export * from "./six.js";',
          "export const a = [one, two, four, five];",
        ].join("\n"),
        "one.ts": "export const one = 1;",
        "two.ts": "export default 2;",
        "three.ts": "export const three = 3;",
        "four.ts": "export const four = 4;",
        "five.ts": "export const five = 5;",
        "six.ts": "export const six = 6;",
      });

      const { files } = reachableFrom([t.path("a.ts")]);
      for (const name of ["one", "two", "three", "four", "five", "six"]) {
        expect(files).toContain(t.path(`${name}.ts`));
      }
    });

    /** `next/dynamic` and route-level code splitting both produce these. */
    test("a dynamic import is followed", () => {
      const t = tree({
        "a.ts": 'export const load = () => import("./lazy.js");',
        "lazy.ts": "export const lazy = 1;",
      });

      expect(reachableFrom([t.path("a.ts")]).files).toContain(t.path("lazy.ts"));
    });

    /** `import type` is erased at build time and carries nothing into a bundle. */
    test("a type-only import is not a dependency", () => {
      const t = tree({
        "a.ts": 'import type { T } from "./types.js";\nexport type A = T;',
        "types.ts": "export type T = 1;",
      });

      expect(reachableFrom([t.path("a.ts")]).files).not.toContain(t.path("types.ts"));
    });
  });

  describe("packages", () => {
    test("records bare specifiers", () => {
      const t = tree({ "a.ts": 'import { z } from "zod";\nexport const a = z;' });
      expect(reachableFrom([t.path("a.ts")]).packages).toContain("zod");
    });

    test("records a scoped package by its full name", () => {
      const t = tree({ "a.ts": 'import "@aws-sdk/client-sqs";' });
      expect(reachableFrom([t.path("a.ts")]).packages).toContain("@aws-sdk/client-sqs");
    });

    test("records a subpath import under its package", () => {
      const t = tree({
        "a.ts": 'import { cookies } from "next/headers";\nexport const c = cookies;',
      });
      expect(reachableFrom([t.path("a.ts")]).packages).toContain("next");
    });

    /** A package reached two hops away is still in the bundle. */
    test("records packages found transitively", () => {
      const t = tree({
        "a.ts": 'import "./b.js";',
        "b.ts": 'import { App } from "aws-cdk-lib";\nexport const b = App;',
      });

      expect(reachableFrom([t.path("a.ts")]).packages).toContain("aws-cdk-lib");
    });
  });
});
