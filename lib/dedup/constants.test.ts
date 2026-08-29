import { describe, expect, test } from "vitest";
import { MEMBER_RENDER_LIMIT } from "../domain/message.js";
import {
  DIMENSIONS,
  EMBEDDING_BYTE_LENGTH,
  MAX_BATCH_SIZE,
  MAX_MEMBERS,
  PUBLISH_RENDER_LIMIT,
  SETTLE_DELAY_SECONDS,
  SIMILARITY_THRESHOLD,
  SQS_MAX_DELAY_SECONDS,
} from "./constants.js";

describe("the §6 CONST block (L491-493)", () => {
  test("SIMILARITY_THRESHOLD is 0.85", () => {
    expect(SIMILARITY_THRESHOLD).toBe(0.85);
  });

  test("DIMENSIONS is 1024", () => {
    expect(DIMENSIONS).toBe(1024);
  });

  test("MAX_MEMBERS is 20", () => {
    expect(MAX_MEMBERS).toBe(20);
  });
});

describe("constants §6 references but does not declare", () => {
  test("MAX_BATCH_SIZE is 10, the batch §6 L489 and §7.3 L607 both cap", () => {
    expect(MAX_BATCH_SIZE).toBe(10);
  });

  /** §3.3 L294 and §7.3 L608; §12.4 L886 records 300 s as "a starting value". */
  test("SETTLE_DELAY_SECONDS is 300", () => {
    expect(SETTLE_DELAY_SECONDS).toBe(300);
  });

  /**
   * SQS caps DelaySeconds at 900. §12.4 makes the settle delay configurable, so
   * item 4.1 validates any override against this bound rather than discovering
   * it at deploy time.
   */
  test("the settle delay is within the SQS delay cap", () => {
    expect(SQS_MAX_DELAY_SECONDS).toBe(900);
    expect(SETTLE_DELAY_SECONDS).toBeLessThanOrEqual(SQS_MAX_DELAY_SECONDS);
  });
});

describe("derived values, so the arithmetic is not repeated", () => {
  /** §7.2 L590: 1024 × 4 = 4 KB as DynamoDB Binary, versus ~20 KB as a list. */
  test("a packed embedding is DIMENSIONS x 4 bytes", () => {
    expect(EMBEDDING_BYTE_LENGTH).toBe(4096);
    expect(EMBEDDING_BYTE_LENGTH).toBe(DIMENSIONS * Float32Array.BYTES_PER_ELEMENT);
  });
});

describe("no constant is declared twice", () => {
  /**
   * §3.4 L318 renders 12 of the 20 stored members. The value belongs to the
   * message domain (item 2.6) and is re-exported here rather than restated —
   * two independent literals would drift silently.
   */
  test("PUBLISH_RENDER_LIMIT is the message domain's MEMBER_RENDER_LIMIT", () => {
    expect(PUBLISH_RENDER_LIMIT).toBe(MEMBER_RENDER_LIMIT);
    expect(PUBLISH_RENDER_LIMIT).toBe(12);
  });

  test("the render limit never exceeds the storage cap", () => {
    expect(PUBLISH_RENDER_LIMIT).toBeLessThanOrEqual(MAX_MEMBERS);
  });
});
