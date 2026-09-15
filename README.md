# Telegator

Reads Telegram news channels, deduplicates and categorises the posts with Claude
via OpenRouter, and publishes merged digests back to Telegram. An operator
dashboard curates sources, reviews messages and replays failures.

**Everything is in one document: [`docs/telegator.md`](docs/telegator.md)** — the
normative specification (Part I), a plain-English guide to every AWS service it
uses (Part II), the register of decisions, reconciliations and traps behind both
(Part III), and what the system is built from (Part IV). Start at §1.4 for the
whole pipeline in one picture. This file gets you running and does not summarise
the document.

## Running it

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run lint        # biome check .
npm run synth       # cdk synth — no credentials needed
npm run dev         # the dashboard, at localhost:3000
```

The first four need nothing else: no AWS account, no credentials, no network.

`npm run dev` does. The dashboard reads live DynamoDB, SQS, CloudWatch and
Cognito, so copy `.env.local.example` to `.env.local` and fill it in — every
variable is documented there, and §29 says where each value comes from. Without
it the server starts and answers every route with `missing required environment
variable`; with it but without credentials for that account, the pages render and
the data reads fail with `AccessDeniedException`.

No gate above runs a bundler, so a change can break the dashboard at runtime and
still pass all four (§32.2).

## Deploying

**This repository carries no AWS credentials, and nothing here has been
deployed.** Use `npm run deploy`, never a bare `cdk deploy` (§33). Two gates
precede production:

- §10.3's threshold calibration. Until `calibration/record.json` exists,
  `cdk synth -c env=prod -c scheduleEnabled=true` refuses to synthesise.
- §10.4's latency, throughput and cost targets, which are measured against a
  running system and are unverified here.

Node 22. Secrets live in Secrets Manager; none is in this repository.
