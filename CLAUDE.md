# Working in this repository

`docs/telegator-design.md` is the authoritative spec. **Do not edit it.** Code
cites it by section and line (`§3.4 L316`), and a divergence from it is recorded
as a reconciliation in the comment that makes it, with the reason.

## The four gates

All four must pass before any commit. Not three.

```bash
npx tsc --noEmit     # never skip: it has caught six defects a green suite did not
npx vitest run
npx biome check .
npx cdk synth        # credential-free, and must stay that way
```

`tsc` and `vitest` disagree more often than you would expect — an unattached L1
CDK property, an untyped `vi.fn()`, a fixture inventing a field. Run both.

Never weaken a gate to pass: no `.skip`, no `any`, no `@ts-expect-error`, no lint
suppression.

## How the code is arranged

- `lib/` holds every rule. `handlers/` and `app/` are thin wrappers over it.
- Every AWS, Telegram and Bedrock boundary is an interface in a `ports.ts` with
  an in-memory fake in `test/fakes/`. **No test touches the network.**
- Zod schemas are the source of truth; types come from `z.infer`.
- `aws-sdk-client-mock` does not typecheck against the installed SDK. Inject a
  structural client port instead — see `lib/metrics/cloudwatch.ts`.

## Boundaries that are easy to violate

Each of these is enforced by a test, and each was violated at least once.

- **The dashboard must not reach `lib/pipeline/`** (§8.2 L734). `app/` and
  `actions/` are checked over the *transitive* closure, along with `aws-cdk-lib`
  — see `test/boundaries.test.ts`. A constant needed by two layers moves to a
  module neither owns; that has happened seven times, most recently `SKIP_REASONS`
  and the log field names.
- **No CDK context lookup** (`fromLookup`, `valueFromLookup`). Each turns synth
  into an authenticated call and breaks the only infrastructure gate there is.
- **Every `app/**/page.tsx` calls `requireRole("viewer", …)`** —
  `test/pageAuth.test.ts`. The dashboard root shipped once without it.
- **Relative imports carry no extension** — `test/importExtensions.test.ts`.
  Write `"../lib/clock"`, never `"../lib/clock.js"`. Turbopack does not perform
  TypeScript's `.js` → `.ts` substitution and reports `Module not found`; every
  dashboard route then 500s. `tsc`, Vite, esbuild and tsx all substitute, so the
  whole repo was written this way and all four gates stayed green against an app
  that could not serve a page. There is no Turbopack setting that restores it.
- **Item ids are `{sourceId}/{telegramMessageId}`, used verbatim** (§2.4).
- **Every AC-x.y in §3.1–3.4 is named by a test** — `test/acceptance.test.ts`
  audits both directions.

## Things that will surprise you

- `next dev` rewrites `tsconfig.json` and `next-env.d.ts`. That is expected;
  biome's formatter is disabled for both, and it appends its own `include`
  entries. `**/*.ts` and `**/*.tsx` must remain among them
  (`test/tsconfig.test.ts`) — a directory-scoped `include` left four categories
  of file unchecked.
- `vitest.config.ts` needs `oxc: { jsx: { runtime: "automatic" } }`. Vitest 4
  uses oxc, not esbuild, and silently ignores `esbuild.jsx`.
- `biome` forbids `console` outside `scripts/**`, and magic numbers in `lib/`,
  `handlers/` and `actions/`.
- A source scan that names what it forbids will match itself. That has happened
  four times; exclude the file, or scan only shipped source.
- **None of the four gates runs a bundler.** `npx next build` is the only thing
  that compiles `app/`, and it needs §9.3's environment set, so it is not one of
  them. A change that breaks the dashboard at runtime — resolution, a client/
  server boundary, an invalid `next.config.ts` option — passes all four. Run the
  dev server and request the routes before believing `app/` works.
- An invalid `experimental` option in `next.config.ts` is warned about and then
  **dropped whole**, so its valid siblings stop applying too. The warning is one
  line at startup, above the ready banner.

## Before production

`cdk synth -c env=prod -c scheduleEnabled=true` refuses until §11.3's
recalibration is recorded in `calibration/record.json`. That is deliberate — the
sweep harness is `lib/calibration/`.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
