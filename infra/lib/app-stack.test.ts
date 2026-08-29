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

/** A syntactically real ARN with a zeroed account id — no account id enters this repo. */
const SESSION_SECRET_ARN =
  "arn:aws:secretsmanager:eu-central-1:000000000000:secret:telegator/session-key-AbCdEf";

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

    /**
     * §8.6's hosted UI. `readAuthConfig` in `lib/auth/config.ts` requires six
     * variables; the stack must set the five it owns, or every sign-in fails at
     * runtime with a message naming one of them.
     */
    test("carries the hosted-UI configuration the dashboard reads", () => {
      const names = Object.keys(variables(templateFor()));

      for (const required of [
        "TELEGATOR_USER_POOL_ID",
        "TELEGATOR_USER_POOL_CLIENT_ID",
        "TELEGATOR_COGNITO_DOMAIN",
        "TELEGATOR_APP_URL",
        "TELEGATOR_SESSION_SECRET_ARN",
      ]) {
        expect(names).toContain(required);
      }
    });

    const dynamoStatements = (t: Template) =>
      policyStatements(t).filter((statement) =>
        actionsOf(statement).some((action) => action.startsWith("dynamodb:")),
      );

    /**
     * §7.6 L673 — "read both tables, write `sources`/`messages`". The dashboard
     * calls `get`, `listAll` (a Scan), `put`, `patch` and `softDelete` on
     * sources, and `get`, `queryByStatus`, `countByStatus`, `patch` and
     * `softDelete` on messages. Every write is an UpdateItem or a PutItem —
     * §8.4 L751's delete is soft, so it is an update.
     */
    test("holds only the DynamoDB actions §8.4's pages and actions perform", () => {
      const actions = new Set(
        dynamoStatements(templateFor())
          .flatMap(actionsOf)
          .filter((action) => action.startsWith("dynamodb:")),
      );

      expect(actions).toEqual(
        new Set([
          "dynamodb:GetItem",
          "dynamodb:Query",
          "dynamodb:Scan",
          "dynamodb:PutItem",
          "dynamodb:UpdateItem",
        ]),
      );
    });

    /**
     * The rule §8.4 L751 states — "Deletes are **soft**, matching the source" —
     * expressed as a permission. An operator's delete sets `deleted: true`; a
     * role that could also delete the row makes that promise unenforceable.
     */
    test("cannot hard-delete a record", () => {
      const actions = dynamoStatements(templateFor()).flatMap(actionsOf);

      expect(actions).not.toContain("dynamodb:DeleteItem");
      expect(actions).not.toContain("dynamodb:BatchWriteItem");
    });

    /** §8.3's tables and §8.5's counts all read a GSI, which is a separate ARN. */
    test("its queries reach the indexes they query", () => {
      const queries = dynamoStatements(templateFor()).filter((statement) =>
        actionsOf(statement).includes("dynamodb:Query"),
      );

      expect(JSON.stringify(queries)).toContain("/index/*");
    });

    /**
     * §8.5 L771's category chart is a Logs Insights query over the analyze log
     * group, and `logsInsightsCategoryReader` takes the group name as an
     * argument. Without this variable the chart has nothing to query, and the
     * role's existing logs:StartQuery grant would be pointed at nothing.
     */
    test("carries the analyze log group the category chart queries", () => {
      expect(Object.keys(variables(templateFor()))).toContain("TELEGATOR_ANALYZE_LOG_GROUP");
    });

    /**
     * The secret's ARN is configuration; its value never is. A literal key here
     * would put it in the CloudFormation template and in this repository.
     */
    test("carries the session secret's arn and not its value", () => {
      const declared = variables(templateFor({ sessionSecretArn: SESSION_SECRET_ARN }));

      expect(declared.TELEGATOR_SESSION_SECRET_ARN).toBe(SESSION_SECRET_ARN);
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
     * R34 revises R24, and narrows rather than relaxes it. R24 withheld Cognito
     * from this role because §8.2–§8.4 define no user-management surface, so the
     * "user management" grant of §8.6 L786 would exceed the task. But §8.6 L788
     * states normatively that "a disabled user is rejected at every action", and
     * enforcing that needs a live read of one field. `AdminGetUser` is that read
     * — and it is the ONLY Cognito action this role may hold.
     */
    test("is granted exactly one Cognito action, the disabled-user read", () => {
      const cognito = policyStatements(templateFor())
        .flatMap(actionsOf)
        .filter((action) => action.startsWith("cognito-idp:"));

      expect(cognito).toEqual(["cognito-idp:AdminGetUser"]);
    });

    /**
     * Named individually, because "exactly one action" is a rule a future edit
     * can satisfy while swapping which one. These are the §8.6 L786 grants that
     * have no route, page or action behind them.
     */
    test("is granted no user-management API", () => {
      const actions = new Set(policyStatements(templateFor()).flatMap(actionsOf));

      for (const forbidden of [
        "cognito-idp:AdminCreateUser",
        "cognito-idp:AdminDeleteUser",
        "cognito-idp:AdminDisableUser",
        "cognito-idp:AdminEnableUser",
        "cognito-idp:AdminAddUserToGroup",
        "cognito-idp:AdminRemoveUserFromGroup",
        "cognito-idp:AdminSetUserPassword",
        "cognito-idp:ListUsers",
      ]) {
        expect(actions.has(forbidden)).toBe(false);
      }
    });

    /**
     * `logs:StartQuery` supports resource-level scoping, and the dashboard
     * queries exactly one log group — §8.5 L771's category chart over the
     * analyze logs, the only group `lib/aws/observability.ts` is ever
     * constructed with. On `*` this role could run Insights queries against
     * every log group in the account, which for an operator console is a
     * strictly larger blast radius than anything §7.6 asks for.
     */
    test("may start a query only against the analyze log group", () => {
      const starts = policyStatements(templateFor()).filter((statement) =>
        actionsOf(statement).includes("logs:StartQuery"),
      );

      expect(starts).toHaveLength(1);
      expect(starts[0]?.Resource).not.toBe("*");

      // A cross-stack reference to the analyze function's own log group, so the
      // ARN is a Fn::Join rather than a literal.
      const resource = JSON.stringify(starts[0]?.Resource);
      expect(resource).toContain(":log-group:");
      expect(resource).toMatch(/analyze/i);
    });

    /**
     * `GetQueryResults` and `StopQuery` key off an ephemeral query id rather
     * than a log group, so they cannot be scoped and must stay `*`. Asserted so
     * that the narrowing above is not "fixed" later by scoping these too, which
     * would break the chart with an access error naming nothing useful.
     */
    test("may read its own query results, which cannot be resource-scoped", () => {
      const reads = policyStatements(templateFor()).filter((statement) =>
        actionsOf(statement).includes("logs:GetQueryResults"),
      );

      expect(reads).toHaveLength(1);
      expect(reads[0]?.Resource).toBe("*");
      expect(actionsOf(reads[0] ?? {})).not.toContain("logs:StartQuery");
    });

    /**
     * The cookie sealing key forges admin sessions, so the role reads it from
     * Secrets Manager at runtime (`handlers/publish.ts` does the same for the
     * bot token) rather than carrying it as an Amplify environment variable
     * anyone who can describe the app could read.
     */
    test("may read the session secret, and only that secret", () => {
      const reads = policyStatements(templateFor({ sessionSecretArn: SESSION_SECRET_ARN })).filter(
        (statement) => actionsOf(statement).includes("secretsmanager:GetSecretValue"),
      );

      expect(reads).toHaveLength(1);
      expect(reads[0]?.Resource).toBe(SESSION_SECRET_ARN);
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
