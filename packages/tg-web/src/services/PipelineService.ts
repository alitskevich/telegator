import { WebClientService } from "arrmatura-web";
import type { Overview } from "tg-actions/dashboard/types";
import { MAX_PUBLISH_NOW } from "tg-configs/limits";
import type { QueueName } from "tg-enums/queueName";
import type { StoredIngestItem } from "tg-firebase/types";
import { resources } from "tg-rc/web";
import { pipelineNodes, queueOf } from "../pipeline/nodes";
import type { PipelineNode } from "../pipeline/types";
import { fill } from "../text/fill";
import type { ApiService } from "./ApiService";
import { asRecord } from "./GridService";
import type { DeadLetter } from "./types";

/**
 * The Pipeline page: the whole chain as one diagram, with each stage's count,
 * queue and dead letters, and each manual trigger on the node it acts on.
 * Mounted as `<PipelineService Ref="pipeline" api="@api" />`.
 */

/** Counts move by the minute while a backlog drains; this is the page an operator watches. */
export const PIPELINE_REFRESH_MS = 30_000;

const DEFAULT_REPLAY_MAX = "10";

/** Tailwind's `lg`, from which `Page.Pipeline.xml` puts the panel beside the diagram. */
const SIDE_LAYOUT = "(min-width: 64rem)";
const PANEL_ID = "pipeline-panel";

const deadLetter = (letter: StoredIngestItem): DeadLetter => ({
  id: letter.id,
  body: `${letter.error ?? ""}\n${JSON.stringify(letter.raw, null, 2)}`,
  attempts: fill(resources.pipeline.attempts, { count: letter.retryCount }),
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
  dlq: Readonly<Partial<Record<QueueName, readonly StoredIngestItem[]>>> = {};
  replayMax = DEFAULT_REPLAY_MAX;
  publishMax = String(MAX_PUBLISH_NOW);
  /** The dead-letter count a purge was armed at; see `purge`. */
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

  get queue(): QueueName | undefined {
    return queueOf(this.selected ?? undefined);
  }

  /**
   * The selected stage's last peek, keyed for the template's `Each` and with
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
   * A second press on the same node closes its panel. Until `lg` the panel sits
   * below the diagram, six rows down: it is scrolled into view.
   */
  select(event: { readonly id?: string }): void {
    const id = event.id ?? null;
    const selectedId = id === this.selectedId ? null : id;
    this.up({ selectedId, purgeArmedAt: null });

    if (selectedId !== null && !window.matchMedia(SIDE_LAYOUT).matches) {
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

  /** Reads dead letters without consuming them; `viewer`. */
  async inspect(): Promise<void> {
    const queue = this.queue;
    if (queue === undefined) return;
    const messages = await this.api.run("inspectDlq", { queueName: queue }, { key: "inspect" });
    if (Array.isArray(messages)) this.up({ dlq: { ...this.dlq, [queue]: messages } });
  }

  /** Re-enqueues up to `replayMax` of this stage's dead letters. */
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
   * A purge cannot be undone: a dead letter is a post's last copy. So it takes two
   * presses, and the second label names the count. The armed count is held, so a
   * refresh that changes it disarms the purge.
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
  private async afterDlqChange(queue: QueueName): Promise<void> {
    const { [queue]: _stale, ...dlq } = this.dlq;
    this.up({ dlq });
    await this.load();
  }
}
