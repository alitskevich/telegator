import { z } from "zod";

/**
 * What the `YOUTUBE_OAUTH` function secret holds, as one JSON string: a Desktop
 * OAuth client and the refresh token `scripts/youtube-login.ts` obtained. The
 * token can edit the owner's YouTube playlists, so it lives in the secret only.
 */

export const YoutubeCredentialsSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  refreshToken: z.string().min(1),
});

export type YoutubeCredentials = z.infer<typeof YoutubeCredentialsSchema>;

/** Parses the secret string. The error names the fields, never the value, which gets logged. */
export function parseYoutubeCredentials(secret: string): YoutubeCredentials {
  let json: unknown;
  try {
    json = JSON.parse(secret);
  } catch {
    throw new Error(
      "the YouTube secret is not JSON; expected {clientId, clientSecret, refreshToken}",
    );
  }

  const parsed = YoutubeCredentialsSchema.safeParse(json);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`the YouTube secret is malformed at: ${fields}`);
  }

  return parsed.data;
}
