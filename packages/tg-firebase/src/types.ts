import type { IngestItem } from "tg-domain/ingest";
import type { AnalyzedItem, ScrapedItem } from "tg-domain/item";

export type StoredIngestItem = IngestItem & { readonly id: string };

/** What each stage carries in an item's `raw`. */
export interface Payloads {
  analyze: ScrapedItem;
  aggregate: AnalyzedItem;
  publish: { messageId: string };
}
