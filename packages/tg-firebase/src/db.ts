import { FieldPath, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import {
  type DedupCandidate,
  DedupCandidateSchema,
  type MemberBlock,
  type Message,
  type MessageListItem,
  MessageListItemSchema,
  type MessageMergeAttributes,
  MessageSchema,
  type Post,
} from "tg-domain/message";
import { type Source, type SourceCursor, SourceSchema } from "tg-domain/source";
import { type Target, TargetSchema } from "tg-domain/target";
import { type Video, VideoSchema } from "tg-domain/video";
import type { MessageStatus } from "tg-enums/messageStatus";
import { type VideoStatus, VideoStatusSchema } from "tg-enums/videoStatus";
import type { z } from "zod";
import { db } from "./app";

/** Item ids are `{source}/{tgId}`, and a Firestore document id cannot hold a `/`. */
export const docId = (id: string): string => id.replaceAll("/", "~");

type Delta = Readonly<Record<string, unknown>>;

const notDeleted = <T extends { deleted?: boolean | undefined }>(row: T): boolean =>
  row.deleted !== true;

/** The operations every collection shares. Soft-deleted rows are hidden from lists. */
function collection<T extends { id: string; deleted?: boolean | undefined }>(
  name: string,
  schema: z.ZodType<T>,
) {
  const ref = db.collection(name);
  const doc = (id: string) => ref.doc(docId(id));
  const parse = (snap: QueryDocumentSnapshot) => schema.parse(snap.data());

  return {
    ref,
    doc,
    async get(id: string): Promise<T | undefined> {
      const snap = await doc(id).get();
      return snap.exists ? schema.parse(snap.data()) : undefined;
    },
    async listAll(): Promise<T[]> {
      return (await ref.get()).docs.map(parse).filter(notDeleted);
    },
    async put(row: T): Promise<void> {
      await doc(row.id).set(row);
    },
    /**
     * Attribute-level: an edit never overwrites fields it did not name. The `id`
     * goes with every write, so a patch that creates the document leaves it readable.
     */
    async patch(id: string, delta: Delta): Promise<void> {
      await doc(id).set({ ...delta, id }, { merge: true });
    },
    async softDelete(ids: readonly string[]): Promise<void> {
      const batch = db.batch();
      for (const id of ids) batch.set(doc(id), { id, deleted: true }, { merge: true });
      await batch.commit();
    },
  };
}

const sourceRows = collection("sources", SourceSchema);

export const sources = {
  ...sourceRows,
  async listByStatus(status: string): Promise<Source[]> {
    const snap = await sourceRows.ref.where("status", "==", status).get();
    return snap.docs.map((d) => SourceSchema.parse(d.data())).filter(notDeleted);
  },
  /** Written only after the source's posts are enqueued. */
  updateCursor: (id: string, cursor: SourceCursor) => sourceRows.patch(id, cursor),
};

const targetRows = collection("targets", TargetSchema);

export const targets = {
  ...targetRows,
  /** Creates the row when absent. */
  recordLastPost: (id: string, post: { lastPostedDate: string; lastPostedMessageId: string }) =>
    targetRows.patch(id, post),
};

/** Everything a list or a card shows; `members` is the one large field and stays out. */
const LIST_FIELDS = Object.keys(MessageListItemSchema.shape);

/** The dedup match key and nothing else. */
const CANDIDATE_FIELDS = Object.keys(DedupCandidateSchema.shape);

const messageRows = collection("messages", MessageSchema);

export const messages = {
  ...messageRows,
  async queryByDate(date: string): Promise<DedupCandidate[]> {
    const snap = await messageRows.ref
      .where("date", "==", date)
      .select(...CANDIDATE_FIELDS)
      .get();
    return snap.docs.map((d) => DedupCandidateSchema.parse(d.data())).filter(notDeleted);
  },
  /** Newest first. */
  async queryByStatus(status: MessageStatus, limit?: number): Promise<MessageListItem[]> {
    let query = messageRows.ref
      .where("status", "==", status)
      .where("deleted", "==", false)
      .orderBy("ts", "desc");
    if (limit !== undefined) query = query.limit(limit);
    const snap = await query.select(...LIST_FIELDS).get();
    return snap.docs.map((d) => MessageListItemSchema.parse(d.data()));
  },
  async countByStatus(status: MessageStatus): Promise<number> {
    const snap = await messageRows.ref
      .where("status", "==", status)
      .where("deleted", "==", false)
      .count()
      .get();
    return snap.data().count;
  },
  /** `deleted: false` is written so the status queries above can filter on it. */
  async putNew(message: Message): Promise<void> {
    await messageRows.doc(message.id).create({ ...message, deleted: false });
  },
  /** One `members.{itemId}` write per member, plus the scalars: idempotent on redelivery. */
  async mergeMember(merge: {
    id: string;
    members: Readonly<Record<string, MemberBlock>>;
    attributes: MessageMergeAttributes;
  }): Promise<void> {
    const fields: unknown[] = [];
    for (const [itemId, block] of Object.entries(merge.members)) {
      fields.push(new FieldPath("members", itemId), block);
    }
    for (const [name, value] of Object.entries(merge.attributes)) {
      if (value !== undefined) fields.push(name, value);
    }
    const [first, value, ...rest] = fields;
    await messageRows.doc(merge.id).update(first as FieldPath, value, ...rest);
  },
  async markPublished(id: string, ts: number): Promise<void> {
    await messageRows.doc(id).update({ status: "published", ts });
  },
  /** The whole post map, replaced. Publish is its only writer. */
  async recordPosts(id: string, posts: Readonly<Record<string, Post>>): Promise<void> {
    await messageRows.doc(id).update({ posts });
  },
};

const videoRows = collection("videos", VideoSchema);

export const videos = {
  ...videoRows,
  /** Every video's status, without `transcript`, the one large field. */
  async statuses(): Promise<Map<string, VideoStatus>> {
    const snap = await videoRows.ref.select("status").get();
    return new Map(snap.docs.map((d) => [d.id, VideoStatusSchema.parse(d.get("status"))]));
  },
  async listByStatus(status: VideoStatus): Promise<Video[]> {
    const snap = await videoRows.ref.where("status", "==", status).get();
    return snap.docs.map((d) => VideoSchema.parse(d.data())).filter(notDeleted);
  },
};

export type Messages = typeof messages;
export type Sources = typeof sources;
export type Targets = typeof targets;
export type Row = Source | Target | Message;
