import type { Adjudicator } from "../../ai/ports";
import type { Clock } from "../../clock";
import type { MessageRepo } from "../../db/ports";
import { type DedupDeps, type DedupWrite, dedupBatch } from "../../dedup/dedupBatch";
import type { Band } from "../../dedup/score";
import type { AnalyzedItem } from "../../domain/item";
import type { Logger } from "../../logging/logger";
import type { MetricSink } from "../../metrics/ports";
import {
  AggregateQueuePayloadSchema,
  publishQueueMessage,
  type QueueProducer,
  SQS_MAX_BATCH_ENTRIES,
} from "../../queues/ports";

/**
 * Stage 3 — the §3.3 aggregate consumer (L256–308).
 *
 * This module is **wiring only**. The whole of §6's normative algorithm lives in
 * `lib/dedup/dedupBatch.ts`, pure and separately tested; duplicating any part of
 * it here would give the spec two implementations that could drift. What is left
 * is the four steps §6 L547–552 leave to the caller: parse the queue payloads,
 * apply the writes, enqueue the touched ids, and report which SQS records failed.
 *
 * **Metrics.** Every aggregate counter — §7.7's `MessagesCreated`,
 * `MessagesMerged`, `MemberCapReached` and `DedupCandidateCount`, and R50's
 * `DedupAdjudicated` and `DedupAdjudicationFailed` — is emitted by `dedupBatch`
 * through the sink this stage hands it. There is nothing left for this module to
 * emit, and emitting any of them again would double-count a number §7.7 L679
 * makes the pipeline's system of record.
 */

export interface AggregateDeps {
  /**
   * R46 — §3.3 L268's single `embedBatch` call for the batch, replaced by at
   * most one adjudication call for the batch: only the pairs `lib/dedup`'s band
   * cannot decide reach a model at all.
   */
  readonly adjudicator: Adjudicator;
  readonly messages: MessageRepo;
  /** §7.3 L608 — the publish FIFO queue. */
  readonly queue: QueueProducer;
  readonly clock: Clock;
  readonly metrics: MetricSink;
  readonly logger: Logger;
  /**
   * §11.3 L864 requires the decision boundary to be recalibrated before
   * production. Passed straight through to `dedupBatch`, so that recalibration
   * is a configuration change rather than a code edit (R46).
   */
  readonly band?: Band;
}

/**
 * The two fields of an SQS record this stage reads.
 *
 * Structural rather than the SDK's `SQSRecord`: a real record satisfies it, and
 * typing it here keeps `aws-lambda` out of `lib/`, which §8.2 L734 reserves for
 * the stage implementation itself.
 */
export interface AggregateRecord {
  readonly messageId: string;
  readonly body: string;
}

/** §7.3 L620 — the `ReportBatchItemFailures` response shape. */
export interface BatchItemFailure {
  readonly itemIdentifier: string;
}

export interface AggregateResult {
  readonly batchItemFailures: BatchItemFailure[];
}

export async function runAggregate(
  records: readonly AggregateRecord[],
  deps: AggregateDeps,
): Promise<AggregateResult> {
  // A Set, because one SQS record can be reported through more than one path —
  // its write fails and, on a later chunk, so does its enqueue.
  const failed = new Set<string>();
  const batch: AnalyzedItem[] = [];
  /**
   * Item id → the SQS records carrying it. A list, not a single id: SQS's
   * 5-minute deduplication window is finite, so the same item can legitimately
   * arrive twice in one batch and both copies must share the same fate.
   */
  const recordsByItemId = new Map<string, string[]>();

  for (const record of records) {
    const item = parseRecord(record, deps.logger);
    if (item === undefined) {
      failed.add(record.messageId);
      continue;
    }

    batch.push(item);
    const carriers = recordsByItemId.get(item.id);
    if (carriers === undefined) recordsByItemId.set(item.id, [record.messageId]);
    else carriers.push(record.messageId);
  }

  const failRecordsFor = (itemIds: Iterable<string>): void => {
    for (const itemId of itemIds) {
      for (const recordId of recordsByItemId.get(itemId) ?? []) failed.add(recordId);
    }
  };

  if (batch.length === 0) return { batchItemFailures: toFailures(failed) };

  let result: Awaited<ReturnType<typeof dedupBatch>>;
  try {
    result = await dedupBatch(batch, dedupDeps(deps));
  } catch (error) {
    // The candidate query is batch-wide, so a failure here says nothing about
    // which item is at fault: every parsed record is reported so SQS redelivers
    // the whole batch (§7.3 L620). An adjudication failure is NOT one of these —
    // §11.3 L868 makes it split rather than throw, inside `dedupBatch`.
    deps.logger.error("aggregate dedup failed", { error: describeError(error) });
    failRecordsFor(recordsByItemId.keys());
    return { batchItemFailures: toFailures(failed) };
  }

  /**
   * Message id → the ids of *this batch's* items absorbed into it, which is what
   * makes a per-write failure attributable back to SQS records. A create's
   * `members` are all from this batch by construction, and a merge carries only
   * the members this batch added (`DedupWrite`'s `merge.members`).
   */
  const contributors = new Map<string, string[]>(
    result.writes.map((write) => [idOf(write), Object.keys(membersOf(write))]),
  );

  const written = new Set<string>();
  // Sequential: at most ten writes per batch, and awaiting each one is what lets
  // a single failure be attributed to its own records rather than rejecting a
  // combinator and losing the rest.
  for (const write of result.writes) {
    const id = idOf(write);
    try {
      // R9 — a create is a whole-record put; a merge is attribute-level, so it
      // cannot erase members it never loaded, and leaves `tgId`/`tgAt` alone.
      if (write.kind === "create") await deps.messages.putNew(write.message);
      else await deps.messages.mergeMember(write.merge);
      written.add(id);
    } catch (error) {
      deps.logger.error("aggregate write failed", { messageId: id, error: describeError(error) });
      failRecordsFor(contributors.get(id) ?? []);
    }
  }

  // §6 L547–552 — write first, enqueue second, and only what was written. An id
  // whose write failed would send publish to a record that does not reflect it.
  await enqueuePublish(
    result.toPublish.filter((id) => written.has(id)),
    contributors,
    failRecordsFor,
    deps,
  );

  return { batchItemFailures: toFailures(failed) };
}

/**
 * §3.3 L290–294 — one publish enqueue per touched id.
 *
 * `publishQueueMessage` sets `MessageGroupId` and `MessageDeduplicationId` to the
 * message id (L292–293). **R19: no per-message `DelaySeconds`.** SQS FIFO
 * supports only a queue-level delay, so L294's settle delay is configured on the
 * publish queue itself (§7.3 L608) and cannot be set here.
 */
async function enqueuePublish(
  messageIds: readonly string[],
  contributors: ReadonlyMap<string, string[]>,
  failRecordsFor: (itemIds: Iterable<string>) => void,
  deps: AggregateDeps,
): Promise<void> {
  for (const chunk of chunks(messageIds, SQS_MAX_BATCH_ENTRIES)) {
    // A send failure is reported even though the write succeeded: redelivery
    // replays the item, and §6 L557's `members`-keyed map makes that a no-op
    // (AC-3.7). An un-enqueued message would otherwise never be published.
    try {
      const sent = await deps.queue.send(chunk.map(publishQueueMessage));
      for (const failure of sent.failed) {
        const messageId = chunk[failure.index];
        if (messageId === undefined) continue;
        deps.logger.error("publish enqueue failed", {
          messageId,
          code: failure.code,
          error: failure.message,
        });
        failRecordsFor(contributors.get(messageId) ?? []);
      }
    } catch (error) {
      deps.logger.error("publish enqueue threw", { error: describeError(error) });
      for (const messageId of chunk) failRecordsFor(contributors.get(messageId) ?? []);
    }
  }
}

/** Builds §6's dependencies from the stage's: L515's query is `queryByDate`, R9's read is `get`. */
function dedupDeps(deps: AggregateDeps): DedupDeps {
  return {
    adjudicator: deps.adjudicator,
    loadCandidatesByDate: (date) => deps.messages.queryByDate(date),
    loadMessage: (id) => deps.messages.get(id),
    clock: deps.clock,
    metrics: deps.metrics,
    logger: deps.logger,
    band: deps.band,
  };
}

/**
 * §7.3 L620 — a body that is not a valid Stage B payload is one item's failure,
 * never the batch's. It is logged by SQS message id rather than by content: the
 * body is unvalidated input and belongs in the DLQ, not in every log line.
 */
function parseRecord(record: AggregateRecord, logger: Logger): AnalyzedItem | undefined {
  let json: unknown;
  try {
    json = JSON.parse(record.body);
  } catch (error) {
    logger.warn("aggregate record is not JSON", {
      sqsMessageId: record.messageId,
      error: describeError(error),
    });
    return undefined;
  }

  const parsed = AggregateQueuePayloadSchema.safeParse(json);
  if (!parsed.success) {
    logger.warn("aggregate record failed schema validation", {
      sqsMessageId: record.messageId,
      error: parsed.error.message,
    });
    return undefined;
  }

  return parsed.data;
}

function idOf(write: DedupWrite): string {
  return write.kind === "create" ? write.message.id : write.merge.id;
}

function membersOf(write: DedupWrite): Readonly<Record<string, unknown>> {
  return write.kind === "create" ? write.message.members : write.merge.members;
}

function* chunks<T>(values: readonly T[], size: number): Generator<T[]> {
  for (let start = 0; start < values.length; start += size) {
    yield values.slice(start, start + size);
  }
}

function toFailures(failed: ReadonlySet<string>): BatchItemFailure[] {
  return [...failed].map((itemIdentifier) => ({ itemIdentifier }));
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
