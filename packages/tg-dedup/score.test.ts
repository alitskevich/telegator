import { describe, expect, test } from "vitest";
import { buildMatchKey } from "./matchKey";
import { classify, matchScore } from "./score";

const key = (fields: Parameters<typeof buildMatchKey>[0]) => buildMatchKey(fields);

describe("matchScore (R46)", () => {
  test("scores an identical key at 1", () => {
    const a = key({ title: "Minsk Factory Fire", properNames: "Minsk", tags: "fire" });

    expect(matchScore(a, a)).toBeCloseTo(1);
  });

  test("scores disjoint keys at 0", () => {
    const a = key({ title: "Minsk Factory Fire", properNames: "Minsk", tags: "fire" });
    const b = key({ title: "Brest Border Queue", properNames: "Brest", tags: "transport" });

    expect(matchScore(a, b)).toBe(0);
  });

  /**
   * The trap. `|a n b| / |a u b|` is 0/0 for two empty sets, and any reading
   * that treats that as equality auto-merges every sparse pair — two items with
   * no entities would score 1 on the heaviest-weighted component.
   */
  test("scores two entity-less items on evidence, never on shared emptiness", () => {
    const a = key({ title: "Alpha Beta" });
    const b = key({ title: "Gamma Delta" });

    expect(matchScore(a, b)).toBe(0);
  });

  /**
   * Three comparisons, not two: each partner shares exactly one component in
   * full and neither of the others, so each score is that component's weight
   * alone. Asserting only entities > tags left the middle term unpinned — the
   * name claimed an ordering the test did not establish, and a weighting that
   * put titleTokens above entities would have passed it.
   */
  test("weights entities above title above tags", () => {
    const base = key({ title: "Alpha Beta", properNames: "Minsk", tags: "fire" });
    const sharedEntity = key({ title: "Gamma Delta", properNames: "Minsk", tags: "safety" });
    const sharedTitle = key({ title: "Alpha Beta", properNames: "Brest", tags: "safety" });
    const sharedTag = key({ title: "Gamma Delta", properNames: "Brest", tags: "fire" });

    expect(matchScore(base, sharedEntity)).toBeGreaterThan(matchScore(base, sharedTitle));
    expect(matchScore(base, sharedTitle)).toBeGreaterThan(matchScore(base, sharedTag));
  });

  test("is symmetric, so candidate ordering cannot change a verdict", () => {
    const a = key({ title: "Minsk Fire", properNames: "Minsk, Belaruskali", tags: "fire" });
    const b = key({ title: "Minsk Blaze", properNames: "Minsk", tags: "fire, safety" });

    expect(matchScore(a, b)).toBe(matchScore(b, a));
  });
});

describe("classify", () => {
  test("auto-merges at or above the merge threshold", () => {
    expect(classify(1, { merge: 0.72, distinct: 0.35 })).toBe("merge");
    expect(classify(0.72, { merge: 0.72, distinct: 0.35 })).toBe("merge");
  });

  test("auto-splits at or below the distinct threshold", () => {
    expect(classify(0, { merge: 0.72, distinct: 0.35 })).toBe("distinct");
    expect(classify(0.35, { merge: 0.72, distinct: 0.35 })).toBe("distinct");
  });

  test("sends the band to the adjudicator", () => {
    expect(classify(0.5, { merge: 0.72, distinct: 0.35 })).toBe("adjudicate");
  });
});
