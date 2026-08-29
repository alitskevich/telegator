/**
 * The §3.1 L197–207 `t.me/s/{channel}` HTML parser.
 *
 * Telegram's preview page is scraped, not fetched through an API, so this module
 * is deliberately string-level: no DOM, no HTML library. Three details below come
 * from markup read off a live page (item 3.1) rather than from the spec's
 * abbreviated examples — the text element's real class, the self-closing `<br/>`,
 * and the forwarded channel living in the anchor's `href`.
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
}

/** §3.1 L197 — the literal the page is split on. */
const CHUNK_MARKER = '<div class="tgme_widget_message_wrap js-widget_message_wrap">';

/**
 * §3.1 L197 — "discarding the first fragment (page chrome)". `split` puts
 * everything before the first marker in element 0, which is the channel header,
 * never a post.
 */
const CHROME_FRAGMENTS = 1;

/** §3.1 L203 — "N from 1". */
const FIRST_LINK_ID = 1;

/** One `<div>` deep — the text element itself — when its inner HTML starts. */
const INITIAL_NESTING_DEPTH = 1;

/** §3.1 L201 — first `href="https://t.me/{any}/{digits}"`, digits captured. */
const MESSAGE_ID_PATTERN = /href="https:\/\/t\.me\/[^"/]+\/(?<messageId>\d+)"/;

/**
 * §3.1 L202 — the spec writes `tgme_widget_message_text …`; live markup is
 * `tgme_widget_message_text js-message_text`, so the class is matched by prefix.
 */
const TEXT_ELEMENT_PREFIX = '<div class="tgme_widget_message_text';
const DIV_OPEN = "<div";
const DIV_CLOSE = "</div";
const TAG_CLOSE = ">";

/** §3.1 L203 — real anchors carry `target`/`rel` after the href, so `[^>]*` both sides. */
const ANCHOR_PATTERN = /<a\b[^>]*\shref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;

/** §3.1 L204 — live pages emit `<br/>`; the spec's bare `<br>` is matched too. */
const LINE_BREAK_PATTERN = /<br\s*\/?>/gi;
const ANY_TAG_PATTERN = /<[^>]*>/g;

/**
 * §3.1 L204 — the six named entities, in the order they must be applied.
 * `&amp;` is decoded **last**: decoding it first rewrites `&amp;lt;` to `&lt;`
 * and then to `<`, inventing markup the channel never wrote.
 */
const HTML_ENTITIES: ReadonlyArray<readonly [string, string]> = [
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&quot;", '"'],
  ["&#39;", "'"],
  // A plain space rather than U+00A0: §3.3 L212 strips a source's `teaser` from
  // this body by literal comparison, which an invisible non-breaking space breaks.
  ["&nbsp;", " "],
  ["&amp;", "&"],
];

/** §3.1 L204 — "collapse 3+ whitespace to `\n\n`". */
const RUN_OF_WHITESPACE_PATTERN = /\s{3,}/g;

/** §3.1 L205 — `background-image:url('X')`. */
const BACKGROUND_IMAGE_PATTERN = /background-image:\s*url\('([^']*)'\)/g;

/**
 * R32 · §3.1 L205 read literally ("first `background-image:url('X')`") captures an
 * emoji sprite: on a live page exactly three classes carry a background image —
 * `emoji`, `tgme_widget_message_photo_wrap` and `tgme_widget_message_video_thumb` —
 * and emoji routinely precede, or wholly replace, the photo. §2.2 L124 calls the
 * field "URL extracted from **the post's** `background-image` style", so the
 * corrected reading is: the first background image that is not an emoji sprite.
 */
const EMOJI_SPRITE_URL_PATTERN = /telegram\.org\/img\/emoji\//;
const EMOJI_CLASS_PATTERN = /class="[^"]*\bemoji\b[^"]*"/;

/** §3.1 L206 — the forwarded-from anchor. */
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

/** §3.1 L203 — `<a href="X">Y</a>` → `[Y](#N)`, collecting `{id, href}`. */
function tokeniseLinks(rawBody: string): { tokenised: string; links: ParsedLink[] } {
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

/** §3.1 L204 — strip tags, break lines, decode entities, collapse, trim. */
function toPlainText(tokenised: string): string {
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

/** R32 — see `EMOJI_SPRITE_URL_PATTERN`. */
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
 * §3.1 L206 — the origin channel. It is read from the anchor's `href`
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
    // §3.1 L208 — an id-less chunk is a zero-yield signal for the orchestrator;
    // here it only means: never emit a post without an id.
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

  return post;
}

/** §3.1 L197–207 — one page of `t.me/s/{channel}` markup into posts. */
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
