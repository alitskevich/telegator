import { createHash } from "node:crypto";
import { TagsSchema } from "tg-domain/tags";
import { z } from "zod";
import type { MatchKeyFields } from "../types";
import type { BandRow, LabelledKeyPair, LabelledPair } from "./types";

/**
 * The calibration file formats. `pairs.jsonl` is the labelled set, one
 * hand-judged pair per line. `items.json` carries the English fields a match key
 * is built from (`title`/`peoples`/`properNames`/`tags`), which `sweepBands` scores.
 */

/** `pairs.jsonl` — one hand-judged pair per line. */
const LabelledPairSchema = z.object({
  a: z.string().min(1),
  b: z.string().min(1),
  label: z.enum(["same", "different"]),
});

export function parsePairsJsonl(text: string): LabelledPair[] {
  return text
    .split("\n")
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => line !== "")
    .map(({ line, number }) => {
      try {
        return LabelledPairSchema.parse(JSON.parse(line));
      } catch (error) {
        // Named by line: the set is hand-written, so the author needs the row.
        throw new Error(
          `pairs.jsonl line ${number}: ${error instanceof Error ? error.message : ""}`,
        );
      }
    });
}

/**
 * `items.json` — the fields a match key is built from, and nothing else.
 * Narrower than `AnalyzedItem`, so a hand-built labelled set stays easy to make.
 */
const CalibrationItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  peoples: z.string().optional(),
  properNames: z.string().optional(),
  tags: TagsSchema.optional(),
});

export type CalibrationItem = z.infer<typeof CalibrationItemSchema>;

export function parseItems(raw: unknown): Record<string, CalibrationItem> {
  const items = z.array(CalibrationItemSchema).parse(raw);
  const byId: Record<string, CalibrationItem> = {};

  for (const item of items) {
    // A duplicate id would silently drop one of the two, and any pair that
    // referenced it would be scored against the wrong fields.
    if (item.id in byId) throw new Error(`items.json contains ${item.id} twice`);
    byId[item.id] = item;
  }

  return byId;
}

/** Scoring ignores order, so `(a,b)` and `(b,a)` are one observation. */
const keyOf = (pair: LabelledPair) => [pair.a, pair.b].sort().join(" ");

/**
 * Collapses mirrored duplicates and rejects self-pairs, while the ids are still
 * there to compare. A self-pair scores 1.0 and inflates auto-merge precision; a
 * pair counted twice doubles its weight.
 */
function distinctLabelledPairs(pairs: readonly LabelledPair[]): LabelledPair[] {
  const seen = new Map<string, LabelledPair>();

  for (const pair of pairs) {
    if (pair.a === pair.b) throw new Error(`pairs.jsonl: ${pair.a} is paired with itself`);

    const key = keyOf(pair);
    const existing = seen.get(key);

    if (existing === undefined) {
      seen.set(key, pair);
      continue;
    }

    // A pair labelled both ways is a labelling error, not a tie to resolve.
    if (existing.label !== pair.label) {
      throw new Error(`pairs.jsonl: conflicting labels for pair ${pair.a} / ${pair.b}`);
    }
  }

  return [...seen.values()];
}

/** Joins labelled pairs to the match-key fields `sweepBands` needs. */
export function toKeyPairs(
  pairs: readonly LabelledPair[],
  items: Readonly<Record<string, CalibrationItem>>,
): LabelledKeyPair[] {
  return distinctLabelledPairs(pairs).map((pair) => {
    const fields: MatchKeyFields | undefined = items[pair.a];
    const other: MatchKeyFields | undefined = items[pair.b];

    // Throws rather than dropping the pair, which would shrink the set silently.
    if (fields === undefined) throw new Error(`pairs.jsonl references unknown item ${pair.a}`);
    if (other === undefined) throw new Error(`pairs.jsonl references unknown item ${pair.b}`);

    return { fields, other, same: pair.label === "same" };
  });
}

/**
 * The labelled set's hash, recorded as `labelledSetHash`: a threshold belongs to
 * the exact set it was tuned on. Both files are hashed, since editing either
 * makes a different set.
 */
export function hashLabelledSet(pairsJsonl: string, itemsJson: string): string {
  const digest = createHash("sha256")
    .update(pairsJsonl, "utf8")
    .update(itemsJson, "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

/** `curve.csv` — the record of the sweep. */
export const CURVE_HEADER =
  "distinctThreshold,mergeThreshold,autoMergePrecision,autoSplitRecall,bandFraction";

export function toCurveCsv(rows: readonly BandRow[]): string {
  return [
    CURVE_HEADER,
    ...rows.map((row) =>
      [
        row.distinctThreshold,
        row.mergeThreshold,
        // Empty, not 0: zero would read as "every merge was wrong", not "no merges".
        row.autoMergePrecision ?? "",
        row.autoSplitRecall,
        row.bandFraction,
      ].join(","),
    ),
  ].join("\n");
}
