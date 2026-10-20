import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { REGION } from "tg-ops/target";
import { parseWebDeployArgs, webConfigFromOutputs } from "tg-ops/web/deploy";

/**
 * §9.3's console deploy, as a command: read the stacks' outputs, write the
 * console's `config.json`, build, and hand `www/` to Firebase Hosting.
 *
 *   npm run deploy:web -- --config-only    # config.json only — for `npm run dev`
 *   npm run deploy:web                     # config + build, then stop
 *   npm run deploy:web -- --execute        # …and deploy to Firebase
 *
 * Opt-in like `npm run deploy`: publishing is the one step that changes what
 * operators see. The Auth and App stacks must be deployed first — their
 * outputs are what this reads, and nothing here is typed by hand. The AWS
 * credentials choose the environment, as they do for `npm run deploy`.
 */

/** The Firebase project and Hosting site the console is served from (`firebase.json`). */
const FIREBASE_PROJECT = "telegator-581db";

const STACKS = ["TelegatorAuthStack", "TelegatorAppStack"];

const WWW = resolve(import.meta.dirname, "../packages/tg-web/www");

async function stackOutputs(): Promise<Record<string, string | undefined>> {
  const client = new CloudFormationClient({ region: REGION });
  const entries = await Promise.all(
    STACKS.map(async (StackName) => {
      const { Stacks } = await client.send(new DescribeStacksCommand({ StackName }));
      return (Stacks?.[0]?.Outputs ?? []).map(({ OutputKey, OutputValue }) => [
        OutputKey ?? "",
        OutputValue,
      ]);
    }),
  );
  return Object.fromEntries(entries.flat());
}

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function main(): Promise<void> {
  const args = parseWebDeployArgs(process.argv.slice(2));

  const config = webConfigFromOutputs(await stackOutputs());
  writeFileSync(join(WWW, "config.json"), `${JSON.stringify(config, null, 2)}\n`);

  console.log(`api      ${config.apiUrl}`);
  console.log(`sign-in  ${config.hostedUiDomain}`);
  console.log(`wrote    ${join(WWW, "config.json")}`);
  if (args.configOnly) return;

  run("npm", ["run", "build"]);

  if (!args.execute) {
    console.log("\nBuilt — nothing deployed. Add --execute to publish to Firebase Hosting.\n");
    return;
  }

  run("npx", [
    "--yes",
    "firebase-tools",
    "deploy",
    "--only",
    "hosting",
    "--project",
    FIREBASE_PROJECT,
  ]);
}

await main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
