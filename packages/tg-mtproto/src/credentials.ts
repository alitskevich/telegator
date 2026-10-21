import { z } from "zod";

/**
 * What the `MTPROTO_SESSION` function secret holds, as one JSON string: the
 * app's `api_id`/`api_hash` from my.telegram.org and the `StringSession` that
 * `scripts/mtproto-login.ts` saved. The session **is a login to the operator's
 * Telegram account**, so it lives in the function secret and nowhere else.
 */

/** my.telegram.org issues `api_hash` as 32 lowercase hex digits. */
const API_HASH_PATTERN = /^[0-9a-f]{32}$/;

export const MtprotoCredentialsSchema = z.object({
  apiId: z.number().int().positive(),
  apiHash: z.string().regex(API_HASH_PATTERN, "expected a 32-digit hex api_hash"),
  session: z.string().min(1),
});

export type MtprotoCredentials = z.infer<typeof MtprotoCredentialsSchema>;

/**
 * Parses the secret string. The error names the fields, never the value: a parse
 * failure is logged, and echoing the input would log the account login.
 */
export function parseMtprotoCredentials(secret: string): MtprotoCredentials {
  let json: unknown;
  try {
    json = JSON.parse(secret);
  } catch {
    throw new Error("the MTProto secret is not JSON; expected {apiId, apiHash, session}");
  }

  const parsed = MtprotoCredentialsSchema.safeParse(json);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`the MTProto secret is malformed at: ${fields}`);
  }

  return parsed.data;
}
