/**
 * The kinds of destination a target can be. An enum with one member, so a second
 * kind can be added without changing the schema's shape.
 */
export const TARGET_TYPES = ["telegram_channel"] as const;

/**
 * The read-side default. `recordLastPost` can create a target doc holding only
 * the two last-post fields; without this default that doc would fail
 * `TargetSchema` on the next read.
 */
export const DEFAULT_TARGET_TYPE = "telegram_channel";
