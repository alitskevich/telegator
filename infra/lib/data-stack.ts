import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { AttributeType, BillingMode, ProjectionType, Table } from "aws-cdk-lib/aws-dynamodb";
import type { Construct } from "constructs";
import type { TelegatorConfig } from "./config";

/**
 * §9.1 L883 — two DynamoDB tables with their GSIs, PITR on `messages`.
 *
 * §7.2 L629: "Two tables, both `PAY_PER_REQUEST`. Nothing is co-queried across
 * them, so single-table modelling would add ceremony with no payoff."
 */

export interface TelegatorDataStackProps extends StackProps {
  readonly config: TelegatorConfig;
}

/**
 * The `status-index` projection on `messages` (§7.2 L636, R27).
 *
 * L636 excludes the large attributes without listing what remains. This is
 * §8.3 L798's Messages columns plus what §8.5 L834's recent-messages card
 * renders.
 *
 * Leaving `members` unprojected is what forces R26: §8.3's expandable member
 * list has to be a lazy base-table read, because this index will never return
 * the map.
 *
 * `posts` (multi-target#2.4) is deliberately absent, and so is the sources
 * column `target`: nothing on the dashboard reads a post id, and adding either
 * here would be a projection change — two deploys and a dedup blackout (§7.2
 * L638). `data-stack.test.ts` MT-16 pins both.
 */
const MESSAGE_LIST_ATTRIBUTES = [
  "title",
  // `date` is a key on `date-index` but a plain attribute here, so it has to be
  // named explicitly or §8.3 L798's date column comes back undefined.
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
 * The `date-index` projection (§7.2 L636, R27, amended by R44/R51).
 *
 * The match key R46 scores on, plus the member ids R51's replay short-circuit
 * checks. Everything a merge needs beyond that comes from R9's base-table read.
 *
 * **Changing this projection on an environment that already has `date-index`
 * takes two deploys, and `cdk diff` will not warn you.** §7.2 L638 carries the
 * sequence and what it costs while it runs. A brand-new environment creates the
 * index once and is unaffected.
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
  /** target-table#2.2 (R56) — one row per publish destination. */
  public readonly targets: Table;

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

    // §7.2 L633's `status-index` drives scrape selection (§3.1 L199). It has no
    // sort key: L633 gives only a partition key.
    this.sources.addGlobalSecondaryIndex({
      indexName: "status-index",
      partitionKey: { name: "status", type: AttributeType.STRING },
      // ALL rather than INCLUDE: §3.1 L199–228 reads or writes nearly every
      // attribute of a selected source — teaser, category, tags and all five
      // cursor fields — so a narrow projection would just add a second read per
      // source on every run.
      projectionType: ProjectionType.ALL,
    });

    this.messages = new Table(this, "MessagesTable", {
      tableName: config.name("messages"),
      partitionKey: { name: "id", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      // §9.1 L883 and §10.4 L1028. This is the one non-functional target of §10.4
      // that can be verified without a deployment.
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // §2.3 L148 — the only durable record of a Telegram post.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // §7.2 L634 — publish backlog, dashboard listing, counts.
    this.messages.addGlobalSecondaryIndex({
      indexName: "status-index",
      partitionKey: { name: "status", type: AttributeType.STRING },
      sortKey: { name: "ts", type: AttributeType.NUMBER },
      projectionType: ProjectionType.INCLUDE,
      nonKeyAttributes: [...MESSAGE_LIST_ATTRIBUTES],
    });

    // §7.2 L634 — "**the deduplication index**". §6 L541 makes the date filter
    // a correctness rule rather than an optimisation.
    this.messages.addGlobalSecondaryIndex({
      indexName: "date-index",
      partitionKey: { name: "date", type: AttributeType.STRING },
      sortKey: { name: "ts", type: AttributeType.NUMBER },
      projectionType: ProjectionType.INCLUDE,
      nonKeyAttributes: [...DEDUP_CANDIDATE_ATTRIBUTES],
    });

    /**
     * target-table#2.2 — the registry (R56).
     *
     * §7.2 L629's "two tables" becomes three: a target is not a source, and
     * §7.2's own reasoning holds — nothing is co-queried across them, so
     * single-table modelling would add ceremony with no payoff.
     *
     * No index (D8): tens of rows, one `GetItem` by id and one `Scan`. No PITR
     * either — an operator's template is re-typeable, and `messages` is the
     * record that is not. `RETAIN` all the same, so a stack replacement does
     * not take the templates with it.
     */
    this.targets = new Table(this, "TargetsTable", {
      tableName: config.name("targets"),
      partitionKey: { name: "id", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }
}
