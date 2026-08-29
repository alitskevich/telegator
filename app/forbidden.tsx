/**
 * §8.6's 403, covering both refusals that a fresh sign-in cannot lift:
 * `disabled` (L788 — "a new user is created disabled ... and must be enabled
 * manually") and `forbidden` (a session ranked below the page's minimum).
 *
 * They share a page because `forbidden.js` takes no props, and they would share
 * one anyway: telling a signed-out-of-luck browser which of the two it hit is
 * an account-enumeration hint, and the operator's next step — ask an admin — is
 * the same either way.
 */
export default function Forbidden() {
  return (
    <section className="auth-gate">
      <h1 className="page-title">Not authorised</h1>
      <p className="empty">
        Your account is signed in but cannot read this console. A new account starts disabled with
        no roles, and an admin has to enable it and grant one.
      </p>
      <p>
        <a href="/api/auth/logout">Sign in as someone else →</a>
      </p>
    </section>
  );
}
