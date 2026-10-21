import type { SendMethod } from "./assemble";
import type { TemplateMessage } from "./template";

export interface AssembledMessage {
  readonly text: string;
  readonly method: SendMethod;
  /** Present only on `sendPhoto`; an edit never re-sends a photo. */
  readonly photo?: string;
  readonly disableWebPagePreview: boolean;
  readonly chatId: string;
}

/** The fields the line is drawn from, all optional but `date` and `ts`. */
export interface HashtagSource {
  readonly category?: string | undefined;
  readonly location?: string | undefined;
  readonly peoples?: string | undefined;
  readonly tags?: string | undefined;
  readonly title?: string | undefined;
  /** A `YYYY-MM-DD` key. */
  readonly date: string;
  /** Epoch milliseconds. */
  readonly ts: number;
}

export interface TemplateValues {
  /** Already-rendered HTML: the header line. */
  readonly header: string;
  /** Already-rendered HTML: the member blocks, newline-joined. */
  readonly body: string;
  /** Already-rendered HTML: the hashtag line, `""` once shortening drops it. */
  readonly hashtags: string;
  readonly message: TemplateMessage;
}
