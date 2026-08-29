/**
 * §8.6 L780's 401. Rendered when `authorized()` maps an `unauthenticated`
 * refusal onto `unauthorized()`.
 *
 * The link is a plain anchor, not `next/link`: `/api/auth/login` is the route
 * handler of §8.2 L722, and it answers with a 302 to the Cognito hosted UI on
 * another origin. The client router would fetch it expecting a payload and get
 * a redirect it cannot follow; a full-page navigation is the point.
 */
export default function Unauthorized() {
  return (
    <section className="auth-gate">
      <h1 className="page-title">Sign in required</h1>
      <p className="empty">
        This console is behind the Cognito user pool. Signing in returns you here.
      </p>
      <p>
        <a href="/api/auth/login">Sign in →</a>
      </p>
    </section>
  );
}
