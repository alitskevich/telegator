import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");
const appRoot = join(repoRoot, "app");

/**
 * Every rendered page must authorise, and this is checked structurally because
 * the alternative failed: `app/page.tsx` shipped in item 5.11 with no check at
 * all, rendering live pipeline data to anyone, while the other three pages each
 * called `requireRole`. Nothing caught it — the page's own tests exercised the
 * data load, which takes no session, and the boundary tests only looked at
 * imports.
 *
 * A per-page rule catches the *next* omission rather than only this one. It is a
 * source scan, which is weak in general but exact here: a page either contains
 * the call or it does not, and there is no way to render a page without one.
 */
function pageFiles(): string[] {
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
      return /(^|\/)page\.tsx$/.test(path) ? [path] : [];
    });
  };

  return walk(appRoot);
}

describe("every page authorises (§8.6 L790)", () => {
  /** The rule is worthless if it is scanning nothing. */
  test("finds the pages", () => {
    const pages = pageFiles().map((path) => relative(repoRoot, path));

    expect(pages).toContain("app/page.tsx");
    expect(pages.length).toBeGreaterThanOrEqual(4);
  });

  /**
   * §8.6 L783 gives `viewer` "Read all pages" — which is a grant to a role, not
   * to the public. Every page therefore needs at least that check before it
   * renders anything.
   */
  test("every page calls requireRole before rendering", () => {
    const unguarded = pageFiles()
      .filter((path) => !/\brequireRole\s*\(/.test(readFileSync(path, "utf8")))
      .map((path) => relative(repoRoot, path));

    expect(unguarded).toEqual([]);
  });

  /**
   * A page that authorised for a role above `viewer` would be a different bug —
   * hiding a page §8.6 L783 says viewers read — so the minimum is pinned too.
   */
  test("the page-level minimum is viewer", () => {
    const wrong = pageFiles()
      .filter((path) => !/requireRole\(\s*"viewer"/.test(readFileSync(path, "utf8")))
      .map((path) => relative(repoRoot, path));

    expect(wrong).toEqual([]);
  });

  /**
   * §8.2 L722's Cognito callbacks are the one route that must stay reachable
   * unauthenticated — it is where a session comes from. Asserting it is not a
   * page keeps the rule above from being "fixed" later by exempting things.
   */
  test("the auth route is not a page, so it needs no exemption", () => {
    expect(pageFiles().some((path) => path.includes(join("api", "auth")))).toBe(false);
  });
});
