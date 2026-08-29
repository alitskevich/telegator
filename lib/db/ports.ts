import type {
  DedupCandidate,
  MemberBlock,
  Message,
  MessageListItem,
  MessageMergeAttributes,
  MessageStatus,
} from "../domain/message.js";
import type { Source, SourceCursor } from "../domain/source.js";

/**
 * The two table boundaries, as interfaces.
 *
 * DynamoDB is unreachable from the build machine and §11.1 L844's DynamoDB
 * Local needs Docker, so every table access goes through one of these with an
 * in-memory fake behind it (R18). The interfaces are shaped by the access
 * patterns §7.2 L587–588 indexes for, not by a generic CRUD surface: a repo
 * that offered `scan` would invite §1.3 L47's forbidden table scan.
 */

export interface SourceRepo {
  get(id: string): Promise<Source | undefined>;
  /** §3.1 L187 — `status-index`. Excludes soft-deleted sources (R16). */
  listByStatus(status: string): Promise<Source[]>;
  put(source: Source): Promise<void>;
  /**
   * §3.1 L216 — the cursor write that happens only after the enqueue succeeds.
   * A patch, not a replacement: writing the whole record would undo an
   * operator's concurrent edit to `category` or `teaser`.
   */
  updateCursor(id: string, cursor: SourceCursor): Promise<void>;
}

/**
 * R9's attribute-level merge: one `SET #members.#itemId = :block` per member,
 * plus the scalar attributes.
 *
 * `members` is a map rather than a single block because one batch can absorb
 * several items into the same message (§6 L544 keys `pending` by message id).
 * Emitting one write per member instead would publish an intermediate
 * `memberCount` that disagrees with the map — a state §2.3 L145's invariant
 * forbids and `MessageSchema` rejects.
 */
export interface MemberMerge {
  readonly id: string;
  readonly members: Readonly<Record<string, MemberBlock>>;
  readonly attributes: MessageMergeAttributes;
}

/** §3.4 L345 — the result write after a successful send or edit. */
export interface PublishResult {
  readonly id: string;
  readonly tgId: string;
  readonly tgAt: number;
  readonly ts: number;
}

export interface MessageRepo {
  /** §3.4 L316 and R9 — a base-table read, the only access that returns `members`. */
  get(id: string): Promise<Message | undefined>;
  /** §6 L515 — `date-index`, projecting the embedding and nothing else that matters. */
  queryByDate(date: string): Promise<DedupCandidate[]>;
  /** §8.5 L772 — `status-index`, `ts` descending. */
  queryByStatus(status: MessageStatus, limit?: number): Promise<MessageListItem[]>;
  /** §6 L539's create branch — a whole new record. */
  putNew(message: Message): Promise<void>;
  /**
   * §6 L527's merge branch, written attribute-level.
   *
   * This is R9's resolution. §6 L547 says "WRITE pending.values()", which reads
   * as a whole-record put; §2.3 L168 describes the same write as "writes
   * `members.{itemId}` with the same value — a no-op. No conditional
   * expression". The attribute-level form is the one that is actually
   * idempotent and the one that cannot erase a member it never loaded.
   */
  mergeMember(merge: MemberMerge): Promise<void>;
  markPublished(result: PublishResult): Promise<void>;
}
