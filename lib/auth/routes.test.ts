import { beforeEach, describe, expect, test } from "vitest";
import { FakeCookieJar, FakeIdTokenVerifier, FakeTokenEndpoint } from "../../test/fakes/auth.js";
import { manualClock } from "../../test/fakes/clock.js";
import { handleAuthRequest, OAUTH_STATE_COOKIE } from "./routes.js";
import { newSessionKey, readSession, SESSION_COOKIE } from "./session.js";

const NOW = 1_770_000_000_000;
const HOUR_MS = 3_600_000;
const SUB = "e4f1a2b3-0000-4000-8000-000000000001";
const FOUND = 302;

let jar: FakeCookieJar;
let tokens: FakeTokenEndpoint;
let verifier: FakeIdTokenVerifier;
let key: Uint8Array;
const clock = manualClock(NOW);

const config = {
  hostedUiDomain: "https://telegator.auth.eu-central-1.amazoncognito.com",
  clientId: "client-123",
  appUrl: "https://dash.example",
};

beforeEach(() => {
  jar = new FakeCookieJar();
  tokens = new FakeTokenEndpoint();
  verifier = new FakeIdTokenVerifier();
  key = newSessionKey();
});

const deps = () => ({ tokens, verifier, jar, key, clock, config });

const call = (path: string) =>
  handleAuthRequest(
    path.split("/").filter(Boolean),
    new Request(`${config.appUrl}/api/auth/${path}`),
    deps(),
  );

describe("login", () => {
  test("redirects to the hosted UI authorize endpoint", async () => {
    const response = await call("login");
    expect(response.status).toBe(FOUND);

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe(config.hostedUiDomain);
    expect(location.pathname).toBe("/oauth2/authorize");
    expect(location.searchParams.get("response_type")).toBe("code");
    expect(location.searchParams.get("client_id")).toBe(config.clientId);
    expect(location.searchParams.get("redirect_uri")).toBe(`${config.appUrl}/api/auth/callback`);
    expect(location.searchParams.get("scope")).toBe("openid email profile");
  });

  /**
   * Without state, any page on the internet can send an operator's browser to
   * the callback with an attacker's code and sign them into the attacker's
   * account — after which anything the operator types goes to the attacker.
   */
  test("mints an unguessable state and stores it httpOnly", async () => {
    const response = await call("login");
    const state = new URL(response.headers.get("location") ?? "").searchParams.get("state");

    expect(state).toBeTruthy();
    expect(jar.get(OAUTH_STATE_COOKIE)).toBe(state);
    expect(jar.written(OAUTH_STATE_COOKIE)?.options).toMatchObject({
      httpOnly: true,
      secure: true,
    });
  });

  test("a fresh state on every login", async () => {
    const first = new URL((await call("login")).headers.get("location") ?? "").searchParams.get(
      "state",
    );
    const second = new URL((await call("login")).headers.get("location") ?? "").searchParams.get(
      "state",
    );
    expect(first).not.toBe(second);
  });
});

describe("callback", () => {
  function armCode(code = "auth-code", groups: readonly string[] = ["editor"]) {
    tokens.expect(code, { idToken: "id.token", accessToken: "access", expiresIn: 3600 });
    verifier.accept("id.token", {
      sub: SUB,
      "cognito:groups": [...groups],
      exp: (NOW + HOUR_MS) / 1000,
    });
  }

  const callback = (query: string) =>
    handleAuthRequest(
      ["callback"],
      new Request(`${config.appUrl}/api/auth/callback?${query}`),
      deps(),
    );

  test("exchanges the code and lands on the dashboard", async () => {
    armCode();
    jar.set(OAUTH_STATE_COOKIE, "state-abc", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    });

    const response = await callback("code=auth-code&state=state-abc");

    expect(response.status).toBe(FOUND);
    expect(response.headers.get("location")).toBe(`${config.appUrl}/`);
    expect(readSession({ jar, key, clock })).toMatchObject({ sub: SUB, roles: ["editor"] });
  });

  test("rejects a mismatched state and starts no session", async () => {
    armCode();
    jar.set(OAUTH_STATE_COOKIE, "state-abc", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    });

    const response = await callback("code=auth-code&state=attacker-state");

    expect(response.status).toBe(400);
    expect(jar.get(SESSION_COOKIE)).toBeUndefined();
    expect(tokens.exchanges).toEqual([]);
  });

  test("rejects a callback with no state cookie", async () => {
    armCode();
    const response = await callback("code=auth-code&state=state-abc");
    expect(response.status).toBe(400);
    expect(jar.get(SESSION_COOKIE)).toBeUndefined();
  });

  /** The state is single-use; a replayed callback must not re-authenticate. */
  test("clears the state cookie once consumed", async () => {
    armCode();
    jar.set(OAUTH_STATE_COOKIE, "state-abc", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    });
    await callback("code=auth-code&state=state-abc");
    expect(jar.get(OAUTH_STATE_COOKIE)).toBeUndefined();
  });

  test("rejects a callback with no code", async () => {
    jar.set(OAUTH_STATE_COOKIE, "state-abc", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    });
    const response = await callback("state=state-abc");
    expect(response.status).toBe(400);
  });

  test("a failed exchange starts no session", async () => {
    jar.set(OAUTH_STATE_COOKIE, "state-abc", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    });
    const response = await callback("code=unknown-code&state=state-abc");
    expect(response.status).toBe(401);
    expect(jar.get(SESSION_COOKIE)).toBeUndefined();
  });
});

describe("logout", () => {
  test("clears the session and redirects to the hosted UI logout", async () => {
    jar.set(SESSION_COOKIE, "whatever", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    });

    const response = await call("logout");

    expect(response.status).toBe(FOUND);
    expect(jar.get(SESSION_COOKIE)).toBeUndefined();

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe(config.hostedUiDomain);
    expect(location.pathname).toBe("/logout");
    expect(location.searchParams.get("logout_uri")).toBe(`${config.appUrl}/`);
  });
});

describe("unknown segments", () => {
  test("404, rather than falling through to something", async () => {
    expect((await call("refresh")).status).toBe(404);
    expect(
      (await handleAuthRequest([], new Request(`${config.appUrl}/api/auth`), deps())).status,
    ).toBe(404);
  });
});
