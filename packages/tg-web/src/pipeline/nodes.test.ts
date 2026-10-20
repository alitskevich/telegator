import type { Overview } from "tg-actions/dashboard/overview";
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
  strip: [
    { label: "analyze", depth: 5, dlqDepth: 0 },
    { label: "aggregate", depth: 0, dlqDepth: 0 },
    { label: "publish", depth: 2, dlqDepth: 3 },
  ],
  recent: [],
};

const byId = (nodes: ReturnType<typeof pipelineNodes>) =>
  Object.fromEntries(nodes.map((node) => [node.id, node]));

describe("pipelineNodes", () => {
  test("draws the chain in order, schedule to Telegram", () => {
    expect(pipelineNodes(resources.stages, null, null).map((node) => node.id)).toEqual([
      "schedule",
      "scrape",
      "analyze-queue",
      "analyze",
      "aggregate-queue",
      "aggregate",
      "publish-queue",
      "publish",
      "telegram",
    ]);
  });

  test("a stage shows its count, a queue its depth and dead letters", () => {
    const nodes = byId(pipelineNodes(resources.stages, overview, null));

    expect(nodes.scrape).toMatchObject({ value: 120, valueLabel: "scraped, 24 h" });
    expect(nodes["analyze-queue"]).toMatchObject({ value: 5, valueLabel: "in queue", dlq: 0 });
    expect(nodes.publish).toMatchObject({ value: 40 });
  });

  /** An unreadable queue is not an empty one, and must not render as `0`. */
  test("an empty queue is zero and raises no alarm", () => {
    const node = byId(pipelineNodes(resources.stages, overview, null))["aggregate-queue"];

    expect(node).toMatchObject({ value: 0, dlq: 0, alert: false });
  });

  test("dead letters raise the alert", () => {
    const nodes = byId(pipelineNodes(resources.stages, overview, null));

    expect(nodes["publish-queue"]?.alert).toBe(true);
    expect(nodes["analyze-queue"]?.alert).toBe(false);
  });

  test("before the first load every number is unknown", () => {
    const nodes = pipelineNodes(resources.stages, null, null);

    expect(nodes.every((node) => node.value === null)).toBe(true);
  });

  test("marks the selected node", () => {
    const nodes = pipelineNodes(resources.stages, overview, "publish-queue");

    expect(nodes.filter((node) => node.selected).map((node) => node.id)).toEqual(["publish-queue"]);
    expect(queueOf(nodes.find((node) => node.selected))).toBe("publish");
    expect(queueOf(nodes[0])).toBeUndefined();
  });
});
