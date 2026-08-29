import { beforeEach, describe, expect, test } from "vitest";
import {
  FakeCookieJar,
  FakeIdTokenVerifier,
  FakeTokenEndpoint,
  FakeUserStatusReader,
} from "../../test/fakes/auth";
import { manualClock } from "../../test/fakes/clock";
import {
  AuthorizationError,
  endSession,
  newSessionKey,
  readSession,
  requireRole,
  SESSION_COOKIE,
  sealSession,
  startSession,
  unsealSession,
} from "./session";

const SUB = "e4f1a2b3-0000-4000-8000-000000000001";
const REDIRECT = "https://dash.example/api/auth/callback";
const NOW = 1_770_000_000_000;
const HOUR_MS = 3_600_000;

let key: Uint8Array;
let clock: ReturnType<typeof manualClock>;
let jar: FakeCookieJar;
let status: FakeUserStatusReader;
let tokens: FakeTokenEndpoint;
let verifier: FakeIdTokenVerifier;

beforeEach(() => {
  key = newSessionKey();
  clock = manualClock(NOW);
  jar = new FakeCookieJar();
  status = new FakeUserStatusReader();
  tokens = new FakeTokenEndpoint();
  verifier = new FakeIdTokenVerifier();
});

const deps = () => ({ jar, key, clock, status });

function signIn(groups: readonly string[] = ["editor"], expSeconds = (NOW + HOUR_MS) / 1000) {
  tokens.expect("auth-code", { idToken: "id.token", accessToken: "access", expiresIn: 3600 });
  verifier.accept("id.token", {
    sub: SUB,
    email: "op@example.com",
    "cognito:groups": [...groups],
    exp: expSeconds,
  });
  return startSession("auth-code", REDIRECT, { tokens, verifier, jar, key, clock });
}

describe("the session cookie", () => {
  test("round-trips a session", () => {
    const session = { sub: SUB, roles: ["admin"], expiresAt: NOW + HOUR_MS };
    expect(unsealSession(sealSession(session, key), key)).toEqual(session);
  });

  /**
   * The cookie is the only thing standing between a browser and an `admin`
   * session, and it travels through a client that can edit it. AES-256-GCM's
   * tag makes a forged or flipped byte unopenable rather than merely wrong.
   */
  test("a tampered cookie does not open", () => {
    const sealed = sealSession({ sub: SUB, roles: ["viewer"], expiresAt: NOW + HOUR_MS }, key);
    const flipped = `${sealed.slice(0, -2)}${sealed.endsWith("A") ? "B" : "A"}=`;
    expect(unsealSession(flipped, key)).toBeNull();
  });

  test("a cookie sealed with another key does not open", () => {
    const sealed = sealSession({ sub: SUB, roles: ["admin"], expiresAt: NOW + HOUR_MS }, key);
    expect(unsealSession(sealed, newSessionKey())).toBeNull();
  });

  test("garbage does not open and does not throw", () => {
    expect(unsealSession("not-a-cookie", key)).toBeNull();
    expect(unsealSession("", key)).toBeNull();
  });
});

describe("startSession", () => {
  test("exchanges the code and stores a session", async () => {
    const session = await signIn(["editor"]);

    expect(session.sub).toBe(SUB);
    expect(session.roles).toEqual(["editor"]);
    expect(tokens.exchanges).toEqual([{ code: "auth-code", redirectUri: REDIRECT }]);
    expect(readSession({ jar, key, clock })).toEqual(session);
  });

  /**
   * §8.6 L780 puts the dashboard behind a Cognito hosted UI, so the cookie must
   * be unreadable to script (an XSS in an operator console would otherwise lift
   * an admin session), confined to this site, and never sent in the clear.
   */
  test("the cookie is httpOnly, secure, sameSite lax and path-scoped", () => {
    return signIn().then(() => {
      const cookie = jar.written(SESSION_COOKIE);
      expect(cookie?.options).toMatchObject({
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
      });
    });
  });

  /**
   * The session must not outlive the identity it was minted from, so its expiry
   * is the ID token's `exp` rather than a duration invented here.
   */
  test("the session expires when the id token does", async () => {
    const session = await signIn(["viewer"], (NOW + HOUR_MS) / 1000);
    expect(session.expiresAt).toBe(NOW + HOUR_MS);
  });

  test("a token the verifier rejects starts no session", async () => {
    tokens.expect("bad-code", { idToken: "forged", accessToken: "a", expiresIn: 3600 });
    await expect(
      startSession("bad-code", REDIRECT, { tokens, verifier, jar, key, clock }),
    ).rejects.toThrow();
    expect(jar.written(SESSION_COOKIE)).toBeUndefined();
  });
});

describe("readSession", () => {
  test("returns null with no cookie", () => {
    expect(readSession({ jar, key, clock })).toBeNull();
  });

  test("returns null for an unopenable cookie", () => {
    jar.set(SESSION_COOKIE, "tampered", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
    });
    expect(readSession({ jar, key, clock })).toBeNull();
  });

  test("returns null once expired", async () => {
    await signIn();
    clock.advance(HOUR_MS + 1);
    expect(readSession({ jar, key, clock })).toBeNull();
  });
});

describe("requireRole — the three gates of §8.4 L757 and §8.6 L788", () => {
  test("passes an enabled admin an admin check", async () => {
    await signIn(["admin"]);
    status.enable(SUB);
    await expect(requireRole("admin", deps())).resolves.toMatchObject({ sub: SUB });
  });

  test("gate 1: unauthenticated", async () => {
    status.enable(SUB);
    await expect(requireRole("viewer", deps())).rejects.toMatchObject({
      reason: "unauthenticated",
    });
  });

  test("gate 1: an expired session is unauthenticated", async () => {
    await signIn(["admin"]);
    status.enable(SUB);
    clock.advance(HOUR_MS + 1);
    await expect(requireRole("viewer", deps())).rejects.toMatchObject({
      reason: "unauthenticated",
    });
  });

  /**
   * The gate the ledger names explicitly. The token is valid, unexpired and
   * carries `admin`; only the directory says otherwise. §8.6 L788 — "a disabled
   * user is rejected at every action" — which is why the check is here on every
   * call and not cached into the cookie at sign-in.
   */
  test("gate 2: a disabled user with a valid admin token is rejected", async () => {
    await signIn(["admin"]);
    status.disable(SUB);
    await expect(requireRole("viewer", deps())).rejects.toMatchObject({ reason: "disabled" });
  });

  test("gate 2: is re-checked on every call, not cached", async () => {
    await signIn(["admin"]);
    status.enable(SUB);
    await expect(requireRole("admin", deps())).resolves.toMatchObject({ sub: SUB });

    status.disable(SUB);
    await expect(requireRole("admin", deps())).rejects.toMatchObject({ reason: "disabled" });
    expect(status.reads).toBe(2);
  });

  test("gate 3: an enabled editor is forbidden an admin action", async () => {
    await signIn(["editor"]);
    status.enable(SUB);
    await expect(requireRole("admin", deps())).rejects.toMatchObject({ reason: "forbidden" });
  });

  test("gate 3: an unknown group grants nothing", async () => {
    await signIn(["superadmin"]);
    status.enable(SUB);
    await expect(requireRole("viewer", deps())).rejects.toMatchObject({ reason: "forbidden" });
  });

  test("the error is an AuthorizationError", async () => {
    await expect(requireRole("viewer", deps())).rejects.toBeInstanceOf(AuthorizationError);
  });

  /**
   * §8.6 L790 — "The source's API handler bypasses authentication entirely when
   * an emulator environment variable is set... **No code path skips
   * authorisation.**" Asserted against the process environment rather than by
   * reading the source, so it holds however the bypass might be spelled.
   */
  test("no environment variable produces a session", async () => {
    for (const name of [
      "EMULATOR",
      "FUNCTIONS_EMULATOR",
      "TELEGATOR_EMULATOR",
      "NODE_ENV",
      "TELEGATOR_ADMIN",
    ]) {
      process.env[name] = "true";
    }
    try {
      status.enable(SUB);
      await expect(requireRole("viewer", deps())).rejects.toMatchObject({
        reason: "unauthenticated",
      });
    } finally {
      for (const name of [
        "EMULATOR",
        "FUNCTIONS_EMULATOR",
        "TELEGATOR_EMULATOR",
        "TELEGATOR_ADMIN",
      ]) {
        delete process.env[name];
      }
    }
  });
});

describe("endSession", () => {
  test("clears the cookie", async () => {
    await signIn();
    endSession(jar);
    expect(jar.get(SESSION_COOKIE)).toBeUndefined();
    expect(readSession({ jar, key, clock })).toBeNull();
  });
});
