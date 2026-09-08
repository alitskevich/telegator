# multi-target · Task 1: `lib/domain/target.ts` — the target-list parser

**Plan:** docs/.spectomat/plans/multi-target.md **Spec:** docs/.spectomat/specs/multi-target.md — #2.1, #5.3 **Covers:** MT-1, MT-2 **Depends on:** none

## Goal

A pure module turns a comma-separated target list into canonical ids, and resolves an empty list to the default channel.

## Constraints

- `TARGET_SEPARATOR` is `","`, owned by `lib/domain/target.ts`. `DEFAULT_TG_CHANNEL` (`"telegator_news"`) stays in `lib/domain/message.ts` and is the fallback list when a list resolves to nothing.
- A canonical target id has no leading `@`; exactly one leading `@` is stripped. Ids are trimmed; empty and duplicate ids are dropped; first-seen order is kept.
- Code cites this spec as `multi-target#<section>`, never with `§`. Criteria are `MT-n`, never `AC-x.y`.
- `target.ts` imports from `./message`; `message.ts` must **not** import from `./target` (plan ruling P1 — a cycle throws when `target.ts` is the entry module).
- Relative imports carry no extension. No magic numbers in `lib/` (0 and 1 are allowed). No `any`, no suppression.
- Gates before commit: `npx tsc --noEmit`, `npx vitest run`, `npx biome check .`, `npx cdk synth`.

## Files

- Create: `lib/domain/target.ts`
- Test: `lib/domain/target.test.ts`

## Interfaces

- Consumes: `DEFAULT_TG_CHANNEL` from `lib/domain/message.ts` (exists today, line 15).
- Produces:
  - `export const TARGET_SEPARATOR = ","`
  - `export function parseTargets(value: string | undefined): string[]`
  - `export function resolveTargets(value: string | undefined): string[]` — never empty.

## Steps

- [x] **Step 1: Write the failing test** — create `lib/domain/target.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import { DEFAULT_TG_CHANNEL } from "./message";
import { parseTargets, resolveTargets, TARGET_SEPARATOR } from "./target";

describe("parseTargets — multi-target#5.3", () => {
  test("MT-1: trims, strips one leading @, drops empties and duplicates, keeps order", () => {
    expect(parseTargets("a, @b,,b , @a")).toEqual(["a", "b"]);
  });

  test("undefined is an empty list", () => {
    expect(parseTargets(undefined)).toEqual([]);
  });

  test("a single id needs no separator", () => {
    expect(parseTargets("@only")).toEqual(["only"]);
  });

  test("only one @ is stripped, so a doubled one stays visible", () => {
    expect(parseTargets("@@odd")).toEqual(["@odd"]);
  });

  test("the separator is a comma (multi-target#2.1)", () => {
    expect(TARGET_SEPARATOR).toBe(",");
  });
});

describe("resolveTargets — multi-target#5.3", () => {
  test("MT-2: undefined and a blank list fall back to the default channel", () => {
    expect(resolveTargets(undefined)).toEqual([DEFAULT_TG_CHANNEL]);
    expect(resolveTargets(" , ")).toEqual([DEFAULT_TG_CHANNEL]);
  });

  test("a non-empty list is returned as parsed", () => {
    expect(resolveTargets("a,b")).toEqual(["a", "b"]);
  });

  test("the default channel itself parses to itself", () => {
    expect(resolveTargets(`@${DEFAULT_TG_CHANNEL}`)).toEqual([DEFAULT_TG_CHANNEL]);
  });
});
```

- [x] **Step 2: Run it, expect FAIL** — `npx vitest run lib/domain/target.test.ts`, fails with "Failed to resolve import "./target"".
- [x] **Step 3: Minimal implementation** — create `lib/domain/target.ts`:

```ts
import { DEFAULT_TG_CHANNEL } from "./message";

/**
 * multi-target#2.1 — a target list is target ids joined by this separator.
 *
 * The list is carried as one string from `sources.target` through the item
 * payload into `messages.tgChannel`, and parsed only here (D1). This module
 * imports from `./message` and `./message` never imports from here: a cycle
 * would throw when this file is the entry module (plan ruling P1).
 */
export const TARGET_SEPARATOR = ",";

/** The one prefix a canonical id drops (D7). `@a` and `a` are one channel. */
const AT = "@";

/**
 * multi-target#5.3 — canonical ids in first-seen order: trimmed, one leading
 * `@` removed, empty and duplicate ids dropped. `[]` for nothing.
 */
export function parseTargets(value: string | undefined): string[] {
  if (value === undefined) return [];

  const out: string[] = [];
  for (const part of value.split(TARGET_SEPARATOR)) {
    const trimmed = part.trim();
    const id = trimmed.startsWith(AT) ? trimmed.slice(AT.length) : trimmed;
    if (id === "" || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

/** multi-target#5.3 — a list that resolves to nothing is `[DEFAULT_TG_CHANNEL]`. */
export function resolveTargets(value: string | undefined): string[] {
  const parsed = parseTargets(value);
  return parsed.length === 0 ? [DEFAULT_TG_CHANNEL] : parsed;
}
```

- [x] **Step 4: Run it, expect PASS** — same command; then the full gates: `npx tsc --noEmit && npx vitest run && npx biome check . && npx cdk synth` all exit 0.
- [x] **Step 5: Commit** — message `feat(multi-target): target-list parser (MT-1, MT-2)`; the controller stages this task's Files and commits — an implementer subagent never runs git

## Rulings

- Minor, parked: `parseTargets` dedups with `out.includes(id)`, O(n²) over the list — a target list is a handful of ids; a `Set` buys nothing here — cost if wrong: none at realistic sizes.

## Result

- Commits: 34174ff..f97ee68 (f97ee68)
- Tests: 1583/1583 (106 files); lib/domain/target.test.ts 8/8
- Review: spec ✅ · quality: clean (1 minor parked)
