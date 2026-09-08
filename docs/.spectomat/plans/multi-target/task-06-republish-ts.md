# multi-target · Task 6: `republishMessage` bumps `ts`

**Plan:** docs/.spectomat/plans/multi-target.md **Spec:** docs/.spectomat/specs/multi-target.md — #3.5, #14 **Covers:** MT-22 **Depends on:** Task 3

## Goal

The dashboard's re-publish sets `status: topublish` **and** `ts: clock.now()`, so every recorded post goes stale at once and the publish stage edits all of them; `TriggerDeps` carries a `clock`, wired to `systemClock` in the server action.

## Constraints

- A post is **current** when `post.tgAt >= message.ts` (D4). Without the `ts` bump every post would be current and a republish would send nothing.
- `republishMessage` order is unchanged: existence check, then the patch, then the enqueue (base §8.4 L815).
- The dashboard must not reach `lib/pipeline/` (transitive closure, `test/boundaries.test.ts`). `lib/clock.ts` is outside it and already imported by `lib/dashboard/`'s tests.
- Code cites this spec as `multi-target#<section>`, never with `§`. Criteria are `MT-n`. Relative imports carry no extension. No magic numbers in `lib/` and `actions/`.
- Gates before commit: `npx tsc --noEmit`, `npx vitest run`, `npx biome check .`, `npx cdk synth`.

## Files

- Modify: `lib/dashboard/triggers.ts:24-37` (`TriggerDeps`), `:85-101` (`republishMessage`)
- Modify: `actions/triggers.ts:19-29` (`deps()`)
- Test: `lib/dashboard/triggers.test.ts` (`deps()` helper at ~line 80-95; new MT-22 test in `describe("republishMessage — §8.4 L815", …)`)

## Interfaces

- Consumes: `Clock`, `systemClock` from `lib/clock.ts`; `manualClock` from `test/fakes/clock.ts`; `Message.posts` (Task 3) only through the fixture.
- Produces: `TriggerDeps.clock: Clock` (required).

## Steps

- [x] **Step 1: Write the failing test** — in `lib/dashboard/triggers.test.ts`, add `clock,` to the object returned by the `deps()` helper (the module-level `const clock = manualClock(NOW)` already exists at line 53), and add inside `describe("republishMessage — §8.4 L815", …)`:

```ts
  /**
   * multi-target#3.5 — every recorded post is current while `post.tgAt >=
   * message.ts` (D4), so without this bump a republish would send nothing.
   */
  test("MT-22: sets topublish and stamps ts with the clock", async () => {
    signedInAs("admin");
    await messages.putNew(message(3, { ts: NOW - 5_000 }));

    await republishMessage({ messageId: "example/3" }, deps());

    const after = await messages.get("example/3");
    expect(after?.status).toBe("topublish");
    expect(after?.ts).toBe(clock.now());
    expect(after?.ts).toBe(NOW);
  });
```

- [x] **Step 2: Run it, expect FAIL** — `npx vitest run lib/dashboard/triggers.test.ts`: `after?.ts` is `NOW - 5000`. (`npx tsc --noEmit` also flags `clock` as an unknown property of `TriggerDeps`.)
- [x] **Step 3: Minimal implementation**

`lib/dashboard/triggers.ts` — add `import type { Clock } from "../clock";`; in `TriggerDeps` add:

```ts
  /** multi-target#3.5 — `republishMessage` stamps `ts` so every post goes stale (D4). */
  readonly clock: Clock;
```

and in `republishMessage` replace `await deps.messages.patch(messageId, { status: "topublish" });` with:

```ts
  // multi-target#3.5 — `ts` too: a recorded post is current while
  // `post.tgAt >= ts` (D4), so the status alone would republish nothing.
  await deps.messages.patch(messageId, { status: "topublish", ts: deps.clock.now() });
```

and extend the function's doc comment with one sentence: `multi-target#3.5 adds the \`ts\` bump.`

`actions/triggers.ts` — add `import { systemClock } from "../lib/clock";` and `clock: systemClock,` to the object `deps()` returns.

- [x] **Step 4: Run it, expect PASS** — `npx vitest run lib/dashboard test/boundaries.test.ts`; then the full gates: `npx tsc --noEmit && npx vitest run && npx biome check . && npx cdk synth` all exit 0.
- [x] **Step 5: Commit** — message `feat(multi-target): republish bumps ts so every post is re-sent (MT-22)`; the controller stages this task's Files and commits — an implementer subagent never runs git

## Rulings

- Reviewer's Minor finding — the MT-22 test asserts both `after?.ts === clock.now()` and `after?.ts === NOW`, which is redundant while the clock is not advanced — parked: the two lines are verbatim from this task file's Step 1, and the pair documents that the value comes from the injected clock rather than a literal — cost if wrong: one redundant assertion.

## Result

(filled by executing-tasks when the task is done)

- Commits: <base7>..<head7>
- Tests: <n>/<n> (<files>)
- Review: spec ✅ · quality: <clean | K parked>
