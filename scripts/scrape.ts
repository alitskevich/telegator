import { LambdaClient } from "@aws-sdk/client-lambda";
import type { Environment } from "../infra/lib/config";
import { resourceName } from "../infra/lib/naming";
import { lambdaInvoker } from "../lib/aws/lambda";
import { parseTarget, REGION } from "../lib/ops/target";

/**
 * §8.4 L752's "Scrape now", as a command.
 *
 * It **invokes the deployed function**; it does not run `lib/pipeline/scrape/`
 * here. That is §8.2 L734's rule, and the reason it gives applies to a terminal
 * exactly as it does to the dashboard: "manual triggers call
 * `lambda:InvokeFunction` on the deployed function, so 'run this now' executes
 * the exact deployed artefact."
 *
 * Running the stage locally would be easy and would answer a different
 * question. It would use this checkout's code, this machine's credentials and
 * whatever `.env.local` points at — so a green local scrape would say nothing
 * about whether the deployed one works, which is the only thing an operator
 * triggering a scrape by hand actually wants to know.
 *
 *   npm run scrape
 *   npm run scrape -- --env=prod
 *
 * No `--execute` gate, unlike `deploy`. A scrape is what §7.5 L649's schedule
 * does every 30 minutes unattended, and E2E-3 pins that a run with no new
 * upstream content enqueues zero messages and makes zero Telegram calls. It
 * does advance §3.1 L216's cursors, so it is not free — but it is the ordinary
 * operation of the pipeline, not a change to it.
 */

/** §7.5 L649's function, named the way every other resource is (§9.2 L810). */
const SCRAPE_RESOURCE = "scrape";

interface ScrapeSummary {
  readonly processed: number;
  readonly enqueued: number;
}

/**
 * The stage answers `{ processed, enqueued }` (`lib/pipeline/scrape/index.ts`).
 *
 * Checked rather than cast: `lambdaInvoker` returns the parsed payload as
 * `unknown`, and a handler that changed its summary shape would otherwise print
 * `undefined undefined` and look like an empty run — which is exactly what a
 * successful no-op scrape looks like too.
 */
function readSummary(payload: unknown): ScrapeSummary {
  if (typeof payload !== "object" || payload === null) {
    throw new Error(`the scrape function returned no summary: ${JSON.stringify(payload)}`);
  }

  const { processed, enqueued } = payload as Record<string, unknown>;
  if (typeof processed !== "number" || typeof enqueued !== "number") {
    throw new Error(`unexpected scrape summary: ${JSON.stringify(payload)}`);
  }

  return { processed, enqueued };
}

async function main(): Promise<void> {
  const { env } = parseTarget(process.argv.slice(2));
  const functionName = resourceName(env as Environment, SCRAPE_RESOURCE);

  console.log(`invoking ${functionName} in ${REGION}…`);

  const invoker = lambdaInvoker(new LambdaClient({ region: REGION }));
  const summary = readSummary(await invoker.invoke(functionName, {}));

  console.log(`processed ${summary.processed}, enqueued ${summary.enqueued}`);

  // §3.1 L216 advances a cursor per source, so a second run right after a first
  // is expected to be empty. E2E-3 pins exactly that, and an operator who does
  // not know it reads a zero as a failure.
  if (summary.enqueued === 0) {
    console.log("nothing new upstream — a zero here is a healthy re-run, not a failure");
  }
}

await main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
