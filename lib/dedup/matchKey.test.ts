import { describe, expect, test } from "vitest";
import { buildMatchKey, matchKeyAttributes, matchKeyOf, unionMatchKeys } from "./matchKey";

describe("buildMatchKey (R46)", () => {
  test("splits comma-separated English entity fields into one sorted set", () => {
    const key = buildMatchKey({
      title: "Minsk Factory Fire",
      peoples: "Ivan Petrov, Maria Ivanova",
      properNames: "Minsk, Belaruskali",
      tags: "fire, industry, safety",
    });

    expect(key.entities).toEqual(["belaruskali", "ivan petrov", "maria ivanova", "minsk"]);
    expect(key.titleTokens).toEqual(["factory", "fire", "minsk"]);
    expect(key.tags).toEqual(["fire", "industry", "safety"]);
  });

  /** AC-3.7 (R51) — replay must serialise byte-identically. */
  test("is canonical: case, spacing, punctuation and order do not change the bytes", () => {
    const a = buildMatchKey({ title: "Minsk  Fire!", properNames: "Minsk, BELARUSKALI" });
    const b = buildMatchKey({ title: "fire minsk", properNames: "belaruskali,  minsk " });

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  /** Regression: multiple separate whitespace runs must collapse. */
  test("collapsesall whitespace runs, not just the first", () => {
    const withMultipleRuns = buildMatchKey({ peoples: "Ivan  Petrov  Jr" });
    const withSingleSpaces = buildMatchKey({ peoples: "Ivan Petrov Jr" });

    expect(JSON.stringify(withMultipleRuns)).toBe(JSON.stringify(withSingleSpaces));
    expect(withMultipleRuns.entities).toEqual(["ivan petrov jr"]);
  });

  test("omits absent fields rather than emitting empty strings", () => {
    const key = buildMatchKey({ title: "Gomel Protest" });

    expect(key.entities).toEqual([]);
    expect(key.tags).toEqual([]);
    expect(key.titleTokens).toEqual(["gomel", "protest"]);
  });
});

describe("unionMatchKeys (R45)", () => {
  test("is the sorted union, replacing the elementwise mean of §3.3", () => {
    const merged = unionMatchKeys(
      buildMatchKey({ properNames: "Minsk", tags: "fire" }),
      buildMatchKey({ properNames: "Gomel", tags: "fire, safety" }),
    );

    expect(merged.entities).toEqual(["gomel", "minsk"]);
    expect(merged.tags).toEqual(["fire", "safety"]);
  });

  test("is commutative, so merge order cannot change the stored bytes", () => {
    const a = buildMatchKey({ properNames: "Minsk, Gomel", title: "Alpha Beta" });
    const b = buildMatchKey({ properNames: "Brest", title: "Beta Gamma" });

    expect(JSON.stringify(unionMatchKeys(a, b))).toBe(JSON.stringify(unionMatchKeys(b, a)));
  });
});

describe("matchKeyOf (R44)", () => {
  test("maps keyEntities to entities, keyTitle to titleTokens, keyTags to tags", () => {
    const record = {
      keyEntities: ["entity-a", "entity-b"],
      keyTitle: ["title-x", "title-y"],
      keyTags: ["tag-p", "tag-q"],
    };

    const key = matchKeyOf(record);

    expect(key.entities).toEqual(["entity-a", "entity-b"]);
    expect(key.titleTokens).toEqual(["title-x", "title-y"]);
    expect(key.tags).toEqual(["tag-p", "tag-q"]);
  });

  test("round-trips what matchKeyAttributes produces", () => {
    const record = {
      keyEntities: ["minsk", "gomel"],
      keyTitle: ["fire", "safety"],
      keyTags: ["disaster"],
    };

    const key = matchKeyOf(record);
    const attributes = matchKeyAttributes(key);

    expect(attributes).toEqual(record);
  });
});

describe("matchKeyAttributes (R44)", () => {
  test("maps entities to keyEntities, titleTokens to keyTitle, tags to keyTags", () => {
    const key = {
      entities: ["entity-a", "entity-b"],
      titleTokens: ["title-x", "title-y"],
      tags: ["tag-p", "tag-q"],
    };

    const attributes = matchKeyAttributes(key);

    expect(attributes.keyEntities).toEqual(["entity-a", "entity-b"]);
    expect(attributes.keyTitle).toEqual(["title-x", "title-y"]);
    expect(attributes.keyTags).toEqual(["tag-p", "tag-q"]);
  });

  test("round-trips what matchKeyOf produces", () => {
    const key = {
      entities: ["minsk", "gomel"],
      titleTokens: ["fire", "safety"],
      tags: ["disaster"],
    };

    const attributes = matchKeyAttributes(key);
    const reconstructed = matchKeyOf(attributes);

    expect(JSON.stringify(reconstructed)).toBe(JSON.stringify(key));
  });
});
