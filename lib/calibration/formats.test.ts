import { describe, expect, test } from "vitest";
import { packEmbedding } from "../db/embeddingCodec.js";
import { buildEmbeddingText } from "../dedup/embeddingText.js";
import {
  CURVE_HEADER,
  embeddingInputs,
  parseEmbeddings,
  parseItems,
  parsePairsJsonl,
  scorePairs,
  toCurveCsv,
} from "./formats.js";
import { type CurveRow, selectThreshold, sweep } from "./sweep.js";

const base64 = (vector: readonly number[]) => Buffer.from(packEmbedding(vector)).toString("base64");

/** Dims are taken from the vectors, so a fixture cannot contradict itself. */
const embeddingsFile = (vectors: Record<string, readonly number[]>) => ({
  model: "cohere.embed-multilingual-v3",
  dims: Object.values(vectors)[0]?.length ?? 0,
  inputType: "search_document",
  vectors: Object.fromEntries(Object.entries(vectors).map(([id, v]) => [id, base64(v)])),
});

describe("parsePairsJsonl", () => {
  test("reads one labelled pair per line", () => {
    const text = [
      '{"a":"x/1","b":"y/2","label":"same"}',
      '{"a":"x/3","b":"y/4","label":"different"}',
    ].join("\n");

    expect(parsePairsJsonl(text)).toEqual([
      { a: "x/1", b: "y/2", label: "same" },
      { a: "x/3", b: "y/4", label: "different" },
    ]);
  });

  test("ignores blank lines and trailing newlines", () => {
    expect(parsePairsJsonl('\n{"a":"x/1","b":"y/2","label":"same"}\n\n')).toHaveLength(1);
  });

  /** A mistyped label is a pair silently excluded from the curve. */
  test("rejects an unknown label, naming the line", () => {
    expect(() => parsePairsJsonl('{"a":"x/1","b":"y/2","label":"maybe"}')).toThrow(/line 1/);
  });

  test("rejects a line that is not an object", () => {
    expect(() => parsePairsJsonl("[1,2,3]")).toThrow(/line 1/);
  });

  test("rejects malformed JSON, naming the line", () => {
    const text = ['{"a":"x/1","b":"y/2","label":"same"}', "not json"].join("\n");

    expect(() => parsePairsJsonl(text)).toThrow(/line 2/);
  });
});

describe("parseItems", () => {
  test("reads the fields the embedding text is built from", () => {
    const items = parseItems([
      { id: "x/1", title: "T", summary: "S", category: "politics", tags: "a,b", body: "B" },
    ]);

    expect(items["x/1"]).toMatchObject({ title: "T", summary: "S", category: "politics" });
  });

  test("rejects an item with no id", () => {
    expect(() => parseItems([{ title: "T" }])).toThrow(/id/);
  });

  test("rejects a duplicate id, which would silently drop one item", () => {
    expect(() => parseItems([{ id: "x/1" }, { id: "x/1" }])).toThrow(/x\/1/);
  });
});

describe("embeddingInputs", () => {
  /**
   * §11.3's whole premise is that a threshold belongs to a specific embedding
   * space. It belongs just as much to the text that was embedded: calibrating on
   * a different concatenation than §6 L495 uses produces a number that does not
   * transfer, and nothing downstream would ever reveal it.
   */
  test("uses the same concatenation the aggregate stage embeds", () => {
    const item = { id: "x/1", title: "T", summary: "S", category: "c", tags: "t", body: "B" };

    expect(embeddingInputs(parseItems([item]))["x/1"]).toBe(buildEmbeddingText(item));
  });

  test("one input per item", () => {
    const inputs = embeddingInputs(
      parseItems([
        { id: "x/1", title: "A" },
        { id: "x/2", title: "B" },
      ]),
    );

    expect(Object.keys(inputs)).toEqual(["x/1", "x/2"]);
  });
});

describe("parseEmbeddings", () => {
  test("unpacks the base64 vectors", () => {
    const parsed = parseEmbeddings(embeddingsFile({ "x/1": [1, 0, 0] }));

    expect(parsed.vectors["x/1"]).toEqual([1, 0, 0]);
  });

  /**
   * Recorded, because §11.3 says a threshold is a property of a specific model.
   * A curve that does not say which model produced it cannot be checked against
   * the one the pipeline runs.
   */
  test("carries the model, dimensions and input type", () => {
    const parsed = parseEmbeddings(embeddingsFile({ "x/1": [1] }));

    expect(parsed).toMatchObject({
      model: "cohere.embed-multilingual-v3",
      dims: 1,
      inputType: "search_document",
    });
  });

  test("rejects a file with no model recorded", () => {
    const file = { ...embeddingsFile({ "x/1": [1] }), model: undefined };

    expect(() => parseEmbeddings(file)).toThrow(/model/);
  });

  /** A vector of the wrong width means the file and the model disagree. */
  test("rejects a vector whose length is not dims", () => {
    const file = { ...embeddingsFile({ "x/1": [1, 0, 0] }), dims: 4 };

    expect(() => parseEmbeddings(file)).toThrow(/x\/1/);
  });
});

describe("scorePairs", () => {
  const vectors = { "x/1": [1, 0], "x/2": [1, 0], "x/3": [0, 1] };

  test("scores each pair by cosine similarity", () => {
    const scored = scorePairs(
      [
        { a: "x/1", b: "x/2", label: "same" },
        { a: "x/1", b: "x/3", label: "different" },
      ],
      vectors,
    );

    expect(scored[0]?.similarity).toBeCloseTo(1);
    expect(scored[1]?.similarity).toBeCloseTo(0);
  });

  /**
   * Loudly, because a pair whose embedding is missing would otherwise score 0
   * and be counted as a confident non-match — dragging recall down and making
   * the sweep recommend a lower threshold than the data supports.
   */
  test("rejects a pair with no embedding, naming the item", () => {
    expect(() => scorePairs([{ a: "x/1", b: "x/9", label: "same" }], vectors)).toThrow(/x\/9/);
  });
});

describe("toCurveCsv", () => {
  const row = (threshold: number, precision: number | null): CurveRow => ({
    threshold,
    tp: 1,
    fp: 2,
    fn: 3,
    tn: 4,
    precision,
    recall: 0.25,
  });

  test("writes the header §11.3 step 5 records", () => {
    expect(toCurveCsv([]).split("\n")[0]).toBe(CURVE_HEADER);
    expect(CURVE_HEADER).toBe("threshold,tp,fp,fn,tn,precision,recall");
  });

  test("writes one line per row", () => {
    expect(toCurveCsv([row(0.7, 0.5), row(0.71, 0.5)]).split("\n")).toHaveLength(3);
  });

  test("a row carries its cells in header order", () => {
    expect(toCurveCsv([row(0.85, 0.5)]).split("\n")[1]).toBe("0.85,1,2,3,4,0.5,0.25");
  });

  /**
   * An empty cell, not 0 and not "null". Zero would read as "no correct merges
   * out of many", when in fact there were no merges at all — the two are
   * different findings and only one of them is a reason to lower the threshold.
   */
  test("an absent precision is an empty cell", () => {
    expect(toCurveCsv([row(0.95, null)]).split("\n")[1]).toBe("0.95,1,2,3,4,,0.25");
  });

  test("the threshold is written as the exact basis point", () => {
    expect(
      toCurveCsv([row(0.7, 1)])
        .split("\n")[1]
        ?.startsWith("0.7,"),
    ).toBe(true);
  });
});

describe("the harness end to end", () => {
  /**
   * Each part is unit-tested above; this is the only assertion that the parts
   * fit together — files in, a curve and a recommendation out. §11.3 step 5 asks
   * for exactly these artefacts.
   */
  test("files in, a curve and a chosen threshold out", () => {
    const items = parseItems([
      { id: "x/1", title: "Explosion downtown", summary: "S1", category: "politics" },
      { id: "x/2", title: "Blast in city centre", summary: "S2", category: "politics" },
      { id: "x/3", title: "Cup final", summary: "S3", category: "sports" },
    ]);

    expect(Object.keys(embeddingInputs(items))).toHaveLength(3);

    const { vectors } = parseEmbeddings(
      embeddingsFile({
        // x/1 and x/2 near each other; x/3 orthogonal to both.
        "x/1": [1, 0],
        "x/2": [0.99, Math.sqrt(1 - 0.99 ** 2)],
        "x/3": [0, 1],
      }),
    );

    const scored = scorePairs(
      [
        { a: "x/1", b: "x/2", label: "same" },
        { a: "x/1", b: "x/3", label: "different" },
        { a: "x/2", b: "x/3", label: "different" },
      ],
      vectors,
    );

    const rows = sweep(scored);
    expect(rows).toHaveLength(26);

    const chosen = selectThreshold(rows);
    // Perfect separation: the highest threshold still recalling the same pair.
    expect(chosen?.precision).toBe(1);
    expect(chosen?.recall).toBe(1);

    const csv = toCurveCsv(rows);
    expect(csv.split("\n")).toHaveLength(27);
    expect(csv.split("\n")[0]).toBe(CURVE_HEADER);
  });
});
