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

The code is npm workspaces under `packages/tg-*` — one concern each, mapped in
§28. `scripts/` holds the operator entry points and `test/` the cross-cutting
invariants.

## Running it

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run lint        # biome check .
npm run synth       # cdk synth — no credentials needed
npm run dev         # the console (packages/tg-web), at localhost:8080
```

The first four need nothing else: no AWS account, no credentials, no network.

`npm install` also links the private Arrmatura framework from sibling checkouts
(`~/Projects/arrmatura`, `arrmatura-web`, `ultimus`); the console cannot build
without them.

`npm run dev` needs the deployed stacks. The console is static: it signs in with
Cognito in the browser and calls the dashboard API (§8, §9.3). It learns where
both are from `packages/tg-web/www/config.json`, which
`npm run deploy:web -- --config-only` writes from the stacks' outputs.

No gate above runs the console in a browser, so a template change can render
nothing and still pass all four (§32.2). Look at the page.

## Deploying

```bash
npm run deploy                    # the stacks — a diff only; add -- --execute
npm run deploy:web -- --execute   # the console, to Firebase Hosting (telegator-581db)
```

## MCP server

`docs/telegator.md`'s companion, `.spectomat/specs/002-mcp-server.md`, specs a
local stdio MCP server exposing three tools — `add_source`, `add_target`,
`find_messages_by_tags` — over this repository's own DynamoDB tables. It
deploys nothing and needs the same AWS credentials `npm run dev` does.

```bash
npm run mcp                 # dev tables
npm run mcp -- --env=prod   # prod tables
```

Configure an MCP client with that command and this repository as its working
directory, for example:

```json
{
  "mcpServers": {
    "telegator": { "command": "npm", "args": ["run", "--silent", "mcp"], "cwd": "<repo>" }
  }
}
```

## Deploying

**This repository carries no AWS credentials, and nothing here has been
deployed.** Use `npm run deploy`, never a bare `cdk deploy` (§33). Two gates
precede production:

- §10.3's threshold calibration. Until `calibration/record.json` exists,
  `cdk synth -c env=prod -c scheduleEnabled=true` refuses to synthesise.
- §10.4's latency, throughput and cost targets, which are measured against a
  running system and are unverified here.

Node 22. Secrets live in Secrets Manager; none is in this repository.
