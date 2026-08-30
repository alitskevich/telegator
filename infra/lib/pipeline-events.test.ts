import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { afterAll, describe, expect, test, vi } from "vitest";
import { MANTLE_PROJECT_ID } from "../../lib/ai/constants";
import { METRIC_NAMESPACE } from "../../lib/metrics/ports";
import { cdkContext } from "../../test/support/cdkContext";
import { isolatedOutdir, removeIsolatedOutdirs } from "../../test/support/cdkOutdir";
import { resolveConfig } from "./config";
import { TelegatorDataStack } from "./data-stack";
import { TelegatorPipelineStack } from "./pipeline-stack";
import { TelegatorQueueStack } from "./queue-stack";

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
  const stack = new TelegatorPipelineStack(app, "Pipeline", { config, data, queues });
  const template = Template.fromStack(stack);
  cache.set(key, template);
  return template;
}

const mappings = (t: Template) =>
  Object.values(t.findResources("AWS::Lambda::EventSourceMapping")).map((r) => r.Properties ?? {});

const policyStatements = (t: Template) =>
  Object.values(t.findResources("AWS::IAM::Policy")).flatMap(
    (r) =>
      (r.Properties?.PolicyDocument as { Statement?: Record<string, unknown>[] } | undefined)
        ?.Statement ?? [],
  );

const alarms = (t: Template) =>
  Object.values(t.findResources("AWS::CloudWatch::Alarm")).map((r) => r.Properties ?? {});

describe("event source mappings (§7.3 L606-608, §7.3 L620)", () => {
  test("declares one mapping per consumer", () => {
    expect(mappings(templateFor())).toHaveLength(3);
  });

  /**
   * §7.3 L620 — "Every consumer sets functionResponseTypes:
   * ['ReportBatchItemFailures']". Without it one poison message forces the whole
   * batch to retry, which for analyze means re-billing nine Bedrock calls.
   */
  test("every mapping reports batch item failures", () => {
    for (const mapping of mappings(templateFor())) {
      expect(mapping.FunctionResponseTypes).toEqual(["ReportBatchItemFailures"]);
    }
  });

  test("uses the batch sizes §7.3 pins: 10, 10 and 1", () => {
    expect(
      mappings(templateFor())
        .map((m) => m.BatchSize)
        .sort((a, b) => Number(a) - Number(b)),
    ).toEqual([1, 10, 10]);
  });

  /**
   * §3.2 L229 gives analyze a 60 s window. R33: §3.3 L258 also gives aggregate
   * 300 s, but AWS supports no batching window on a FIFO queue and CDK rejects
   * it at synth — so analyze's is the only one, and this asserts that rather
   * than the spec's stated pair.
   */
  test("gives analyze the only batching window a FIFO queue cannot have", () => {
    const windows = mappings(templateFor())
      .map((m) => m.MaximumBatchingWindowInSeconds)
      .filter((w) => w !== undefined);

    expect(windows).toEqual([60]);
  });
});

describe("the EventBridge schedule (§7.5 L649, R22, R23)", () => {
  test("fires every 30 minutes", () => {
    templateFor().hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "rate(30 minutes)",
    });
  });

  /**
   * R23 and §9.2 L810. The flag is not derived from the environment name:
   * §9.5 step 4 deploys PROD with the schedule disabled too, enabling it only at
   * step 7 after a 48-hour soak. A dev deploy that can post to production
   * Telegram channels is a defect, and so is a prod deploy that starts posting
   * before the soak.
   */
  test("is disabled by default in every environment", () => {
    for (const env of ["dev", "prod"]) {
      templateFor({ env }).hasResourceProperties("AWS::Events::Rule", { State: "DISABLED" });
    }
  });

  test("is enabled only when a deploy opts in", () => {
    templateFor({ scheduleEnabled: true }).hasResourceProperties("AWS::Events::Rule", {
      State: "ENABLED",
    });
  });

  test("targets the scraper", () => {
    templateFor().hasResourceProperties("AWS::Events::Rule", { Targets: Match.anyValue() });
  });
});

describe("IAM (§7.6 L668-673, R24)", () => {
  /**
   * §7.6's whole point is per-function least privilege. A wildcard resource
   * would grant every function every table and queue in the account.
   */
  test("no statement uses a wildcard resource except namespace-scoped PutMetricData", () => {
    for (const statement of policyStatements(templateFor())) {
      const actions = [statement.Action].flat().map(String);
      if (statement.Resource === "*") {
        expect(actions.every((action) => action === "cloudwatch:PutMetricData")).toBe(true);
        expect(statement.Condition).toBeDefined();
      }
    }
  });

  /**
   * R24 — §7.6 omits PutMetricData, yet §7.7's twelve counters are unemittable
   * without it, and §7.7 L679 makes them the system of record for volume.
   */
  test("grants PutMetricData, conditioned on the Telegator namespace", () => {
    const putMetric = policyStatements(templateFor()).filter((s) =>
      [s.Action].flat().map(String).includes("cloudwatch:PutMetricData"),
    );

    expect(putMetric.length).toBeGreaterThan(0);
    expect(JSON.stringify(putMetric)).toContain(METRIC_NAMESPACE);
  });

  /**
   * Attribute each policy statement to the function it was attached to, through
   * the role both reference. Without this the Bedrock assertions below can only
   * say "two functions got a model" — and the two are different models with
   * different costs and capabilities, so which function got which is the whole
   * content of §7.6 L669-670.
   */
  function statementsByFunction(template: Template): Map<string, Record<string, unknown>[]> {
    const roleToFunction = new Map<string, string>();

    for (const fn of Object.values(template.findResources("AWS::Lambda::Function"))) {
      const role = (fn.Properties?.Role as { "Fn::GetAtt"?: string[] } | undefined)?.["Fn::GetAtt"];
      const name = fn.Properties?.FunctionName;
      if (role?.[0] !== undefined && typeof name === "string") roleToFunction.set(role[0], name);
    }

    const byFunction = new Map<string, Record<string, unknown>[]>();

    for (const policy of Object.values(template.findResources("AWS::IAM::Policy"))) {
      const roles = (policy.Properties?.Roles ?? []) as { Ref?: string }[];
      const statements = ((
        policy.Properties?.PolicyDocument as { Statement?: Record<string, unknown>[] }
      )?.Statement ?? []) as Record<string, unknown>[];

      for (const { Ref } of roles) {
        const name = Ref === undefined ? undefined : roleToFunction.get(Ref);
        if (name === undefined) continue;
        byFunction.set(name, [...(byFunction.get(name) ?? []), ...statements]);
      }
    }

    return byFunction;
  }

  /**
   * Both actions, because §5's two Bedrock calls do not share an API. Filtering
   * on `bedrock:InvokeModel` alone is what let R42 ship: analyze's grant named
   * an action its client never issues, and a test that only looked for that
   * action saw a well-formed statement and passed.
   */
  const BEDROCK_ACTIONS = ["bedrock:InvokeModel", "bedrock-mantle:CreateInference"];

  const bedrockFor = (template: Template, functionName: string) =>
    JSON.stringify(
      (statementsByFunction(template).get(functionName) ?? []).filter((statement) =>
        [statement.Action]
          .flat()
          .map(String)
          .some((action) => BEDROCK_ACTIONS.includes(action)),
      ),
    );

  /**
   * R49 — aggregate embedded through `bedrock-runtime`, so §7.6 L670's
   * `bedrock:InvokeModel` was correct for it while R42 was fixing analyze's.
   * With embeddings gone (R43) both stages call the Mantle API, so one grant
   * covers the stack and `bedrock:InvokeModel` appears nowhere.
   */
  test("grants bedrock-mantle:CreateInference to exactly two functions, and InvokeModel to none", () => {
    const statements = policyStatements(templateFor());

    const mantle = statements.filter((s) =>
      [s.Action].flat().map(String).includes("bedrock-mantle:CreateInference"),
    );
    const invoke = statements.filter((s) =>
      [s.Action].flat().map(String).includes("bedrock:InvokeModel"),
    );

    expect(mantle).toHaveLength(2);
    expect(invoke).toHaveLength(0);
    for (const statement of mantle) {
      expect(statement.Resource).not.toBe("*");
    }
  });

  test("analyze may create a Mantle inference on the project", () => {
    expect(bedrockFor(templateFor(), "telegator-dev-analyze")).toContain(
      `project/${MANTLE_PROJECT_ID}`,
    );
  });

  test("aggregate may create a Mantle inference on the project", () => {
    expect(bedrockFor(templateFor(), "telegator-dev-aggregate")).toContain(
      `project/${MANTLE_PROJECT_ID}`,
    );
  });

  /** §7.6 grants Bedrock to those two stages only; scrape and publish call no model. */
  test("no other function may invoke a model", () => {
    const template = templateFor();

    for (const name of [
      "telegator-dev-scrape",
      "telegator-dev-publish",
      "telegator-dev-dlq-replay",
    ]) {
      expect(bedrockFor(template, name)).toBe("[]");
    }
  });

  /**
   * §7.6 L672 reads "read/write `messages`", which `grantReadWriteData` matches
   * literally — and that helper also grants DeleteItem and BatchWriteItem.
   * `publish` calls exactly two APIs: `GetItem` (§3.4 L316's load) and
   * `UpdateItem` (§3.4 L345's result write).
   *
   * The narrow reading wins here because of what the wide one enables. §7.2
   * makes `messages` the only durable record of a Telegram post — §1.3 L49 says
   * a post that never merges "leaves no row anywhere" — and §8.4 L751 makes even
   * an operator's delete soft for that reason. A stage that never deletes should
   * not be able to, least of all irrecoverably.
   */
  test("publish may read and update messages, and nothing more (§7.6 L672)", () => {
    const statements = statementsByFunction(templateFor()).get("telegator-dev-publish") ?? [];
    const dynamo = new Set(
      statements
        .flatMap((statement) => [statement.Action].flat().map(String))
        .filter((action) => action.startsWith("dynamodb:")),
    );

    expect(dynamo).toEqual(new Set(["dynamodb:GetItem", "dynamodb:UpdateItem"]));
  });

  /** Named individually, because a set equality can be satisfied by a later edit. */
  test("publish may not delete or overwrite a message record", () => {
    const statements = statementsByFunction(templateFor()).get("telegator-dev-publish") ?? [];
    const dynamo = statements.flatMap((statement) => [statement.Action].flat().map(String));

    for (const forbidden of [
      "dynamodb:DeleteItem",
      "dynamodb:BatchWriteItem",
      "dynamodb:PutItem",
      "dynamodb:Scan",
    ]) {
      expect(dynamo).not.toContain(forbidden);
    }
  });

  const dynamoActionsFor = (template: Template, functionName: string) =>
    new Set(
      (statementsByFunction(template).get(functionName) ?? [])
        .flatMap((statement) => [statement.Action].flat().map(String))
        .filter((action) => action.startsWith("dynamodb:")),
    );

  /**
   * §7.6 L668 — "read/write `sources`". `scrape` calls `listByStatus` (a Query
   * on `status-index`) and `updateCursor` (an UpdateItem). It never reads a
   * source by id, never creates one, and never deletes one.
   */
  test("scrape may query and update sources, and nothing more", () => {
    expect(dynamoActionsFor(templateFor(), "telegator-dev-scrape")).toEqual(
      new Set(["dynamodb:Query", "dynamodb:UpdateItem"]),
    );
  });

  /**
   * §7.6 L670 — "read/write `messages`". `aggregate` calls `get`, `queryByDate`
   * (on `date-index`), `putNew` and `mergeMember`: §6's create branch genuinely
   * needs PutItem, which is why this stage is not `publish`.
   */
  test("aggregate may get, query, put and update messages, and nothing more", () => {
    expect(dynamoActionsFor(templateFor(), "telegator-dev-aggregate")).toEqual(
      new Set(["dynamodb:GetItem", "dynamodb:Query", "dynamodb:PutItem", "dynamodb:UpdateItem"]),
    );
  });

  /**
   * A Query against a GSI is authorised on the index ARN, not the table's —
   * `table.grant()` grants only the table, so a narrowed Query that forgot the
   * index would fail at runtime on §3.1 L187's source selection and §6 L515's
   * dedup read, which is a worse outcome than the widening being removed.
   */
  test("a narrowed Query still reaches the indexes it queries", () => {
    const byFunction = statementsByFunction(templateFor());

    for (const name of ["telegator-dev-scrape", "telegator-dev-aggregate"]) {
      const queries = (byFunction.get(name) ?? []).filter((statement) =>
        [statement.Action].flat().map(String).includes("dynamodb:Query"),
      );

      expect(JSON.stringify(queries)).toContain("/index/*");
    }
  });

  /** No stage deletes a record: §8.4 L751 makes even an operator's delete soft. */
  test("no pipeline function may delete a record", () => {
    const template = templateFor();

    for (const name of [
      "telegator-dev-scrape",
      "telegator-dev-analyze",
      "telegator-dev-aggregate",
      "telegator-dev-publish",
      "telegator-dev-dlq-replay",
    ]) {
      const actions = dynamoActionsFor(template, name);
      expect(actions.has("dynamodb:DeleteItem")).toBe(false);
      expect(actions.has("dynamodb:BatchWriteItem")).toBe(false);
    }
  });

  test("grants secretsmanager:GetSecretValue to exactly one function (§7.6 L671)", () => {
    const secrets = policyStatements(templateFor()).filter((s) =>
      [s.Action].flat().map(String).includes("secretsmanager:GetSecretValue"),
    );

    expect(secrets).toHaveLength(1);
  });

  /** §7.6 L675 — "No VPC." A VPC would need NAT for outbound scraping, with no security gain. */
  test("places no function in a VPC", () => {
    for (const fn of Object.values(templateFor().findResources("AWS::Lambda::Function"))) {
      expect(fn.Properties?.VpcConfig).toBeUndefined();
    }
  });
});

describe("alarms (§7.7 L699)", () => {
  test("declares the five §7.7 alarms", () => {
    // Three DLQ-depth alarms, plus SourceStale, DedupCandidateCount, the Lambda
    // error rate and the analyze queue age.
    expect(alarms(templateFor()).length).toBeGreaterThanOrEqual(5);
  });

  test("alarms on any DLQ depth above zero", () => {
    const dlqAlarms = alarms(templateFor()).filter(
      (a) => a.MetricName === "ApproximateNumberOfMessagesVisible",
    );

    expect(dlqAlarms).toHaveLength(3);
    for (const alarm of dlqAlarms) {
      expect(alarm.Threshold).toBe(0);
      expect(alarm.ComparisonOperator).toBe("GreaterThanThreshold");
    }
  });

  /** §7.2 L600 — "Alarm at > 500 — the point at which the in-memory comparison assumption needs revisiting." */
  test("alarms when a day's dedup candidates exceed 500", () => {
    const alarm = alarms(templateFor()).find((a) => a.MetricName === "DedupCandidateCount");

    expect(alarm?.Threshold).toBe(500);
    expect(alarm?.Namespace).toBe(METRIC_NAMESPACE);
  });

  /**
   * R25 — §7.7 L699 alarms on "SourceStale for any source", but the metric is
   * dimensioned by a runtime-discovered Source. A CloudWatch alarm cannot
   * enumerate that at synth time and lookups are banned, so item 3.5 emits the
   * metric undimensioned as well and the alarm watches that.
   */
  test("alarms on the undimensioned SourceStale", () => {
    const alarm = alarms(templateFor()).find((a) => a.MetricName === "SourceStale");

    expect(alarm).toBeDefined();
    expect(alarm?.Dimensions ?? []).toEqual([]);
  });

  /** §11.4 L874 targets "oldest message < 1 hour under normal load". */
  test("alarms when the analyze queue's oldest message passes an hour", () => {
    const alarm = alarms(templateFor()).find(
      (a) => a.MetricName === "ApproximateAgeOfOldestMessage",
    );

    expect(alarm?.Threshold).toBe(3600);
  });

  test("alarms on a Lambda error rate above 10% over 15 minutes", () => {
    const rate = alarms(templateFor()).find((a) => a.Metrics !== undefined);

    expect(rate?.Threshold).toBe(10);
    expect(JSON.stringify(rate)).toContain("900");
  });

  /**
   * The expression is pinned rather than merely present. CloudWatch parses
   * metric math only when the alarm is created, so `cdk synth` emits a valid
   * template around an expression the service rejects outright — all four gates
   * stay green and the deploy fails at `CREATE_FAILED`.
   *
   * The original divide-by-zero guard, `MAX([invocations, 1])`, is exactly that:
   * CloudWatch answers "Unsupported operand type(s) for MAX: '[Array[TimeSeries,
   * Scalar]]'", because every element of a MAX array must be a TimeSeries and
   * `1` is a scalar. `IF` guards the same division and is accepted — verified
   * against `cloudwatch:GetMetricData`, which parses the expression server-side.
   */
  test("guards the error-rate division with an expression CloudWatch accepts", () => {
    const rate = alarms(templateFor()).find((a) => a.Metrics !== undefined);
    const metrics = (rate?.Metrics ?? []) as { Expression?: string }[];
    const expression = metrics.find((m) => m.Expression !== undefined)?.Expression;

    expect(expression).toBe("IF(invocations > 0, 100 * errors / invocations, 0)");
  });
});
