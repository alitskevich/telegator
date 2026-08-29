# Telegator

Reads Telegram news channels, deduplicates and categorises the posts with
Bedrock, and publishes merged digests back to Telegram. An operator dashboard
curates sources, reviews messages and replays failures.

The full design is [`docs/telegator-design.md`](docs/telegator-design.md) — the
authoritative spec. This file points at it and does not summarise it.

## The pipeline

```
EventBridge ──▶ scrape ──▶ analyze queue ──▶ analyze ──▶ aggregate queue
  (30 min)        │                            │              │
                  │ t.me/s/{channel}           │ Claude       ▼
                  ▼                            ▼          aggregate ──▶ publish queue
              sources table              (classify, drop)   (Cohere embed,        │
                                                             dedupe, merge)       ▼
                                                                 │            publish
                                                          messages table ◀────  (Telegram)
```

Each stage is a Lambda behind an SQS queue, and every queue has a dead-letter
queue the dashboard can inspect and replay from.

## Layout

| Path | What lives there |
| --- | --- |
| `lib/` | All the logic: `domain/`, `pipeline/`, `dedup/`, `ai/`, `db/`, `queues/`, `telegram/`, `auth/`, `dashboard/`, `calibration/` |
| `handlers/` | Lambda entry points — thin wrappers over `lib/pipeline/` |
| `infra/` | AWS CDK: five stacks (data, queue, auth, pipeline, app) |
| `app/`, `components/`, `actions/` | The Next.js dashboard and its server actions |
| `scripts/` | One-off cutover tooling (seed, cursor re-seed) |
| `test/` | Fakes, fixtures, end-to-end suites and the meta-tests |

Every AWS and network boundary is an interface with an in-memory fake, so the
tests never touch the network.

## Running it

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run lint        # biome check .
npm run synth       # cdk synth — no credentials needed
npm run dev         # the dashboard, at localhost:3000
```

`cdk synth` is deliberately credential-free — nothing in `infra/` uses a context
lookup — so the templates are built and asserted on without an AWS account.

## Deploying

**This repository carries no AWS credentials, and nothing here has been
deployed.** `cdk deploy` needs an account, a bootstrapped environment and the
context values `infra/lib/config.ts` reads. Two gates precede production:

- §11.3's similarity threshold must be recalibrated against Cohere. Until a
  `calibration/record.json` exists, `cdk synth -c env=prod -c scheduleEnabled=true`
  refuses to synthesise. The sweep harness is `lib/calibration/`.
- §11.4's latency, throughput and cost targets are measured against a running
  system and are unverified here.

Node 24. Secrets live in Secrets Manager; none is in this repository.
