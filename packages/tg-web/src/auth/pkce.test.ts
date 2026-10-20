import { describe, expect, test } from "vitest";
import { base64Url, codeChallenge, newCodeVerifier, newState } from "./pkce";

describe("PKCE (RFC 7636)", () => {
  /** The RFC's own worked example, Appendix B. */
  test("derives the S256 challenge of the RFC's example verifier", async () => {
    await expect(codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).resolves.toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  test("a verifier is in the RFC's alphabet and length", () => {
    const verifier = newCodeVerifier();

    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
  });

  test("two verifiers, or two states, are never the same", () => {
    expect(newCodeVerifier()).not.toBe(newCodeVerifier());
    expect(newState()).not.toBe(newState());
  });

  test("base64url drops padding and the two URL-unsafe characters", () => {
    expect(base64Url(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
  });
});
