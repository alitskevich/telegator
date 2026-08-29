import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import type { Clock } from "../clock.js";
import type {
  CookieJar,
  CookieOptions,
  IdTokenVerifier,
  TokenEndpoint,
  UserStatusReader,
} from "./ports.js";
import { hasRole, type Role } from "./roles.js";

export const SESSION_COOKIE = "telegator_session";

/** AES-256-GCM, in the sizes the algorithm fixes. */
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

const MS_PER_SECOND = 1000;

/**
 * What the cookie carries. Deliberately not `enabled`: §8.6 L788 rejects a
 * disabled user "at every action", and a flag written at sign-in would go stale
 * the moment an operator disables the account it belongs to.
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

export function newSessionKey(): Uint8Array {
  return randomBytes(KEY_BYTES);
}

/**
 * Seal a session into a cookie value.
 *
 * Authenticated encryption, not a signature: the cookie travels through a
 * browser that can read and edit it, and GCM's tag makes a forged or flipped
 * byte unopenable rather than merely wrong. A fresh IV per seal means two
 * identical sessions do not produce the same cookie.
 */
export function sealSession(session: Session, key: Uint8Array): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(session), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

/** Open a cookie value, or `null` if it is missing, malformed, forged or foreign. */
export function unsealSession(cookie: string, key: Uint8Array): Session | null {
  try {
    const raw = Buffer.from(cookie, "base64url");
    if (raw.length <= IV_BYTES + TAG_BYTES) return null;

    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, IV_BYTES));
    decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));

    const plaintext = Buffer.concat([
      decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
      decipher.final(),
    ]).toString("utf8");

    return SessionSchema.parse(JSON.parse(plaintext));
  } catch {
    // A bad cookie is an unauthenticated request, not a server error. Throwing
    // here would turn an edited cookie into a 500 on every page.
    return null;
  }
}

/**
 * §8.6 L780 puts an operator console behind Cognito. `httpOnly` because an XSS
 * here would otherwise lift an admin session; `secure` because the session is a
 * bearer credential; `lax` because the hosted UI returns by top-level
 * navigation, which `strict` would strip the cookie from.
 */
function cookieOptions(maxAgeSeconds: number): CookieOptions {
  return { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: maxAgeSeconds };
}

export interface StartSessionDeps {
  readonly tokens: TokenEndpoint;
  readonly verifier: IdTokenVerifier;
  readonly jar: CookieJar;
  readonly key: Uint8Array;
  readonly clock: Clock;
}

/**
 * Exchange a hosted-UI authorization code for a session cookie.
 *
 * The session expires exactly when the ID token does — an interval this module
 * derives rather than invents, so a session can never outlive the identity that
 * minted it.
 */
export async function startSession(
  code: string,
  redirectUri: string,
  deps: StartSessionDeps,
): Promise<Session> {
  const tokenSet = await deps.tokens.exchangeAuthorizationCode(code, redirectUri);
  // Verification first: nothing is written for a token that fails it.
  const claims = await deps.verifier.verify(tokenSet.idToken);

  const session: Session = {
    sub: claims.sub,
    ...(claims.email === undefined ? {} : { email: claims.email }),
    roles: claims["cognito:groups"],
    expiresAt: claims.exp * MS_PER_SECOND,
  };

  const maxAge = Math.max(0, Math.floor((session.expiresAt - deps.clock.now()) / MS_PER_SECOND));
  deps.jar.set(SESSION_COOKIE, sealSession(session, deps.key), cookieOptions(maxAge));

  return session;
}

export interface ReadSessionDeps {
  readonly jar: CookieJar;
  readonly key: Uint8Array;
  readonly clock: Clock;
}

/** The current session, or `null`. Never throws, and never consults the environment. */
export function readSession(deps: ReadSessionDeps): Session | null {
  const cookie = deps.jar.get(SESSION_COOKIE);
  if (cookie === undefined) return null;

  const session = unsealSession(cookie, deps.key);
  if (session === null) return null;

  // Expiry is enforced here and not left to the cookie's own `maxAge`: a client
  // controls when it stops sending a cookie, and this is the server's copy of
  // the same deadline.
  return session.expiresAt <= deps.clock.now() ? null : session;
}

export interface RequireRoleDeps extends ReadSessionDeps {
  readonly status: UserStatusReader;
}

/**
 * The three gates of §8.4 L757 ("every action ... re-checks the caller's role
 * server-side") and §8.6 L788, in order: authenticated, not disabled, ranked at
 * or above `min`.
 *
 * The disabled check is a live read on every call. That is the entire content of
 * "rejected at every action" — an operator who disables a compromised admin has
 * not invalidated their cookie, and expects the next click to fail.
 *
 * §8.6 L790: no branch of this function reads `process.env`, so there is no
 * emulator bypass to find.
 */
export async function requireRole(min: Role, deps: RequireRoleDeps): Promise<Session> {
  const session = readSession(deps);
  if (session === null) throw new AuthorizationError("unauthenticated");

  const enabled = await deps.status.isEnabled(session.sub);
  if (!enabled) throw new AuthorizationError("disabled");

  if (!hasRole({ roles: session.roles, enabled }, min)) {
    throw new AuthorizationError("forbidden");
  }

  return session;
}

export function endSession(jar: CookieJar): void {
  jar.delete(SESSION_COOKIE);
}
