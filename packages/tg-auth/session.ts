import type { Role } from "tg-enums/roles";
import type { IdTokenVerifier, UserStatusReader } from "tg-ports/auth";
import { z } from "zod";
import { hasRole } from "./roles";

const MS_PER_SECOND = 1000;

/**
 * Who is calling, as one verified ID token says. Deliberately not `enabled`:
 * §8.6 rejects a disabled user "at every action", and a flag taken from the
 * token would stay true for the token's whole hour after an operator disables
 * the account it belongs to.
 */
export const SessionSchema = z.object({
  sub: z.string().min(1),
  email: z.string().optional(),
  /** Raw `cognito:groups`, ranked at check time by `hasRole`. */
  roles: z.array(z.string()),
  /** Epoch milliseconds, derived from the ID token's `exp`. */
  expiresAt: z.number(),
});

export type Session = z.infer<typeof SessionSchema>;

/** Why a request was refused. Each value is one of the gates §8.4/§8.6 require. */
export type AuthorizationReason = "unauthenticated" | "disabled" | "forbidden";

export class AuthorizationError extends Error {
  constructor(readonly reason: AuthorizationReason) {
    super(`authorization failed: ${reason}`);
    this.name = "AuthorizationError";
  }
}

/**
 * §8.6 — the browser holds the Cognito ID token and sends it as a bearer
 * credential; this turns it into a session, or `null`.
 *
 * Verification is the whole boundary: the claims decide the role, so a token
 * the verifier rejects — forged, foreign, expired, absent — is an anonymous
 * request rather than an error. Throwing here would turn an edited token into a
 * 500 on every call.
 */
export async function sessionFromIdToken(
  idToken: string | undefined,
  verifier: IdTokenVerifier,
): Promise<Session | null> {
  if (idToken === undefined || idToken === "") return null;

  try {
    const claims = await verifier.verify(idToken);
    return {
      sub: claims.sub,
      ...(claims.email === undefined ? {} : { email: claims.email }),
      roles: claims["cognito:groups"],
      expiresAt: claims.exp * MS_PER_SECOND,
    };
  } catch {
    return null;
  }
}

export interface RequireRoleDeps {
  /** The caller, already verified by `sessionFromIdToken`; `null` when anonymous. */
  readonly session: Session | null;
  readonly status: UserStatusReader;
}

/**
 * The three gates of §8.4 ("every action ... re-checks the caller's role
 * server-side") and §8.6, in order: authenticated, not disabled, ranked at or
 * above `min`.
 *
 * The disabled check is a live read on every call. That is the entire content of
 * "rejected at every action" — an operator who disables a compromised admin has
 * not revoked their token, and expects the next click to fail.
 *
 * §8.6: no branch of this function reads `process.env`, so there is no
 * emulator bypass to find.
 */
export async function requireRole(min: Role, deps: RequireRoleDeps): Promise<Session> {
  const { session } = deps;
  if (session === null) throw new AuthorizationError("unauthenticated");

  const enabled = await deps.status.isEnabled(session.sub);
  if (!enabled) throw new AuthorizationError("disabled");

  if (!hasRole({ roles: session.roles, enabled }, min)) {
    throw new AuthorizationError("forbidden");
  }

  return session;
}
