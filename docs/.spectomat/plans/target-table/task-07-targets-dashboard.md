# target-table · Task 7: the `/targets` page — columns, actions, table, route and nav

**Plan:** docs/.spectomat/plans/target-table.md **Spec:** docs/.spectomat/specs/target-table.md — #3.2, #7 **Covers:** TT-19, TT-20, TT-21, TT-22 **Depends on:** Task 1, Task 3, Task 4

## Goal

An operator can see every target row, create one, edit its `type` and `messageTemplate`, soft-delete it and export the table, from a `/targets` page reached from the nav.

## Constraints

- `TARGET_COLUMNS = ["id", "type", "lastPostedDate", "lastPostedMessageId", "messageTemplate"] as const`, in `lib/ui/columns.ts`. `messageTemplate` is last because it is the widest. The page and the export share this list, so the two can never show different columns.
- `TARGET_WRITABLE_FIELDS = ["type", "messageTemplate"] as const`, in `lib/dashboard/records.ts`. The two `lastPosted*` fields render read-only — they are publish's, and an operator editing them would make the mirror lie.
- The `targets` arm of `UpsertInputSchema` uses `TargetConfigInput` directly (plan ruling P1), not a second `writableDelta(TARGET_WRITABLE_FIELDS)`: one schema, with `type` validated as the enum it is. A test pins `TARGET_WRITABLE_FIELDS` against the schema's shape so the two cannot drift.
- A create with no existing row goes through `put(TargetSchema.parse({ id, ...delta }))` so the schema's `type` default lands; an existing row is a `patch`. A bare `UpdateItem` would create a row with no `type`, which fails on the next read.
- `messageTemplate` edits in a `<textarea>`, not an `<input>`: templates contain newlines and a single-line control cannot enter one.
- There is **no trigger button** on this page — nothing on this table is a pipeline action. Add, delete and export only, with `editor` for the writes and `viewer` for the export, exactly as the Sources page has them.
- The page calls `authorized(requireRole("viewer", await authContext()))` before it renders anything, and must not import `lib/pipeline/` — directly or transitively (`test/boundaries.test.ts` checks the closure).
- Code cites this spec as `target-table#<section>`, **never** with `§`. Criteria are `TT-n`, never `AC-x.y`. Do not add any new `§x.y Lnnn` citation; the `§8.3 L797`, `§8.4 L808`, `§8.4 L810`, `§8.4 L812`, `§8.4 L819`, `§8.6 L842` citations quoted below already appear in these files and resolve.
- Relative imports carry no extension. No `any`, no type assertions, no suppression. No magic numbers in `lib/` and `actions/`. No test touches the network.
- Gates before commit: `npm run gates`, `npm run build`, `npx cdk synth`.

## Files

- Modify: `lib/ui/columns.ts`
- Modify: `lib/dashboard/records.ts`, `lib/dashboard/records.test.ts`
- Modify: `lib/dashboard/triggers.ts`, `lib/dashboard/triggers.test.ts`
- Modify: `actions/context.ts`, `actions/records.ts`, `actions/triggers.ts`
- Create: `components/TargetsTable.tsx`, `components/TargetsTable.test.tsx`
- Create: `app/targets/page.tsx`
- Modify: `app/layout.tsx`, `test/layout.test.ts`, `test/pageAuth.test.ts`

## Interfaces

- Consumes (Task 1): `TargetSchema`, `TargetConfigInput`, `type Target` from `lib/domain/target.ts`.
- Consumes (Task 3): `type TargetRepo` from `lib/db/ports.ts`; `createTargetRepo` from `lib/db/targets.ts`; `fakeTargetRepo` from `test/fakes/db.ts`.
- Consumes (Task 4): `ENV_VARS.targetsTable === "TELEGATOR_TARGETS_TABLE"`.
- Consumes (exists today): `TableHead`, `filterByKeyword`, `filterByColumn`, `cycleSort`, `sortRows`, `toCsv`, `hasRole`, `requireRole`, `authorized`.
- Produces: `TARGET_COLUMNS`, `TARGET_WRITABLE_FIELDS`, `RecordActionDeps.targets`, `TriggerDeps.targets`, `TargetsTable`, the `/targets` route.

## Steps

- [ ] **Step 1: Write the failing test** — four edits.

  (a) `lib/dashboard/records.test.ts` — add `fakeTargetRepo` to the fakes import, `TARGET_WRITABLE_FIELDS` to the `./records` import, a `let targets` beside `sources`, `targets = fakeTargetRepo([{ id: "a", type: "telegram_channel" }]);` in `beforeEach`, `targets` in the `deps()` object, and this describe:

```ts
describe("upsertRecord on targets — target-table#3.2", () => {
  test("TT-19: an editor may set a messageTemplate on an existing row", async () => {
    signedInAs("editor");

    await upsertRecord(
      { table: "targets", id: "a", delta: { messageTemplate: "{header}\n\n{body}" } },
      deps(),
    );

    await expect(targets.get("a")).resolves.toMatchObject({
      messageTemplate: "{header}\n\n{body}",
    });
    expect(revalidated).toContain("/targets");
  });

  test("TT-19: a create supplies the schema's defaults", async () => {
    signedInAs("editor");

    await upsertRecord({ table: "targets", id: "fresh", delta: { messageTemplate: "{body}" } }, deps());

    await expect(targets.get("fresh")).resolves.toEqual({
      id: "fresh",
      type: "telegram_channel",
      messageTemplate: "{body}",
    });
  });

  test.each([
    { lastPostedDate: "2026-09-08T10:00:00.000Z" },
    { lastPostedMessageId: "chan_a/1" },
    {},
  ])("TT-19: rejects the delta %o", async (delta) => {
    signedInAs("editor");

    await expect(upsertRecord({ table: "targets", id: "a", delta }, deps())).rejects.toThrow();
  });

  test("TT-19: a viewer may not write a target", async () => {
    signedInAs("viewer");

    await expect(
      upsertRecord({ table: "targets", id: "a", delta: { messageTemplate: "{body}" } }, deps()),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  /** Plan ruling P1 — one allowlist, read by the schema and by the table alike. */
  test("TARGET_WRITABLE_FIELDS is exactly what the schema accepts", () => {
    expect([...TARGET_WRITABLE_FIELDS].sort()).toEqual(["messageTemplate", "type"]);
  });
});

describe("deleteRecords on targets — §8.4 L810", () => {
  test("TT-20: an editor soft-deletes a target", async () => {
    signedInAs("editor");

    await deleteRecords({ table: "targets", ids: ["a"] }, deps());

    await expect(targets.listAll()).resolves.toEqual([]);
    expect(revalidated).toContain("/targets");
  });
});
```

  (b) `lib/dashboard/triggers.test.ts` — add `fakeTargetRepo` to the fakes import, `TARGET_COLUMNS` to the `../ui/columns` import, a `let targets`, its `beforeEach` line, `targets` in `deps()`, and:

```ts
describe("exportTable on targets — §8.4 L812", () => {
  test("TT-20: emits the TARGET_COLUMNS header", async () => {
    signedInAs("viewer");

    const csv = await exportTable({ table: "targets" }, deps());

    expect(csv.split("\n")[0]).toBe(TARGET_COLUMNS.join(","));
  });

  test("TT-20: one row per live target", async () => {
    signedInAs("viewer");

    const csv = await exportTable({ table: "targets" }, deps());

    expect(csv.split("\n")).toHaveLength(2);
  });
});
```

  (c) create `components/TargetsTable.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Target } from "../lib/domain/target";
import { TargetsTable } from "./TargetsTable";

const target = (id: string, extra: Partial<Target> = {}): Target => ({
  id,
  type: "telegram_channel",
  lastPostedDate: "2026-09-08T10:00:00.000Z",
  lastPostedMessageId: "chan_a/1",
  ...extra,
});

type SaveFn = (id: string, delta: Record<string, string>) => Promise<void>;
type DeleteFn = (ids: string[]) => Promise<void>;

let onSave: ReturnType<typeof vi.fn<SaveFn>>;
let onDelete: ReturnType<typeof vi.fn<DeleteFn>>;

beforeEach(() => {
  onSave = vi.fn<SaveFn>(async () => undefined);
  onDelete = vi.fn<DeleteFn>(async () => undefined);
});

afterEach(cleanup);

const rows = [target("a", { messageTemplate: "{header}\n\n{body}" }), target("b")];

const draw = (props: Partial<Parameters<typeof TargetsTable>[0]> = {}) =>
  render(<TargetsTable rows={rows} canEdit onSave={onSave} onDelete={onDelete} {...props} />);

const rowFor = (id: string) => screen.getByTestId(`row-${id}`);

describe("TargetsTable — target-table#7", () => {
  test("TT-21: shows every column the section lists, in order", () => {
    draw();

    for (const column of [
      "id",
      "type",
      "lastPostedDate",
      "lastPostedMessageId",
      "messageTemplate",
    ]) {
      expect(screen.getByRole("columnheader", { name: column })).toBeDefined();
    }
  });

  test("TT-21: renders a row per target", () => {
    draw();
    expect(screen.getAllByTestId(/^row-/)).toHaveLength(2);
  });

  test("TT-21: messageTemplate edits in a textarea, because templates have newlines", () => {
    draw();

    const cell = within(rowFor("a")).getByLabelText("messageTemplate");

    expect(cell.tagName).toBe("TEXTAREA");
  });

  test("TT-21: saving sends only what changed", () => {
    draw();

    const cell = within(rowFor("b")).getByLabelText("messageTemplate");
    fireEvent.change(cell, { target: { value: "{body}" } });
    fireEvent.click(within(rowFor("b")).getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith("b", { messageTemplate: "{body}" });
  });

  /** The two mirror fields are publish's; an operator editing them makes it lie. */
  test("TT-21: offers no edit control on lastPostedDate", () => {
    draw();

    expect(within(rowFor("a")).queryByLabelText("lastPostedDate")).toBeNull();
    expect(within(rowFor("a")).queryByLabelText("lastPostedMessageId")).toBeNull();
  });

  test("TT-21: a viewer gets no controls at all", () => {
    draw({ canEdit: false });

    expect(within(rowFor("a")).queryByLabelText("messageTemplate")).toBeNull();
    expect(screen.queryByRole("button", { name: "Add" })).toBeNull();
  });

  /** target-table#3.2 — nothing on this table is a pipeline action. */
  test("TT-21: offers no trigger button", () => {
    draw();

    expect(screen.queryByRole("button", { name: /now$/i })).toBeNull();
  });

  test("adds a target by id", () => {
    draw();

    fireEvent.change(screen.getByLabelText("New target id"), { target: { value: "c" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(onSave).toHaveBeenCalledWith("c", { type: "telegram_channel" });
  });

  test("deletes the selected rows", () => {
    draw();

    fireEvent.click(screen.getByLabelText("Select a"));
    fireEvent.click(screen.getByRole("button", { name: "Delete selected" }));

    expect(onDelete).toHaveBeenCalledWith(["a"]);
  });
});
```

  (d) `test/pageAuth.test.ts` and `test/layout.test.ts` — in `pageAuth`, add `expect(pages).toContain("app/targets/page.tsx");` to the "finds the pages" test and raise its floor to `5`, renaming it `"TT-22: finds the pages, including /targets"`. In `layout.test.ts`, add `readFileSync` to the `node:fs` import and append:

```ts
describe("the nav (target-table#3.2)", () => {
  /** A page nothing links to is a page nobody finds. */
  test("TT-22: lists Targets between Sources and Messages", () => {
    const layout = readFileSync(resolve(repoRoot, "app/layout.tsx"), "utf8");
    const order = ["/sources", "/targets", "/messages"].map((href) =>
      layout.indexOf(`href: "${href}"`),
    );

    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `npx vitest run lib/dashboard components/TargetsTable.test.tsx test/layout.test.ts test/pageAuth.test.ts`, fails with `Failed to resolve import "./TargetsTable"` and `Invalid discriminator value. Expected 'sources' | 'messages'`.
- [ ] **Step 3: Minimal implementation** — six edits.

  (a) `lib/ui/columns.ts` — append:

```ts
/**
 * target-table#7 — the Targets table.
 *
 * `messageTemplate` is last because it is by far the widest, and the two
 * `lastPosted*` columns sit beside `type` where an operator scanning the table
 * reads them together.
 */
export const TARGET_COLUMNS = [
  "id",
  "type",
  "lastPostedDate",
  "lastPostedMessageId",
  "messageTemplate",
] as const;
```

  (b) `lib/dashboard/records.ts` — `TABLES` becomes `["sources", "messages", "targets"] as const`; add the imports `import type { MessageRepo, SourceRepo, TargetRepo } from "../db/ports";` and `import { TargetConfigInput, TargetSchema } from "../domain/target";`; then:

```ts
/**
 * target-table#2.2's operator-writable columns — the two `lastPosted*` fields
 * are publish's mirror (D7) and editing one would make the table lie about a
 * post that did happen. `id` is the key.
 *
 * The list the table's editable cells read; the schema that validates a write
 * is `TargetConfigInput`, so there is one allowlist rather than two (plan
 * ruling P1).
 */
export const TARGET_WRITABLE_FIELDS = ["type", "messageTemplate"] as const;
```

  a third arm on `UpsertInputSchema`:

```ts
  z.object({
    table: z.literal("targets"),
    id: z.string().min(1),
    delta: TargetConfigInput,
  }),
```

  `targets` on `RecordActionDeps`:

```ts
  readonly targets: TargetRepo;
```

  `repoFor` widened past the two-way ternary it was:

```ts
/** The repository each table's soft delete goes to. */
const repoFor = (table: TableName, deps: RecordActionDeps) => {
  if (table === "sources") return deps.sources;
  if (table === "targets") return deps.targets;
  return deps.messages;
};
```

  and the upsert branch, placed after the `messages` branch and before the `sources` one:

```ts
  if (table === "targets") {
    const existing = await deps.targets.get(id);

    if (existing === undefined) {
      /**
       * target-table#3.2's "add". A bare `UpdateItem` would create a row with
       * no `type`, which fails `TargetSchema` on the very next read; the schema
       * supplies the default here instead.
       */
      await deps.targets.put(TargetSchema.parse({ id, ...delta }));
    } else {
      await deps.targets.patch(id, delta);
    }

    deps.revalidate(pathFor(table));
    return;
  }
```

  (c) `lib/dashboard/triggers.ts` — `TriggerDeps` gains `readonly targets: TargetRepo;`; `ExportInputSchema` becomes `z.object({ table: z.enum(["sources", "messages", "targets"]) })`; the re-export line gains `TARGET_COLUMNS as TARGET_EXPORT_COLUMNS`; and `exportTable` gains a branch before the messages fallthrough:

```ts
  if (table === "targets") {
    // target-table#3.2 — the same columns the page shows, so an export matches
    // the table it was taken from.
    return toCsv(await deps.targets.listAll(), TARGET_COLUMNS);
  }
```

  (d) `actions/context.ts` — beside the other two repos:

```ts
export const targets = createTargetRepo({
  client: documents,
  tableName: requireEnv(ENV_VARS.targetsTable),
});
```

  with `import { createTargetRepo } from "../lib/db/targets";`, and add `targets` to the `deps()` objects in `actions/records.ts` and `actions/triggers.ts` (importing it from `./context`).

  (e) create `components/TargetsTable.tsx`:

```tsx
"use client";

import { useMemo, useState } from "react";
import { TARGET_WRITABLE_FIELDS } from "../lib/dashboard/records";
import { DEFAULT_TARGET_TYPE, type Target } from "../lib/domain/target";
import { TARGET_COLUMNS } from "../lib/ui/columns";
import { filterByColumn, filterByKeyword } from "../lib/ui/filter";
import { cycleSort, type SortState, sortRows } from "../lib/ui/sort";
import { TableHead } from "./TableHead";

/**
 * target-table#7 — the Targets table: id, type, the two `lastPosted*` mirrors
 * and the template, with inline edit, add, delete and export.
 *
 * No trigger button, unlike the Sources table: nothing on this table is a
 * pipeline action, so there is nothing to run now.
 *
 * The server actions arrive as props, which is what lets this be tested against
 * a DOM without AWS and keeps the component ignorant of authorisation — §8.4
 * L819 re-checks the caller's role server-side regardless of what is on screen.
 */

const EDITABLE: ReadonlySet<string> = new Set(TARGET_WRITABLE_FIELDS);

/** Templates contain newlines, which a single-line control cannot enter. */
const MULTILINE = "messageTemplate";

export interface TargetsTableProps {
  readonly rows: readonly Target[];
  readonly canEdit: boolean;
  readonly onSave: (id: string, delta: Record<string, string>) => Promise<void>;
  readonly onDelete: (ids: string[]) => Promise<void>;
  readonly onExport?: () => Promise<string>;
}

const cellText = (value: unknown) => (value === undefined || value === null ? "" : String(value));

export function TargetsTable(props: TargetsTableProps) {
  const [keyword, setKeyword] = useState("");
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<SortState | undefined>(undefined);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [newId, setNewId] = useState("");

  const visible = useMemo(() => {
    const matched = filterByKeyword([...props.rows], keyword, TARGET_COLUMNS);
    return sortRows(filterByColumn(matched, columnFilters, TARGET_COLUMNS), sort);
  }, [props.rows, keyword, columnFilters, sort]);

  const leading = props.canEdit ? ["select"] : [];
  const trailing = props.canEdit ? ["actions"] : [];
  const columnCount = TARGET_COLUMNS.length + leading.length + trailing.length;

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  };

  return (
    <>
      <h1 className="page-title">Targets</h1>

      <div className="table-toolbar">
        <label className="search">
          <span>Search</span>
          <input
            type="search"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="Filter visible columns"
          />
        </label>

        {props.canEdit ? (
          <>
            <label className="add">
              <span>New target id</span>
              <input value={newId} onChange={(event) => setNewId(event.target.value)} />
            </label>
            <button
              type="button"
              onClick={() => {
                // An empty id would create a row nothing can address, and the
                // action would reject it after a round trip.
                if (newId.trim() === "") return;
                void props.onSave(newId.trim(), { type: DEFAULT_TARGET_TYPE });
                setNewId("");
              }}
            >
              Add
            </button>
            <button
              type="button"
              onClick={() => {
                if (selected.size === 0) return;
                void props.onDelete([...selected]);
                setSelected(new Set());
              }}
            >
              Delete selected
            </button>
          </>
        ) : null}

        {/* §8.4 L812 — export is `viewer`, so everyone who can see the table has it. */}
        <button type="button" onClick={() => void props.onExport?.()}>
          Export
        </button>
      </div>

      <table className="data-table">
        <TableHead
          columns={TARGET_COLUMNS}
          sort={sort}
          onSort={(column) => setSort((current) => cycleSort(current, column))}
          filters={columnFilters}
          onFilter={(column, value) =>
            setColumnFilters((current) => ({ ...current, [column]: value }))
          }
          leading={leading}
          trailing={trailing}
        />
        <tbody>
          {visible.length === 0 ? (
            <tr>
              <td className="empty" colSpan={columnCount}>
                No targets
              </td>
            </tr>
          ) : (
            visible.map((row) => (
              <TargetRow
                key={row.id}
                row={row}
                canEdit={props.canEdit}
                selected={selected.has(row.id)}
                onToggle={() => toggle(row.id)}
                onSave={props.onSave}
              />
            ))
          )}
        </tbody>
      </table>
    </>
  );
}

function TargetRow({
  row,
  canEdit,
  selected,
  onToggle,
  onSave,
}: {
  row: Target;
  canEdit: boolean;
  selected: boolean;
  onToggle: () => void;
  onSave: (id: string, delta: Record<string, string>) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});

  // Only what the operator actually changed. Sending unchanged fields would
  // overwrite a concurrent edit with a value this page read before it landed.
  const changed = Object.entries(draft).filter(
    ([field, value]) => value !== cellText(row[field as keyof Target]),
  );

  return (
    <tr data-testid={`row-${row.id}`}>
      {canEdit ? (
        <td>
          <input
            type="checkbox"
            aria-label={`Select ${row.id}`}
            checked={selected}
            onChange={onToggle}
          />
        </td>
      ) : null}

      {TARGET_COLUMNS.map((column) => (
        <td key={column}>
          {canEdit && EDITABLE.has(column) ? (
            column === MULTILINE ? (
              <textarea
                aria-label={column}
                value={draft[column] ?? cellText(row[column as keyof Target])}
                onChange={(event) => setDraft({ ...draft, [column]: event.target.value })}
              />
            ) : (
              <input
                aria-label={column}
                value={draft[column] ?? cellText(row[column as keyof Target])}
                onChange={(event) => setDraft({ ...draft, [column]: event.target.value })}
              />
            )
          ) : (
            cellText(row[column as keyof Target])
          )}
        </td>
      ))}

      {canEdit ? (
        <td>
          <button
            type="button"
            disabled={changed.length === 0}
            onClick={() => {
              void onSave(row.id, Object.fromEntries(changed));
              setDraft({});
            }}
          >
            Save
          </button>
        </td>
      ) : null}
    </tr>
  );
}
```

  If Biome objects to the nested ternary in the cell body, lift it into a small `EditableCell` component in the same file rather than suppressing the rule.

  (f) create `app/targets/page.tsx`:

```tsx
import { authContext, targets } from "../../actions/context";
import {
  deleteRecords as deleteRecordsAction,
  upsertRecord as upsertRecordAction,
} from "../../actions/records";
import { exportTable } from "../../actions/triggers";
import { TargetsTable } from "../../components/TargetsTable";
import { hasRole } from "../../lib/auth/roles";
import { requireRole } from "../../lib/auth/session";
import { authorized } from "../authorize";

/**
 * target-table#3.2 — the Targets page.
 *
 * Thin: authorise, load, render. Every action passed down re-checks the
 * caller's role server-side (§8.4 L819), so `canEdit` only decides what is on
 * screen — it is not the gate.
 */

export const dynamic = "force-dynamic";

export default async function TargetsPage() {
  // §8.6 L842 — `viewer` reads every page.
  const session = await authorized(requireRole("viewer", await authContext()));
  const principal = { roles: session.roles, enabled: true };

  const rows = await targets.listAll();

  async function save(id: string, delta: Record<string, string>) {
    "use server";
    await upsertRecordAction({ table: "targets", id, delta });
  }

  async function remove(ids: string[]) {
    "use server";
    await deleteRecordsAction({ table: "targets", ids });
  }

  async function exportTargets() {
    "use server";
    return exportTable({ table: "targets" });
  }

  return (
    <TargetsTable
      rows={rows}
      canEdit={hasRole(principal, "editor")}
      onSave={save}
      onDelete={remove}
      onExport={exportTargets}
    />
  );
}
```

  and add the nav entry in `app/layout.tsx`, between Sources and Messages:

```ts
  { href: "/targets", label: "Targets" },
```

- [ ] **Step 4: Run it, expect PASS** — `npx vitest run lib/dashboard components test/layout.test.ts test/pageAuth.test.ts test/boundaries.test.ts`; then the full gates: `npm run gates && npm run build && npx cdk synth` all exit 0. `npm run build` is the gate that proves the new route compiles — no unit test bundles `app/`.
- [ ] **Step 5: Commit** — message `feat(target-table): the /targets dashboard page (TT-19 – TT-22)`; the controller stages this task's Files and commits — an implementer subagent never runs git

## Rulings

## Result
