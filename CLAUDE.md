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

## Before production

`cdk synth -c env=prod -c scheduleEnabled=true` refuses until §11.3's
recalibration is recorded in `calibration/record.json`. That is deliberate — the
sweep harness is `lib/calibration/`.
