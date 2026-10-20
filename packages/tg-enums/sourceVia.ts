/**
 * How a source is read. `web` is the anonymous `t.me/s/{id}` preview, which
 * serves public channels only. `mtproto` reads through a logged-in user account
 * (GramJS), so it also reaches groups and chats the preview cannot render.
 */
export const SOURCE_VIAS = ["web", "mtproto"] as const;

export type SourceVia = (typeof SOURCE_VIAS)[number];

/** An absent `via` is `web`: every source older than the field is a preview source. */
export const DEFAULT_SOURCE_VIA: SourceVia = "web";
