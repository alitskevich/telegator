import { describe, expect, test } from "vitest";
import { type AuthInterrupts, authorized } from "../app/authorize";
import { AuthorizationError, type AuthorizationReason, type Session } from "../lib/auth/session";

/**
 * `requireRole` throws, and a throw out of a server component is an HTTP 500.
 * Every page of §8.2 L718-723 returned one to a signed-out browser — including
 * the first visit anyone ever makes, which is necessarily signed out. The
 * console has a working sign-in route and nothing sent a browser to it.
 *
 * This module is the mapping from the three gates of §8.6 onto the two answers
 * HTTP has for them, so the tests are that mapping, one reason at a time.
 */

const SESSION: Session = { sub: "u-1", roles: ["viewer"], expiresAt: 4_102_444_800_000 };

/** What the interrupt did, recorded rather than performed. */
class Interrupted extends Error {
  constructor(readonly kind: "unauthorized" | "forbidden") {
    super(kind);
  }
}

const recording = (): AuthInterrupts => ({
  unauthorized: () => {
    throw new Interrupted("unauthorized");
  },
  forbidden: () => {
    throw new Interrupted("forbidden");
  },
});

const refused = (reason: AuthorizationReason): Promise<Session> =>
  Promise.reject(new AuthorizationError(reason));

describe("authorized()", () => {
  test("passes an authorised session straight through", async () => {
    await expect(authorized(Promise.resolve(SESSION), recording())).resolves.toEqual(SESSION);
  });

  /**
   * §8.6 L780 puts the console behind the hosted UI. A signed-out visitor has
   * not been refused anything — they have not been asked yet — so this is the
   * one reason that must offer a way in.
   */
  test("unauthenticated asks for sign-in", async () => {
    await expect(authorized(refused("unauthenticated"), recording())).rejects.toMatchObject({
      kind: "unauthorized",
    });
  });

  /**
   * §8.6 L788: "a disabled user is rejected at every action". They are signed
   * in and stay signed in; sending them to the hosted UI would loop them
   * straight back with the same cookie and the same answer.
   */
  test("a disabled account is refused, not re-prompted", async () => {
    await expect(authorized(refused("disabled"), recording())).rejects.toMatchObject({
      kind: "forbidden",
    });
  });

  test("a role below the minimum is refused", async () => {
    await expect(authorized(refused("forbidden"), recording())).rejects.toMatchObject({
      kind: "forbidden",
    });
  });

  /**
   * The failure this function must not absorb. `authContext()` reads the
   * session key from Secrets Manager and the enabled flag from Cognito; either
   * can fail, and dressing an outage as "please sign in" would send an operator
   * to log in again over and over while the console was simply broken.
   */
  test("any other failure stays a server error", async () => {
    const outage = new Error("Secrets Manager unavailable");

    await expect(authorized(Promise.reject(outage), recording())).rejects.toBe(outage);
  });

  /**
   * The tests above prove the mapping against fakes. This proves the shipped
   * default is Next's own pair, by the digests it renders `unauthorized.tsx`
   * and `forbidden.tsx` from — the whole point being the status code.
   */
  test("the defaults are Next's interrupts, with their real digests", async () => {
    const flag = "__NEXT_EXPERIMENTAL_AUTH_INTERRUPTS";
    const previous = process.env[flag];
    process.env[flag] = "1";

    try {
      await expect(authorized(refused("unauthenticated"))).rejects.toMatchObject({
        digest: "NEXT_HTTP_ERROR_FALLBACK;401",
      });
      await expect(authorized(refused("forbidden"))).rejects.toMatchObject({
        digest: "NEXT_HTTP_ERROR_FALLBACK;403",
      });
    } finally {
      if (previous === undefined) delete process.env[flag];
      else process.env[flag] = previous;
    }
  });
});
