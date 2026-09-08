# multi-target · Task 7: seed mapping, `legacyTargetPatch`, `scripts/migrate-targets.ts`

**Plan:** docs/.spectomat/plans/multi-target.md **Spec:** docs/.spectomat/specs/multi-target.md — #3.7, #8.1, #8.2, #12, #13 **Covers:** MT-20, MT-21 **Depends on:** Task 2

## Goal

`toSeedSource` writes `target` (from a legacy export's `tgChannel` when that is all it has); a pure `legacyTargetPatch` decides the one patch a live row needs; `npm run migrate:targets` scans the sources table, prints every patch, and writes only with `--write`.

## Constraints

- `toSeedSource` maps an export row's `tgChannel` to `target`; a row that already has `target` keeps it and ignores `tgChannel`. The seeded record never carries a `tgChannel` key.
- `legacyTargetPatch(raw)`: `{tgChannel}` → `{ target }`; `{tgChannel, target}` → `undefined`; neither → `undefined`. Plan ruling **P5**: an empty-string `target` counts as absent. A non-string `tgChannel` is ignored.
- The script: `--env` parsed by `parseTarget` (`lib/ops/target.ts`), region `REGION`; `--write` is stripped before `parseTarget` sees it, as `scripts/set-cursors-now.ts` does; table name `resourceName(env, "sources")`; scans with the **document client's `ScanCommand`** (not `SourceRepo.listAll`, which parses through `SourceSchema` and would strip the very attribute it is looking for); prints one line per patch; writes only with `--write`, through `SourceRepo.patch`; never removes `tgChannel`; idempotent (a second run patches nothing because every row then has `target`).
- `console` is allowed only in `scripts/`. No magic numbers in `lib/`. Relative imports carry no extension. Code cites this spec as `multi-target#<section>`, never with `§`. Criteria are `MT-n`.
- `package.json` gains `"migrate:targets": "tsx scripts/migrate-targets.ts"`, next to `"cursors:now"`.
- Gates before commit: `npx tsc --noEmit`, `npx vitest run`, `npx biome check .`, `npx cdk synth`. There is no test for the script itself (spec #15.2); its logic lives in `lib/seed/targets.ts`.

## Files

- Modify: `lib/seed/sources.ts:17-25` (`TEXT_FIELDS`), `:75-78` (the field loop)
- Test: `lib/seed/sources.test.ts` (fixture line 9, key list at 43; new MT-20 tests)
- Create: `lib/seed/targets.ts`
- Test: `lib/seed/targets.test.ts`
- Create: `scripts/migrate-targets.ts`
- Modify: `package.json` (`scripts`)

## Interfaces

- Consumes: `Source.target` (Task 2); `parseTarget`, `REGION` (`lib/ops/target.ts`); `resourceName` (`infra/lib/naming.ts`), `Environment` (`infra/lib/config.ts`); `createSourceRepo` (`lib/db/sources.ts`); `ScanCommand`, `DynamoDBDocumentClient` (`@aws-sdk/lib-dynamodb`).
- Produces: `export function legacyTargetPatch(raw: unknown): { readonly target: string } | undefined` in `lib/seed/targets.ts`.

## Steps

- [x] **Step 1: Write the failing tests**

`lib/seed/sources.test.ts` — line 9 `tgChannel: "@target",` → `target: "@target",`; in the key list at lines 31-45 replace `"tgChannel",` with `"target",`; append inside `describe("toSeedSource — §9.4 L965 as a migration", …)`:

```ts
  describe("target — multi-target#3.7 (R54)", () => {
    test("MT-20: a legacy export's tgChannel seeds as target", () => {
      const seeded = toSeedSource(exported({ target: undefined, tgChannel: "x" }));

      expect(seeded.target).toBe("x");
      expect("tgChannel" in seeded).toBe(false);
    });

    test("MT-20: with both present, target wins and tgChannel is ignored", () => {
      const seeded = toSeedSource(exported({ target: "a,b", tgChannel: "x" }));

      expect(seeded.target).toBe("a,b");
      expect("tgChannel" in seeded).toBe(false);
    });

    test("neither present seeds no target", () => {
      expect("target" in toSeedSource(exported({ target: undefined, tgChannel: undefined }))).toBe(
        false,
      );
    });
  });
```

`lib/seed/targets.test.ts` (new):

```ts
import { describe, expect, test } from "vitest";
import { legacyTargetPatch } from "./targets";

describe("legacyTargetPatch — multi-target#3.7, #8.2", () => {
  test("MT-21: a row with tgChannel and no target is patched", () => {
    expect(legacyTargetPatch({ id: "a", tgChannel: "x" })).toEqual({ target: "x" });
  });

  test("MT-21: a row that already has target is left alone", () => {
    expect(legacyTargetPatch({ id: "a", tgChannel: "x", target: "y" })).toBeUndefined();
  });

  test("MT-21: a row with neither is left alone", () => {
    expect(legacyTargetPatch({ id: "a" })).toBeUndefined();
  });

  /** Plan ruling P5 — a cleared target still published from tgChannel under the old code. */
  test("an empty target counts as absent", () => {
    expect(legacyTargetPatch({ id: "a", tgChannel: "x", target: "" })).toEqual({ target: "x" });
  });

  test("a non-string or empty tgChannel is nothing to copy", () => {
    expect(legacyTargetPatch({ id: "a", tgChannel: 7 })).toBeUndefined();
    expect(legacyTargetPatch({ id: "a", tgChannel: "" })).toBeUndefined();
  });

  test("a non-object row is nothing to copy", () => {
    expect(legacyTargetPatch(null)).toBeUndefined();
    expect(legacyTargetPatch("row")).toBeUndefined();
  });
});
```

- [x] **Step 2: Run them, expect FAIL** — `npx vitest run lib/seed`: `targets` cannot be resolved; `seeded.target` is undefined.
- [x] **Step 3: Minimal implementation**

`lib/seed/sources.ts` — remove `"tgChannel",` from `TEXT_FIELDS` (the array becomes `category`, `tags`, `teaser`, `lastItemId`, `lastResult`), and after the `TEXT_FIELDS` loop add:

```ts
  /**
   * multi-target#3.7 (R54) — the export predates the rename, so its `tgChannel`
   * is the target list; a row that already carries `target` keeps it. Written
   * under the new name only: a `tgChannel` attribute on a seeded row would be an
   * orphan `SourceSchema` strips on every read.
   */
  const target = text(source.target) ?? text(source.tgChannel);
  if (target !== undefined) seeded.target = target;
```

`lib/seed/targets.ts` (new):

```ts
/**
 * multi-target#3.7, #8.2 — what the migration writes for one live source row,
 * or nothing.
 *
 * Pure, over the raw row: the script scans with the document client rather
 * than `SourceRepo.listAll`, because `SourceSchema` strips `tgChannel` — the
 * very attribute this is looking for. The patch never removes `tgChannel`
 * (D8): the old code reads it until the new one is deployed.
 */
export function legacyTargetPatch(raw: unknown): { readonly target: string } | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;

  const { tgChannel, target } = raw as { tgChannel?: unknown; target?: unknown };

  // Plan ruling P5 — a cleared `target` still published from `tgChannel` under
  // the old code, so it is copied like an absent one.
  if (typeof target === "string" && target !== "") return undefined;
  if (typeof tgChannel !== "string" || tgChannel === "") return undefined;

  return { target: tgChannel };
}
```

`scripts/migrate-targets.ts` (new):

```ts
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { Environment } from "../infra/lib/config";
import { resourceName } from "../infra/lib/naming";
import { createSourceRepo } from "../lib/db/sources";
import { parseTarget, REGION } from "../lib/ops/target";
import { legacyTargetPatch } from "../lib/seed/targets";

/**
 * multi-target#8.1 step 1 — copy `tgChannel` into `target` on every live source
 * row that has the former and lacks the latter, BEFORE the code that reads
 * `target` is deployed.
 *
 *   npm run migrate:targets                    # dry run against dev
 *   npm run migrate:targets -- --write
 *   npm run migrate:targets -- --env=prod --write
 *
 * Dry run by default, like the other cutover scripts. `tgChannel` is never
 * removed (D8): the old code still reads it until `npm run deploy`, and the new
 * `SourceSchema` strips it on read, so it is an orphan rather than a hazard.
 * Idempotent: a second run finds `target` everywhere and patches nothing.
 *
 * The scan uses the document client directly rather than `SourceRepo.listAll`,
 * which parses every row through `SourceSchema` and would strip the attribute
 * this script exists to find.
 */

/** §7.2 L633's table, environment-prefixed per §9.2 L896. */
const SOURCES_RESOURCE = "sources";

const WRITE = "--write";

interface Patch {
  readonly id: string;
  readonly target: string;
}

async function scanRaw(client: DynamoDBDocumentClient, tableName: string): Promise<unknown[]> {
  const rows: unknown[] = [];
  let cursor: Record<string, unknown> | undefined;

  do {
    const output = await client.send(
      new ScanCommand({
        TableName: tableName,
        ...(cursor === undefined ? {} : { ExclusiveStartKey: cursor }),
      }),
    );
    rows.push(...(output.Items ?? []));
    cursor = output.LastEvaluatedKey;
  } while (cursor !== undefined);

  return rows;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const write = argv.includes(WRITE);
  // `parseTarget` rejects any argument it does not know, on purpose — so
  // `--write` is taken out before it, not added to it.
  const { env } = parseTarget(argv.filter((arg) => arg !== WRITE));

  const tableName = resourceName(env as Environment, SOURCES_RESOURCE);
  console.log(`${tableName} in ${REGION} — ${write ? "WRITE" : "dry run"}`);

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const rows = await scanRaw(client, tableName);

  const patches: Patch[] = [];
  for (const row of rows) {
    const patch = legacyTargetPatch(row);
    const id = (row as { id?: unknown }).id;
    if (patch === undefined || typeof id !== "string") continue;
    patches.push({ id, target: patch.target });
  }

  for (const patch of patches) {
    console.log(`  ${patch.id}: target <- ${JSON.stringify(patch.target)}`);
  }

  if (write) {
    const repo = createSourceRepo({ client, tableName });
    for (const patch of patches) {
      // A patch, not a put: an operator's concurrent edit survives, and
      // `tgChannel` stays where it is (D8).
      await repo.patch(patch.id, { target: patch.target });
    }
  }

  console.log(
    `\n${write ? "patched" : "would patch"} ${patches.length} of ${rows.length} source row(s)`,
  );
  if (!write) console.log(`dry run — pass ${WRITE} to apply`);
}

await main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
```

`package.json` — in `scripts`, after `"cursors:now"`, add `"migrate:targets": "tsx scripts/migrate-targets.ts",`.

- [x] **Step 4: Run it, expect PASS** — `npx vitest run lib/seed`; `npx tsc --noEmit` covers the script (it is inside the project's `include`; if `tsc` reports the script's `output.Items` as possibly untyped, narrow the way `lib/db/sources.ts` `listAll` does: `"Items" in output ? (output.Items ?? []) : []`); then the full gates: `npx tsc --noEmit && npx vitest run && npx biome check . && npx cdk synth` all exit 0.
- [x] **Step 5: Commit** — message `feat(multi-target): seed maps tgChannel to target; migrate-targets script (MT-20, MT-21)`; the controller stages this task's Files and commits — an implementer subagent never runs git

## Rulings

- A stray `"gates": "tsc --noEmit && vitest run && biome check ."` script had entered `package.json` beside `migrate:targets` and was committed in cb793fe; removed in fix round 1 (a9e2a09) — a `gates` script is what the factory's runner uses instead of typecheck/test/lint/build, and this one dropped `next build` and `npx cdk synth`; it belonged to no task's Files, as in wave 1's ruling — cost if wrong: one line to re-add.

## Result

- Commits: dde71c9..a9e2a09 (cb793fe + fix round 1 a9e2a09)
- Tests: 1599/1599 (107 files)
- Review: spec ✅ (round 1 resolved the one Extra) · quality: clean
