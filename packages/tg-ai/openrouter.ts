import type { Classifier } from "tg-ai/types";
import { type NewsItem, NewsItemSchema } from "tg-domain/newsItemSchema";
import {
  buildClassificationRequest,
  type ClassificationRequest,
  type ClassificationRequestOptions,
} from "./classificationRequest";
import { extractText } from "./messagesContent";
import { type ApiKeyProvider, createMessagesClient, missingApiKey } from "./openrouterClient";

/**
 * The OpenRouter classifier. The client is injectable and built lazily, so
 * constructing the adapter never fetches a secret and tests can import it.
 */

/** Kept as a named export because the tests inject against exactly this shape. */
export interface ClassifierClient {
  create(request: ClassificationRequest): Promise<unknown>;
}

export interface OpenRouterClassifierOptions {
  readonly client?: ClassifierClient;
  /** Reads the key from the function secret; supplied by `tg-functions/index.ts`. */
  readonly apiKey?: ApiKeyProvider;
  /** `false` omits `output_config.effort` entirely. */
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

      const request = buildClassificationRequest(
        body,
        options.effort === undefined ? {} : { effort: options.effort },
      );

      const response = await client.create(request);

      // Validated here, so a bad response retries like a provider error instead
      // of putting an unvalidated category on the aggregate queue.
      return NewsItemSchema.parse(JSON.parse(extractText(response, "openrouter")));
    },
  };
}
