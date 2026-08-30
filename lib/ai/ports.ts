import type { NewsItem } from "./newsItemSchema";

/**
 * The two model boundaries, as interfaces.
 *
 * Bedrock is unreachable from the build machine, so every model call goes
 * through one of these with a deterministic fake behind it in tests. That is
 * not only a local constraint: it is what lets §11's acceptance criteria be
 * checked at all, since a test that needs a live model cannot assert "these two
 * posts produce one message with two members".
 */

/** §5.2 — one request per item (§3.2 L234). */
export interface Classifier {
  /**
   * Classifies one item body. Throws on a provider error rather than returning
   * a sentinel: §3.2 L239/L246 route a provider failure to a throw so SQS
   * retries and the item reaches the DLQ, because an error is transient while a
   * `skip` decision is final.
   */
  classify(body: string): Promise<NewsItem>;
}

/**
 * R46 — the band adjudicator's inputs.
 *
 * Only the English structured fields cross this boundary. `body` (Russian or
 * Ukrainian) and `summary` (Belarusian) are deliberately excluded: §5.2 has
 * already reduced the discriminating signal to one language, and sending source
 * text back to a model would make the call large, slow and language-dependent
 * for no gain.
 */
export interface AdjudicationFields {
  readonly title: string;
  readonly entities: readonly string[];
  readonly tags: readonly string[];
  readonly category: string | undefined;
  readonly location: string | undefined;
  readonly date: string;
}

export interface AdjudicationPair {
  /** Caller-assigned and stable. Verdicts come back keyed by this, never positionally. */
  readonly id: string;
  readonly item: AdjudicationFields;
  readonly candidate: AdjudicationFields;
}

/**
 * One call per aggregate batch, carrying at most one pair per item, because
 * only each item's highest-scoring candidate is ever ambiguous.
 *
 * Returns a map keyed by `AdjudicationPair.id`. Never an array: §6 indexed one
 * provider response positionally against its input, and a misaligned response
 * silently attached the wrong result to the wrong item — the class of bug the
 * removed embedding provider (R43) could only guard against by checking its
 * response length before returning. A keyed map removes the bug rather than
 * checking for it.
 */
export interface Adjudicator {
  adjudicate(pairs: readonly AdjudicationPair[]): Promise<ReadonlyMap<string, boolean>>;
}
