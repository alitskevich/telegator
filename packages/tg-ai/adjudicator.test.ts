import type { AdjudicationFields, AdjudicationPair } from "tg-ai/types";
import { ADJUDICATOR_MAX_TOKENS, ADJUDICATOR_MODEL_ID } from "tg-configs/ai";
import { describe, expect, test } from "vitest";
import {
  type AdjudicatorClient,
  createOpenRouterAdjudicator,
  parseVerdicts,
  VERDICTS_SCHEMA,
} from "./adjudicator";

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
 * A hand-injected fake, as in `openrouter.test.ts`: the request shape is
 * checked without constructing a real client, which demands an API key.
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

describe("parseVerdicts", () => {
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

  /** A model that answers two of three pairs must fail, not decide the third by omission. */
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

/** As in `openrouter.test.ts`: only the request sent and the response handling are tested. */
describe("createOpenRouterAdjudicator", () => {
  test("sends ADJUDICATOR_MODEL_ID, not the classifier's model inline", async () => {
    const fake = fakeAdjudicatorClient(async () => response([{ id: "p1", same: true }]));

    await createOpenRouterAdjudicator({ client: fake.client }).adjudicate([pair("p1")]);

    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.model).toBe(ADJUDICATOR_MODEL_ID);
  });

  test("bounds the answer with ADJUDICATOR_MAX_TOKENS", async () => {
    const fake = fakeAdjudicatorClient(async () => response([{ id: "p1", same: false }]));

    await createOpenRouterAdjudicator({ client: fake.client }).adjudicate([pair("p1")]);

    expect(fake.requests[0]?.max_tokens).toBe(ADJUDICATOR_MAX_TOKENS);
  });

  /** Without the schema the model may answer in prose, and `parseVerdicts` would reject it. */
  test("asks for structured output against the generated verdict schema", async () => {
    const fake = fakeAdjudicatorClient(async () => response([{ id: "p1", same: true }]));

    await createOpenRouterAdjudicator({ client: fake.client }).adjudicate([pair("p1")]);

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

    const verdicts = await createOpenRouterAdjudicator({ client: fake.client }).adjudicate([
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

  /** An empty band is the common case; a model call for zero pairs is wasted money. */
  test("an empty pair list short-circuits without calling the client", async () => {
    const fake = fakeAdjudicatorClient(async () => {
      throw new Error("the client must not be called for an empty band");
    });

    const verdicts = await createOpenRouterAdjudicator({ client: fake.client }).adjudicate([]);

    expect(fake.requests).toEqual([]);
    expect(verdicts.size).toBe(0);
  });

  /** Constructing the adapter must not fetch a key. */
  test("constructs without a client and without reaching for a key", () => {
    expect(() => createOpenRouterAdjudicator()).not.toThrow();
  });

  test("names the missing key provider rather than failing inside the SDK", async () => {
    await expect(createOpenRouterAdjudicator().adjudicate([pair("p1")])).rejects.toThrow(
      /OpenRouter API key/,
    );
  });
});
