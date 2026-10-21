import { describe, expect, test } from "vitest";
import { mergeTags, splitTags } from "./tags";

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
  /** Source tags survive alongside AI tags, with no duplicates. */
  test("keeps both sides of the merge and drops duplicates", () => {
    expect(mergeTags("war, politics", "politics, drones")).toBe("war,politics,drones");
  });

  /** Aggregate calls `mergeTags(item.tags, match.tags)`; first-seen order keeps a replay unchanged. */
  test("preserves first-seen order, item side first", () => {
    expect(mergeTags("b, a", "c, a")).toBe("b,a,c");
  });

  /** After a first merge the message holds M; a replay computes mergeTags(item.tags, M), which must be M. */
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

  /** On purpose: folding would discard the stored form, and publish lowercases hashtags anyway. */
  test("deduplicates by exact match, so War and war both survive", () => {
    expect(mergeTags("War", "war")).toBe("War,war");
  });
});
