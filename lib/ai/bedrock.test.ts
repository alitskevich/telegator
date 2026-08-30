import { describe, expect, it } from "vitest";
import type { ClassificationRequest } from "../pipeline/analyze/index";
import { buildClassificationRequest } from "../pipeline/analyze/index";
import { type ClassifierClient, createBedrockClassifier } from "./bedrock";

/**
 * Tests for the Bedrock classifier adapter (§5.1 L392).
 *
 * R3 — this build cannot reach Bedrock, so nothing here asserts anything about
 * what a model returns. Every test is about the *request shape* the adapter
 * puts on the wire and the *response handling* it applies to bytes handed back
 * to it. The Anthropic client is a hand-injected fake. No network involved.
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
