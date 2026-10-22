import type { QueryDocumentSnapshot } from "firebase-admin/firestore";
import { AuditEntrySchema, RejectedSendSchema } from "tg-domain/audit";
import type { z } from "zod";
import { db } from "./app";
import type { StoredAuditEntry, StoredRejectedSend } from "./types";

/**
 * `audit`: an append-only record of what went wrong: each rejected send and each
 * item that used up its attempts. The `ingest` error goes when an operator
 * replays or discards it; this stays until the TTL policy deletes it.
 */

export const auditRef = db.collection("audit");

/** How long an entry stays before the TTL policy deletes it. */
const AUDIT_TTL_MS = 30 * 86_400_000;
/** The most ids one `in` filter takes. */
const IN_MAX = 30;

const parse = (snap: QueryDocumentSnapshot): StoredAuditEntry => ({
  ...AuditEntrySchema.parse(snap.data()),
  id: snap.id,
});

export async function recordAudit(entry: z.input<typeof AuditEntrySchema>): Promise<void> {
  const parsed = AuditEntrySchema.parse(entry);
  await auditRef.add({ ...parsed, expireAt: new Date(parsed.at + AUDIT_TTL_MS) });
}

/** Newest first. */
export async function listAudit(limit: number): Promise<StoredAuditEntry[]> {
  const snap = await auditRef.orderBy("at", "desc").limit(limit).get();
  return snap.docs.map(parse);
}

/** One message's rejected sends, newest first. */
export async function listAuditFor(messageId: string): Promise<StoredRejectedSend[]> {
  const snap = await auditRef.where("messageId", "==", messageId).orderBy("at", "desc").get();
  return snap.docs.map((doc) => ({ ...RejectedSendSchema.parse(doc.data()), id: doc.id }));
}

const AuditKeySchema = RejectedSendSchema.pick({ messageId: true, target: true, at: true });

/** Every entry of these messages, with only where and when it failed. */
export async function listAuditKeys(
  messageIds: readonly string[],
): Promise<z.infer<typeof AuditKeySchema>[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < messageIds.length; i += IN_MAX) {
    chunks.push(messageIds.slice(i, i + IN_MAX));
  }
  const snaps = await Promise.all(
    chunks.map((ids) =>
      auditRef.where("messageId", "in", ids).select("messageId", "target", "at").get(),
    ),
  );
  return snaps.flatMap((snap) => snap.docs.map((doc) => AuditKeySchema.parse(doc.data())));
}
