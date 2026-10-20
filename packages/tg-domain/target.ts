import { DEFAULT_TARGET_TYPE, TARGET_TYPES } from "tg-enums/targetType";
import { z } from "zod";
import { DEFAULT_TG_CHANNEL } from "./message";

/**
 * A target list is target ids joined by this separator. It travels as one string
 * from `sources.target` through the item into `messages.tgChannel`, and is
 * parsed only here. `./message` must never import this module: the cycle would
 * throw when this file is the entry module.
 */
export const TARGET_SEPARATOR = ",";

/** The one prefix a canonical id drops: `@a` and `a` are one channel. */
const AT = "@";

/**
 * Canonical ids in first-seen order: trimmed, one leading `@` removed, empty and
 * duplicate ids dropped. `[]` for nothing.
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

/** A list that resolves to nothing is `[DEFAULT_TG_CHANNEL]`. */
export function resolveTargets(value: string | undefined): string[] {
  const parsed = parseTargets(value);
  return parsed.length === 0 ? [DEFAULT_TG_CHANNEL] : parsed;
}

/** Each field's type, declared once — the same shape `tg-domain/source.ts` uses. */
const targetField = {
  /** The canonical target id, and the key of `messages.posts`. */
  id: z.string().min(1),
  type: z.enum(TARGET_TYPES),
  /** Written by publish only: an ISO timestamp, for human eyes. */
  lastPostedDate: z.string().optional(),
  /** Written by publish only: `messages.id`, not Telegram's `message_id`. */
  lastPostedMessageId: z.string().optional(),
  /** Absent means the built-in layout, byte for byte. */
  messageTemplate: z.string().optional(),
  deleted: z.boolean().optional(),
} as const;

/** A stored target, as read back from Firestore. */
export const TargetSchema = z.object({
  ...targetField,
  type: targetField.type.default(DEFAULT_TARGET_TYPE),
});

export type Target = z.infer<typeof TargetSchema>;

/**
 * The operator-writable fields, as a patch. Strict, so hand-editing a field
 * publish owns is an error. Non-empty, so a save that changes nothing does not
 * read as a success.
 */
export const TargetConfigInput = z
  .object({ type: targetField.type, messageTemplate: targetField.messageTemplate })
  .partial()
  .strict()
  .refine((delta) => Object.keys(delta).length > 0, {
    message: "delta must change at least one field",
  });

export type TargetConfig = z.infer<typeof TargetConfigInput>;
