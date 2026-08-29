/**
 * §6 L555 — "the dot product over the product of L2 norms".
 *
 * The same line notes that Cohere returns normalised vectors, so cosine reduces
 * to a bare dot product, and then instructs: "the implementation keeps the
 * general form." That instruction is load-bearing rather than stylistic. §6 L533
 * stores `elementwiseMean(match.embedding, vec)` as a message's embedding, and
 * the mean of two unit vectors is not a unit vector — so from the first merge
 * onward the stored side of every comparison is un-normalised, and a dot product
 * would report a systematically low score. Messages would stop matching anything
 * as soon as they had matched something once.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    // §5.3 L465: vectors from different models "are not comparable at all", so a
    // length mismatch is a bug to surface, not a shape to coerce.
    throw new Error(`cannot compare vectors of length ${a.length} and ${b.length}`);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  // sqrt(normA * normB), not sqrt(normA) * sqrt(normB): the latter rounds three
  // times and returns 0.9999999999999998 for a merged centroid against itself.
  // A message must score exactly 1 against itself — §6 L559's idempotency
  // argument ("the mean of a vector with itself is that vector") depends on it.
  const magnitude = Math.sqrt(normA * normB);

  // A zero vector has no direction, so cosine is undefined (0/0). Returning 0
  // rather than NaN keeps threshold comparisons behaving identically whichever
  // way round they are written: NaN makes both `s >= t` and `s < t` false, so a
  // later refactor of the comparison could silently invert the branch.
  return magnitude === 0 ? 0 : dot / magnitude;
}
