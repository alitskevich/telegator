import { type ScrapedItem, ScrapedItemSchema } from "tg-domain/item";
import { type NewsItem, NewsItemSchema } from "tg-domain/newsItemSchema";
import { metrics } from "tg-firebase/metrics";
import { enqueue } from "tg-firebase/tasks";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { stubClassifier } from "../../../test/support";
import { runAnalyze } from "./index";

vi.mock("tg-firebase/tasks", () => ({ enqueue: vi.fn(async () => true) }));
vi.mock("tg-firebase/metrics", () => ({ metrics: { count: vi.fn() } }));

const scraped = (body: string): ScrapedItem =>
  ScrapedItemSchema.parse({ id: "chan/1", body, date: "2026-08-29", kind: "post" });

const classification = (fields: Partial<NewsItem> = {}): NewsItem =>
  NewsItemSchema.parse({
    title: "Three word title",
    summary: "Кароткі змест.",
    country: "by",
    location: "Minsk",
    category: "politics",
    importance: "high",
    ...fields,
  });

beforeEach(() => vi.clearAllMocks());

describe("runAnalyze", () => {
  test("enqueues an important item for aggregate", async () => {
    const body = "Something happened in Minsk.";
    await runAnalyze(scraped(body), stubClassifier({ [body]: classification() }));

    expect(enqueue).toHaveBeenCalledWith(
      "aggregate",
      expect.objectContaining({ id: "chan/1", category: "politics" }),
    );
    expect(metrics.count).toHaveBeenCalledWith("ItemsAnalyzed");
  });

  test("drops a low-importance item", async () => {
    const body = "A local fair.";
    await runAnalyze(
      scraped(body),
      stubClassifier({ [body]: classification({ importance: "low" }) }),
    );

    expect(enqueue).not.toHaveBeenCalled();
    expect(metrics.count).toHaveBeenCalledWith("ItemsSkipped", 1, "low");
  });

  test("drops a bare link before paying for a model call", async () => {
    const classifier = stubClassifier({});
    await runAnalyze(scraped("[link](#1)"), classifier);

    expect(classifier.calls).toEqual([]);
    expect(metrics.count).toHaveBeenCalledWith("ItemsSkipped", 1, "nobody");
  });

  test("a provider error throws, so the task retries", async () => {
    await expect(runAnalyze(scraped("unscripted"), stubClassifier({}))).rejects.toThrow();
    expect(enqueue).not.toHaveBeenCalled();
  });
});
