import { WebClientService } from "arrmatura-web";
import type { ItemPreview } from "tg-actions/dashboard/types";
import { IngestStatusSchema } from "tg-enums/ingestStatus";
import { QueueNameSchema } from "tg-enums/queueName";
import { clock } from "../functions";
import type { ApiService } from "./ApiService";
import type { ItemRow } from "./types";

/**
 * The Items page: one stage's `ingest` items, or every stage's, in one status,
 * or in any, newest first. Both are url params, so a reload or a shared link
 * shows the same list.
 * Mounted as `<ItemsService Ref="items" api="@api" stage="{@browser.params.stage}" status="{@browser.params.status}" />`.
 */

/** The stage filter's value for every stage at once; not a stored stage. */
const ALL_STAGES = "all";
/** The status filter's value for every status at once; not a stored status. */
const ALL_STATUSES = "all";
const DEFAULT_STAGE = "analyze";

export const itemRow = (item: ItemPreview): ItemRow => ({
  id: item.id,
  ref: item.ref || item.id,
  stage: item.stage,
  text: item.text,
  status: item.status,
  failed: item.retryCount,
  created: clock(item.createdAt),
  runAt: clock(item.runAt),
  error: item.error ?? "",
  canRun: item.status === "pending" || item.status === "error",
});

interface ValueEvent {
  readonly value?: string;
}

export class ItemsService extends WebClientService {
  declare api: ApiService;

  items: ItemPreview[] | null = null;
  loading = false;
  error: string | null = null;
  keyword = "";

  #stage = DEFAULT_STAGE;
  #status = ALL_STATUSES;
  #ready = false;

  get stage(): string {
    return this.#stage;
  }

  set stage(value: unknown) {
    // A mistyped URL falls back to the first stage rather than to an error page.
    const parsed = QueueNameSchema.safeParse(value);
    const stage = parsed.success ? parsed.data : DEFAULT_STAGE;
    this.#set(value === ALL_STAGES ? ALL_STAGES : stage, this.#status);
  }

  get status(): string {
    return this.#status;
  }

  set status(value: unknown) {
    const parsed = IngestStatusSchema.safeParse(value);
    this.#set(this.#stage, parsed.success ? parsed.data : ALL_STATUSES);
  }

  /** The rows on screen: the keyword matches the item, its text or its error. */
  get rows(): readonly ItemRow[] | null {
    const keyword = this.keyword.trim().toLowerCase();
    const rows = this.items?.map(itemRow) ?? null;
    if (rows === null || keyword === "") return rows;
    return rows.filter((row) =>
      [row.ref, row.text, row.error].some((value) => value.toLowerCase().includes(keyword)),
    );
  }

  override __init(): void {
    this.#ready = true;
    void this.load();
  }

  #set(stage: string, status: string): void {
    if (stage === this.#stage && status === this.#status) return;
    this.#stage = stage;
    this.#status = status;
    if (this.#ready) void this.load();
  }

  async load(): Promise<void> {
    this.up({ loading: true, error: null });
    try {
      const items = (await this.api.call("listItems", {
        ...(this.#stage === ALL_STAGES ? {} : { queueName: this.#stage }),
        ...(this.#status === ALL_STATUSES ? {} : { status: this.#status }),
      })) as ItemPreview[];
      this.up({ items, loading: false });
    } catch (error) {
      this.logError(error);
      this.up({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  search(event: ValueEvent): void {
    this.up({ keyword: event.value ?? "" });
  }
}
