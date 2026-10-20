import { describe, expect, test } from "vitest";
import { parseMtprotoCredentials } from "./credentials";

const valid = { apiId: 12345, apiHash: "0123456789abcdef0123456789abcdef", session: "1AgAOMTQ5" };

describe("parseMtprotoCredentials", () => {
  test("parses the secret's JSON", () => {
    expect(parseMtprotoCredentials(JSON.stringify(valid))).toEqual(valid);
  });

  test("names the bad field and never echoes the session", () => {
    const secret = JSON.stringify({ ...valid, apiHash: "nope", session: "" });

    expect(() => parseMtprotoCredentials(secret)).toThrow("malformed at: apiHash, session");
    expect(() => parseMtprotoCredentials("1AgAOMTQ5 not json")).toThrow(
      /^the MTProto secret is not JSON/,
    );
    try {
      parseMtprotoCredentials("1AgAOMTQ5 not json");
    } catch (error) {
      expect(String(error)).not.toContain("1AgAOMTQ5");
    }
  });
});
