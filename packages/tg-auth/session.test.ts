import { beforeEach, describe, expect, test } from "vitest";
import { FakeIdTokenVerifier, FakeUserStatusReader } from "../../test/fakes/auth";
import { AuthorizationError, requireRole, type Session, sessionFromIdToken } from "./session";

const SUB = "e4f1a2b3-0000-4000-8000-000000000001";
const EXP_SECONDS = 1_770_003_600;

let status: FakeUserStatusReader;
let verifier: FakeIdTokenVerifier;

beforeEach(() => {
  status = new FakeUserStatusReader();
  verifier = new FakeIdTokenVerifier();
});

const session = (roles: readonly string[]): Session => ({
  sub: SUB,
  roles: [...roles],
  expiresAt: EXP_SECONDS * 1000,
});

describe("sessionFromIdToken", () => {
  test("turns a verified token into a session", async () => {
    verifier.accept("id.token", {
      sub: SUB,
      email: "op@example.com",
      "cognito:groups": ["editor"],
      exp: EXP_SECONDS,
    });

    await expect(sessionFromIdToken("id.token", verifier)).resolves.toEqual({
      sub: SUB,
      email: "op@example.com",
      roles: ["editor"],
      expiresAt: EXP_SECONDS * 1000,
    });
  });

  test("a token without groups carries no roles", async () => {
    verifier.accept("id.token", { sub: SUB, exp: EXP_SECONDS });
    await expect(sessionFromIdToken("id.token", verifier)).resolves.toMatchObject({ roles: [] });
  });

  /**
   * The claims decide the role, so a token the verifier rejects must be an
   * anonymous caller — and must not throw, or an edited token is a 500.
   */
  test("a token the verifier rejects is anonymous, not an error", async () => {
    await expect(sessionFromIdToken("forged.token", verifier)).resolves.toBeNull();
  });

  test("no token is anonymous", async () => {
    await expect(sessionFromIdToken(undefined, verifier)).resolves.toBeNull();
    await expect(sessionFromIdToken("", verifier)).resolves.toBeNull();
  });
});

describe("requireRole — the three gates of §8.4 and §8.6", () => {
  test("passes an enabled admin an admin check", async () => {
    status.enable(SUB);
    await expect(
      requireRole("admin", { session: session(["admin"]), status }),
    ).resolves.toMatchObject({ sub: SUB });
  });

  test("gate 1: unauthenticated", async () => {
    status.enable(SUB);
    await expect(requireRole("viewer", { session: null, status })).rejects.toMatchObject({
      reason: "unauthenticated",
    });
  });

  /**
   * The token is valid and carries `admin`; only the directory says otherwise.
   * §8.6 — "a disabled user is rejected at every action" — which is why the
   * check is a live read on every call and not a claim in the token.
   */
  test("gate 2: a disabled user with a valid admin token is rejected", async () => {
    status.disable(SUB);
    await expect(
      requireRole("viewer", { session: session(["admin"]), status }),
    ).rejects.toMatchObject({ reason: "disabled" });
  });

  test("gate 2: is re-checked on every call, not cached", async () => {
    const deps = { session: session(["admin"]), status };
    status.enable(SUB);
    await expect(requireRole("admin", deps)).resolves.toMatchObject({ sub: SUB });

    status.disable(SUB);
    await expect(requireRole("admin", deps)).rejects.toMatchObject({ reason: "disabled" });
    expect(status.reads).toBe(2);
  });

  test("gate 3: an enabled editor is forbidden an admin action", async () => {
    status.enable(SUB);
    await expect(
      requireRole("admin", { session: session(["editor"]), status }),
    ).rejects.toMatchObject({ reason: "forbidden" });
  });

  test("gate 3: an unknown group grants nothing", async () => {
    status.enable(SUB);
    await expect(
      requireRole("viewer", { session: session(["superadmin"]), status }),
    ).rejects.toMatchObject({ reason: "forbidden" });
  });

  test("the error is an AuthorizationError", async () => {
    await expect(requireRole("viewer", { session: null, status })).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  /**
   * §8.6 — "The source's API handler bypassed authentication entirely when an
   * emulator environment variable was set... **No code path skips
   * authorisation.**" Asserted against the process environment rather than by
   * reading the source, so it holds however the bypass might be spelled.
   */
  test("no environment variable produces a session", async () => {
    const names = ["EMULATOR", "FUNCTIONS_EMULATOR", "TELEGATOR_EMULATOR", "TELEGATOR_ADMIN"];
    for (const name of names) process.env[name] = "true";
    try {
      status.enable(SUB);
      await expect(requireRole("viewer", { session: null, status })).rejects.toMatchObject({
        reason: "unauthenticated",
      });
    } finally {
      for (const name of names) delete process.env[name];
    }
  });
});
