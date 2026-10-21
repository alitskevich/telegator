import type { Classifier } from "tg-ai/types";
import { type ScrapedItem, ScrapedItemSchema } from "tg-domain/item";
import { metrics } from "tg-firebase/metrics";
import { enqueue } from "tg-firebase/tasks";
import { log } from "tg-utils/logger";
import { normalizeAnalyzed, prefilter, route } from "./route";

/**
 * Stage 2 — analyze one scraped post: pre-filter, classify, route, and enqueue
 * the survivor for aggregate.
 *
 * A provider error throws, so the item is retried; a `skip` decision is
 * final and returns normally.
 */
export async function runAnalyze(payload: unknown, classifier: Classifier): Promise<void> {
  const item: ScrapedItem = ScrapedItemSchema.parse(payload);

  // Empty and bare-link bodies are dropped before the model is paid for.
  const skipped = prefilter(item.body);
  if (skipped?.kind === "drop") {
    metrics.count("ItemsSkipped", 1, skipped.reason);
    return;
  }

  const classified = await classifier.classify(item.body);
  const decision = route(classified);
  metrics.count("ItemsClassified", 1, classified.category);
  log.info("item classified", {
    itemId: item.id,
    category: classified.category,
    importance: classified.importance,
    decision: decision.kind,
  });

  if (decision.kind === "retry") throw new Error(`classification returned no category`);
  if (decision.kind === "drop") {
    metrics.count("ItemsSkipped", 1, decision.reason);
    return;
  }

  await enqueue("aggregate", normalizeAnalyzed(item, classified));
  metrics.count("ItemsAnalyzed");
}
