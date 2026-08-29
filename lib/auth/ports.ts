import { z } from "zod";

/**
 * The boundaries of §8.6 L780's Cognito hosted UI. Each is an interface with an
 * in-memory fake because every one of them is a network call, and no test in
 * this build touches the network.
 */

/**
 * The claims the dashboard reads from a verified ID token. Cognito sends more;
 * this is the subset authorisation depends on, so an unexpected claim cannot
 * quietly become an input to a role decision.
 */
export const IdTokenClaimsSchema = z.object({
  sub: z.string().min(1),
  email: z.string().optional(),
  /** Cognito's group claim — arbitrary strings. `lib/auth/roles.ts` ranks them. */
  "cognito:groups": z.array(z.string()).default([]),
  /** Seconds since the epoch, per RFC 7519. The session's expiry is derived from it. */
  exp: z.number(),
});

export type IdTokenClaims = z.infer<typeof IdTokenClaimsSchema>;

/** An OIDC token response from the Cognito `/oauth2/token` endpoint. */
export interface TokenSet {
  readonly idToken: string;
  readonly accessToken: string;
  readonly refreshToken?: string;
  readonly expiresIn: number;
}

/** §8.2 L722 — `api/auth/[...]/route.ts`, the authorization-code exchange. */
export interface TokenEndpoint {
  exchangeAuthorizationCode(code: string, redirectUri: string): Promise<TokenSet>;
}

/** Verifies an ID token's signature, issuer, audience and expiry. Throws if invalid. */
export interface IdTokenVerifier {
  verify(idToken: string): Promise<IdTokenClaims>;
}

/**
 * §8.6 L788 — "a new user is created **disabled** ... a disabled user is
 * rejected at every action".
 *
 * A port rather than a cookie field, because the whole point of the rule is that
 * it takes effect for a session that is already signed in. Anything cached at
 * sign-in would leave a disabled operator working until their token expired.
 */
export interface UserStatusReader {
  isEnabled(sub: string): Promise<boolean>;
}

export interface CookieOptions {
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: "lax" | "strict" | "none";
  readonly path: string;
  readonly maxAge?: number;
}

/**
 * The subset of Next's cookie store this uses. Narrow on purpose: `cookies()`
 * is request-scoped and async, and injecting it keeps the session logic testable
 * without a request.
 */
export interface CookieJar {
  get(name: string): string | undefined;
  set(name: string, value: string, options: CookieOptions): void;
  delete(name: string): void;
}
