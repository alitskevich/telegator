import {
  buildClassificationRequest,
  type ClassificationRequest,
  type ClassificationRequestOptions,
} from "../pipeline/analyze/index";
import { extractText } from "./messagesContent";
import { type NewsItem, NewsItemSchema } from "./newsItemSchema";
import { type ApiKeyProvider, createMessagesClient, missingApiKey } from "./openrouterClient";
import type { Classifier } from "./ports";

/**
 * The OpenRouter adapter (§5.1 — "Decision: OpenRouter", as revised by R50).
 *
 * Classification goes through the Anthropic-compatible Messages API OpenRouter
 * serves (§5.1). The client is injectable and built lazily, so constructing an
 * adapter never fetches a secret — which is what lets this module be imported
 * in a test process at all.
 *
 * R3: nothing here asserts or assumes anything about what a model returns. The
 * adapter's job is the request shape and the handling of bytes handed back.
 *
 * R43 — §5.3's embedding adapter is removed entirely; dedup no longer calls a
 * model at all except for R46's adjudicator, which goes through the same
 * Messages API as classification.
 *
 * R50 — this file was `bedrock.ts`. The request shape did not change with the
 * provider: only where the client points and how it authenticates did.
 */

/** Kept as a named export because the tests inject against exactly this shape. */
export interface ClassifierClient {
  create(request: ClassificationRequest): Promise<unknown>;
}

export interface OpenRouterClassifierOptions {
  readonly client?: ClassifierClient;
  /** §7.6 — reads the key from Secrets Manager; supplied by `handlers/analyze.ts`. */
  readonly apiKey?: ApiKeyProvider;
  /** R3 — `false` omits `output_config.effort` entirely. */
  readonly effort?: ClassificationRequestOptions["effort"];
}

export function createOpenRouterClassifier(options: OpenRouterClassifierOptions = {}): Classifier {
  let client = options.client;

  return {
    classify: async (body: string): Promise<NewsItem> => {
      if (client === undefined) {
        if (options.apiKey === undefined) throw missingApiKey("the classifier");
        client = await createMessagesClient(options.apiKey);
      }

      // The request shape is item 3.7's, reused rather than rebuilt, so §5.2's
      // contract has one definition.
      const request = buildClassificationRequest(
        body,
        options.effort === undefined ? {} : { effort: options.effort },
      );

      const response = await client.create(request);

      // Validated here rather than downstream: §3.2 L239 sends a provider error
      // back through SQS retry to the DLQ, and a response that violates the
      // schema is the same class of event. Letting it through would put an
      // unvalidated category into the aggregate queue.
      return NewsItemSchema.parse(JSON.parse(extractText(response, "openrouter")));
    },
  };
}
