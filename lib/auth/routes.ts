import { randomBytes } from "node:crypto";
import type { CookieOptions } from "./ports";
import { endSession, SESSION_COOKIE, type StartSessionDeps, startSession } from "./session";

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

/**
 * The page a refused sign-in renders.
 *
 * A bare `Response(null, { status: 400 })` is what an operator first met here:
 * a blank window, no reason and no way back. The status was never wrong — the
 * request really is malformed — but this is also the likeliest thing to go
 * wrong in the whole flow, because the state cookie above lives for
 * `STATE_TTL_SECONDS` and a sign-in that pauses for longer than that arrives
 * with nothing left to match.
 *
 * Fixed strings only, and deliberately so: `state` and `code` are both
 * attacker-supplied — anyone on the internet can send a browser to this route,
 * which is the entire reason the state check exists — so echoing either into
 * the HTML would put reflected XSS on the operator console's own origin.
 *
 * One page for every refusal, rather than one per branch. An expired attempt
 * and a forged one get the same answer, so a prober learns nothing about which
 * check rejected them, and the operator's next step is the same either way.
 */
const SIGN_IN_FAILED_PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Sign-in failed</title></head>
<body style="background:#0f1115;color:#e6e8ec;font-family:ui-sans-serif,system-ui,sans-serif;margin:0">
<main style="max-width:46ch;padding:48px 24px">
<h1 style="font-size:20px;margin:0 0 20px">Sign-in could not be completed</h1>
<p style="color:#9aa3b2;font-size:12px;margin:0 0 12px">
This usually means the attempt took longer than ten minutes, or it began in a
different browser session. Starting again will issue a fresh one.
</p>
<p style="margin:0"><a href="/api/auth/login" style="color:#4a9eff;text-decoration:none">Start again &rarr;</a></p>
</main>
</body>
</html>
`;

/** §8.2 L722's refusals, as something an operator can act on. */
const signInFailed = (status: number): Response =>
  new Response(SIGN_IN_FAILED_PAGE, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
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
    return signInFailed(BAD_REQUEST);
  }

  // Single-use, whatever happens next: a replayed callback must not re-authenticate.
  deps.jar.delete(OAUTH_STATE_COOKIE);

  if (code === null) return signInFailed(BAD_REQUEST);

  try {
    await startSession(code, redirectUri(deps.config), deps);
  } catch {
    // A rejected code or an unverifiable token is a failed sign-in, not a server
    // fault, and the reason is not the browser's business — but the operator
    // still needs the way back, so it is the same page at a different status.
    return signInFailed(UNAUTHORIZED);
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
