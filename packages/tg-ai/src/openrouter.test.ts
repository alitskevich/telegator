import { describe, expect, it } from "vitest";

import { buildClassificationRequest } from "./classificationRequest";
import { createOpenRouterClassifier } from "./openrouter";
import type { ClassificationRequest, ClassifierClient } from "./types";

/**
 * Tests for the OpenRouter classifier adapter. Nothing here asserts what a
 * model returns: only the *request shape* and the *response handling*. The
 * Messages client is a hand-injected fake.
 */

/** A response that satisfies `NewsItemSchema`; `category` is from the category enum. */
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

describe("createOpenRouterClassifier", () => {
  it("sends exactly the request buildClassificationRequest produces", async () => {
    const fake = fakeClassifierClient(async () => textResponse(VALID_ITEM));
    const classifier = createOpenRouterClassifier({ client: fake.client });

    await classifier.classify(ITEM_BODY);

    expect(fake.requests).toEqual([buildClassificationRequest(ITEM_BODY)]);
  });

  it("passes the effort option through to the request builder", async () => {
    const fake = fakeClassifierClient(async () => textResponse(VALID_ITEM));
    const classifier = createOpenRouterClassifier({ client: fake.client, effort: false });

    await classifier.classify(ITEM_BODY);

    expect(fake.requests).toEqual([buildClassificationRequest(ITEM_BODY, { effort: false })]);
    expect(fake.requests[0]?.output_config).not.toHaveProperty("effort");
  });

  it("parses a valid response with NewsItemSchema", async () => {
    const fake = fakeClassifierClient(async () => textResponse(VALID_ITEM));
    const classifier = createOpenRouterClassifier({ client: fake.client });

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
    const classifier = createOpenRouterClassifier({ client: fake.client });

    await expect(classifier.classify(ITEM_BODY)).resolves.toEqual(VALID_ITEM);
  });

  it("ignores non-text blocks", async () => {
    const fake = fakeClassifierClient(async () => ({
      content: [
        { type: "thinking", thinking: "…" },
        { type: "text", text: JSON.stringify(VALID_ITEM) },
      ],
    }));
    const classifier = createOpenRouterClassifier({ client: fake.client });

    await expect(classifier.classify(ITEM_BODY)).resolves.toEqual(VALID_ITEM);
  });

  it("throws when the response violates NewsItemSchema", async () => {
    const fake = fakeClassifierClient(async () =>
      textResponse({ ...VALID_ITEM, category: "not-a-real-category" }),
    );
    const classifier = createOpenRouterClassifier({ client: fake.client });

    await expect(classifier.classify(ITEM_BODY)).rejects.toThrow();
  });

  it("throws when a required field is missing", async () => {
    const { country: _dropped, ...withoutCountry } = VALID_ITEM;
    const fake = fakeClassifierClient(async () => textResponse(withoutCountry));
    const classifier = createOpenRouterClassifier({ client: fake.client });

    await expect(classifier.classify(ITEM_BODY)).rejects.toThrow();
  });

  it("throws when the response envelope is not a Messages response", async () => {
    const fake = fakeClassifierClient(async () => ({ nonsense: true }));
    const classifier = createOpenRouterClassifier({ client: fake.client });

    await expect(classifier.classify(ITEM_BODY)).rejects.toThrow();
  });

  it("throws when the text block is not JSON", async () => {
    const fake = fakeClassifierClient(async () => ({
      content: [{ type: "text", text: "I'm sorry, I can't help with that." }],
    }));
    const classifier = createOpenRouterClassifier({ client: fake.client });

    await expect(classifier.classify(ITEM_BODY)).rejects.toThrow();
  });

  it("propagates a provider error unchanged", async () => {
    const providerError = new Error("ThrottlingException");
    const fake = fakeClassifierClient(async () => {
      throw providerError;
    });
    const classifier = createOpenRouterClassifier({ client: fake.client });

    await expect(classifier.classify(ITEM_BODY)).rejects.toBe(providerError);
  });

  it("constructs no client until a call is made", () => {
    expect(() => createOpenRouterClassifier()).not.toThrow();
  });

  /** A missing key is a wiring fault; naming it saves retries that hide the cause. */
  it("names the missing key provider rather than failing inside the SDK", async () => {
    await expect(createOpenRouterClassifier().classify(ITEM_BODY)).rejects.toThrow(
      /OpenRouter API key/,
    );
  });

  it("does not reach for a key when a client is injected", async () => {
    const fake = fakeClassifierClient(async () => textResponse(VALID_ITEM));

    await expect(
      createOpenRouterClassifier({ client: fake.client }).classify(ITEM_BODY),
    ).resolves.toEqual(VALID_ITEM);
  });
});
