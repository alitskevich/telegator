import { WebClientService } from "arrmatura-web";
import { resources } from "tg-rc/web";
import { cellText, changedFields, type Row } from "../grid/view";
import { fill } from "../text/fill";
import type { ApiService } from "./ApiService";
import { exportTable, LIST_ACTION, NEW_ROW, SPECS } from "./GridService";
import type { ItemOwner } from "./ItemService";

/**
 * One table's records on the Dashboard page, chosen by `table`: the Publish
 * node's targets, or the sources of the Scrape node. Added by id, edited and
 * deleted in `RecordModal`, deleted in bulk by selection, all through the records actions; each
 * write reloads `owner` too, so the node's own list follows.
 * Mounted as `<RecordService Ref="targets" table="targets" api="@api" owner="@pipeline" />`.
 */

type RecordTable = "sources" | "targets";

interface ValueEvent {
  readonly value?: string;
}

export class RecordService extends WebClientService {
  declare api: ApiService;
  declare owner: ItemOwner;
  declare table: RecordTable;
  /** What "add" writes besides `NEW_ROW`: the selected node's reader, for a source. */
  declare defaults: Readonly<Record<string, string>> | undefined;

  /** The live records: `null` until read. */
  rows: readonly Row[] | null = null;
  error: string | null = null;
  newId = "";
  /** The record the modal edits: `null` while closed. */
  detail: Row | null = null;
  /** The record as `Forma` last changed it: `null` until an edit. */
  draft: Readonly<Record<string, unknown>> | null = null;
  /** The ids ticked in the table, for a bulk delete. */
  selected: readonly string[] = [];

  /** The writable fields the modal changed, as `upsertRecord` takes them. */
  private get delta(): Record<string, string> {
    const { detail, draft } = this;
    if (detail === null || draft === null) return {};
    const editable = SPECS[this.table].editable;
    return changedFields(
      detail,
      Object.fromEntries(editable.map((field) => [field, cellText(draft[field])])),
    );
  }

  get dirty(): boolean {
    return Object.keys(this.delta).length > 0;
  }

  /** The node's list calls it on mount, so the records are fresh each time the node is selected. */
  async load(): Promise<void> {
    try {
      const rows = (await this.api.call(LIST_ACTION[this.table])) as Row[];
      this.up({ rows, error: null });
    } catch (error) {
      this.logError(error);
      this.up({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  setNewId(event: ValueEvent): void {
    this.up({ newId: event.value ?? "" });
  }

  /** `upsertRecord` creates what it cannot find. */
  async add(): Promise<void> {
    const id = this.newId.trim();
    // An empty id would create a row nothing can address.
    if (id === "") return;

    const delta = { ...NEW_ROW[this.table], ...this.defaults };
    const done = await this.api.run(
      "upsertRecord",
      { table: this.table, id, delta },
      { key: "addRecord", success: () => fill(resources.toasts.added, { id }) },
    );
    if (done === undefined) return;

    this.up({ newId: "" });
    await this.reload();
  }

  /** A row's click; its payload carries the id. */
  open(event: { readonly id?: string }): void {
    const detail = this.rows?.find((row) => row.id === event.id) ?? null;
    this.up({ detail, draft: null });
  }

  close(): void {
    this.up({ detail: null, draft: null });
  }

  setDraft(record: Readonly<Record<string, unknown>>): void {
    this.up({ draft: record });
  }

  async save(): Promise<void> {
    const id = this.detail?.id;
    const delta = this.delta;
    // `upsertRecord` refuses an empty delta.
    if (id === undefined || Object.keys(delta).length === 0) return;

    const done = await this.api.run(
      "upsertRecord",
      { table: this.table, id, delta },
      { key: "saveRecord", success: () => fill(resources.toasts.saved, { id }) },
    );
    if (done === undefined) return;

    this.close();
    await this.reload();
  }

  async remove(): Promise<void> {
    const id = this.detail?.id;
    if (id === undefined) return;
    if (!(await this.delete([id]))) return;

    this.close();
    await this.reload();
  }

  /** `Table`'s selection: the whole set on every tick. */
  select(event: { readonly value?: readonly string[] }): void {
    this.up({ selected: event.value ?? [] });
  }

  async removeSelected(): Promise<void> {
    // A delete of nothing would read as a success.
    if (this.selected.length === 0) return;
    if (!(await this.delete(this.selected))) return;

    this.up({ selected: [] });
    await this.reload();
  }

  exportCsv(): Promise<void> {
    return exportTable(this.api, this.table);
  }

  /** Soft, as on the table pages. */
  private async delete(ids: readonly string[]): Promise<boolean> {
    const noun = resources.tables[this.table].noun;
    const done = await this.api.run(
      "deleteRecords",
      { table: this.table, ids },
      {
        key: "deleteRecord",
        success: () => fill(resources.toasts.deleted, { count: ids.length, noun }),
      },
    );
    return done !== undefined;
  }

  private async reload(): Promise<void> {
    await Promise.all([this.load(), this.owner.load()]);
  }
}
