import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");
const docPath = join(repoRoot, "docs/telegator.md");

/**
 * `§3.4 L316` — a section, and a line inside it. The line half is optional, and
 * a range (`L495-497`) names two.
 */
const CITATION = /§(\d+(?:\.\d+)?)(?:\s+L(\d+)(?:[-–](\d+))?)?/g;

const HEADING = /^(#{2,4})\s+(\d+(?:\.\d+)?)[.)]?\s/;

/**
 * Where each numbered section starts and ends in the document, 1-indexed and
 * inclusive. A section runs until the next heading at the same depth or
 * shallower, and a parent's range covers all of its children.
 */
function sectionRanges(doc: readonly string[]): Map<string, { start: number; end: number }> {
  const headings = doc.flatMap((line, index) => {
    const match = HEADING.exec(line);
    if (match === null) return [];
    const [, hashes, id] = match;
    if (hashes === undefined || id === undefined) return [];
    return [{ id, depth: hashes.length, line: index + 1 }];
  });

  const ranges = new Map<string, { start: number; end: number }>();
  headings.forEach((heading, index) => {
    const next = headings.slice(index + 1).find((other) => other.depth <= heading.depth);
    ranges.set(heading.id, { start: heading.line, end: (next?.line ?? doc.length + 1) - 1 });
  });

  for (const [id, range] of [...ranges]) {
    if (id.includes(".")) continue;
    const childEnds = [...ranges].flatMap(([other, r]) =>
      other.startsWith(`${id}.`) ? [r.end] : [],
    );
    ranges.set(id, { start: range.start, end: Math.max(range.end, ...childEnds) });
  }

  return ranges;
}

/**
 * Shipped source and tests, minus this file.
 *
 * The scan reads file *text* for citations, so a file listing examples of the
 * form it checks would audit its own vocabulary — it would fail on a sample and
 * pass once someone renamed one, proving nothing about the code.
 */
function citingFiles(): string[] {
  const skip = new Set(["node_modules", ".git", ".next", "cdk.out", "dist", "coverage", "docs"]);
  const selfPath = join(repoRoot, "test", "specCitations.test.ts");

  const walk = (dir: string): string[] => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }
    return entries.flatMap((entry) => {
      if (skip.has(entry)) return [];
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return walk(path);
      return /\.tsx?$/.test(path) && path !== selfPath ? [path] : [];
    });
  };

  return walk(repoRoot);
}

interface Citation {
  readonly where: string;
  readonly text: string;
  readonly section: string;
  readonly lines: readonly number[];
}

function citations(): Citation[] {
  return citingFiles().flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line, index) =>
        [...line.matchAll(CITATION)].flatMap((match) => {
          const [text, section, first, second] = match;
          if (text === undefined || section === undefined) return [];
          const lines = [first, second].flatMap((value) =>
            value === undefined ? [] : [Number(value)],
          );
          return [{ where: `${relative(repoRoot, path)}:${index + 1}`, text, section, lines }];
        }),
      ),
  );
}

/**
 * The document is cited by section *and line*, which nothing else checks: the
 * other three gates never open it, and a line number that drifts points at
 * unrelated prose while every suite stays green. Sixteen citations were already
 * wrong when this test was written (§26 row 16).
 *
 * It pins ranges, not exact lines — a line cannot be verified to be *the* right
 * one without restating the document here. A citation landing in the wrong
 * section is the failure that misleads a reader, and that is what this catches.
 */
describe("§x.y L### citations resolve in docs/telegator.md", () => {
  const doc = readFileSync(docPath, "utf8").split("\n");
  const ranges = sectionRanges(doc);
  const found = citations();

  test("the document parses into numbered sections", () => {
    expect(ranges.get("1")?.start).toBeGreaterThan(0);
    expect(ranges.has("25")).toBe(true);
  });

  test("the scan finds the citations", () => {
    expect(found.length).toBeGreaterThan(1000);
  });

  test("every cited section exists", () => {
    const missing = found
      .filter(({ section }) => !ranges.has(section) && !ranges.has(section.split(".")[0] ?? ""))
      .map(({ where, text }) => `${where}: ${text}`);

    expect([...new Set(missing)]).toEqual([]);
  });

  test("every cited line falls inside the section it names", () => {
    const outside = found.flatMap(({ where, text, section, lines }) => {
      // §11.1–§11.6 are table rows inside §11, not headings of their own.
      const range = ranges.get(section) ?? ranges.get(section.split(".")[0] ?? "");
      if (range === undefined) return [];
      return lines.some((line) => line < range.start || line > range.end)
        ? [`${where}: ${text} (§${section} spans L${range.start}-L${range.end})`]
        : [];
    });

    expect([...new Set(outside)]).toEqual([]);
  });
});
