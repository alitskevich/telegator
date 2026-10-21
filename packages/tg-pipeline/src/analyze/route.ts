import type { AnalyzedItem, ScrapedItem } from "tg-domain/item";
import type { NewsItem } from "tg-domain/newsItemSchema";
import { mergeTags } from "tg-domain/tags";
import { DROPPED_CATEGORY } from "tg-enums/categories";
import type { SkipReason } from "tg-enums/metrics";

/**
 * The analyze pre-filter, routing table and field normalisers, as pure
 * functions. The caller counts metrics, enqueues, and throws on `retry`.
 */

/**
 * What to do with one item. `retry` (no category, or a provider error) is a
 * value here; the caller throws it so the queue retries.
 */
export type RouteDecision =
  | { readonly kind: "drop"; readonly reason: SkipReason }
  | { readonly kind: "enqueue" }
  | { readonly kind: "retry"; readonly cause: "no-category" };

/**
 * A body that is exactly one `[text](#N)` link token. `[^\]]*` stops at the
 * first `]`, so prose that contains a `]` is not one token.
 */
const LONE_LINK_TOKEN = /^\[[^\]]*\]\(#\d+\)$/;

/**
 * Drops an empty body, or a bare link with no prose, before the model call.
 * Returns `undefined` when the body should be classified.
 */
export function prefilter(body: string): RouteDecision | undefined {
  const trimmed = body.trim();

  if (trimmed.length === 0 || LONE_LINK_TOKEN.test(trimmed)) {
    return { kind: "drop", reason: "nobody" };
  }

  return undefined;
}

/**
 * The fields routing reads. Wider than `NewsItem`, so a missing or
 * out-of-enum category can be routed too.
 */
export interface RoutableClassification {
  readonly category?: string | undefined;
  readonly importance?: NewsItem["importance"] | undefined;
}

/**
 * The routing rules, in order. Order matters: no category with
 * `importance: "low"` is a retry, not a drop.
 */
export function route(classified: RoutableClassification): RouteDecision {
  if (!classified.category) {
    return { kind: "retry", cause: "no-category" };
  }

  if (classified.importance === "low") {
    return { kind: "drop", reason: "low" };
  }

  // Currently dead: `DROPPED_CATEGORY` is not in the category enum the model is
  // held to. Kept as written and pinned by a test.
  if (classified.category === DROPPED_CATEGORY) {
    return { kind: "drop", reason: "category" };
  }

  return { kind: "enqueue" };
}

/** `country` is always uppercase or empty after analyze. */
export function normalizeCountry(country: string): string {
  return country.trim().toUpperCase();
}

/**
 * AI tags merged with source tags, AI tags first, each once. Aggregate merges
 * with the same `mergeTags`, so the two agree.
 */
export function normalizeTags(aiTags: string | undefined, sourceTags: string | undefined): string {
  return mergeTags(aiTags, sourceTags);
}

/**
 * The payload for aggregate. AI fields overwrite the scrape defaults, `tags`
 * is merged, and the scrape identity fields pass through. Inputs are not mutated.
 */
export function normalizeAnalyzed(scraped: ScrapedItem, ai: NewsItem): AnalyzedItem {
  return {
    ...scraped,
    title: ai.title,
    summary: ai.summary,
    country: normalizeCountry(ai.country),
    location: ai.location,
    category: ai.category,
    importance: ai.importance,
    peoples: ai.peoples,
    properNames: ai.properNames,
    tags: normalizeTags(ai.tags, scraped.tags),
  };
}
