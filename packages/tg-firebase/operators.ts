import { z } from "zod";
import { auth, db, isEmulator } from "./app";

/**
 * Console operators: one `users/{uid}` document per Firebase Auth account.
 *
 * A first sign-in creates the document **disabled with no roles**; an admin
 * enables it by hand. It is read on every call, so disabling someone takes
 * effect at once rather than when their token expires.
 *
 * Under the emulator the first sign-in is an enabled admin instead, so local
 * development needs no manual step. The token is still verified.
 */
export const OperatorSchema = z.object({
  uid: z.string(),
  email: z.string().optional(),
  roles: z.array(z.string()).default([]),
  enabled: z.boolean().default(false),
});

export type Operator = z.infer<typeof OperatorSchema>;

const BEARER = /^Bearer\s+(\S+)$/i;

/** The operator behind an `Authorization: Bearer` header, or null when there is none or it is invalid. */
export async function operatorFrom(header: string | undefined): Promise<Operator | null> {
  const token = BEARER.exec(header?.trim() ?? "")?.[1];
  if (token === undefined) return null;

  let uid: string;
  let email: string | undefined;
  try {
    ({ uid, email } = await auth.verifyIdToken(token));
  } catch {
    return null;
  }

  const ref = db.collection("users").doc(uid);
  const snap = await ref.get();
  if (snap.exists) return OperatorSchema.parse({ ...snap.data(), uid });

  const created: Operator = isEmulator
    ? { uid, email, roles: ["admin"], enabled: true }
    : { uid, email, roles: [], enabled: false };
  await ref.set(created);
  return created;
}
