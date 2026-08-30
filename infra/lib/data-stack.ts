import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { AttributeType, BillingMode, ProjectionType, Table } from "aws-cdk-lib/aws-dynamodb";
import type { Construct } from "constructs";
import type { TelegatorConfig } from "./config";

/**
 * §9.1 L800 — two DynamoDB tables with their GSIs, PITR on `messages`.
 *
 * §7.2 L583: "Two tables, both `PAY_PER_REQUEST`. Nothing is co-queried across
 * them, so single-table modelling would add ceremony with no payoff."
 */

export interface TelegatorDataStackProps extends StackProps {
  readonly config: TelegatorConfig;
}

/**
 * The `status-index` projection on `messages` (§7.2 L598, R27).
 *
 * L598 says "INCLUDE with dashboard-visible attributes only, **excluding
 * `embedding` and `members`** — the two large attributes" without listing them.
 * This is §8.3 L742's Messages columns plus what §8.5 L772's recent-messages
 * card renders.
 *
 * Leaving `members` unprojected is what forces R26: §8.3's expandable member
 * list has to be a lazy base-table read, because this index will never return
 * the map.
 */
const MESSAGE_LIST_ATTRIBUTES = [
  "title",
  // `date` is a key on `date-index` but a plain attribute here, so it has to be
  // named explicitly or §8.3 L742's date column comes back undefined.
  "date",
  "category",
  "country",
  "location",
  "image",
  "tags",
  "tgChannel",
  "tgId",
  "tgAt",
  "memberCount",
  "deleted",
] as const;

/**
 * The `date-index` projection (§7.2 L598, R27, amended by R44/R51).
 *
 * §7.2 L598 calls this "the one query that needs vectors". There are no
 * vectors now: it needs the match key R46 scores on, plus the member ids
 * R51's replay short-circuit checks. Everything the merge needs beyond that
 * still comes from the base-table read of R9.
 *
 * **Deploying this change to an environment that already has `date-index` may
 * need two deploys.** These attributes replace `["embedding", "deleted"]`, and
 * DynamoDB's `UpdateTable` cannot alter an existing GSI's projection at all:
 * CloudFormation accepts only a narrow set of GSI updates (and only one index
 * created or deleted per stack update). `cdk diff` renders this as an in-place
 * modification of the index and gives no warning, because the diff is computed
 * from the template alone and cannot know what the service will accept at apply
 * time. If the update is rejected, there is no fallback: `tableName` is fixed
 * by `config.name()` and `removalPolicy` is RETAIN, so a replacement of the
 * table would fail on the existing name rather than silently recreate it.
 *
 * The sequence, if it is needed, is: deploy once with the `date-index` block
 * below removed, wait for the index to finish deleting, then deploy again with
 * it restored and this projection in place. That is an operational decision —
 * it drops dedup candidate lookups for the duration — so it is documented here
 * and in §10 of `docs/superpowers/specs/2026-08-30-dedup-without-embeddings-design.md`
 * rather than encoded. A brand-new environment creates the index once and is
 * unaffected.
 */
const DEDUP_CANDIDATE_ATTRIBUTES = [
  "keyEntities",
  "keyTitle",
  "keyTags",
  "memberIds",
  "deleted",
] as const;

/**
 * `Table`, not `TableV2`, is deliberate. `TableV2` synthesises as
 * `AWS::DynamoDB::GlobalTable` even with a single replica — a different
 * resource type whose PITR and billing settings live inside a per-replica
 * structure. §7.2 describes two plain regional tables and never mentions
 * replication, so the simplest faithful mapping is the one that emits
 * `AWS::DynamoDB::Table`.
 */
export class TelegatorDataStack extends Stack {
  /** §2.1 — the channels to poll. */
  public readonly sources: Table;
  /** §2.3 — the only durable record of a Telegram post. */
  public readonly messages: Table;

  constructor(scope: Construct, id: string, props: TelegatorDataStackProps) {
    super(scope, id, props);

    const { config } = props;

    this.sources = new Table(this, "SourcesTable", {
      tableName: config.name("sources"),
      partitionKey: { name: "id", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      // The cursors in this table are what stop a redeploy re-scraping and
      // double-posting (§9.5 step 5), so the table outlives its stack.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // §7.2 L587's `status-index` drives scrape selection (§3.1 L187). It has no
    // sort key: L587 gives only a partition key.
    this.sources.addGlobalSecondaryIndex({
      indexName: "status-index",
      partitionKey: { name: "status", type: AttributeType.STRING },
      // ALL rather than INCLUDE: §3.1 L187–216 reads or writes nearly every
      // attribute of a selected source — teaser, category, tags and all five
      // cursor fields — so a narrow projection would just add a second read per
      // source on every run.
      projectionType: ProjectionType.ALL,
    });

    this.messages = new Table(this, "MessagesTable", {
      tableName: config.name("messages"),
      partitionKey: { name: "id", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      // §9.1 L800 and §11.4 L877. This is the one non-functional target of §11.4
      // that can be verified without a deployment.
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // §2.3 L138 — the only durable record of a Telegram post.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // §7.2 L588 — publish backlog, dashboard listing, counts.
    this.messages.addGlobalSecondaryIndex({
      indexName: "status-index",
      partitionKey: { name: "status", type: AttributeType.STRING },
      sortKey: { name: "ts", type: AttributeType.NUMBER },
      projectionType: ProjectionType.INCLUDE,
      nonKeyAttributes: [...MESSAGE_LIST_ATTRIBUTES],
    });

    // §7.2 L588 — "**the deduplication index**". §3.3 L276 makes the date filter
    // a correctness rule rather than an optimisation.
    this.messages.addGlobalSecondaryIndex({
      indexName: "date-index",
      partitionKey: { name: "date", type: AttributeType.STRING },
      sortKey: { name: "ts", type: AttributeType.NUMBER },
      projectionType: ProjectionType.INCLUDE,
      nonKeyAttributes: [...DEDUP_CANDIDATE_ATTRIBUTES],
    });
  }
}
