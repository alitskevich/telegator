import type { NewsItem } from "tg-domain/newsItemSchema";

/**
 * The fields routing reads. Wider than `NewsItem`, so a missing or
 * out-of-enum category can be routed too.
 */
export interface RoutableClassification {
  readonly category?: string | undefined;
  readonly importance?: NewsItem["importance"] | undefined;
}
