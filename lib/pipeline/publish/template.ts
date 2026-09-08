import type { Message } from "../../domain/message";
import { escapeHtml } from "./escape";

/**
 * target-table#5.2 — a target's own message layout, as a pure substitution
 * (R57).
 *
 * A total function of the template and the values handed to it: no clock, no
 * network, no map iteration. That is what keeps the byte-identical replay and
 * the idempotent edit the publish stage depends on true under a template as
 * well as without one.
 */

/**
 * target-table#2.3 — the token form (D9).
 *
 * `{…}` collides with neither Telegram HTML nor the `[text](#N)` link tokens
 * the stored summaries still carry. Letters only, so a stray brace in prose is
 * left where the operator put it.
 */
export const TEMPLATE_PLACEHOLDER = /\{([a-zA-Z]+)\}/g;

/** target-table#5.2 — the most consecutive newlines a rendered template keeps. */
export const MAX_CONSECUTIVE_NEWLINES = 2;

/** The message fields target-table#5.2's table substitutes. */
export type TemplateMessage = Pick<Message, "title" | "category" | "country" | "location" | "date">;

export interface TemplateValues {
  /** Already-rendered HTML: the header line. */
  readonly header: string;
  /** Already-rendered HTML: the member blocks, newline-joined. */
  readonly body: string;
  /** Already-rendered HTML: the hashtag line, `""` once the ladder drops it. */
  readonly hashtags: string;
  readonly message: TemplateMessage;
}

/**
 * target-table#5.2's table, as a lookup.
 *
 * The split is D10's: the three rendered values are HTML this build produced
 * and must not be escaped again, while the message fields are the untrusted
 * half and are escaped exactly where the built-in layout escapes them. `date`
 * is neither — `DateKeySchema` admits digits and hyphens only.
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
 * target-table#5.2 — substitute, collapse, trim.
 *
 * The collapse runs over the whole rendered string rather than per token, so
 * `{title}\n{location}` behaves the same whichever of the two is empty; without
 * it every absent value would leave a blank line where it used to be.
 */
export function renderTemplate(template: string, values: TemplateValues): string {
  const substituted = template.replaceAll(
    TEMPLATE_PLACEHOLDER,
    (_match, name: string) => valueFor(name, values) ?? "",
  );

  return substituted.replaceAll(EXCESS_NEWLINES, COLLAPSED).trim();
}
