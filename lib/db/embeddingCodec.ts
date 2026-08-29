const BYTES_PER_FLOAT = Float32Array.BYTES_PER_ELEMENT;

/**
 * §7.2 L590 — `Float32Array` → raw bytes → DynamoDB **Binary**. 1024 × 4 = 4 KB,
 * versus ~20 KB as a list of numbers.
 *
 * The spec sketches this in two lines (L593–596). Both need hardening before
 * they meet real data, which is why this is a module rather than an inline pair:
 *
 *  - `new Float32Array(buffer, byteOffset, length)` requires `byteOffset` to be a
 *    multiple of 4. Node pools small Buffers and the AWS SDK returns views into
 *    larger buffers, so bytes read back from DynamoDB can arrive at any offset —
 *    and the literal expression throws `RangeError` on them. Tests over
 *    freshly-packed, offset-0 bytes would never notice.
 *  - the sketch types the input as `Buffer`, but the DynamoDB DocumentClient
 *    hands back a plain `Uint8Array`.
 *
 * The round trip is lossy by design: float64 in, float32 stored, so
 * `unpack(pack(v))` equals `v` only to float32 precision. Assertions on
 * embeddings must compare with tolerance, or compare after a round trip on both
 * sides.
 */
export function packEmbedding(vector: readonly number[]): Uint8Array {
  // `new Float32Array(vector)` allocates a fresh, aligned buffer of exactly
  // 4 × length bytes, so the view below covers it completely.
  return new Uint8Array(new Float32Array(vector).buffer);
}

export function unpackEmbedding(bytes: Uint8Array): number[] {
  if (bytes.byteLength % BYTES_PER_FLOAT !== 0) {
    throw new Error(`embedding of ${bytes.byteLength} bytes is not a whole number of float32s`);
  }

  // Copy into a fresh buffer when the view does not start on a 4-byte boundary.
  // `new Uint8Array(typedArray)` copies the elements, giving byteOffset 0.
  const aligned = bytes.byteOffset % BYTES_PER_FLOAT === 0 ? bytes : new Uint8Array(bytes);

  return Array.from(
    new Float32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / BYTES_PER_FLOAT),
  );
}
