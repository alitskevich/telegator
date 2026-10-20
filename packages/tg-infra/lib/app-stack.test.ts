import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { afterAll, describe, expect, test, vi } from "vitest";
import { cdkContext } from "../../../test/support/cdkContext";
import { isolatedOutdir, removeIsolatedOutdirs } from "../../../test/support/cdkOutdir";
import { RPC_PATH, TelegatorAppStack } from "./app-stack";
import { TelegatorAuthStack } from "./auth-stack";
import { resolveConfig } from "./config";
import { TelegatorDataStack } from "./data-stack";
import { TelegatorPipelineStack } from "./pipeline-stack";
import { TelegatorQueueStack } from "./queue-stack";
import { DEFAULT_WEB_ORIGINS } from "./web";

// Item 10.0 — without this each synth leaves ~9 MB of bundles behind.
afterAll(removeIsolatedOutdirs);

vi.setConfig({ testTimeout: 60_000 });

const cache = new Map<string, Template>();

function templateFor(context: Record<string, unknown> = {}): Template {
  const key = JSON.stringify(context);
  const existing = cache.get(key);
  if (existing !== undefined) return existing;

  const app = new App({ context: cdkContext(context), outdir: isolatedOutdir() });
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

const apiFunction = (t: Template) =>
  Object.values(t.findResources("AWS::Lambda::Function")).find(
    (r) => r.Properties?.FunctionName === "telegator-dev-api",
  )?.Properties;

const policyStatements = (t: Template) =>
  Object.values(t.findResources("AWS::IAM::Policy")).flatMap(
    (r) =>
      (r.Properties?.PolicyDocument as { Statement?: Record<string, unknown>[] } | undefined)
        ?.Statement ?? [],
  );

const actionsOf = (statement: Record<string, unknown>) => [statement.Action].flat().map(String);

describe("TelegatorAppStack", () => {
  test("declares the API function, named with the §9.2 environment prefix", () => {
    expect(apiFunction(templateFor())).toBeDefined();
  });

  /** §8.4 — one route, and it is authorised at the edge as well as in the Lambda. */
  test("routes POST /rpc through the Cognito JWT authorizer", () => {
    const template = templateFor();
    const routes = Object.values(template.findResources("AWS::ApiGatewayV2::Route"));

    expect(routes).toHaveLength(1);
    expect(routes[0]?.Properties?.RouteKey).toBe(`POST ${RPC_PATH}`);
    expect(routes[0]?.Properties?.AuthorizationType).toBe("JWT");
    template.resourceCountIs("AWS::ApiGatewayV2::Authorizer", 1);
  });

  /** The authorizer accepts only this pool's ID tokens for this app client. */
  test("the authorizer checks the pool's issuer and the client's audience", () => {
    const authorizer = Object.values(
      templateFor().findResources("AWS::ApiGatewayV2::Authorizer"),
    )[0]?.Properties;

    expect(authorizer?.AuthorizerType).toBe("JWT");
    expect(JSON.stringify(authorizer?.JwtConfiguration?.Issuer)).toContain("cognito-idp");
    expect(authorizer?.JwtConfiguration?.Audience).toHaveLength(1);
  });

  /**
   * §9.3 — the browser calls from the Hosting origin, so the API must answer
   * its preflight; the origins are the same list Cognito's callbacks use.
   */
  test("allows CORS from exactly the web origins", () => {
    const api = Object.values(templateFor().findResources("AWS::ApiGatewayV2::Api"))[0]?.Properties;

    expect(api?.CorsConfiguration?.AllowOrigins).toEqual([...DEFAULT_WEB_ORIGINS]);
    expect(api?.CorsConfiguration?.AllowHeaders).toEqual(
      expect.arrayContaining(["authorization", "content-type"]),
    );
  });

  test("outputs the RPC url the console calls", () => {
    expect(Object.keys(templateFor().findOutputs("*"))).toContain("ApiUrl");
  });

  /** API Gateway gives up at 30 s; a longer Lambda would run on unobserved. */
  test("times out inside API Gateway's 30 s ceiling", () => {
    expect(apiFunction(templateFor())?.Timeout).toBeLessThan(30);
  });

  describe("environment variables", () => {
    const variables = (t: Template): Record<string, unknown> => {
      const declared = apiFunction(t)?.Environment?.Variables;
      if (declared === undefined) throw new Error("the function declares no environment variables");
      return declared as Record<string, unknown>;
    };

    test("carries both table names, so §8.5's cards can query them", () => {
      const names = Object.keys(variables(templateFor()));

      expect(names).toContain("TELEGATOR_SOURCES_TABLE");
      expect(names).toContain("TELEGATOR_MESSAGES_TABLE");
    });

    test("carries every queue and DLQ url §8.5 L844 and §8.2 L788 need", () => {
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
     * §8.6 — `readAuthConfig` in `tg-configs/auth.ts` needs the pool and the
     * client to verify a token, and nothing else: there is no cookie key and
     * no app URL any more, because the browser owns the sign-in.
     */
    test("carries the Cognito ids the verifier needs, and no session secret", () => {
      const names = Object.keys(variables(templateFor()));

      expect(names).toContain("TELEGATOR_USER_POOL_ID");
      expect(names).toContain("TELEGATOR_USER_POOL_CLIENT_ID");
      expect(names).not.toContain("TELEGATOR_SESSION_SECRET_ARN");
    });

    const dynamoStatements = (t: Template) =>
      policyStatements(t).filter((statement) =>
        actionsOf(statement).some((action) => action.startsWith("dynamodb:")),
      );

    /**
     * §7.6 L716 — "read both tables, write `sources`/`messages`". The dashboard
     * calls `get`, `listAll` (a Scan), `put`, `patch` and `softDelete` on
     * sources, and `get`, `queryByStatus`, `countByStatus`, `patch` and
     * `softDelete` on messages. Every write is an UpdateItem or a PutItem —
     * §8.4 L823's delete is soft, so it is an update.
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
     * The rule §8.4 L823 states — "Deletes are **soft**, matching the source" —
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
     * §8.5 L846's category chart is a Logs Insights query over the analyze log
     * group, and `logsInsightsCategoryReader` takes the group name as an
     * argument. Without this variable the chart has nothing to query, and the
     * role's existing logs:StartQuery grant would be pointed at nothing.
     */
    test("carries the analyze log group the category chart queries", () => {
      expect(Object.keys(variables(templateFor()))).toContain("TELEGATOR_ANALYZE_LOG_GROUP");
    });

    /** §8.4 L827/L817 — runScraper and replayDlq invoke by function name. */
    test("carries the two function names the manual triggers invoke", () => {
      const names = Object.keys(variables(templateFor()));

      expect(names).toContain("TELEGATOR_SCRAPE_FUNCTION_NAME");
      expect(names).toContain("TELEGATOR_DLQ_REPLAY_FUNCTION_NAME");
      // R53 — "Publish now" invokes the publish stage, so its name travels too.
      expect(names).toContain("TELEGATOR_PUBLISH_FUNCTION_NAME");
    });
  });

  describe("the app role (§7.6 L716, R24)", () => {
    test("may read both tables and write them", () => {
      const dynamo = policyStatements(templateFor()).filter((s) =>
        actionsOf(s).some((action) => action.startsWith("dynamodb:")),
      );

      expect(dynamo.length).toBeGreaterThan(0);
    });

    /**
     * §7.6 L716 scopes the invoke grant to "the scraper and the replay
     * handler". §8.2 L776 is why that matters: the dashboard must not import
     * tg-pipeline/, so invoking is its only route into the pipeline — and a
     * broader grant would let it invoke the stages directly, defeating the
     * boundary.
     */
    test("may invoke exactly four functions, never the analysis stages", () => {
      const invoke = policyStatements(templateFor()).filter((s) =>
        actionsOf(s).includes("lambda:InvokeFunction"),
      );

      expect(invoke).toHaveLength(1);
      expect(invoke[0]?.Resource).not.toBe("*");
      const serialised = JSON.stringify(invoke[0]?.Resource);
      expect(serialised).not.toContain("aggregateFunction");
      expect(serialised).not.toContain("analyzeFunction");
      // R53 — the third is `publish`, and only because "Publish now" runs the
      // deployed stage; the boundary L712 protects is the analysis pair above.
      expect(serialised).toContain("publishFunction");
      // R61 — the fourth is the pump. It is *how* the pair above stays
      // ungranted: it holds the queue and stage permissions, this role does not.
      expect(serialised).toContain("consumeFunction");
    });

    /** R24 — §8.5 L846's chart needs GetQueryResults; StartQuery alone returns nothing. */
    test("may both start a Logs Insights query and read its results", () => {
      const logs = policyStatements(templateFor()).flatMap(actionsOf);

      expect(logs).toContain("logs:StartQuery");
      expect(logs).toContain("logs:GetQueryResults");
    });

    /** R24 — §8.4 L828's republishMessage "enqueues", which §7.6 L716 omits. */
    test("may send to the publish queue, which republishMessage requires", () => {
      const sends = policyStatements(templateFor()).filter((s) =>
        actionsOf(s).includes("sqs:SendMessage"),
      );

      expect(sends.length).toBeGreaterThan(0);
    });

    /** R24 — §8.2 L776's "DLQ inspection" needs more than queue depth. */
    test("may receive from the DLQs, which DLQ inspection requires", () => {
      const receives = policyStatements(templateFor()).flatMap(actionsOf);

      expect(receives).toContain("sqs:ReceiveMessage");
    });

    /** R57 — "Cleanup all" discards a DLQ the operator has judged unrecoverable. */
    test("may purge, which the DLQ cleanup requires", () => {
      const actions = policyStatements(templateFor()).flatMap(actionsOf);

      expect(actions).toContain("sqs:PurgeQueue");
    });

    /**
     * R57 — the grant is per dead-letter queue and must stay there. Purging a
     * *source* queue would discard posts still in flight, and §1.3 L69 means
     * nothing recovers them. Asserted through the DLQ statement's own shape,
     * because the resources are cross-stack import tokens rather than names:
     * `sqs:ReceiveMessage` is granted on the DLQs and nowhere else, so a purge
     * that appears without it is a purge on something that is not a DLQ.
     */
    test("may purge only the queues it may receive from", () => {
      const purges = policyStatements(templateFor()).filter((statement) =>
        actionsOf(statement).includes("sqs:PurgeQueue"),
      );

      expect(purges.length).toBeGreaterThan(0);
      for (const statement of purges) {
        expect(actionsOf(statement)).toContain("sqs:ReceiveMessage");
      }
    });

    /**
     * R34 revises R24, narrowing rather than relaxing it: §8.6 L882 requires
     * that a disabled user is rejected at every action, and enforcing that needs
     * a live read of one field. `AdminGetUser` is that read, and the only
     * Cognito action this role may hold.
     */
    test("is granted exactly one Cognito action, the disabled-user read", () => {
      const cognito = policyStatements(templateFor())
        .flatMap(actionsOf)
        .filter((action) => action.startsWith("cognito-idp:"));

      expect(cognito).toEqual(["cognito-idp:AdminGetUser"]);
    });

    /**
     * Named individually, because "exactly one action" is a rule a future edit
     * can satisfy while swapping which one. These are the §8.6 L861 grants that
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
     * queries exactly one log group — §8.5 L846's category chart over the
     * analyze logs, the only group `tg-aws/observability.ts` is ever
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

      /**
       * A cross-stack reference to the analyze function's own log group.
       *
       * R41 makes the group a construct this stack owns and hands to the
       * function, so the reference is an `Fn::ImportValue` of its `Arn`. The
       * implicitly managed group it replaced was not the 90-day one §11.5 L1036
       * requires. What is asserted is unchanged: one statement, never `*`.
       */
      const resource = JSON.stringify(starts[0]?.Resource);
      expect(resource).toMatch(/:log-group:|LogGroup[A-Za-z0-9]*Arn/);
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

    /** The browser owns the sign-in now, so the API reads no secret at all. */
    test("may read no secret", () => {
      const actions = policyStatements(templateFor()).flatMap(actionsOf);

      expect(actions).not.toContain("secretsmanager:GetSecretValue");
    });

    /**
     * TT-18 — the dashboard reads and writes three tables now. The action set is
     * unchanged, so the grant can only be seen in what the statements reach.
     *
     * Not a statement *count*: `@aws-cdk/aws-iam:minimizePolicies` is on in
     * `cdk.json`, and the targets grant is deliberately the same four actions
     * as the sources grant, so the two merge into one statement with two
     * resources. Counting the distinct table ARNs survives that merge and is
     * the thing worth asserting anyway.
     */
    test("TT-18: its DynamoDB statements reach all three tables", () => {
      const dynamo = policyStatements(templateFor()).filter((s) =>
        actionsOf(s).some((action) => action.startsWith("dynamodb:")),
      );

      const tables = new Set(
        dynamo
          .flatMap((statement) => [statement.Resource].flat())
          .map((resource) => JSON.stringify(resource))
          // A Query is granted on the index ARN as well; only tables count here.
          .filter((resource) => !resource.includes("/index/")),
      );

      expect(tables.size).toBe(3);

      /**
       * And the four actions on `targets` specifically. The ARN count alone
       * would pass a narrower grant: a single-action grant on `targets` would
       * not merge with `sources`, so it would still contribute a third ARN.
       */
      const onTargets = dynamo.filter((statement) =>
        JSON.stringify(statement.Resource).includes("TargetsTable"),
      );

      expect(onTargets).toHaveLength(1);
      expect(new Set(actionsOf(onTargets[0] ?? {}))).toEqual(
        new Set(["dynamodb:GetItem", "dynamodb:Scan", "dynamodb:PutItem", "dynamodb:UpdateItem"]),
      );
    });
  });

  test("is environment-agnostic and requests no context lookup", () => {
    const app = new App({ context: cdkContext(), outdir: isolatedOutdir() });
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
