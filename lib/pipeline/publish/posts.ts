import type { Message, Post } from "../../domain/message";
import { resolveTargets } from "../../domain/target";

/** A legacy post with no `tgAt` is older than any `ts`, so it is never current. */
const LEGACY_TG_AT = 0;

export type PostMap = Readonly<Record<string, Post>>;

/**
 * multi-target#5.2 — the post a target already has: from the map, or — for the
 * first target only — from the frozen `tgId`/`tgAt` pair a message published
 * before the map carries (R55). A legacy message has one post, on its single
 * channel, and that channel is the first (only) entry of its list, so the next
 * publish is an edit rather than a duplicate (base E2E-4).
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
 * multi-target D4 — a post at or after the message's last write needs no send.
 * Telegram rejects an edit that changes nothing, which would loop a partial
 * retry into the DLQ; republish bumps `ts` so every post goes stale at once.
 */
export function isCurrent(post: Post, message: Pick<Message, "ts">): boolean {
  return post.tgAt >= message.ts;
}
