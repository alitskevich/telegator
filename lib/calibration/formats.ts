import { createHash } from "node:crypto";
import { z } from "zod";
import type { MatchKeyFields } from "../dedup/matchKey";
import type { BandRow, LabelledKeyPair } from "./sweep";

/**
 * §11.3 step 1/6's file formats, rewritten (R48 — see `sweep.ts` for what the
 * harness itself became).
 *
 * `pairs.jsonl` — one hand-judged pair per line — is unchanged: the labelled
 * set is model-agnostic and did not move when the embedding step did.
 * `items.json` now carries the fields a match key is built from (§5.2's
 * English `title`/`peoples`/`properNames`/`tags`) rather than the fields the
 * old embedding text concatenated — there is no embedding step left to feed
 * `summary`, `category` or `body` to. `embeddings.json` is gone entirely:
 * nothing produces it, because `sweepBands` scores the analyzed fields
 * directly.
 */

/** `pairs.jsonl` — one hand-judged pair per line (§11.3 step 1). */
const LabelledPairSchema = z.object({
  a: z.string().min(1),
  b: z.string().min(1),
  label: z.enum(["same", "different"]),
});

export interface LabelledPair {
  readonly a: string;
  readonly b: string;
  readonly label: "same" | "different";
}

export function parsePairsJsonl(text: string): LabelledPair[] {
  return text
    .split("\n")
    .map((line, index) => ({ line: line.trim(), number: index + 1 }))
    .filter(({ line }) => line !== "")
    .map(({ line, number }) => {
      try {
        return LabelledPairSchema.parse(JSON.parse(line));
      } catch (error) {
        // Named by line, because a labelled set is hand-written and the only
        // way to fix one bad row is to be told which row it is.
        throw new Error(
          `pairs.jsonl line ${number}: ${error instanceof Error ? error.message : ""}`,
        );
      }
    });
}

/**
 * `items.json` — the fields a match key is built from (§5.2 L443-453), and
 * nothing else.
 *
 * Deliberately narrower than `AnalyzedItem`, for the same reason
 * `MatchKeyFields` is structural: a labelled set is assembled by hand from
 * existing data, and requiring every pipeline field would make it harder to
 * produce without making the calibration any more faithful.
 */
const CalibrationItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  peoples: z.string().optional(),
  properNames: z.string().optional(),
  tags: z.string().optional(),
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

/**
 * §6 compares an item against a candidate without regard to order, so `(a,b)`
 * and `(b,a)` are one observation.
 */
const keyOf = (pair: LabelledPair) => [pair.a, pair.b].sort().join(" ");

/**
 * Collapse mirrored duplicates and reject what cannot be one pair, before the
 * ids are erased into `fields`/`other`.
 *
 * Ported from the embedding-era `ScoredPair` harness's `distinctPairs` — the
 * rewrite from id-keyed pairs to id-less `LabelledKeyPair`s dropped these
 * guards by omission, not by decision, and they matter more here than they
 * looked: the labelled set is what `autoMergePrecision`, `autoSplitRecall` and
 * `bandFraction` are computed from, and those numbers are what
 * `calibration/record.json` asks production to trust. A self-pair scores 1.0
 * against itself and inflates the auto-merge region's apparent precision —
 * exactly the metric the three-way objective is built to protect. A pair
 * counted twice (once as `(a,b)`, once as `(b,a)`) silently doubles its
 * weight against every other pair in the set. This has to run over
 * `LabelledPair`, before `toKeyPairs` resolves ids to fields, because `a`/`b`
 * are the only handle a duplicate or a self-pair can be recognised by.
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

    // A pair labelled both ways is a labelling error. Picking one would decide
    // the calibration on whichever line happened to come first in the file.
    if (existing.label !== pair.label) {
      throw new Error(`pairs.jsonl: conflicting labels for pair ${pair.a} / ${pair.b}`);
    }
  }

  return [...seen.values()];
}

/**
 * Join labelled pairs to the match-key fields `sweepBands` needs.
 *
 * `CalibrationItem` is a superset of `MatchKeyFields` — it carries `id` too —
 * so each side is passed through as-is rather than rebuilt field by field.
 */
export function toKeyPairs(
  pairs: readonly LabelledPair[],
  items: Readonly<Record<string, CalibrationItem>>,
): LabelledKeyPair[] {
  return distinctLabelledPairs(pairs).map((pair) => {
    const fields: MatchKeyFields | undefined = items[pair.a];
    const other: MatchKeyFields | undefined = items[pair.b];

    // Throws rather than dropping the pair: a silently dropped pair would
    // shrink the labelled set below §11.3 step 1's floor without telling
    // anyone.
    if (fields === undefined) throw new Error(`pairs.jsonl references unknown item ${pair.a}`);
    if (other === undefined) throw new Error(`pairs.jsonl references unknown item ${pair.b}`);

    return { fields, other, same: pair.label === "same" };
  });
}

/**
 * The labelled set's hash, recorded as `labelledSetHash` (R48).
 *
 * A threshold is a property of the exact set it was tuned on — the same
 * argument that applied when the score was a similarity threshold over
 * embedded text, carried over unchanged to the fields a match key is built
 * from. Hashing both files rather than one: a `pairs.jsonl` unchanged against
 * an edited `items.json` (or vice versa) is still a different labelled set.
 */
export function hashLabelledSet(pairsJsonl: string, itemsJson: string): string {
  const digest = createHash("sha256")
    .update(pairsJsonl, "utf8")
    .update(itemsJson, "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

/** `curve.csv` — §11.3 step 6's record of the sweep. */
export const CURVE_HEADER =
  "distinctThreshold,mergeThreshold,autoMergePrecision,autoSplitRecall,bandFraction";

export function toCurveCsv(rows: readonly BandRow[]): string {
  return [
    CURVE_HEADER,
    ...rows.map((row) =>
      [
        row.distinctThreshold,
        row.mergeThreshold,
        // Empty, not 0 and not "null". Zero reads as "every merge was wrong",
        // when in fact there were no merges at all — different findings, and
        // only one is a reason to raise the merge threshold.
        row.autoMergePrecision ?? "",
        row.autoSplitRecall,
        row.bandFraction,
      ].join(","),
    ),
  ].join("\n");
}
