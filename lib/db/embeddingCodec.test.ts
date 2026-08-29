import { describe, expect, test } from "vitest";
import { DIMENSIONS, EMBEDDING_BYTE_LENGTH } from "../dedup/constants";
import { packEmbedding, unpackEmbedding } from "./embeddingCodec";

/** Builds a view whose byteOffset is 1, i.e. not a multiple of 4. */
const misalign = (bytes: Uint8Array): Uint8Array => {
  const backing = new Uint8Array(bytes.byteLength + 1);
  backing.set(bytes, 1);
  return backing.subarray(1);
};

describe("packEmbedding", () => {
  /** §7.2 L590: 1024 x 4 = 4 KB as DynamoDB Binary, versus ~20 KB as a number list. */
  test("packs a full embedding into exactly 4096 bytes", () => {
    const vector = Array.from({ length: DIMENSIONS }, (_, i) => i / DIMENSIONS);

    expect(packEmbedding(vector).byteLength).toBe(EMBEDDING_BYTE_LENGTH);
  });

  test("packs four bytes per dimension", () => {
    expect(packEmbedding([1, 2, 3]).byteLength).toBe(12);
  });

  test("packs an empty vector to no bytes", () => {
    expect(packEmbedding([]).byteLength).toBe(0);
  });
});

describe("unpackEmbedding", () => {
  test("round-trips values that float32 represents exactly", () => {
    const vector = [0.5, -0.25, 0.125, 0];

    expect(unpackEmbedding(packEmbedding(vector))).toEqual(vector);
  });

  test("round-trips arbitrary values within float32 precision", () => {
    const vector = [0.1, -0.3333333, 0.987654321];
    const restored = unpackEmbedding(packEmbedding(vector));

    for (const [i, value] of vector.entries()) {
      expect(restored[i]).toBeCloseTo(value, 6);
    }
  });

  test("preserves length", () => {
    const vector = Array.from({ length: DIMENSIONS }, () => 0.5);

    expect(unpackEmbedding(packEmbedding(vector))).toHaveLength(DIMENSIONS);
  });

  /**
   * The reason this module exists rather than the two lines of §7.2 L593-596.
   *
   * `new Float32Array(buffer, byteOffset, length)` requires byteOffset to be a
   * multiple of 4. Node pools small Buffers and the AWS SDK hands back views
   * into larger buffers, so a stored embedding read from DynamoDB can arrive at
   * an arbitrary offset — and the spec's literal expression throws RangeError on
   * it. That would fail the aggregate stage on a real record while every test
   * over freshly-packed, offset-0 bytes passed.
   */
  test("the spec's literal expression throws on a misaligned view", () => {
    const bytes = misalign(packEmbedding([1, 2, 3]));

    expect(bytes.byteOffset % Float32Array.BYTES_PER_ELEMENT).not.toBe(0);
    expect(
      () =>
        new Float32Array(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength / Float32Array.BYTES_PER_ELEMENT,
        ),
    ).toThrow(RangeError);
  });

  test("unpacks a misaligned view correctly", () => {
    const vector = [0.5, -0.25, 0.125];

    expect(unpackEmbedding(misalign(packEmbedding(vector)))).toEqual(vector);
  });

  /** The DynamoDB DocumentClient returns Uint8Array; §7.2 L594 types the input as Buffer. */
  test("accepts a Node Buffer as well as a Uint8Array", () => {
    const vector = [0.5, -0.25];
    const buffer = Buffer.from(packEmbedding(vector));

    expect(unpackEmbedding(buffer)).toEqual(vector);
  });

  test("accepts a pooled Buffer, which may itself be misaligned", () => {
    const vector = [0.5, -0.25, 0.125, 1];
    const pooled = Buffer.alloc(packEmbedding(vector).byteLength);
    pooled.set(packEmbedding(vector));

    expect(unpackEmbedding(pooled)).toEqual(vector);
  });

  test("rejects a byte length that is not a whole number of float32s", () => {
    expect(() => unpackEmbedding(new Uint8Array(5))).toThrow();
  });

  test("unpacks empty bytes to an empty vector", () => {
    expect(unpackEmbedding(new Uint8Array(0))).toEqual([]);
  });

  test("does not alias the input buffer, so a later write cannot corrupt the vector", () => {
    const bytes = packEmbedding([0.5, 0.25]);
    const restored = unpackEmbedding(bytes);
    bytes.fill(0);

    expect(restored).toEqual([0.5, 0.25]);
  });
});
