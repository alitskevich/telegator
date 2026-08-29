import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");

/**
 * §11.1 — "§3.1–3.4 are the functional test suite".
 *
 * The criteria are numbered in the spec and referenced by name in the tests, so
 * coverage can be checked rather than asserted. This reads the spec, extracts
 * every AC id §3.1–3.4 declares, and requires each to be named by at least one
 * test file. A criterion added to the spec, or a test renamed out of existence,
 * fails here instead of quietly reducing what §11.1 covers.
 *
 * R18: §11.1 L844 proposes DynamoDB Local and ElasticMQ, neither of which runs
 * without Docker. The criteria survive unchanged against in-memory fakes and
 * `aws-cdk-lib/assertions`; only the harness sentence does not.
 */

const AC_PATTERN = /\bAC-\d+\.\d+\b/g;

const selfPath = join(repoRoot, "test", "acceptance.test.ts");

function acceptanceCriteria(): string[] {
  const spec = readFileSync(join(repoRoot, "docs/telegator-design.md"), "utf8");
  // §3.1 through §3.4 — the stages. §3.5's replay has no criteria of its own.
  const stages = spec.slice(spec.indexOf("### 3.1"), spec.indexOf("### 3.5"));

  return [...new Set(stages.match(AC_PATTERN) ?? [])].sort();
}

function testFiles(): string[] {
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
      // This file names criteria as data, not as coverage — including it would
      // let the audit satisfy itself, and its examples would fail the reverse
      // check below.
      if (path === selfPath) return [];
      return /\.test\.tsx?$/.test(path) ? [path] : [];
    });
  };

  return ["lib", "test", "handlers", "infra", "components", "actions"].flatMap((dir) =>
    walk(join(repoRoot, dir)),
  );
}

describe("§11.1 — every stage criterion is named by a test", () => {
  /**
   * The audit is worthless if the extraction silently returns nothing, which a
   * heading rename in the spec would cause. §3.1–3.4 declare 27 criteria today;
   * the floor guards the mechanism without pinning the count.
   */
  test("finds the criteria in the spec", () => {
    const criteria = acceptanceCriteria();

    expect(criteria.length).toBeGreaterThan(20);
    expect(criteria).toContain("AC-1.1");
    expect(criteria).toContain("AC-4.7");
  });

  test("finds the test files", () => {
    expect(testFiles().length).toBeGreaterThan(50);
  });

  test("every AC-1.x…AC-4.x is named by at least one test", () => {
    const named = new Set(
      testFiles().flatMap((path) => readFileSync(path, "utf8").match(AC_PATTERN) ?? []),
    );

    const unnamed = acceptanceCriteria().filter((ac) => !named.has(ac));

    expect(unnamed).toEqual([]);
  });

  /**
   * The reverse direction. A test naming a criterion the spec does not declare
   * is either a typo — AC-3.10 for AC-3.1 asserts something no criterion asked
   * for and hides the one that did — or a criterion the spec dropped.
   */
  test("no test names a criterion §3.1–3.4 does not declare", () => {
    const declared = new Set(acceptanceCriteria());

    const invented = [
      ...new Set(
        testFiles().flatMap((path) => {
          const found = readFileSync(path, "utf8").match(AC_PATTERN) ?? [];
          return found.map((ac) => `${relative(repoRoot, path)}: ${ac}`);
        }),
      ),
    ].filter((entry) => !declared.has(entry.split(": ")[1] ?? ""));

    expect(invented).toEqual([]);
  });
});
