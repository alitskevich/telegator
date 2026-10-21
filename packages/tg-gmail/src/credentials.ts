import { z } from "zod";

/**
 * What the `GMAIL_OAUTH` function secret holds, as one JSON string: a Desktop
 * OAuth client and the refresh token `scripts/gmail-login.ts` obtained. The
 * token reads the whole mailbox, so it lives in the secret only.
 */

export const GmailCredentialsSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  refreshToken: z.string().min(1),
});

export type GmailCredentials = z.infer<typeof GmailCredentialsSchema>;

/** Parses the secret string. The error names the fields, never the value, which gets logged. */
export function parseGmailCredentials(secret: string): GmailCredentials {
  let json: unknown;
  try {
    json = JSON.parse(secret);
  } catch {
    throw new Error(
      "the Gmail secret is not JSON; expected {clientId, clientSecret, refreshToken}",
    );
  }

  const parsed = GmailCredentialsSchema.safeParse(json);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`the Gmail secret is malformed at: ${fields}`);
  }

  return parsed.data;
}
