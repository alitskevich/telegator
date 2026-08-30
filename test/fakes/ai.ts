import type { NewsItem } from "../../lib/ai/newsItemSchema";
import type { AdjudicationPair, Adjudicator, Classifier } from "../../lib/ai/ports";

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
