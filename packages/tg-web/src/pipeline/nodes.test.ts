import type { Overview } from "tg-actions/dashboard/types";
import { resources } from "tg-rc/web";
import { describe, expect, test } from "vitest";
import { pipelineNodes, queueOf } from "./nodes";

const overview: Overview = {
  scraped: 120,
  analyzed: 96,
  skipped: { total: 24, byReason: { category: 10, low: 14, nobody: 0 } },
  published: 40,
  errors: 3,
  statusSlices: [],
  categorySlices: [],
  inQueue: { analyze: 5, aggregate: 0, publish: 2 },
  deadLetters: { analyze: 0, aggregate: 0, publish: 3 },
  recent: [],
};

const byId = (nodes: ReturnType<typeof pipelineNodes>) =>
  Object.fromEntries(nodes.map((node) => [node.id, node]));

describe("pipelineNodes", () => {
  test("draws the chain in order, schedule to Telegram, with an arrow into all but the first", () => {
    const nodes = pipelineNodes(resources.stages, null, null);

    expect(nodes.map((node) => node.id)).toEqual([
      "schedule",
      "scrape",
      "analyze",
      "aggregate",
      "publish",
      "telegram",
    ]);
    expect(nodes.map((node) => node.first)).toEqual([true, false, false, false, false, false]);
  });

  test("a stage shows its count, and its queue and dead letters when it has a lane", () => {
    const nodes = byId(pipelineNodes(resources.stages, overview, null));

    expect(nodes.scrape).toMatchObject({
      value: 120,
      valueLabel: "scraped, 24 h",
      queued: null,
      dlq: null,
    });
    expect(nodes.analyze).toMatchObject({
      value: 96,
      valueLabel: "analysed, 24 h",
      queued: 5,
      dlq: 0,
    });
    expect(nodes.aggregate).toMatchObject({ hasValue: false, dlq: 0, alert: false });
    expect(nodes.publish).toMatchObject({ value: 40, dlq: 3 });
  });

  test("dead letters raise the alert", () => {
    const nodes = byId(pipelineNodes(resources.stages, overview, null));

    expect(nodes.publish?.alert).toBe(true);
    expect(nodes.analyze?.alert).toBe(false);
  });

  /** An unread count is not an empty one, and must not render as `0`. */
  test("before the first load every number is unknown", () => {
    const nodes = pipelineNodes(resources.stages, null, null);

    expect(
      nodes.every((node) => node.value === null && node.queued === null && node.dlq === null),
    ).toBe(true);
  });

  test("marks the selected node", () => {
    const nodes = pipelineNodes(resources.stages, overview, "publish");

    expect(nodes.filter((node) => node.selected).map((node) => node.id)).toEqual(["publish"]);
    expect(queueOf(nodes.find((node) => node.selected))).toBe("publish");
    expect(queueOf(nodes[0])).toBeUndefined();
  });
});
