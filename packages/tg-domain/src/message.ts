import { MessageStatusSchema } from "tg-enums/messageStatus";
import { z } from "zod";
import { DateKeySchema } from "./date";
import { ItemIdSchema } from "./ids";
import { LinkSchema, SUMMARY_MAX_LENGTH } from "./item";

/**
 * `messages`: aggregated, publishable stories (docs/telegator.md §2.3). The only
 * durable record of a post: a post in flight lives on the queue and is stored
 * *inside* the message that absorbs it.
 */

/** The target channel a message falls back to. */
export const DEFAULT_TG_CHANNEL = "telegator_news";

/**
 * Everything publish needs to render one item, captured by aggregate: there is
 * no item collection to read, so the content travels inside the message.
 */
export const MemberBlockSchema = z.object({
  /** Belarusian summary, with `[text](#N)` tokens still intact. */
  summary: z.string().max(SUMMARY_MAX_LENGTH),
  links: z.array(LinkSchema).default([]),
  /** Source channel segment, for the rendered `@mention`. */
  channel: z.string(),
  /** When this member joined; publish sorts by it for a stable order. */
  ts: z.number().int().nonnegative(),
});

export type MemberBlock = z.infer<typeof MemberBlockSchema>;

/**
 * One Telegram post on one target. Declared here, not in `./target`, because
 * `./target` imports this module and the cycle would throw.
 */
export const PostSchema = z.object({
  /** Telegram `message_id` on that target. */
  tgId: z.string(),
  /** Epoch ms of the send or edit that produced it. */
  tgAt: z.number().int().nonnegative(),
});

export type Post = z.infer<typeof PostSchema>;

/**
 * The message fields, closed: item fields such as `body`, `kind` or
 * `forwardedFrom` are stripped if a caller spreads an item in.
 */
const messageFields = z.object({
  /** Id of the **first** item, which created the message. */
  id: ItemIdSchema,
  status: MessageStatusSchema,
  members: z.record(ItemIdSchema, MemberBlockSchema),
  /** Cached `size(members)`, so the dashboard need not read the map. */
  memberCount: z.number().int().nonnegative(),
  /**
   * The dedup match key (docs/telegator.md §5). Defaulted, so an old message
   * without one parses as an empty key, which scores 0 and never matches.
   * Plain arrays rather than `MatchKey`, because `tg-dedup` imports this package.
   */
  keyEntities: z.array(z.string()).default([]),
  keyTitle: z.array(z.string()).default([]),
  keyTags: z.array(z.string()).default([]),
  /**
   * The keys of `members`, kept beside the map so the replay check can use the
   * candidate query, which does not select `members`.
   */
  memberIds: z.array(z.string()).default([]),
  date: DateKeySchema,

  // Copied or merged from member items.
  title: z.string().optional(),
  category: z.string().optional(),
  country: z.string().optional(),
  location: z.string().optional(),
  peoples: z.string().optional(),
  tags: z.string().optional(),
  image: z.string().optional(),

  tgChannel: z.string().default(DEFAULT_TG_CHANNEL),

  /**
   * `{canonicalTargetId → Post}`, written by publish only. Defaulted so a
   * message written before the map parses.
   */
  posts: z.record(z.string(), PostSchema).default({}),

  /**
   * The legacy single-target post. No longer written; publish reads it so a
   * message published before `posts` is edited rather than posted twice.
   */
  tgId: z.string().optional(),
  tgAt: z.number().int().nonnegative().optional(),

  /** Last-write epoch ms. Required: the status query orders by it. */
  ts: z.number().int().nonnegative(),

  /** Soft delete. */
  deleted: z.boolean().optional(),
});

/**
 * A stored message. The refinement enforces the `memberCount` cache: a mismatch
 * is a stage bug that nothing repairs, since the dashboard reads the count alone.
 */
export const MessageSchema = messageFields.refine(
  (m) => m.memberCount === Object.keys(m.members).length,
  { message: "memberCount must equal the size of members", path: ["memberCount"] },
);

export type Message = z.infer<typeof MessageSchema>;

/**
 * The fields the console's message list selects. Its own type, so code cannot
 * read a field the query did not return; the member list is a separate read.
 */
export const MessageListItemSchema = messageFields.omit({
  members: true,
  keyEntities: true,
  keyTitle: true,
  keyTags: true,
  memberIds: true,
  posts: true,
});

export type MessageListItem = z.infer<typeof MessageListItemSchema>;

/**
 * The fields the dedup candidate query selects: the match key and `memberIds`.
 * Typed without `members`, so a whole-message write built from a candidate,
 * which would erase every member, does not compile. A merge writes per field
 * (`mergeMember`).
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
 * The scalar fields an aggregate merge writes alongside `members.{itemId}`.
 * `tgId` and `tgAt` are absent: publish owns them, and keeping them makes the
 * next publish an edit.
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
   * `status` is optional: a merge normally sets `topublish` so the live post is
   * edited, but a merge that changes nothing visible (a replay) must leave it,
   * or the message is re-published unchanged. `memberCount` and `ts` hold on
   * every write.
   */
  .required({ memberCount: true, ts: true });

export type MessageMergeAttributes = z.infer<typeof MessageMergeAttributesSchema>;
