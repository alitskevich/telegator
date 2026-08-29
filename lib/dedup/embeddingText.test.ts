import { describe, expect, test } from "vitest";
import { buildEmbeddingText } from "./embeddingText";

const item = {
  title: "Capital explosions reported",
  summary: "Выбухі ў сталіцы",
  category: "geopolitics",
  tags: "war,politics",
  body: "Explosions were reported overnight.",
};

describe("buildEmbeddingText", () => {
  /**
   * The field order is normative and stated identically twice — §3.3 L265 and
   * §6 L495. It is asserted as one exact string rather than field by field,
   * because a reordering is exactly the change that would pass a looser test
   * while silently invalidating §11.3's calibrated threshold.
   */
  test("concatenates title, summary, category, tags, body in that order", () => {
    expect(buildEmbeddingText(item)).toBe(
      "Capital explosions reported Выбухі ў сталіцы geopolitics war,politics Explosions were reported overnight.",
    );
  });

  test("joins with a single space", () => {
    expect(buildEmbeddingText({ title: "a", body: "b" })).toBe("a b");
  });

  test("drops absent fields rather than emitting gaps", () => {
    expect(buildEmbeddingText({ title: "a", category: "c" })).toBe("a c");
  });

  test("drops empty strings, which filter(Boolean) treats as absent", () => {
    expect(buildEmbeddingText({ ...item, summary: "", tags: "" })).toBe(
      "Capital explosions reported geopolitics Explosions were reported overnight.",
    );
  });

  test("produces no leading or trailing space when the first or last field is absent", () => {
    const text = buildEmbeddingText({ summary: "s", tags: "t" });

    expect(text).toBe("s t");
    expect(text).toBe(text.trim());
  });

  test("returns an empty string when every field is absent", () => {
    expect(buildEmbeddingText({})).toBe("");
  });

  /**
   * §6 L496 says filter(non-empty) and §3.3 L265 says filter(Boolean); a
   * whitespace-only value is non-empty and truthy under both, so it is kept.
   * Pinned because the tidier reading — trimming it away — would make this
   * function disagree with the spec and, worse, disagree with itself between
   * the aggregate stage and the calibration harness.
   */
  test("keeps a whitespace-only field, which both readings treat as present", () => {
    expect(buildEmbeddingText({ title: "a", summary: " ", category: "c" })).toBe("a   c");
  });

  test("accepts anything carrying the five fields, which is what the harness passes", () => {
    const analyzedItemShaped = { ...item, id: "abc/1", date: "2026-08-29", kind: "post" };

    expect(buildEmbeddingText(analyzedItemShaped)).toBe(buildEmbeddingText(item));
  });
});
