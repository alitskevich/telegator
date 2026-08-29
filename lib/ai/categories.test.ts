import { describe, expect, test } from "vitest";
import { CATEGORIES, CategorySchema, DROPPED_CATEGORY } from "./categories";

describe("CATEGORIES", () => {
  /**
   * R4. §5.4's heading reads "Categories (35)", §5.2 L449 says "One of the 35
   * values in §5.4", and §7.7 L695 reasons from "Thirty-five category
   * dimensions". The fenced block at L472–481 contains 29 tokens. Two entries
   * (`human-rights`, `nature`) sit off the block's four-column grid, which is
   * the signature of removed text — but the six missing names cannot be
   * recovered from this document, so the list the spec actually contains ships.
   */
  test("contains the 29 values §5.4 actually lists, not the 35 it claims", () => {
    expect(CATEGORIES).toHaveLength(29);
  });

  /**
   * Asserted as the whole list, in document order. This enum constrains model
   * output (§5.2 L423/L449) and other stages route on it, so an edit here
   * changes what the classifier is able to say — it must be deliberate.
   */
  test("is §5.4 L472-481 verbatim, in document order", () => {
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

  test("is case-sensitive, matching the spec's lowercase forms", () => {
    expect(CategorySchema.safeParse("War").success).toBe(false);
  });
});

describe("DROPPED_CATEGORY (R5)", () => {
  /**
   * §3.2 L241 drops items whose `category === "crime&law"`. §5.4 contains
   * `crime`, and no `crime&law`. §5.2 L423 constrains the model's output to the
   * §5.4 enum via output_config.format, so the model cannot emit "crime&law" —
   * the drop rule is unreachable, its ItemsSkipped{Reason=category} metric
   * (§7.7 L688) is always zero, and crime content is published.
   *
   * §3.2 is the normative stage spec, so the rule is implemented literally and
   * this test makes the mismatch visible rather than silently dead. Changing the
   * string would change what reaches production channels, which is the spec
   * owner's call and not this build's.
   */
  test("is the literal §3.2 L241 routes on", () => {
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
