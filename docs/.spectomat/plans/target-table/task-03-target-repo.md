# target-table · Task 3: `TargetRepo` — the port, the fake and the DynamoDB adapter

**Plan:** docs/.spectomat/plans/target-table.md **Spec:** docs/.spectomat/specs/target-table.md — #2.2, #5.3, #6, #14 **Covers:** TT-16 **Depends on:** Task 1

## Goal

The `targets` table has a port, an in-memory fake that creates a row on `recordLastPost` the way an `UpdateItem` does, and a DynamoDB adapter that parses every read through `TargetSchema`.

## Constraints

- The table has **no GSI** (D8). Every read is a `GetItem` by id or a `Scan`; the adapter must issue no `Query`.
- `listAll` filters soft-deleted rows at this layer, the way `createSourceRepo.listAll` does, and paginates — a Scan stops at 1 MB like a Query.
- `recordLastPost` is one `UpdateItem` setting exactly `lastPostedDate` and `lastPostedMessageId`, with no condition expression: it creates the row when there is none, which is how the registry fills itself as the pipeline runs (D5).
- `get` returns the stored row **including** `deleted`; filtering a soft-deleted target row is publish's job (target-table#5.3), not the adapter's — publish logs the reason, and a filtered `undefined` would lose which of the three no-template cases happened.
- `patch` reuses `updateAttributes` and `softDelete` reuses `softDeleteCommand`, both from `./patch`; the caller validates the delta.
- The fake takes an options bag `{ failGet?, failRecordLastPost? }` naming the ids whose call throws (plan ruling P4) — Task 6's TT-11 and TT-13 need one target to fail while the rest of the run succeeds.
- `Target` is from `lib/domain/target.ts`. `lib/ops/target.ts` exports an unrelated `Target`; do not import that one.
- Code cites this spec as `target-table#<section>`, **never** with `§`. Criteria are `TT-n`, never `AC-x.y`. Do not add any new `§x.y Lnnn` citation; the `§8.3 L797` / `§8.4 L808` / `§8.4 L810` citations quoted below already appear in `lib/db/ports.ts` and resolve.
- Relative imports carry no extension. No magic numbers in `lib/` (0 and 1 are allowed). No `any`, no suppression. No test touches the network.
- Gates before commit: `npm run gates`, `npm run build`, `npx cdk synth`.

## Files

- Modify: `lib/db/ports.ts` (append `LastPost` and `TargetRepo` after `SourceRepo`; add the `Target` type import)
- Modify: `test/fakes/db.ts` (append `FakeTargetRepo` and `fakeTargetRepo`)
- Create: `lib/db/targets.ts`
- Test: `lib/db/targets.test.ts`

## Interfaces

- Consumes (Task 1): `import { type Target, TargetSchema } from "../domain/target";` — `TargetSchema.parse({ id: "a" })` yields `{ id: "a", type: "telegram_channel" }`.
- Consumes (exists today): `DocumentSender` from `./messages`; `softDeleteCommand` and `updateAttributes` from `./patch`.
- Produces:
  - `export interface LastPost { readonly lastPostedDate: string; readonly lastPostedMessageId: string }` in `lib/db/ports.ts`
  - `export interface TargetRepo` in `lib/db/ports.ts`, with `get`, `listAll`, `put`, `patch`, `recordLastPost`, `softDelete`
  - `export interface TargetRepoOptions { readonly client: DocumentSender; readonly tableName: string }` and `export function createTargetRepo(options: TargetRepoOptions): TargetRepo` in `lib/db/targets.ts`
  - `export interface FakeTargetRepo extends TargetRepo { readonly writeCount: number }`, `export interface FakeTargetRepoOptions`, and `export function fakeTargetRepo(initial?: readonly Target[], options?: FakeTargetRepoOptions): FakeTargetRepo` in `test/fakes/db.ts`

## Steps

- [ ] **Step 1: Write the failing test** — create `lib/db/targets.test.ts`:

```ts
import type {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { describe, expect, test } from "vitest";
import type { DocumentSender } from "./messages";
import { createTargetRepo } from "./targets";

const TABLE = "telegator-dev-targets";

type AnyCommand = GetCommand | PutCommand | QueryCommand | ScanCommand | UpdateCommand;

/**
 * The same recording stub `lib/db/messages.test.ts` uses, copied rather than
 * shared: `sender` is annotated `DocumentSender` so the callback's parameter is
 * contextually typed, which is what makes it assignable under
 * `strictFunctionTypes`.
 */
function stub(replies: Array<Record<string, unknown>> = [{}]) {
  const commands: AnyCommand[] = [];
  let call = 0;

  const sender: DocumentSender = {
    send: async (command) => {
      commands.push(command);
      const reply = replies[Math.min(call, replies.length - 1)] ?? {};
      call++;
      return reply;
    },
  };

  return {
    commands,
    sender,
    input: (index = 0) => commands[index]?.input as Record<string, unknown> | undefined,
  };
}

const repoWith = (s: ReturnType<typeof stub>) =>
  createTargetRepo({ client: s.sender, tableName: TABLE });

describe("createTargetRepo — target-table#6", () => {
  test("TT-16: get parses the item with TargetSchema, defaulting the type", async () => {
    const s = stub([{ Item: { id: "a", messageTemplate: "{body}" } }]);

    await expect(repoWith(s).get("a")).resolves.toEqual({
      id: "a",
      type: "telegram_channel",
      messageTemplate: "{body}",
    });
    expect(s.input()).toMatchObject({ TableName: TABLE, Key: { id: "a" } });
  });

  test("TT-16: get returns undefined for a row that is not there", async () => {
    await expect(repoWith(stub([{}])).get("nope")).resolves.toBeUndefined();
  });

  /**
   * target-table#5.3 — a deleted row reaches publish, which logs why it has no
   * template. Filtering here would collapse three distinct cases into one.
   */
  test("TT-16: get returns a soft-deleted row rather than hiding it", async () => {
    const s = stub([{ Item: { id: "a", deleted: true } }]);

    await expect(repoWith(s).get("a")).resolves.toMatchObject({ id: "a", deleted: true });
  });

  test("TT-16: listAll Scans and filters soft-deleted rows", async () => {
    const s = stub([{ Items: [{ id: "a" }, { id: "b", messageTemplate: "{body}" }] }]);

    const rows = await repoWith(s).listAll();

    expect(rows.map((row) => row.id)).toEqual(["a", "b"]);
    expect(s.input()).toMatchObject({
      TableName: TABLE,
      FilterExpression: "attribute_not_exists(#deleted) OR #deleted = :notDeleted",
      ExpressionAttributeNames: { "#deleted": "deleted" },
      ExpressionAttributeValues: { ":notDeleted": false },
    });
  });

  test("TT-16: listAll follows the Scan's pagination", async () => {
    const s = stub([{ Items: [{ id: "a" }], LastEvaluatedKey: { id: "a" } }, { Items: [{ id: "b" }] }]);

    const rows = await repoWith(s).listAll();

    expect(rows.map((row) => row.id)).toEqual(["a", "b"]);
    expect(s.commands).toHaveLength(2);
  });

  test("TT-16: recordLastPost is one UpdateItem setting exactly the two fields", async () => {
    const s = stub();

    await repoWith(s).recordLastPost("a", {
      lastPostedDate: "2026-09-08T10:00:00.000Z",
      lastPostedMessageId: "chan_a/1",
    });

    expect(s.commands).toHaveLength(1);
    const input = s.input() ?? {};
    expect(input).toMatchObject({ TableName: TABLE, Key: { id: "a" } });
    expect(Object.values(input.ExpressionAttributeNames as Record<string, string>).sort()).toEqual([
      "lastPostedDate",
      "lastPostedMessageId",
    ]);
    expect(Object.values(input.ExpressionAttributeValues as Record<string, string>).sort()).toEqual([
      "2026-09-08T10:00:00.000Z",
      "chan_a/1",
    ]);
  });

  /** D5 — no condition, so the UpdateItem creates the row the registry lacked. */
  test("TT-16: recordLastPost carries no condition expression", async () => {
    const s = stub();

    await repoWith(s).recordLastPost("a", {
      lastPostedDate: "2026-09-08T10:00:00.000Z",
      lastPostedMessageId: "chan_a/1",
    });

    expect(s.input()?.ConditionExpression).toBeUndefined();
  });

  test("put writes the whole row", async () => {
    const s = stub();

    await repoWith(s).put({ id: "a", type: "telegram_channel" });

    expect(s.input()).toMatchObject({ TableName: TABLE, Item: { id: "a" } });
  });

  test("patch sets only the named attributes, and an empty delta writes nothing", async () => {
    const s = stub();
    const repo = repoWith(s);

    await repo.patch("a", { messageTemplate: "{body}" });
    await repo.patch("a", {});

    expect(s.commands).toHaveLength(1);
    expect(s.input()?.UpdateExpression).toBe("SET #p0 = :p0");
  });

  test("softDelete issues one UpdateItem per id", async () => {
    const s = stub();

    await repoWith(s).softDelete(["a", "b"]);

    expect(s.commands).toHaveLength(2);
    expect(s.input()?.UpdateExpression).toBe("SET #deleted = :deleted");
  });

  /** D8 — one access pattern by id and one full listing; a Query would need an index. */
  test("TT-16: issues no Query, because the table has no index", async () => {
    const s = stub([{ Items: [] }]);
    const repo = repoWith(s);

    await repo.get("a");
    await repo.listAll();

    expect(s.commands.map((command) => command.constructor.name)).toEqual([
      "GetCommand",
      "ScanCommand",
    ]);
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `npx vitest run lib/db/targets.test.ts`, fails with `Failed to resolve import "./targets"`.
- [ ] **Step 3: Minimal implementation** — three edits.

  (a) append to `lib/db/ports.ts`, after `SourceRepo`, and add `import type { Target } from "../domain/target";` beside the existing domain type imports:

```ts
/** target-table#5.3 — the two mirror fields publish writes after a send (D3, D4). */
export interface LastPost {
  readonly lastPostedDate: string;
  readonly lastPostedMessageId: string;
}

/**
 * The `targets` registry (target-table#2.2, R56).
 *
 * No `query`: the table carries no index (D8), and offering one would invite a
 * caller to assume an access pattern the table cannot serve.
 */
export interface TargetRepo {
  /** target-table#5.3 — publish's per-target read. Soft-deleted rows come back too. */
  get(id: string): Promise<Target | undefined>;
  /** §8.3 L797's table, as for sources: a Scan, soft-deleted rows filtered. */
  listAll(): Promise<Target[]>;
  /** §8.4 L808 — an operator create. */
  put(target: Target): Promise<void>;
  /** §8.4 L808 — an operator edit, attribute-level. The caller validates the delta. */
  patch(id: string, delta: Readonly<Record<string, unknown>>): Promise<void>;
  /** target-table#5.3 — the two mirror fields, creating the row if absent (D5). */
  recordLastPost(id: string, post: LastPost): Promise<void>;
  /** §8.4 L810 — soft delete. The row survives; `listAll` hides it. */
  softDelete(ids: readonly string[]): Promise<void>;
}
```

  (b) create `lib/db/targets.ts`:

```ts
import { GetCommand, PutCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { type Target, TargetSchema } from "../domain/target";
import type { DocumentSender } from "./messages";
import { softDeleteCommand, updateAttributes } from "./patch";
import type { LastPost, TargetRepo } from "./ports";

/**
 * The DynamoDB adapter for `targets` (target-table#2.2, R56).
 *
 * The `DocumentSender` port is shared with the other two repositories rather
 * than duplicated — all three speak to the same client.
 */

export interface TargetRepoOptions {
  readonly client: DocumentSender;
  readonly tableName: string;
}

/** Soft-deleted rows are filtered here, where every listing caller gets it. */
const NOT_DELETED = "attribute_not_exists(#deleted) OR #deleted = :notDeleted";

/** target-table#5.3 — the two attributes the mirror write sets, and only these. */
const LAST_POSTED_DATE = "#d";
const LAST_POSTED_MESSAGE_ID = "#m";

export function createTargetRepo(options: TargetRepoOptions): TargetRepo {
  const { client, tableName } = options;

  return {
    /**
     * target-table#5.3 — publish's read.
     *
     * A soft-deleted row is returned as it is stored: publish decides what a
     * deleted row means and logs which of the three no-template cases it hit,
     * and a filter here would collapse them into one silent `undefined`.
     */
    get: async (id: string): Promise<Target | undefined> => {
      const output = await client.send(new GetCommand({ TableName: tableName, Key: { id } }));
      const item = "Item" in output ? output.Item : undefined;
      return item === undefined ? undefined : TargetSchema.parse(item);
    },

    /**
     * §8.3 L797 — every target.
     *
     * A Scan, for the reason `sources.listAll` is one: tens of rows, no index
     * to query (D8), and an index existing only to avoid a Scan of that size
     * would cost more than the Scan. Paginated all the same.
     */
    listAll: async (): Promise<Target[]> => {
      const found: Target[] = [];
      let cursor: Record<string, unknown> | undefined;

      do {
        const output = await client.send(
          new ScanCommand({
            TableName: tableName,
            FilterExpression: NOT_DELETED,
            ExpressionAttributeNames: { "#deleted": "deleted" },
            ExpressionAttributeValues: { ":notDeleted": false },
            ...(cursor === undefined ? {} : { ExclusiveStartKey: cursor }),
          }),
        );

        const items = "Items" in output ? (output.Items ?? []) : [];
        for (const item of items) found.push(TargetSchema.parse(item));
        cursor = "LastEvaluatedKey" in output ? output.LastEvaluatedKey : undefined;
      } while (cursor !== undefined);

      return found;
    },

    put: async (target: Target): Promise<void> => {
      await client.send(new PutCommand({ TableName: tableName, Item: target }));
    },

    /** §8.4 L808 — an operator edit. The action validates the delta first. */
    patch: async (id: string, delta: Readonly<Record<string, unknown>>): Promise<void> => {
      const command = updateAttributes(tableName, id, delta);
      if (command === undefined) return;
      await client.send(command);
    },

    /**
     * target-table#5.3 — the mirror write.
     *
     * No condition expression, deliberately: the row is created when there is
     * none, which is how the registry fills itself as the pipeline runs (D5).
     * Exactly two attributes, so an operator's `messageTemplate` and `type`
     * survive a write that knows nothing about them.
     */
    recordLastPost: async (id: string, post: LastPost): Promise<void> => {
      await client.send(
        new UpdateCommand({
          TableName: tableName,
          Key: { id },
          UpdateExpression: `SET ${LAST_POSTED_DATE} = :date, ${LAST_POSTED_MESSAGE_ID} = :messageId`,
          ExpressionAttributeNames: {
            [LAST_POSTED_DATE]: "lastPostedDate",
            [LAST_POSTED_MESSAGE_ID]: "lastPostedMessageId",
          },
          ExpressionAttributeValues: {
            ":date": post.lastPostedDate,
            ":messageId": post.lastPostedMessageId,
          },
        }),
      );
    },

    /** §8.4 L810 — soft delete, one UpdateItem per id. */
    softDelete: async (ids: readonly string[]): Promise<void> => {
      for (const id of ids) {
        await client.send(softDeleteCommand(tableName, id));
      }
    },
  };
}
```

  (c) append to `test/fakes/db.ts`, adding `TargetRepo` and `LastPost` to the existing `../../lib/db/ports` type import and `import { type Target, TargetSchema } from "../../lib/domain/target";`:

```ts
export interface FakeTargetRepo extends TargetRepo {
  readonly writeCount: number;
}

/**
 * The failure injections target-table#5.3's three no-template cases need.
 *
 * A data-only fake cannot express "this one id's read throws while the rest of
 * the run succeeds", which is exactly the case D5 exists to survive.
 */
export interface FakeTargetRepoOptions {
  readonly failGet?: readonly string[];
  readonly failRecordLastPost?: readonly string[];
}

/**
 * An in-memory `targets` table (target-table#2.2).
 *
 * `recordLastPost` creates the row when there is none and parses the result
 * through `TargetSchema`, because that is what the real `UpdateItem` plus the
 * schema's `type` default do together — a fake that stored a typeless row would
 * hide the reason the default exists.
 */
export function fakeTargetRepo(
  initial: readonly Target[] = [],
  options: FakeTargetRepoOptions = {},
): FakeTargetRepo {
  const rows = new Map(initial.map((target) => [target.id, { ...target }]));
  let writeCount = 0;

  return {
    get writeCount() {
      return writeCount;
    },
    get: async (id: string) => {
      if (options.failGet?.includes(id) === true) {
        throw new Error(`targets.get failed for ${id}`);
      }
      const row = rows.get(id);
      return row === undefined ? undefined : { ...row };
    },
    listAll: async () => [...rows.values()].filter((row) => row.deleted !== true),
    put: async (target: Target) => {
      writeCount++;
      rows.set(target.id, { ...target });
    },
    patch: async (id: string, delta: Readonly<Record<string, unknown>>) => {
      const existing = rows.get(id);
      if (existing === undefined) throw new Error(`no such target: ${id}`);
      writeCount++;
      rows.set(id, { ...existing, ...delta } as Target);
    },
    recordLastPost: async (id: string, post: LastPost) => {
      if (options.failRecordLastPost?.includes(id) === true) {
        throw new Error(`targets.recordLastPost failed for ${id}`);
      }
      writeCount++;
      rows.set(id, TargetSchema.parse({ ...(rows.get(id) ?? { id }), ...post }));
    },
    softDelete: async (ids: readonly string[]) => {
      for (const id of ids) {
        const existing = rows.get(id);
        if (existing !== undefined) {
          writeCount++;
          rows.set(id, { ...existing, deleted: true });
        }
      }
    },
  };
}
```

- [ ] **Step 4: Run it, expect PASS** — same command; then the full gates: `npm run gates && npm run build && npx cdk synth` all exit 0.
- [ ] **Step 5: Commit** — message `feat(target-table): TargetRepo port, fake and DynamoDB adapter (TT-16)`; the controller stages this task's Files and commits — an implementer subagent never runs git

## Rulings

## Result
