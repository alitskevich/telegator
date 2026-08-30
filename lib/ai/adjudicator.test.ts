import { describe, expect, test } from "vitest";
import {
  type AdjudicatorClient,
  createBedrockAdjudicator,
  parseVerdicts,
  VERDICTS_SCHEMA,
} from "./adjudicator";
import { ADJUDICATOR_MAX_TOKENS, ADJUDICATOR_MODEL_ID } from "./constants";
import type { AdjudicationFields, AdjudicationPair } from "./ports";

const response = (verdicts: unknown) => ({
  content: [{ type: "text", text: JSON.stringify({ verdicts }) }],
});

const fields = (title: string): AdjudicationFields => ({
  title,
  entities: ["minsk"],
  tags: ["fire"],
  category: "geopolitics",
  location: "Minsk",
  date: "2026-08-30",
});

const pair = (id: string): AdjudicationPair => ({
  id,
  item: fields("Minsk Factory Fire"),
  candidate: fields("Minsk Plant Blaze"),
});

interface FakeAdjudicatorClient {
  readonly client: AdjudicatorClient;
  readonly requests: Record<string, unknown>[];
}

/**
 * The same hand-injected fake `bedrock.test.ts` uses, and the reason
 * `AdjudicatorClient` is a structural type: the request shape is assertable
 * without a test process constructing an `AnthropicBedrockMantle`, which reads
 * AWS_REGION and resolves a credential chain on construction. No network.
 */
function fakeAdjudicatorClient(respond: () => Promise<unknown>): FakeAdjudicatorClient {
  const requests: Record<string, unknown>[] = [];
  return {
    requests,
    client: {
      create(request) {
        requests.push(request as Record<string, unknown>);
        return respond();
      },
    },
  };
}

describe("parseVerdicts (R46)", () => {
  test("keys verdicts by pair id", () => {
    const parsed = parseVerdicts(
      response([
        { id: "a", same: true },
        { id: "b", same: false },
      ]),
      ["a", "b"],
    );

    expect(parsed.get("a")).toBe(true);
    expect(parsed.get("b")).toBe(false);
  });

  /**
   * `parseEmbeddings` checks its returned count because §6 indexed
   * `embeddings[idx]` against `batch[idx]`, and a short response would silently
   * attach the wrong vector to every later item. A model that answers two of
   * three pairs reintroduces exactly that, so an incomplete verdict set is an
   * error rather than a partial result.
   */
  test("rejects a verdict set that does not cover every requested pair", () => {
    expect(() => parseVerdicts(response([{ id: "a", same: true }]), ["a", "b"])).toThrow(
      /verdict/i,
    );
  });

  test("rejects a verdict for a pair that was never sent", () => {
    expect(() =>
      parseVerdicts(
        response([
          { id: "a", same: true },
          { id: "z", same: true },
        ]),
        ["a"],
      ),
    ).toThrow(/verdict/i);
  });

  test("rejects a duplicated pair id rather than letting the last one win", () => {
    expect(() =>
      parseVerdicts(
        response([
          { id: "a", same: true },
          { id: "a", same: false },
        ]),
        ["a"],
      ),
    ).toThrow(/verdict/i);
  });
});

/**
 * `createBedrockAdjudicator` had no coverage at all, while
 * `createBedrockClassifier` — the adapter it is modelled on — has eleven tests.
 * `AdjudicatorClient` exists precisely so these can be written; nothing used
 * it. As in `bedrock.test.ts`, nothing here asserts what a model returns (R3):
 * every test is about the request put on the wire and the handling of bytes
 * handed back.
 */
describe("createBedrockAdjudicator (R46)", () => {
  test("sends the model id R46's constant names, not the classifier's inline", async () => {
    const fake = fakeAdjudicatorClient(async () => response([{ id: "p1", same: true }]));

    await createBedrockAdjudicator({ client: fake.client }).adjudicate([pair("p1")]);

    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.model).toBe(ADJUDICATOR_MODEL_ID);
  });

  test("bounds the answer with ADJUDICATOR_MAX_TOKENS", async () => {
    const fake = fakeAdjudicatorClient(async () => response([{ id: "p1", same: false }]));

    await createBedrockAdjudicator({ client: fake.client }).adjudicate([pair("p1")]);

    expect(fake.requests[0]?.max_tokens).toBe(ADJUDICATOR_MAX_TOKENS);
  });

  /**
   * §5.2 L423's structured output. Without the schema on the request the model
   * is free to answer in prose, and `parseVerdicts` would reject every batch —
   * a failure that reads as a model fault rather than a missing request field.
   */
  test("asks for structured output against the generated verdict schema", async () => {
    const fake = fakeAdjudicatorClient(async () => response([{ id: "p1", same: true }]));

    await createBedrockAdjudicator({ client: fake.client }).adjudicate([pair("p1")]);

    expect(fake.requests[0]?.output_config).toEqual({
      format: { type: "json_schema", schema: VERDICTS_SCHEMA },
    });
  });

  test("sends every pair it was given, keyed by the caller's ids", async () => {
    const fake = fakeAdjudicatorClient(async () =>
      response([
        { id: "p1", same: true },
        { id: "p2", same: false },
      ]),
    );

    const verdicts = await createBedrockAdjudicator({ client: fake.client }).adjudicate([
      pair("p1"),
      pair("p2"),
    ]);

    const messages = fake.requests[0]?.messages as { role: string; content: string }[];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe("user");
    expect(JSON.parse(String(messages[0]?.content))).toEqual({ pairs: [pair("p1"), pair("p2")] });
    expect(verdicts.get("p1")).toBe(true);
    expect(verdicts.get("p2")).toBe(false);
  });

  /**
   * An empty band is the common case — most batches resolve entirely on the
   * score — and a model call for zero pairs is money spent on nothing, plus a
   * response `parseVerdicts` would have to be taught to accept.
   */
  test("an empty pair list short-circuits without calling the client", async () => {
    const fake = fakeAdjudicatorClient(async () => {
      throw new Error("the client must not be called for an empty band");
    });

    const verdicts = await createBedrockAdjudicator({ client: fake.client }).adjudicate([]);

    expect(fake.requests).toEqual([]);
    expect(verdicts.size).toBe(0);
  });

  /** Constructing the adapter must not resolve a region or a credential chain. */
  test("constructs without a client and without reaching for AWS", () => {
    expect(() => createBedrockAdjudicator()).not.toThrow();
  });
});
