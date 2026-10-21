import type { MemberBlock, MessageListItem } from "tg-domain/message";
import type { SkipReason } from "tg-enums/metrics";
import type { QueueName } from "tg-enums/queueName";
import type { Slice } from "tg-utils/ui/types";

export interface Overview {
  readonly scraped: number;
  readonly analyzed: number;
  readonly skipped: { readonly total: number; readonly byReason: Record<SkipReason, number> };
  readonly published: number;
  readonly errors: number;
  readonly statusSlices: Slice[];
  readonly categorySlices: Slice[];
  /** Per task stage: its `ingest` items waiting or running. */
  readonly inQueue: Readonly<Record<QueueName, number>>;
  /** Per task stage: its `ingest` items that used up their attempts. */
  readonly deadLetters: Readonly<Record<QueueName, number>>;
  readonly recent: MessageListItem[];
}

export interface MemberRow extends MemberBlock {
  readonly itemId: string;
}
