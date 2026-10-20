/**
 * target-table#2.2 — the kinds of destination a row can be (D2, R58).
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
