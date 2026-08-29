import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { DIMENSIONS } from "../dedup/constants.js";
import {
  buildClassificationRequest,
  type ClassificationRequest,
  type ClassificationRequestOptions,
} from "../pipeline/analyze/index.js";
import { EMBEDDING_INPUT_TYPE, EMBEDDING_MAX_BATCH, EMBEDDING_MODEL_ID } from "./constants.js";
import { type NewsItem, NewsItemSchema } from "./newsItemSchema.js";
import type { Classifier, EmbeddingProvider } from "./ports.js";

/**
 * The Bedrock adapters (§5.1 L392 — "Decision: Amazon Bedrock").
 *
 * Two different clients, because §5 uses two different services: classification
 * goes through the Anthropic Messages API (§5.1 L394–396) and embeddings through
 * the raw Bedrock runtime (§5.3 L461). Both are injectable and both are built
 * lazily, so constructing an adapter never reaches for credentials — which is
 * what lets these modules be imported in a test process at all.
 *
 * R3: nothing here asserts or assumes anything about what a model returns. The
 * adapter's job is the request shape and the handling of bytes handed back.
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

/**
 * The slice of the Bedrock runtime client this adapter uses.
 *
 * Structural, like `ClassifierClient` above, and for the same reason: a test
 * supplies a plain object rather than constructing a real client. It also lets
 * the tests drop `aws-sdk-client-mock`, whose `mockClient()` signature is built
 * against an older `@smithy/types` than the installed SDK and does not
 * typecheck against it — and there is no newer release.
 */
export interface BedrockInvokeResponse {
  readonly body?: Uint8Array | undefined;
}

export interface BedrockInvoker {
  send(command: InvokeModelCommand): Promise<BedrockInvokeResponse>;
}

export interface BedrockEmbeddingOptions {
  readonly client?: BedrockInvoker;
}

function parseEmbeddings(payload: Uint8Array | undefined, expected: number): number[][] {
  if (payload === undefined) throw new Error("bedrock returned no response body");

  const decoded: unknown = JSON.parse(new TextDecoder().decode(payload));
  if (typeof decoded !== "object" || decoded === null || !("embeddings" in decoded)) {
    throw new Error("bedrock returned no embeddings field");
  }

  const { embeddings } = decoded as { embeddings: unknown };
  if (!Array.isArray(embeddings)) throw new Error("bedrock returned a non-array embeddings field");

  // §6 indexes `embeddings[idx]` against `batch[idx]`, so a short or misaligned
  // response would silently attach the wrong vector to every subsequent item —
  // a dedup fault with no error anywhere. Checked per chunk, before any of it is
  // returned.
  if (embeddings.length !== expected) {
    throw new Error(`expected ${expected} embeddings, received ${embeddings.length}`);
  }

  return embeddings.map((vector) => {
    if (!Array.isArray(vector) || vector.some((value) => typeof value !== "number")) {
      throw new Error("bedrock returned a non-numeric embedding");
    }
    if (vector.length !== DIMENSIONS) {
      throw new Error(`expected ${DIMENSIONS}-dimensional vectors, received ${vector.length}`);
    }
    return vector;
  });
}

export function createBedrockEmbeddingProvider(
  options: BedrockEmbeddingOptions = {},
): EmbeddingProvider {
  let client = options.client;

  return {
    embedBatch: async (texts: readonly string[], dimensions: number): Promise<number[][]> => {
      // §5.3 L461 fixes the model at 1024 dimensions. Refusing any other width
      // here rather than passing it along means a mismatch fails at the call
      // site instead of producing vectors §5.3 L465 says "are not comparable at
      // all" to the ones already stored.
      if (dimensions !== DIMENSIONS) {
        throw new Error(
          `${EMBEDDING_MODEL_ID} embeds at ${DIMENSIONS} dimensions, not ${dimensions}`,
        );
      }

      if (texts.length === 0) return [];

      client ??= new BedrockRuntimeClient({});

      const results: number[][] = [];
      // §5.3 L467 — Cohere accepts up to 96 texts per call, and §6's batch of 10
      // fits in one. Chunked anyway: the calibration harness of §11.3 embeds a
      // labelled set far larger than a queue batch.
      for (let start = 0; start < texts.length; start += EMBEDDING_MAX_BATCH) {
        const chunk = texts.slice(start, start + EMBEDDING_MAX_BATCH);
        const response = await client.send(
          new InvokeModelCommand({
            modelId: EMBEDDING_MODEL_ID,
            contentType: "application/json",
            accept: "application/json",
            // `body` is a blob on InvokeModel, so it is encoded rather than passed
            // as a string — the SDK would otherwise coerce it for us and the wire
            // shape would depend on that coercion.
            body: new TextEncoder().encode(
              JSON.stringify({ texts: chunk, input_type: EMBEDDING_INPUT_TYPE }),
            ),
          }),
        );
        results.push(...parseEmbeddings(response.body, chunk.length));
      }

      return results;
    },
  };
}
