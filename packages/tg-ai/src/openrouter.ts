import type { Classifier } from "tg-ai/types";
import { type NewsItem, NewsItemSchema } from "tg-domain/newsItemSchema";
import { buildClassificationRequest } from "./classificationRequest";
import { extractText } from "./messagesContent";
import { createMessagesClient, missingApiKey } from "./openrouterClient";
import type { OpenRouterClassifierOptions } from "./types";

/**
 * The OpenRouter classifier. The client is injectable and built lazily, so
 * constructing the adapter never fetches a secret and tests can import it.
 */

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
