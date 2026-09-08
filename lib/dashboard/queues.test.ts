import { beforeEach, describe, expect, test } from "vitest";
import { FakeCookieJar, FakeUserStatusReader } from "../../test/fakes/auth";
import { manualClock } from "../../test/fakes/clock";
import { FakeQueueDepthReader } from "../../test/fakes/observability";
import { FakeDlqInspector, FakeDlqPurger } from "../../test/fakes/queues";
import { AuthorizationError, newSessionKey, SESSION_COOKIE, sealSession } from "../auth/session";
import { inspectDlq, loadQueues, purgeDlq } from "./queues";

const NOW = 1_770_000_000_000;
const SUB = "e4f1a2b3-0000-4000-8000-000000000001";

const QUEUES = { analyze: "q/analyze", aggregate: "q/aggregate", publish: "q/publish" };
const DLQS = { analyze: "dlq/analyze", aggregate: "dlq/aggregate", publish: "dlq/publish" };

let jar: FakeCookieJar;
let status: FakeUserStatusReader;
let key: Uint8Array;
let queues: FakeQueueDepthReader;
let inspector: FakeDlqInspector;
let purger: FakeDlqPurger;
let revalidated: string[];
const clock = manualClock(NOW);

beforeEach(() => {
  jar = new FakeCookieJar();
  status = new FakeUserStatusReader();
  key = newSessionKey();
  queues = new FakeQueueDepthReader();
  inspector = new FakeDlqInspector();
  purger = new FakeDlqPurger();
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
  queues,
  inspector,
  purger,
  queueUrls: QUEUES,
  dlqUrls: DLQS,
  revalidate: (path: string) => revalidated.push(path),
});

describe("loadQueues — §8.2 L776", () => {
  test("carries every stage with both depths", async () => {
    queues.set(QUEUES.analyze, { available: 4, inFlight: 1 });
    queues.set(DLQS.analyze, { available: 2, inFlight: 0 });

    const rows = await loadQueues(deps());

    expect(rows.map((row) => row.name)).toEqual(["analyze", "aggregate", "publish"]);
    expect(rows[0]).toMatchObject({ name: "analyze", depth: 5, dlqDepth: 2 });
  });

  test("an empty pipeline reads as zeros, not as missing", async () => {
    const rows = await loadQueues(deps());

    expect(rows.every((row) => row.depth === 0 && row.dlqDepth === 0)).toBe(true);
  });

  test("carries the DLQ url the replay and inspect controls need", async () => {
    const rows = await loadQueues(deps());
    expect(rows[0]?.dlqUrl).toBe(DLQS.analyze);
  });
});

describe("inspectDlq — §8.2 L776", () => {
  const body = { messageId: "m1", body: '{"id":"example/1"}', receiveCount: 3 };

  /** §8.6 L843 — `viewer` reads all pages, and this is part of one. */
  test("a viewer may inspect", async () => {
    signedInAs("viewer");
    inspector.set(DLQS.publish, [body]);

    expect(await inspectDlq({ queueName: "publish" }, deps())).toEqual([body]);
  });

  test("an unauthenticated caller may not", async () => {
    await expect(inspectDlq({ queueName: "publish" }, deps())).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  /** Matching `handlers/dlqReplay.ts`: inspecting the wrong queue misleads an operator. */
  test("an unknown queue name is rejected", async () => {
    signedInAs("viewer");

    await expect(inspectDlq({ queueName: "scrape" }, deps())).rejects.toThrow();
    expect(inspector.asked).toEqual([]);
  });

  test("reads the DLQ, never the source queue", async () => {
    signedInAs("viewer");
    await inspectDlq({ queueName: "analyze" }, deps());

    expect(inspector.asked).toEqual([DLQS.analyze]);
  });
});

describe("purgeDlq — R57", () => {
  test("purges the DLQ the operator named", async () => {
    signedInAs("admin");

    await purgeDlq({ queueName: "aggregate" }, deps());

    expect(purger.purged).toEqual([DLQS.aggregate]);
  });

  /**
   * The receipt an operator gets back, in the same shape as replay's
   * `{ replayed }`. Read before the purge, because afterwards there is nothing
   * left to count.
   */
  test("reports what the queue held", async () => {
    signedInAs("admin");
    queues.set(DLQS.analyze, { available: 7, inFlight: 2 });

    expect(await purgeDlq({ queueName: "analyze" }, deps())).toEqual({ discarded: 9 });
  });

  /** §8.4 L817's replay is `admin`; ending messages outright cannot be less. */
  test("a viewer may not purge", async () => {
    signedInAs("viewer");

    await expect(purgeDlq({ queueName: "analyze" }, deps())).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    expect(purger.purged).toEqual([]);
  });

  test("an unauthenticated caller may not", async () => {
    await expect(purgeDlq({ queueName: "analyze" }, deps())).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    expect(purger.purged).toEqual([]);
  });

  /**
   * The DLQ, never the source queue. Purging `q/analyze` would discard posts
   * still on their way through the pipeline, which no operator asked for and
   * which nothing recovers.
   */
  test("an unknown queue name is rejected before anything is destroyed", async () => {
    signedInAs("admin");

    await expect(purgeDlq({ queueName: "scrape" }, deps())).rejects.toThrow();
    expect(purger.purged).toEqual([]);
  });

  test("never names a source queue", async () => {
    signedInAs("admin");
    await purgeDlq({ queueName: "publish" }, deps());

    expect(purger.purged).not.toContain(QUEUES.publish);
  });

  /** Otherwise the card keeps showing the depth the queue had before the purge. */
  test("revalidates the page so the card stops showing a stale depth", async () => {
    signedInAs("admin");
    await purgeDlq({ queueName: "analyze" }, deps());

    expect(revalidated).toEqual(["/queues"]);
  });

  /** SQS's 60 s cooldown surfaces to the operator rather than reading as success. */
  test("a refused purge does not report a discard", async () => {
    signedInAs("admin");
    purger.error = new Error("a purge of this DLQ is already in progress");

    await expect(purgeDlq({ queueName: "analyze" }, deps())).rejects.toThrow(/already in progress/);
    expect(revalidated).toEqual([]);
  });
});
