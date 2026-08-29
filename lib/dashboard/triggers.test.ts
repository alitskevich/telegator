import { beforeEach, describe, expect, test } from "vitest";
import { FakeCookieJar, FakeUserStatusReader } from "../../test/fakes/auth.js";
import { manualClock } from "../../test/fakes/clock.js";
import { fakeMessageRepo, fakeSourceRepo } from "../../test/fakes/db.js";
import { fakeQueueProducer } from "../../test/fakes/queues.js";
import { AuthorizationError, newSessionKey, SESSION_COOKIE, sealSession } from "../auth/session.js";
import type { LambdaInvoker } from "../aws/lambda.js";
import type { Message } from "../domain/message.js";
import type { Source } from "../domain/source.js";
import { exportTable, replayDlq, republishMessage, runScraper } from "./triggers.js";

const NOW = 1_770_000_000_000;
const SUB = "e4f1a2b3-0000-4000-8000-000000000001";

const source = (id: string, extra: Partial<Source> = {}): Source => ({
  id,
  status: "ok",
  tgChannel: "@target",
  category: "politics",
  lastCount: 4,
  lastUpdated: NOW,
  zeroYieldRuns: 0,
  lastNonZeroCount: 4,
  ...extra,
});

const message = (n: number, extra: Partial<Message> = {}): Message => ({
  id: `example/${n}`,
  status: "published",
  title: "Election result",
  category: "politics",
  date: "2026-02-01",
  ts: NOW,
  tgChannel: "@target",
  memberCount: 1,
  members: {},
  ...extra,
});

let jar: FakeCookieJar;
let status: FakeUserStatusReader;
let key: Uint8Array;
let invocations: { functionName: string; payload: unknown }[];
let lambdaResult: unknown;
let messages: ReturnType<typeof fakeMessageRepo>;
let sources: ReturnType<typeof fakeSourceRepo>;
let publishQueue: ReturnType<typeof fakeQueueProducer>;
let revalidated: string[];
const clock = manualClock(NOW);

const lambda: LambdaInvoker = {
  invoke: async (functionName, payload) => {
    invocations.push({ functionName, payload });
    return lambdaResult;
  },
};

beforeEach(() => {
  jar = new FakeCookieJar();
  status = new FakeUserStatusReader();
  key = newSessionKey();
  invocations = [];
  lambdaResult = {};
  messages = fakeMessageRepo([message(1), message(2, { status: "error" })]);
  sources = fakeSourceRepo([source("channel-a"), source("channel-b", { status: "paused" })]);
  publishQueue = fakeQueueProducer();
  revalidated = [];
});

function signedInAs(...roles: string[]) {
  jar.set(SESSION_COOKIE, sealSession({ sub: SUB, roles, expiresAt: NOW + 3_600_000 }, key), {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
  });
  status.enable(SUB);
}

const deps = () => ({
  auth: { jar, key, clock, status },
  lambda,
  functions: { scrape: "telegator-scrape", dlqReplay: "telegator-dlq-replay" },
  messages,
  sources,
  publishQueue,
  revalidate: (path: string) => revalidated.push(path),
});

describe("runScraper — §8.4 L752", () => {
  /**
   * §8.2 L734 — "manual triggers call `lambda:InvokeFunction` on the deployed
   * function, so 'run this now' executes the exact deployed artefact". Importing
   * the stage instead would run the dashboard's own copy of it.
   */
  test("invokes the scrape function and returns its summary", async () => {
    signedInAs("admin");
    lambdaResult = { processed: 12, enqueued: 11 };

    expect(await runScraper(deps())).toEqual({ processed: 12 });
    expect(invocations).toEqual([{ functionName: "telegator-scrape", payload: {} }]);
  });

  test("an editor is rejected and nothing is invoked", async () => {
    signedInAs("editor");

    await expect(runScraper(deps())).rejects.toBeInstanceOf(AuthorizationError);
    expect(invocations).toEqual([]);
  });

  test("a viewer is rejected", async () => {
    signedInAs("viewer");
    await expect(runScraper(deps())).rejects.toMatchObject({ reason: "forbidden" });
  });

  /** A reply that is not a summary means the function failed in a way it did not report. */
  test("a malformed reply is rejected rather than shown as zero", async () => {
    signedInAs("admin");
    lambdaResult = { ok: true };

    await expect(runScraper(deps())).rejects.toThrow();
  });
});

describe("replayDlq — §8.4 L754", () => {
  test("invokes the replay handler with the operator's choice", async () => {
    signedInAs("admin");
    lambdaResult = { replayed: 4, failed: 0 };

    expect(await replayDlq({ queueName: "publish", max: 10 }, deps())).toEqual({ replayed: 4 });
    expect(invocations).toEqual([
      { functionName: "telegator-dlq-replay", payload: { queueName: "publish", max: 10 } },
    ]);
  });

  /**
   * The handler names this rather than defaulting, and so does the action:
   * draining the wrong queue moves messages no operator asked to move.
   */
  test("an unknown queue name is rejected before any invoke", async () => {
    signedInAs("admin");

    await expect(replayDlq({ queueName: "scrape", max: 10 }, deps())).rejects.toThrow();
    expect(invocations).toEqual([]);
  });

  test("a non-positive max is rejected", async () => {
    signedInAs("admin");

    await expect(replayDlq({ queueName: "publish", max: 0 }, deps())).rejects.toThrow();
    await expect(replayDlq({ queueName: "publish", max: -1 }, deps())).rejects.toThrow();
  });

  test("an editor is rejected", async () => {
    signedInAs("editor");
    await expect(replayDlq({ queueName: "publish", max: 5 }, deps())).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});

describe("republishMessage — §8.4 L753", () => {
  /**
   * The ordering the ledger names. §3.4 L316 has the publish stage load the
   * message and drop anything not in `topublish`; a request that arrived before
   * the status write landed would be silently discarded, and the operator would
   * see a button that did nothing.
   */
  test("writes topublish before it enqueues", async () => {
    signedInAs("admin");
    const order: string[] = [];

    const tracking = {
      ...deps(),
      messages: {
        ...messages,
        patch: async (id: string, delta: Readonly<Record<string, unknown>>) => {
          order.push("patch");
          await messages.patch(id, delta);
        },
      },
      publishQueue: {
        send: async (batch: Parameters<typeof publishQueue.send>[0]) => {
          order.push("send");
          return publishQueue.send(batch);
        },
      },
    };

    await republishMessage({ messageId: "example/1" }, tracking);

    expect(order).toEqual(["patch", "send"]);
    expect((await messages.get("example/1"))?.status).toBe("topublish");
  });

  test("enqueues the message id on the publish queue", async () => {
    signedInAs("admin");

    await republishMessage({ messageId: "example/1" }, deps());

    expect(publishQueue.sent).toHaveLength(1);
    expect(JSON.parse(publishQueue.sent[0]?.body ?? "{}")).toEqual({ messageId: "example/1" });
  });

  test("an editor is rejected and nothing is written or enqueued", async () => {
    signedInAs("editor");

    await expect(republishMessage({ messageId: "example/1" }, deps())).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    expect((await messages.get("example/1"))?.status).toBe("published");
    expect(publishQueue.sent).toHaveLength(0);
  });

  test("an unknown message id shape is rejected", async () => {
    signedInAs("admin");
    await expect(republishMessage({ messageId: "not-an-id" }, deps())).rejects.toThrow();
  });

  test("a message that does not exist is rejected before enqueuing", async () => {
    signedInAs("admin");

    await expect(republishMessage({ messageId: "example/99" }, deps())).rejects.toThrow();
    expect(publishQueue.sent).toHaveLength(0);
  });

  test("revalidates the messages page", async () => {
    signedInAs("admin");
    await republishMessage({ messageId: "example/1" }, deps());
    expect(revalidated).toEqual(["/messages"]);
  });
});

describe("exportTable — §8.4 L755", () => {
  test("a viewer may export", async () => {
    signedInAs("viewer");
    expect(await exportTable({ table: "sources" }, deps())).toContain("channel-a");
  });

  test("an unauthenticated caller may not", async () => {
    await expect(exportTable({ table: "sources" }, deps())).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  test("the header row is §8.3 L741's source columns", async () => {
    signedInAs("viewer");
    const [header] = (await exportTable({ table: "sources" }, deps())).split("\n");

    expect(header).toBe("id,status,tgChannel,category,teaser,lastCount,lastResult,zeroYieldRuns");
  });

  test("the header row is §8.3 L742's message columns", async () => {
    signedInAs("viewer");
    const [header] = (await exportTable({ table: "messages" }, deps())).split("\n");

    expect(header).toBe("id,title,category,status,date,tgChannel,memberCount");
  });

  test("exports every source, whatever its status", async () => {
    signedInAs("viewer");
    const csv = await exportTable({ table: "sources" }, deps());

    expect(csv).toContain("channel-a");
    expect(csv).toContain("channel-b");
  });

  test("exports messages across every status", async () => {
    signedInAs("viewer");
    const csv = await exportTable({ table: "messages" }, deps());

    expect(csv).toContain("example/1");
    expect(csv).toContain("example/2");
  });

  /**
   * A title containing a comma is ordinary news copy. Unquoted, it shifts every
   * later column by one and the export silently reports the wrong category for
   * that row.
   */
  test("quotes a value containing a comma", async () => {
    signedInAs("viewer");
    messages = fakeMessageRepo([message(1, { title: "Vance, then Rubio" })]);

    expect(await exportTable({ table: "messages" }, deps())).toContain('"Vance, then Rubio"');
  });

  test("doubles an embedded quote", async () => {
    signedInAs("viewer");
    messages = fakeMessageRepo([message(1, { title: 'He said "no"' })]);

    expect(await exportTable({ table: "messages" }, deps())).toContain('"He said ""no"""');
  });

  test("quotes a value containing a newline", async () => {
    signedInAs("viewer");
    messages = fakeMessageRepo([message(1, { title: "line one\nline two" })]);

    expect(await exportTable({ table: "messages" }, deps())).toContain('"line one\nline two"');
  });

  test("an absent optional field is an empty cell, not the word undefined", async () => {
    signedInAs("viewer");
    sources = fakeSourceRepo([source("channel-a", { teaser: undefined })]);

    expect(await exportTable({ table: "sources" }, deps())).not.toContain("undefined");
  });

  test("soft-deleted rows are not exported", async () => {
    signedInAs("viewer");
    sources = fakeSourceRepo([source("channel-a"), source("gone", { deleted: true })]);

    expect(await exportTable({ table: "sources" }, deps())).not.toContain("gone");
  });

  test("an unknown table is rejected", async () => {
    signedInAs("viewer");
    await expect(exportTable({ table: "items" }, deps())).rejects.toThrow();
  });
});
