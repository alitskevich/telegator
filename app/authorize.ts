import { forbidden, unauthorized } from "next/navigation";
import { AuthorizationError, type AuthorizationReason, type Session } from "../lib/auth/session";

/**
 * The bridge from §8.6's three gates to the two answers HTTP has for them.
 *
 * `requireRole` throws — deliberately, since §8.6 L790 allows no code path that
 * skips authorisation — and an uncaught throw out of a server component is a
 * 500. That is what every page of §8.2 L718-723 served to a signed-out browser,
 * which is every browser's first visit: an opaque error page, on a console whose
 * sign-in route at L722 worked the whole time and which nothing ever linked to.
 *
 * This lives in `app/` rather than `lib/auth/` because it is written in Next's
 * vocabulary, and `lib/auth/session.ts` is imported by the Lambda handlers too —
 * a `next/navigation` import there would put the framework in their bundles to
 * express a rule they never reach.
 */

/**
 * Next's interrupts, as a port. They signal by throwing an error the renderer
 * recognises by digest, and that recognition only happens inside a request, so
 * a fake is the only way to assert the mapping itself.
 */
export interface AuthInterrupts {
  /** Renders `app/unauthorized.tsx` with a 401. */
  readonly unauthorized: () => never;
  /** Renders `app/forbidden.tsx` with a 403. */
  readonly forbidden: () => never;
}

const nextInterrupts: AuthInterrupts = { unauthorized, forbidden };

/**
 * Wraps a `requireRole` call so its refusal renders instead of crashing.
 *
 * Takes the pending promise rather than the arguments so the `requireRole(...)`
 * call stays written out at each page's top, where `test/pageAuth.test.ts` reads
 * it and where anyone opening the file sees which role the page demands.
 */
export async function authorized(
  pending: Promise<Session>,
  interrupts: AuthInterrupts = nextInterrupts,
): Promise<Session> {
  let reason: AuthorizationReason;

  try {
    return await pending;
  } catch (error) {
    // Only our own refusals. A Secrets Manager or Cognito outage reaches here
    // too, and answering it with "please sign in" would send an operator round
    // a login loop that could never succeed.
    if (!(error instanceof AuthorizationError)) throw error;
    reason = error.reason;
  }

  /**
   * Outside the `catch`, and that is the whole reason the reason is hoisted:
   * both interrupts work by throwing, and a `try` still in scope would swallow
   * the error the renderer is watching for, leaving the 500 this exists to fix.
   */
  if (reason === "unauthenticated") interrupts.unauthorized();

  // `disabled` and `forbidden` are both "signed in, and the answer is no".
  // Neither is fixed by signing in again, so neither is offered the hosted UI.
  interrupts.forbidden();
}
