import type { Message, Post } from "tg-domain/message";
import { resolveTargets } from "tg-domain/target";

/** A legacy post with no `tgAt` is older than any `ts`, so it is never current. */
const LEGACY_TG_AT = 0;

export type PostMap = Readonly<Record<string, Post>>;

/**
 * The post a target already has: from the map, or, for the first target only,
 * from the legacy `tgId`/`tgAt` pair of a message published before the map
 * existed. The next publish is then an edit, not a duplicate.
 */
export function postFor(
  message: Pick<Message, "tgChannel" | "tgId" | "tgAt">,
  posts: PostMap,
  target: string,
): Post | undefined {
  const recorded = posts[target];
  if (recorded !== undefined) return recorded;

  const [first] = resolveTargets(message.tgChannel);
  if (target === first && typeof message.tgId === "string" && message.tgId !== "") {
    return { tgId: message.tgId, tgAt: message.tgAt ?? LEGACY_TG_AT };
  }

  return undefined;
}

/**
 * A post at or after the message's last write needs no send. Telegram rejects
 * an edit that changes nothing, which would loop a retry into an `error` item;
 * republish bumps `ts` so every post goes stale at once.
 */
export function isCurrent(post: Post, message: Pick<Message, "ts">): boolean {
  return post.tgAt >= message.ts;
}
