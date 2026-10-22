import { WebClientService } from "arrmatura-web";
import type { ItemDetail } from "tg-actions/dashboard/types";
import { resources } from "tg-rc/web";
import { clock } from "../functions";
import { fill } from "../text/fill";
import type { ApiService } from "./ApiService";
import { asRecord } from "./GridService";
import type { ItemFact } from "./types";

/**
 * One `ingest` item: the modal that shows it whole and edits its payload, and
 * running it next. The Pipeline and Audit pages share it; a change reloads the
 * page's own service. Mounted as `<ItemService Ref="item" api="@api" owner="@pipeline" />`.
 */

/** The page service whose lists an item change moves. */
export interface ItemOwner {
  load(): Promise<void>;
}

interface ItemEvent {
  readonly id?: string;
  readonly ref?: string;
}

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

export class ItemService extends WebClientService {
  declare api: ApiService;
  declare owner: ItemOwner;

  /** The item the modal shows, read whole: `null` while closed. */
  detail: ItemDetail | null = null;
  /** The payload as `Forma` last changed it: `null` until an edit. */
  draft: Readonly<Record<string, unknown>> | null = null;

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

  /** Opens the modal; `viewer`. */
  async open(event: ItemEvent): Promise<void> {
    if (event.id === undefined) return;
    const detail = await this.api.run("inspectItem", { id: event.id }, { key: "item" });
    if (detail !== undefined) this.up({ detail: detail as ItemDetail, draft: null });
  }

  close(): void {
    this.up({ detail: null, draft: null });
  }

  setDraft(raw: Readonly<Record<string, unknown>>): void {
    this.up({ draft: raw });
  }

  /** Saves the edited payload, then shows the item as stored. */
  async save(): Promise<void> {
    const id = this.detail?.id;
    if (id === undefined || this.draft === null) return;
    const ref = this.detailTitle;
    const done = await this.api.run(
      "editItem",
      { id, raw: this.draft },
      { success: () => fill(resources.toasts.saved, { id: ref }) },
    );
    if (done === undefined) return;
    await this.open({ id });
    await this.owner.load();
  }

  /** Runs one waiting or failed item next, even on a paused stage. */
  async run(event: ItemEvent): Promise<void> {
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
    if (done !== undefined) await this.owner.load();
  }
}
