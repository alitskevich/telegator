import type { ScrapedItem } from "tg-domain/item";
import { AnalyzedItemSchema, ScrapedItemSchema } from "tg-domain/item";
import type { NewsItem } from "tg-domain/newsItemSchema";
import { NewsItemSchema } from "tg-domain/newsItemSchema";
import { CATEGORIES, CategorySchema, DROPPED_CATEGORY } from "tg-enums/categories";
import { describe, expect, test } from "vitest";
import { normalizeAnalyzed, normalizeCountry, normalizeTags, prefilter, route } from "./route";

/** Fixtures are parsed, not cast, so each is a payload the previous stage could produce. */
function classified(fields: Record<string, unknown>): NewsItem {
  return NewsItemSchema.parse({
    title: "Three word title",
    summary: "Кароткі змест.",
    country: "BY",
    location: "Minsk",
    category: "politics",
    importance: "high",
    ...fields,
  });
}

function scraped(fields: Record<string, unknown>): ScrapedItem {
  return ScrapedItemSchema.parse({
    id: "chan/42",
    body: "Some prose about a thing.",
    date: "2026-08-29",
    kind: "post",
    ...fields,
  });
}

describe("route — outcomes", () => {
  test("an item classified importance: low never reaches aggregate", () => {
    const decision = route(classified({ importance: "low" }));

    expect(decision).toEqual({ kind: "drop", reason: "low" });
    expect(decision.kind).not.toBe("enqueue");
  });

  test("source tags survive alongside AI tags, with no duplicates", () => {
    expect(normalizeTags(["war", "economy"], ["belarus", "war"])).toEqual([
      "war",
      "economy",
      "belarus",
    ]);
  });

  test("source-only and AI-only tags both survive an absent counterpart", () => {
    expect(normalizeTags(undefined, ["belarus", "minsk"])).toEqual(["belarus", "minsk"]);
    expect(normalizeTags(["war"], undefined)).toEqual(["war"]);
  });

  test("country is always uppercase or empty", () => {
    expect(normalizeCountry("by")).toBe("BY");
    expect(normalizeCountry("By")).toBe("BY");
    expect(normalizeCountry("BY")).toBe("BY");
    expect(normalizeCountry("")).toBe("");
  });

  test("normalizeAnalyzed produces a payload AnalyzedItemSchema accepts", () => {
    const analyzed = normalizeAnalyzed(
      scraped({ tags: ["belarus", "war"] }),
      classified({ country: "by", tags: ["war", "economy"] }),
    );

    expect(analyzed.country).toBe("BY");
    expect(analyzed.tags).toEqual(["war", "economy", "belarus"]);
    expect(() => AnalyzedItemSchema.parse(analyzed)).not.toThrow();
  });
});

describe("prefilter", () => {
  test("an empty body is dropped with reason nobody", () => {
    expect(prefilter("")).toEqual({ kind: "drop", reason: "nobody" });
  });

  test("a whitespace-only body is dropped with reason nobody", () => {
    expect(prefilter("   \n\n\t  ")).toEqual({ kind: "drop", reason: "nobody" });
  });

  test("the literal `[link1](#1)` is dropped", () => {
    expect(prefilter("[link1](#1)")).toEqual({ kind: "drop", reason: "nobody" });
  });

  test("any single `[Y](#N)` token is dropped, not only the literal", () => {
    // Scrape emits `[Y](#N)` with the anchor's own text as Y.
    expect(prefilter("[Чытаць далей](#1)")).toEqual({ kind: "drop", reason: "nobody" });
    expect(prefilter("[t.me/example](#12)")).toEqual({ kind: "drop", reason: "nobody" });
    expect(prefilter("[](#1)")).toEqual({ kind: "drop", reason: "nobody" });
  });

  test("a lone link token surrounded by whitespace is dropped", () => {
    expect(prefilter("\n  [Read more](#3)  \n")).toEqual({ kind: "drop", reason: "nobody" });
  });

  test("a body with a link and prose is not dropped", () => {
    expect(prefilter("Something happened [source](#1)")).toBeUndefined();
    expect(prefilter("[source](#1) and then some prose")).toBeUndefined();
  });

  test("two bare link tokens are not dropped: the rule is exactly one", () => {
    expect(prefilter("[a](#1) [b](#2)")).toBeUndefined();
  });

  test("ordinary prose with no link is not dropped", () => {
    expect(prefilter("Учора ў Мінску адбылося нешта.")).toBeUndefined();
  });

  test("a link-like string that is not a token does not drop", () => {
    expect(prefilter("[not a token](#abc)")).toBeUndefined();
    expect(prefilter("[nested ] bracket](#1)")).toBeUndefined();
  });
});

describe("route — the rules, in order", () => {
  test("no category returned yields a retry decision the orchestrator throws on", () => {
    expect(route({ importance: "high" })).toEqual({ kind: "retry", cause: "no-category" });
    expect(route({ category: "", importance: "high" })).toEqual({
      kind: "retry",
      cause: "no-category",
    });
  });

  test("the no-category row is checked before importance: low, per table order", () => {
    expect(route({ importance: "low" })).toEqual({ kind: "retry", cause: "no-category" });
  });

  test("importance low drops with reason low", () => {
    expect(route(classified({ importance: "low" }))).toEqual({ kind: "drop", reason: "low" });
  });

  test("category crime&law drops with reason category", () => {
    expect(route({ category: DROPPED_CATEGORY, importance: "high" })).toEqual({
      kind: "drop",
      reason: "category",
    });
  });

  test("importance low wins over crime&law, per table order", () => {
    expect(route({ category: DROPPED_CATEGORY, importance: "low" })).toEqual({
      kind: "drop",
      reason: "low",
    });
  });

  test("importance high with an ordinary category enqueues", () => {
    expect(route(classified({ importance: "high", category: "politics" }))).toEqual({
      kind: "enqueue",
    });
  });

  test("every category other than the dropped one enqueues at importance high", () => {
    for (const category of CATEGORIES) {
      expect(route({ category, importance: "high" })).toEqual({ kind: "enqueue" });
    }
  });
});

describe("route — the crime&law branch is currently dead", () => {
  test("DROPPED_CATEGORY is not a category, so the model cannot emit it", () => {
    // The model is held to CategorySchema, so this drop rule never fires in
    // production. Kept as written and pinned here.
    expect(CategorySchema.safeParse(DROPPED_CATEGORY).success).toBe(false);
    expect(CATEGORIES).not.toContain(DROPPED_CATEGORY);
  });

  test("no NewsItem can carry the dropped category, so route can only reach it via a widened input", () => {
    expect(() => classified({ category: DROPPED_CATEGORY })).toThrow();
  });
});

describe("normalizeAnalyzed", () => {
  test("AI fields overwrite the scrape defaults, scrape identity fields survive", () => {
    const analyzed = normalizeAnalyzed(
      scraped({ id: "chan/7", category: "operator-default" }),
      classified({ category: "war", title: "Front line moves" }),
    );

    expect(analyzed.id).toBe("chan/7");
    expect(analyzed.category).toBe("war");
    expect(analyzed.title).toBe("Front line moves");
  });

  test("an empty merge yields an empty tag list, never undefined", () => {
    const analyzed = normalizeAnalyzed(scraped({}), classified({}));

    expect(analyzed.tags).toEqual([]);
  });

  test("it does not mutate its inputs", () => {
    const source = scraped({ tags: ["belarus"], category: "other" });
    const ai = classified({ country: "by" });

    normalizeAnalyzed(source, ai);

    expect(source.tags).toEqual(["belarus"]);
    expect(source.category).toBe("other");
    expect(ai.country).toBe("by");
  });
});
