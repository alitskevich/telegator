import { z } from "zod";

/**
 * `sources` — the Telegram channels to poll, per §2.1 L99–111.
 *
 * Two fields are additions the spec does not list, each recorded as a
 * reconciliation rather than invented here:
 *  - `lastNonZeroCount` (R15). §4.1 L373 fires `SourceStale` on a source with "a
 *    non-zero historical `lastCount`", but §3.1 L208 writes `lastCount: 0` on the
 *    first zero-yield run — destroying the evidence two runs before it is needed.
 *  - `deleted` (R16). §8.4 L751 mandates a soft delete setting `deleted: true`;
 *    §2.1's table never declares the field.
 */

/** §2.1 L102 — the one status value that enables polling. */
export const SOURCE_STATUS_OK = "ok";

const count = z.number().int().nonnegative();
const epochMs = z.number().int().nonnegative();

/**
 * Each field's type, declared once. `SourceSchema` adds read-side defaults on
 * top of these; the write-side schemas reuse them without defaults.
 */
const field = {
  /** Telegram channel username, and the `t.me/s/{id}` URL segment (§3.1 L195). */
  id: z.string().min(1),

  /**
   * §2.1 L102: "`ok` enables polling. Any other value disables the source." An
   * open string, not an enum. Optional because DynamoDB rejects an empty string
   * as an index key, so item 6.3 omits the attribute for the 61 legacy records
   * carrying `status: ""` — leaving them out of the sparse `status-index`, which
   * is the same outcome L102 already describes.
   */
  status: z.string().optional(),

  // Operator-curated (§2.1 L103–106).
  tgChannel: z.string().optional(),
  category: z.string().optional(),
  tags: z.string().optional(),
  teaser: z.string().optional(),

  // Written by scrape (§2.1 L107–111).
  /** The `?after=` cursor, and the sole duplicate-suppression mechanism (§3.1 L210). */
  lastItemId: z.string().optional(),
  lastCount: count,
  lastUpdated: epochMs,
  /** ISO timestamp of the last successful poll (§2.1 L110). */
  lastResult: z.string().optional(),
  zeroYieldRuns: count,
  lastNonZeroCount: count,

  deleted: z.boolean().optional(),
} as const;

/**
 * A stored record, as read back from DynamoDB.
 *
 * The counters default to 0 rather than being optional: §3.1 L190 selects on
 * `now - lastUpdated >= (lastCount > 0 ? 30 : 240) * 60_000`, which yields NaN
 * on undefined, and NaN fails every comparison — so a never-polled source would
 * never be selected and its channel would go dark with no error anywhere.
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
 * The operator-writable fields (§2.1 L102–106) — the allowlist item 5.9's
 * `upsertRecord` enforces.
 *
 * `.strict()` rather than the default strip: an operator who tries to hand-edit
 * a scrape-owned cursor should get an error, not a silent no-op.
 */
export const SourceConfigInput = z
  .object({
    status: field.status,
    tgChannel: field.tgChannel,
    category: field.category,
    tags: field.tags,
    teaser: field.teaser,
  })
  .partial()
  .strict();

export type SourceConfig = z.infer<typeof SourceConfigInput>;

/**
 * The scrape-written fields (§2.1 L107–111), as a patch.
 *
 * Deliberately built from `field` rather than `SourceSchema.pick()`: a pick
 * carries the read-side `.default(0)` through `.partial()`, so parsing a patch
 * that omits `zeroYieldRuns` would *inject* 0 — resetting the staleness counter
 * on every successful poll and making §4.1 L373's alarm unreachable. A patch
 * must leave an absent field absent.
 *
 * Strict for the mirror reason to `SourceConfigInput`: scrape must not overwrite
 * operator curation.
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
