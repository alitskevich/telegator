import { describe, expect, test } from "vitest";
import { mergeTags, splitTags } from "./tags.js";

describe("splitTags", () => {
  test("splits on commas and trims each token", () => {
    expect(splitTags("war, politics ,drones")).toEqual(["war", "politics", "drones"]);
  });

  test("drops empty and whitespace-only tokens", () => {
    expect(splitTags("war, ,,  ,politics")).toEqual(["war", "politics"]);
  });

  test("treats absent input as no tags", () => {
    expect(splitTags(undefined)).toEqual([]);
    expect(splitTags("")).toEqual([]);
  });
});

describe("mergeTags", () => {
  /** AC-2.3 (L252): source tags survive alongside AI tags, with no duplicates. */
  test("keeps both sides of the merge and drops duplicates", () => {
    expect(mergeTags("war, politics", "politics, drones")).toBe("war,politics,drones");
  });

  /**
   * §6 L532 calls `mergeTags(item.tags, match.tags)` — item first. First-seen
   * order is what makes the result deterministic, and determinism is what
   * AC-3.7 (L306) requires when it says `tags` are unchanged on replay.
   */
  test("preserves first-seen order, item side first", () => {
    expect(mergeTags("b, a", "c, a")).toBe("b,a,c");
  });

  /**
   * The replay case, stated directly. After a first merge the message holds M;
   * replaying the same item computes mergeTags(item.tags, M), which must be M
   * again or the record is not byte-identical.
   */
  test("re-merging an already-merged result changes nothing", () => {
    const item = "war, politics";
    const merged = mergeTags(item, "politics, drones");

    expect(mergeTags(item, merged)).toBe(merged);
    expect(mergeTags(item, mergeTags(item, merged))).toBe(merged);
  });

  test("accepts more than two sources", () => {
    expect(mergeTags("a", "b", "c")).toBe("a,b,c");
  });

  test("tolerates absent sides", () => {
    expect(mergeTags(undefined, "war")).toBe("war");
    expect(mergeTags("war", undefined)).toBe("war");
    expect(mergeTags(undefined, undefined)).toBe("");
    expect(mergeTags()).toBe("");
  });

  test("drops whitespace-only tokens rather than emitting empty entries", () => {
    expect(mergeTags(" , war , ", "  ")).toBe("war");
  });

  /**
   * Decision, not an accident: deduplication is exact-match. The spec never asks
   * for case folding (§3.2 L244 says only "comma-split, deduplicated,
   * comma-joined"), and folding would discard a tag's stored form. §3.4 L335
   * lowercases when it builds hashtags, so display case does not leak onward.
   */
  test("deduplicates by exact match, so War and war both survive", () => {
    expect(mergeTags("War", "war")).toBe("War,war");
  });
});
