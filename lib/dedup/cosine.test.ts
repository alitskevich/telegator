import { describe, expect, test } from "vitest";
import { cosineSimilarity } from "./cosine";

const dot = (a: readonly number[], b: readonly number[]): number =>
  a.reduce((sum, x, i) => sum + x * (b[i] ?? 0), 0);

describe("cosineSimilarity", () => {
  test("a vector is exactly similar to itself", () => {
    expect(cosineSimilarity([3, 4], [3, 4])).toBe(1);
  });

  test("orthogonal vectors score zero", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBe(0);
  });

  test("opposed vectors score minus one", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBe(-1);
  });

  test("computes the angle, not the raw dot product", () => {
    // [3,4] and [4,3] both have norm 5; dot is 24, so cos is 24/25 exactly.
    expect(cosineSimilarity([3, 4], [4, 3])).toBe(0.96);
  });

  test("is invariant to scale, which is what the norms buy", () => {
    const a = [1, 2, 3];
    const b = [4, 5, 6];

    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(a, [8, 10, 12]), 12);
  });

  test("is symmetric", () => {
    expect(cosineSimilarity([1, 2], [3, 4])).toBe(cosineSimilarity([3, 4], [1, 2]));
  });

  /**
   * The reason §6 L555 says "the implementation keeps the general form".
   *
   * L555's own aside — that Cohere returns normalised vectors so cosine reduces
   * to a dot product — stops being true the moment anything merges: §6 L533
   * stores `elementwiseMean(match.embedding, vec)`, and the mean of two unit
   * vectors is not a unit vector. Here the merged centroid has norm sqrt(0.5),
   * so a bare dot product would score it 0.5 against itself instead of 1 — an
   * error of 0.5 against a threshold whose whole working range is 0.70 to 0.95.
   * Every merged message would stop matching anything, including itself.
   */
  test("scores a merged centroid against itself as 1, which a bare dot product does not", () => {
    const centroid = [0.5, 0.5]; // elementwiseMean([1,0], [0,1])

    expect(cosineSimilarity(centroid, centroid)).toBe(1);
    expect(dot(centroid, centroid)).toBe(0.5);
  });

  /**
   * Decision: a zero vector has no direction, so the mathematical value is
   * undefined (0/0). Returning 0 rather than NaN keeps every threshold
   * comparison behaving the same way regardless of which direction it is
   * written — NaN makes both `s >= t` and `s < t` false, so a later refactor
   * could silently invert the branch.
   */
  test("scores a zero vector as zero rather than NaN", () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
    expect(cosineSimilarity([1, 2], [0, 0])).toBe(0);
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  test("a zero vector therefore never reaches the merge threshold", () => {
    expect(cosineSimilarity([0, 0], [1, 2])).toBeLessThan(0.85);
  });

  /**
   * §5.3 L465: the 768 -> 1024 dimension change means vectors from different
   * models "are not comparable at all". Comparing across lengths would produce
   * a confident, meaningless number.
   */
  test("refuses vectors of different lengths", () => {
    expect(() => cosineSimilarity([1, 2, 3], [1, 2])).toThrow();
  });

  test("treats two empty vectors as zero rather than NaN", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  test("stays within [-1, 1] across many random pairs", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const a = [Math.sin(seed), Math.cos(seed * 2), Math.sin(seed * 3)];
      const b = [Math.cos(seed), Math.sin(seed * 5), Math.cos(seed * 7)];
      const score = cosineSimilarity(a, b);

      expect(score).toBeGreaterThanOrEqual(-1);
      expect(score).toBeLessThanOrEqual(1);
    }
  });
});
