import { z } from "zod";

/**
 * The boundaries of §8.6's Cognito sign-in, as the API sees it. Each is an
 * interface with an in-memory fake because every one of them is a network call,
 * and no test in this build touches the network.
 */

/**
 * The claims the API reads from a verified ID token. Cognito sends more; this is
 * the subset authorisation depends on, so an unexpected claim cannot quietly
 * become an input to a role decision.
 */
export const IdTokenClaimsSchema = z.object({
  sub: z.string().min(1),
  email: z.string().optional(),
  /** Cognito's group claim — arbitrary strings. `tg-auth/roles.ts` ranks them. */
  "cognito:groups": z.array(z.string()).default([]),
  /** Seconds since the epoch, per RFC 7519. The session's expiry is derived from it. */
  exp: z.number(),
});

export type IdTokenClaims = z.infer<typeof IdTokenClaimsSchema>;

/** Verifies an ID token's signature, issuer, audience and expiry. Throws if invalid. */
export interface IdTokenVerifier {
  verify(idToken: string): Promise<IdTokenClaims>;
}

/**
 * §8.6 — "a new user is created **disabled** ... a disabled user is rejected at
 * every action".
 *
 * A port rather than a token claim, because the whole point of the rule is that
 * it takes effect for a caller who is already signed in. Anything read from the
 * token would leave a disabled operator working until it expired.
 */
export interface UserStatusReader {
  isEnabled(sub: string): Promise<boolean>;
}
