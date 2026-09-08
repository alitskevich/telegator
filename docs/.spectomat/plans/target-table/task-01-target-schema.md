# target-table · Task 1: the `targets` row schema and `toIsoTimestamp`

**Plan:** docs/.spectomat/plans/target-table.md **Spec:** docs/.spectomat/specs/target-table.md — #2.1, #2.2, #5.3 **Covers:** TT-1, TT-2, TT-15 **Depends on:** none

## Goal

`lib/domain/target.ts` describes a `targets` row — its type enum, its read-side default and its operator-writable allowlist — and `lib/domain/date.ts` formats an epoch instant as the ISO timestamp publish mirrors onto that row.

## Constraints

- `TARGET_TYPES` is `["telegram_channel"] as const` and `DEFAULT_TARGET_TYPE` is `"telegram_channel"`, both owned by `lib/domain/target.ts`. `TargetSchema` defaults `type` to `DEFAULT_TARGET_TYPE`, so a row created by publish's blind `recordLastPost` — which writes neither `type` nor anything else — parses.
- `TargetConfigInput` is the operator-writable allowlist: `type` and `messageTemplate` only, `.partial()` and `.strict()`, plus a refinement rejecting an empty delta (plan ruling P1). A delta naming `lastPostedDate`, `lastPostedMessageId` or `id` is rejected.
- `deleted` is the soft-delete flag, matching the other two tables.
- `toIsoTimestamp(epochMs)` is `new Date(epochMs).toISOString()`, in `lib/domain/date.ts` beside `toDateKey`.
- The domain type is `Target`. `lib/ops/target.ts` exports an unrelated `Target`; neither is renamed and they never meet in one module.
- `lib/domain/target.ts` imports `./message`; `./message` must **not** import `./target` (a cycle throws when `target.ts` is the entry module — its own test file is one).
- Code cites this spec as `target-table#<section>`, **never** with `§`. Criteria are `TT-n`, never `AC-x.y`. Do not add any new `§x.y Lnnn` citation — `test/specCitations.test.ts` resolves those against `docs/telegator.md`.
- Relative imports carry no extension. No magic numbers in `lib/` (0 and 1 are allowed). No `any`, no suppression.
- Gates before commit: `npm run gates`, `npm run build`, `npx cdk synth`.

## Files

- Modify: `lib/domain/target.ts` (append after `resolveTargets`)
- Modify: `lib/domain/target.test.ts` (append two describes)
- Modify: `lib/domain/date.ts` (append after `todayKey`)
- Modify: `lib/domain/date.test.ts` (append one describe)

## Interfaces

- Consumes: nothing new. `zod` is already a dependency; `lib/domain/target.ts` does not import it today and must add `import { z } from "zod";` at the top, before the existing `import { DEFAULT_TG_CHANNEL } from "./message";`.
- Produces:
  - `export const TARGET_TYPES = ["telegram_channel"] as const`
  - `export const DEFAULT_TARGET_TYPE = "telegram_channel"`
  - `export const TargetSchema` — a `z.object`; `TargetSchema.parse({ id: "a" })` yields `{ id: "a", type: "telegram_channel" }`
  - `export type Target = z.infer<typeof TargetSchema>`
  - `export const TargetConfigInput` — `.partial().strict()` over `{ type, messageTemplate }`, refined non-empty
  - `export type TargetConfig = z.infer<typeof TargetConfigInput>`
  - `export function toIsoTimestamp(epochMs: number): string` in `lib/domain/date.ts`

## Steps

- [ ] **Step 1: Write the failing test** — append to `lib/domain/target.test.ts` (and add `TargetConfigInput`, `TargetSchema`, `TARGET_TYPES`, `DEFAULT_TARGET_TYPE` to the existing `./target` import):

```ts
describe("TargetSchema — target-table#2.2", () => {
  test("TT-1: a bare id parses with the default type and no template", () => {
    const row = TargetSchema.parse({ id: "a" });

    expect(row).toEqual({ id: "a", type: DEFAULT_TARGET_TYPE });
    expect(row.messageTemplate).toBeUndefined();
  });

  test("TT-1: an unknown type fails to parse", () => {
    expect(() => TargetSchema.parse({ id: "a", type: "sms" })).toThrow();
  });

  test("the enum has exactly the one member the draft names (D2)", () => {
    expect(TARGET_TYPES).toEqual(["telegram_channel"]);
    expect(TARGET_TYPES).toContain(DEFAULT_TARGET_TYPE);
  });

  test("carries the two mirror fields, the template and the soft-delete flag", () => {
    const row = TargetSchema.parse({
      id: "a",
      type: "telegram_channel",
      lastPostedDate: "2026-09-08T10:00:00.000Z",
      lastPostedMessageId: "chan_a/1",
      messageTemplate: "{header}\n\n{body}",
      deleted: true,
    });

    expect(row.lastPostedDate).toBe("2026-09-08T10:00:00.000Z");
    expect(row.lastPostedMessageId).toBe("chan_a/1");
    expect(row.messageTemplate).toBe("{header}\n\n{body}");
    expect(row.deleted).toBe(true);
  });

  test("an empty id is not a row anything can address", () => {
    expect(() => TargetSchema.parse({ id: "" })).toThrow();
  });
});

describe("TargetConfigInput — target-table#2.2", () => {
  test("TT-2: accepts either operator-writable field, and both", () => {
    expect(TargetConfigInput.parse({ type: "telegram_channel" })).toEqual({
      type: "telegram_channel",
    });
    expect(TargetConfigInput.parse({ messageTemplate: "{body}" })).toEqual({
      messageTemplate: "{body}",
    });
    expect(
      TargetConfigInput.parse({ type: "telegram_channel", messageTemplate: "{body}" }),
    ).toEqual({ type: "telegram_channel", messageTemplate: "{body}" });
  });

  test.each([
    { lastPostedDate: "2026-09-08T10:00:00.000Z" },
    { lastPostedMessageId: "chan_a/1" },
    { id: "b" },
    {},
  ])("TT-2: rejects %o", (delta) => {
    expect(() => TargetConfigInput.parse(delta)).toThrow();
  });

  test("TT-2: rejects a type outside the enum", () => {
    expect(() => TargetConfigInput.parse({ type: "sms" })).toThrow();
  });
});
```

  and append to `lib/domain/date.test.ts` (adding `toIsoTimestamp` to the existing `./date` import):

```ts
describe("toIsoTimestamp — target-table#5.3", () => {
  test("TT-15: the epoch is 1970-01-01T00:00:00.000Z", () => {
    expect(toIsoTimestamp(0)).toBe("1970-01-01T00:00:00.000Z");
  });

  /** D3 — the same shape `sources.lastResult` already carries. */
  test("TT-15: formats in UTC with milliseconds, whatever the host timezone", () => {
    expect(toIsoTimestamp(utc(2026, 9, 8, 10, 30, 15))).toBe("2026-09-08T10:30:15.000Z");
  });

  test("agrees with toDateKey on the day it names", () => {
    const at = utc(2026, 9, 8, 23, 59, 59);

    expect(toIsoTimestamp(at).slice(0, 10)).toBe(toDateKey(at));
  });
});
```

- [ ] **Step 2: Run it, expect FAIL** — `npx vitest run lib/domain/target.test.ts lib/domain/date.test.ts`, fails with `No "TargetSchema" export is defined on the "./target" mock`-style resolution errors (`TargetSchema is not a function` / `toIsoTimestamp is not a function`).
- [ ] **Step 3: Minimal implementation** — append to `lib/domain/target.ts`, and add `import { z } from "zod";` as the first import:

```ts
/**
 * target-table#2.2 — the kinds of destination a row can be (D2, R56).
 *
 * An enum with one member rather than an open string: the draft says
 * "`telegram_channel` only at the moment", which is an enum that will grow, and
 * a second kind can then be added without touching the schema's shape.
 */
export const TARGET_TYPES = ["telegram_channel"] as const;

/**
 * target-table#2.2 — the read-side default.
 *
 * `recordLastPost` (target-table#5.3) creates a row from one `UpdateItem` that
 * sets the two mirror fields and nothing else. Without this default that row
 * would fail `TargetSchema` on the very next read, so the registry would fill
 * itself with rows nothing could load.
 */
export const DEFAULT_TARGET_TYPE = "telegram_channel";

/** Each field's type, declared once — the same shape `lib/domain/source.ts` uses. */
const targetField = {
  /** target-table#2.1 — the canonical target id, and `messages.posts`' map key. */
  id: z.string().min(1),
  type: z.enum(TARGET_TYPES),
  /** Written by publish only (D3): an ISO timestamp, read by human eyes alone. */
  lastPostedDate: z.string().optional(),
  /** Written by publish only (D4): `messages.id`, not Telegram's `message_id`. */
  lastPostedMessageId: z.string().optional(),
  /** target-table#2.3 — absent means the built-in layout, byte for byte (D6). */
  messageTemplate: z.string().optional(),
  deleted: z.boolean().optional(),
} as const;

/** A stored `targets` row, as read back from DynamoDB (target-table#2.2). */
export const TargetSchema = z.object({
  ...targetField,
  type: targetField.type.default(DEFAULT_TARGET_TYPE),
});

export type Target = z.infer<typeof TargetSchema>;

/**
 * The operator-writable fields (target-table#2.2), as a patch.
 *
 * `.strict()` for the reason `SourceConfigInput` is strict: an operator who
 * tries to hand-edit one of publish's mirror fields should get an error, not a
 * silent no-op. Non-empty because a delta that changes nothing still
 * revalidates the page and reads as a successful save.
 */
export const TargetConfigInput = z
  .object({ type: targetField.type, messageTemplate: targetField.messageTemplate })
  .partial()
  .strict()
  .refine((delta) => Object.keys(delta).length > 0, {
    message: "delta must change at least one field",
  });

export type TargetConfig = z.infer<typeof TargetConfigInput>;
```

  and append to `lib/domain/date.ts`:

```ts
/**
 * target-table#5.3 — an epoch-millisecond instant as an ISO timestamp.
 *
 * Beside `toDateKey` because it is the same conversion at a different
 * precision, and UTC for the same reason: one place decides what instant a
 * number names, so two parts of the build cannot disagree.
 */
export function toIsoTimestamp(epochMs: number): string {
  return new Date(epochMs).toISOString();
}
```

- [ ] **Step 4: Run it, expect PASS** — same command; then the full gates: `npm run gates && npm run build && npx cdk synth` all exit 0.
- [ ] **Step 5: Commit** — message `feat(target-table): targets row schema and toIsoTimestamp (TT-1, TT-2, TT-15)`; the controller stages this task's Files and commits — an implementer subagent never runs git

## Rulings

## Result
