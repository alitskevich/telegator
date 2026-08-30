import { z } from "zod";
import { ADJUDICATOR_MAX_TOKENS, ADJUDICATOR_MODEL_ID } from "./constants";
import { extractText } from "./messagesContent";
import type { Adjudicator } from "./ports";

/**
 * R46 — the band adjudicator (the model that resolves the "adjudicate" verdict
 * from `lib/dedup/score.ts`'s classification).
 *
 * Built on the same shape as `createBedrockClassifier` in `lib/ai/bedrock.ts`:
 * a structural client interface, a lazily-imported `AnthropicBedrockMantle` so
 * constructing the adapter never resolves AWS credentials, and the shared
 * `extractText` over Messages content blocks. Kept in its own module rather than
 * folded into `bedrock.ts` because its contract — verdicts keyed by pair id,
 * never positional — is the one thing this task exists to get right. The
 * content-block reader itself is shared (`./messagesContent`), not copied.
 */

const VerdictsSchema = z.object({
  verdicts: z.array(z.object({ id: z.string().min(1), same: z.boolean() })),
});

/** Sent as `output_config.format.schema`, generated rather than hand-written (§5.2 L423). */
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

export interface BedrockAdjudicatorOptions {
  readonly client?: AdjudicatorClient;
}

const SYSTEM_PROMPT =
  "You decide whether two news reports describe the same underlying event. " +
  "Two reports of one event may use different wording, different sources and " +
  "different emphasis. Different events that merely share a place, a person or " +
  "a topic are NOT the same event. Answer for every pair you are given.";

export function createBedrockAdjudicator(options: BedrockAdjudicatorOptions = {}): Adjudicator {
  let client = options.client;

  return {
    adjudicate: async (pairs) => {
      if (pairs.length === 0) return new Map();

      if (client === undefined) {
        // Imported lazily so the module can be loaded without the SDK resolving
        // a region or a credential chain.
        const { AnthropicBedrockMantle } = await import("@anthropic-ai/bedrock-sdk");
        // AWS_REGION is a reserved Lambda variable: read, never declared (§5.1 L396).
        const mantle = new AnthropicBedrockMantle({ awsRegion: process.env.AWS_REGION });
        client = { create: (request) => mantle.messages.create(request as never) };
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
