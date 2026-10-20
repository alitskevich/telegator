import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { PROJECT_ID } from "tg-configs/firebase";
import { createMtprotoClient } from "tg-mtproto/client";
import type { MtprotoCredentials } from "tg-mtproto/credentials";

/**
 * `npm run mtproto:login` — signs the reading account in once and stores
 * `{apiId, apiHash, session}` as the `MTPROTO_SESSION` function secret.
 * TG_API_ID and TG_API_HASH come from my.telegram.org → API development tools.
 */

function requireVar(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; take it from my.telegram.org`);
  return value;
}

async function main(): Promise<void> {
  const login: MtprotoCredentials = {
    apiId: Number(requireVar("TG_API_ID")),
    apiHash: requireVar("TG_API_HASH"),
    session: "",
  };

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const client = createMtprotoClient(login);
  try {
    await client.start({
      phoneNumber: () => rl.question("Phone (+31…): "),
      phoneCode: () => rl.question("Login code: "),
      password: () => rl.question("2FA password: "),
      onError: (error) => console.error(error),
    });
    const me = await client.getMe();
    const secret = JSON.stringify({ ...login, session: String(client.session.save()) });

    const stored = spawnSync(
      "firebase",
      ["functions:secrets:set", "MTPROTO_SESSION", "--data-file", "-", "-P", PROJECT_ID],
      { input: secret, stdio: ["pipe", "inherit", "inherit"] },
    );
    if (stored.status !== 0) throw new Error("firebase functions:secrets:set failed");
    console.log(
      `logged in as ${me.username ?? me.id.toString()}; session stored in MTPROTO_SESSION`,
    );
  } finally {
    rl.close();
    await client.destroy();
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
