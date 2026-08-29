import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, test } from "vitest";

/**
 * A private CDK output directory per App.
 *
 * `NodejsFunction` stages its bundle on disk during synth, so parallel vitest
 * workers sharing one cdk.out race over the staging directory.
 */
const isolatedOutdir = () => mkdtempSync(join(tmpdir(), "telegator-cdk-"));

import { resolveConfig } from "./config.js";
import { TelegatorDataStack } from "./data-stack.js";

function templateFor(context: Record<string, unknown> = {}): Template {
  const app = new App({ context, outdir: isolatedOutdir() });
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
  test("declares exactly the two tables §7.2 L583 names", () => {
    templateFor().resourceCountIs("AWS::DynamoDB::Table", 2);
  });

  test("names them with the §9.2 L810 environment prefix", () => {
    const t = templateFor({ env: "prod" });

    expect(table(t, "telegator-prod-sources")).toBeDefined();
    expect(table(t, "telegator-prod-messages")).toBeDefined();
  });

  /** §7.2 L583 — "both `PAY_PER_REQUEST`". */
  test.each(["telegator-dev-sources", "telegator-dev-messages"])("%s bills per request", (name) => {
    expect(table(templateFor(), name)?.BillingMode).toBe("PAY_PER_REQUEST");
  });

  test.each(["telegator-dev-sources", "telegator-dev-messages"])("%s is keyed by id", (name) => {
    expect(table(templateFor(), name)?.KeySchema).toEqual([
      { AttributeName: "id", KeyType: "HASH" },
    ]);
  });

  describe("sources", () => {
    /** §7.2 L587 — `status-index`: PK `status`, and no sort key. */
    test("has a status-index keyed on status alone", () => {
      const gsis = table(templateFor(), "telegator-dev-sources")?.GlobalSecondaryIndexes;

      expect(gsis).toHaveLength(1);
      expect(gsis?.[0]?.IndexName).toBe("status-index");
      expect(gsis?.[0]?.KeySchema).toEqual([{ AttributeName: "status", KeyType: "HASH" }]);
    });

    /**
     * §3.1 L187-216 reads or writes nearly every attribute of a selected source
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

    test("has both indexes §7.2 L588 names", () => {
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
     * §7.2 L598 — status-index "uses INCLUDE with dashboard-visible attributes
     * only, excluding `embedding` and `members` — the two large attributes".
     * This is the assertion that keeps R26 honest: with `members` unprojected,
     * §8.3 L742's expandable member list must be a lazy base-table read.
     */
    test("status-index excludes the two large attributes", () => {
      const projection = index(templateFor(), "status-index")?.Projection;

      expect(projection?.ProjectionType).toBe("INCLUDE");
      expect(projection?.NonKeyAttributes).not.toContain("members");
      expect(projection?.NonKeyAttributes).not.toContain("embedding");
    });

    test("status-index projects what §8.3 L742 and §8.5 L772 render (R27)", () => {
      const projected = index(templateFor(), "status-index")?.Projection?.NonKeyAttributes ?? [];

      for (const attribute of ["title", "category", "date", "tgChannel", "memberCount"]) {
        expect(projected).toContain(attribute);
      }
    });

    /** §7.2 L598 — "Only `date-index` projects `embedding`, because it is the one query that needs vectors." */
    test("date-index projects the embedding, and not members", () => {
      const projection = index(templateFor(), "date-index")?.Projection;

      expect(projection?.NonKeyAttributes).toContain("embedding");
      expect(projection?.NonKeyAttributes).not.toContain("members");
    });

    /** §9.1 L800 and §11.4 L877 — the only §11.4 row verifiable without a deployment. */
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
    const app = new App({ context: {}, outdir: isolatedOutdir() });
    new TelegatorDataStack(app, "TelegatorDataStack", { config: resolveConfig(app) });
    const assembly = app.synth();

    expect(assembly.manifest.missing ?? []).toEqual([]);
    for (const stack of assembly.stacks) {
      expect(stack.environment.account).toBe("unknown-account");
      expect(stack.environment.region).toBe("unknown-region");
    }
  });

  test("declares no resource beyond the two tables", () => {
    templateFor().resourceCountIs("AWS::DynamoDB::Table", 2);
    expect(Object.keys(templateFor().toJSON().Resources ?? {})).toHaveLength(2);
  });

  test("exposes both tables to the stacks that consume them", () => {
    const app = new App({ context: {}, outdir: isolatedOutdir() });
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
});
