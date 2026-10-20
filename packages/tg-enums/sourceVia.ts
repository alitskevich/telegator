/**
 * R63 — how a source is read.
 *
 * `web` is §3.1 L207's anonymous `t.me/s/{id}` preview, which serves public
 * channels only. `mtproto` reads through a logged-in user account (GramJS), so
 * it also reaches groups and chats the preview cannot render.
 */
export const SOURCE_VIAS = ["web", "mtproto"] as const;

export type SourceVia = (typeof SOURCE_VIAS)[number];

/** R63 — an absent `via` is `web`: every source predating the field is a preview source. */
export const DEFAULT_SOURCE_VIA: SourceVia = "web";
