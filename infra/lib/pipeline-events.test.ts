import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { afterAll, describe, expect, test, vi } from "vitest";
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

describe("event source mappings (§7.3 L644-646, §7.3 L662)", () => {
  test("declares one mapping per consumer", () => {
    expect(mappings(templateFor())).toHaveLength(3);
  });

  /**
   * §7.3 L662 — "Every consumer sets functionResponseTypes:
   * ['ReportBatchItemFailures']". Without it one poison message forces the whole
   * batch to retry, which for analyze means re-billing nine OpenRouter calls.
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
   * §3.2 L239 gives analyze a 60 s window. R33: §3.3 L268 also gives aggregate
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

describe("the EventBridge schedule (§7.5 L687, R22, R23)", () => {
  test("fires every 30 minutes", () => {
    templateFor().hasResourceProperties("AWS::Events::Rule", {
      ScheduleExpression: "rate(30 minutes)",
    });
  });

  /**
   * R23 and §9.2 L864. The flag is not derived from the environment name:
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

describe("IAM (§7.6 L705-710, R24)", () => {
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
   * without it, and §7.7 L718 makes them the system of record for volume.
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
   * the role both reference. Without this the secret assertions below can only
   * say "three functions got a secret" — and R50 put two different secrets in
   * the stack, so which function got which is the whole content of §7.6
   * L706-708.
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
   * R50 — distinct ARNs, supplied as synth context.
   *
   * Without them both secrets fall back to the same `telegator-*` prefix
   * (`secretArn` in `pipeline-stack.ts`), and every assertion below would pass
   * just as well against a stack that handed analyze the bot token and publish
   * the model key. The whole point of these tests is telling those apart.
   */
  const SECRET_ARNS = {
    openRouterSecretArn:
      "arn:aws:secretsmanager:eu-central-1:111122223333:secret:telegator/openrouter-AbCdEf",
    telegramSecretArn:
      "arn:aws:secretsmanager:eu-central-1:111122223333:secret:telegator/telegram-ZyXwVu",
  };

  const secretsFor = (template: Template, functionName: string) =>
    JSON.stringify(
      (statementsByFunction(template).get(functionName) ?? []).filter((statement) =>
        [statement.Action].flat().map(String).includes("secretsmanager:GetSecretValue"),
      ),
    );

  /**
   * R50 — the provider swap, asserted at the only place it is enforceable.
   *
   * R42 and R49 each shipped a grant naming an action its client never issued,
   * and both passed a suite that only looked for the action it expected to
   * find. So this looks for the *prefix*: any `bedrock…` action at all is the
   * old decision surviving the new one.
   */
  test("grants no Bedrock action of any kind", () => {
    const bedrock = policyStatements(templateFor(SECRET_ARNS)).filter((statement) =>
      [statement.Action]
        .flat()
        .map(String)
        .some((action) => action.startsWith("bedrock")),
    );

    expect(bedrock).toEqual([]);
  });

  /** §7.6, as revised by R50 — the model key reaches exactly the two stages that call a model. */
  test("grants GetSecretValue to exactly three functions, none of them wildcarded", () => {
    const statements = policyStatements(templateFor(SECRET_ARNS)).filter((statement) =>
      [statement.Action].flat().map(String).includes("secretsmanager:GetSecretValue"),
    );

    expect(statements).toHaveLength(3);
    for (const statement of statements) {
      expect(statement.Resource).not.toBe("*");
    }
  });

  test("analyze may read the OpenRouter key", () => {
    expect(secretsFor(templateFor(SECRET_ARNS), "telegator-dev-analyze")).toContain(
      SECRET_ARNS.openRouterSecretArn,
    );
  });

  test("aggregate may read the OpenRouter key", () => {
    expect(secretsFor(templateFor(SECRET_ARNS), "telegator-dev-aggregate")).toContain(
      SECRET_ARNS.openRouterSecretArn,
    );
  });

  /**
   * The bot token is §3.4's send credential and nothing else. A model stage
   * holding it could post to the channel outside §3.4 L315's status guard.
   */
  test("neither model stage may read the Telegram token", () => {
    const template = templateFor(SECRET_ARNS);

    for (const name of ["telegator-dev-analyze", "telegator-dev-aggregate"]) {
      expect(secretsFor(template, name)).not.toContain(SECRET_ARNS.telegramSecretArn);
    }
  });

  test("publish may read the Telegram token and not the model key", () => {
    const granted = secretsFor(templateFor(SECRET_ARNS), "telegator-dev-publish");

    expect(granted).toContain(SECRET_ARNS.telegramSecretArn);
    expect(granted).not.toContain(SECRET_ARNS.openRouterSecretArn);
  });

  /** scrape and dlq-replay call neither a model nor Telegram. */
  test("no other function may read a secret", () => {
    const template = templateFor(SECRET_ARNS);

    for (const name of ["telegator-dev-scrape", "telegator-dev-dlq-replay"]) {
      expect(secretsFor(template, name)).toBe("[]");
    }
  });

  /**
   * §7.6 L709 reads "read/write `messages`", which `grantReadWriteData` matches
   * literally — and that helper also grants DeleteItem and BatchWriteItem.
   * `publish` calls exactly two APIs: `GetItem` (§3.4 L315's load) and
   * `UpdateItem` (§3.4 L348's result write).
   *
   * The narrow reading wins here because of what the wide one enables. §7.2
   * makes `messages` the only durable record of a Telegram post — §1.3 L69 says
   * a post that never merges "leaves no row anywhere" — and §8.4 L799 makes even
   * an operator's delete soft for that reason. A stage that never deletes should
   * not be able to, least of all irrecoverably.
   */
  test("publish may read and update messages, and nothing more (§7.6 L709)", () => {
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
   * §7.6 L705 — "read/write `sources`". `scrape` calls `listByStatus` (a Query
   * on `status-index`) and `updateCursor` (an UpdateItem). It never reads a
   * source by id, never creates one, and never deletes one.
   */
  test("scrape may query and update sources, and nothing more", () => {
    expect(dynamoActionsFor(templateFor(), "telegator-dev-scrape")).toEqual(
      new Set(["dynamodb:Query", "dynamodb:UpdateItem"]),
    );
  });

  /**
   * §7.6 L707 — "read/write `messages`". `aggregate` calls `get`, `queryByDate`
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
   * index would fail at runtime on §3.1 L197's source selection and §6 L558's
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

  /** No stage deletes a record: §8.4 L799 makes even an operator's delete soft. */
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

  /** §9.3 L907 — "No VPC." A VPC would need NAT for outbound scraping, with no security gain. */
  test("places no function in a VPC", () => {
    for (const fn of Object.values(templateFor().findResources("AWS::Lambda::Function"))) {
      expect(fn.Properties?.VpcConfig).toBeUndefined();
    }
  });
});

describe("alarms (§7.7 L739)", () => {
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

  /** §7.2 L638 — "Alarm at > 500 — the point at which the in-memory comparison assumption needs revisiting." */
  test("alarms when a day's dedup candidates exceed 500", () => {
    const alarm = alarms(templateFor()).find((a) => a.MetricName === "DedupCandidateCount");

    expect(alarm?.Threshold).toBe(500);
    expect(alarm?.Namespace).toBe(METRIC_NAMESPACE);
  });

  /**
   * R25 — §7.7 L739 alarms on "SourceStale for any source", but the metric is
   * dimensioned by a runtime-discovered Source. A CloudWatch alarm cannot
   * enumerate that at synth time and lookups are banned, so item 3.5 emits the
   * metric undimensioned as well and the alarm watches that.
   */
  test("alarms on the undimensioned SourceStale", () => {
    const alarm = alarms(templateFor()).find((a) => a.MetricName === "SourceStale");

    expect(alarm).toBeDefined();
    expect(alarm?.Dimensions ?? []).toEqual([]);
  });

  /** §10.4 L995 targets "oldest message < 1 hour under normal load". */
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
