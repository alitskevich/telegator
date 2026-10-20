import { z } from "zod";

/**
 * §2.2 L141 — replaces the source system's initial `status` value.
 *
 * `obsolete` (§3.1 L228) joins the two §3.1 L226 kinds the enqueue drops. It is
 * a kind rather than a filter in the orchestrator so the drop reaches §7.7's
 * `ItemsDropped` counter through the one path every dropped post already takes.
 */
export const ITEM_KINDS = ["post", "forward", "empty", "obsolete"] as const;

export const ItemKindSchema = z.enum(ITEM_KINDS);
export type ItemKind = z.infer<typeof ItemKindSchema>;

/** §5.2 L459 — the two levels the classifier may assign. */
export const IMPORTANCE_LEVELS = ["high", "low"] as const;

export const ImportanceSchema = z.enum(IMPORTANCE_LEVELS);
export type Importance = z.infer<typeof ImportanceSchema>;
