import { CATEGORIES } from "tg-enums/categories";
import { describe, expect, test } from "vitest";
import { SUMMARY_MAX_LENGTH } from "./item";
import { NEWS_ITEM_SCHEMA, NewsItemSchema } from "./newsItemSchema";

const valid = {
  title: "Capital explosions reported",
  summary: "Выбухі ў сталіцы",
  country: "UA",
  location: "Kyiv",
  category: "geopolitics",
  importance: "high",
};

describe("NewsItemSchema", () => {
  test("accepts a well-formed classification", () => {
    expect(NewsItemSchema.parse(valid)).toMatchObject(valid);
  });

  /** The item may carry an operator's arbitrary default; the model may not. */
  test("constrains category to the enum, unlike the item payload", () => {
    expect(NewsItemSchema.safeParse({ ...valid, category: "weather" }).success).toBe(false);
    expect(NewsItemSchema.safeParse({ ...valid, category: "war" }).success).toBe(true);
  });

  test("still enforces the summary cap", () => {
    expect(
      NewsItemSchema.safeParse({ ...valid, summary: "x".repeat(SUMMARY_MAX_LENGTH + 1) }).success,
    ).toBe(false);
  });

  test("keeps the required/optional split", () => {
    expect(NewsItemSchema.safeParse({ ...valid, peoples: undefined }).success).toBe(true);
    const { location: _omitted, ...missingRequired } = valid;
    expect(NewsItemSchema.safeParse(missingRequired).success).toBe(false);
  });
});

/**
 * zod 4 types an emitted property as `_JSONSchema`, which includes the boolean
 * form JSON Schema allows (`false` meaning "nothing validates"). Narrowing is
 * how a test reads the object form without reaching for a cast.
 */
function propertyOf(name: string) {
  const properties = NEWS_ITEM_SCHEMA.properties;
  if (properties === undefined) throw new Error("emitted schema declares no properties");

  const property = properties[name];
  if (typeof property !== "object" || property === null) {
    throw new Error(`property ${name} is not an object schema`);
  }

  return property;
}

describe("NEWS_ITEM_SCHEMA (the JSON Schema sent to the model)", () => {
  test("declares exactly the six required fields", () => {
    expect(NEWS_ITEM_SCHEMA.required).toEqual([
      "title",
      "summary",
      "country",
      "location",
      "category",
      "importance",
    ]);
  });

  test("caps summary at 220 characters", () => {
    expect(propertyOf("summary").maxLength).toBe(SUMMARY_MAX_LENGTH);
  });

  test("enumerates the 29 categories, so the model cannot invent one", () => {
    expect(propertyOf("category").enum).toEqual([...CATEGORIES]);
  });

  test("enumerates importance as high or low", () => {
    expect(propertyOf("importance").enum).toEqual(["high", "low"]);
  });

  /** The model sees this guidance only if it reaches the emitted schema. */
  test("carries the field descriptions, the only place that guidance lives", () => {
    expect(propertyOf("title").description).toContain("three words");
    expect(propertyOf("summary").description).toContain("Belarusian");
    expect(propertyOf("country").description).toContain("ISO-3166 alpha-2");
    expect(propertyOf("importance").description).toContain("Diminish");
    expect(propertyOf("tags").description).toContain("3–5 related tags");
  });

  test("is an object schema", () => {
    expect(NEWS_ITEM_SCHEMA.type).toBe("object");
  });
});

/**
 * Structured output does not enforce string length, so the cap must reach the
 * model as an instruction, or over-long summaries fail validation on every retry.
 */
describe("the summary cap reaches the model", () => {
  interface JsonField {
    readonly description?: string;
    readonly maxLength?: number;
  }

  /**
   * Narrowed by a throw rather than a non-null assertion: `noNonNullAssertion`
   * is an error in this repo, and a schema that emitted no `summary` at all
   * should fail as that, not as three puzzling assertion failures.
   */
  function summaryField(): JsonField {
    const { properties } = NEWS_ITEM_SCHEMA as { properties: Record<string, JsonField> };
    const field = properties.summary;
    if (field === undefined) throw new Error("the emitted schema has no summary property");
    return field;
  }

  const summary = summaryField();

  test("is emitted as maxLength for any provider that does enforce it", () => {
    expect(summary.maxLength).toBe(SUMMARY_MAX_LENGTH);
  });

  test("is also stated in the description, which is what the model reads", () => {
    expect(summary.description).toContain(String(SUMMARY_MAX_LENGTH));
  });

  /** One definition: a changed cap must not leave the sentence saying 220. */
  test("quotes the constant rather than a second hand-written number", () => {
    const numbers = (summary.description ?? "").match(/\d+/g) ?? [];
    expect(numbers).toEqual([String(SUMMARY_MAX_LENGTH)]);
  });
});
