import { MEMBER_RENDER_LIMIT } from "tg-configs/dedup";
import type { MemberBlock } from "tg-domain/message";
import { escapeHtml } from "./escape";

/**
 * The member renderer. It runs on every publish, edits included, so the output
 * depends on the record alone, never on map order or a locale.
 */

/** The `[text](#N)` link token, as it survives into `summary`. */
const LINK_TOKEN = /\[([^\]]*)\]\(#(\d+)\)/g;

/**
 * Resolves each `[text](#N)` against this member's links. `text` is already
 * escaped; `href` is escaped here. An unresolved N degrades to plain text.
 */
function substituteLinks(escapedSummary: string, links: MemberBlock["links"]): string {
  return escapedSummary.replaceAll(LINK_TOKEN, (_match, text: string, id: string) => {
    const link = links.find((candidate) => candidate.id === Number(id));

    return link === undefined ? text : `<a href="${escapeHtml(link.href)}">${text}</a>`;
  });
}

/**
 * One member block: `🔘 {summary} - <a href="https://t.me/{itemId}">@{channel}</a>`.
 */
export function renderMember(itemId: string, block: MemberBlock): string {
  const content = substituteLinks(escapeHtml(block.summary), block.links);
  const href = `https://t.me/${escapeHtml(itemId)}`;

  return `🔘 ${content} - <a href="${href}">@${escapeHtml(block.channel)}</a>`;
}

/**
 * Members sorted by `ts` ascending, the first `MEMBER_RENDER_LIMIT`, one block
 * per line.
 *
 * Several members can share a `ts`, so the item id breaks ties: a replay must
 * render the same bytes. The id is compared with `<`, not `localeCompare`,
 * whose result depends on the runtime's locale.
 */
export function renderMembers(members: Record<string, MemberBlock>): string {
  return Object.entries(members)
    .sort(([idA, a], [idB, b]) => {
      if (a.ts !== b.ts) {
        return a.ts - b.ts;
      }

      if (idA === idB) {
        return 0;
      }

      return idA < idB ? -1 : 1;
    })
    .slice(0, MEMBER_RENDER_LIMIT)
    .map(([itemId, block]) => renderMember(itemId, block))
    .join("\n");
}
