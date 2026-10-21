import type { ErrorDiagnosis } from "tg-domain/ingest";
import type { MemberBlock, MessageListItem } from "tg-domain/message";
import type { IngestStatus } from "tg-enums/ingestStatus";
import type { SkipReason } from "tg-enums/metrics";
import type { QueueName } from "tg-enums/queueName";
import type { SourceVia } from "tg-enums/sourceVia";
import type { Slice } from "tg-utils/ui/types";

export interface Overview {
  readonly scraped: number;
  readonly analyzed: number;
  readonly skipped: { readonly total: number; readonly byReason: Record<SkipReason, number> };
  readonly published: number;
  /** `ingest` items of every stage that used up their attempts. */
  readonly errors: number;
  readonly statusSlices: Slice[];
  readonly categorySlices: Slice[];
  /** Per task stage: its `ingest` items waiting or running. */
  readonly inQueue: Readonly<Record<QueueName, number>>;
  /** Per task stage: whether an operator paused it. */
  readonly paused: Readonly<Record<QueueName, boolean>>;
  readonly recent: MessageListItem[];
}

/** One waiting or running `ingest` item, without its payload. */
export interface QueueItemPreview {
  readonly id: string;
  readonly status: IngestStatus;
  readonly runAt: number;
  readonly retryCount: number;
  readonly error: string | null;
  /** The item id or the message id the payload carries. */
  readonly ref: string;
  /** The start of its title or body. */
  readonly text: string;
}

/** One failed item for the Errors panel: why it failed and the model's reading, without its payload. */
export interface ErrorPreview extends QueueItemPreview {
  readonly stage: QueueName;
  readonly cause: string | null;
  readonly failedAt: number | null;
  readonly diagnosis: (ErrorDiagnosis & { readonly at: number }) | null;
}

/** One enabled source, as a scrape candidate: when it is due and whether its reader's next run polls it. */
export interface SourcePreview {
  readonly id: string;
  readonly via: SourceVia;
  readonly dueAt: number;
  /** Its reader's next run polls it: it is due and within that run's cap. */
  readonly next: boolean;
  readonly lastCount: number;
}

/** One `ingest` item whole, payload included, for the item modal. */
export interface ItemDetail {
  readonly id: string;
  readonly stage: QueueName;
  readonly status: IngestStatus;
  readonly raw: Readonly<Record<string, unknown>>;
  readonly retryCount: number;
  readonly runAt: number;
  readonly createdAt: number;
  readonly finishedAt: number | null;
  readonly error: string | null;
  readonly cause: string | null;
}

export interface MemberRow extends MemberBlock {
  readonly itemId: string;
}

/** A Messages table row: the listed fields, and how many of its `audit` entries are still open. */
export type MessageRow = MessageListItem & { readonly errors: number };
