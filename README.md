# Telegator

Reads Telegram news channels, classifies and deduplicates the posts with Claude through OpenRouter, and publishes merged stories back to Telegram. An operator console curates sources, reviews messages and replays failures.

It runs on Firebase: Firestore, Cloud Functions, Cloud Tasks and Hosting. **How it works is in [`docs/telegator.md`](docs/telegator.md).**

## Run it locally

```bash
npm install     # also links the private Arrmatura checkouts (~/Projects/arrmatura, arrmatura-web, ultimus)
npm run dev     # emulators + functions watch + console at http://localhost:8080
```

Everything runs in the Firebase emulators, with live reload for both the functions and the console. Sign in with the emulator's dev account. See the doc's §7 for secrets, seeding and how to trigger a scrape.

## Check it

```bash
npx tsc --noEmit
npm test          # vitest inside the Firestore + Auth emulators
npx biome check .
npm run build
```

No check runs the console in a browser: after a template change, look at the page.

## Deploy it

```bash
npm run deploy    # hosting, functions, Firestore rules and indexes → telegator-581db
```

First-time setup (Blaze plan, secrets, Google sign-in, the first admin, turning on the schedule) is §8 of the doc.

## MCP server

`npm run mcp` starts a local stdio MCP server with three tools, `add_source`, `add_target` and `find_messages_by_tags`, over the Firestore collections. It uses the emulator when `FIRESTORE_EMULATOR_HOST` is set, and production otherwise.

## YouTube absorber

The `youtube` function turns the videos saved to one YouTube playlist into transcripts. `npm run youtube:absorb` then merges them into a docs repo with a Claude Code agent. Setup is §10 of the doc.
