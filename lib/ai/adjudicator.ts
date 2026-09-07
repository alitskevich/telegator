import { z } from "zod";
import { ADJUDICATOR_MAX_TOKENS, ADJUDICATOR_MODEL_ID } from "./constants";
import { extractText } from "./messagesContent";
import { type ApiKeyProvider, createMessagesClient, missingApiKey } from "./openrouterClient";
import type { Adjudicator } from "./ports";

/**
 * R46 — the band adjudicator (the model that resolves the "adjudicate" verdict
 * from `lib/dedup/score.ts`'s classification).
 *
 * Same shape as `createOpenRouterClassifier`: a structural client interface, a
 * lazily-built client so constructing the adapter never fetches a secret, and
 * the shared `extractText`. Its own module rather than folded into
 * `openrouter.ts` because its contract — verdicts keyed by pair id, never
 * positional (§5.3) — is the thing this adapter exists to get right.
 */

const VerdictsSchema = z.object({
  verdicts: z.array(z.object({ id: z.string().min(1), same: z.boolean() })),
});

/** Sent as `output_config.format.schema`, generated rather than hand-written (§5.2 L427). */
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
  /** §7.6 — reads the key from Secrets Manager; supplied by `handlers/aggregate.ts`. */
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
