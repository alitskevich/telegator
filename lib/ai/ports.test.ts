import { describe, expect, test } from "vitest";
import { stubClassifier } from "../../test/fakes/ai";

const newsItem = {
  title: "Capital explosions reported",
  summary: "Выбухі ў сталіцы",
  country: "UA",
  location: "Kyiv",
  category: "geopolitics",
  importance: "high",
} as const;

describe("stubClassifier", () => {
  test("returns the scripted classification for a body", async () => {
    const classifier = stubClassifier({ "post one": newsItem });

    await expect(classifier.classify("post one")).resolves.toMatchObject(newsItem);
  });

  /**
   * §3.2 L239 routes a provider error to a throw, so SQS retries and the item
   * ultimately reaches the DLQ (§3.2 L246: an error is transient, a skip is
   * final). AC-2.2 and E2E-7 both need a classifier that fails on demand.
   */
  test("throws for a body scripted to fail, modelling a provider error", async () => {
    const boom = new Error("bedrock unavailable");
    const classifier = stubClassifier({ "post one": newsItem }, { "post two": boom });

    await expect(classifier.classify("post two")).rejects.toThrow("bedrock unavailable");
  });

  test("throws for an unscripted body rather than inventing a classification", async () => {
    await expect(stubClassifier({}).classify("unknown")).rejects.toThrow();
  });

  test("records the bodies it was asked to classify", async () => {
    const classifier = stubClassifier({ a: newsItem, b: newsItem });

    await classifier.classify("a");
    await classifier.classify("b");

    expect(classifier.calls).toEqual(["a", "b"]);
  });
});
