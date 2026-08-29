/**
 * §6 L533 — `embedding: elementwiseMean(match.embedding, vec)`.
 *
 * Strictly pairwise, two arguments, applied once per arriving member.
 *
 * This diverges from §2.3 L146, which describes the stored embedding as a
 * "Running mean of member embeddings" — that would be `(Σvᵢ)/n`, weighting
 * every member equally. The recurrence §6 specifies instead gives, for members
 * v1..vn, `v1/2ⁿ⁻¹ + … + vₙ₋₁/4 + vₙ/2`: the newest member carries half the
 * weight and the first member's influence halves again with every merge.
 *
 * §6 is the section labelled normative (L486), and its arity is what makes
 * L559's idempotency argument true — "the mean of a vector with itself is that
 * vector" holds for the pairwise form and would not for a count-weighted one.
 * Recorded as reconciliation R6; AC-3.6 (L305) only exercises the two-member
 * case, where both readings coincide, so the acceptance suite cannot tell them
 * apart and the divergence is pinned by test instead.
 */
export function elementwiseMean(a: readonly number[], b: readonly number[]): number[] {
  if (a.length !== b.length) {
    // §5.3 L465: vectors from different models are not comparable, so averaging
    // across a dimension change would silently manufacture a meaningless centroid.
    throw new Error(`cannot average vectors of length ${a.length} and ${b.length}`);
  }

  return a.map((x, i) => (x + (b[i] ?? 0)) / 2);
}
