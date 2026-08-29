import { beforeEach, describe, expect, test } from "vitest";
import { FakeCookieJar, FakeUserStatusReader } from "../../test/fakes/auth";
import { manualClock } from "../../test/fakes/clock";
import { FakeQueueDepthReader } from "../../test/fakes/observability";
import { FakeDlqInspector } from "../../test/fakes/queues";
import { AuthorizationError, newSessionKey, SESSION_COOKIE, sealSession } from "../auth/session";
import { inspectDlq, loadQueues } from "./queues";

const NOW = 1_770_000_000_000;
const SUB = "e4f1a2b3-0000-4000-8000-000000000001";

const QUEUES = { analyze: "q/analyze", aggregate: "q/aggregate", publish: "q/publish" };
const DLQS = { analyze: "dlq/analyze", aggregate: "dlq/aggregate", publish: "dlq/publish" };

let jar: FakeCookieJar;
let status: FakeUserStatusReader;
let key: Uint8Array;
let queues: FakeQueueDepthReader;
let inspector: FakeDlqInspector;
const clock = manualClock(NOW);

beforeEach(() => {
  jar = new FakeCookieJar();
  status = new FakeUserStatusReader();
  key = newSessionKey();
  queues = new FakeQueueDepthReader();
  inspector = new FakeDlqInspector();
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
  queueUrls: QUEUES,
  dlqUrls: DLQS,
});

describe("loadQueues — §8.2 L723", () => {
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

describe("inspectDlq — §8.2 L723", () => {
  const body = { messageId: "m1", body: '{"id":"example/1"}', receiveCount: 3 };

  /** §8.6 L783 — `viewer` reads all pages, and this is part of one. */
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
