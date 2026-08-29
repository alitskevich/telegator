import { describe, expect, test } from "vitest";
import { stubClassifier, stubEmbedder, unitVectorAtAngle } from "../../test/fakes/ai";
import { DIMENSIONS } from "../dedup/constants";
import { cosineSimilarity } from "../dedup/cosine";

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

describe("unitVectorAtAngle", () => {
  /**
   * The construction the dedup tests depend on: in R^n, a = e1 and
   * b = s*e1 + sqrt(1-s^2)*e2 gives cosine exactly s. Without it, a test for
   * "two items at similarity 0.90" has no way to produce that similarity.
   */
  test.each([0.9, 0.85, 0.8, 0])("produces a vector at cosine %s from e1", (target) => {
    const e1 = unitVectorAtAngle(1, DIMENSIONS);
    const other = unitVectorAtAngle(target, DIMENSIONS);

    expect(cosineSimilarity(e1, other)).toBeCloseTo(target, 12);
  });

  test("produces unit vectors of the requested dimension", () => {
    const v = unitVectorAtAngle(0.9, DIMENSIONS);

    expect(v).toHaveLength(DIMENSIONS);
    expect(cosineSimilarity(v, v)).toBe(1);
  });
});

describe("stubEmbedder", () => {
  test("returns the scripted vector for each text, in order", async () => {
    const embedder = stubEmbedder({ alpha: [1, 0], beta: [0, 1] });

    await expect(embedder.embedBatch(["beta", "alpha"], 2)).resolves.toEqual([
      [0, 1],
      [1, 0],
    ]);
  });

  test("throws for an unscripted text rather than returning a silent zero vector", async () => {
    await expect(stubEmbedder({}).embedBatch(["missing"], 2)).rejects.toThrow();
  });

  test("records each batch it was asked to embed", async () => {
    const embedder = stubEmbedder({ a: [1, 0] });

    await embedder.embedBatch(["a"], 2);

    expect(embedder.batches).toEqual([["a"]]);
  });

  test("embeds an empty batch to an empty result", async () => {
    await expect(stubEmbedder({}).embedBatch([], DIMENSIONS)).resolves.toEqual([]);
  });
});
