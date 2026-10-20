import bigInt, { type BigInteger } from "big-integer";
import { Api } from "telegram";
import { describe, expect, test } from "vitest";
import {
  createMtprotoReader,
  type MessageClient,
  type MessagePage,
  MTPROTO_PAGE_SIZE,
  pageAfter,
  toChannelPost,
  tokeniseLinks,
  UNKNOWN_FORWARD_ORIGIN,
} from "./reader";

/** 2026-10-20T12:00:00Z, in Telegram's unit. */
const POSTED_AT_S = 1_792_497_600;

const message = (fields: Partial<ConstructorParameters<typeof Api.Message>[0]>): Api.Message =>
  new Api.Message({
    id: 7,
    peerId: new Api.PeerChannel({ channelId: bigInt(1) }),
    date: POSTED_AT_S,
    message: "hello",
    ...fields,
  });

interface FakeClient extends MessageClient {
  readonly calls: { readonly entity: string | BigInteger; readonly page: MessagePage }[];
  dialogLoads: number;
}

function fakeClient(messages: readonly Api.Message[] = []): FakeClient {
  const client: FakeClient = {
    calls: [],
    dialogLoads: 0,
    async getMessages(entity, page) {
      client.calls.push({ entity, page });
      return messages;
    },
    async getDialogs() {
      client.dialogLoads += 1;
      return [];
    },
  };
  return client;
}

describe("tokeniseLinks (§3.1 L216 over MTProto entities)", () => {
  test("replaces labelled and bare links with numbered tokens", () => {
    const text = "see docs and https://x.io now";
    const entities = [
      new Api.MessageEntityUrl({ offset: 13, length: 12 }),
      new Api.MessageEntityTextUrl({ offset: 4, length: 4, url: "https://d.io" }),
      new Api.MessageEntityBold({ offset: 0, length: 3 }),
    ];

    expect(tokeniseLinks(text, entities)).toEqual({
      body: "see [docs](#1) and [https://x.io](#2) now",
      links: [
        { id: 1, href: "https://d.io" },
        { id: 2, href: "https://x.io" },
      ],
    });
  });

  test("slices by UTF-16 offsets, as Telegram counts them", () => {
    const text = "🔥 link";
    const entities = [new Api.MessageEntityTextUrl({ offset: 3, length: 4, url: "https://a.io" })];

    expect(tokeniseLinks(text, entities).body).toBe("🔥 [link](#1)");
  });

  test("skips an entity overlapping an earlier one", () => {
    const entities = [
      new Api.MessageEntityTextUrl({ offset: 0, length: 4, url: "https://a.io" }),
      new Api.MessageEntityUrl({ offset: 2, length: 4 }),
    ];

    expect(tokeniseLinks("abcdef", entities).links).toEqual([{ id: 1, href: "https://a.io" }]);
  });
});

describe("toChannelPost", () => {
  test("maps id, trimmed body and an ISO publish time", () => {
    expect(toChannelPost(message({ message: "  news \n" }))).toEqual({
      id: "7",
      body: "news",
      links: [],
      forwardedFrom: undefined,
      postedAt: "2026-10-20T12:00:00.000Z",
    });
  });

  test("marks a forward by origin name, else by peer id, else as unknown", () => {
    const named = new Api.MessageFwdHeader({ date: POSTED_AT_S, fromName: "Origin" });
    const byPeer = new Api.MessageFwdHeader({
      date: POSTED_AT_S,
      fromId: new Api.PeerChannel({ channelId: bigInt(42) }),
    });
    const anonymous = new Api.MessageFwdHeader({ date: POSTED_AT_S });

    expect(toChannelPost(message({ fwdFrom: named })).forwardedFrom).toBe("Origin");
    expect(toChannelPost(message({ fwdFrom: byPeer })).forwardedFrom).toBe("-10042");
    expect(toChannelPost(message({ fwdFrom: anonymous })).forwardedFrom).toBe(
      UNKNOWN_FORWARD_ORIGIN,
    );
  });

  test("a message with no text has an empty body, for §3.1 L230 to drop", () => {
    expect(toChannelPost(message({ message: "" })).body).toBe("");
  });
});

describe("pageAfter", () => {
  test("without a cursor asks for the newest page, never the chat's start", () => {
    expect(pageAfter(undefined)).toEqual({ limit: MTPROTO_PAGE_SIZE });
    expect(pageAfter("")).toEqual({ limit: MTPROTO_PAGE_SIZE });
  });

  test("with a cursor pages forward from it", () => {
    expect(pageAfter("90177")).toEqual({ limit: MTPROTO_PAGE_SIZE, minId: 90177, reverse: true });
  });
});

describe("createMtprotoReader", () => {
  test("serves the mtproto sources", () => {
    expect(createMtprotoReader(fakeClient()).via).toBe("mtproto");
  });

  test("reads a username as is, without loading dialogs", async () => {
    const client = fakeClient([message({ id: 11 })]);

    const posts = await createMtprotoReader(client).read("some_chat", "10");

    expect(posts.map((post) => post.id)).toEqual(["11"]);
    expect(client.calls).toEqual([{ entity: "some_chat", page: pageAfter("10") }]);
    expect(client.dialogLoads).toBe(0);
  });

  test("resolves numeric ids through one dialog load per reader", async () => {
    const client = fakeClient();
    const reader = createMtprotoReader(client);

    await reader.read("-1004360889387", undefined);
    await reader.read("-1001234567890", undefined);

    expect(client.dialogLoads).toBe(1);
    expect(client.calls.map((call) => call.entity.toString())).toEqual([
      "-1004360889387",
      "-1001234567890",
    ]);
  });
});
