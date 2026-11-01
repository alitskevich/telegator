import { describe, expect, test } from "vitest";
import { mapTags, TagConfigInput, TagIdSchema, TagSchema } from "./tag";

const tag = (id: string, keywords: string) => TagSchema.parse({ id, keywords });

describe("mapTags", () => {
  test("replaces a keyword with its tag, whatever the keyword's case or spacing", () => {
    expect(mapTags(["Real Estate"], [tag("housing", "real estate, rent")])).toEqual(["housing"]);
  });

  test("keeps a tag no keyword names, in place", () => {
    expect(mapTags(["war", "rent"], [tag("housing", "rent")])).toEqual(["war", "housing"]);
  });

  test("merges keywords of one tag into it once", () => {
    expect(mapTags(["rent", "housing", "mortgage"], [tag("housing", "rent,mortgage")])).toEqual([
      "housing",
    ]);
  });

  test("maps a keyword to every tag that claims it", () => {
    expect(mapTags(["rent"], [tag("housing", "rent"), tag("economy", "rent")])).toEqual([
      "housing",
      "economy",
    ]);
  });

  test("changes nothing with an empty dictionary", () => {
    expect(mapTags(["war"], [])).toEqual(["war"]);
  });
});

describe("TagIdSchema", () => {
  test("normalises like every other tag", () => {
    expect(TagIdSchema.parse(" Real Estate ")).toBe("real-estate");
  });

  test("refuses an empty id and a list", () => {
    expect(TagIdSchema.safeParse("  ").success).toBe(false);
    expect(TagIdSchema.safeParse("a,b").success).toBe(false);
  });
});

describe("TagConfigInput", () => {
  test("reads the console's comma-separated text as a list", () => {
    expect(TagConfigInput.parse({ keywords: "Rent, Real Estate" })).toEqual({
      keywords: ["rent", "real-estate"],
    });
  });

  test("refuses any other field", () => {
    expect(TagConfigInput.safeParse({ deleted: true }).success).toBe(false);
  });
});
