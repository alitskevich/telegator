import { DROPPED_CATEGORY } from "../../ai/categories";
import type { NewsItem } from "../../ai/newsItemSchema";
import type { AnalyzedItem, ScrapedItem } from "../../domain/item";
import { mergeTags } from "../../domain/tags";
import type { MetricDimensions } from "../../metrics/ports";
import { SKIP_REASONS, type SkipReason } from "../../metrics/ports";

/**
 * Stage 2's pre-filter, routing table and field normalisers (§3.2 L231–244) as
 * pure functions.
 *
 * Nothing here performs an effect. Each function returns a decision or a value;
 * the orchestrator (item 3.7) emits the `ItemsSkipped` metrics, does the
 * enqueueing, and throws on `retry`. That split is what makes the routing table
 * testable without an SQS or CloudWatch double, and it keeps the "why errors
 * throw rather than drop" reasoning of §3.2 L246 in one place instead of
 * scattered across branches.
 */

export type { SkipReason };
/** Re-exported for this stage's callers; defined in `lib/metrics/ports.ts`. */
export { SKIP_REASONS };

/**
 * What the orchestrator should do with one item.
 *
 * `retry` covers the table's first row — "No category returned, or provider
 * error" (§3.2 L237). It is a decision rather than a thrown error here because
 * throwing is an effect: the orchestrator throws so SQS retries and the item
 * ultimately reaches the DLQ (§3.2 L246), while `route` stays a total function
 * that a test can call and inspect.
 */
export type RouteDecision =
  | { readonly kind: "drop"; readonly reason: SkipReason }
  | { readonly kind: "enqueue" }
  | { readonly kind: "retry"; readonly cause: "no-category" };

/**
 * The dimension set for an `ItemsSkipped` count.
 *
 * R31 — the name is `Reason`, capital R. §7.7 L688 spells it that way while
 * §3.2 L241 writes `reason`; CloudWatch dimension names are case-sensitive, so
 * emitting both spellings would split one metric into two half-populated ones.
 * Building the dimensions here rather than at each call site means the casing is
 * decided once.
 */
export function skippedDimensions(reason: SkipReason): MetricDimensions {
  return { Reason: reason };
}

/**
 * A body consisting of exactly one link token, per §3.2 L231.
 *
 * R31 — L231 says the dropped body is "exactly `[link1](#1)` (a bare link, no
 * prose)". Read literally that is a 12-character string, but §3.1 L203 emits
 * `[Y](#N)` where `Y` is the anchor's own text, so the literal would essentially
 * never be produced and the rule would never fire. The parenthetical states the
 * intent — a bare link with no prose — so the pattern is implemented instead of
 * the example. `[^\]]*` keeps the token non-greedy over brackets so that prose
 * containing a `]` cannot be mistaken for one token.
 */
const LONE_LINK_TOKEN = /^\[[^\]]*\]\(#\d+\)$/;

/**
 * §3.2 L231 — an empty body, or one that is a bare link with no prose, is
 * dropped before the AI call: no request, no downstream message.
 *
 * Returns `undefined` when the body passes and should be classified.
 *
 * The reason is `nobody`. §3.2 L231 names none, but §7.7 L688 declares
 * `Reason = low | category | nobody` and the other two are spoken for by the
 * routing table, leaving this the only rule `nobody` can belong to.
 */
export function prefilter(body: string): RouteDecision | undefined {
  const trimmed = body.trim();

  if (trimmed.length === 0 || LONE_LINK_TOKEN.test(trimmed)) {
    return { kind: "drop", reason: "nobody" };
  }

  return undefined;
}

/**
 * The fields the routing table of §3.2 L237–242 reads.
 *
 * Deliberately wider than `NewsItem`, which a `NewsItem` still satisfies.
 * `NewsItem` requires `category` and constrains it to §5.4's enum (§5.2 L423),
 * so with structured output neither the "no category returned" row nor the
 * `crime&law` row is expressible in that type — typing the parameter as
 * `NewsItem` would make two of the four table rows unwritable. Widening here
 * lets the table be implemented as specified and lets a raw, not-yet-validated
 * provider response be routed as well.
 */
export interface RoutableClassification {
  readonly category?: string | undefined;
  readonly importance?: NewsItem["importance"] | undefined;
}

/**
 * §3.2 L237–242, evaluated in the table's own order.
 *
 * Order is load-bearing: an item with no category and `importance: "low"` is a
 * retry, not a drop, because the first row wins. Silently dropping it would
 * discard an item the provider never actually classified.
 */
export function route(classified: RoutableClassification): RouteDecision {
  if (!classified.category) {
    return { kind: "retry", cause: "no-category" };
  }

  if (classified.importance === "low") {
    return { kind: "drop", reason: "low" };
  }

  /**
   * R5 — this branch is currently dead. `DROPPED_CATEGORY` is `"crime&law"`,
   * which is not one of §5.4's categories, and §5.2 L423 constrains the model to
   * that enum, so the comparison can never be true for a validated response.
   * §3.2 is the normative stage spec, so the rule ships exactly as written and
   * the mismatch is pinned by test rather than quietly repointed at `crime`.
   */
  if (classified.category === DROPPED_CATEGORY) {
    return { kind: "drop", reason: "category" };
  }

  return { kind: "enqueue" };
}

/**
 * §3.2 L244 — "`country` uppercased".
 *
 * AC-2.4 (L253) reads "always uppercase or empty", and this is the only place
 * that is made true: `AnalyzedItemSchema` asserts the property rather than
 * transforming, so that the criterion stays falsifiable at the stage responsible
 * for it.
 */
export function normalizeCountry(country: string): string {
  return country.trim().toUpperCase();
}

/**
 * §3.2 L244 — "AI `tags` merged with source tags (comma-split, deduplicated,
 * comma-joined)".
 *
 * AI tags lead, matching the sentence's order; `mergeTags` keeps first-seen
 * order, so the source tags follow and AC-2.3 (L252) holds — they survive, once
 * each. The split/dedupe/join itself lives in `lib/domain/tags.ts` because §6
 * L532 merges again at aggregate time and the two must agree.
 */
export function normalizeTags(aiTags: string | undefined, sourceTags: string | undefined): string {
  return mergeTags(aiTags, sourceTags);
}

/**
 * Composes §3.2 L244's normalisers into the Stage B payload of §2.2 L132.
 *
 * The AI fields overwrite the scrape defaults — §2.2 L128 lets a source carry an
 * operator's arbitrary category until AI supplies a real one — while `tags` is
 * merged rather than replaced, and the scrape identity fields (`id`, `links`,
 * `image`, `tgChannel`, `date`, `kind`) pass through untouched. Returns a fresh
 * object; neither input is mutated.
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
