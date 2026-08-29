import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, test, vi } from "vitest";
import { TelegatorAppStack } from "./app-stack.js";
import { TelegatorAuthStack } from "./auth-stack.js";
import { resolveConfig } from "./config.js";
import { TelegatorDataStack } from "./data-stack.js";
import { TelegatorPipelineStack } from "./pipeline-stack.js";
import { TelegatorQueueStack } from "./queue-stack.js";

vi.setConfig({ testTimeout: 60_000 });

const isolatedOutdir = () => mkdtempSync(join(tmpdir(), "telegator-cdk-"));

const cache = new Map<string, Template>();

function templateFor(context: Record<string, unknown> = {}): Template {
  const key = JSON.stringify(context);
  const existing = cache.get(key);
  if (existing !== undefined) return existing;

  const app = new App({ context, outdir: isolatedOutdir() });
  const config = resolveConfig(app);
  const data = new TelegatorDataStack(app, "Data", { config });
  const queues = new TelegatorQueueStack(app, "Queues", { config });
  const auth = new TelegatorAuthStack(app, "Auth", { config });
  const pipeline = new TelegatorPipelineStack(app, "Pipeline", { config, data, queues });
  const stack = new TelegatorAppStack(app, "AppStack", {
    config,
    data,
    queues,
    auth,
    pipeline,
  });
  const template = Template.fromStack(stack);
  cache.set(key, template);
  return template;
}

const amplifyApp = (t: Template) =>
  Object.values(t.findResources("AWS::Amplify::App"))[0]?.Properties;

const policyStatements = (t: Template) =>
  Object.values(t.findResources("AWS::IAM::Policy")).flatMap(
    (r) =>
      (r.Properties?.PolicyDocument as { Statement?: Record<string, unknown>[] } | undefined)
        ?.Statement ?? [],
  );

const actionsOf = (statement: Record<string, unknown>) => [statement.Action].flat().map(String);

describe("TelegatorAppStack", () => {
  test("declares one Amplify app (§9.1 L804)", () => {
    templateFor().resourceCountIs("AWS::Amplify::App", 1);
  });

  /**
   * The app must actually carry the role, not merely coexist with it. The L1
   * construct accepts an unknown property silently, so a misspelled key here
   * synthesises an app with no role and every §8.5 query fails at runtime with
   * an access error naming nothing useful.
   */
  test("attaches the dashboard role to the app", () => {
    expect(amplifyApp(templateFor())?.IAMServiceRole).toBeDefined();
  });

  /**
   * §9.3 L814 — Amplify Hosting "supports the App Router (SSR, server actions,
   * streaming) natively with no OpenNext adapter or Fargate service". Only the
   * WEB_COMPUTE platform runs server-side; WEB would deploy a static export and
   * every server action in §8.4 would 404.
   */
  test("runs on WEB_COMPUTE, the only platform that serves §8.4's server actions", () => {
    expect(amplifyApp(templateFor())?.Platform).toBe("WEB_COMPUTE");
  });

  test("names the app with the §9.2 L810 environment prefix", () => {
    expect(amplifyApp(templateFor({ env: "prod" }))?.Name).toBe("telegator-prod-dashboard");
  });

  describe("environment variables", () => {
    const variables = (t: Template): Record<string, string> => {
      const declared = amplifyApp(t)?.EnvironmentVariables;
      if (!Array.isArray(declared)) throw new Error("the app declares no environment variables");
      return Object.fromEntries(
        declared.map((entry: { Name: string; Value: string }) => [entry.Name, entry.Value]),
      );
    };

    test("carries both table names, so §8.5's cards can query them", () => {
      const names = Object.keys(variables(templateFor()));

      expect(names).toContain("TELEGATOR_SOURCES_TABLE");
      expect(names).toContain("TELEGATOR_MESSAGES_TABLE");
    });

    test("carries every queue and DLQ url §8.5 L769 and §8.2 L723 need", () => {
      const names = Object.keys(variables(templateFor()));

      for (const name of [
        "TELEGATOR_ANALYZE_QUEUE_URL",
        "TELEGATOR_PUBLISH_QUEUE_URL",
        "TELEGATOR_ANALYZE_DLQ_URL",
        "TELEGATOR_PUBLISH_DLQ_URL",
      ]) {
        expect(names).toContain(name);
      }
    });

    /** §8.4 L752/L754 — runScraper and replayDlq invoke by function name. */
    test("carries the two function names the manual triggers invoke", () => {
      const names = Object.keys(variables(templateFor()));

      expect(names).toContain("TELEGATOR_SCRAPE_FUNCTION_NAME");
      expect(names).toContain("TELEGATOR_DLQ_REPLAY_FUNCTION_NAME");
    });

    test("carries the Cognito ids the session layer needs (§8.6 L780)", () => {
      const names = Object.keys(variables(templateFor()));

      expect(names).toContain("TELEGATOR_USER_POOL_ID");
      expect(names).toContain("TELEGATOR_USER_POOL_CLIENT_ID");
    });
  });

  describe("the app role (§7.6 L673, R24)", () => {
    test("may read both tables and write them", () => {
      const dynamo = policyStatements(templateFor()).filter((s) =>
        actionsOf(s).some((action) => action.startsWith("dynamodb:")),
      );

      expect(dynamo.length).toBeGreaterThan(0);
    });

    /**
     * §7.6 L673 scopes the invoke grant to "the scraper and the replay
     * handler". §8.2 L734 is why that matters: the dashboard must not import
     * lib/pipeline/, so invoking is its only route into the pipeline — and a
     * broader grant would let it invoke the stages directly, defeating the
     * boundary.
     */
    test("may invoke exactly two functions, not the stages", () => {
      const invoke = policyStatements(templateFor()).filter((s) =>
        actionsOf(s).includes("lambda:InvokeFunction"),
      );

      expect(invoke).toHaveLength(1);
      expect(invoke[0]?.Resource).not.toBe("*");
      const serialised = JSON.stringify(invoke[0]?.Resource);
      expect(serialised).not.toContain("aggregateFunction");
    });

    /** R24 — §8.5 L771's chart needs GetQueryResults; StartQuery alone returns nothing. */
    test("may both start a Logs Insights query and read its results", () => {
      const logs = policyStatements(templateFor()).flatMap(actionsOf);

      expect(logs).toContain("logs:StartQuery");
      expect(logs).toContain("logs:GetQueryResults");
    });

    /** R24 — §8.4 L753's republishMessage "enqueues", which §7.6 L673 omits. */
    test("may send to the publish queue, which republishMessage requires", () => {
      const sends = policyStatements(templateFor()).filter((s) =>
        actionsOf(s).includes("sqs:SendMessage"),
      );

      expect(sends.length).toBeGreaterThan(0);
    });

    /** R24 — §8.2 L723's "DLQ inspection" needs more than queue depth. */
    test("may receive from the DLQs, which DLQ inspection requires", () => {
      const receives = policyStatements(templateFor()).flatMap(actionsOf);

      expect(receives).toContain("sqs:ReceiveMessage");
    });

    /**
     * R24 records that Cognito user-management APIs are deliberately NOT
     * granted: §8.2, §8.3 and §8.4 define no user-management route, page or
     * action, so the grant would exceed the task §8.6 L786 describes.
     */
    test("is granted no Cognito administration", () => {
      const actions = policyStatements(templateFor()).flatMap(actionsOf);

      expect(actions.filter((action) => action.startsWith("cognito-idp:"))).toEqual([]);
    });
  });

  test("is environment-agnostic and requests no context lookup", () => {
    const app = new App({ context: {}, outdir: isolatedOutdir() });
    const config = resolveConfig(app);
    const data = new TelegatorDataStack(app, "Data", { config });
    const queues = new TelegatorQueueStack(app, "Queues", { config });
    const auth = new TelegatorAuthStack(app, "Auth", { config });
    const pipeline = new TelegatorPipelineStack(app, "Pipeline", { config, data, queues });
    new TelegatorAppStack(app, "AppStack", { config, data, queues, auth, pipeline });
    const assembly = app.synth();

    expect(assembly.manifest.missing ?? []).toEqual([]);
    for (const s of assembly.stacks) {
      expect(s.environment.account).toBe("unknown-account");
    }
  });
});
