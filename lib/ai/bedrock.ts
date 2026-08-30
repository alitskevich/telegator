import {
  buildClassificationRequest,
  type ClassificationRequest,
  type ClassificationRequestOptions,
} from "../pipeline/analyze/index";
import { type NewsItem, NewsItemSchema } from "./newsItemSchema";
import type { Classifier } from "./ports";

/**
 * The Bedrock adapter (§5.1 L392 — "Decision: Amazon Bedrock").
 *
 * Classification goes through the Anthropic Messages API (§5.1 L394–396). It is
 * injectable and built lazily, so constructing an adapter never reaches for
 * credentials — which is what lets this module be imported in a test process at
 * all.
 *
 * R3: nothing here asserts or assumes anything about what a model returns. The
 * adapter's job is the request shape and the handling of bytes handed back.
 *
 * R43 — §5.3's embedding adapter (the raw Bedrock runtime, Cohere
 * `embed-multilingual-v3`) is removed entirely; dedup no longer calls a model
 * at all except for R46's adjudicator, which goes through the same Mantle API
 * as classification.
 */

/**
 * The slice of the Anthropic client this adapter uses.
 *
 * A structural type rather than the SDK class: it keeps the fake in the tests
 * honest (it must satisfy the same shape the real client does) without the test
 * process constructing an `AnthropicBedrockMantle`, which reads AWS_REGION and
 * resolves a credential chain on construction.
 */
export interface ClassifierClient {
  create(request: ClassificationRequest): Promise<unknown>;
}

export interface BedrockClassifierOptions {
  readonly client?: ClassifierClient;
  /** R3 — `false` omits `output_config.effort` entirely. */
  readonly effort?: ClassificationRequestOptions["effort"];
}

/** A Messages response carries the model's JSON inside one or more text blocks. */
function extractText(response: unknown): string {
  if (typeof response !== "object" || response === null || !("content" in response)) {
    throw new Error("bedrock returned no Messages content block");
  }

  const { content } = response as { content: unknown };
  if (!Array.isArray(content)) {
    throw new Error("bedrock returned a non-array content field");
  }

  // Concatenated rather than "first block wins": a long structured output can be
  // split across blocks, and taking only the first would truncate the JSON into
  // a parse error that looks like a model fault.
  const text = content
    .filter(
      (block): block is { type: string; text: string } =>
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        (block as { type: unknown }).type === "text" &&
        typeof (block as { text: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("");

  if (text === "") throw new Error("bedrock returned no text content");
  return text;
}

export function createBedrockClassifier(options: BedrockClassifierOptions = {}): Classifier {
  let client = options.client;

  return {
    classify: async (body: string): Promise<NewsItem> => {
      if (client === undefined) {
        // Imported lazily so the module can be loaded without the SDK resolving
        // a region or a credential chain.
        const { AnthropicBedrockMantle } = await import("@anthropic-ai/bedrock-sdk");
        // AWS_REGION is a reserved Lambda variable: read, never declared (§5.1 L396).
        const mantle = new AnthropicBedrockMantle({ awsRegion: process.env.AWS_REGION });
        client = { create: (request) => mantle.messages.create(request as never) };
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
      return NewsItemSchema.parse(JSON.parse(extractText(response)));
    },
  };
}
