# multi-target · Task 2: `tgChannel` → `target` on the source and the item, end to end

**Plan:** docs/.spectomat/plans/multi-target.md **Spec:** docs/.spectomat/specs/multi-target.md — #2.2, #2.3, #3.1, #3.2, #3.3 (the `item.target` half), #3.6, #7 **Covers:** MT-3, MT-4, MT-5, MT-17, MT-18, MT-19 **Depends on:** none

## Goal

The source column and the item payload field are named `target` everywhere — schemas, the scrape stamp, the analyze pass-through, the aggregate copy into `messages.tgChannel`, the operator allowlist, the Sources table and its export — and a stored `tgChannel` attribute on a source is an orphan the schema strips.

## Constraints

- `messages.tgChannel` keeps its name (D2). Only the **source** column and the **item** field are renamed. Every `tgChannel` on a `Message` / `MessageListItem` — fixture, column, writable field, projection — stays exactly as it is.
- `SourceSchema`, `SourceConfigInput`, `SOURCE_WRITABLE_FIELDS`, `SOURCE_COLUMNS` name `target` and no longer name `tgChannel`. `SourceConfigInput` is strict, so a delta carrying `tgChannel` is rejected. `SourceSchema` strips a stored `tgChannel` (like the orphan `embedding` of base R43).
- Sources page column order is `id, status, target, category, teaser, lastCount, lastResult, zeroYieldRuns` — `target` in `tgChannel`'s old position. The CSV export header follows. `MESSAGE_COLUMNS` and `MESSAGE_WRITABLE_FIELDS` (`title`, `category`, `tgChannel`) are unchanged.
- Aggregate: `tgChannel = item.target ?? DEFAULT_TG_CHANNEL` on both the create and the merge branch (newest item overwrites, base §3.3 L283). The value is carried verbatim — no parsing here (D1).
- Code cites this spec as `multi-target#<section>`, never with `§`. Criteria are `MT-n`, never `AC-x.y`. Existing base-spec citations stay.
- Relative imports carry no extension. No `any`, no suppression, no `.skip`. Fixtures that already parse through a schema keep doing so.
- `lib/seed/sources.ts` and its test are **not** touched here (Task 7 owns the seed mapping). After this task `toSeedSource` still emits a `tgChannel` key; that is expected and green.
- Gates before commit: `npx tsc --noEmit`, `npx vitest run`, `npx biome check .`, `npx cdk synth`.

## Files

Production:

- Modify: `lib/domain/source.ts:39` and `:85`
- Modify: `lib/domain/item.ts:37-38`
- Modify: `lib/pipeline/scrape/transform.ts:12` (comment) and `:109`
- Modify: `lib/pipeline/analyze/route.ts:155` (comment)
- Modify: `lib/dedup/dedupBatch.ts:255` and `:273`
- Modify: `lib/dashboard/records.ts:29`
- Modify: `lib/ui/columns.ts:13`
- Modify: `components/SourcesTable.tsx:12` (comment)

Tests with new criteria:

- Test: `lib/domain/source.test.ts` (fixture line 7; new MT-3 block)
- Test: `lib/pipeline/scrape/transform.test.ts` (fixture line 15; tests at 83-93 → MT-4)
- Test: `lib/pipeline/analyze/route.test.ts:193,198` (→ MT-5)
- Test: `lib/dashboard/records.test.ts` (line 22 fixture; 147 list; 283-288; new MT-18)
- Test: `lib/dashboard/triggers.test.ts` (line 18 fixture; 258 header; new MT-17)
- Test: `components/SourcesTable.test.tsx` (line 10 fixture; 66 column list; new MT-19)

Fixture-only renames (a Source, ScrapedItem or AnalyzedItem literal):

- Modify: `lib/domain/item.test.ts:15,75-77`
- Modify: `lib/dedup/dedupBatch.test.ts:303` (the item override only; line 68 and 306 are the message's `tgChannel` and stay)
- Modify: `lib/pipeline/scrape/index.test.ts:66,401`
- Modify: `lib/queues/ports.test.ts:17`
- Modify: `lib/db/ports.test.ts:7` (line 30 is the message fixture and stays)
- Modify: `lib/db/sources.test.ts:29`
- Modify: `test/e2e/e2e1.test.ts` (the `fakeSourceRepo([...])` literal in `beforeEach`), `test/e2e/e2e2.test.ts:40`, `test/e2e/e2e3.test.ts:39`, `test/e2e/e2e4.test.ts` (the `source()` helper), `test/e2e/e2e5.test.ts:46` (lines 221-225 destructure a `Message` and stay), `test/e2e/e2e6.test.ts:50`, `test/e2e/e2e7.test.ts:38`

**Untouched on purpose** (all `Message`/`MessageListItem` uses): `lib/domain/message.ts`, `lib/domain/message.test.ts`, `lib/dashboard/overview.test.ts`, `lib/dashboard/computations.test.ts`, `components/Dashboard.test.tsx`, `components/MessagesTable.test.tsx`, `components/MessagesTable.tsx`, `lib/db/messages.test.ts`, `lib/pipeline/aggregate/index.test.ts`, `lib/pipeline/publish/*`, `infra/lib/data-stack.*`, `lib/seed/*`.

## Interfaces

- Consumes: nothing from other tasks.
- Produces:
  - `Source.target?: string` (`SourceSchema`, `SourceConfigInput`).
  - `ScrapedItem.target?: string`, and through `.extend()` `AnalyzedItem.target?: string`.
  - `SOURCE_WRITABLE_FIELDS = ["status", "target", "category", "tags", "teaser"] as const`.
  - `SOURCE_COLUMNS = ["id", "status", "target", "category", "teaser", "lastCount", "lastResult", "zeroYieldRuns"] as const`.

## Steps

- [x] **Step 1: Write the failing tests** — six edits, one per criterion:

`lib/domain/source.test.ts` — change line 7 `tgChannel: "telegator_news",` to `target: "telegator_news",` and append at the end of the file:

```ts
describe("target — multi-target#2.2 (R54)", () => {
  test("MT-3: a stored tgChannel is stripped and does not become target", () => {
    const parsed = SourceSchema.parse({ id: "yigal_levin", tgChannel: "x" });

    expect(parsed).not.toHaveProperty("tgChannel");
    expect(parsed.target).toBeUndefined();
  });

  test("MT-3: SourceConfigInput accepts target and rejects tgChannel", () => {
    expect(SourceConfigInput.parse({ target: "a, @b" })).toEqual({ target: "a, @b" });
    expect(SourceConfigInput.safeParse({ tgChannel: "a" }).success).toBe(false);
  });

  test("target is carried verbatim — a list is not parsed here (D1)", () => {
    expect(SourceSchema.parse({ ...seedRecord, target: "a, @b" }).target).toBe("a, @b");
  });
});
```

`lib/pipeline/scrape/transform.test.ts` — line 15 `tgChannel: "telegator_news",` → `target: "telegator_news",`; replace the two tests at lines 83-95 with:

```ts
  test("MT-4: copies target, category and tags from the source", () => {
    const item = transformPost(makePost(), makeSource({ target: "a, @b" }), DATE);
    expect(item.target).toBe("a, @b");
    expect(item.category).toBe("geopolitics");
    expect(item.tags).toBe("war,politics");
  });

  test("MT-4: leaves them absent when the source does not curate them", () => {
    const source = makeSource({ target: undefined, category: undefined, tags: undefined });
    const item = transformPost(makePost(), source, DATE);
    expect(item.target).toBeUndefined();
    expect(item.category).toBeUndefined();
    expect(item.tags).toBeUndefined();
  });
```

`lib/pipeline/analyze/route.test.ts` — line 193 `tgChannel: "news"` → `target: "a,b"`; line 198 `expect(analyzed.tgChannel).toBe("news");` → `expect(analyzed.target).toBe("a,b");`; rename that test's title to `"MT-5: AI fields overwrite the scrape defaults, scrape identity fields (target included) survive"`.

`lib/dashboard/records.test.ts` — line 22 `tgChannel: "@target",` → `target: "@target",` (the `source` helper only; the `message` helper at line 37 keeps `tgChannel`); in the test at line 145-152 replace `"tgChannel",` with `"target",`; lines 283-288 replace both `tgChannel: "@t"` with `target: "@t"`; then add next to `"the source allowlist is §2.1's operator column"`:

```ts
    test("MT-18: a source delta may name target, never tgChannel", async () => {
      signedInAs("editor");

      await upsertRecord({ table: "sources", id: "channel-a", delta: { target: "a, @b" } }, deps());
      expect((await sources.get("channel-a"))?.target).toBe("a, @b");

      await expect(
        upsertRecord({ table: "sources", id: "channel-a", delta: { tgChannel: "x" } }, deps()),
      ).rejects.toThrow(/writable|unrecognized|unknown/i);
    });
```

`lib/dashboard/triggers.test.ts` — line 18 `tgChannel: "@target",` → `target: "@target",` (the `source` helper only; the `message` helper at line 34 keeps `tgChannel`); line 258 becomes:

```ts
    expect(header).toBe("id,status,target,category,teaser,lastCount,lastResult,zeroYieldRuns");
```

and rename that test to `"MT-17: the header row is the sources columns, target in tgChannel's old place"`; add `import { SOURCE_COLUMNS } from "../ui/columns";` and, in the same `describe`:

```ts
  test("MT-17: SOURCE_COLUMNS is the export header", () => {
    expect([...SOURCE_COLUMNS]).toEqual([
      "id",
      "status",
      "target",
      "category",
      "teaser",
      "lastCount",
      "lastResult",
      "zeroYieldRuns",
    ]);
  });
```

`components/SourcesTable.test.tsx` — line 10 `tgChannel: "@target",` → `target: "@target",`; in the column list at lines 62-71 replace `"tgChannel",` with `"target",`; add after the `"renders a row per source"` test:

```tsx
  test("MT-19: the target column is inline-editable and saves { target }", () => {
    draw();
    const row = rowFor("yigal_levin");

    fireEvent.change(within(row).getByLabelText("target"), { target: { value: "a, @b" } });
    fireEvent.click(within(row).getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledWith("yigal_levin", { target: "a, @b" });
  });
```

- [x] **Step 2: Run them, expect FAIL** — `npx tsc --noEmit` reports `target` does not exist on `Source` / `ScrapedItem` (excess-property errors in the fixtures); `npx vitest run lib/domain/source.test.ts lib/pipeline/scrape/transform.test.ts lib/dashboard/records.test.ts lib/dashboard/triggers.test.ts components/SourcesTable.test.tsx` fails MT-3, MT-4, MT-17, MT-18, MT-19.
- [x] **Step 3: Minimal implementation** — the production edits, then the fixture renames:

`lib/domain/source.ts` line 39:

```ts
  /**
   * multi-target#2.2 (R54) — the target list this source publishes to: target
   * ids joined by `TARGET_SEPARATOR`, carried verbatim (D1). Replaces
   * `tgChannel` (§2.1 L111); a stored `tgChannel` is an orphan the strip
   * removes, like the orphan `embedding` of R43.
   */
  target: z.string().optional(),
```

and line 85 `tgChannel: field.tgChannel,` → `target: field.target,`.

`lib/domain/item.ts` lines 37-38:

```ts
  /** The source's `target`, verbatim (multi-target#2.3); §3.3 falls back to `telegator_news` when absent. */
  target: z.string().optional(),
```

`lib/pipeline/scrape/transform.ts` — line 12 comment `stamp \`tgChannel\`` → `stamp \`target\``; line 109 `tgChannel: source.tgChannel,` → `target: source.target,` and the comment above it becomes:

```ts
    // Stamped from the source; §2.2 L138 lets the analyze stage overwrite
    // `category` and merge `tags`. `target` (multi-target#3.1) passes through
    // untouched all the way to publish.
```

`lib/pipeline/analyze/route.ts` line 155 — in the comment list `(\`id\`, \`links\`, \`image\`, \`tgChannel\`, \`date\`, \`kind\`)` replace `tgChannel` with `target` (the code spreads `...scraped`, so nothing else changes — that is MT-5).

`lib/dedup/dedupBatch.ts` — lines 255 and 273 both become:

```ts
            // multi-target#3.3 — the message field keeps its name (D2); its
            // value is the item's target list, verbatim (D1).
            tgChannel: item.target ?? DEFAULT_TG_CHANNEL,
```

`lib/dashboard/records.ts` line 29 `"tgChannel",` → `"target",`; extend the comment above the array with one line: ` * \`target\` replaces \`tgChannel\` (multi-target#2.2, R54).`

`lib/ui/columns.ts` line 13 `"tgChannel",` → `"target",` with the comment on `SOURCE_COLUMNS` becoming `/** §8.3 L797 — the Sources table; \`target\` replaces \`tgChannel\` (multi-target#3.6, R54). */`.

`components/SourcesTable.tsx` line 12 — in the doc comment replace `tgChannel` with `target`.

Fixture renames — in each file listed under *Fixture-only renames* replace `tgChannel:` with `target:` **on the Source / ScrapedItem / AnalyzedItem literal only**: `lib/domain/item.test.ts` (line 15, and lines 75-77 become `const { target: _omitted, ...rest } = scraped;` with the test title `"allows an absent target"` and its comment citing `multi-target#3.3`), `lib/dedup/dedupBatch.test.ts:303` (`{ ...OTHER_EVENT, target: "other_news" }`), `lib/pipeline/scrape/index.test.ts:66` and `:401` (`target: "target"` in both), `lib/queues/ports.test.ts:17`, `lib/db/ports.test.ts:7`, `lib/db/sources.test.ts:29`, and the source literals in `test/e2e/e2e1.test.ts`, `e2e2.test.ts:40`, `e2e3.test.ts:39`, `e2e4.test.ts` (`source()` helper), `e2e5.test.ts:46`; the `ScrapedItem` literals in `e2e6.test.ts:50` and `e2e7.test.ts:38`.

- [x] **Step 4: Run it, expect PASS** — `npx vitest run` green; then this audit must print **only** message-side hits (`lib/domain/message.ts`, `lib/dedup/dedupBatch.ts` message field, `lib/dashboard/records.ts` `MESSAGE_WRITABLE_FIELDS`, `lib/ui/columns.ts` `MESSAGE_COLUMNS`, `components/MessagesTable.tsx`, `lib/pipeline/publish/*`, `infra/lib/data-stack.ts`, `lib/seed/sources.ts`, and message fixtures in tests):

```bash
grep -rn --include='*.ts' --include='*.tsx' "tgChannel" lib/domain/source.ts lib/domain/item.ts lib/pipeline/scrape lib/pipeline/analyze components/SourcesTable.tsx lib/db/sources.ts
```

must print nothing. Then the full gates: `npx tsc --noEmit && npx vitest run && npx biome check . && npx cdk synth` all exit 0.

- [x] **Step 5: Commit** — message `feat(multi-target): rename sources.tgChannel and item.tgChannel to target (MT-3, MT-4, MT-5, MT-17, MT-18, MT-19)`; the controller stages this task's Files and commits — an implementer subagent never runs git

## Rulings

- Step 4's audit grep prints one line, `lib/domain/source.ts:42`, the doc comment Step 3 dictates verbatim ("Replaces `tgChannel` …"); the audit's "must print nothing" is over-strict and the comment stands — a comment naming the old column is the only hit, so the substance (no live `tgChannel` read on the source/item side) holds — cost if wrong: none.
- Minor, parked: the same doc comment names `tgChannel` twice — it is documentation of the rename, which is what a reader grepping for the old name needs — cost if wrong: none.

## Result

- Commits: f97ee68..0304416 (0304416)
- Tests: 1583/1583 (106 files); the six criteria files 163/163
- Review: spec ✅ · quality: clean (1 minor parked)
