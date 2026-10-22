import type { Link } from "tg-domain/item";
import { tokeniseLinks, toPlainText } from "./html";
import type { MessagePart } from "./types";

/**
 * A mail's text as a post body: the subject, then the `text/plain` part, else
 * the `text/html` part, with links as `[text](#N)` tokens. Pure.
 *
 * Parts are decoded as UTF-8, which nearly every mail sender uses.
 */

/** A newsletter runs to tens of kilobytes; the model needs the gist, not all of it. */
export const MAX_MAIL_BODY_LENGTH = 10_000;

/** Link tokens are numbered from 1. */
const FIRST_LINK_ID = 1;

/** A bare URL in plain text; trailing punctuation is the sentence's, not the URL's. */
const BARE_URL_PATTERN = /https?:\/\/[^\s<>"'()[\]]*[^\s<>"'()[\].,;:!?]/g;

/** Mail HTML carries CSS and conditional comments that are not text. */
const INVISIBLE_PATTERN = /<!--[\s\S]*?-->|<(head|style|script)\b[\s\S]*?<\/\1>/gi;

/** Mail HTML breaks lines with blocks, not `<br>`, so each block end becomes one. */
const BLOCK_END_PATTERN = /<\/(p|div|tr|li|h[1-6]|table)>/gi;

/** An image link leaves a token with no text, which carries nothing. */
const EMPTY_TOKEN_PATTERN = /\[\s*\]\(#\d+\)/g;

const RUN_OF_BLANK_LINES_PATTERN = /\n{3,}/g;

const decode = (data: string): string => Buffer.from(data, "base64url").toString("utf8");

/** A header's value; names compare case-insensitively, as RFC 5322 says. */
export function header(part: MessagePart, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return part.headers?.find((h) => h.name.toLowerCase() === wanted)?.value;
}

/** The first part of this type, depth first, decoded. */
function findPart(part: MessagePart, mimeType: string): string | undefined {
  if (part.mimeType === mimeType && part.body?.data !== undefined) return decode(part.body.data);
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found !== undefined) return found;
  }
  return undefined;
}

function fromPlain(text: string): { body: string; links: Link[] } {
  const links: Link[] = [];
  const body = text.replace(BARE_URL_PATTERN, (href) => {
    const id = links.length + FIRST_LINK_ID;
    links.push({ id, href });
    return `[${href}](#${id})`;
  });
  return { body: body.replaceAll("\r\n", "\n").replace(RUN_OF_BLANK_LINES_PATTERN, "\n\n"), links };
}

function fromHtml(html: string): { body: string; links: Link[] } {
  const visible = html.replace(INVISIBLE_PATTERN, "").replace(BLOCK_END_PATTERN, "<br>");
  const { tokenised, links } = tokeniseLinks(visible);
  return { body: toPlainText(tokenised).replace(EMPTY_TOKEN_PATTERN, ""), links };
}

export function mailContent(payload: MessagePart): { body: string; links: Link[] } {
  const plain = findPart(payload, "text/plain");
  const html = plain === undefined ? findPart(payload, "text/html") : undefined;
  const content =
    plain !== undefined ? fromPlain(plain) : html !== undefined ? fromHtml(html) : undefined;

  const body = [header(payload, "Subject"), content?.body]
    .filter((text) => text !== undefined && text.trim() !== "")
    .join("\n\n");
  return { body: body.slice(0, MAX_MAIL_BODY_LENGTH).trim(), links: content?.links ?? [] };
}
