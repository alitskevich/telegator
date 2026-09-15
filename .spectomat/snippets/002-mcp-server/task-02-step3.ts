import { parseTargets } from "../domain/target";

/**
 * mcp-server#5.4 — the one canonicalisation rule this subsystem uses, reused
 * from multi-target#5.3 (`parseTargets`) so `@a` and `a` address the same row
 * here exactly as they do at publish time. A value that does not resolve to
 * exactly one id — the separator, an empty string, `"@"` alone — is rejected
 * rather than silently taking the first element (D13).
 */
export function canonicalId(value: string): string {
  const ids = parseTargets(value);
  const [id, ...rest] = ids;

  if (id === undefined || rest.length > 0) {
    throw new Error(`not a single id: ${value}`);
  }

  return id;
}
