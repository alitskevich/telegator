import { z } from "zod";
import { DateKeySchema } from "./date";
import { ItemIdSchema } from "./ids";
import { LinkSchema, SUMMARY_MAX_LENGTH } from "./item";

/**
 * `messages` — aggregated, publishable stories (§2.3 L146–163).
 *
 * The only durable record of a Telegram post: §1.3 L63 keeps work-in-flight on
 * SQS, so a post becomes durable only when it is absorbed into a message, and it
 * is stored *inside* that message rather than beside it.
 */

/** §2.3 L160 — the target channel a message falls back to. */
export const DEFAULT_TG_CHANNEL = "telegator_news";

/** §3.4 L319 — publish renders the first 12 members, though 20 are stored. */
export const MEMBER_RENDER_LIMIT = 12;

/** §2.3 L153. `error` currently has no writer — see R17. */
export const MESSAGE_STATUSES = ["topublish", "published", "error"] as const;

export const MessageStatusSchema = z.enum(MESSAGE_STATUSES);
export type MessageStatus = z.infer<typeof MessageStatusSchema>;

/**
 * §2.3 L168–175 — everything `publish` needs to render one item, captured at
 * aggregation time.
 *
 * This is what §1.3 L68's denormalization requirement buys: publish has no item
 * table to read, so the renderable content travels inside the message.
 */
export const MemberBlockSchema = z.object({
  /** Belarusian summary, with `[text](#N)` tokens still intact (§2.3 L170). */
  summary: z.string().max(SUMMARY_MAX_LENGTH),
  links: z.array(LinkSchema).default([]),
  /** Source channel segment, for the `@mention` §3.4 L322 renders. */
  channel: z.string(),
  /** When this member joined — §3.4 L319 sorts by it for stable ordering. */
  ts: z.number().int().nonnegative(),
});

export type MemberBlock = z.infer<typeof MemberBlockSchema>;

/**
 * The field list of §2.3 L150–163, closed.
 *
 * R7: §6 L581/L584 build the record as `{...item, …}`, which would also write
 * `body`, `links`, `kind`, `importance`, `properNames` and `forwardedFrom` —
 * none of which §2.3 declares. That spread is shorthand for "the item's
 * descriptive fields overwrite" (§3.3 L283); this table is the schema, and
 * unlisted keys are stripped.
 */
const messageFields = z.object({
  /** Id of the **first** item that created the message (§2.3 L152). */
  id: ItemIdSchema,
  status: MessageStatusSchema,
  members: z.record(ItemIdSchema, MemberBlockSchema),
  /** Cached `size(members)`, so the dashboard need not read the map (§2.3 L155). */
  memberCount: z.number().int().nonnegative(),
  /**
   * R43/R44 — the match key §7.2 L636 projects, in place of the embedding it
   * replaced. Rows written earlier keep an orphan `embedding` nothing reads.
   *
   * Defaulted rather than optional, so a pre-R44 record parses as an empty key.
   * An empty key scores 0 against everything (§6.2), so it never matches and
   * ages out of `date-index` — the whole of the migration story.
   *
   * Plain string arrays rather than `MatchKey`: `lib/dedup` already imports
   * from `lib/domain`, so importing it back would be a package-level cycle.
   */
  keyEntities: z.array(z.string()).default([]),
  keyTitle: z.array(z.string()).default([]),
  keyTags: z.array(z.string()).default([]),
  /**
   * R51 — the ids already in `members`, projected so AC-3.7's replay check
   * costs nothing.
   *
   * An item that CREATED a message is addressable as `loadMessage(item.id)`,
   * because §3.3's create branch sets `id` = item id. An item that MERGED is
   * not: its id lives only inside another message's `members` map, and R9
   * records that `date-index` projects no `members`. Without this attribute the
   * short-circuit would need a base-table read per candidate.
   */
  memberIds: z.array(z.string()).default([]),
  date: DateKeySchema,

  // Copied or merged from member items (§2.3 L159).
  title: z.string().optional(),
  category: z.string().optional(),
  country: z.string().optional(),
  location: z.string().optional(),
  peoples: z.string().optional(),
  tags: z.string().optional(),
  image: z.string().optional(),

  tgChannel: z.string().default(DEFAULT_TG_CHANNEL),

  /** Telegram `message_id`. Its presence turns the next publish into an edit (§2.3 L161). */
  tgId: z.string().optional(),
  tgAt: z.number().int().nonnegative().optional(),

  /**
   * Last-write epoch ms, and the sort key on **both** GSIs (§2.3 L163, §7.2 L634).
   * Required, per R8: §6 sets it on neither branch, and a record without it is
   * absent from `status-index` and `date-index` — invisible to the very query
   * that would have found it.
   */
  ts: z.number().int().nonnegative(),

  /** R16 — §8.4 L810 mandates a soft delete; §2.3's table never declares it. */
  deleted: z.boolean().optional(),
});

/**
 * A stored message.
 *
 * The refinement enforces §2.3 L155's cache invariant. §3.3 L279 recomputes
 * `memberCount` on every write, so a disagreement is a stage bug — and one
 * nothing downstream repairs, since the dashboard reads the cached number
 * without the map.
 */
export const MessageSchema = messageFields.refine(
  (m) => m.memberCount === Object.keys(m.members).length,
  { message: "memberCount must equal the size of members (§2.3 L155)", path: ["memberCount"] },
);

export type Message = z.infer<typeof MessageSchema>;

/**
 * The `status-index` projection (§7.2 L636, R27, amended by R44/R51).
 *
 * §7.2 L636 projects no `members`. Giving the projection its own type means
 * dashboard code cannot read an attribute the query did not return; §8.3 L798's
 * expandable member list is a lazy base-table read instead (R26).
 *
 * The match-key attributes are omitted for the same reason: `data-stack.ts`
 * does not project them, and being `.default([])` fields they would parse as
 * `[]` in production while the in-memory fake — which parses whole base records
 * — handed a caller populated ones. A test would then agree with a page that is
 * empty in production.
 */
export const MessageListItemSchema = messageFields.omit({
  members: true,
  keyEntities: true,
  keyTitle: true,
  keyTags: true,
  memberIds: true,
});

export type MessageListItem = z.infer<typeof MessageListItemSchema>;

/**
 * The `date-index` projection (§7.2 L634/L636, R27, amended by R44/R51).
 *
 * R44 projects the match key R46 scores on, and R51 adds `memberIds` for the
 * replay short-circuit. R43 removes `embedding` from the type; a stored record
 * may still carry an orphan one, which nothing here reads.
 *
 * §6 L560's Pass 2 reads its candidates from this index. Typing them without
 * `members` is what stops R9's defect at the type level: §3.3 L279/L282 read
 * `match.members`, which the real query never returns, so building a
 * whole-record write from a candidate would erase every existing member. A
 * merge must load the base record or write attribute-level (`mergeMember`).
 */
export const DedupCandidateSchema = messageFields.pick({
  id: true,
  date: true,
  ts: true,
  keyEntities: true,
  keyTitle: true,
  keyTags: true,
  memberIds: true,
  deleted: true,
});

export type DedupCandidate = z.infer<typeof DedupCandidateSchema>;

/**
 * The scalar attributes an aggregate merge SETs alongside `members.{itemId}`.
 *
 * `tgId` and `tgAt` are deliberately absent: §3.3 L284 preserves `tgId` so the
 * next publish is an edit (§2.3 L161), and R7 notes the §6 spread would
 * silently drop `tgAt`. Publish owns both; a merge must touch neither.
 */
export const MessageMergeAttributesSchema = messageFields
  .pick({
    memberCount: true,
    keyEntities: true,
    keyTitle: true,
    keyTags: true,
    memberIds: true,
    date: true,
    title: true,
    category: true,
    country: true,
    location: true,
    peoples: true,
    tags: true,
    image: true,
    tgChannel: true,
    status: true,
    ts: true,
  })
  .partial()
  /**
   * `status` is optional (R39). §6 L581's merge branch normally returns the
   * message to `topublish` so §3.4 L345 edits the live post with the new
   * member — but a merge that changes nothing a reader would see must leave the
   * status where it is, or every replayed message is re-published with its own
   * text. `memberCount` and `ts` stay required: §2.3 L155's invariant and §6
   * L593's stamp hold for every write.
   */
  .required({ memberCount: true, ts: true });

export type MessageMergeAttributes = z.infer<typeof MessageMergeAttributesSchema>;
