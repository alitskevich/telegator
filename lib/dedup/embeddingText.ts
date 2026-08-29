/**
 * The five fields the embedding text is built from.
 *
 * A structural shape rather than `AnalyzedItem`, so the §11.3 calibration
 * harness can pass records read from its own labelled-set file without
 * constructing a full queue payload.
 */
export interface EmbeddingTextFields {
  readonly title?: string | undefined;
  readonly summary?: string | undefined;
  readonly category?: string | undefined;
  readonly tags?: string | undefined;
  readonly body?: string | undefined;
}

/**
 * §3.3 L265 and §6 L495, stated identically in both:
 * `[title, summary, category, tags, body].filter(Boolean).join(" ")`.
 *
 * One implementation, shared by the aggregate stage and the §11.3 calibration
 * harness. That sharing is the point: a similarity threshold is a property of
 * the exact text that was embedded, so calibrating against a different
 * concatenation — a reordering, a trimmed field, an extra separator — produces
 * a number that does not transfer to production.
 */
export function buildEmbeddingText(fields: EmbeddingTextFields): string {
  return [fields.title, fields.summary, fields.category, fields.tags, fields.body]
    .filter(Boolean)
    .join(" ");
}
