import { describe, expect, test } from "vitest";
import { recordingSink } from "../../test/fakes/logging.js";
import { createLogger } from "./logger.js";

describe("createLogger", () => {
  test("writes one JSON object per call", () => {
    const sink = recordingSink();
    const log = createLogger(sink);

    log.info("scraped");
    log.info("analyzed");

    expect(sink.lines).toHaveLength(2);
    expect(sink.lines.map((l) => JSON.parse(l).msg)).toEqual(["scraped", "analyzed"]);
  });

  test("records the level alongside the message", () => {
    const sink = recordingSink();

    createLogger(sink).warn("source stale");

    expect(JSON.parse(sink.lines[0] ?? "")).toMatchObject({ level: "warn", msg: "source stale" });
  });

  /**
   * §7.7 L695 sources the dashboard's category chart from a Logs Insights query
   * over analyze's logs rather than a metric. Insights discovers fields from the
   * top level of each JSON line, so a nested `fields` envelope would make
   * `stats count(*) by category` return nothing.
   */
  test("lifts caller fields to the top level, where Logs Insights can group them", () => {
    const sink = recordingSink();

    createLogger(sink).info("classified", { category: "geopolitics", itemId: "yigal_levin/12345" });

    expect(JSON.parse(sink.lines[0] ?? "")).toEqual({
      level: "info",
      msg: "classified",
      category: "geopolitics",
      itemId: "yigal_levin/12345",
    });
  });

  test("keeps a multi-line value on one line, so one record stays one log event", () => {
    const sink = recordingSink();

    createLogger(sink).info("parsed", { body: "line one\nline two" });

    expect(sink.lines[0]).not.toContain("\n");
    expect(JSON.parse(sink.lines[0] ?? "").body).toBe("line one\nline two");
  });

  test("a caller field cannot overwrite level or msg", () => {
    const sink = recordingSink();

    createLogger(sink).error("real failure", { level: "info", msg: "spoofed" });

    expect(JSON.parse(sink.lines[0] ?? "")).toMatchObject({ level: "error", msg: "real failure" });
  });

  /**
   * A logger that throws inside a `catch` converts a handled failure into an
   * unhandled one. §1.3 L49 makes that permanent data loss: a post that errors
   * past its retries exists only in the logs and the DLQ.
   */
  test("never throws on a value JSON cannot serialise", () => {
    const sink = recordingSink();
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => createLogger(sink).error("boom", { circular })).not.toThrow();
    expect(sink.lines).toHaveLength(1);
    expect(() => JSON.parse(sink.lines[0] ?? "")).not.toThrow();
  });

  test("emits every level named by the type", () => {
    const sink = recordingSink();
    const log = createLogger(sink);

    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");

    expect(sink.lines.map((l) => JSON.parse(l).level)).toEqual(["debug", "info", "warn", "error"]);
  });
});
