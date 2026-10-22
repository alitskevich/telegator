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
  paused: { analyze: false, aggregate: true, publish: false },
  recent: [],
};

const byId = (nodes: ReturnType<typeof pipelineNodes>) =>
  Object.fromEntries(nodes.map((node) => [node.id, node]));

describe("pipelineNodes", () => {
  test("draws the chain scrape to publish, an arrow into every node but the first", () => {
    const nodes = pipelineNodes(resources.stages, null, null);

    expect(nodes.map((node) => node.id)).toEqual(["scrape", "analyze", "aggregate", "publish"]);
    expect(nodes.map((node) => node.arrow)).toEqual([false, true, true, true]);
  });

  test("a stage shows its count, and its queue and pause when it has a lane", () => {
    const nodes = byId(pipelineNodes(resources.stages, overview, null));

    expect(nodes.scrape).toMatchObject({ value: 120, valueLabel: "scraped, 24 h", queued: null });
    expect(nodes.analyze).toMatchObject({ value: 96, queued: 5, paused: false });
    expect(nodes.aggregate).toMatchObject({ hasValue: false, queued: 0, paused: true });
    expect(nodes.publish).toMatchObject({ value: 40, queued: 2 });
  });

  /** An unread count is not an empty one, and must not render as `0`. */
  test("before the first load every number is unknown", () => {
    const nodes = pipelineNodes(resources.stages, null, null);

    expect(nodes.every((node) => node.value === null && node.queued === null)).toBe(true);
  });

  test("marks the selected node", () => {
    const nodes = pipelineNodes(resources.stages, overview, "publish");

    expect(nodes.filter((node) => node.selected).map((node) => node.id)).toEqual(["publish"]);
    expect(queueOf(nodes.find((node) => node.selected))).toBe("publish");
    expect(queueOf(nodes[0])).toBeUndefined();
  });
});
