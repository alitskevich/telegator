# target-table · Task 2: `lib/pipeline/publish/template.ts` — the message template renderer

**Plan:** docs/.spectomat/plans/target-table.md **Spec:** docs/.spectomat/specs/target-table.md — #2.3, #5.2 **Covers:** TT-3, TT-4, TT-5, TT-6 **Depends on:** none

## Goal

A pure module substitutes `{placeholder}` tokens in an operator-authored template, escaping the message fields and leaving the already-rendered HTML alone, and collapses the blank lines an absent value would leave behind.

## Constraints

- `TEMPLATE_PLACEHOLDER` is `/\{([a-zA-Z]+)\}/g` and `MAX_CONSECUTIVE_NEWLINES` is `2`, both owned by this module. `{…}` is the token form (D9): it does not collide with Telegram HTML or with the `[text](#N)` link tokens the summaries carry.
- An unknown placeholder renders as the empty string and leaves no token in the output — a visible `{oops}` in a published post is worse than a gap.
- The template's literal text is trusted HTML and is emitted verbatim (D10): a template exists to add markup, and escaping it would make every `<b>` visible.
- Escaping, exactly: `{header}`, `{body}`, `{hashtags}` are already-rendered HTML and are **not** re-escaped. `{title}`, `{category}`, `{country}`, `{location}` go through `escapeHtml`. `{country}` is uppercased before escaping. `{date}` is not escaped — `DateKeySchema` admits digits and hyphens only.
- The collapse is applied to the **whole** rendered string, not per token, then the result is trimmed — that is what makes `{title}\n{location}` behave the same whichever of the two is empty.
- `renderTemplate` is total: no clock, no network, no map iteration.
- Code cites this spec as `target-table#<section>`, **never** with `§`. Criteria are `TT-n`, never `AC-x.y`. Do not add any new `§x.y Lnnn` citation.
- Relative imports carry no extension. No magic numbers in `lib/` (0 and 1 are allowed). No `any`, no suppression.
- Gates before commit: `npm run gates`, `npm run build`, `npx cdk synth`.

## Files

- Create: `lib/pipeline/publish/template.ts`
- Test: `lib/pipeline/publish/template.test.ts`

## Interfaces

- Consumes: `escapeHtml` from `./escape` (exists today: `export function escapeHtml(text: string): string`); the `Message` type from `../../domain/message`.
- Produces:
  - `export const TEMPLATE_PLACEHOLDER: RegExp`
  - `export const MAX_CONSECUTIVE_NEWLINES = 2`
  - `export type TemplateMessage = Pick<Message, "title" | "category" | "country" | "location" | "date">`
  - `export interface TemplateValues { readonly header: string; readonly body: string; readonly hashtags: string; readonly message: TemplateMessage }`
  - `export function renderTemplate(template: string, values: TemplateValues): string`

## Steps

- [x] **Step 1: Write the failing test** — create `lib/pipeline/publish/template.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  MAX_CONSECUTIVE_NEWLINES,
  renderTemplate,
  TEMPLATE_PLACEHOLDER,
  type TemplateValues,
} from "./template";

const HEADER = "<b>⚡️</b> <i>2026-09-08</i> <b>BY, Minsk, politics</b>";
const BODY = "<b>Story</b>\n@chan_a";
const HASHTAGS = "#politics #minsk";

const values = (over: Partial<TemplateValues> = {}): TemplateValues => ({
  header: HEADER,
  body: BODY,
  hashtags: HASHTAGS,
  message: {
    title: "Explosions & fire",
    category: "politics",
    country: "by",
    location: "Minsk",
    date: "2026-09-08",
  },
  ...over,
});

/**
 * The built-in layout of the pre-template composer, spelled out: the header, a
 * blank line, the member blocks, a blank line, the hashtag line. TT-7 pins that
 * the built-in path itself is unchanged; this pins that a template can
 * reproduce it.
 */
const builtIn = (hashtags: string) =>
  hashtags === "" ? `${HEADER}\n\n${BODY}` : `${HEADER}\n\n${BODY}\n\n${hashtags}`;

describe("renderTemplate — target-table#5.2", () => {
  test("TT-3: {header}/{body}/{hashtags} reproduces the built-in layout", () => {
    expect(renderTemplate("{header}\n\n{body}\n\n{hashtags}", values())).toBe(builtIn(HASHTAGS));
  });

  test("TT-4: an empty value collapses its blank line and leaves no trailing space", () => {
    const out = renderTemplate("{header}\n\n{body}\n\n{hashtags}", values({ hashtags: "" }));

    expect(out).toBe(builtIn(""));
    expect(out).toBe(out.trimEnd());
  });

  test("TT-4: the collapse is over the whole string, so order does not matter", () => {
    const empty = { title: "", category: "", country: "", location: "", date: "2026-09-08" };

    expect(renderTemplate("{title}\n{location}\nx", values({ message: empty }))).toBe("x");
    expect(renderTemplate("{location}\n{title}\nx", values({ message: empty }))).toBe("x");
  });

  test("TT-4: never more than the maximum consecutive newlines", () => {
    const out = renderTemplate("a\n\n\n\n\nb", values());

    expect(out).toBe(`a${"\n".repeat(MAX_CONSECUTIVE_NEWLINES)}b`);
    expect(MAX_CONSECUTIVE_NEWLINES).toBe(2);
  });

  test("TT-5: an unknown placeholder renders empty and leaves no token behind", () => {
    const out = renderTemplate("[{oops}]{body}", values());

    expect(out).toBe(`[]${BODY}`);
    expect(out).not.toContain("{");
  });

  test("TT-6: the message fields are escaped", () => {
    expect(renderTemplate("{title}", values())).toBe("Explosions &amp; fire");
    expect(renderTemplate("{category}", values())).toBe("politics");
    expect(renderTemplate("{location}", values())).toBe("Minsk");
  });

  test("TT-6: {country} is uppercased", () => {
    expect(renderTemplate("{country}", values())).toBe("BY");
  });

  test("TT-6: the rendered HTML is not re-escaped", () => {
    expect(renderTemplate("{header}", values())).toBe(HEADER);
    expect(renderTemplate("{body}", values())).toBe(BODY);
    expect(renderTemplate("{hashtags}", values())).toBe(HASHTAGS);
  });

  test("TT-6: {date} passes through, digits and hyphens only", () => {
    expect(renderTemplate("{date}", values())).toBe("2026-09-08");
  });

  /** D10 — a template exists to add markup, so its own literal text is trusted. */
  test("the template's own markup survives verbatim", () => {
    expect(renderTemplate("<b>Live</b> {category}", values())).toBe("<b>Live</b> politics");
  });

  /** An absent optional field is the empty string, not the word "undefined". */
  test("an absent field renders as nothing", () => {
    const bare = { category: "politics", country: "by", date: "2026-09-08" };

    expect(renderTemplate("[{title}]", values({ message: bare }))).toBe("[]");
  });

  test("the placeholder pattern is letters only (D9)", () => {
    expect("{a}{Ab}{a1}{a-b}{}".match(TEMPLATE_PLACEHOLDER)).toEqual(["{a}", "{Ab}"]);
  });
});
```

- [x] **Step 2: Run it, expect FAIL** — `npx vitest run lib/pipeline/publish/template.test.ts`, fails with `Failed to resolve import "./template"`.
- [x] **Step 3: Minimal implementation** — create `lib/pipeline/publish/template.ts`:

```ts
import type { Message } from "../../domain/message";
import { escapeHtml } from "./escape";

/**
 * target-table#5.2 — a target's own message layout, as a pure substitution
 * (R57).
 *
 * A total function of the template and the values handed to it: no clock, no
 * network, no map iteration. That is what keeps the byte-identical replay and
 * the idempotent edit the publish stage depends on true under a template as
 * well as without one.
 */

/**
 * target-table#2.3 — the token form (D9).
 *
 * `{…}` collides with neither Telegram HTML nor the `[text](#N)` link tokens
 * the stored summaries still carry. Letters only, so a stray brace in prose is
 * left where the operator put it.
 */
export const TEMPLATE_PLACEHOLDER = /\{([a-zA-Z]+)\}/g;

/** target-table#5.2 — the most consecutive newlines a rendered template keeps. */
export const MAX_CONSECUTIVE_NEWLINES = 2;

/** The message fields target-table#5.2's table substitutes. */
export type TemplateMessage = Pick<
  Message,
  "title" | "category" | "country" | "location" | "date"
>;

export interface TemplateValues {
  /** Already-rendered HTML: the header line. */
  readonly header: string;
  /** Already-rendered HTML: the member blocks, newline-joined. */
  readonly body: string;
  /** Already-rendered HTML: the hashtag line, `""` once the ladder drops it. */
  readonly hashtags: string;
  readonly message: TemplateMessage;
}

/**
 * target-table#5.2's table, as a lookup.
 *
 * The split is D10's: the three rendered values are HTML this build produced
 * and must not be escaped again, while the message fields are the untrusted
 * half and are escaped exactly where the built-in layout escapes them. `date`
 * is neither — `DateKeySchema` admits digits and hyphens only.
 */
function valueFor(name: string, values: TemplateValues): string | undefined {
  const { message } = values;

  switch (name) {
    case "header":
      return values.header;
    case "body":
      return values.body;
    case "hashtags":
      return values.hashtags;
    case "title":
      return escapeHtml(message.title ?? "");
    case "category":
      return escapeHtml(message.category ?? "");
    case "country":
      return escapeHtml((message.country ?? "").toUpperCase());
    case "location":
      return escapeHtml(message.location ?? "");
    case "date":
      return message.date;
    default:
      return undefined;
  }
}

/** Built from the constant so the two can never drift apart. */
const EXCESS_NEWLINES = new RegExp(`\\n{${MAX_CONSECUTIVE_NEWLINES + 1},}`, "g");
const COLLAPSED = "\n".repeat(MAX_CONSECUTIVE_NEWLINES);

/**
 * target-table#5.2 — substitute, collapse, trim.
 *
 * The collapse runs over the whole rendered string rather than per token, so
 * `{title}\n{location}` behaves the same whichever of the two is empty; without
 * it every absent value would leave a blank line where it used to be.
 */
export function renderTemplate(template: string, values: TemplateValues): string {
  const substituted = template.replaceAll(
    TEMPLATE_PLACEHOLDER,
    (_match, name: string) => valueFor(name, values) ?? "",
  );

  return substituted.replaceAll(EXCESS_NEWLINES, COLLAPSED).trim();
}
```

- [x] **Step 4: Run it, expect PASS** — same command; then the full gates: `npm run gates && npm run build && npx cdk synth` all exit 0.
- [x] **Step 5: Commit** — message `feat(target-table): message template renderer (TT-3 – TT-6)`; the controller stages this task's Files and commits — an implementer subagent never runs git

## Rulings

- Reviewer Minor parked: `TEMPLATE_PLACEHOLDER` is an exported `/g` regex and so carries a mutable `lastIndex`; both current uses (`String.replaceAll`, `String.match`) reset it, and the spec pins the pattern rather than the instance — cost if wrong: a future consumer calling `.exec()`/`.test()` on the shared instance gets alternating results.
- Reviewer Minor parked: the escaping test proves only `&`, not `<`, `>` or `"`; the test body is the task's verbatim text, so the gap is the brief's, not the implementation's — cost if wrong: an unescaped-tag regression in `{title}` would pass.
- Reviewer Minor parked: a comment in `template.test.ts` cites TT-7, which Task 5 covers; no TT-criteria audit test exists (`test/acceptance.test.ts` audits `AC-x.y` only) — cost if wrong: a false coverage claim if such an audit is ever added.
- Formatting deviation accepted: biome collapsed `TemplateMessage` to one line — behaviour-neutral, and `biome check` is a gate — cost if wrong: none.

## Result

- Commit: `f218972` — `feat(target-table): message template renderer (TT-3 – TT-6)`
- Files: `lib/pipeline/publish/template.ts`, `lib/pipeline/publish/template.test.ts` (both created)
- Review: spec ✅ / quality ✅, 0 Critical, 0 Important, 3 Minor + 1 formatting note (all parked above), 0 fix rounds
- Gates (whole wave, after the fix rounds): `npm run gates` 0 — tsc 0, tests 1686/1686 in 111 files, biome 265 files clean; `npm run build` 0; `npx cdk synth` 0
