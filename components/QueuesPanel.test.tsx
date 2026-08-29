// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { QueueRow } from "../lib/dashboard/queues.js";
import type { DlqMessage } from "../lib/queues/inspect.js";
import { QueuesPanel } from "./QueuesPanel.js";

type InspectFn = (queueName: string) => Promise<DlqMessage[]>;
type ReplayFn = (queueName: string, max: number) => Promise<{ replayed: number }>;

let onInspect: ReturnType<typeof vi.fn<InspectFn>>;
let onReplay: ReturnType<typeof vi.fn<ReplayFn>>;

const MESSAGES: DlqMessage[] = [
  { messageId: "m1", body: '{"id":"example/1"}', receiveCount: 3 },
  { messageId: "m2", body: '{"id":"example/2"}', receiveCount: 1 },
];

const rows: QueueRow[] = [
  { name: "analyze", depth: 4, dlqDepth: 2, dlqUrl: "dlq/analyze" },
  { name: "aggregate", depth: 0, dlqDepth: 0, dlqUrl: "dlq/aggregate" },
  { name: "publish", depth: 1, dlqDepth: 0, dlqUrl: "dlq/publish" },
];

beforeEach(() => {
  onInspect = vi.fn<InspectFn>(async () => MESSAGES);
  onReplay = vi.fn<ReplayFn>(async () => ({ replayed: 2 }));
});

afterEach(cleanup);

const draw = (props: Partial<Parameters<typeof QueuesPanel>[0]> = {}) =>
  render(<QueuesPanel rows={rows} canAdmin onInspect={onInspect} onReplay={onReplay} {...props} />);

const queue = (name: string) => screen.getByTestId(`queue-${name}`);

describe("QueuesPanel — §8.2 L723", () => {
  test("shows every stage with both depths", () => {
    draw();

    for (const name of ["analyze", "aggregate", "publish"]) {
      expect(queue(name)).toBeDefined();
    }
    expect(within(queue("analyze")).getByText("4")).toBeDefined();
  });

  /** A non-empty DLQ is the number that means someone has to act. */
  test("marks a queue whose DLQ is not empty", () => {
    draw();

    expect(queue("analyze").className).toContain("queue-card-alert");
    expect(queue("aggregate").className).not.toContain("queue-card-alert");
  });

  describe("inspection", () => {
    test("reads nothing until asked", () => {
      draw();
      expect(onInspect).not.toHaveBeenCalled();
    });

    test("shows the bodies for the queue inspected", async () => {
      draw();
      fireEvent.click(within(queue("analyze")).getByRole("button", { name: "Inspect" }));

      expect(onInspect).toHaveBeenCalledWith("analyze");
      expect(await screen.findByText(/example\/1/)).toBeDefined();
    });

    /** §3.5's replay decides by attempt count, so the panel shows it. */
    test("shows how many times each message was attempted", async () => {
      draw();
      fireEvent.click(within(queue("analyze")).getByRole("button", { name: "Inspect" }));

      expect(await screen.findByText(/3 attempts/)).toBeDefined();
    });

    test("says so when a DLQ is empty", async () => {
      onInspect = vi.fn<InspectFn>(async () => []);
      draw();
      fireEvent.click(within(queue("publish")).getByRole("button", { name: "Inspect" }));

      expect(await screen.findByText(/nothing in this dlq/i)).toBeDefined();
    });

    /** A payload is arbitrary text from a third-party channel. */
    test("escapes a body containing markup", async () => {
      onInspect = vi.fn<InspectFn>(async () => [
        { messageId: "m1", body: '<img src=x onerror="alert(1)">', receiveCount: 1 },
      ]);
      const { container } = draw();
      fireEvent.click(within(queue("analyze")).getByRole("button", { name: "Inspect" }));

      expect(await screen.findByText(/img src=x/)).toBeDefined();
      expect(container.querySelector("img")).toBeNull();
    });
  });

  describe("replay (§8.4 L754)", () => {
    test("replays the named queue up to the given max", async () => {
      draw();
      const card = queue("analyze");
      fireEvent.change(within(card).getByLabelText("max"), { target: { value: "5" } });
      fireEvent.click(within(card).getByRole("button", { name: "Replay" }));

      expect(onReplay).toHaveBeenCalledWith("analyze", 5);
      expect(await screen.findByText(/replayed 2/i)).toBeDefined();
    });

    /** The handler bounds the drain by `max`, so an unusable one must not be sent. */
    test("will not replay with a non-positive max", () => {
      draw();
      const card = queue("analyze");
      fireEvent.change(within(card).getByLabelText("max"), { target: { value: "0" } });
      fireEvent.click(within(card).getByRole("button", { name: "Replay" }));

      expect(onReplay).not.toHaveBeenCalled();
    });

    /**
     * Replaying an empty DLQ is a no-op that still invokes a Lambda and reads a
     * queue, so the control is not offered.
     */
    test("offers no replay for an empty DLQ", () => {
      draw();
      expect(within(queue("aggregate")).queryByRole("button", { name: "Replay" })).toBeNull();
    });

    /** §8.4 L754 — `admin`. Inspection stays available to everyone (§8.6 L783). */
    test("a viewer sees no replay control but may still inspect", () => {
      draw({ canAdmin: false });

      expect(screen.queryByRole("button", { name: "Replay" })).toBeNull();
      expect(within(queue("analyze")).getByRole("button", { name: "Inspect" })).toBeDefined();
    });
  });
});
