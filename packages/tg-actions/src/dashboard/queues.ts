import type { Diagnoser } from "tg-ai/types";
import { type ErrorDiagnosis, refOf } from "tg-domain/ingest";
import { AnalyzedItemSchema, ScrapedItemSchema } from "tg-domain/item";
import { SOURCE_STATUS_OK, sourceType } from "tg-domain/source";
import { QUEUES, type QueueName } from "tg-enums/queueName";
import { SOURCE_TYPES } from "tg-enums/sourceType";
import { sources } from "tg-firebase/db";
import {
  countErrors,
  discardErrors,
  listErrors,
  replayErrors,
  saveDiagnosis,
} from "tg-firebase/errors";
import {
  clearIngest,
  getItem,
  listQueue,
  runItemNow,
  runNow,
  saveRaw,
  setPaused,
} from "tg-firebase/ingest";
import type { StoredIngestItem } from "tg-firebase/types";
import { dueAt, selectSources } from "tg-pipeline/scrape/select";
import { z } from "zod";
import type {
  ErrorPreview,
  ErrorsPage,
  ItemDetail,
  QueueItemPreview,
  SourcePreview,
} from "./types";

/**
 * The Dashboard page: the sources scrape would poll; run, pause and step each
 * task stage. The Audit page: handle the items that failed.
 */

/** The most errors the Audit page lists. */
export const ERROR_PAGE = 50;
/** How much of a payload the diagnoser reads. */
const DIAGNOSIS_PAYLOAD = 4000;
/** How many of a stage's next items the panel lists. */
export const QUEUE_PREVIEW = 10;
const PREVIEW_TEXT = 140;

const QueueInput = z.object({ queueName: z.enum(QUEUES) });
const ReplayInput = z.object({ max: z.number().int().positive() });
const IdInput = z.object({ id: z.string().min(1) });
const RunInput = QueueInput.extend({ max: z.number().int().positive().optional() });
const PauseInput = QueueInput.extend({ paused: z.boolean() });
const EditInput = IdInput.extend({ raw: z.record(z.string(), z.unknown()) });

/** What each stage parses its payload with; an edit must pass it. */
const PAYLOADS: Record<QueueName, z.ZodType> = {
  analyze: ScrapedItemSchema,
  aggregate: AnalyzedItemSchema,
  publish: z.object({ messageId: z.string().min(1) }),
};

/** Runs a stage's waiting items now: all of them, or its oldest `max` (a step). */
export async function runStage(input: unknown): Promise<{ released: number }> {
  const { queueName, max } = RunInput.parse(input);
  return { released: await runNow(queueName, max) };
}

export async function pauseStage(input: unknown): Promise<{ paused: boolean }> {
  const { queueName, paused } = PauseInput.parse(input);
  await setPaused(queueName, paused);
  return { paused };
}

const field = (raw: unknown, key: string): string => {
  const value =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)[key] : "";
  return typeof value === "string" ? value : "";
};

export const preview = (item: StoredIngestItem): QueueItemPreview => ({
  id: item.id,
  status: item.status,
  runAt: item.runAt,
  retryCount: item.retryCount,
  error: item.error ?? null,
  ref: refOf(item.raw),
  text: (field(item.raw, "title") || field(item.raw, "body")).slice(0, PREVIEW_TEXT),
});

/** The stage's next items, soonest first, without their payloads. */
export async function inspectQueue(input: unknown): Promise<QueueItemPreview[]> {
  return (await listQueue(QueueInput.parse(input).queueName, QUEUE_PREVIEW)).map(preview);
}

/** Every enabled source: those its reader's next run polls first, then soonest due. */
export async function inspectSources(now = Date.now()): Promise<SourcePreview[]> {
  const enabled = await sources.listByStatus(SOURCE_STATUS_OK);
  const next = new Set(
    SOURCE_TYPES.flatMap((type) => selectSources(enabled, now, type)).map((source) => source.id),
  );
  return enabled
    .map((source) => ({
      id: source.id,
      type: sourceType(source),
      dueAt: dueAt(source),
      next: next.has(source.id),
      lastCount: source.lastCount,
    }))
    .sort((a, b) => Number(b.next) - Number(a.next) || a.dueAt - b.dueAt);
}

/** One item whole, payload included. */
export async function inspectItem(input: unknown): Promise<ItemDetail> {
  const { id } = IdInput.parse(input);
  const item = await getItem(id);
  if (item === undefined) throw new Error(`no such item: ${id}`);
  return {
    id,
    stage: item.stage,
    status: item.status,
    raw: z.record(z.string(), z.unknown()).catch({}).parse(item.raw),
    retryCount: item.retryCount,
    runAt: item.runAt,
    createdAt: item.createdAt,
    finishedAt: item.finishedAt ?? null,
    error: item.error ?? null,
    cause: item.cause ?? null,
  };
}

/** Replaces a waiting or failed item's payload, once its stage's schema accepts it. */
export async function editItem(input: unknown): Promise<{ id: string }> {
  const { id, raw } = EditInput.parse(input);
  const item = await getItem(id);
  if (item === undefined) throw new Error(`no such item: ${id}`);
  if (!(await saveRaw(id, PAYLOADS[item.stage].parse(raw)))) {
    throw new Error(`${id} is no longer waiting or failed`);
  }
  return { id };
}

/** Runs one waiting or failed item next, even on a paused stage. */
export async function runItem(input: unknown): Promise<{ started: boolean }> {
  return { started: await runItemNow(IdInput.parse(input).id) };
}

export const errorPreview = (item: StoredIngestItem): ErrorPreview => ({
  ...preview(item),
  stage: item.stage,
  cause: item.cause ?? null,
  failedAt: item.finishedAt ?? null,
  diagnosis: item.diagnosis ?? null,
});

/** Every stage's errors, oldest first, without their payloads. */
export async function inspectErrors(): Promise<ErrorsPage> {
  const [items, total] = await Promise.all([listErrors(ERROR_PAGE), countErrors()]);
  return { items: items.map(errorPreview), total };
}

/** Sends up to `max` errors back to their stages, oldest first. */
export async function retryErrors(input: unknown): Promise<{ replayed: number }> {
  return { replayed: await replayErrors(ReplayInput.parse(input).max) };
}

export async function purgeErrors(): Promise<{ discarded: number }> {
  return { discarded: await discardErrors() };
}

/** Deletes every `ingest` item; the stages' pause settings stay. */
export async function resetIngest(): Promise<{ deleted: number }> {
  return { deleted: await clearIngest() };
}

/**
 * Asks the model what went wrong with one error and how to fix it, and keeps
 * the answer on the item, so a second look costs nothing.
 */
export async function diagnoseError(input: unknown, diagnoser: Diagnoser): Promise<ErrorDiagnosis> {
  const { id } = IdInput.parse(input);
  const item = await getItem(id);
  if (item?.status !== "error") throw new Error(`${id} is not a failed item`);
  const diagnosis = await diagnoser.diagnose({
    stage: item.stage,
    error: item.error ?? "",
    cause: item.cause,
    attempts: item.retryCount,
    payload: JSON.stringify(item.raw).slice(0, DIAGNOSIS_PAYLOAD),
  });
  await saveDiagnosis(id, diagnosis);
  return diagnosis;
}
