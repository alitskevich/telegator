import type { AuditEntry } from "tg-domain/audit";
import type { IngestItem } from "tg-domain/ingest";
import type { AnalyzedItem, ScrapedItem } from "tg-domain/item";

export type StoredIngestItem = IngestItem & { readonly id: string };

export type StoredAuditEntry = AuditEntry & { readonly id: string };

/** What each stage carries in an item's `raw`. */
export interface Payloads {
  analyze: ScrapedItem;
  aggregate: AnalyzedItem;
  publish: { messageId: string };
}
