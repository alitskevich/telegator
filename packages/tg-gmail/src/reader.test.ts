import { describe, expect, test } from "vitest";
import { createGmailReader, GMAIL_PAGE_SIZE, gmailQuery } from "./reader";
import type { GmailClient } from "./types";

const CURSOR = 1_792_500_000_000;

/** A fake inbox of `internalDate`s, newest first, listed `perPage` at a time. */
function fakeInbox(dates: number[], perPage = 100) {
  const queries: string[] = [];
  const client: GmailClient = {
    list: async (query, maxResults, pageToken) => {
      queries.push(query);
      const start = Number(pageToken ?? 0);
      const end = start + Math.min(maxResults, perPage);
      const ids = dates.slice(start, end).map((date) => `g${date}`);
      return { ids, nextPageToken: end < dates.length ? String(end) : undefined };
    },
    get: async (id) => ({
      id,
      internalDate: id.slice(1),
      payload: { headers: [{ name: "Subject", value: `mail ${id}` }] },
    }),
  };
  return { client, queries };
}

/** `count` dates a second apart, newest first. */
const newestFirst = (newest: number, count: number) =>
  Array.from({ length: count }, (_, i) => newest - i * 1000);

const ids = (posts: { id: string }[]) => posts.map((post) => Number(post.id)).sort();

describe("gmailQuery", () => {
  test("searches the sender's inbox, after the cursor's second when there is one", () => {
    expect(gmailQuery("news@e.by", undefined)).toBe("in:inbox from:news@e.by");
    expect(gmailQuery("news@e.by", "1792500000999")).toBe(
      "in:inbox from:news@e.by after:1792500000",
    );
  });
});

describe("createGmailReader", () => {
  test("without a cursor reads the newest page only", async () => {
    const inbox = newestFirst(CURSOR, 30);
    const { client, queries } = fakeInbox(inbox);
    const posts = await createGmailReader(client).read("news@e.by", undefined);

    expect(queries).toHaveLength(1);
    expect(ids(posts)).toEqual(inbox.slice(0, GMAIL_PAGE_SIZE).sort());
    expect(posts[0]).toMatchObject({ body: `mail g${inbox[0]}`, links: [] });
  });

  test("with a cursor pages through and reads the oldest mails after it", async () => {
    // 40 mails newer than the cursor, and the cursor's own.
    const { client, queries } = fakeInbox(newestFirst(CURSOR + 40_000, 41), 15);
    const posts = await createGmailReader(client).read("news@e.by", String(CURSOR));

    expect(queries).toHaveLength(3);
    expect(ids(posts)).toEqual(newestFirst(CURSOR + 19_000, 19).sort());
  });

  test("drops a mail at the cursor itself, which `after:` may return", async () => {
    const { client } = fakeInbox([CURSOR + 100, CURSOR]);
    const posts = await createGmailReader(client).read("news@e.by", String(CURSOR));

    expect(posts.map((post) => post.id)).toEqual([String(CURSOR + 100)]);
  });
});
