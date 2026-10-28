/**
 * How a source is read. `telegram` reads through a logged-in user account
 * (MTProto, GramJS), so it reaches channels, groups and chats alike.
 */
export const SOURCE_TYPES = ["telegram"] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

/** An absent `type` is `telegram`: every source older than the field is a Telegram source. */
export const DEFAULT_SOURCE_TYPE: SourceType = "telegram";
