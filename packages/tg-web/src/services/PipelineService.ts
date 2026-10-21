import { WebClientService } from "arrmatura-web";
import type {
  ErrorPreview,
  ItemDetail,
  Overview,
  QueueItemPreview,
  SourcePreview,
} from "tg-actions/dashboard/types";
import { MAX_PUBLISH_NOW } from "tg-configs/limits";
import type { QueueName } from "tg-enums/queueName";
import { resources } from "tg-rc/web";
import { clock } from "../functions";
import { pipelineNodes, queueOf } from "../pipeline/nodes";
import type { PipelineNode } from "../pipeline/types";
import { fill } from "../text/fill";
import type { ApiService } from "./ApiService";
import { asRecord } from "./GridService";
import type { ErrorRow, ItemFact, QueueRow, SourceRow } from "./types";

/**
 * The Pipeline page: the whole chain as one diagram, with each stage's count and
 * queue, the Errors node, and each manual trigger on the node it acts on.
 * Mounted as `<PipelineService Ref="pipeline" api="@api" />`.
 */

/** Counts move by the minute while a backlog drains; this is the page an operator watches. */
export const PIPELINE_REFRESH_MS = 30_000;

const DEFAULT_REPLAY_MAX = "10";
const DEFAULT_STEP_MAX = "1";

/** Tailwind's `lg`, from which `Page.Pipeline.xml` puts the panel beside the diagram. */
/** The stage whose panel lists the sources, not a queue. */
const SCRAPE = "scrape";

const SIDE_LAYOUT = "(min-width: 64rem)";
const PANEL_ID = "pipeline-panel";

const whenDue = (item: QueueItemPreview): string => {
  if (item.status === "running") return resources.pipeline.running;
  if (item.runAt === 0) return resources.pipeline.headOfQueue;
  return fill(resources.pipeline.due, { time: clock(item.runAt) });
};

const queueRow = (item: QueueItemPreview): QueueRow => ({
  id: item.id,
  ref: item.ref || item.id,
  text: item.text,
  meta: [
    whenDue(item),
    item.retryCount > 0 ? fill(resources.pipeline.failedTimes, { count: item.retryCount }) : "",
  ]
    .filter(Boolean)
    .join(" · "),
  error: item.error ?? "",
  canRun: item.status === "pending",
});

const whenPolled = (source: SourcePreview, now: number): string => {
  if (source.next) return resources.pipeline.nextRun;
  if (source.dueAt <= now) return resources.pipeline.afterNextRun;
  return fill(resources.pipeline.due, { time: clock(source.dueAt) });
};

const sourceRow = (source: SourcePreview, now: number): SourceRow => ({
  id: source.id,
  meta: [
    whenPolled(source, now),
    source.via,
    fill(resources.pipeline.lastCount, { count: source.lastCount }),
  ].join(" · "),
  next: source.next,
});

const itemFacts = (item: ItemDetail): ItemFact[] => {
  const label = resources.pipeline.item;
  return [
    { id: "stage", label: label.stage, value: item.stage },
    { id: "status", label: label.status, value: item.status },
    { id: "failed", label: label.failed, value: String(item.retryCount) },
    { id: "created", label: label.created, value: clock(item.createdAt) },
    { id: "runAt", label: label.runAt, value: clock(item.runAt) },
    {
      id: "finished",
      label: label.finished,
      value: item.finishedAt === null ? "" : clock(item.finishedAt),
    },
    { id: "error", label: label.error, value: item.error ?? "" },
  ].filter((fact) => fact.value !== "");
};

const errorRow = (item: ErrorPreview): ErrorRow => ({
  id: item.id,
  ref: item.ref || item.id,
  text: item.text,
  meta: [
    item.stage,
    item.ref || item.id,
    clock(item.failedAt),
    fill(resources.pipeline.attempts, { count: item.retryCount }),
  ].join(" · "),
  error: item.error ?? "",
  cause: item.cause ?? "",
  diagnosis: item.diagnosis,
  analyseLabel:
    item.diagnosis === null ? resources.pipeline.analyse : resources.pipeline.analyseAgain,
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
  /** The next items per stage: `undefined` until read. */
  next: Readonly<Partial<Record<QueueName, readonly QueueItemPreview[]>>> = {};
  /** The enabled sources, the next run's first: `null` until read. */
  sourceItems: readonly SourcePreview[] | null = null;
  /** Every stage's failed items, oldest first: `null` until read. */
  errorItems: readonly ErrorPreview[] | null = null;
  replayMax = DEFAULT_REPLAY_MAX;
  publishMax = String(MAX_PUBLISH_NOW);
  stepMax = DEFAULT_STEP_MAX;
  /** The error count a purge was armed at; see `purge`. */
  purgeArmedAt: number | null = null;
  /** A first press of *Reset ingest*; see `resetIngest`. */
  resetArmed = false;
  /** The item the modal shows, read whole: `null` while closed. */
  detail: ItemDetail | null = null;
  /** The payload as `Forma` last changed it: `null` until an edit. */
  draft: Readonly<Record<string, unknown>> | null = null;

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

  get errorRows(): readonly ErrorRow[] | null {
    return this.errorItems?.map(errorRow) ?? null;
  }

  get sourceRows(): readonly SourceRow[] | null {
    const now = Date.now();
    return this.sourceItems?.map((source) => sourceRow(source, now)) ?? null;
  }

  /** How many sources *Scrape now*, a web run, would poll; `null` until read. */
  get scrapeDue(): number | null {
    return this.sourceItems?.filter((source) => source.next && source.via === "web").length ?? null;
  }

  /** Messages waiting to be published; `null` until read. */
  get toPublish(): number | null {
    return this.data?.statusSlices.find((slice) => slice.label === "topublish")?.value ?? null;
  }

  /** The selected stage's next items, soonest first; `null` until read. */
  get nextItems(): readonly QueueRow[] | null {
    const queue = this.queue;
    const items = queue === undefined ? undefined : this.next[queue];
    return items === undefined ? null : items.map(queueRow);
  }

  get armedPurge(): boolean {
    return this.purgeArmedAt !== null && this.purgeArmedAt === this.selected?.value;
  }

  get purgeLabel(): string {
    return this.armedPurge
      ? fill(resources.pipeline.confirmCleanup, { count: this.selected?.value ?? 0 })
      : resources.pipeline.cleanup;
  }

  /** The post or message the item carries, as its row names it. */
  get detailTitle(): string {
    const raw = this.detail?.raw;
    const ref = raw?.id ?? raw?.messageId ?? this.detail?.id;
    return typeof ref === "string" ? ref : "";
  }

  get detailFacts(): readonly ItemFact[] {
    return this.detail === null ? [] : itemFacts(this.detail);
  }

  get detailFields(): readonly object[] {
    return this.detail === null ? [] : resources.payloadFields[this.detail.stage];
  }

  get detailJson(): string {
    return JSON.stringify(this.draft ?? this.detail?.raw ?? {}, null, 2);
  }

  /** A running or finished item belongs to its stage; the API refuses the edit regardless. */
  get canEditDetail(): boolean {
    const status = this.detail?.status;
    return this.api.canAdmin && (status === "pending" || status === "error");
  }

  get resetLabel(): string {
    return this.resetArmed ? resources.pipeline.confirmResetIngest : resources.pipeline.resetIngest;
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
      await this.loadSelected();
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
    this.up({ selectedId, purgeArmedAt: null, resetArmed: false });
    void this.loadSelected();

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

  setStepMax(event: ValueEvent): void {
    this.up({ stepMax: event.value ?? "" });
  }

  /** Reads what the selected node lists: the sources, a stage's next items, or the errors. */
  private async loadSelected(): Promise<void> {
    if (this.selected?.kind === "errors") await this.loadErrors();
    else if (this.selected?.id === SCRAPE) await this.loadSources();
    else await this.loadNext();
  }

  /** `viewer`. */
  async loadSources(): Promise<void> {
    const items = await this.api.run("inspectSources", undefined, { key: "sources" });
    if (Array.isArray(items)) this.up({ sourceItems: items });
  }

  /** `viewer`. */
  async loadErrors(): Promise<void> {
    const items = await this.api.run("inspectErrors", undefined, { key: "errors" });
    if (Array.isArray(items)) this.up({ errorItems: items });
  }

  /** Reads the selected stage's next items; `viewer`. */
  async loadNext(): Promise<void> {
    const queue = this.queue;
    if (queue === undefined) return;
    const items = await this.api.run("inspectQueue", { queueName: queue }, { key: "next" });
    if (Array.isArray(items)) this.up({ next: { ...this.next, [queue]: items } });
  }

  /** Opens the item modal; `viewer`. */
  async openItem(event: { readonly id?: string }): Promise<void> {
    if (event.id === undefined) return;
    const detail = await this.api.run("inspectItem", { id: event.id }, { key: "item" });
    if (detail !== undefined) this.up({ detail: detail as ItemDetail, draft: null });
  }

  closeItem(): void {
    this.up({ detail: null, draft: null });
  }

  setDraft(raw: Readonly<Record<string, unknown>>): void {
    this.up({ draft: raw });
  }

  /** Saves the edited payload, then shows the item as stored. */
  async saveItem(): Promise<void> {
    const id = this.detail?.id;
    if (id === undefined || this.draft === null) return;
    const ref = this.detailTitle;
    const done = await this.api.run(
      "editItem",
      { id, raw: this.draft },
      { success: () => fill(resources.toasts.saved, { id: ref }) },
    );
    if (done === undefined) return;
    await this.openItem({ id });
    await this.load();
  }

  /** Asks the model why one error happened and how to fix it; the answer stays on the item. */
  async diagnose(event: { readonly id?: string; readonly ref?: string }): Promise<void> {
    if (event.id === undefined) return;
    const ref = event.ref ?? event.id;
    const done = await this.api.run(
      "diagnoseError",
      { id: event.id },
      { key: "diagnose", success: () => fill(resources.toasts.diagnoseError, { ref }) },
    );
    if (done !== undefined) await this.loadErrors();
  }

  /** Runs one waiting or failed item next, even on a paused stage. */
  async runItem(event: { readonly id?: string; readonly ref?: string }): Promise<void> {
    if (event.id === undefined) return;
    const ref = event.ref ?? event.id;
    const done = await this.api.run(
      "runItem",
      { id: event.id },
      {
        success: (result) =>
          fill(asRecord(result).started ? resources.toasts.runItem : resources.toasts.runItemGone, {
            ref,
          }),
      },
    );
    if (done !== undefined) await this.load();
  }

  /** Sends up to `replayMax` errors, oldest first, back to their stages. */
  async replay(): Promise<void> {
    const max = Number(this.replayMax);
    if (!Number.isInteger(max) || max <= 0) return;
    const done = await this.api.run(
      "retryErrors",
      { max },
      { key: "replay", success: (result) => fill(resources.toasts.retryErrors, asRecord(result)) },
    );
    if (done !== undefined) await this.load();
  }

  /**
   * A purge cannot be undone: an error is a post's last copy. So it takes two
   * presses, and the second label names the count. The armed count is held, so a
   * refresh that changes it disarms the purge.
   */
  async purge(): Promise<void> {
    if (!this.armedPurge) {
      this.up({ purgeArmedAt: this.selected?.value ?? null });
      return;
    }

    this.up({ purgeArmedAt: null });
    const done = await this.api.run("purgeErrors", undefined, {
      key: "purge",
      success: (result) => fill(resources.toasts.purgeErrors, asRecord(result)),
    });
    if (done !== undefined) await this.load();
  }

  async scrapeNow(): Promise<void> {
    const done = await this.api.run("runScraper", undefined, {
      success: (result) => fill(resources.toasts.runScraper, asRecord(result)),
    });
    if (done !== undefined) await this.load();
  }

  /** Queues one fake post for analyze; it is published like any post. */
  async emulate(): Promise<void> {
    const done = await this.api.run("emulateItem", undefined, {
      success: (result) => fill(resources.toasts.emulateItem, asRecord(result)),
    });
    if (done !== undefined) await this.load();
  }

  /** Deletes every `ingest` item. It cannot be undone, so it takes two presses, as `purge` does. */
  async resetIngest(): Promise<void> {
    if (!this.resetArmed) {
      this.up({ resetArmed: true });
      return;
    }

    this.up({ resetArmed: false });
    const done = await this.api.run("resetIngest", undefined, {
      success: (result) => fill(resources.toasts.resetIngest, asRecord(result)),
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

  /** Runs every waiting item of the selected stage now, delays and backoff skipped. */
  async runNow(): Promise<void> {
    await this.runStage(undefined);
  }

  /** On a paused stage: runs its next `stepMax` items, and only those. */
  async step(): Promise<void> {
    const max = Number(this.stepMax);
    if (Number.isInteger(max) && max > 0) await this.runStage(max);
  }

  async togglePause(): Promise<void> {
    const queue = this.queue;
    if (queue === undefined) return;
    const paused = !this.selected?.paused;
    const toast = paused ? resources.toasts.pauseStage : resources.toasts.resumeStage;
    const done = await this.api.run(
      "pauseStage",
      { queueName: queue, paused },
      { key: "pause", success: () => fill(toast, { queue }) },
    );
    if (done !== undefined) await this.load();
  }

  private async runStage(max: number | undefined): Promise<void> {
    const queue = this.queue;
    if (queue === undefined) return;
    const done = await this.api.run(
      "runStage",
      { queueName: queue, max },
      {
        key: "runStage",
        success: (result) => fill(resources.toasts.runStage, { ...asRecord(result), queue }),
      },
    );
    if (done !== undefined) await this.load();
  }
}
