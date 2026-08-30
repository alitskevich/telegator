import { describe, expect, test } from "vitest";
import { parseVerdicts } from "./adjudicator";

const response = (verdicts: unknown) => ({
  content: [{ type: "text", text: JSON.stringify({ verdicts }) }],
});

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
