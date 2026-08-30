import type { NewsItem } from "../../lib/ai/newsItemSchema";
import type {
  AdjudicationPair,
  Adjudicator,
  Classifier,
  EmbeddingProvider,
} from "../../lib/ai/ports";

export interface StubClassifier extends Classifier {
  /** Bodies this classifier was asked about, in order. */
  readonly calls: readonly string[];
}

/**
 * A classifier with no model behind it.
 *
 * Unscripted input throws rather than returning a default. A fake that invents
 * a plausible classification would let a test pass while the stage under test
 * fed it the wrong body entirely.
 */
export function stubClassifier(
  results: Readonly<Record<string, NewsItem>>,
  failures: Readonly<Record<string, Error>> = {},
): StubClassifier {
  const calls: string[] = [];

  return {
    calls,
    classify: async (body) => {
      calls.push(body);

      const failure = failures[body];
      if (failure !== undefined) throw failure;

      const result = results[body];
      if (result === undefined) throw new Error(`stubClassifier has no script for body: ${body}`);

      return result;
    },
  };
}

/**
 * A unit vector whose cosine similarity to `e1` is exactly `target`.
 *
 * In R^n with a = e1, the vector b = target*e1 + sqrt(1 - target^2)*e2 has
 * |b| = 1 and a·b = target, so cos(a, b) = target. This is how a dedup test
 * produces "two items at similarity 0.90" without a real embedding model.
 */
export function unitVectorAtAngle(target: number, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  vector[0] = target;
  if (dimensions > 1) vector[1] = Math.sqrt(1 - target * target);
  return vector;
}

export interface StubEmbedder extends EmbeddingProvider {
  /** Each batch of texts this embedder was asked to embed, in order. */
  readonly batches: readonly (readonly string[])[];
}

/**
 * An embedding provider with no model behind it.
 *
 * Like the classifier, an unscripted text throws. Returning a zero vector would
 * be worse than useless: §6 L508 skips empty embeddings and cosine scores a
 * zero vector at 0, so the item would quietly create its own message and the
 * test would report a false split as correct behaviour.
 */
export function stubEmbedder(vectors: Readonly<Record<string, number[]>>): StubEmbedder {
  const batches: (readonly string[])[] = [];

  return {
    batches,
    embedBatch: async (texts) => {
      batches.push([...texts]);

      return texts.map((text) => {
        const vector = vectors[text];
        if (vector === undefined) throw new Error(`stubEmbedder has no vector for text: ${text}`);
        return vector;
      });
    },
  };
}

/**
 * Decides by a caller-supplied predicate, and records what it was asked.
 * `calls` is what lets a test assert the band produced ONE call for the batch
 * rather than one per pair.
 */
export function fakeAdjudicator(
  decide: (pair: AdjudicationPair) => boolean,
): Adjudicator & { readonly calls: AdjudicationPair[][] } {
  const calls: AdjudicationPair[][] = [];

  return {
    calls,
    adjudicate: async (pairs) => {
      calls.push([...pairs]);
      return new Map(pairs.map((pair) => [pair.id, decide(pair)]));
    },
  };
}

/** Throws, to drive R46's "adjudication failure splits" path. */
export function failingAdjudicator(message = "adjudicator unavailable"): Adjudicator {
  return {
    adjudicate: async () => {
      throw new Error(message);
    },
  };
}
