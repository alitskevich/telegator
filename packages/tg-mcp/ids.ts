import { parseTargets } from "tg-domain/target";

/**
 * Canonicalises an id with `parseTargets`, so `@a` and `a` address the same row
 * here as at publish time. A value that is not exactly one id is rejected rather
 * than silently cut to its first element.
 */
export function canonicalId(value: string): string {
  const ids = parseTargets(value);
  const [id, ...rest] = ids;

  if (id === undefined || rest.length > 0) {
    throw new Error(`not a single id: ${value}`);
  }

  return id;
}
