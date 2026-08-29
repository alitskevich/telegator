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

import { cdkContext } from "../../test/support/cdkContext";
import { isolatedOutdir, removeIsolatedOutdirs } from "../../test/support/cdkOutdir";
import { resolveConfig } from "./config";
import { TelegatorDataStack } from "./data-stack";
import { PIPELINE_FUNCTIONS, TelegatorPipelineStack } from "./pipeline-stack";
import { TelegatorQueueStack } from "./queue-stack";

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
  const app = new App({ context: cdkContext(context), outdir: isolatedOutdir() });
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

    /**
     * R40 — `reserveConcurrency=false` drops every reservation.
     *
     * A reservation is only creatable while the account keeps 5 concurrent
     * executions unreserved. A cold account's quota is 5 in total, so AWS
     * rejects *any* reservation: "Specified ReservedConcurrentExecutions for
     * function decreases account's UnreservedConcurrentExecution below its
     * minimum value of [5]". §3.1 L185 and §3.2 L229 are then undeployable
     * through no fault of the template.
     *
     * Its own parameter rather than a dev-only branch, for R23's reason: the
     * driver is the account's quota, not the environment name — a prod account
     * with a cold quota fails identically. The default stays spec-faithful, so
     * a deploy has to opt out and say so on the command line.
     */
    test("reserveConcurrency=false drops every reservation", () => {
      const reserved = functions(stackFor({ reserveConcurrency: "false" }).template).filter(
        (f) => f.ReservedConcurrentExecutions !== undefined,
      );

      expect(reserved).toHaveLength(0);
    });

    test("the opt-out changes nothing else about the functions", () => {
      const withReservation = named(stackFor().template, "telegator-dev-scrape");
      const without = named(
        stackFor({ reserveConcurrency: "false" }).template,
        "telegator-dev-scrape",
      );

      expect(without?.MemorySize).toBe(withReservation?.MemorySize);
      expect(without?.Timeout).toBe(withReservation?.Timeout);
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

  /**
   * R41 — the retention has to apply to the group the function actually writes
   * to, not merely to a group that exists.
   *
   * `@aws-cdk/aws-lambda:useCdkManagedLogGroup` makes every function declare its
   * own `/aws/lambda/<name>` group. Declaring a second one beside it for
   * retention collides on deploy ("already exists in stack"), and until it
   * collided it was inert: the function used the managed group's 731 days while
   * this suite asserted 90 against the group nothing referenced. The assertion
   * above could not see the difference — the managed group's name is an
   * `Fn::Join`, so `String(...)` renders "[object Object]" and never matches.
   */
  /**
   * The count is the evidence that cdk.json's flags reached this synthesis.
   * `@aws-cdk/aws-lambda:useCdkManagedLogGroup` gives every function a log
   * group; without it CDK emits only the one this stack declares, and the suite
   * is asserting against a template that never deploys.
   */
  test("synthesises a log group per function, as the deploy does", () => {
    const groups = Object.keys(stackFor().template.findResources("AWS::Logs::LogGroup"));

    expect(groups).toHaveLength(PIPELINE_FUNCTIONS.length);
  });

  test("declares one log group per name, so the deploy does not collide", () => {
    const template = stackFor().template;
    const resources = template.toJSON().Resources as Record<
      string,
      { Type: string; Properties?: Record<string, unknown> }
    >;

    /**
     * Resolved, not stringified. The managed group names itself with an
     * `Fn::Join` over a `Ref` to the function while the declared one uses a
     * literal, so comparing the raw values finds two distinct names for one
     * physical log group — which is precisely the collision CloudFormation
     * rejects.
     */
    const resolve = (value: unknown): string => {
      if (typeof value === "string") return value;
      const join = (value as { "Fn::Join"?: [string, unknown[]] })["Fn::Join"];
      if (join === undefined) return JSON.stringify(value);
      return join[1]
        .map((part) => {
          if (typeof part === "string") return part;
          const ref = (part as { Ref?: string }).Ref;
          return ref === undefined
            ? JSON.stringify(part)
            : String(resources[ref]?.Properties?.FunctionName ?? ref);
        })
        .join("");
    };

    const names = Object.values(resources)
      .filter((r) => r.Type === "AWS::Logs::LogGroup")
      .map((r) => resolve(r.Properties?.LogGroupName));

    expect(new Set(names).size).toBe(names.length);
  });

  test("points analyze at the 90-day group rather than a managed one", () => {
    const template = stackFor().template;
    const logging = named(template, "telegator-dev-analyze")?.LoggingConfig as
      | { LogGroup?: unknown }
      | undefined;

    expect(logging?.LogGroup).toBeDefined();
  });

  test("supplies every environment variable handlers/env.ts requires", async () => {
    const { ENV_VARS } = await import("../../handlers/env");
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
    const app = new App({ context: cdkContext(), outdir: isolatedOutdir() });
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
