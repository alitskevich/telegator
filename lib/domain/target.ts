import { DEFAULT_TG_CHANNEL } from "./message";

/**
 * multi-target#2.1 — a target list is target ids joined by this separator.
 *
 * The list is carried as one string from `sources.target` through the item
 * payload into `messages.tgChannel`, and parsed only here (D1). This module
 * imports from `./message` and `./message` never imports from here: a cycle
 * would throw when this file is the entry module (plan ruling P1).
 */
export const TARGET_SEPARATOR = ",";

/** The one prefix a canonical id drops (D7). `@a` and `a` are one channel. */
const AT = "@";

/**
 * multi-target#5.3 — canonical ids in first-seen order: trimmed, one leading
 * `@` removed, empty and duplicate ids dropped. `[]` for nothing.
 */
export function parseTargets(value: string | undefined): string[] {
  if (value === undefined) return [];

  const out: string[] = [];
  for (const part of value.split(TARGET_SEPARATOR)) {
    const trimmed = part.trim();
    const id = trimmed.startsWith(AT) ? trimmed.slice(AT.length) : trimmed;
    if (id === "" || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/** multi-target#5.3 — a list that resolves to nothing is `[DEFAULT_TG_CHANNEL]`. */
export function resolveTargets(value: string | undefined): string[] {
  const parsed = parseTargets(value);
  return parsed.length === 0 ? [DEFAULT_TG_CHANNEL] : parsed;
}
