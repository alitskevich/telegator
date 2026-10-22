import { WebClientService } from "arrmatura-web";
import type { MemberRow } from "tg-actions/dashboard/types";
import { MAX_PUBLISH_NOW } from "tg-configs/limits";
import { MessageStatusSchema } from "tg-enums/messageStatus";
import { DEFAULT_TARGET_TYPE } from "tg-enums/targetType";
import type { StoredAuditEntry } from "tg-firebase/types";
import {
  MESSAGE_WRITABLE_FIELDS,
  SOURCE_WRITABLE_FIELDS,
  TARGET_WRITABLE_FIELDS,
  type TableName,
} from "tg-rc/columns";
import { resources } from "tg-rc/web";
import { toggleSelectAll } from "tg-utils/ui/selection";
import { cycleSort } from "tg-utils/ui/sort";
import type { SortState } from "tg-utils/ui/types";
import { downloadText, exportFilename } from "../files/download";
import type { GridSpec, GridView } from "../grid/types";
import { changedFields, type Drafts, type Expanded, gridView, type Row } from "../grid/view";
import { fill } from "../text/fill";
import type { ApiService } from "./ApiService";

/**
 * One table page's state: Sources or Messages, chosen by `table`.
 * Mounted as `<GridService Ref="grid" table="sources" api="@api" canEdit="{@api.canEdit}" />`.
 * `src/grid/view.ts` derives the view; this holds the state, calls the API,
 * and reloads after every write so the table shows what was stored.
 */

export const SPECS: Readonly<Record<TableName, GridSpec>> = {
  sources: {
    columns: resources.tables.sources.columns,
    editable: SOURCE_WRITABLE_FIELDS,
    multiline: [],
  },
  targets: {
    columns: resources.tables.targets.columns,
    editable: TARGET_WRITABLE_FIELDS,
    // Templates contain newlines, which a single-line control cannot enter.
    multiline: ["messageTemplate"],
  },
  messages: {
    columns: resources.tables.messages.columns,
    editable: MESSAGE_WRITABLE_FIELDS,
    multiline: [],
  },
};

/** What "add" writes besides the id: `ok` enables polling; a target needs a type. */
export const NEW_ROW: Readonly<Partial<Record<TableName, Record<string, string>>>> = {
  sources: { status: "ok" },
  targets: { type: DEFAULT_TARGET_TYPE },
};

export const LIST_ACTION: Readonly<Record<TableName, string>> = {
  sources: "listSources",
  targets: "listTargets",
  messages: "listMessages",
};

/** The DOM payloads the template's handlers pass: an element's `data-*` set plus `value`. */
interface FieldEvent {
  readonly id?: string;
  readonly column?: string;
  readonly field?: string;
  readonly value?: string;
}

const toRows = (result: unknown): Row[] => (Array.isArray(result) ? (result as Row[]) : []);

export class GridService extends WebClientService {
  declare api: ApiService;
  declare table: TableName;
  declare canEdit: boolean;

  rows: Row[] | null = null;
  loading = false;
  error: string | null = null;
  keyword = "";
  filters: Readonly<Record<string, string>> = {};
  sort: SortState | undefined = undefined;
  selected: readonly string[] = [];
  drafts: Drafts = {};
  expanded: Expanded = {};
  newId = "";
  publishMax = String(MAX_PUBLISH_NOW);

  declare view: GridView;

  #status = "topublish";
  #ready = false;

  constructor() {
    super();
    this.__defineCalculatedProperties({
      "view(rows,keyword,filters,sort,drafts,selected,expanded,canEdit,table)": (
        rows: Row[] | null,
        keyword: string | null,
        filters: Record<string, string> | null,
        sort: SortState | null,
        drafts: Drafts | null,
        selected: string[] | null,
        expanded: Expanded | null,
        canEdit: boolean | null,
        table: TableName | null,
      ) =>
        gridView(
          rows,
          {
            keyword: keyword ?? "",
            filters: filters ?? {},
            sort: sort ?? undefined,
            drafts: drafts ?? {},
            selected: selected ?? [],
            expanded: expanded ?? {},
            canEdit: canEdit === true,
          },
          SPECS[table ?? "sources"],
        ),
    });
  }

  /** The Messages tab is `?status=`, so a reload or a shared link shows the same one. */
  get status(): string {
    return this.#status;
  }

  set status(value: unknown) {
    const parsed = MessageStatusSchema.safeParse(value);
    // A mistyped URL falls back to the backlog rather than to an error page.
    const next = parsed.success ? parsed.data : "topublish";
    if (next === this.#status) return;
    this.#status = next;
    if (this.#ready) void this.load();
  }

  override __init(): void {
    this.#ready = true;
    void this.load();
  }

  async load(): Promise<void> {
    this.up({ loading: true, error: null });
    try {
      const input = this.table === "messages" ? { status: this.#status } : undefined;
      const rows = toRows(await this.api.call(LIST_ACTION[this.table], input));
      this.up({ rows, loading: false, expanded: {} });
    } catch (error) {
      this.logError(error);
      this.up({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  search(event: FieldEvent): void {
    this.up({ keyword: event.value ?? "" });
  }

  filter(event: FieldEvent): void {
    if (event.column === undefined) return;
    this.up({ filters: { ...this.filters, [event.column]: event.value ?? "" } });
  }

  sortBy(event: FieldEvent): void {
    if (event.column === undefined) return;
    this.up({ sort: cycleSort(this.sort, event.column) });
  }

  /** The phone's sort control: a column from a select, ascending until flipped. */
  sortColumn(event: FieldEvent): void {
    const column = event.value ?? "";
    this.up({ sort: column === "" ? undefined : { column, direction: "asc" } });
  }

  flipSort(): void {
    const { sort } = this;
    if (sort === undefined) return;
    this.up({ sort: { ...sort, direction: sort.direction === "asc" ? "desc" : "asc" } });
  }

  toggle(event: FieldEvent): void {
    const { id } = event;
    if (id === undefined) return;
    const selected = this.selected.includes(id)
      ? this.selected.filter((other) => other !== id)
      : [...this.selected, id];
    this.up({ selected });
  }

  /** Over the rows on screen, so a filter narrows what "all" means. */
  toggleAll(): void {
    this.up({ selected: [...toggleSelectAll(this.view.ids, new Set(this.selected))] });
  }

  edit(event: FieldEvent): void {
    const { id, field } = event;
    if (id === undefined || field === undefined) return;
    this.up({
      drafts: { ...this.drafts, [id]: { ...this.drafts[id], [field]: event.value ?? "" } },
    });
  }

  setNewId(event: FieldEvent): void {
    this.up({ newId: event.value ?? "" });
  }

  setPublishMax(event: FieldEvent): void {
    this.up({ publishMax: event.value ?? "" });
  }

  /** `upsertRecord` with only the fields that changed. */
  async save(id: string): Promise<void> {
    const row = this.rows?.find((candidate) => candidate.id === id);
    if (row === undefined) return;
    const delta = changedFields(row, this.drafts[id]);
    if (Object.keys(delta).length === 0) return;

    const done = await this.api.run(
      "upsertRecord",
      { table: this.table, id, delta },
      { key: `save:${id}`, success: () => fill(resources.toasts.saved, { id }) },
    );
    if (done === undefined) return;

    const { [id]: _saved, ...drafts } = this.drafts;
    this.up({ drafts });
    await this.load();
  }

  /** `upsertRecord` creates what it cannot find. */
  async add(): Promise<void> {
    const id = this.newId.trim();
    // An empty id would create a row nothing can address.
    if (id === "" || NEW_ROW[this.table] === undefined) return;

    const done = await this.api.run(
      "upsertRecord",
      { table: this.table, id, delta: NEW_ROW[this.table] },
      { key: "add", success: () => fill(resources.toasts.added, { id }) },
    );
    if (done === undefined) return;

    this.up({ newId: "" });
    await this.load();
  }

  /** Soft, and only the selected rows still on screen. */
  async removeSelected(): Promise<void> {
    const visible = new Set(this.view.ids);
    const ids = this.selected.filter((id) => visible.has(id));
    // A delete of nothing would read as a success.
    if (ids.length === 0) return;

    const noun = resources.tables[this.table].noun;
    const done = await this.api.run(
      "deleteRecords",
      { table: this.table, ids },
      { key: "delete", success: () => fill(resources.toasts.deleted, { count: ids.length, noun }) },
    );
    if (done === undefined) return;

    this.up({ selected: [] });
    await this.load();
  }

  exportCsv(): Promise<void> {
    return exportTable(this.api, this.table);
  }

  /** A story's members and audit are loaded when its panel opens, and only then. */
  async expand(id: string): Promise<void> {
    if (this.expanded[id] !== undefined) {
      const { [id]: _closed, ...rest } = this.expanded;
      this.up({ expanded: rest });
      return;
    }

    this.up({ expanded: { ...this.expanded, [id]: "loading" } });
    try {
      const [members, audit] = await Promise.all([
        this.api.call("loadMembers", { messageId: id }) as Promise<MemberRow[]>,
        this.api.call("loadAudit", { messageId: id }) as Promise<StoredAuditEntry[]>,
      ]);
      this.up({ expanded: { ...this.expanded, [id]: { members, audit } } });
    } catch (error) {
      this.logError(error);
      const { [id]: _failed, ...rest } = this.expanded;
      this.up({ expanded: rest, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Sets `topublish` and enqueues; the queue does the send. */
  async republish(id: string): Promise<void> {
    const done = await this.api.run(
      "republishMessage",
      { messageId: id },
      { key: `republish:${id}`, success: () => fill(resources.toasts.republishMessage, { id }) },
    );
    if (done !== undefined) await this.load();
  }

  /** Runs the publish stage over the `topublish` backlog, capped. */
  async publishNow(): Promise<void> {
    const max = Number(this.publishMax);
    // Bounded here as well as server-side, so an out-of-range value costs no round trip.
    if (!Number.isInteger(max) || max <= 0 || max > MAX_PUBLISH_NOW) return;

    const done = await this.api.run(
      "publishPending",
      { max },
      { success: (result) => fill(resources.toasts.publishPending, asRecord(result)) },
    );
    if (done !== undefined) await this.load();
  }
}

/** The CSV comes back as a download. */
export const exportTable = async (api: ApiService, table: TableName): Promise<void> => {
  const file = exportFilename(table, new Date());
  const csv = await api.run(
    "exportTable",
    { table },
    { key: "export", success: () => fill(resources.toasts.exported, { file }) },
  );
  if (typeof csv === "string") downloadText(file, csv);
};

export const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
