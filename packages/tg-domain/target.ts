import { DEFAULT_TARGET_TYPE, TARGET_TYPES } from "tg-enums/targetType";
import { z } from "zod";
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

/** Each field's type, declared once — the same shape `tg-domain/source.ts` uses. */
const targetField = {
  /** target-table#2.1 — the canonical target id, and `messages.posts`' map key. */
  id: z.string().min(1),
  type: z.enum(TARGET_TYPES),
  /** Written by publish only (D3): an ISO timestamp, read by human eyes alone. */
  lastPostedDate: z.string().optional(),
  /** Written by publish only (D4): `messages.id`, not Telegram's `message_id`. */
  lastPostedMessageId: z.string().optional(),
  /** target-table#2.3 — absent means the built-in layout, byte for byte (D6). */
  messageTemplate: z.string().optional(),
  deleted: z.boolean().optional(),
} as const;

/** A stored `targets` row, as read back from DynamoDB (target-table#2.2). */
export const TargetSchema = z.object({
  ...targetField,
  type: targetField.type.default(DEFAULT_TARGET_TYPE),
});

export type Target = z.infer<typeof TargetSchema>;

/**
 * The operator-writable fields (target-table#2.2), as a patch.
 *
 * `.strict()` for the reason `SourceConfigInput` is strict: an operator who
 * tries to hand-edit one of publish's mirror fields should get an error, not a
 * silent no-op. Non-empty because a delta that changes nothing still
 * revalidates the page and reads as a successful save.
 */
export const TargetConfigInput = z
  .object({ type: targetField.type, messageTemplate: targetField.messageTemplate })
  .partial()
  .strict()
  .refine((delta) => Object.keys(delta).length > 0, {
    message: "delta must change at least one field",
  });

export type TargetConfig = z.infer<typeof TargetConfigInput>;
