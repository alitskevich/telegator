import { describe, expect, test } from "vitest";
import { recordingMetrics } from "../../test/fakes/metrics";
import { METRIC_NAMES, METRIC_NAMESPACE } from "./ports";

describe("the metric catalogue", () => {
  test("is the twelve names §7.7 L684-693 lists, then R50's two", () => {
    expect([...METRIC_NAMES]).toEqual([
      "ItemsScraped",
      "ItemsDropped",
      "ItemsAnalyzed",
      "ItemsSkipped",
      "MessagesCreated",
      "MessagesMerged",
      "MessagesPublished",
      "MessagesEdited",
      "DedupCandidateCount",
      "MemberCapReached",
      "TelegramApiErrors",
      "SourceStale",
      "DedupAdjudicated",
      "DedupAdjudicationFailed",
    ]);
  });

  /**
   * R50 — §7.7's table predates R46's band, so these two are the plan's own.
   * Named separately from the list above so the reason survives a future
   * reordering of it.
   */
  test("counts adjudication volume and failure (R50)", () => {
    expect(METRIC_NAMES).toContain("DedupAdjudicated");
    expect(METRIC_NAMES).toContain("DedupAdjudicationFailed");
  });

  test("publishes under the namespace §7.7 L681 names", () => {
    expect(METRIC_NAMESPACE).toBe("Telegator");
  });
});

describe("recordingMetrics", () => {
  test("reports zero for a metric that was never emitted", () => {
    expect(recordingMetrics().get("MessagesPublished")).toBe(0);
  });

  test("accumulates repeated counts", () => {
    const metrics = recordingMetrics();

    metrics.count("MessagesCreated", 1);
    metrics.count("MessagesCreated", 1);

    expect(metrics.get("MessagesCreated")).toBe(2);
  });

  test("counts a value larger than one, as DedupCandidateCount emits", () => {
    const metrics = recordingMetrics();

    metrics.count("DedupCandidateCount", 501);

    expect(metrics.get("DedupCandidateCount")).toBe(501);
  });

  /**
   * §3.2 L241-242 routes drops by reason, and §8.5 L767 charts items skipped
   * "Sum by Reason". A fake that collapsed the dimension would let a test pass
   * while the stage attributed every skip to the wrong cause.
   */
  test("keeps dimension sets apart", () => {
    const metrics = recordingMetrics();

    metrics.count("ItemsSkipped", 1, { Reason: "low" });
    metrics.count("ItemsSkipped", 1, { Reason: "low" });
    metrics.count("ItemsSkipped", 1, { Reason: "category" });

    expect(metrics.get("ItemsSkipped", { Reason: "low" })).toBe(2);
    expect(metrics.get("ItemsSkipped", { Reason: "category" })).toBe(1);
    expect(metrics.get("ItemsSkipped", { Reason: "nobody" })).toBe(0);
  });

  test("sums across every dimension set when no dimensions are asked for", () => {
    const metrics = recordingMetrics();

    metrics.count("ItemsScraped", 3, { Source: "yigal_levin" });
    metrics.count("ItemsScraped", 4, { Source: "nexta_live" });

    expect(metrics.get("ItemsScraped")).toBe(7);
  });

  test("does not confuse an undimensioned emission with a dimensioned one", () => {
    const metrics = recordingMetrics();

    // R25: SourceStale is emitted twice — dimensioned for drill-down, and
    // undimensioned because a CloudWatch alarm cannot enumerate a runtime-
    // discovered Source dimension at synth time.
    metrics.count("SourceStale", 1, { Source: "yigal_levin" });
    metrics.count("SourceStale", 1);

    expect(metrics.get("SourceStale", { Source: "yigal_levin" })).toBe(1);
    expect(metrics.get("SourceStale")).toBe(2);
    expect(metrics.records).toHaveLength(2);
  });
});
