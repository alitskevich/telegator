import { WebClientService } from "arrmatura-web";
import type { Overview } from "tg-actions/dashboard/overview";
import type { ReplayableQueue } from "tg-enums/queueName";
import type { DlqMessage } from "tg-ports/queues";
import { MAX_CONSUME, MAX_PUBLISH_NOW } from "tg-ports/queues";
import { resources } from "tg-rc/web";
import { type PipelineNode, pipelineNodes, queueOf } from "../pipeline/nodes";
import { fill } from "../text/fill";
import type { ApiService } from "./ApiService";
import { asRecord } from "./GridService";

/**
 * §8.3 — the Pipeline page: §1.4's whole chain as one diagram, every queue's
 * depth and dead letters on it, and every manual trigger on the node it acts
 * on. Mounted as `<PipelineService Ref="pipeline" api="@api" />`.
 */

/** Depths move by the minute while a backlog drains; this is the page an operator watches. */
export const PIPELINE_REFRESH_MS = 30_000;

const DEFAULT_REPLAY_MAX = "10";

/** Tailwind's `xl`, from which `Page.Pipeline.xml` lays the diagram out in a row. */
const ROW_LAYOUT = "(min-width: 80rem)";
const PANEL_ID = "pipeline-panel";

export interface DeadLetter {
  readonly id: string;
  readonly body: string;
  readonly attempts: string;
}

const deadLetter = (message: DlqMessage): DeadLetter => ({
  id: message.messageId,
  body: message.body,
  attempts: fill(resources.pipeline.attempts, { count: message.receiveCount }),
});

interface ValueEvent {
  readonly value?: string;
}

export class PipelineService extends WebClientService {
  declare api: ApiService;

  data: Overview | null = null;
  loading = false;
  error: string | null = null;
  updatedAt: number | null = null;
  selectedId: string | null = null;
  /** The last peek per queue: `undefined` until inspected. */
  dlq: Readonly<Partial<Record<ReplayableQueue, readonly DlqMessage[]>>> = {};
  replayMax = DEFAULT_REPLAY_MAX;
  publishMax = String(MAX_PUBLISH_NOW);
  /** R57 — the DLQ depth a purge was armed at; see `purge`. */
  purgeArmedAt: number | null = null;

  declare nodes: readonly PipelineNode[];
  declare selected: PipelineNode | null;

  constructor() {
    super();
    this.__defineCalculatedProperties({
      "nodes(data,selectedId)": (data: Overview | null, selectedId: string | null) =>
        pipelineNodes(resources.stages, data, selectedId),
      "selected(data,selectedId)": (data: Overview | null, selectedId: string | null) =>
        pipelineNodes(resources.stages, data, selectedId).find((node) => node.selected) ?? null,
    });
  }

  get queue(): ReplayableQueue | undefined {
    return queueOf(this.selected ?? undefined);
  }

  /**
   * The selected queue's last peek, keyed for the template's `Each` and with
   * its attempt count worded; `null` when it has not been inspected.
   */
  get peek(): readonly DeadLetter[] | null {
    const queue = this.queue;
    const messages = queue === undefined ? undefined : this.dlq[queue];
    return messages === undefined ? null : messages.map(deadLetter);
  }

  get armedPurge(): boolean {
    return this.purgeArmedAt !== null && this.purgeArmedAt === this.selected?.dlq;
  }

  get purgeLabel(): string {
    return this.armedPurge
      ? fill(resources.pipeline.confirmCleanup, { count: this.selected?.dlq ?? 0 })
      : resources.pipeline.cleanup;
  }

  get consumeLabel(): string {
    return `${resources.pipeline.consume} (${MAX_CONSUME})`;
  }

  override __init(): void {
    void this.load();
    const timer = setInterval(() => void this.load(), PIPELINE_REFRESH_MS);
    this.defer(() => clearInterval(timer));
  }

  async load(): Promise<void> {
    this.up({ loading: true, error: null });
    try {
      const data = (await this.api.call("overview")) as Overview;
      this.up({ data, loading: false, updatedAt: Date.now() });
    } catch (error) {
      this.logError(error);
      this.up({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * A second press on the same node closes its panel. Until `xl` the diagram is
   * a column, so the panel can sit eight nodes down: it is scrolled into view.
   */
  select(event: { readonly id?: string }): void {
    const id = event.id ?? null;
    const selectedId = id === this.selectedId ? null : id;
    this.up({ selectedId, purgeArmedAt: null });

    if (selectedId !== null && !window.matchMedia(ROW_LAYOUT).matches) {
      requestAnimationFrame(() =>
        document.getElementById(PANEL_ID)?.scrollIntoView({ behavior: "smooth", block: "start" }),
      );
    }
  }

  setReplayMax(event: ValueEvent): void {
    this.up({ replayMax: event.value ?? "" });
  }

  setPublishMax(event: ValueEvent): void {
    this.up({ publishMax: event.value ?? "" });
  }

  /** §8.4 — reads DLQ bodies without consuming them; `viewer`. */
  async inspect(): Promise<void> {
    const queue = this.queue;
    if (queue === undefined) return;
    const messages = await this.api.run("inspectDlq", { queueName: queue }, { key: "inspect" });
    if (Array.isArray(messages)) this.up({ dlq: { ...this.dlq, [queue]: messages } });
  }

  /** R61 — one batch of this queue's stage, now, rather than when its mapping polls. */
  async consume(): Promise<void> {
    const queue = this.queue;
    if (queue === undefined) return;
    const done = await this.api.run(
      "consumeQueue",
      { queueName: queue, max: MAX_CONSUME },
      {
        key: "consume",
        success: (result) => fill(resources.toasts.consumeQueue, { ...asRecord(result), queue }),
      },
    );
    if (done !== undefined) await this.load();
  }

  /** §8.4 — invokes the replay handler over this queue's DLQ. */
  async replay(): Promise<void> {
    const queue = this.queue;
    const max = Number(this.replayMax);
    if (queue === undefined || !Number.isInteger(max) || max <= 0) return;
    const done = await this.api.run(
      "replayDlq",
      { queueName: queue, max },
      {
        key: "replay",
        success: (result) => fill(resources.toasts.replayDlq, { ...asRecord(result), queue }),
      },
    );
    if (done !== undefined) await this.afterDlqChange(queue);
  }

  /**
   * R57 — a purge cannot be undone: the DLQ is a dead-lettered post's last
   * copy. So it is armed by one press and fired by a second, and the second
   * label names the count. The armed *depth* is held, so a refresh that changes
   * the number disarms it rather than confirming a count no longer true.
   */
  async purge(): Promise<void> {
    const queue = this.queue;
    if (queue === undefined) return;
    if (!this.armedPurge) {
      this.up({ purgeArmedAt: this.selected?.dlq ?? null });
      return;
    }

    this.up({ purgeArmedAt: null });
    const done = await this.api.run(
      "purgeDlq",
      { queueName: queue },
      {
        key: "purge",
        success: (result) => fill(resources.toasts.purgeDlq, { ...asRecord(result), queue }),
      },
    );
    if (done !== undefined) await this.afterDlqChange(queue);
  }

  async scrapeNow(): Promise<void> {
    const done = await this.api.run("runScraper", undefined, {
      success: (result) => fill(resources.toasts.runScraper, asRecord(result)),
    });
    if (done !== undefined) await this.load();
  }

  async publishNow(): Promise<void> {
    const max = Number(this.publishMax);
    if (!Number.isInteger(max) || max <= 0 || max > MAX_PUBLISH_NOW) return;
    const done = await this.api.run(
      "publishPending",
      { max },
      { success: (result) => fill(resources.toasts.publishPending, asRecord(result)) },
    );
    if (done !== undefined) await this.load();
  }

  /** A peek taken before a replay or a purge lists messages that are gone. */
  private async afterDlqChange(queue: ReplayableQueue): Promise<void> {
    const { [queue]: _stale, ...dlq } = this.dlq;
    this.up({ dlq });
    await this.load();
  }
}
