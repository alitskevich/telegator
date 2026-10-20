/**
 * RFC 7636 — Proof Key for Code Exchange, S256.
 *
 * The console is a public client: anything it ships, a visitor can read, so it
 * holds no secret. PKCE binds the authorization code to the tab that asked for
 * it instead — the code is useless without the verifier, and the verifier
 * never leaves this tab's `sessionStorage`.
 */

/** RFC 7636 §4.1 allows 43–128 characters; 64 random bytes encode to 86. */
const VERIFIER_BYTES = 64;

/** `state` only has to be unguessable and single-use. */
const STATE_BYTES = 32;

/** Base64url without padding (RFC 4648 §5), as both PKCE and JWTs spell it. */
export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const randomToken = (size: number): string =>
  base64Url(crypto.getRandomValues(new Uint8Array(size)));

export const newCodeVerifier = (): string => randomToken(VERIFIER_BYTES);

export const newState = (): string => randomToken(STATE_BYTES);

/** `BASE64URL(SHA256(ASCII(code_verifier)))` — RFC 7636 §4.2. */
export async function codeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}
