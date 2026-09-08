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

/**
 * target-table#2.2 — the kinds of destination a row can be (D2, R56).
 *
 * An enum with one member rather than an open string: the draft says
 * "`telegram_channel` only at the moment", which is an enum that will grow, and
 * a second kind can then be added without touching the schema's shape.
 */
export const TARGET_TYPES = ["telegram_channel"] as const;

/**
 * target-table#2.2 — the read-side default.
 *
 * `recordLastPost` (target-table#5.3) creates a row from one `UpdateItem` that
 * sets the two mirror fields and nothing else. Without this default that row
 * would fail `TargetSchema` on the very next read, so the registry would fill
 * itself with rows nothing could load.
 */
export const DEFAULT_TARGET_TYPE = "telegram_channel";

/** Each field's type, declared once — the same shape `lib/domain/source.ts` uses. */
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
