# multi-target · Task 4: the `status-index` projection guard

**Plan:** docs/.spectomat/plans/multi-target.md **Spec:** docs/.spectomat/specs/multi-target.md — #2.4, #15.3, D2 **Covers:** MT-16 **Depends on:** none

## Goal

A CDK assertion pins that the synthesised `status-index` (and `date-index`) on `telegator-dev-messages` projects neither `posts` nor `target`, so a later edit cannot add either without a red test.

## Constraints

- `messages.tgChannel` keeps its name (D2). The `status-index` projection in `infra/lib/data-stack.ts` is unchanged: no attribute added or renamed. `posts` is base table only.
- A projection change is accepted silently by `cdk diff` and refused by DynamoDB (base §7.2 L638), which is why this is a test and not a rule (spec #15.3).
- Code cites this spec as `multi-target#<section>`, never with `§`. Criteria are `MT-n`.
- No CDK context lookup. `npx cdk synth` stays credential-free.
- Gates before commit: `npx tsc --noEmit`, `npx vitest run`, `npx biome check .`, `npx cdk synth`.

## Files

- Modify: `infra/lib/data-stack.ts:28-43` (comment only)
- Test: `infra/lib/data-stack.test.ts` (append inside `describe("messages", …)`, after the test at line 130-136)

## Interfaces

- Consumes: the file's existing helpers `templateFor()` and `index(t, name)` (defined at lines 87-92 of the test).
- Produces: nothing.

## Steps

- [x] **Step 1: Write the test** — in `infra/lib/data-stack.test.ts`, inside `describe("messages", …)` directly after the test `"status-index projects what §8.3 L798 and §8.5 L832 render (R27)"`:

```ts
  /**
   * multi-target#2.4, D2 — the post map is base-table only, and the renamed
   * source column never reaches the messages table at all. A projection change
   * is accepted by `cdk diff` and refused by DynamoDB (§7.2 L638), so this is
   * the only place the invariant can fail loudly (multi-target#15.3).
   */
  test("MT-16: neither index projects posts or target", () => {
    const template = templateFor();

    for (const name of ["status-index", "date-index"]) {
      const projected = index(template, name)?.Projection?.NonKeyAttributes ?? [];
      expect(projected).not.toContain("posts");
      expect(projected).not.toContain("target");
    }
  });
```

- [x] **Step 2: Run it, expect PASS — then prove it bites** — `npx vitest run infra/lib/data-stack.test.ts` passes (the template already satisfies the guard). Temporarily add `"posts",` to `MESSAGE_LIST_ATTRIBUTES` in `infra/lib/data-stack.ts`, run again, see `MT-16` fail, and revert that one line. A guard that cannot fail proves nothing.
- [x] **Step 3: Minimal implementation** — the comment on `MESSAGE_LIST_ATTRIBUTES` in `infra/lib/data-stack.ts` (lines 17-27) gains one paragraph, nothing else changes:

```ts
 *
 * `posts` (multi-target#2.4) is deliberately absent, and so is the sources
 * column `target`: nothing on the dashboard reads a post id, and adding either
 * here would be a projection change — two deploys and a dedup blackout (§7.2
 * L638). `data-stack.test.ts` MT-16 pins both.
```

- [x] **Step 4: Run it, expect PASS** — `npx vitest run infra/lib/data-stack.test.ts`; then the full gates: `npx tsc --noEmit && npx vitest run && npx biome check . && npx cdk synth` all exit 0.
- [x] **Step 5: Commit** — message `test(multi-target): status-index projects neither posts nor target (MT-16)`; the controller stages this task's Files and commits — an implementer subagent never runs git

## Rulings

- Minor, parked: the test title carries the `MT-16:` prefix while its siblings do not — the task's Step 1 dictates the string and `test/acceptance.test.ts`-style audits find criteria by id — cost if wrong: none.

## Result

- Commits: 0304416..09e0dad (09e0dad)
- Tests: 1583/1583 (106 files); infra/lib/data-stack.test.ts 20/20
- Review: spec ✅ · quality: clean (1 minor parked)
