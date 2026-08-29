import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { cdkContext } from "./support/cdkContext";

const repoRoot = resolve(import.meta.dirname, "..");

/**
 * A CDK `App` built in a test must load cdk.json's context, exactly as
 * `cdk synth` and every deploy do.
 *
 * `new App({ context: {} })` loads no feature flags at all. The flags are not
 * cosmetic — they change which resources CDK emits, so a suite built on an empty
 * context asserts against a template that never deploys. When this rule was
 * written the pipeline suite synthesised one log group where the real synth
 * synthesised six, and the two extra `/aws/lambda/*` groups were what made the
 * deploy fail with "already exists in stack" (R41). All four gates were green
 * throughout, because none of them had ever seen those resources.
 *
 * The flags also silently downgrade behaviour: an unset flag falls back to the
 * pre-flag default, so a test can assert a property CDK would never emit under
 * the project's own configuration.
 */
const APP_CONSTRUCTORS = ["new App(", "createApp("] as const;

/** Every `*.test.ts` that could synthesise, minus this file. */
function testFiles(): string[] {
  const walk = (dir: string): string[] => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return [];
    }
    return entries.flatMap((entry) => {
      if (entry === "node_modules" || entry === "cdk.out") return [];
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return walk(path);
      return path.endsWith(".test.ts") ? [path] : [];
    });
  };

  /**
   * This file names the very strings it forbids, so it would match itself —
   * the mistake `test/boundaries.test.ts` and `test/importExtensions.test.ts`
   * each record having made.
   */
  const self = resolve(import.meta.dirname, "cdkContext.test.ts");
  return [...walk(join(repoRoot, "infra")), ...walk(join(repoRoot, "test"))].filter(
    (path) => path !== self,
  );
}

/** The argument list of the call starting at `start`, by balanced parentheses. */
function callArguments(source: string, start: number): string {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(") depth += 1;
    if (character === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return source.slice(start);
}

/**
 * The file with its comments removed.
 *
 * These constructors get named in prose — this rule's own explanation is written
 * in terms of them — and a scan that reads commentary reports lines no CDK app
 * is ever built from. Block comments go whole; only lines that are entirely a
 * comment are dropped, so a trailing `//` inside a URL cannot swallow real code
 * sharing its line.
 */
function codeOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*");
    })
    .join("\n");
}

function offendingCalls(path: string): string[] {
  const source = codeOf(readFileSync(path, "utf8"));
  const found: string[] = [];

  for (const builder of APP_CONSTRUCTORS) {
    let index = source.indexOf(builder);
    while (index !== -1) {
      const args = callArguments(source, index + builder.length - 1);
      if (!args.includes("cdkContext(")) {
        found.push(`${relative(repoRoot, path)}: ${builder}${args.slice(1, 60)}`);
      }
      index = source.indexOf(builder, index + 1);
    }
  }

  return found;
}

describe("the CDK test harness", () => {
  test("scans the test files that build an App", () => {
    const scanned = testFiles().filter((path) => {
      const code = codeOf(readFileSync(path, "utf8"));
      return APP_CONSTRUCTORS.some((builder) => code.includes(builder));
    });

    // A scan that silently matches nothing enforces nothing.
    expect(scanned.length).toBeGreaterThan(0);
  });

  test("builds every App with cdk.json's context", () => {
    const offenders = testFiles().flatMap(offendingCalls);

    expect(offenders).toEqual([]);
  });

  test("cdkContext carries the project's feature flags", () => {
    const context = cdkContext();

    expect(context["@aws-cdk/aws-lambda:useCdkManagedLogGroup"]).toBe(true);
    expect(Object.keys(context).length).toBeGreaterThan(50);
  });

  test("cdkContext lets a test override a value without dropping the flags", () => {
    const context = cdkContext({ env: "prod" });

    expect(context.env).toBe("prod");
    expect(context["@aws-cdk/aws-lambda:useCdkManagedLogGroup"]).toBe(true);
  });
});
