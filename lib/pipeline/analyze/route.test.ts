import { describe, expect, test } from "vitest";
import { CATEGORIES, CategorySchema, DROPPED_CATEGORY } from "../../ai/categories.js";
import type { NewsItem } from "../../ai/newsItemSchema.js";
import { NewsItemSchema } from "../../ai/newsItemSchema.js";
import type { ScrapedItem } from "../../domain/item.js";
import { AnalyzedItemSchema, ScrapedItemSchema } from "../../domain/item.js";
import {
  normalizeAnalyzed,
  normalizeCountry,
  normalizeTags,
  prefilter,
  route,
  skippedDimensions,
} from "./route.js";

/**
 * Fixtures are parsed rather than cast: the house rule bans type assertions, and
 * parsing also proves each fixture is a payload the previous stage could produce.
 */
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

describe("route — acceptance criteria", () => {
  test("AC-2.1 (§3.2 L250) an item classified importance: low never reaches aggregate", () => {
    const decision = route(classified({ importance: "low" }));

    expect(decision).toEqual({ kind: "drop", reason: "low" });
    expect(decision.kind).not.toBe("enqueue");
  });

  test("AC-2.3 (§3.2 L252) source tags survive alongside AI tags, with no duplicates", () => {
    expect(normalizeTags("war,economy", "belarus,war")).toBe("war,economy,belarus");
  });

  test("AC-2.3 source-only and AI-only tags both survive an absent counterpart", () => {
    expect(normalizeTags(undefined, "belarus,minsk")).toBe("belarus,minsk");
    expect(normalizeTags("war", undefined)).toBe("war");
  });

  test("AC-2.4 (§3.2 L253) country is always uppercase or empty", () => {
    expect(normalizeCountry("by")).toBe("BY");
    expect(normalizeCountry("By")).toBe("BY");
    expect(normalizeCountry("BY")).toBe("BY");
    expect(normalizeCountry("")).toBe("");
  });

  test("AC-2.4 normalizeAnalyzed produces a payload AnalyzedItemSchema accepts", () => {
    const analyzed = normalizeAnalyzed(
      scraped({ tags: "belarus,war" }),
      classified({ country: "by", tags: "war,economy" }),
    );

    expect(analyzed.country).toBe("BY");
    expect(analyzed.tags).toBe("war,economy,belarus");
    expect(() => AnalyzedItemSchema.parse(analyzed)).not.toThrow();
  });
});

describe("prefilter — §3.2 L231", () => {
  test("an empty body is dropped with reason nobody", () => {
    expect(prefilter("")).toEqual({ kind: "drop", reason: "nobody" });
  });

  test("a whitespace-only body is dropped with reason nobody", () => {
    expect(prefilter("   \n\n\t  ")).toEqual({ kind: "drop", reason: "nobody" });
  });

  test("the literal `[link1](#1)` of L231 is dropped", () => {
    expect(prefilter("[link1](#1)")).toEqual({ kind: "drop", reason: "nobody" });
  });

  test("R31 — any single `[Y](#N)` token is dropped, not only the literal of L231", () => {
    // §3.1 L203 emits `[Y](#N)` where Y is the anchor's own text, so a body of
    // exactly the 12 characters `[link1](#1)` would essentially never occur.
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

  test("two bare link tokens are not dropped — L231 says exactly one", () => {
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

describe("route — the table of §3.2 L237–242, in order", () => {
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

  test("every §5.4 category other than the dropped one enqueues at importance high", () => {
    for (const category of CATEGORIES) {
      expect(route({ category, importance: "high" })).toEqual({ kind: "enqueue" });
    }
  });
});

describe("route — R5: the crime&law branch is currently dead", () => {
  test("DROPPED_CATEGORY is not one of §5.4's categories, so the model cannot emit it", () => {
    // §5.2 L423 constrains model output to CategorySchema. The drop rule of
    // §3.2 L241 is therefore unreachable in production and its metric is always
    // zero — implemented as written, pinned here rather than silently corrected.
    expect(CategorySchema.safeParse(DROPPED_CATEGORY).success).toBe(false);
    expect(CATEGORIES).not.toContain(DROPPED_CATEGORY);
  });

  test("no NewsItem can carry the dropped category, so route can only reach it via a widened input", () => {
    expect(() => classified({ category: DROPPED_CATEGORY })).toThrow();
  });
});

describe("skippedDimensions — R31: the dimension name is `Reason`, capital R", () => {
  test("uses §7.7 L688's spelling, not §3.2 L241's lowercase `reason`", () => {
    // CloudWatch dimension names are case-sensitive; two spellings would split
    // one metric into two.
    expect(skippedDimensions("low")).toEqual({ Reason: "low" });
    expect(skippedDimensions("category")).toEqual({ Reason: "category" });
    expect(skippedDimensions("nobody")).toEqual({ Reason: "nobody" });
  });
});

describe("normalizeAnalyzed — §3.2 L244", () => {
  test("AI fields overwrite the scrape defaults, scrape identity fields survive", () => {
    const analyzed = normalizeAnalyzed(
      scraped({ id: "chan/7", category: "operator-default", tgChannel: "news" }),
      classified({ category: "war", title: "Front line moves" }),
    );

    expect(analyzed.id).toBe("chan/7");
    expect(analyzed.tgChannel).toBe("news");
    expect(analyzed.category).toBe("war");
    expect(analyzed.title).toBe("Front line moves");
  });

  test("an empty merge yields an empty tag string, never undefined", () => {
    const analyzed = normalizeAnalyzed(scraped({}), classified({}));

    expect(analyzed.tags).toBe("");
  });

  test("it does not mutate its inputs", () => {
    const source = scraped({ tags: "belarus", category: "other" });
    const ai = classified({ country: "by" });

    normalizeAnalyzed(source, ai);

    expect(source.tags).toBe("belarus");
    expect(source.category).toBe("other");
    expect(ai.country).toBe("by");
  });
});
