import { describe, expect, test } from "vitest";
import { CATEGORIES, CategorySchema, DROPPED_CATEGORY } from "./categories";

describe("CATEGORIES", () => {
  /** The old spec claimed 35 categories, but only these 29 were ever listed. */
  test("contains 29 values", () => {
    expect(CATEGORIES).toHaveLength(29);
  });

  /**
   * Asserted as the whole list: the model's output is constrained to this enum,
   * so an edit changes what the classifier can say and must be deliberate.
   */
  test("is the exact list, in order", () => {
    expect([...CATEGORIES]).toEqual([
      "art&fashion",
      "crime",
      "culture&history",
      "news-digest",
      "economics&finance",
      "education",
      "energy",
      "entertainment",
      "sports",
      "environmental",
      "geopolitics",
      "health",
      "human-rights",
      "infrastructure",
      "international",
      "media",
      "other",
      "politics",
      "real-estate",
      "science",
      "social",
      "technology",
      "internet",
      "traditions",
      "tourism",
      "traffic",
      "war",
      "incidents",
      "nature",
    ]);
  });

  test("has no duplicates", () => {
    expect(new Set(CATEGORIES).size).toBe(CATEGORIES.length);
  });

  test('includes "other", the fallback a classifier falls back to', () => {
    expect(CATEGORIES).toContain("other");
  });
});

describe("CategorySchema", () => {
  test.each(CATEGORIES)("accepts %s", (category) => {
    expect(CategorySchema.safeParse(category).success).toBe(true);
  });

  test("rejects a value outside the list", () => {
    expect(CategorySchema.safeParse("weather").success).toBe(false);
  });

  test("is case-sensitive", () => {
    expect(CategorySchema.safeParse("War").success).toBe(false);
  });
});

describe("DROPPED_CATEGORY", () => {
  /**
   * Analyze drops `crime&law`, but the model can only return CATEGORIES, which
   * has `crime` and no `crime&law`, so the rule never fires. The test keeps that
   * mismatch visible: changing the string changes what gets published.
   */
  test("is crime&law", () => {
    expect(DROPPED_CATEGORY).toBe("crime&law");
  });

  test("is not one of the categories the model can return", () => {
    expect(CATEGORIES).not.toContain(DROPPED_CATEGORY);
    expect(CategorySchema.safeParse(DROPPED_CATEGORY).success).toBe(false);
  });

  test("while the similarly-named `crime` is a category, and is not dropped", () => {
    expect(CATEGORIES).toContain("crime");
    expect(DROPPED_CATEGORY).not.toBe("crime");
  });
});
