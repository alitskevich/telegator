import type { DateKey } from "tg-domain/date";
import { formatItemId } from "tg-domain/ids";
import type { ScrapedItem } from "tg-domain/item";
import { ScrapedItemSchema } from "tg-domain/item";
import type { Source } from "tg-domain/source";
import type { ChannelPost } from "tg-domain/types";
import type { ItemKind } from "tg-enums/itemKind";

/**
 * The per-post transform: a parsed post plus its source become one item for
 * analyze. Sets the id, strips the teaser, stamps the source settings and the
 * date, and sets `kind`.
 */

/** What the MTProto reader produces. */
export type TransformInput = ChannelPost;

/** Posts older than this are obsolete. */
export const MAX_POST_AGE_DAYS = 3;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;

export const MAX_POST_AGE_MS =
  MAX_POST_AGE_DAYS * HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND;

/**
 * Is this post too old to be news? A post exactly at the cutoff is kept.
 *
 * A missing or unparseable time counts as obsolete: the page dates every post,
 * so a missing date means the markup changed, and the opposite default would
 * republish a channel's whole history. Such a change shows as `ItemsDropped`
 * with reason `obsolete`.
 */
function isObsolete(postedAt: string | undefined, now: number): boolean {
  if (postedAt === undefined) {
    return true;
  }
  const published = Date.parse(postedAt);
  return Number.isNaN(published) || now - published > MAX_POST_AGE_MS;
}

/**
 * Removes the source's teaser, the promotional text an operator curates away.
 * Every occurrence, case-sensitive, then the body is trimmed again. An absent
 * or empty teaser leaves the body untouched.
 *
 * It runs on the tokenised body, so a teaser that contains a link does not match.
 */
function stripTeaser(body: string, teaser: string | undefined): string {
  if (teaser === undefined || teaser === "") {
    return body;
  }

  // split/join, not a RegExp: the teaser is operator text and would need escaping.
  return body.split(teaser).join("").trim();
}

/**
 * The post's kind: `obsolete`, then `forward`, then `empty` or `post`. An empty
 * `forwardedFrom` is not a forward. Blankness is judged after the teaser is
 * stripped, so a post that was only the teaser is `empty`.
 */
function classify(
  body: string,
  forwardedFrom: string | undefined,
  postedAt: string | undefined,
  now: number,
): ItemKind {
  // Age first: a stale forward is counted as stale.
  if (isObsolete(postedAt, now)) {
    return "obsolete";
  }
  if (forwardedFrom !== undefined && forwardedFrom !== "") {
    return "forward";
  }
  return body.trim() === "" ? "empty" : "post";
}

/**
 * Builds one item for analyze.
 *
 * `date` is passed in, read once per run, so every post of a run shares one
 * dedup partition even across midnight. The result is parsed, so a malformed
 * post fails here rather than in a queue consumer.
 */
export function transformPost(
  post: TransformInput,
  source: Source,
  date: DateKey,
  now: number,
): ScrapedItem {
  const body = stripTeaser(post.body, source.teaser);

  return ScrapedItemSchema.parse({
    id: formatItemId(source.id, post.id),
    body,
    links: post.links,
    image: post.image,
    forwardedFrom: post.forwardedFrom,
    // Stamped from the source. Analyze may overwrite `category` and merges
    // `tags`, which publish routes by.
    category: source.category,
    tags: source.tags,
    date,
    kind: classify(body, post.forwardedFrom, post.postedAt, now),
  });
}
