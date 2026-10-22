import type { ChannelPost, ChannelReader } from "tg-domain/types";
import { mailContent } from "./mime";
import type { GmailClient, GmailMessage } from "./types";

/**
 * The `type: "gmail"` reader: `ChannelReader` over the Gmail API. A source's id
 * is a sender's address, and its posts are that sender's inbox mails.
 *
 * A post's id is the mail's `internalDate` (epoch ms): item ids need digits,
 * and a time is a cursor Gmail can search by. Two mails from one sender in the
 * same millisecond would share an id, and the second would be read as a replay.
 */

/** One run reads at most a `t.me/s/` page's worth of mails, like the other readers. */
export const GMAIL_PAGE_SIZE = 20;

/** `messages.list` allows up to 500; ids are cheap. */
const LIST_PAGE_SIZE = 100;

const MS_PER_SECOND = 1000;

/** `after:` takes epoch seconds, so it may return mails at the cursor's own second. */
export function gmailQuery(sender: string, afterId: string | undefined): string {
  const query = `in:inbox from:${sender}`;
  return afterId ? `${query} after:${Math.floor(Number(afterId) / MS_PER_SECOND)}` : query;
}

/** Every id the query matches, newest first. */
async function allIds(client: GmailClient, query: string): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await client.list(query, LIST_PAGE_SIZE, pageToken);
    ids.push(...page.ids);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return ids;
}

/** No `image`: a mail's images have no public URL for `sendPhoto`. */
export function toChannelPost(message: GmailMessage): ChannelPost {
  const { body, links } = mailContent(message.payload);
  return {
    id: message.internalDate,
    body,
    links,
    postedAt: new Date(Number(message.internalDate)).toISOString(),
  };
}

/**
 * Without a cursor, the newest page: older mail would only be dropped as
 * obsolete. With one, the oldest page after it, so a busy sender catches up
 * over successive runs, not by skipping mail.
 */
export function createGmailReader(client: GmailClient): ChannelReader {
  return {
    type: "gmail",
    async read(sender, afterId) {
      const query = gmailQuery(sender, afterId);
      const ids = afterId
        ? (await allIds(client, query)).slice(-GMAIL_PAGE_SIZE)
        : (await client.list(query, GMAIL_PAGE_SIZE)).ids;

      const messages = await Promise.all(ids.map((id) => client.get(id)));
      return messages
        .map(toChannelPost)
        .filter((post) => !afterId || Number(post.id) > Number(afterId));
    },
  };
}
