# target-table · Task 5: `assembleMessage`'s fourth argument and the parameterised overflow ladder

**Plan:** .spectomat/plans/target-table.md **Spec:** .spectomat/specs/target-table.md — #5.1 **Covers:** TT-7, TT-8, TT-9 **Depends on:** Task 2

## Goal

`assembleMessage` composes a target's text through that target's template when it has one, keeps the built-in layout byte for byte when it does not, and drops metadata before content on either path.

## Constraints

- The signature becomes `assembleMessage(message, target, tgId, template?)`. Everything outside the composition step is unchanged: the header, the member rendering, the hashtag line, `chatIdFor(target)`, the `disableWebPagePreview` rule, the edit decision and `PHOTO_SUPPRESSION_LIMIT` all behave exactly as they do today.
- No template, or a template that is empty or whitespace-only, takes the built-in path **byte for byte** (D6). There is no default template string, and no constant holds `{header}\n\n{body}\n\n{hashtags}`.
- `fitToLimit` is today's ladder, parameterised by a `compose` function rather than hard-wired to the built-in one: full, then without the hashtag line, then fewer member blocks down to `MIN_RENDERED_MEMBERS`, never below one. Metadata is dropped before content on both paths — hashtags are reconstructible from the record, a member block is the only surviving rendering of a scraped post.
- A template that names neither `{body}` nor `{hashtags}` cannot be shortened; the ladder then returns the same over-limit string on every rung and the Bot API rejects it. That is the designed outcome — silently truncating an operator's own text is worse than a loud rejection. Do not add a truncation fallback.
- `assembleMessage` stays a total function of the record and the template: no clock, no network.
- Code cites this spec as `target-table#<section>`, **never** with `§`. Criteria are `TT-n`, never `AC-x.y`. Do not add any new `§x.y Lnnn` citation; comments may name **R57**, the reconciliation Task 8 writes into `docs/telegator.md` §25. The existing `§3.4 L…` citations in this file stay exactly as they are.
- Relative imports carry no extension. No magic numbers in `lib/` (0 and 1 are allowed). No `any`, no suppression.
- Gates before commit: `npm run gates`, `npm run build`, `npx cdk synth`.

## Files

- Modify: `lib/pipeline/publish/assemble.ts` (the `compose` / `fitToLimit` pair and `assembleMessage`'s signature)
- Modify: `lib/pipeline/publish/assemble.test.ts` (append one describe)

## Interfaces

- Consumes (Task 2): `import { renderTemplate } from "./template";` — `renderTemplate(template: string, values: { header: string; body: string; hashtags: string; message: TemplateMessage }): string`, where `TemplateMessage` is `Pick<Message, "title" | "category" | "country" | "location" | "date">` and a `Message` satisfies it.
- Consumes (exists today): `TELEGRAM_MESSAGE_LIMIT` and `chatIdFor` from `../../telegram/ports`; `buildHeader`, `buildHashtagLine`, `renderMembers`.
- Produces: `export function assembleMessage(message: Message, target: string, tgId: string | undefined, template?: string): AssembledMessage`. Task 6 calls it with `row?.messageTemplate` as the fourth argument.

## Steps

- [x] **Step 1: Write the failing test** — append to `lib/pipeline/publish/assemble.test.ts`. Reuse whatever message factory the file already defines; the block below assumes a helper `message(over)` returning a parsed `Message` and, where it needs one, builds its own literal.

```ts
describe("assembleMessage with a template — target-table#5.1 (R57)", () => {
  const TEMPLATE = "<b>LIVE</b>\n{header}\n\n{body}\n\n{hashtags}";

  /** Enough tokens that the hashtag line alone overflows a full body. */
  const MANY_TAGS = Array.from({ length: 200 }, (_, i) => `templatetag${i}`).join(",");

  function fullMembers(): Record<string, MemberBlock> {
    const members: Record<string, MemberBlock> = {};
    for (let i = 0; i < MEMBER_RENDER_LIMIT; i += 1) {
      members[`chan/${i + 1}`] = member({ summary: "a".repeat(SUMMARY_MAX_LENGTH), ts: i });
    }
    return members;
  }

  test("TT-7: no template is byte-identical to the pre-template result", () => {
    const stored = message();

    expect(assembleMessage(stored, "b", undefined, undefined).text).toBe(
      assembleMessage(stored, "b", undefined).text,
    );
  });

  /** D6 — an empty or whitespace-only template is no template at all. */
  test.each(["", "   ", "\n"])("TT-7: %o is treated as no template", (template) => {
    const stored = message();

    expect(assembleMessage(stored, "b", undefined, template).text).toBe(
      assembleMessage(stored, "b", undefined).text,
    );
  });

  test("TT-8: a template decides the text and nothing else", () => {
    const stored = message({ image: "https://example.test/p.jpg" });

    const plain = assembleMessage(stored, "b", undefined);
    const templated = assembleMessage(stored, "b", undefined, TEMPLATE);

    expect(templated.text).not.toBe(plain.text);
    expect(templated.text.startsWith("<b>LIVE</b>\n")).toBe(true);
    expect(templated.chatId).toBe(plain.chatId);
    expect(templated.method).toBe(plain.method);
    expect(templated.photo).toBe(plain.photo);
    expect(templated.disableWebPagePreview).toBe(plain.disableWebPagePreview);
  });

  test("TT-8: a tgId still makes it an edit, template or not", () => {
    const templated = assembleMessage(message(), "b", "4711", TEMPLATE);

    expect(templated.method).toBe("editMessageText");
    expect(templated.photo).toBeUndefined();
  });

  test("TT-9: overflow drops {hashtags} first, and every member block survives", () => {
    const stored = message({ tags: MANY_TAGS, members: fullMembers() });
    const template = "{body}\n\n{hashtags}";

    // Precondition: it is the hashtag line that pushes this over the limit.
    expect(assembleMessage(stored, "b", undefined, "{body}").text.length).toBeLessThanOrEqual(
      TELEGRAM_MESSAGE_LIMIT,
    );

    const assembled = assembleMessage(stored, "b", undefined, template);

    expect(assembled.text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    expect(assembled.text).not.toContain("#templatetag0");
    expect(memberBlockCount(assembled.text)).toBe(MEMBER_RENDER_LIMIT);
  });

  test("TT-9: then reduces member blocks, never below one", () => {
    // A long literal in the template inflates the text past what dropping the
    // hashtag line alone could recover, so the ladder reaches its third rung.
    const stored = message({ tags: MANY_TAGS, members: fullMembers() });
    const assembled = assembleMessage(
      stored,
      "b",
      undefined,
      `${"l".repeat(1500)}\n{body}\n\n{hashtags}`,
    );

    expect(assembled.text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    expect(assembled.text).not.toContain("#templatetag0");
    expect(memberBlockCount(assembled.text)).toBeGreaterThan(0);
    expect(memberBlockCount(assembled.text)).toBeLessThan(MEMBER_RENDER_LIMIT);
  });

  /**
   * A template naming neither `{body}` nor `{hashtags}` cannot be shortened.
   * The ladder returns the same over-limit string on every rung and the Bot API
   * rejects it — the designed outcome, not a truncation to hide.
   */
  test("TT-9: an unshortenable template is emitted over the limit rather than cut", () => {
    const literal = "z".repeat(TELEGRAM_MESSAGE_LIMIT + 1);

    expect(assembleMessage(message(), "b", undefined, literal).text).toBe(literal);
  });
});
```

  No new imports are needed: `TELEGRAM_MESSAGE_LIMIT`, `MEMBER_RENDER_LIMIT`, `SUMMARY_MAX_LENGTH`, `assembleMessage`, `message`, `member` and `memberBlockCount` are all already in scope in this file.

- [x] **Step 2: Run it, expect FAIL** — `npx vitest run lib/pipeline/publish/assemble.test.ts`, fails with `Expected 3 arguments, but got 4` at typecheck and with the templated text equalling the plain one at runtime.
- [x] **Step 3: Minimal implementation** — in `lib/pipeline/publish/assemble.ts`, add `import { renderTemplate } from "./template";` and replace the `compose` / `fitToLimit` pair and the body of `assembleMessage`:

```ts
/**
 * How one candidate text is built from the blocks that survived the ladder.
 *
 * A parameter rather than a branch inside `fitToLimit` (R57): the shortening
 * order is a property of the *message*, not of the layout, so both paths get
 * the same ladder and a template cannot quietly acquire a different one.
 */
type Compose = (blocks: readonly string[], hashtagLine: string) => string;

/**
 * §3.4 L327–334's layout, plus R12's hashtag line — after the member blocks,
 * separated by a blank line, because metadata trails content.
 */
function builtInCompose(
  header: string,
  blocks: readonly string[],
  hashtagLine: string,
): string {
  const body = [header, "", ...blocks].join(BLOCK_SEPARATOR);

  return hashtagLine === "" ? body : `${body}${BLANK_LINE}${hashtagLine}`;
}

/**
 * **Recorded decision, not spec text.** §3.4 L340 caps a message at 4096
 * characters and the spec states no truncation rule — because before R12 the
 * cap was unreachable: 12 blocks (L319) of a 220-character summary (§11.2)
 * cannot reach 4096. Appending the hashtag line makes overflow reachable, so the
 * rule has to exist.
 *
 * Order: drop the hashtag line first, then reduce the number of rendered member
 * blocks. Hashtags are derived metadata and are reconstructible from the record;
 * a member block is the only surviving rendering of a scraped post (§1.3 L63).
 * Content outlives metadata.
 *
 * A template that names neither `{body}` nor `{hashtags}` cannot be shortened:
 * every rung returns the same string and the Bot API rejects it (§3.4 L350).
 * That is the designed outcome — silently truncating an operator's own text
 * would be worse than a loud rejection.
 */
function fitToLimit(compose: Compose, blocks: readonly string[], hashtagLine: string): string {
  const withHashtags = compose(blocks, hashtagLine);
  if (withHashtags.length <= TELEGRAM_MESSAGE_LIMIT) return withHashtags;

  const withoutHashtags = compose(blocks, "");
  if (withoutHashtags.length <= TELEGRAM_MESSAGE_LIMIT) return withoutHashtags;

  for (let count = blocks.length - 1; count >= MIN_RENDERED_MEMBERS; count -= 1) {
    const candidate = compose(blocks.slice(0, count), "");
    if (candidate.length <= TELEGRAM_MESSAGE_LIMIT) return candidate;
  }

  // Nothing fits. Emit the floor and let the Bot API reject it (§3.4 L350).
  return compose(blocks.slice(0, MIN_RENDERED_MEMBERS), "");
}
```

  and, inside `assembleMessage`, replace the `const text = fitToLimit(…)` call with:

```ts
  const header = buildHeader(message);
  const hashtagLine = buildHashtagLine({
    category: message.category,
    location: message.location,
    peoples: message.peoples,
    tags: message.tags,
    title: message.title,
    date: message.date,
    ts: message.ts,
  });

  /**
   * target-table#5.1 — the target's own layout, when it has one (D6, R57).
   *
   * An absent, empty or whitespace-only template is no template: the built-in
   * path runs byte for byte, so a target with no row publishes exactly what it
   * published the day before.
   */
  const compose: Compose =
    template === undefined || template.trim() === ""
      ? (blocks_, hashtags) => builtInCompose(header, blocks_, hashtags)
      : (blocks_, hashtags) =>
          renderTemplate(template, {
            header,
            body: blocks_.join(BLOCK_SEPARATOR),
            hashtags,
            message,
          });

  const text = fitToLimit(compose, blocks, hashtagLine);
```

  and widen the signature, extending the existing doc comment with a sentence naming the fourth argument:

```ts
export function assembleMessage(
  message: Message,
  target: string,
  tgId: string | undefined,
  template?: string,
): AssembledMessage {
```

- [x] **Step 4: Run it, expect PASS** — same command, then `npx vitest run lib/pipeline/publish` for the neighbours; then the full gates: `npm run gates && npm run build && npx cdk synth` all exit 0.
- [x] **Step 5: Commit** — message `feat(target-table): assembleMessage composes with a per-target template (TT-7 – TT-9)`; the controller stages this task's Files and commits — an implementer subagent never runs git

## Rulings

- The five Minor review findings are parked, not fixed — the duplicated `fullMembers()` helper, the second `MANY_TAGS` shadowing the first by name, the report's "7 cases" undercount against the diff's 9, `PHOTO_SUPPRESSION_LIMIT` crossing untested on the template path, and a `{hashtags}`-without-`{body}` template degenerating to the unshortenable case — the two test-structure ones reproduce the task's own Step 1 snippet verbatim, the report count is prose not code, and the two untested edges are behaviours the Constraints call correct rather than defects — cost if wrong: two helpers stay duplicated in one file and two edges rest on the ladder's general proof instead of a case each.
- Part of this task's content rode into a concurrent session's tree-wide commit `7addb67 "upui"`, which ran mid-wave and swept the then-uncommitted `lib/pipeline/publish/assemble.test.ts` into itself; the factory's own commit `a7938c8` carries `lib/pipeline/publish/assemble.ts`. History was not rewritten — the same call the multi-target Task 8 ruling made for commit `8526d6a` — so the task's diff spans `de5d99d..HEAD` rather than one commit, and the reviewer was given that range — cost if wrong: `git log` for this task reads across two commits, one of them not the factory's.

## Result

- Commits: `7addb67` (partial, concurrent session's) + `a7938c8` (`feat(target-table): assembleMessage composes with a per-target template (TT-7 – TT-9)`)
- Covers: TT-7, TT-8, TT-9
- Focused tests: `lib/pipeline/publish/assemble.test.ts` 29/29; `lib/pipeline/publish` 137/137
- Review: spec ✅ quality ✅ — 0 Critical, 0 Important, 5 Minor parked as rulings; 0 fix rounds
- Wave gates: tsc 0, tests 1714/1714 (112 files), biome 268 clean, next build 0, cdk synth 0
