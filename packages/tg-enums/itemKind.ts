import { z } from "zod";

/**
 * What scrape made of a post. Only `post` is enqueued; the rest are dropped and
 * counted in `ItemsDropped`. `obsolete` is a kind rather than a separate filter,
 * so it takes the same drop path.
 */
export const ITEM_KINDS = ["post", "forward", "empty", "obsolete"] as const;

export const ItemKindSchema = z.enum(ITEM_KINDS);
export type ItemKind = z.infer<typeof ItemKindSchema>;

/** The two levels the classifier may assign. */
export const IMPORTANCE_LEVELS = ["high", "low"] as const;

export const ImportanceSchema = z.enum(IMPORTANCE_LEVELS);
export type Importance = z.infer<typeof ImportanceSchema>;
