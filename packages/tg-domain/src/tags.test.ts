import { describe, expect, test } from "vitest";
import { mergeTags, splitTags, TagsSchema } from "./tags";

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
    expect(mergeTags(["war", "politics"], ["politics", "drones"])).toEqual([
      "war",
      "politics",
      "drones",
    ]);
  });

  /** Aggregate calls `mergeTags(item.tags, match.tags)`; first-seen order keeps a replay unchanged. */
  test("preserves first-seen order, item side first", () => {
    expect(mergeTags(["b", "a"], ["c", "a"])).toEqual(["b", "a", "c"]);
  });

  /** After a first merge the message holds M; a replay computes mergeTags(item.tags, M), which must be M. */
  test("re-merging an already-merged result changes nothing", () => {
    const item = ["war", "politics"];
    const merged = mergeTags(item, ["politics", "drones"]);

    expect(mergeTags(item, merged)).toEqual(merged);
    expect(mergeTags(item, mergeTags(item, merged))).toEqual(merged);
  });

  test("accepts more than two lists", () => {
    expect(mergeTags(["a"], ["b"], ["c"])).toEqual(["a", "b", "c"]);
  });

  test("tolerates absent sides", () => {
    expect(mergeTags(undefined, ["war"])).toEqual(["war"]);
    expect(mergeTags(["war"], undefined)).toEqual(["war"]);
    expect(mergeTags(undefined, undefined)).toEqual([]);
    expect(mergeTags()).toEqual([]);
  });

  test("trims tags and drops whitespace-only ones", () => {
    expect(mergeTags([" ", " war "], ["  ", "war"])).toEqual(["war"]);
  });

  /** On purpose: folding would discard the stored form, and publish lowercases hashtags anyway. */
  test("deduplicates by exact match, so War and war both survive", () => {
    expect(mergeTags(["War"], ["war"])).toEqual(["War", "war"]);
  });
});

describe("TagsSchema", () => {
  test("normalises an array as mergeTags does", () => {
    expect(TagsSchema.parse([" war", "war", "", "politics"])).toEqual(["war", "politics"]);
  });

  /** Rows stored before tags were arrays, and the console's text inputs, carry a string. */
  test("reads a comma-separated string as a list", () => {
    expect(TagsSchema.parse("war, politics ,,war")).toEqual(["war", "politics"]);
    expect(TagsSchema.parse("")).toEqual([]);
  });

  test("rejects anything else", () => {
    expect(() => TagsSchema.parse(7)).toThrow();
    expect(() => TagsSchema.parse([7])).toThrow();
  });
});
