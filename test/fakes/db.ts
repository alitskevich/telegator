import type { MemberMerge, MessageRepo, PublishResult, SourceRepo } from "../../lib/db/ports.js";
import {
  type DedupCandidate,
  DedupCandidateSchema,
  type Message,
  type MessageListItem,
  MessageListItemSchema,
  type MessageStatus,
} from "../../lib/domain/message.js";
import type { Source, SourceCursor } from "../../lib/domain/source.js";

export interface FakeSourceRepo extends SourceRepo {
  readonly writeCount: number;
}

export function fakeSourceRepo(initial: readonly Source[] = []): FakeSourceRepo {
  const rows = new Map(initial.map((s) => [s.id, { ...s }]));
  let writeCount = 0;

  return {
    get writeCount() {
      return writeCount;
    },
    get: async (id) => rows.get(id),
    listByStatus: async (status) =>
      [...rows.values()].filter((s) => s.status === status && s.deleted !== true),
    put: async (source) => {
      writeCount++;
      rows.set(source.id, { ...source });
    },
    updateCursor: async (id: string, cursor: SourceCursor) => {
      const existing = rows.get(id);
      if (existing === undefined) throw new Error(`no such source: ${id}`);
      writeCount++;
      // A patch: only the keys present in `cursor` are written, matching an
      // UpdateItem with a SET for each named attribute.
      rows.set(id, { ...existing, ...cursor });
    },
  };
}

export interface FakeMessageRepo extends MessageRepo {
  readonly writeCount: number;
}

/**
 * An in-memory `messages` table that honours the GSI projections of §7.2 L598.
 *
 * The projections are enforced, not simulated loosely: `queryByDate` returns
 * `DedupCandidate` and `queryByStatus` returns `MessageListItem`, both parsed
 * through their schemas so unprojected attributes are stripped. A fake that
 * returned whole records would let §6's Pass 2 read a `members` map the real
 * query never sends — hiding R9's defect until deployment.
 */
export function fakeMessageRepo(initial: readonly Message[] = []): FakeMessageRepo {
  const rows = new Map(initial.map((m) => [m.id, structuredClone(m)]));
  let writeCount = 0;

  const live = (): Message[] => [...rows.values()].filter((m) => m.deleted !== true);

  return {
    get writeCount() {
      return writeCount;
    },
    get: async (id) => {
      const row = rows.get(id);
      return row === undefined ? undefined : structuredClone(row);
    },
    queryByDate: async (date): Promise<DedupCandidate[]> =>
      live()
        .filter((m) => m.date === date)
        .map((m) => DedupCandidateSchema.parse(m)),
    queryByStatus: async (status: MessageStatus, limit?: number): Promise<MessageListItem[]> => {
      const listed = live()
        .filter((m) => m.status === status)
        .sort((a, b) => b.ts - a.ts)
        .map((m) => MessageListItemSchema.parse(m));

      return limit === undefined ? listed : listed.slice(0, limit);
    },
    countByStatus: async (status: MessageStatus): Promise<number> =>
      // Counts live rows only, matching R16's filter in the real adapter.
      live().filter((m) => m.status === status).length,
    putNew: async (message) => {
      writeCount++;
      rows.set(message.id, structuredClone(message));
    },
    mergeMember: async ({ id, members, attributes }: MemberMerge) => {
      const existing = rows.get(id);
      if (existing === undefined) throw new Error(`no such message: ${id}`);
      writeCount++;

      // One `SET #members.#itemId = :block` per member, plus a SET per named
      // scalar. tgId and tgAt are absent from MessageMergeAttributes, so they
      // survive untouched.
      rows.set(id, {
        ...existing,
        ...attributes,
        members: { ...existing.members, ...members },
      });
    },
    markPublished: async ({ id, tgId, tgAt, ts }: PublishResult) => {
      const existing = rows.get(id);
      if (existing === undefined) throw new Error(`no such message: ${id}`);
      writeCount++;
      rows.set(id, { ...existing, status: "published", tgId, tgAt, ts });
    },
  };
}
