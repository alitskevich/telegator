import { z } from "zod";
import { DateKeySchema } from "./date.js";
import { ItemIdSchema } from "./ids.js";
import { LinkSchema, SUMMARY_MAX_LENGTH } from "./item.js";

/**
 * `messages` — aggregated, publishable stories (§2.3 L136–152).
 *
 * The only durable record of a Telegram post: §1.3 L43 keeps work-in-flight on
 * SQS, so a post becomes durable only when it is absorbed into a message, and it
 * is stored *inside* that message rather than beside it.
 */

/** §2.3 L149 — the target channel a message falls back to. */
export const DEFAULT_TG_CHANNEL = "telegator_news";

/** §3.4 L318 — publish renders the first 12 members, though 20 are stored. */
export const MEMBER_RENDER_LIMIT = 12;

/** §2.3 L143. `error` currently has no writer — see R17. */
export const MESSAGE_STATUSES = ["topublish", "published", "error"] as const;

export const MessageStatusSchema = z.enum(MESSAGE_STATUSES);
export type MessageStatus = z.infer<typeof MessageStatusSchema>;

/**
 * §2.3 L156–163 — everything `publish` needs to render one item, captured at
 * aggregation time.
 *
 * This is what §1.3 L48's denormalization requirement buys: publish has no item
 * table to read, so the renderable content travels inside the message.
 */
export const MemberBlockSchema = z.object({
  /** Belarusian summary, with `[text](#N)` tokens still intact (§2.3 L158). */
  summary: z.string().max(SUMMARY_MAX_LENGTH),
  links: z.array(LinkSchema).default([]),
  /** Source channel segment, for the `@mention` §3.4 L321 renders. */
  channel: z.string(),
  /** When this member joined — §3.4 L318 sorts by it for stable ordering. */
  ts: z.number().int().nonnegative(),
});

export type MemberBlock = z.infer<typeof MemberBlockSchema>;

/**
 * The field list of §2.3 L140–152, closed.
 *
 * R7: §6 L528/L539 build the record as `{...item, …}`, which would also write
 * `body`, `links`, `kind`, `importance`, `properNames` and `forwardedFrom` —
 * none of which §2.3 declares. That spread is shorthand for "the item's
 * descriptive fields overwrite" (§3.3 L285); this table is the schema, and
 * unlisted keys are stripped.
 */
const messageFields = z.object({
  /** Id of the **first** item that created the message (§2.3 L142). */
  id: ItemIdSchema,
  status: MessageStatusSchema,
  members: z.record(ItemIdSchema, MemberBlockSchema),
  /** Cached `size(members)`, so the dashboard need not read the map (§2.3 L145). */
  memberCount: z.number().int().nonnegative(),
  /** Packed `Float32Array`, 1024 dims (§7.2 L590). Absent until aggregate embeds;
   * §6 L508 guards against an empty one. */
  embedding: z.instanceof(Uint8Array).optional(),
  date: DateKeySchema,

  // Copied or merged from member items (§2.3 L148).
  title: z.string().optional(),
  category: z.string().optional(),
  country: z.string().optional(),
  location: z.string().optional(),
  peoples: z.string().optional(),
  tags: z.string().optional(),
  image: z.string().optional(),

  tgChannel: z.string().default(DEFAULT_TG_CHANNEL),

  /** Telegram `message_id`. Its presence turns the next publish into an edit (§2.3 L150). */
  tgId: z.string().optional(),
  tgAt: z.number().int().nonnegative().optional(),

  /**
   * Last-write epoch ms, and the sort key on **both** GSIs (§2.3 L152, §7.2 L588).
   * Required, per R8: §6 sets it on neither branch, and a record without it is
   * absent from `status-index` and `date-index` — invisible to the very query
   * that would have found it.
   */
  ts: z.number().int().nonnegative(),

  /** R16 — §8.4 L751 mandates a soft delete; §2.3's table never declares it. */
  deleted: z.boolean().optional(),
});

/**
 * A stored message.
 *
 * The refinement enforces §2.3 L145's cache invariant. §6 L543 recomputes
 * `memberCount` on every write, so a disagreement is a stage bug — and one
 * nothing downstream repairs, since the dashboard reads the cached number
 * without the map.
 */
export const MessageSchema = messageFields.refine(
  (m) => m.memberCount === Object.keys(m.members).length,
  { message: "memberCount must equal the size of members (§2.3 L145)", path: ["memberCount"] },
);

export type Message = z.infer<typeof MessageSchema>;

/**
 * The `status-index` projection (§7.2 L598, R27).
 *
 * §7.2 excludes `embedding` and `members` — the two large attributes — and says
 * "Nothing projects `members`". Giving the projection its own type means
 * dashboard code cannot read an attribute the query did not return; §8.3 L742's
 * expandable member list is a lazy base-table read instead (R26).
 */
export const MessageListItemSchema = messageFields.omit({ members: true, embedding: true });

export type MessageListItem = z.infer<typeof MessageListItemSchema>;
