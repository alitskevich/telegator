import type { Node } from "constructs";

/**
 * §9.3 — the origins the console is served from: the dev server, and the
 * Firebase Hosting site's two domains.
 *
 * One list for two consumers that must agree exactly. Cognito redirects only to
 * a registered callback, and the API answers CORS only for an allowed origin;
 * an origin present in one and missing from the other signs in and then fails
 * every call, or never signs in at all. Context overrides it, because a second
 * site is deployment configuration — never a lookup, which would break the
 * credential-free synth.
 */
export const DEFAULT_WEB_ORIGINS = [
  "http://localhost:8080",
  "https://telegator-581db.web.app",
  "https://telegator-581db.firebaseapp.com",
] as const;

/** `-c webOrigins=a,b` arrives as one string; a test may pass an array. */
export function webOrigins(node: Node): string[] {
  const raw: unknown = node.tryGetContext("webOrigins");
  if (raw === undefined) return [...DEFAULT_WEB_ORIGINS];
  if (Array.isArray(raw) && raw.every((entry) => typeof entry === "string")) return raw;
  if (typeof raw === "string") return raw.split(",").map((origin) => origin.trim());
  throw new Error(`expected a list of origins, received ${String(raw)}`);
}

/**
 * The SPA is one page, so it signs in and out at its root. Cognito compares the
 * `redirect_uri` byte for byte, which is why the trailing slash is fixed here
 * and in `tg-web/src/auth/cognito.ts` rather than left to each side.
 */
export const callbackUrl = (origin: string): string => `${origin.replace(/\/+$/, "")}/`;
