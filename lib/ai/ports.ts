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

/** §5.3 — the whole batch embedded in a single call (§3.3 L268). */
export interface EmbeddingProvider {
  /** Returns one vector per input text, positionally aligned with `texts`. */
  embedBatch(texts: readonly string[], dimensions: number): Promise<number[][]>;
}
