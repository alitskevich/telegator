import type { Message } from "tg-domain/message";
import { escapeHtml } from "./escape";

/**
 * A target's own message layout, as a pure substitution, so a replay or an
 * idempotent edit renders the same bytes with a template as without one.
 */

/**
 * The `{name}` token. It collides with neither Telegram HTML nor the
 * `[text](#N)` link tokens. Letters only, so a stray brace in prose stays.
 */
export const TEMPLATE_PLACEHOLDER = /\{([a-zA-Z]+)\}/g;

/** The most consecutive newlines a rendered template keeps. */
export const MAX_CONSECUTIVE_NEWLINES = 2;

/** The message fields a template can name. */
export type TemplateMessage = Pick<Message, "title" | "category" | "country" | "location" | "date">;

export interface TemplateValues {
  /** Already-rendered HTML: the header line. */
  readonly header: string;
  /** Already-rendered HTML: the member blocks, newline-joined. */
  readonly body: string;
  /** Already-rendered HTML: the hashtag line, `""` once shortening drops it. */
  readonly hashtags: string;
  readonly message: TemplateMessage;
}

/**
 * The value for one token. The three rendered values are already HTML and are
 * not escaped again; message fields are escaped. `date` holds only digits and
 * hyphens.
 */
function valueFor(name: string, values: TemplateValues): string | undefined {
  const { message } = values;

  switch (name) {
    case "header":
      return values.header;
    case "body":
      return values.body;
    case "hashtags":
      return values.hashtags;
    case "title":
      return escapeHtml(message.title ?? "");
    case "category":
      return escapeHtml(message.category ?? "");
    case "country":
      return escapeHtml((message.country ?? "").toUpperCase());
    case "location":
      return escapeHtml(message.location ?? "");
    case "date":
      return message.date;
    default:
      return undefined;
  }
}

/** Built from the constant so the two can never drift apart. */
const EXCESS_NEWLINES = new RegExp(`\\n{${MAX_CONSECUTIVE_NEWLINES + 1},}`, "g");
const COLLAPSED = "\n".repeat(MAX_CONSECUTIVE_NEWLINES);

/**
 * Substitute, collapse, trim. The collapse runs over the whole string, so an
 * empty value does not leave a blank line behind.
 */
export function renderTemplate(template: string, values: TemplateValues): string {
  const substituted = template.replaceAll(
    TEMPLATE_PLACEHOLDER,
    (_match, name: string) => valueFor(name, values) ?? "",
  );

  return substituted.replaceAll(EXCESS_NEWLINES, COLLAPSED).trim();
}
