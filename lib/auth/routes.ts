import { randomBytes } from "node:crypto";
import type { CookieOptions } from "./ports.js";
import { endSession, SESSION_COOKIE, type StartSessionDeps, startSession } from "./session.js";

/** Holds the OAuth `state` between the redirect out and the callback back. */
export const OAUTH_STATE_COOKIE = "telegator_oauth_state";

const STATE_BYTES = 32;
const FOUND = 302;
const BAD_REQUEST = 400;
const UNAUTHORIZED = 401;
const NOT_FOUND = 404;
const STATE_TTL_SECONDS = 600;

export interface HostedUiConfig {
  /** Origin of the Cognito hosted UI, e.g. `https://x.auth.eu-central-1.amazoncognito.com`. */
  readonly hostedUiDomain: string;
  readonly clientId: string;
  /** Origin this dashboard is served from; the callback and logout URLs derive from it. */
  readonly appUrl: string;
}

export interface AuthRouteDeps extends StartSessionDeps {
  readonly config: HostedUiConfig;
}

const transientCookie = (maxAge: number): CookieOptions => ({
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
  maxAge,
});

const redirectUri = (config: HostedUiConfig) => `${config.appUrl}/api/auth/callback`;

const redirect = (location: string) => new Response(null, { status: FOUND, headers: { location } });

/**
 * §8.2 L722 — `app/api/auth/[...]/route.ts`. Three segments: `login`, `callback`
 * and `logout`.
 *
 * Written as a function over the path segments rather than inside the route file
 * so it can be tested without a Next request context, the same way the Lambda
 * handlers are thin wrappers over `lib/pipeline/`.
 */
export async function handleAuthRequest(
  segments: readonly string[],
  request: Request,
  deps: AuthRouteDeps,
): Promise<Response> {
  const [segment] = segments;

  if (segments.length === 1 && segment === "login") return login(deps);
  if (segments.length === 1 && segment === "callback") return callback(request, deps);
  if (segments.length === 1 && segment === "logout") return logout(deps);

  return new Response(null, { status: NOT_FOUND });
}

function login(deps: AuthRouteDeps): Response {
  /**
   * Without `state`, any page on the internet can send an operator's browser to
   * the callback carrying an attacker's authorization code, silently signing the
   * operator into the attacker's account — after which every source they edit
   * and every message they publish lands somewhere else.
   */
  const state = randomBytes(STATE_BYTES).toString("base64url");
  deps.jar.set(OAUTH_STATE_COOKIE, state, transientCookie(STATE_TTL_SECONDS));

  const url = new URL("/oauth2/authorize", deps.config.hostedUiDomain);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", deps.config.clientId);
  url.searchParams.set("redirect_uri", redirectUri(deps.config));
  // Matches the scopes the app client is created with in `infra/lib/auth-stack.ts`.
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);

  return redirect(url.toString());
}

async function callback(request: Request, deps: AuthRouteDeps): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const expected = deps.jar.get(OAUTH_STATE_COOKIE);
  const state = params.get("state");
  const code = params.get("code");

  // Checked before the exchange, so a forged callback costs no token request.
  if (expected === undefined || state === null || state !== expected) {
    return new Response(null, { status: BAD_REQUEST });
  }

  // Single-use, whatever happens next: a replayed callback must not re-authenticate.
  deps.jar.delete(OAUTH_STATE_COOKIE);

  if (code === null) return new Response(null, { status: BAD_REQUEST });

  try {
    await startSession(code, redirectUri(deps.config), deps);
  } catch {
    // A rejected code or an unverifiable token is a failed sign-in, not a server
    // fault, and the reason is not the browser's business.
    return new Response(null, { status: UNAUTHORIZED });
  }

  return redirect(`${deps.config.appUrl}/`);
}

function logout(deps: AuthRouteDeps): Response {
  endSession(deps.jar);

  const url = new URL("/logout", deps.config.hostedUiDomain);
  url.searchParams.set("client_id", deps.config.clientId);
  // Ends the hosted-UI session too. Clearing only the local cookie would let the
  // next `login` sign straight back in without a prompt, which on a shared
  // operator machine is not a logout at all.
  url.searchParams.set("logout_uri", `${deps.config.appUrl}/`);

  return redirect(url.toString());
}

export { SESSION_COOKIE };
