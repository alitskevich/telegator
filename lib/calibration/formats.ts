import { z } from "zod";
import { unpackEmbedding } from "../db/embeddingCodec.js";
import { cosineSimilarity } from "../dedup/cosine.js";
import { buildEmbeddingText } from "../dedup/embeddingText.js";
import type { PairLabel, ScoredPair } from "./sweep.js";

/**
 * §11.3 step 5 — "Record the value, the curve and the labelled set in the
 * repository."
 *
 * Four files, and the shapes are here so the labelled set outlives the run that
 * produced it. A curve without its model, its dimensions and the text that was
 * embedded cannot be checked against the pipeline it was meant to calibrate.
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
  readonly label: PairLabel;
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
 * `items.json` — the fields §6 L495 embeds, and nothing else.
 *
 * Deliberately narrower than `AnalyzedItem`: a labelled set is assembled by hand
 * from existing data, and requiring every pipeline field would make it harder to
 * produce without making the calibration any more faithful.
 */
const CalibrationItemSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  summary: z.string().optional(),
  category: z.string().optional(),
  tags: z.string().optional(),
  body: z.string().optional(),
});

export type CalibrationItem = z.infer<typeof CalibrationItemSchema>;

export function parseItems(raw: unknown): Record<string, CalibrationItem> {
  const items = z.array(CalibrationItemSchema).parse(raw);
  const byId: Record<string, CalibrationItem> = {};

  for (const item of items) {
    // A duplicate id would silently drop one of the two, and the pair that
    // referenced it would be scored against the wrong text.
    if (item.id in byId) throw new Error(`items.json contains ${item.id} twice`);
    byId[item.id] = item;
  }

  return byId;
}

/**
 * The text to embed for each item, from §2.11's builder.
 *
 * Shared with the aggregate stage on purpose. §11.3's premise is that a
 * threshold belongs to a specific embedding space, and it belongs just as much
 * to the text that was embedded — calibrating on a different concatenation than
 * §6 L495 uses produces a number that does not transfer, and nothing downstream
 * would ever reveal it.
 */
export function embeddingInputs(items: Record<string, CalibrationItem>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(items).map(([id, item]) => [id, buildEmbeddingText(item)]),
  );
}

/** `embeddings.json` — base64 packed vectors, with the model that produced them. */
const EmbeddingsFileSchema = z.object({
  model: z.string().min(1),
  dims: z.number().int().positive(),
  inputType: z.string().min(1),
  vectors: z.record(z.string(), z.string()),
});

export interface Embeddings {
  readonly model: string;
  readonly dims: number;
  readonly inputType: string;
  readonly vectors: Record<string, number[]>;
}

export function parseEmbeddings(raw: unknown): Embeddings {
  const file = EmbeddingsFileSchema.parse(raw);
  const vectors: Record<string, number[]> = {};

  for (const [id, encoded] of Object.entries(file.vectors)) {
    const vector = unpackEmbedding(Buffer.from(encoded, "base64"));

    // A vector of the wrong width means the file and the model it claims
    // disagree, and every similarity computed from it would be meaningless.
    if (vector.length !== file.dims) {
      throw new Error(
        `embeddings.json: ${id} has ${vector.length} dimensions, expected ${file.dims}`,
      );
    }

    vectors[id] = vector;
  }

  return { model: file.model, dims: file.dims, inputType: file.inputType, vectors };
}

/**
 * Attach a cosine similarity to each labelled pair.
 *
 * A missing embedding throws rather than scoring zero: a zero would be counted
 * as a confident non-match at every threshold, dragging recall down and making
 * the sweep recommend a lower threshold than the data supports.
 */
export function scorePairs(
  pairs: readonly LabelledPair[],
  vectors: Readonly<Record<string, readonly number[]>>,
): ScoredPair[] {
  return pairs.map((pair) => {
    const a = vectors[pair.a];
    const b = vectors[pair.b];

    if (a === undefined) throw new Error(`no embedding for ${pair.a}`);
    if (b === undefined) throw new Error(`no embedding for ${pair.b}`);

    return { ...pair, similarity: cosineSimilarity([...a], [...b]) };
  });
}

/** `curve.csv` — §11.3 step 5's record of the sweep. */
export const CURVE_HEADER = "threshold,tp,fp,fn,tn,precision,recall";

export function toCurveCsv(
  rows: readonly {
    threshold: number;
    tp: number;
    fp: number;
    fn: number;
    tn: number;
    precision: number | null;
    recall: number;
  }[],
): string {
  return [
    CURVE_HEADER,
    ...rows.map((row) =>
      [
        row.threshold,
        row.tp,
        row.fp,
        row.fn,
        row.tn,
        // Empty, not 0 and not "null". Zero reads as "no correct merges out of
        // many", when in fact there were no merges at all — different findings,
        // and only one is a reason to lower the threshold.
        row.precision ?? "",
        row.recall,
      ].join(","),
    ),
  ].join("\n");
}
