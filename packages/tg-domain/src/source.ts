import { DEFAULT_SOURCE_TYPE, SOURCE_TYPES, type SourceType } from "tg-enums/sourceType";
import { z } from "zod";
import { TagsSchema } from "./tags";

/**
 * `sources`: the Telegram channels to poll (docs/telegator.md §2.1).
 *
 * `lastNonZeroCount` exists because `lastCount` is overwritten with 0 on the
 * first empty run, which would erase the evidence that the source once yielded.
 */

/** The one status value that enables polling. */
export const SOURCE_STATUS_OK = "ok";

const count = z.number().int().nonnegative();
const epochMs = z.number().int().nonnegative();

/**
 * Each field's type, declared once. `SourceSchema` adds read-side defaults on
 * top of these; the write-side schemas reuse them without defaults.
 */
const field = {
  /** Telegram channel username, and the `t.me/s/{id}` URL segment. */
  id: z.string().min(1),

  /** `ok` enables polling; any other value, or none, disables the source. An open string. */
  status: z.string().optional(),

  // Operator-curated. A stored legacy `target` or `tgChannel` is stripped on parse.
  category: z.string().optional(),
  /** Copied onto every item of this source; publish routes by them (`tg-domain/target`). */
  tags: TagsSchema.optional(),
  teaser: z.string().optional(),
  /** Which reader polls this source; absent means `telegram` (`sourceType`). */
  type: z.enum(SOURCE_TYPES).optional(),

  // Written by scrape.
  /** The `?after=` cursor, and the only duplicate guard on the way in. */
  lastItemId: z.string().optional(),
  lastCount: count,
  lastUpdated: epochMs,
  /** ISO timestamp of the last successful poll. */
  lastResult: z.string().optional(),
  zeroYieldRuns: count,
  lastNonZeroCount: count,

  deleted: z.boolean().optional(),
} as const;

/**
 * A stored source, as read back from Firestore.
 *
 * The counters default to 0 rather than being optional: scrape's due-time math
 * would yield NaN on undefined, and a never-polled source would never be due.
 */
export const SourceSchema = z.object({
  ...field,
  lastCount: field.lastCount.default(0),
  lastUpdated: field.lastUpdated.default(0),
  zeroYieldRuns: field.zeroYieldRuns.default(0),
  lastNonZeroCount: field.lastNonZeroCount.default(0),
});

export type Source = z.infer<typeof SourceSchema>;

/**
 * The operator-writable fields. `.strict()` so an attempt to hand-edit a
 * scrape-owned cursor is an error, not a silent no-op.
 */
export const SourceConfigInput = z
  .object({
    status: field.status,
    category: field.category,
    tags: field.tags,
    teaser: field.teaser,
    type: field.type,
  })
  .partial()
  .strict();

export type SourceConfig = z.infer<typeof SourceConfigInput>;

/**
 * The scrape-written fields, as a patch.
 *
 * Built from `field`, not `SourceSchema.pick()`: a pick keeps `.default(0)`, so
 * a patch omitting `zeroYieldRuns` would reset the staleness counter. Strict so
 * scrape cannot overwrite operator settings.
 */
export const SourceCursorUpdate = z
  .object({
    lastItemId: field.lastItemId,
    lastCount: field.lastCount,
    lastUpdated: field.lastUpdated,
    lastResult: field.lastResult,
    zeroYieldRuns: field.zeroYieldRuns,
    lastNonZeroCount: field.lastNonZeroCount,
  })
  .partial()
  .strict();

export type SourceCursor = z.infer<typeof SourceCursorUpdate>;

/** The reader a source belongs to, with the default applied. */
export function sourceType(source: Pick<Source, "type">): SourceType {
  return source.type ?? DEFAULT_SOURCE_TYPE;
}
