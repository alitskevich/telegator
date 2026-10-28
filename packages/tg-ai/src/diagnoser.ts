import { DIAGNOSER_MAX_TOKENS, DIAGNOSER_MODEL_ID } from "tg-configs/ai";
import { type ErrorDiagnosis, ErrorDiagnosisSchema } from "tg-domain/ingest";
import { z } from "zod";
import { extractText } from "./messagesContent";
import { createMessagesClient, missingApiKey } from "./openrouterClient";
import type { Diagnoser, OpenRouterDiagnoserOptions } from "./types";

/**
 * Reads one failed `ingest` item and proposes a fix: the model call behind the
 * console's *Analyse*. Built like `createOpenRouterAdjudicator`, with a lazy
 * client so construction never fetches a secret.
 */

/** Sent as `output_config.format.schema`, generated from the stored shape. */
export const DIAGNOSIS_SCHEMA = z.toJSONSchema(ErrorDiagnosisSchema);

export const parseDiagnosis = (response: unknown): ErrorDiagnosis =>
  ErrorDiagnosisSchema.parse(JSON.parse(extractText(response, "diagnoser")));

const SYSTEM_PROMPT =
  "You support the operator of Telegator, a news pipeline on Firebase: scrape " +
  "(Telegram over MTProto) feeds analyze (a model classifies each post), " +
  "which feeds aggregate (dedup into stories in Firestore), which feeds publish (the " +
  "Telegram Bot API posts to target channels). One item failed every attempt of a stage. " +
  "From its stage, error, cause and payload, say what went wrong, the most likely root " +
  "cause, and one concrete fix: an operator step (run it again, edit a source or a target, " +
  "rotate a secret), a data change, or a code change naming the likely file. Be brief and " +
  "specific, and say so when the evidence is not enough.";

export function createOpenRouterDiagnoser(options: OpenRouterDiagnoserOptions = {}): Diagnoser {
  let client = options.client;

  return {
    diagnose: async (report) => {
      if (client === undefined) {
        if (options.apiKey === undefined) throw missingApiKey("the diagnoser");
        client = await createMessagesClient(options.apiKey);
      }

      const response = await client.create({
        model: DIAGNOSER_MODEL_ID,
        max_tokens: DIAGNOSER_MAX_TOKENS,
        system: SYSTEM_PROMPT,
        output_config: { format: { type: "json_schema", schema: DIAGNOSIS_SCHEMA } },
        messages: [{ role: "user", content: JSON.stringify(report) }],
      });
      return parseDiagnosis(response);
    },
  };
}
