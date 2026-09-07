import { describe, expect, test } from "vitest";
import { SUMMARY_MAX_LENGTH } from "../domain/item";
import { CATEGORIES } from "./categories";
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

  /**
   * Narrower than the payload schema of item 2.5: §5.2 L451 constrains the
   * model's category to §5.4's enum, while §2.2 L136 lets the item carry an
   * operator's arbitrary source default until AI overwrites it.
   */
  test("constrains category to §5.4's enum, unlike the item payload", () => {
    expect(NewsItemSchema.safeParse({ ...valid, category: "weather" }).success).toBe(false);
    expect(NewsItemSchema.safeParse({ ...valid, category: "war" }).success).toBe(true);
  });

  test("still enforces the 220-character summary cap inherited from §11.2", () => {
    expect(
      NewsItemSchema.safeParse({ ...valid, summary: "x".repeat(SUMMARY_MAX_LENGTH + 1) }).success,
    ).toBe(false);
  });

  test("keeps §5.2 L443's required/optional split", () => {
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

describe("NEWS_ITEM_SCHEMA (the JSON Schema §5.2 L425 sends)", () => {
  test("declares exactly the six required fields of §5.2 L443", () => {
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

  test("enumerates importance as high or low (§5.2 L452)", () => {
    expect(propertyOf("importance").enum).toEqual(["high", "low"]);
  });

  /**
   * §5.2 L445-455's Description column is the only place the "three words",
   * "In Belarusian" and importance guidance appear. Structured output drops
   * them unless they reach the emitted schema, and then the model never sees
   * the instruction at all.
   */
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
 * R51 — the cap must reach the model as an *instruction*, not only as a
 * constraint the provider does not enforce.
 *
 * Structured output enforces shape, types and enums; string length it leaves to
 * the model. Emitting `maxLength` and saying nothing held the model to a limit
 * it had never been told, and Zod then failed the item permanently down §3.2
 * L249's transient path into the DLQ.
 */
describe("the summary cap reaches the model (R51)", () => {
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
