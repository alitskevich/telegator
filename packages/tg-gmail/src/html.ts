import type { Link } from "tg-domain/item";

/**
 * A mail's HTML as a post body. String-level on purpose: no DOM, no HTML library.
 */

/** Link tokens are numbered from 1. */
const FIRST_LINK_ID = 1;

/** Real anchors carry `target`/`rel` after the href, so `[^>]*` on both sides. */
const ANCHOR_PATTERN = /<a\b[^>]*\shref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;

/** `<br/>` and a bare `<br>` alike. */
const LINE_BREAK_PATTERN = /<br\s*\/?>/gi;
const ANY_TAG_PATTERN = /<[^>]*>/g;

/**
 * The six named entities, in the order they must be applied.
 * `&amp;` is decoded **last**: decoding it first rewrites `&amp;lt;` to `&lt;`
 * and then to `<`, inventing markup the sender never wrote.
 */
const HTML_ENTITIES: ReadonlyArray<readonly [string, string]> = [
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&#39;", "'"],
  // A plain space rather than U+00A0: scrape strips a source's `teaser` from this
  // body by literal comparison, which an invisible non-breaking space breaks.
  ["&nbsp;", " "],
  ["&amp;", "&"],
];

/** Runs of 3+ whitespace collapse to `\n\n`. */
const RUN_OF_WHITESPACE_PATTERN = /\s{3,}/g;

/** `<a href="X">Y</a>` → `[Y](#N)`, collecting `{id, href}`. */
export function tokeniseLinks(rawBody: string): { tokenised: string; links: Link[] } {
  const links: Link[] = [];
  let nextId = FIRST_LINK_ID;

  const replaceAnchor = (_match: string, href: string, text: string): string => {
    const id = nextId;
    nextId += 1;
    links.push({ id, href });
    return `[${text}](#${id})`;
  };

  return { tokenised: rawBody.replace(ANCHOR_PATTERN, replaceAnchor), links };
}

/** Strip tags, break lines, decode entities, collapse, trim. */
export function toPlainText(tokenised: string): string {
  const withBreaks = tokenised.replace(LINE_BREAK_PATTERN, "\n");
  const stripped = withBreaks.replace(ANY_TAG_PATTERN, "");

  // Decoding after stripping keeps an encoded `&lt;div&gt;` in the prose from
  // being read as a tag and deleted.
  let decoded = stripped;
  for (const [entity, character] of HTML_ENTITIES) {
    decoded = decoded.split(entity).join(character);
  }

  return decoded.replace(RUN_OF_WHITESPACE_PATTERN, "\n\n").trim();
}
