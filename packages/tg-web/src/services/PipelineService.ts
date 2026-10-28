import { WebClientService } from "arrmatura-web";
import type { Overview, QueueItemPreview, SourcePreview } from "tg-actions/dashboard/types";
import { MAX_PUBLISH_NOW } from "tg-configs/limits";
import type { QueueName } from "tg-enums/queueName";
import { resources } from "tg-rc/web";
import { conicGradient, toPieSlices } from "tg-utils/ui/pie";
import type { Slice } from "tg-utils/ui/types";
import { clock } from "../functions";
import { pipelineNodes, queueOf } from "../pipeline/nodes";
import type { PipelineNode } from "../pipeline/types";
import { fill } from "../text/fill";
import type { ApiService } from "./ApiService";
import { asRecord } from "./GridService";
import type { Donut, QueueRow, SourceRow } from "./types";

/**
 * The Dashboard page: the whole chain as one diagram, with each stage's count and
 * queue, and each manual trigger on the node it acts on; with no node selected,
 * the overview's figures and charts.
 * Mounted as `<PipelineService Ref="pipeline" api="@api" browser="@browser" selectedId="{@browser.params.node}" />`.
 */

/** Counts move by the minute while a backlog drains; this is the page an operator watches. */
export const PIPELINE_REFRESH_MS = 30_000;

const DEFAULT_STEP_MAX = "1";

/** Tailwind's `lg`, from which `Page.Dashboard.xml` puts the panel beside the diagram. */
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
    source.type,
    fill(resources.pipeline.lastCount, { count: source.lastCount }),
  ].join(" · "),
  next: source.next,
});

const donut = (values: readonly Slice[] | undefined): Donut => {
  const slices = toPieSlices(values ?? []);
  return { slices, background: conicGradient(slices) };
};

/** The skip split by reason, e.g. "category 10 · low 14". */
export const skipNote = (overview: Overview | null): string =>
  Object.entries(overview?.skipped.byReason ?? {})
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(" · ");

interface ValueEvent {
  readonly value?: string;
}

/** The one `BrowserService` method this service calls. */
interface Browser {
  setParam(key: string, value: string | null): void;
}

export class PipelineService extends WebClientService {
  declare api: ApiService;
  declare browser: Browser;

  data: Overview | null = null;
  loading = false;
  error: string | null = null;
  updatedAt: number | null = null;
  /** The next items per stage: `undefined` until read. */
  next: Readonly<Partial<Record<QueueName, readonly QueueItemPreview[]>>> = {};
  /** The enabled sources, the next run's first: `null` until read. */
  sourceItems: readonly SourcePreview[] | null = null;
  publishMax = String(MAX_PUBLISH_NOW);
  stepMax = DEFAULT_STEP_MAX;
  /** A first press of *Reset ingest*; see `resetIngest`. */
  resetArmed = false;
  /** A first press of *Reset all cursors*; see `resetCursors`. */
  cursorsArmed = false;

  declare nodes: readonly PipelineNode[];
  declare selected: PipelineNode | null;
  declare statusChart: Donut;
  declare categoryChart: Donut;
  declare skipped: string;

  #selectedId: string | null = null;

  constructor() {
    super();
    this.__defineCalculatedProperties({
      "nodes(data,selectedId)": (data: Overview | null, selectedId: string | null) =>
        pipelineNodes(resources.stages, data, selectedId),
      "selected(data,selectedId)": (data: Overview | null, selectedId: string | null) =>
        pipelineNodes(resources.stages, data, selectedId).find((node) => node.selected) ?? null,
      "statusChart(data)": (data: Overview | null) => donut(data?.statusSlices),
      "categoryChart(data)": (data: Overview | null) => donut(data?.categorySlices),
      "skipped(data)": skipNote,
    });
  }

  /** The selected node is `?node=`, so a reload or a shared link opens the same one. */
  get selectedId(): string | null {
    return this.#selectedId;
  }

  set selectedId(value: unknown) {
    const next = typeof value === "string" && value !== "" ? value : null;
    if (next === this.#selectedId) return;
    this.#selectedId = next;
    // Before the first overview, `load` reads it.
    if (this.data !== null) void this.loadSelected();
  }

  get queue(): QueueName | undefined {
    return queueOf(this.selected ?? undefined);
  }

  /** The sources the selected node lists: its reader's. */
  get sourceRows(): readonly SourceRow[] | null {
    const now = Date.now();
    const type = this.selected?.sources;
    return (
      this.sourceItems
        ?.filter((source) => source.type === type)
        .map((source) => sourceRow(source, now)) ?? null
    );
  }

  /** What a source added on the selected node writes besides `NEW_ROW`: that node's reader. */
  get sourceDefaults(): Readonly<Record<string, string>> {
    return this.selected?.sources === undefined ? {} : { type: this.selected.sources };
  }

  /** How many sources *Scrape now*, a Telegram run, would poll; `null` until read. */
  get scrapeDue(): number | null {
    return (
      this.sourceItems?.filter((source) => source.next && source.type === "telegram").length ?? null
    );
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

  get resetLabel(): string {
    return this.resetArmed ? resources.pipeline.confirmResetIngest : resources.pipeline.resetIngest;
  }

  get cursorsLabel(): string {
    return this.cursorsArmed
      ? resources.pipeline.confirmResetCursors
      : resources.pipeline.resetCursors;
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
   * Writes `?node=`; a second press on the same node clears it and closes the panel.
   * Until `lg` the panel sits below the diagram, six rows down: it is scrolled into view.
   */
  select(event: { readonly id?: string }): void {
    const id = event.id ?? "";
    const node = id === this.selectedId ? "" : id;
    this.up({ resetArmed: false, cursorsArmed: false });
    this.browser.setParam("node", node || null);

    if (node !== "" && !window.matchMedia(SIDE_LAYOUT).matches) {
      requestAnimationFrame(() =>
        document.getElementById(PANEL_ID)?.scrollIntoView({ behavior: "smooth", block: "start" }),
      );
    }
  }

  setPublishMax(event: ValueEvent): void {
    this.up({ publishMax: event.value ?? "" });
  }

  setStepMax(event: ValueEvent): void {
    this.up({ stepMax: event.value ?? "" });
  }

  /** Reads what the selected node lists: the sources, or a stage's next items. */
  private async loadSelected(): Promise<void> {
    if (this.selected?.sources !== undefined) await this.loadSources();
    else await this.loadNext();
  }

  /** `viewer`. */
  async loadSources(): Promise<void> {
    const items = await this.api.run("inspectSources", undefined, { key: "sources" });
    if (Array.isArray(items)) this.up({ sourceItems: items });
  }

  /** Reads the selected stage's next items; `viewer`. */
  async loadNext(): Promise<void> {
    const queue = this.queue;
    if (queue === undefined) return;
    const items = await this.api.run("inspectQueue", { queueName: queue }, { key: "next" });
    if (Array.isArray(items)) this.up({ next: { ...this.next, [queue]: items } });
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

  /** Deletes every `ingest` item. It cannot be undone, so it takes two presses. */
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

  /** Drops every source's cursor, so the next scrape starts from each latest post; two presses. */
  async resetCursors(): Promise<void> {
    if (!this.cursorsArmed) {
      this.up({ cursorsArmed: true });
      return;
    }

    this.up({ cursorsArmed: false });
    const done = await this.api.run("resetSourceCursors", undefined, {
      success: (result) => fill(resources.toasts.resetSourceCursors, asRecord(result)),
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
