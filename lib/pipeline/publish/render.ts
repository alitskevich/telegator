import type { MemberBlock } from "../../domain/message.js";
import { MEMBER_RENDER_LIMIT } from "../../domain/message.js";

/**
 * Stage 4's member renderer (§3.4 L318–321).
 *
 * The rendered block is the only place a member's denormalized `summary` and
 * `links` (§2.3 L156–163) become visible, and it is produced fresh on every
 * publish — including the edit path of §3.4 L336 — so the output must depend on
 * the record alone, never on map iteration order or a locale.
 */

/** `[text](#N)` — §2.2 L122's inline-link token, as it survives into `summary`. */
const LINK_TOKEN = /\[([^\]]*)\]\(#(\d+)\)/g;

/**
 * §3.4 L342 sends with `parse_mode: html`, so every value interpolated into the
 * block must be escaped or Telegram parses it as markup — a summary containing
 * `<` or `&` otherwise yields broken tags or a rejected send. The spec does not
 * state this; it is a recorded correctness decision.
 *
 * Escaping happens *before* token substitution (see `renderMember`) so that the
 * anchors L319 introduces stay real markup while their text does not.
 */
function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * §3.4 L319 — resolve each `[text](#N)` against *this* member's links.
 *
 * `text` arrives already HTML-escaped, and `href` is escaped here, since it
 * lands inside an attribute. An unresolved N degrades to the plain text
 * (AC-4.4, L352) rather than leaving the token visible.
 */
function substituteLinks(escapedSummary: string, links: MemberBlock["links"]): string {
  return escapedSummary.replaceAll(LINK_TOKEN, (_match, text: string, id: string) => {
    const link = links.find((candidate) => candidate.id === Number(id));

    return link === undefined ? text : `<a href="${escapeHtml(link.href)}">${text}</a>`;
  });
}

/**
 * One member block: `🔘 {summary} - <a href="https://t.me/{itemId}">@{channel}</a>`
 * (§3.4 L321). `{content}` in the spec is the summary after L319's substitution;
 * `MemberBlock` has no field of that name.
 */
export function renderMember(itemId: string, block: MemberBlock): string {
  const content = substituteLinks(escapeHtml(block.summary), block.links);
  const href = `https://t.me/${escapeHtml(itemId)}`;

  return `🔘 ${content} - <a href="${href}">@${escapeHtml(block.channel)}</a>`;
}

/**
 * §3.4 L318 — members sorted by `ts` ascending, first `MEMBER_RENDER_LIMIT`,
 * one block per line.
 *
 * The item-id tiebreak is a recorded decision beyond the spec: one aggregate
 * batch can stamp several members with the same clock reading (§3.3 L285), and
 * `ts` alone would then leave their order to `Object.entries`. A reordering
 * changes the rendered bytes, so AC-3.7's byte-identical replay — and the
 * "no visible change" contract of an idempotent edit (AC-4.6) — depends on the
 * order being total. The comparison is `<`/`>` on the raw id rather than
 * `localeCompare`, whose result varies with the runtime's ICU data and locale
 * and so would reintroduce exactly the instability it is meant to remove.
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
