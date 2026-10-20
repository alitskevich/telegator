import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { cmlIndexSource } from "tg-ops/web/cml";
import { describe, expect, test } from "vitest";

const web = resolve(import.meta.dirname, "../packages/tg-web");

function templates(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return templates(path);
    return entry.endsWith(".xml") ? [path] : [];
  });
}

/**
 * A template missing from the generated registry renders silently as an
 * unknown-tag stub. `scripts/web.ts` regenerates it on every build; this
 * catches a checked-in copy that was not rebuilt after a template moved.
 */
describe("the console's CML registry", () => {
  test("src/index.cml.ts lists exactly the templates on disk", () => {
    const files = templates(join(web, "cml")).map((file) => relative(join(web, "src"), file));

    expect(readFileSync(join(web, "src/index.cml.ts"), "utf8")).toBe(cmlIndexSource(files));
  });

  /** Every service a template mounts is registered, or its tag is an unknown stub too. */
  test("every service a template mounts is registered", () => {
    const registry = readFileSync(join(web, "src/components.ts"), "utf8");
    const mounted = new Set(
      templates(join(web, "cml")).flatMap((file) =>
        [...readFileSync(file, "utf8").matchAll(/<(\w+Service)\b/g)].map((match) => match[1]),
      ),
    );
    const platform = new Set([
      "ToastService",
      "NavigationService",
      "BrowserService",
      "FirebaseService",
    ]);

    for (const service of mounted) {
      if (service !== undefined && !platform.has(service)) expect(registry).toContain(service);
    }
  });
});
