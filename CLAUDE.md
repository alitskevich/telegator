# Working in this repository

`docs/telegator.md` is the project's only document, and it is where the reasoning
lives. This file is the short list of what to do and not do; each rule names the
section that explains it.

**Part I (§1–§11) is the normative spec — do not edit it to match the code.** Code
cites it by section and line (`§3.4 L316`), and `test/specCitations.test.ts` fails
when a citation stops resolving, so editing Part I means re-pointing every
citation into it.

A divergence from Part I is a **reconciliation**: the comment that makes it names
the number and the reason in a sentence or two, and §25 carries the full account.
Add a row there when you issue a new number.

## The four gates

All four pass before any commit. Not three (§32.1).

```bash
npx tsc --noEmit     # never skip: it has caught defects a green suite did not
npx vitest run
npx biome check .
npx cdk synth        # credential-free, and must stay that way
```

Never weaken a gate to pass: no `.skip`, no `any`, no `@ts-expect-error`, no lint
suppression. `tsc` and `vitest` disagree more often than you would expect — run
both.

**What they do not cover is §32.2.** In short: no gate makes a model call, so use
`npm run smoke:openrouter`; and no gate runs a bundler, so run the dev server and
request the routes before believing `app/` works.

## Rules with silent failure modes

Each is enforced by a test, and each was violated at least once (§32.3).

- **Relative imports carry no extension.** `"../lib/clock"`, never
  `"../lib/clock.js"`. Turbopack does not substitute `.js` → `.ts`, so every
  dashboard route 500s while all four gates stay green. No setting restores it.
- **The dashboard must not reach `lib/pipeline/`** (§8.2), checked over the
  *transitive* closure. A constant needed by two layers moves to a module neither
  owns.
- **Every `app/**/page.tsx` calls `requireRole("viewer", …)`.**
- **No CDK context lookup** (`fromLookup`, `valueFromLookup`) — each turns synth
  into an authenticated call and breaks the only infrastructure gate there is.
- **Every AC-x.y in §3.1–3.4 is named by a test**, audited in both directions.
- A source scan that names what it forbids will match itself: exclude the file, or
  scan only shipped source.

## Conventions

§28 has the layout and the full list. The ones worth repeating here: `lib/` holds
every rule and everything else wraps it; Zod schemas are the source of truth;
every boundary is a port with an in-memory fake and **no test touches the
network**; `console` belongs in `scripts/` only; magic numbers are banned in
`lib/`, `handlers/` and `actions/`, and the values live in §31.

`next dev` rewrites `tsconfig.json` and `next-env.d.ts`. That is expected — commit
it with your work.

## Deploying

`npm run deploy`, never a bare `cdk deploy`: §33 says what a bare one omits and
why the stack then creates cleanly and fails on its first message. §10.3's
calibration gate refuses a prod synth until `calibration/record.json` exists.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
