import {
  CLASSIFIER_EFFORT,
  CLASSIFIER_MAX_TOKENS,
  CLASSIFIER_MODEL_ID,
} from "../../ai/constants.js";
import { NEWS_ITEM_SCHEMA } from "../../ai/newsItemSchema.js";
import type { Classifier } from "../../ai/ports.js";
import { SYSTEM_PROMPT } from "../../ai/prompt.js";
import type { ScrapedItem } from "../../domain/item.js";
import { CATEGORY_LOG_FIELD, CLASSIFIED_LOG_MESSAGE } from "../../logging/fields.js";
import type { Logger } from "../../logging/logger.js";
import type { MetricSink } from "../../metrics/ports.js";
import type { QueueMessage, QueueProducer } from "../../queues/ports.js";
import { AnalyzeQueuePayloadSchema, aggregateQueueMessage } from "../../queues/ports.js";
import { normalizeAnalyzed, prefilter, route, skippedDimensions } from "./route.js";

/** Re-exported for the stage's own tests; defined in `lib/logging/fields.ts`. */
export { CATEGORY_LOG_FIELD, CLASSIFIED_LOG_MESSAGE };

/**
 * Stage 2 — the `analyze` SQS consumer (§3.2 L227–246).
 *
 * The stage owns effects only. Every decision it takes comes from `route.ts`
 * (item 3.6): the pre-filter, the routing table and the §3.2 L244 normalisers
 * are pure functions there, and nothing in this file re-decides them. What is
 * left here is the batch loop, the one classifier call per surviving item
 * (L234), the enqueue, the metrics, the category log line and — the part with
 * real money attached — per-message failure reporting.
 */

/** §7.3 L606 and §3.2 L229 — the event source mapping delivers at most ten records. */
export const ANALYZE_BATCH_SIZE = 10;

/** One item, one count. Named because `style/noMagicNumbers` is an error in `lib/`. */
const ONE_ITEM = 1;

/** One SQS record, reduced to the two fields this stage reads. */
export interface AnalyzeRecord {
  readonly messageId: string;
  readonly body: string;
}

export interface AnalyzeDeps {
  readonly classifier: Classifier;
  readonly queue: QueueProducer;
  readonly metrics: MetricSink;
  readonly logger: Logger;
}

/** §7.3 L620 — the `ReportBatchItemFailures` response shape. */
export interface AnalyzeResult {
  readonly batchItemFailures: Array<{ itemIdentifier: string }>;
}

/**
 * The `output_config.format` of §5.2 L423.
 *
 * `schema` is typed from `NEWS_ITEM_SCHEMA` rather than restated, so the JSON
 * Schema the model is held to has exactly one definition (item 2.13).
 */
export interface ClassificationOutputFormat {
  readonly type: "json_schema";
  readonly schema: typeof NEWS_ITEM_SCHEMA;
}

export interface ClassificationOutputConfig {
  /** Absent when R3's option disables it — never present-and-undefined. */
  readonly effort?: string;
  readonly format: ClassificationOutputFormat;
}

export interface ClassificationMessage {
  readonly role: "user";
  readonly content: string;
}

/**
 * The §5.2 L418–427 request body.
 *
 * §5.2 L457: `temperature` and `top_p` are **not** carried over — they are
 * removed on current Claude models and return 400 — so there is no property for
 * them to occupy. Depth is `output_config.effort` instead.
 */
export interface ClassificationRequest {
  readonly model: string;
  readonly max_tokens: number;
  readonly output_config: ClassificationOutputConfig;
  readonly system: string;
  readonly messages: readonly ClassificationMessage[];
}

export interface ClassificationRequestOptions {
  /**
   * R3 — `false` omits `output_config.effort` entirely.
   *
   * §5.2 L421 sets `effort: "low"` and L457 makes it the replacement for the
   * removed sampling parameters, so it is the default. But effort is not
   * available on every Claude tier, and this build cannot reach Bedrock to
   * establish whether R2's `CLASSIFIER_MODEL_ID` accepts it. Configurable and
   * honest beats hard-coded and guessed: nothing in this repo asserts what
   * either shape does to the model, because nothing here can observe it.
   */
  readonly effort?: string | false;
}

/**
 * Builds the classification request of §5.2 L418–427.
 *
 * Pure, and deliberately not a Bedrock call: the adapter that owns the SDK
 * client implements `Classifier` (item 2.14), which keeps the wire shape unit
 * testable on a machine with no Bedrock access at all.
 */
export function buildClassificationRequest(
  itemBody: string,
  options: ClassificationRequestOptions = {},
): ClassificationRequest {
  const effort = options.effort ?? CLASSIFIER_EFFORT;
  const format: ClassificationOutputFormat = { type: "json_schema", schema: NEWS_ITEM_SCHEMA };

  return {
    model: CLASSIFIER_MODEL_ID,
    max_tokens: CLASSIFIER_MAX_TOKENS,
    // The key is built by branch rather than by `{ effort: undefined }`: a tier
    // that rejects `effort` rejects an explicit null just as hard, and
    // `JSON.stringify` is not relied on to drop it.
    output_config: effort === false ? { format } : { effort, format },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: itemBody }],
  };
}

/** A survivor of routing, paired with the SQS message id that must fail if its send does. */
interface Candidate {
  readonly messageId: string;
  readonly message: QueueMessage;
}

function parsePayload(body: string): ScrapedItem {
  return AnalyzeQueuePayloadSchema.parse(JSON.parse(body));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Consumes one batch of analyze-queue records (§3.2 L227–246).
 *
 * Items are classified **sequentially**. §7.5 L648 gives the function 300 s for
 * ten items and §7.5 caps the stage at five concurrent invocations, so the
 * throughput ceiling is the reserved concurrency, not the loop; running the ten
 * calls in parallel would multiply this stage's instantaneous Bedrock rate by
 * ten for no deadline that needs it.
 *
 * Sends are batched once at the end because `SendMessageBatch` takes exactly
 * `SQS_MAX_BATCH_ENTRIES` (10) entries and a batch is at most ten items, so the
 * whole survivor set fits in one call — and `SendResult` reports per-entry
 * outcomes, so a rejected entry can still be attributed to its own message id.
 */
export async function runAnalyze(
  records: readonly AnalyzeRecord[],
  deps: AnalyzeDeps,
): Promise<AnalyzeResult> {
  const batchItemFailures: Array<{ itemIdentifier: string }> = [];
  const candidates: Candidate[] = [];

  for (const sqsRecord of records) {
    try {
      const item = parsePayload(sqsRecord.body);

      // §3.2 L231 — empty or bare-link bodies are dropped before the AI call.
      // The `continue` is the whole point: no request is made, so the drop is
      // free.
      const skipped = prefilter(item.body);
      if (skipped !== undefined) {
        // `prefilter` shares `RouteDecision` with the routing table but can only
        // ever answer `drop` (route.ts). Checking rather than assuming keeps the
        // union exhaustive: were that to change, the item fails back to SQS
        // instead of being acked on a branch nobody wrote.
        if (skipped.kind !== "drop") {
          throw new Error(`pre-filter returned an unexpected decision: ${skipped.kind}`);
        }
        deps.metrics.count("ItemsSkipped", ONE_ITEM, skippedDimensions(skipped.reason));
        deps.logger.debug("item pre-filtered", { itemId: item.id, reason: skipped.reason });
        continue;
      }

      // §3.2 L234 — one request per item. A provider error propagates out of
      // `classify` (lib/ai/ports.ts) into the catch below, which is §3.2 L246's
      // rule: a provider error is transient, so the message is failed back to
      // SQS rather than dropped.
      const classified = await deps.classifier.classify(item.body);
      const decision = route(classified);

      deps.logger.info(CLASSIFIED_LOG_MESSAGE, {
        itemId: item.id,
        [CATEGORY_LOG_FIELD]: classified.category,
        importance: classified.importance,
        // Carried so §8.5 L771's chart can be narrowed to enqueued items later
        // without changing what this stage logs. Every classified item is
        // logged, dropped ones included: the distribution is of what the
        // classifier saw, and a chart missing every `low` item would understate
        // exactly the categories §5.2 L451 tells the model to diminish.
        decision: decision.kind,
      });

      if (decision.kind === "retry") {
        // §3.2 L237 — "No category returned" shares the provider-error row of
        // the routing table, so it takes the same throw-retry-DLQ path.
        //
        // Unreachable through the typed `Classifier` port, in the same way R5's
        // `crime&law` branch is: §5.2 L423 constrains the response to §5.4's
        // enum, so a validated `NewsItem` always carries a category. It is
        // implemented anyway because the port is an interface — an adapter that
        // relaxes validation must not silently start dropping items — and
        // `route.test.ts` pins the decision itself.
        throw new Error(`classification returned no category (${decision.cause})`);
      }

      if (decision.kind === "drop") {
        // §3.2 L246 — a `skip` decision is final. No throw, no failure id: the
        // message is acked and the item ends here.
        deps.metrics.count("ItemsSkipped", ONE_ITEM, skippedDimensions(decision.reason));
        continue;
      }

      candidates.push({
        messageId: sqsRecord.messageId,
        message: aggregateQueueMessage(normalizeAnalyzed(item, classified)),
      });
    } catch (error) {
      // §7.3 L620 — exactly this message fails. Without per-message reporting
      // one poison item forces the whole batch to retry, re-billing the nine
      // successful Bedrock calls.
      batchItemFailures.push({ itemIdentifier: sqsRecord.messageId });
      deps.logger.error("analyze failed", {
        messageId: sqsRecord.messageId,
        error: describeError(error),
      });
    }
  }

  if (candidates.length > 0) {
    await sendCandidates(candidates, batchItemFailures, deps);
  }

  return { batchItemFailures };
}

/**
 * Sends the survivors and attributes every outcome back to an SQS message id.
 *
 * `send` answers a partial failure in its result rather than by throwing (§3.1
 * L216's reading in `lib/queues/ports.ts`), mirroring what `SendMessageBatch`
 * does. An unchecked result would be the worst outcome available: the record is
 * acked to SQS while the item never reached aggregate, and with no items table
 * (§7.7 L679) nothing would ever notice.
 */
async function sendCandidates(
  candidates: readonly Candidate[],
  batchItemFailures: Array<{ itemIdentifier: string }>,
  deps: AnalyzeDeps,
): Promise<void> {
  try {
    const result = await deps.queue.send(candidates.map((candidate) => candidate.message));

    for (const index of result.successful) {
      if (candidates[index] === undefined) continue;
      // §7.7 L687 — `ItemsAnalyzed` counts items that actually reached the next
      // stage, so it stays disjoint from `ItemsSkipped` and the two add up to
      // what §8.5 L766–768's cards claim.
      deps.metrics.count("ItemsAnalyzed", ONE_ITEM);
    }

    for (const failure of result.failed) {
      const candidate = candidates[failure.index];
      if (candidate === undefined) continue;
      batchItemFailures.push({ itemIdentifier: candidate.messageId });
      deps.logger.error("aggregate enqueue rejected", {
        messageId: candidate.messageId,
        code: failure.code,
        error: failure.message,
      });
    }
  } catch (error) {
    // The adapter itself failed — every survivor is unsent, so every survivor's
    // message must be retried. Their classifications are lost with them; that
    // cost is the point of §7.3 L620's per-message reporting being applied to
    // the send as well as to the classify.
    for (const candidate of candidates) {
      batchItemFailures.push({ itemIdentifier: candidate.messageId });
    }
    deps.logger.error("aggregate enqueue failed", { error: describeError(error) });
  }
}
