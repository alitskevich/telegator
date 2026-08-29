import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { afterAll, describe, expect, test, vi } from "vitest";

/**
 * A private CDK output directory per App.
 *
 * `NodejsFunction` stages its bundle on disk during synth, so parallel vitest
 * workers sharing one cdk.out race over the staging directory.
 */

// Synthesising this stack bundles five Lambdas with esbuild, which exceeds the
// 5 s default on a cold run.
vi.setConfig({ testTimeout: 60_000 });

import { isolatedOutdir, removeIsolatedOutdirs } from "../../test/support/cdkOutdir.js";
import { resolveConfig } from "./config.js";
import { TelegatorDataStack } from "./data-stack.js";
import { PIPELINE_FUNCTIONS, TelegatorPipelineStack } from "./pipeline-stack.js";
import { TelegatorQueueStack } from "./queue-stack.js";

// Item 10.0 — without this each synth leaves ~9 MB of bundles behind.
afterAll(removeIsolatedOutdirs);

const TIMEOUT_SECONDS = 300;

/**
 * Memoised per context: each synthesis bundles five Lambdas, and the assertions
 * below only read the resulting template, so building it once per distinct
 * context is both faster and identical in meaning.
 */
const cache = new Map<string, ReturnType<typeof build>>();

function stackFor(context: Record<string, unknown> = {}) {
  const key = JSON.stringify(context);
  const existing = cache.get(key);
  if (existing !== undefined) return existing;

  const built = build(context);
  cache.set(key, built);
  return built;
}

function build(context: Record<string, unknown>) {
  const app = new App({ context, outdir: isolatedOutdir() });
  const config = resolveConfig(app);
  const data = new TelegatorDataStack(app, "Data", { config });
  const queues = new TelegatorQueueStack(app, "Queues", { config });
  const stack = new TelegatorPipelineStack(app, "Pipeline", { config, data, queues });
  return { stack, template: Template.fromStack(stack) };
}

const functions = (t: Template) =>
  Object.values(t.findResources("AWS::Lambda::Function")).map((r) => r.Properties ?? {});

const named = (t: Template, name: string) => functions(t).find((f) => f.FunctionName === name);

const NAMES = [
  "telegator-dev-scrape",
  "telegator-dev-analyze",
  "telegator-dev-aggregate",
  "telegator-dev-publish",
  "telegator-dev-dlq-replay",
];

describe("TelegatorPipelineStack functions", () => {
  /**
   * §8.5 L771's category chart is a Logs Insights query grouping by a top-level
   * `category` field, which only works if Lambda emits the line the analyze
   * stage produced and nothing else. `LoggingFormat.JSON` wraps every record in
   * an envelope and carries ours as a `message` string, so the query would match
   * nothing and the chart would be permanently empty with no error anywhere.
   * TEXT is today's default; declaring it means a future default cannot change
   * that silently.
   */
  test("logs in TEXT format, which §8.5 L771's query depends on", () => {
    const formats = functions(stackFor().template).map(
      (fn) => (fn.LoggingConfig as { LogFormat?: string } | undefined)?.LogFormat,
    );

    expect(formats).toHaveLength(5);
    expect(formats.every((format) => format === "Text")).toBe(true);
  });

  /** §7.5 L655 — "Five functions, down from the source system's seven". */
  test("declares exactly the five functions §7.5 L649-653 inventories", () => {
    expect(functions(stackFor().template)).toHaveLength(5);
  });

  test.each(NAMES)("declares %s", (name) => {
    expect(named(stackFor().template, name)).toBeDefined();
  });

  /** §7.5 L645 — "All Node.js 22, ARM64, bundled with esbuild." */
  test.each(NAMES)("%s runs Node.js 22 on ARM64", (name) => {
    const fn = named(stackFor().template, name);

    expect(fn?.Runtime).toBe("nodejs22.x");
    expect(fn?.Architectures).toEqual(["arm64"]);
  });

  /** Every row of §7.5's table gives 300 s. */
  test.each(NAMES)("%s times out at 300 s", (name) => {
    expect(named(stackFor().template, name)?.Timeout).toBe(TIMEOUT_SECONDS);
  });

  test.each([
    ["telegator-dev-scrape", 512],
    ["telegator-dev-analyze", 512],
    // §7.5 L657 — "aggregate is given 1024 MB because it holds a day of 4 KB
    // vectors plus a 10-item embedding batch".
    ["telegator-dev-aggregate", 1024],
    ["telegator-dev-publish", 512],
    ["telegator-dev-dlq-replay", 512],
  ])("%s is given %i MB", (name, memory) => {
    expect(named(stackFor().template, name)?.MemorySize).toBe(memory);
  });

  describe("reserved concurrency (§7.5 L649-653)", () => {
    test.each([
      ["telegator-dev-scrape", 1],
      ["telegator-dev-analyze", 5],
      ["telegator-dev-dlq-replay", 1],
    ])("%s reserves %i", (name, reserved) => {
      expect(named(stackFor().template, name)?.ReservedConcurrentExecutions).toBe(reserved);
    });

    /**
     * §7.5 L651-652 say "by message group" rather than a number, and §3.3 L260
     * is explicit that this "replaces a blunt reserved-concurrency-of-1".
     * Reserving here would serialise across dates too, undoing the parallelism
     * FIFO groups exist to allow.
     */
    test.each(["telegator-dev-aggregate", "telegator-dev-publish"])(
      "AC-3.9: %s reserves nothing, because the message group is the control",
      (name) => {
        expect(named(stackFor().template, name)?.ReservedConcurrentExecutions).toBeUndefined();
      },
    );

    test("exactly three functions reserve concurrency", () => {
      const reserved = functions(stackFor().template).filter(
        (f) => f.ReservedConcurrentExecutions !== undefined,
      );

      expect(reserved).toHaveLength(3);
    });
  });

  /** §12.5 L887 — analyze's logs are the source of §8.5 L771's category chart. */
  test("retains analyze logs for 90 days", () => {
    const groups = Object.values(stackFor().template.findResources("AWS::Logs::LogGroup")).map(
      (r) => r.Properties ?? {},
    );
    const analyze = groups.find((g) => String(g.LogGroupName).includes("analyze"));

    expect(analyze?.RetentionInDays).toBe(90);
  });

  test("supplies every environment variable handlers/env.ts requires", async () => {
    const { ENV_VARS } = await import("../../handlers/env.js");
    const template = stackFor().template;

    const declared = new Set(
      functions(template).flatMap((f) =>
        Object.keys(
          (f.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables ?? {},
        ),
      ),
    );

    for (const name of Object.values(ENV_VARS)) {
      expect(declared).toContain(name);
    }
  });

  test("names functions with the §9.2 L810 environment prefix", () => {
    expect(named(stackFor({ env: "prod" }).template, "telegator-prod-scrape")).toBeDefined();
  });

  test("is environment-agnostic and requests no context lookup", () => {
    const app = new App({ context: {}, outdir: isolatedOutdir() });
    const config = resolveConfig(app);
    const data = new TelegatorDataStack(app, "Data", { config });
    const queues = new TelegatorQueueStack(app, "Queues", { config });
    new TelegatorPipelineStack(app, "Pipeline", { config, data, queues });
    const assembly = app.synth();

    expect(assembly.manifest.missing ?? []).toEqual([]);
    for (const s of assembly.stacks) {
      expect(s.environment.account).toBe("unknown-account");
    }
  });

  test("exposes each function so 4.6 can wire its trigger", () => {
    const { stack } = stackFor();

    for (const key of PIPELINE_FUNCTIONS) {
      expect(stack.functions[key].functionArn).toBeDefined();
    }
  });
});
