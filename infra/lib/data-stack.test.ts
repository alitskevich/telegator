import { App } from "aws-cdk-lib";
import { Match, Template } from "aws-cdk-lib/assertions";
import { afterAll, describe, expect, test, vi } from "vitest";

/**
 * A private CDK output directory per App.
 *
 * `NodejsFunction` stages its bundle on disk during synth, so parallel vitest
 * workers sharing one cdk.out race over the staging directory.
 */

import { cdkContext } from "../../test/support/cdkContext";
import { isolatedOutdir, removeIsolatedOutdirs } from "../../test/support/cdkOutdir";
import { resolveConfig } from "./config";
import { TelegatorDataStack } from "./data-stack";

/**
 * The 5 s default is not enough for the first synth in a worker: CDK stages
 * bundles on disk, and under the suite's parallelism these files intermittently
 * timed out while the assertions themselves are instant. The synth-based test
 * files that already raise it were, until now, only most of them.
 */
vi.setConfig({ testTimeout: 60_000 });

// Item 10.0 — without this each synth leaves ~9 MB of bundles behind.
afterAll(removeIsolatedOutdirs);

function templateFor(context: Record<string, unknown> = {}): Template {
  const app = new App({ context: cdkContext(context), outdir: isolatedOutdir() });
  const stack = new TelegatorDataStack(app, "TelegatorDataStack", {
    config: resolveConfig(app),
  });
  return Template.fromStack(stack);
}

const table = (t: Template, name: string) =>
  Object.values(t.findResources("AWS::DynamoDB::Table")).find(
    (r) => r.Properties?.TableName === name,
  )?.Properties;

describe("TelegatorDataStack", () => {
  test("declares the three tables: §7.2 L629's two, plus targets (R56)", () => {
    templateFor().resourceCountIs("AWS::DynamoDB::Table", 3);
  });

  test("names them with the §9.2 L896 environment prefix", () => {
    const t = templateFor({ env: "prod" });

    expect(table(t, "telegator-prod-sources")).toBeDefined();
    expect(table(t, "telegator-prod-messages")).toBeDefined();
    expect(table(t, "telegator-prod-targets")).toBeDefined();
  });

  /** §7.2 L629 — "both `PAY_PER_REQUEST`". */
  test.each(["telegator-dev-sources", "telegator-dev-messages", "telegator-dev-targets"])(
    "%s bills per request",
    (name) => {
      expect(table(templateFor(), name)?.BillingMode).toBe("PAY_PER_REQUEST");
    },
  );

  test.each(["telegator-dev-sources", "telegator-dev-messages", "telegator-dev-targets"])(
    "%s is keyed by id",
    (name) => {
      expect(table(templateFor(), name)?.KeySchema).toEqual([
        { AttributeName: "id", KeyType: "HASH" },
      ]);
    },
  );

  describe("sources", () => {
    /** §7.2 L633 — `status-index`: PK `status`, and no sort key. */
    test("has a status-index keyed on status alone", () => {
      const gsis = table(templateFor(), "telegator-dev-sources")?.GlobalSecondaryIndexes;

      expect(gsis).toHaveLength(1);
      expect(gsis?.[0]?.IndexName).toBe("status-index");
      expect(gsis?.[0]?.KeySchema).toEqual([{ AttributeName: "status", KeyType: "HASH" }]);
    });

    /**
     * §3.1 L199-228 reads or writes nearly every attribute of a selected source
     * — teaser, category, tags, the cursor fields — so a narrow projection would
     * force a second read per source on every run.
     */
    test("projects every attribute, since scrape reads nearly all of them", () => {
      const gsis = table(templateFor(), "telegator-dev-sources")?.GlobalSecondaryIndexes;

      expect(gsis?.[0]?.Projection).toEqual({ ProjectionType: "ALL" });
    });
  });

  describe("messages", () => {
    const gsisOf = (t: Template) =>
      table(t, "telegator-dev-messages")?.GlobalSecondaryIndexes as
        | Array<{ IndexName: string; KeySchema: unknown; Projection: Record<string, unknown> }>
        | undefined;

    const index = (t: Template, name: string) => gsisOf(t)?.find((g) => g.IndexName === name);

    test("has both indexes §7.2 L634 names", () => {
      expect(
        gsisOf(templateFor())
          ?.map((g) => g.IndexName)
          .sort(),
      ).toEqual(["date-index", "status-index"]);
    });

    test("status-index is PK status, SK ts", () => {
      expect(index(templateFor(), "status-index")?.KeySchema).toEqual([
        { AttributeName: "status", KeyType: "HASH" },
        { AttributeName: "ts", KeyType: "RANGE" },
      ]);
    });

    test("date-index is PK date, SK ts — the deduplication index", () => {
      expect(index(templateFor(), "date-index")?.KeySchema).toEqual([
        { AttributeName: "date", KeyType: "HASH" },
        { AttributeName: "ts", KeyType: "RANGE" },
      ]);
    });

    /**
     * §7.2 L636 — status-index "uses INCLUDE with dashboard-visible attributes
     * only, excluding `embedding` and `members` — the two large attributes".
     * This is the assertion that keeps R26 honest: with `members` unprojected,
     * §8.3 L798's expandable member list must be a lazy base-table read.
     */
    test("status-index excludes the two large attributes", () => {
      const projection = index(templateFor(), "status-index")?.Projection;

      expect(projection?.ProjectionType).toBe("INCLUDE");
      expect(projection?.NonKeyAttributes).not.toContain("members");
      expect(projection?.NonKeyAttributes).not.toContain("embedding");
    });

    test("status-index projects what §8.3 L798 and §8.5 L832 render (R27)", () => {
      const projected = index(templateFor(), "status-index")?.Projection?.NonKeyAttributes ?? [];

      for (const attribute of ["title", "category", "date", "tgChannel", "memberCount"]) {
        expect(projected).toContain(attribute);
      }
    });

    /**
     * multi-target#2.4, D2 — the post map is base-table only, and the renamed
     * source column never reaches the messages table at all. A projection change
     * is accepted by `cdk diff` and refused by DynamoDB (§7.2 L638), so this is
     * the only place the invariant can fail loudly (multi-target#15.3).
     */
    test("MT-16: neither index projects posts or target", () => {
      const template = templateFor();

      for (const name of ["status-index", "date-index"]) {
        const projected = index(template, name)?.Projection?.NonKeyAttributes ?? [];
        expect(projected).not.toContain("posts");
        expect(projected).not.toContain("target");
      }
    });

    /**
     * R44 — §7.2 L636 called this "the one query that needs vectors". There are
     * no vectors now: the projection carries the match key R46 scores on and
     * `memberIds` instead, and still excludes `members`.
     */
    test("date-index no longer projects the embedding, and still excludes members", () => {
      const projection = index(templateFor(), "date-index")?.Projection;

      expect(projection?.NonKeyAttributes).not.toContain("embedding");
      expect(projection?.NonKeyAttributes).not.toContain("members");
    });

    /** R44/R51 — the four attributes `matchKeyOf`/`memberIds` need, verbatim. */
    test("date-index projects the match key and member ids, not the embedding (R44)", () => {
      const template = templateFor();

      template.hasResourceProperties("AWS::DynamoDB::Table", {
        GlobalSecondaryIndexes: Match.arrayWith([
          Match.objectLike({
            IndexName: "date-index",
            Projection: Match.objectLike({
              NonKeyAttributes: Match.arrayWith([
                "keyEntities",
                "keyTitle",
                "keyTags",
                "memberIds",
              ]),
            }),
          }),
        ]),
      });
    });

    /** §9.1 L883 and §10.4 L1028 — the only §10.4 row verifiable without a deployment. */
    test("has point-in-time recovery enabled", () => {
      expect(
        table(templateFor(), "telegator-dev-messages")?.PointInTimeRecoverySpecification,
      ).toEqual({ PointInTimeRecoveryEnabled: true });
    });
  });

  /**
   * The invariant the whole synth gate rests on: `cdk synth` only runs without
   * credentials while every stack stays environment-agnostic.
   */
  test("is environment-agnostic and requests no context lookup", () => {
    const app = new App({ context: cdkContext(), outdir: isolatedOutdir() });
    new TelegatorDataStack(app, "TelegatorDataStack", { config: resolveConfig(app) });
    const assembly = app.synth();

    expect(assembly.manifest.missing ?? []).toEqual([]);
    for (const stack of assembly.stacks) {
      expect(stack.environment.account).toBe("unknown-account");
      expect(stack.environment.region).toBe("unknown-region");
    }
  });

  test("declares no resource beyond the three tables", () => {
    templateFor().resourceCountIs("AWS::DynamoDB::Table", 3);
    expect(Object.keys(templateFor().toJSON().Resources ?? {})).toHaveLength(3);
  });

  test("exposes both tables to the stacks that consume them", () => {
    const app = new App({ context: cdkContext(), outdir: isolatedOutdir() });
    const stack = new TelegatorDataStack(app, "TelegatorDataStack", { config: resolveConfig(app) });

    /**
     * Named rather than merely defined. `Match.anyValue()` stood here, which
     * constructs a matcher object and can never be undefined — it asserted
     * nothing at all.
     *
     * What is worth asserting is that the two properties are not swapped. Every
     * consumer wires them by name (`data.sources`, `data.messages`), both are
     * DynamoDB tables, and a swap type-checks and synthesises: the pipeline
     * would write messages into the sources table, and §7.2's indexes would be
     * missing on whichever it read.
     *
     * `tableName` cannot carry this: it resolves to a CDK token, not the
     * configured string, so a substring check on it fails against correct code.
     */
    expect(stack.sources.node.id).toBe("SourcesTable");
    expect(stack.messages.node.id).toBe("MessagesTable");
  });

  describe("targets (target-table#2.2, R56)", () => {
    test("TT-17: is keyed by id, bills per request and is retained", () => {
      const properties = table(templateFor(), "telegator-dev-targets");

      expect(properties?.KeySchema).toEqual([{ AttributeName: "id", KeyType: "HASH" }]);
      expect(properties?.BillingMode).toBe("PAY_PER_REQUEST");
    });

    /** D1 — an operator's templates outlive the stack that created the table. */
    test("TT-17: is retained when the stack goes", () => {
      const retained = Object.values(templateFor().findResources("AWS::DynamoDB::Table")).find(
        (resource) => resource.Properties?.TableName === "telegator-dev-targets",
      );

      expect(retained?.DeletionPolicy).toBe("Retain");
    });

    /**
     * D8 — tens of rows, one access pattern by id and one full listing. A
     * projection is the one thing that cannot be changed in place later, so the
     * absence of an index is worth pinning rather than assuming.
     */
    test("TT-17: has no global secondary index", () => {
      expect(table(templateFor(), "telegator-dev-targets")?.GlobalSecondaryIndexes).toBeUndefined();
    });

    /** The templates are re-typeable; `messages` is the record that is not. */
    test("TT-17: needs no point-in-time recovery", () => {
      expect(
        table(templateFor(), "telegator-dev-targets")?.PointInTimeRecoverySpecification,
      ).toBeUndefined();
    });
  });
});
