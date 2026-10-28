import { defineBoolean, defineSecret, defineString } from "firebase-functions/params";

/** The secrets and params the scheduled functions read. */

/** JSON: `{apiId, apiHash, session}` of the reading account. */
export const mtprotoSession = defineSecret("MTPROTO_SESSION");

/** JSON: `{clientId, clientSecret, refreshToken}` of the playlist owner. */
export const youtubeOAuth = defineSecret("YOUTUBE_OAUTH");

/** Off until an operator turns it on, so a first deploy does not start posting. */
export const scrapeEnabled = defineBoolean("SCRAPE_ENABLED", { default: false });
/** The playlist the YouTube absorber works through; empty keeps it off. */
export const youtubePlaylist = defineString("YOUTUBE_PLAYLIST_ID", { default: "" });
