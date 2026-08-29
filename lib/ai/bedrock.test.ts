import type { InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { describe, expect, it } from "vitest";
import { DIMENSIONS } from "../dedup/constants";
import type { ClassificationRequest } from "../pipeline/analyze/index";
import { buildClassificationRequest } from "../pipeline/analyze/index";
import {
  type BedrockInvoker,
  type ClassifierClient,
  createBedrockClassifier,
  createBedrockEmbeddingProvider,
} from "./bedrock";
import { EMBEDDING_INPUT_TYPE, EMBEDDING_MAX_BATCH, EMBEDDING_MODEL_ID } from "./constants";

/**
 * Tests for the two Bedrock adapters (§5.1 L392).
 *
 * R3 — this build cannot reach Bedrock, so nothing here asserts anything about
 * what a model returns. Every test is about the *request shape* the adapter
 * puts on the wire and the *response handling* it applies to bytes handed back
 * to it. The Anthropic client is a hand-injected fake; the Bedrock runtime
 * client is `aws-sdk-client-mock`. No network in either direction.
 */

/** A response that satisfies `NewsItemSchema`; `category` is from §5.4's enum. */
const VALID_ITEM = {
  title: "Minsk metro delay",
  summary: "Кароткае паведамленне пра здарэнне.",
  country: "BY",
  location: "Minsk",
  category: "geopolitics",
  importance: "high",
};

const ITEM_BODY = "Some scraped article body.";

/** The Messages API envelope: the JSON arrives inside a `text` content block. */
function textResponse(payload: unknown): unknown {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

interface FakeClassifierClient {
  readonly client: ClassifierClient;
  readonly requests: ClassificationRequest[];
}

function fakeClassifierClient(
  respond: (request: ClassificationRequest) => Promise<unknown>,
): FakeClassifierClient {
  const requests: ClassificationRequest[] = [];
  return {
    requests,
    client: {
      create(request) {
        requests.push(request);
        return respond(request);
      },
    },
  };
}

function encode(payload: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(payload));
}

/** `InvokeModelCommand.input.body` is a blob union, so narrow before decoding. */
function decode(bytes: unknown): unknown {
  if (!(bytes instanceof Uint8Array)) throw new Error("request carried no byte body");
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** `n` distinct vectors of the right width, so alignment is observable. */
function vectors(count: number, width: number = DIMENSIONS): number[][] {
  return Array.from({ length: count }, (_unused, index) =>
    Array.from({ length: width }, (_value, position) => index + position / width),
  );
}

/**
 * A recording stub for the Bedrock runtime.
 *
 * `aws-sdk-client-mock` cannot be used here: its `mockClient()` signature is
 * built against an older `@smithy/types` than the installed SDK and does not
 * typecheck against it, and 4.1.0 is the latest release. Injecting a structural
 * stub is what the rest of this codebase does anyway.
 */
interface StubInvoker {
  readonly invoker: BedrockInvoker;
  readonly bodies: unknown[];
  readonly modelIds: (string | undefined)[];
  readonly contentTypes: (string | undefined)[];
  readonly callCount: () => number;
}

function stubInvoker(responses: Array<() => Promise<{ body?: Uint8Array }>>): StubInvoker {
  const bodies: unknown[] = [];
  const modelIds: (string | undefined)[] = [];
  const contentTypes: (string | undefined)[] = [];
  let calls = 0;

  return {
    bodies,
    modelIds,
    contentTypes,
    callCount: () => calls,
    invoker: {
      send: async (command: InvokeModelCommand) => {
        modelIds.push(command.input.modelId);
        contentTypes.push(command.input.contentType);
        bodies.push(decode(command.input.body));
        const next = responses[Math.min(calls, responses.length - 1)];
        calls++;
        if (next === undefined) throw new Error("stubInvoker has no scripted response");
        return next();
      },
    },
  };
}

const ok = (payload: unknown) => async () => ({ body: encode(payload) });

describe("createBedrockClassifier", () => {
  it("sends exactly the request buildClassificationRequest produces", async () => {
    const fake = fakeClassifierClient(async () => textResponse(VALID_ITEM));
    const classifier = createBedrockClassifier({ client: fake.client });

    await classifier.classify(ITEM_BODY);

    expect(fake.requests).toEqual([buildClassificationRequest(ITEM_BODY)]);
  });

  it("passes the effort option through to the request builder (R3)", async () => {
    const fake = fakeClassifierClient(async () => textResponse(VALID_ITEM));
    const classifier = createBedrockClassifier({ client: fake.client, effort: false });

    await classifier.classify(ITEM_BODY);

    expect(fake.requests).toEqual([buildClassificationRequest(ITEM_BODY, { effort: false })]);
    expect(fake.requests[0]?.output_config).not.toHaveProperty("effort");
  });

  it("parses a valid response with NewsItemSchema", async () => {
    const fake = fakeClassifierClient(async () => textResponse(VALID_ITEM));
    const classifier = createBedrockClassifier({ client: fake.client });

    await expect(classifier.classify(ITEM_BODY)).resolves.toEqual(VALID_ITEM);
  });

  it("concatenates multiple text blocks before parsing", async () => {
    const json = JSON.stringify(VALID_ITEM);
    const split = Math.floor(json.length / 2);
    const fake = fakeClassifierClient(async () => ({
      content: [
        { type: "text", text: json.slice(0, split) },
        { type: "text", text: json.slice(split) },
      ],
    }));
    const classifier = createBedrockClassifier({ client: fake.client });

    await expect(classifier.classify(ITEM_BODY)).resolves.toEqual(VALID_ITEM);
  });

  it("ignores non-text blocks", async () => {
    const fake = fakeClassifierClient(async () => ({
      content: [
        { type: "thinking", thinking: "…" },
        { type: "text", text: JSON.stringify(VALID_ITEM) },
      ],
    }));
    const classifier = createBedrockClassifier({ client: fake.client });

    await expect(classifier.classify(ITEM_BODY)).resolves.toEqual(VALID_ITEM);
  });

  it("throws when the response violates NewsItemSchema (§3.2 L239)", async () => {
    const fake = fakeClassifierClient(async () =>
      textResponse({ ...VALID_ITEM, category: "not-a-real-category" }),
    );
    const classifier = createBedrockClassifier({ client: fake.client });

    await expect(classifier.classify(ITEM_BODY)).rejects.toThrow();
  });

  it("throws when a required field is missing", async () => {
    const { country: _dropped, ...withoutCountry } = VALID_ITEM;
    const fake = fakeClassifierClient(async () => textResponse(withoutCountry));
    const classifier = createBedrockClassifier({ client: fake.client });

    await expect(classifier.classify(ITEM_BODY)).rejects.toThrow();
  });

  it("throws when the response envelope is not a Messages response", async () => {
    const fake = fakeClassifierClient(async () => ({ nonsense: true }));
    const classifier = createBedrockClassifier({ client: fake.client });

    await expect(classifier.classify(ITEM_BODY)).rejects.toThrow();
  });

  it("throws when the text block is not JSON", async () => {
    const fake = fakeClassifierClient(async () => ({
      content: [{ type: "text", text: "I'm sorry, I can't help with that." }],
    }));
    const classifier = createBedrockClassifier({ client: fake.client });

    await expect(classifier.classify(ITEM_BODY)).rejects.toThrow();
  });

  it("propagates a provider error unchanged (§3.2 L246)", async () => {
    const providerError = new Error("ThrottlingException");
    const fake = fakeClassifierClient(async () => {
      throw providerError;
    });
    const classifier = createBedrockClassifier({ client: fake.client });

    await expect(classifier.classify(ITEM_BODY)).rejects.toBe(providerError);
  });

  it("constructs no client until a call is made", () => {
    expect(() => createBedrockClassifier()).not.toThrow();
  });
});

describe("createBedrockEmbeddingProvider", () => {
  const providerWith = (stub: StubInvoker) =>
    createBedrockEmbeddingProvider({ client: stub.invoker });

  it("sends the §5.3 L461 model id, input_type and texts", async () => {
    const stub = stubInvoker([ok({ embeddings: vectors(2) })]);

    await providerWith(stub).embedBatch(["первый", "другий"], DIMENSIONS);

    expect(stub.callCount()).toBe(1);
    expect(stub.modelIds[0]).toBe(EMBEDDING_MODEL_ID);
    expect(stub.contentTypes[0]).toBe("application/json");
    expect(stub.bodies[0]).toEqual({
      texts: ["первый", "другий"],
      input_type: EMBEDDING_INPUT_TYPE,
    });
  });

  it("returns vectors positionally aligned with the input texts (§6)", async () => {
    const expected = vectors(3);
    const stub = stubInvoker([ok({ embeddings: expected })]);

    const got = await providerWith(stub).embedBatch(["a", "b", "c"], DIMENSIONS);

    expect(got).toEqual(expected);
    expect(got[0]?.[0]).toBe(0);
    expect(got[1]?.[0]).toBe(1);
    expect(got[2]?.[0]).toBe(2);
  });

  it("returns vectors of the requested width", async () => {
    const stub = stubInvoker([ok({ embeddings: vectors(1) })]);

    const got = await providerWith(stub).embedBatch(["a"], DIMENSIONS);

    expect(got[0]).toHaveLength(DIMENSIONS);
  });

  it("throws when the provider returns fewer vectors than texts", async () => {
    const stub = stubInvoker([ok({ embeddings: vectors(2) })]);

    await expect(providerWith(stub).embedBatch(["a", "b", "c"], DIMENSIONS)).rejects.toThrow(
      /3.*2|2.*3/,
    );
  });

  it("throws when a returned vector has the wrong width", async () => {
    const stub = stubInvoker([ok({ embeddings: vectors(1, 768) })]);

    await expect(providerWith(stub).embedBatch(["a"], DIMENSIONS)).rejects.toThrow();
  });

  it("throws when a dimension other than the model's fixed width is requested", async () => {
    const stub = stubInvoker([ok({ embeddings: vectors(1) })]);

    await expect(providerWith(stub).embedBatch(["a"], 768)).rejects.toThrow();
    expect(stub.callCount()).toBe(0);
  });

  it("throws when the response carries no body", async () => {
    const stub = stubInvoker([async () => ({})]);

    await expect(providerWith(stub).embedBatch(["a"], DIMENSIONS)).rejects.toThrow();
  });

  it("throws when the response body is not the Cohere shape", async () => {
    const stub = stubInvoker([ok({ message: "denied" })]);

    await expect(providerWith(stub).embedBatch(["a"], DIMENSIONS)).rejects.toThrow();
  });

  it("propagates a provider error", async () => {
    const stub = stubInvoker([
      async () => {
        throw new Error("AccessDeniedException");
      },
    ]);

    await expect(providerWith(stub).embedBatch(["a"], DIMENSIONS)).rejects.toThrow(
      "AccessDeniedException",
    );
  });

  it("makes no call for an empty input", async () => {
    const stub = stubInvoker([ok({ embeddings: [] })]);

    const got = await providerWith(stub).embedBatch([], DIMENSIONS);

    expect(got).toEqual([]);
    expect(stub.callCount()).toBe(0);
  });

  it("sends §6's ten-item batch in a single call (§5.3 L467)", async () => {
    const stub = stubInvoker([ok({ embeddings: vectors(10) })]);

    await providerWith(stub).embedBatch(
      vectors(10).map((_v, index) => `t${index}`),
      DIMENSIONS,
    );

    expect(stub.callCount()).toBe(1);
  });

  it("chunks at EMBEDDING_MAX_BATCH and keeps the chunks in order", async () => {
    const total = EMBEDDING_MAX_BATCH + 4;
    const all = vectors(total);
    const stub = stubInvoker([
      ok({ embeddings: all.slice(0, EMBEDDING_MAX_BATCH) }),
      ok({ embeddings: all.slice(EMBEDDING_MAX_BATCH) }),
    ]);

    const texts = Array.from({ length: total }, (_v, index) => `t${index}`);
    const got = await providerWith(stub).embedBatch(texts, DIMENSIONS);

    expect(stub.callCount()).toBe(2);
    expect(stub.bodies[0]).toEqual({
      texts: texts.slice(0, EMBEDDING_MAX_BATCH),
      input_type: EMBEDDING_INPUT_TYPE,
    });
    expect(stub.bodies[1]).toEqual({
      texts: texts.slice(EMBEDDING_MAX_BATCH),
      input_type: EMBEDDING_INPUT_TYPE,
    });
    expect(got).toEqual(all);
  });

  it("throws when a chunk comes back short, before returning a misaligned batch", async () => {
    const total = EMBEDDING_MAX_BATCH + 4;
    const all = vectors(total);
    const stub = stubInvoker([
      ok({ embeddings: all.slice(0, EMBEDDING_MAX_BATCH - 1) }),
      ok({ embeddings: all.slice(EMBEDDING_MAX_BATCH) }),
    ]);

    const texts = Array.from({ length: total }, (_v, index) => `t${index}`);

    await expect(providerWith(stub).embedBatch(texts, DIMENSIONS)).rejects.toThrow();
  });

  it("constructs no client until a call is made", () => {
    expect(() => createBedrockEmbeddingProvider()).not.toThrow();
  });
});
