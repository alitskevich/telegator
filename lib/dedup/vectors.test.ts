import { describe, expect, test } from "vitest";
import { cosineSimilarity } from "./cosine";
import { elementwiseMean } from "./vectors";

describe("elementwiseMean", () => {
  test("averages position by position", () => {
    expect(elementwiseMean([1, 0], [0, 1])).toEqual([0.5, 0.5]);
  });

  /**
   * The theorem §6 L559 rests on: "because the mean of a vector with itself is
   * that vector, replaying an item that is already the sole member is exactly
   * idempotent". Exactly, not approximately — E2E-5 (L852) calls DLQ replay the
   * master idempotency test.
   */
  test("the mean of a vector with itself is that vector, exactly", () => {
    const v = [0.1, -0.25, 0.75, 0];

    expect(elementwiseMean(v, v)).toEqual(v);
  });

  test("a replayed sole member leaves the stored embedding untouched", () => {
    const stored = [0.6, 0.8];

    expect(cosineSimilarity(elementwiseMean(stored, stored), stored)).toBe(1);
  });

  test("is symmetric", () => {
    expect(elementwiseMean([1, 2], [3, 4])).toEqual(elementwiseMean([3, 4], [1, 2]));
  });

  /**
   * R6, pinned in code. §2.3 L146 describes the stored embedding as a "Running
   * mean of member embeddings", which for three members would be (v1+v2+v3)/3
   * with every member weighted equally. §6 L533 — the section labelled
   * normative — specifies elementwiseMean(match.embedding, vec), applied once
   * per arriving member. That recurrence gives v1/4 + v2/4 + v3/2: the newest
   * member carries half the weight and the first member's influence halves
   * again with every merge.
   *
   * §6 wins. This test exists so the divergence is visible in the code rather
   * than only in the ledger, and so a later "fix" to a true centroid is a
   * deliberate change rather than a silent one.
   */
  test("applied in sequence it is a decaying blend, not an equal-weight centroid", () => {
    const v1 = [1, 0, 0];
    const v2 = [0, 1, 0];
    const v3 = [0, 0, 1];

    const afterTwo = elementwiseMean(v1, v2);
    const afterThree = elementwiseMean(afterTwo, v3);

    expect(afterThree).toEqual([0.25, 0.25, 0.5]);
    expect(afterThree).not.toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  test("the first member's weight halves with every merge", () => {
    let centroid = [1];
    for (let merges = 0; merges < 4; merges++) {
      centroid = elementwiseMean(centroid, [0]);
    }

    expect(centroid).toEqual([0.0625]);
  });

  test("does not mutate either input", () => {
    const a = [1, 2];
    const b = [3, 4];

    elementwiseMean(a, b);

    expect(a).toEqual([1, 2]);
    expect(b).toEqual([3, 4]);
  });

  /** §5.3 L465 — vectors from different models are not comparable, so not averageable. */
  test("refuses vectors of different lengths", () => {
    expect(() => elementwiseMean([1, 2, 3], [1, 2])).toThrow();
  });

  test("handles empty vectors", () => {
    expect(elementwiseMean([], [])).toEqual([]);
  });
});
