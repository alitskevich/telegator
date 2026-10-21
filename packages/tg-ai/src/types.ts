import type { NewsItem } from "tg-domain/newsItemSchema";

/** Classifies one post. Throws on a provider error, so the task retries. */
export interface Classifier {
  classify(body: string): Promise<NewsItem>;
}

/** The English structured fields a dedup pair is judged on; source text never crosses. */
export interface AdjudicationFields {
  readonly title: string;
  readonly entities: readonly string[];
  readonly tags: readonly string[];
  readonly category: string | undefined;
  readonly location: string | undefined;
  readonly date: string;
}

export interface AdjudicationPair {
  /** Verdicts come back keyed by this, never positionally. */
  readonly id: string;
  readonly item: AdjudicationFields;
  readonly candidate: AdjudicationFields;
}

/** Decides the ambiguous dedup pairs: `true` means same story. */
export interface Adjudicator {
  adjudicate(pairs: readonly AdjudicationPair[]): Promise<ReadonlyMap<string, boolean>>;
}
