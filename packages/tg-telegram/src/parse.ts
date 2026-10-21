/**
 * The `t.me/s/{channel}` HTML parser. String-level on purpose: no DOM, no HTML
 * library. The patterns follow markup read off a live page.
 */

export interface ParsedLink {
  readonly id: number;
  readonly href: string;
}

export interface ParsedPost {
  id: string;
  body: string;
  links: Array<{ id: number; href: string }>;
  image?: string;
  forwardedFrom?: string;
  /** The post's publish time, as the page writes it — an ISO-8601 string. */
  postedAt?: string;
}

/** The literal the page is split on. */
const CHUNK_MARKER = '<div class="tgme_widget_message_wrap js-widget_message_wrap">';

/** The first fragment of the split is the channel header, never a post. */
const CHROME_FRAGMENTS = 1;

/** Link tokens are numbered from 1. */
const FIRST_LINK_ID = 1;

/** One `<div>` deep — the text element itself — when its inner HTML starts. */
const INITIAL_NESTING_DEPTH = 1;

/** The first `href="https://t.me/{any}/{digits}"`, digits captured. */
const MESSAGE_ID_PATTERN = /href="https:\/\/t\.me\/[^"/]+\/(?<messageId>\d+)"/;

/** Live markup is `tgme_widget_message_text js-message_text`, so the class is matched by prefix. */
const TEXT_ELEMENT_PREFIX = '<div class="tgme_widget_message_text';
const DIV_OPEN = "<div";
const DIV_CLOSE = "</div";
const TAG_CLOSE = ">";

/** Real anchors carry `target`/`rel` after the href, so `[^>]*` on both sides. */
const ANCHOR_PATTERN = /<a\b[^>]*\shref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;

/** Live pages emit `<br/>`; a bare `<br>` is matched too. */
const LINE_BREAK_PATTERN = /<br\s*\/?>/gi;
const ANY_TAG_PATTERN = /<[^>]*>/g;

/**
 * The six named entities, in the order they must be applied.
 * `&amp;` is decoded **last**: decoding it first rewrites `&amp;lt;` to `&lt;`
 * and then to `<`, inventing markup the channel never wrote.
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

/** `background-image:url('X')`. */
const BACKGROUND_IMAGE_PATTERN = /background-image:\s*url\('([^']*)'\)/g;

/**
 * The image is the first background image that is not an emoji sprite: emoji
 * also carry one, and they often precede, or replace, the photo.
 */
const EMOJI_SPRITE_URL_PATTERN = /telegram\.org\/img\/emoji\//;
const EMOJI_CLASS_PATTERN = /class="[^"]*\bemoji\b[^"]*"/;

/**
 * The publish time, from the date anchor's `<time datetime="…">`, the only
 * `datetime` in a chunk. Passed through as written, so the parser stays
 * clock-free; scrape does the arithmetic.
 */
const POSTED_AT_PATTERN = /<time\b[^>]*\sdatetime="(?<postedAt>[^"]*)"/;

/** The forwarded-from anchor. */
const FORWARDED_FROM_CLASS = "tgme_widget_message_forwarded_from_name";
const CHANNEL_HREF_PATTERN = /href="https:\/\/t\.me\/(?<channel>[^"/]+)/;

/**
 * Inner HTML of the message text element. Nested `<div>`s are counted rather than
 * matched by the first `</div>`, because a text element can wrap one (a poll, a
 * quote block) and a first-close match would truncate the body mid-sentence.
 */
function extractRawBody(chunk: string): string {
  const elementStart = chunk.indexOf(TEXT_ELEMENT_PREFIX);
  if (elementStart === -1) {
    return "";
  }
  const openTagEnd = chunk.indexOf(TAG_CLOSE, elementStart);
  if (openTagEnd === -1) {
    return "";
  }

  const bodyStart = openTagEnd + TAG_CLOSE.length;
  let cursor = bodyStart;
  let depth = INITIAL_NESTING_DEPTH;

  while (depth > 0) {
    const nextClose = chunk.indexOf(DIV_CLOSE, cursor);
    if (nextClose === -1) {
      // Truncated page: keep what is there rather than dropping the post.
      return chunk.slice(bodyStart);
    }
    const nextOpen = chunk.indexOf(DIV_OPEN, cursor);
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth += 1;
      cursor = nextOpen + DIV_OPEN.length;
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return chunk.slice(bodyStart, nextClose);
    }
    cursor = nextClose + DIV_CLOSE.length;
  }

  return chunk.slice(bodyStart);
}

/** `<a href="X">Y</a>` → `[Y](#N)`, collecting `{id, href}`. */
export function tokeniseLinks(rawBody: string): { tokenised: string; links: ParsedLink[] } {
  const links: ParsedLink[] = [];
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

  // Decoding after stripping keeps an encoded `&lt;div&gt;` in the post's prose
  // from being read as a tag and deleted.
  let decoded = stripped;
  for (const [entity, character] of HTML_ENTITIES) {
    decoded = decoded.split(entity).join(character);
  }

  return decoded.replace(RUN_OF_WHITESPACE_PATTERN, "\n\n").trim();
}

/** See `EMOJI_SPRITE_URL_PATTERN`. */
function isEmojiBackground(chunk: string, matchIndex: number, url: string): boolean {
  if (EMOJI_SPRITE_URL_PATTERN.test(url)) {
    return true;
  }
  // Fall back to the carrying element's class, so a sprite served from another
  // host is still not mistaken for the post's photo.
  const tagStart = chunk.lastIndexOf("<", matchIndex);
  if (tagStart === -1) {
    return false;
  }
  return EMOJI_CLASS_PATTERN.test(chunk.slice(tagStart, matchIndex));
}

function extractImage(chunk: string): string | undefined {
  for (const match of chunk.matchAll(BACKGROUND_IMAGE_PATTERN)) {
    const url = match[1];
    if (url === undefined) {
      continue;
    }
    if (!isEmojiBackground(chunk, match.index, url)) {
      return url;
    }
  }
  return undefined;
}

/**
 * The origin channel. It is read from the anchor's `href`
 * (`https://t.me/origin_channel/7001`) and not from its text, which is the
 * channel's display name and may be any language, emoji or punctuation.
 */
function extractForwardedFrom(chunk: string): string | undefined {
  const classIndex = chunk.indexOf(FORWARDED_FROM_CLASS);
  if (classIndex === -1) {
    return undefined;
  }
  const tagStart = chunk.lastIndexOf("<", classIndex);
  const tagEnd = chunk.indexOf(TAG_CLOSE, classIndex);
  if (tagStart === -1 || tagEnd === -1) {
    return undefined;
  }
  // The whole open tag is searched so `href` may precede or follow `class`.
  return CHANNEL_HREF_PATTERN.exec(chunk.slice(tagStart, tagEnd))?.groups?.channel;
}

function parseChunk(chunk: string): ParsedPost | undefined {
  const id = MESSAGE_ID_PATTERN.exec(chunk)?.groups?.messageId;
  if (id === undefined) {
    // Never emit a post without an id.
    return undefined;
  }

  const { tokenised, links } = tokeniseLinks(extractRawBody(chunk));
  const post: ParsedPost = { id, body: toPlainText(tokenised), links };

  const image = extractImage(chunk);
  if (image !== undefined) {
    post.image = image;
  }
  const forwardedFrom = extractForwardedFrom(chunk);
  if (forwardedFrom !== undefined) {
    post.forwardedFrom = forwardedFrom;
  }
  const postedAt = POSTED_AT_PATTERN.exec(chunk)?.groups?.postedAt;
  if (postedAt !== undefined) {
    post.postedAt = postedAt;
  }

  return post;
}

/** One page of `t.me/s/{channel}` markup into posts. */
export function parseTelegramPage(html: string): ParsedPost[] {
  const posts: ParsedPost[] = [];

  for (const chunk of html.split(CHUNK_MARKER).slice(CHROME_FRAGMENTS)) {
    const post = parseChunk(chunk);
    if (post !== undefined) {
      posts.push(post);
    }
  }

  return posts;
}
