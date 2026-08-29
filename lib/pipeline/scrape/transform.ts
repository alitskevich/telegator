import type { DateKey } from "../../domain/date";
import { formatItemId } from "../../domain/ids";
import type { ItemKind, Link, ScrapedItem } from "../../domain/item";
import { ScrapedItemSchema } from "../../domain/item";
import type { Source } from "../../domain/source";

/**
 * §3.1 L212 — the per-post transform: a parsed post plus its source become one
 * Stage A item payload (§2.2 L120–130).
 *
 * "Per post: `id = \"{sourceId}/{messageId}\"`; strip the source's `teaser` from
 * the body; stamp `tgChannel`, `category`, `tags`, `date` = today; set `kind` to
 * `forward` (if forwarded), `empty` (blank body) or `post`."
 */

/**
 * The parse output of §3.1 L201–207, declared structurally rather than imported
 * from `lib/telegram/parse.ts`: this module needs only the shape, and depending
 * on the parser's module would couple the transform to the scraper's HTML layer
 * for no gain. Field names match the parser's exactly.
 */
export interface TransformInput {
  /** The Telegram message id alone — digits (§3.1 L201), not the composite id. */
  id: string;
  /** Already tokenised: inline links are `[text](#N)` (§3.1 L203). */
  body: string;
  links: Link[];
  image?: string;
  forwardedFrom?: string;
}

/**
 * Removes the source's teaser — the promotional tail an operator curates away
 * (§2.1 L106).
 *
 * §3.1 L212 says only "strip the source's `teaser` from the body" and leaves
 * three questions open. Recorded decisions, all three:
 *  - **All occurrences**, not the first: a teaser repeated as a header *and* a
 *    footer is the common Telegram shape, and leaving one behind would ship it.
 *  - **Case-sensitive**: `teaser` is operator-authored copy pasted from the
 *    channel, so it matches the post's casing already; a case-insensitive match
 *    would also eat ordinary prose that merely shares the wording.
 *  - **Re-trim afterwards**, since removing a trailing teaser leaves the
 *    separator whitespace §3.1 L205 had collapsed behind it, and that whitespace
 *    would otherwise decide `kind` below.
 *
 * Skipped entirely when the teaser is absent or empty — an empty needle would
 * match nothing yet still trim, changing a body the operator never asked to
 * touch.
 *
 * Note this runs on the **already tokenised** body (§3.1 L203), so a teaser
 * containing a link — `<a href="…">Subscribe</a>` in the channel's HTML — will
 * not match `[Subscribe](#1)` and will survive. Matching HTML would mean
 * running before tokenisation, which L212 places after parsing.
 */
function stripTeaser(body: string, teaser: string | undefined): string {
  if (teaser === undefined || teaser === "") {
    return body;
  }

  // split/join rather than a RegExp: the teaser is operator-supplied text, and
  // building a pattern from it would need escaping and could be made pathological.
  return body.split(teaser).join("").trim();
}

/**
 * §3.1 L212's classification. The order is normative: `forward` is tested
 * before `empty`, so a forwarded post with a blank body is a `forward`. Both
 * are dropped by §3.1 L214, but the counter metric there distinguishes them.
 *
 * An empty-string `forwardedFrom` counts as *not* forwarded — recorded decision;
 * the spec says "if forwarded", and a blank origin channel is the parser having
 * found no forward header rather than a real origin.
 *
 * Blankness is judged on the *stripped* body, following L212's own order: a post
 * that was nothing but the teaser is `empty`, which is what dropping it achieves.
 */
function classify(body: string, forwardedFrom: string | undefined): ItemKind {
  if (forwardedFrom !== undefined && forwardedFrom !== "") {
    return "forward";
  }
  return body.trim() === "" ? "empty" : "post";
}

/**
 * Builds one Stage A payload.
 *
 * `date` is a parameter rather than a clock reading: item 2.3 exports
 * `todayKey(clock)` and the orchestrator (item 3.5) calls it **once per run**,
 * so every post of a run shares one date key. That matters because §2.2 L127
 * makes the key both the dedup partition and the FIFO `MessageGroupId` — a run
 * that straddled midnight would otherwise split one batch across two groups.
 *
 * The result is parsed, not merely constructed: `ScrapedItemSchema` is the
 * contract the analyze stage reads, so a malformed post fails here rather than
 * inside a queue consumer.
 */
export function transformPost(post: TransformInput, source: Source, date: DateKey): ScrapedItem {
  const body = stripTeaser(post.body, source.teaser);

  return ScrapedItemSchema.parse({
    id: formatItemId(source.id, post.id),
    body,
    links: post.links,
    image: post.image,
    forwardedFrom: post.forwardedFrom,
    // Stamped from the source; §2.2 L128 lets the analyze stage overwrite
    // `category` and merge `tags`.
    tgChannel: source.tgChannel,
    category: source.category,
    tags: source.tags,
    date,
    kind: classify(body, post.forwardedFrom),
  });
}
