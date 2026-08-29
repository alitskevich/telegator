import { describe, expect, test } from "vitest";
import {
  AiFieldsSchema,
  AnalyzedItemSchema,
  ITEM_KINDS,
  LinkSchema,
  ScrapedItemSchema,
  SUMMARY_MAX_LENGTH,
} from "./item.js";

const scraped = {
  id: "yigal_levin/12345",
  body: "Explosions reported in [the capital](#1)",
  links: [{ id: 1, href: "https://example.test/a" }],
  tgChannel: "telegator_news",
  date: "2026-08-29",
  category: "geopolitics",
  tags: "war,politics",
  kind: "post",
};

const aiFields = {
  title: "Capital explosions reported",
  summary: "Выбухі ў сталіцы",
  country: "UA",
  location: "Kyiv",
  importance: "high",
  category: "geopolitics",
};

describe("LinkSchema", () => {
  test("resolves a #N token to an href (§2.2 L123)", () => {
    expect(LinkSchema.parse({ id: 1, href: "https://example.test/a" })).toEqual({
      id: 1,
      href: "https://example.test/a",
    });
  });

  test("rejects a non-numeric token id", () => {
    expect(LinkSchema.safeParse({ id: "1", href: "https://example.test/a" }).success).toBe(false);
  });
});

describe("ScrapedItemSchema (Stage A, §2.2 L120-130)", () => {
  test("parses a scraped post", () => {
    expect(ScrapedItemSchema.parse(scraped)).toMatchObject(scraped);
  });

  test("parses a minimal post: only the fields scrape always produces", () => {
    const minimal = { id: "abc/1", body: "text", date: "2026-08-29", kind: "post" };

    expect(ScrapedItemSchema.parse(minimal).links).toEqual([]);
  });

  test("delegates id validation, so a malformed composite id never enters the queue", () => {
    expect(ScrapedItemSchema.safeParse({ ...scraped, id: "a/b/1" }).success).toBe(false);
  });

  test("delegates date validation, since date is the FIFO group and dedup partition", () => {
    expect(ScrapedItemSchema.safeParse({ ...scraped, date: "2026-02-30" }).success).toBe(false);
  });

  test.each(ITEM_KINDS)("accepts kind %s", (kind) => {
    expect(ScrapedItemSchema.safeParse({ ...scraped, kind }).success).toBe(true);
  });

  test("rejects a kind outside §2.2 L130's enum", () => {
    expect(ScrapedItemSchema.safeParse({ ...scraped, kind: "fetched" }).success).toBe(false);
  });

  test("strips an unknown attribute", () => {
    expect(ScrapedItemSchema.parse({ ...scraped, status: "legacy" })).not.toHaveProperty("status");
  });

  /** §6 L536 reads `item.tgChannel ?? "telegator_news"`, so absence is expected. */
  test("allows an absent tgChannel", () => {
    const { tgChannel: _omitted, ...rest } = scraped;

    expect(ScrapedItemSchema.safeParse(rest).success).toBe(true);
  });
});

describe("AiFieldsSchema (§5.2 L441-453)", () => {
  test("requires the six fields L441 lists as required", () => {
    expect(AiFieldsSchema.parse(aiFields)).toMatchObject(aiFields);
  });

  test.each(["title", "summary", "country", "location", "importance", "category"])(
    "rejects a response missing the required %s",
    (missing) => {
      const partial: Record<string, unknown> = { ...aiFields };
      delete partial[missing];

      expect(AiFieldsSchema.safeParse(partial).success).toBe(false);
    },
  );

  test("treats peoples, properNames and tags as optional per L441", () => {
    expect(AiFieldsSchema.parse(aiFields).peoples).toBeUndefined();
    expect(AiFieldsSchema.safeParse({ ...aiFields, peoples: "Ivan Ivanov" }).success).toBe(true);
  });

  test.each(["high", "low"])("accepts importance %s", (importance) => {
    expect(AiFieldsSchema.safeParse({ ...aiFields, importance }).success).toBe(true);
  });

  test("rejects an importance outside §5.2 L450's enum", () => {
    expect(AiFieldsSchema.safeParse({ ...aiFields, importance: "medium" }).success).toBe(false);
  });

  /** §12.2 L884 and §5.2 L455: the source prompt's 60-symbol cap is raised to 220. */
  test("caps summary at 220 characters", () => {
    expect(SUMMARY_MAX_LENGTH).toBe(220);
    expect(AiFieldsSchema.safeParse({ ...aiFields, summary: "x".repeat(220) }).success).toBe(true);
    expect(AiFieldsSchema.safeParse({ ...aiFields, summary: "x".repeat(221) }).success).toBe(false);
  });

  /** The model returns whatever case it likes; §3.2 L244 is what uppercases it. */
  test("does not require the model's country to be uppercase", () => {
    expect(AiFieldsSchema.safeParse({ ...aiFields, country: "ua" }).success).toBe(true);
  });
});

describe("AnalyzedItemSchema (Stage B, §2.2 L132)", () => {
  const analyzed = { ...scraped, ...aiFields };

  test("carries Stage A plus the AI fields", () => {
    expect(AnalyzedItemSchema.parse(analyzed)).toMatchObject(analyzed);
  });

  /**
   * §6 L495 builds the embedding text as
   * [title, summary, category, tags, body].filter(Boolean).join(" ").
   * Dropping `body` between stages would silently degrade every similarity
   * score, and no test of the dedup algorithm itself would notice.
   */
  test("keeps body, which §6 L495 embeds", () => {
    expect(AnalyzedItemSchema.parse(analyzed).body).toBe(scraped.body);
  });

  test("requires the AI fields, so an unanalyzed item cannot reach the aggregate queue", () => {
    expect(AnalyzedItemSchema.safeParse(scraped).success).toBe(false);
  });

  /** AC-2.4 (L253): country is always uppercase or empty, by the time it is enqueued. */
  test("rejects a lowercase country on the aggregate queue", () => {
    expect(AnalyzedItemSchema.safeParse({ ...analyzed, country: "ua" }).success).toBe(false);
  });

  test("accepts an empty country, which AC-2.4 allows", () => {
    expect(AnalyzedItemSchema.safeParse({ ...analyzed, country: "" }).success).toBe(true);
  });

  test("keeps tags required-shaped from Stage A rather than weakening it to the AI optional", () => {
    expect(AnalyzedItemSchema.parse(analyzed).tags).toBe("war,politics");
  });
});
