import type {
  DedupCandidate,
  MemberBlock,
  Message,
  MessageListItem,
  MessageMergeAttributes,
  MessageStatus,
  Post,
} from "../domain/message";
import type { Source, SourceCursor } from "../domain/source";
import type { Target } from "../domain/target";

/**
 * The two table boundaries, as interfaces.
 *
 * DynamoDB is unreachable from the build machine and §10.1 L986's DynamoDB
 * Local needs Docker, so every table access goes through one of these with an
 * in-memory fake behind it (R18). The interfaces are shaped by the access
 * patterns §7.2 L633–634 indexes for, not by a generic CRUD surface: a repo
 * that offered `scan` would invite §1.3 L67's forbidden table scan.
 */

export interface SourceRepo {
  get(id: string): Promise<Source | undefined>;
  /** §3.1 L199 — `status-index`. Excludes soft-deleted sources (R16). */
  listByStatus(status: string): Promise<Source[]>;
  put(source: Source): Promise<void>;
  /**
   * §3.1 L228 — the cursor write that happens only after the enqueue succeeds.
   * A patch, not a replacement: writing the whole record would undo an
   * operator's concurrent edit to `category` or `teaser`.
   */
  updateCursor(id: string, cursor: SourceCursor): Promise<void>;
  /**
   * §8.3 L797 and §8.4 L812 — every source, whatever its status.
   *
   * `listByStatus` cannot answer this: the Sources table shows a status column,
   * so a disabled source has to appear in it, and an export that silently
   * omitted them would be wrong in a way nobody could see.
   */
  listAll(): Promise<Source[]>;
  /** §8.4 L808 — an operator edit, attribute-level. The caller validates the delta. */
  patch(id: string, delta: Readonly<Record<string, unknown>>): Promise<void>;
  /** §8.4 L810 — soft delete. The row survives; R16 hides it from reads. */
  softDelete(ids: readonly string[]): Promise<void>;
}

/** target-table#5.3 — the two mirror fields publish writes after a send (D3, D4). */
export interface LastPost {
  readonly lastPostedDate: string;
  readonly lastPostedMessageId: string;
}

/**
 * The `targets` registry (target-table#2.2, R56).
 *
 * No `query`: the table carries no index (D8), and offering one would invite a
 * caller to assume an access pattern the table cannot serve.
 */
export interface TargetRepo {
  /** target-table#5.3 — publish's per-target read. Soft-deleted rows come back too. */
  get(id: string): Promise<Target | undefined>;
  /** §8.3 L797's table, as for sources: a Scan, soft-deleted rows filtered. */
  listAll(): Promise<Target[]>;
  /** §8.4 L808 — an operator create. */
  put(target: Target): Promise<void>;
  /** §8.4 L808 — an operator edit, attribute-level. The caller validates the delta. */
  patch(id: string, delta: Readonly<Record<string, unknown>>): Promise<void>;
  /** target-table#5.3 — the two mirror fields, creating the row if absent (D5). */
  recordLastPost(id: string, post: LastPost): Promise<void>;
  /** §8.4 L810 — soft delete. The row survives; `listAll` hides it. */
  softDelete(ids: readonly string[]): Promise<void>;
}

/**
 * R9's attribute-level merge: one `SET #members.#itemId = :block` per member,
 * plus the scalar attributes.
 *
 * `members` is a map rather than a single block because one batch can absorb
 * several items into the same message (§6 L581 keys `pending` by message id).
 * Emitting one write per member instead would publish an intermediate
 * `memberCount` that disagrees with the map — a state §2.3 L155's invariant
 * forbids and `MessageSchema` rejects.
 */
export interface MemberMerge {
  readonly id: string;
  readonly members: Readonly<Record<string, MemberBlock>>;
  readonly attributes: MessageMergeAttributes;
}

/** multi-target#6 — the status write once every target has a current post. */
export interface PublishResult {
  readonly id: string;
  readonly ts: number;
}

/** multi-target#6, D5 — the whole post map, written after every send. */
export interface PostsRecord {
  readonly id: string;
  readonly posts: Readonly<Record<string, Post>>;
}

export interface MessageRepo {
  /** §3.4 L317 and R9 — a base-table read, the only access that returns `members`. */
  get(id: string): Promise<Message | undefined>;
  /** §6 L560 — `date-index`, projecting the match key (R44) and nothing else that matters. */
  queryByDate(date: string): Promise<DedupCandidate[]>;
  /** §8.5 L832 — `status-index`, `ts` descending. */
  queryByStatus(status: MessageStatus, limit?: number): Promise<MessageListItem[]>;
  /**
   * §8.5 L828 — the "Messages published" card, window "all".
   *
   * A count rather than a list length: the archive only grows, and fetching
   * every published message to measure it would make the cheapest card on the
   * page the most expensive query on it.
   */
  countByStatus(status: MessageStatus): Promise<number>;
  /** §6 L584's create branch — a whole new record. */
  putNew(message: Message): Promise<void>;
  /**
   * §6 L581's merge branch, written attribute-level.
   *
   * This is R9's resolution. §6 L586 says "WRITE pending.values()", which reads
   * as a whole-record put; §2.3 L180 describes the same write as "writes
   * `members.{itemId}` with the same value — a no-op. No conditional
   * expression". The attribute-level form is the one that is actually
   * idempotent and the one that cannot erase a member it never loaded.
   */
  mergeMember(merge: MemberMerge): Promise<void>;
  /** multi-target#6 — `SET status, ts`; `tgId`/`tgAt` are frozen (R55). */
  markPublished(result: PublishResult): Promise<void>;
  /** multi-target#6, D5 — `SET posts = :posts`, the whole map. Publish is the only writer. */
  recordPosts(record: PostsRecord): Promise<void>;
  /** §8.4 L808 — an operator edit, attribute-level. The caller validates the delta. */
  patch(id: string, delta: Readonly<Record<string, unknown>>): Promise<void>;
  /** §8.4 L810 — soft delete. The row survives; R16 hides it from reads. */
  softDelete(ids: readonly string[]): Promise<void>;
}
