import { describe, expect, test } from "vitest";
import { DISTINCT_THRESHOLD, MERGE_THRESHOLD } from "../dedup/constants";
import {
  CURVE_HEADER,
  hashLabelledSet,
  parseItems,
  parsePairsJsonl,
  toCurveCsv,
  toKeyPairs,
} from "./formats";
import type { BandRow } from "./sweep";
import { sweepBands } from "./sweep";

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

  /** A mistyped label is a pair silently excluded from the sweep. */
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
  /**
   * R48 — the fields a match key is built from (§5.2's English fields), not
   * the fields the old embedding text concatenated. There is no embedding
   * step left to feed `summary`, `category` or `body` to.
   */
  test("reads the fields a match key is built from", () => {
    const items = parseItems([
      { id: "x/1", title: "T", peoples: "A, B", properNames: "C", tags: "t1, t2" },
    ]);

    expect(items["x/1"]).toMatchObject({
      title: "T",
      peoples: "A, B",
      properNames: "C",
      tags: "t1, t2",
    });
  });

  test("rejects an item with no id", () => {
    expect(() => parseItems([{ title: "T" }])).toThrow(/id/);
  });

  test("rejects a duplicate id, which would silently drop one item", () => {
    expect(() => parseItems([{ id: "x/1" }, { id: "x/1" }])).toThrow(/x\/1/);
  });
});

describe("toKeyPairs", () => {
  const items = parseItems([
    { id: "x/1", title: "Minsk Factory Fire", properNames: "Minsk" },
    { id: "x/2", title: "Minsk Factory Blaze", properNames: "Minsk" },
    { id: "x/3", title: "Cup Final", properNames: "Wembley" },
  ]);

  test("joins each pair to its items' match-key fields and a same/different flag", () => {
    const pairs = toKeyPairs(
      [
        { a: "x/1", b: "x/2", label: "same" },
        { a: "x/1", b: "x/3", label: "different" },
      ],
      items,
    );

    expect(pairs).toEqual([
      { fields: items["x/1"], other: items["x/2"], same: true },
      { fields: items["x/1"], other: items["x/3"], same: false },
    ]);
  });

  /**
   * Throws rather than dropping the pair. A silently dropped pair would shrink
   * the labelled set below what §11.3 step 1 requires without telling anyone.
   */
  test("throws naming a referenced item that is missing, on either side", () => {
    expect(() => toKeyPairs([{ a: "x/1", b: "x/9", label: "same" }], items)).toThrow(/x\/9/);
    expect(() => toKeyPairs([{ a: "x/9", b: "x/1", label: "same" }], items)).toThrow(/x\/9/);
  });

  /**
   * A self-pair scores 1.0 against itself under `matchScore` and would inflate
   * the auto-merge region's apparent precision — exactly the metric the
   * three-way objective exists to protect. Ported from the embedding-era
   * `distinctPairs`'s "pair with itself is rejected" guard.
   */
  test("a pair with itself is rejected", () => {
    expect(() => toKeyPairs([{ a: "x/1", b: "x/1", label: "same" }], items)).toThrow(/itself/);
  });

  /**
   * §6 compares without regard to order, so `(a,b)` and `(b,a)` are one
   * observation. Counting both would double that pair's weight against every
   * other pair in the set. Ported from `distinctPairs`.
   */
  test("a mirrored duplicate (a,b) / (b,a) is one observation, not two", () => {
    const pairs = toKeyPairs(
      [
        { a: "x/1", b: "x/2", label: "same" },
        { a: "x/2", b: "x/1", label: "same" },
      ],
      items,
    );

    expect(pairs).toHaveLength(1);
  });

  /**
   * Two labels for one pair is a labelling error, not a tie to resolve
   * silently — resolving it either way would decide the calibration on
   * whichever line happened to come first in the file. Ported from
   * `distinctPairs`.
   */
  test("contradictory labels for one pair are rejected", () => {
    expect(() =>
      toKeyPairs(
        [
          { a: "x/1", b: "x/2", label: "same" },
          { a: "x/2", b: "x/1", label: "different" },
        ],
        items,
      ),
    ).toThrow(/conflict/i);
  });
});

describe("hashLabelledSet", () => {
  test("is deterministic: the same inputs hash the same", () => {
    expect(hashLabelledSet("pairs", "items")).toBe(hashLabelledSet("pairs", "items"));
  });

  /**
   * A threshold is a property of the exact set it was tuned on — the same
   * argument that applied when the score was a similarity threshold over
   * embedded text. If two different labelled sets hashed the same, that
   * guarantee would be empty.
   */
  test("changes when either input changes", () => {
    const base = hashLabelledSet("pairs", "items");

    expect(hashLabelledSet("pairs2", "items")).not.toBe(base);
    expect(hashLabelledSet("pairs", "items2")).not.toBe(base);
  });

  test("is prefixed so a reader can tell which digest it is", () => {
    expect(hashLabelledSet("pairs", "items")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("toCurveCsv", () => {
  const row = (
    distinctThreshold: number,
    mergeThreshold: number,
    autoMergePrecision: number | null,
  ): BandRow => ({
    distinctThreshold,
    mergeThreshold,
    autoMergePrecision,
    autoSplitRecall: 0.5,
    bandFraction: 0.25,
  });

  test("writes the header §11.3 step 6 records", () => {
    expect(toCurveCsv([]).split("\n")[0]).toBe(CURVE_HEADER);
    expect(CURVE_HEADER).toBe(
      "distinctThreshold,mergeThreshold,autoMergePrecision,autoSplitRecall,bandFraction",
    );
  });

  test("writes one line per row", () => {
    expect(toCurveCsv([row(0.3, 0.7, 0.9), row(0.35, 0.72, 0.95)]).split("\n")).toHaveLength(3);
  });

  test("a row carries its cells in header order", () => {
    expect(toCurveCsv([row(0.35, 0.72, 0.9)]).split("\n")[1]).toBe("0.35,0.72,0.9,0.5,0.25");
  });

  /**
   * An empty cell, not 0 and not "null". Zero would read as "every merge was
   * wrong", when in fact there were no merges at all — different findings, and
   * only one of them is a reason to raise the merge threshold.
   */
  test("an absent auto-merge precision is an empty cell", () => {
    expect(toCurveCsv([row(0.35, 0.95, null)]).split("\n")[1]).toBe("0.35,0.95,,0.5,0.25");
  });
});

describe("the harness end to end (R48)", () => {
  /**
   * Each part is unit-tested above; this is the only assertion that the parts
   * fit together — files in, a curve and a row satisfying both error floors
   * out, with zero model calls anywhere in the path.
   */
  test("files in, a curve and a viable band out", () => {
    const items = parseItems([
      {
        id: "x/1",
        title: "Minsk Factory Fire",
        properNames: "Minsk, Belaruskali",
        tags: "fire, industry",
      },
      {
        id: "x/2",
        title: "Minsk Factory Blaze",
        properNames: "Minsk, Belaruskali",
        tags: "fire, safety",
      },
      { id: "x/3", title: "Cup Final Result", properNames: "Wembley", tags: "sports" },
    ]);

    const pairs = toKeyPairs(
      [
        { a: "x/1", b: "x/2", label: "same" },
        { a: "x/1", b: "x/3", label: "different" },
        { a: "x/2", b: "x/3", label: "different" },
      ],
      items,
    );

    const rows = sweepBands(pairs, { step: 0.01 });
    const productionRow = rows.find(
      (candidate) =>
        candidate.distinctThreshold === DISTINCT_THRESHOLD &&
        candidate.mergeThreshold === MERGE_THRESHOLD,
    );

    // The pair actually judged the same scores well above 0.72 (shared
    // entities and half the title tokens); both different pairs share nothing
    // and score 0. §6's provisional band separates them perfectly.
    expect(productionRow).toMatchObject({
      autoMergePrecision: 1,
      autoSplitRecall: 1,
      bandFraction: 0,
    });

    const csv = toCurveCsv(rows);
    expect(csv.split("\n")[0]).toBe(CURVE_HEADER);
    expect(csv.split("\n")).toHaveLength(rows.length + 1);

    const hash = hashLabelledSet(
      ['{"a":"x/1","b":"x/2","label":"same"}'].join("\n"),
      JSON.stringify(items),
    );
    expect(hash).toMatch(/^sha256:/);
  });
});
