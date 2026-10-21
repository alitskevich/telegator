import type { Adjudicator } from "tg-ai/types";
import { ADJUDICATOR_MAX_TOKENS, ADJUDICATOR_MODEL_ID } from "tg-configs/ai";
import { z } from "zod";
import { extractText } from "./messagesContent";
import { type ApiKeyProvider, createMessagesClient, missingApiKey } from "./openrouterClient";

/**
 * The band adjudicator: the model call that resolves the "adjudicate" verdict
 * of `tg-dedup/src/score.ts`. Built like `createOpenRouterClassifier`, with a lazy
 * client so construction never fetches a secret. Verdicts are keyed by pair id,
 * never by position.
 */

const VerdictsSchema = z.object({
  verdicts: z.array(z.object({ id: z.string().min(1), same: z.boolean() })),
});

/** Sent as `output_config.format.schema`, generated rather than hand-written. */
export const VERDICTS_SCHEMA = z.toJSONSchema(VerdictsSchema);

/**
 * Verdicts must cover the requested ids exactly — no gaps, no strangers, no
 * duplicates. A partial answer is an error, not a partial result: silently
 * defaulting the missing pairs would decide real merges by omission.
 */
export function parseVerdicts(
  response: unknown,
  expected: readonly string[],
): ReadonlyMap<string, boolean> {
  const { verdicts } = VerdictsSchema.parse(JSON.parse(extractText(response, "adjudicator")));

  const byId = new Map<string, boolean>();
  for (const verdict of verdicts) {
    if (byId.has(verdict.id)) throw new Error(`duplicate verdict for pair ${verdict.id}`);
    byId.set(verdict.id, verdict.same);
  }

  const wanted = new Set(expected);
  for (const id of byId.keys()) {
    if (!wanted.has(id)) throw new Error(`verdict for unknown pair ${id}`);
  }
  for (const id of wanted) {
    if (!byId.has(id)) throw new Error(`missing verdict for pair ${id}`);
  }

  return byId;
}

export interface AdjudicatorClient {
  create(request: unknown): Promise<unknown>;
}

export interface OpenRouterAdjudicatorOptions {
  readonly client?: AdjudicatorClient;
  /** Reads the key from the function secret; supplied by `tg-functions/src/index.ts`. */
  readonly apiKey?: ApiKeyProvider;
}

const SYSTEM_PROMPT =
  "You decide whether two news reports describe the same underlying event. " +
  "Two reports of one event may use different wording, different sources and " +
  "different emphasis. Different events that merely share a place, a person or " +
  "a topic are NOT the same event. Answer for every pair you are given.";

export function createOpenRouterAdjudicator(
  options: OpenRouterAdjudicatorOptions = {},
): Adjudicator {
  let client = options.client;

  return {
    adjudicate: async (pairs) => {
      if (pairs.length === 0) return new Map();

      if (client === undefined) {
        if (options.apiKey === undefined) throw missingApiKey("the adjudicator");
        client = await createMessagesClient(options.apiKey);
      }

      const response = await client.create({
        model: ADJUDICATOR_MODEL_ID,
        max_tokens: ADJUDICATOR_MAX_TOKENS,
        system: SYSTEM_PROMPT,
        output_config: { format: { type: "json_schema", schema: VERDICTS_SCHEMA } },
        messages: [{ role: "user", content: JSON.stringify({ pairs }) }],
      });

      return parseVerdicts(
        response,
        pairs.map((pair) => pair.id),
      );
    },
  };
}
