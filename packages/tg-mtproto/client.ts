import { Logger, TelegramClient } from "telegram";
import { LogLevel } from "telegram/extensions/Logger";
import { StringSession } from "telegram/sessions";
import type { MtprotoCredentials } from "./credentials";

/**
 * R63 — building and opening the GramJS client.
 *
 * The one module here that touches the network, so it holds no rule: the
 * reader's mapping and paging are in `reader.ts`, behind an interface a test
 * can fake.
 */

/** GramJS's own default; stated so a library default cannot change it silently. */
const CONNECTION_RETRIES = 5;

/**
 * One factory for the Lambda and for `scripts/mtproto-login.ts`, so the session
 * the script saves is opened with exactly the settings that will read it.
 *
 * GramJS logs every connection step at `info` to stdout; in Lambda that would
 * interleave plain text with `tg-utils/logger.ts`'s one-JSON-object-per-line
 * output, which §8.5's Logs Insights query parses. Errors still print.
 */
export function createMtprotoClient(credentials: MtprotoCredentials): TelegramClient {
  return new TelegramClient(
    new StringSession(credentials.session),
    credentials.apiId,
    credentials.apiHash,
    { connectionRetries: CONNECTION_RETRIES, baseLogger: new Logger(LogLevel.ERROR) },
  );
}

/**
 * Connects with a saved session and refuses one Telegram no longer honours.
 *
 * `connect()` succeeds on a revoked session — it opens the socket and nothing
 * more — so without the check every source would read as an error per run and
 * the cause would be one log line deep. The client is destroyed on refusal:
 * GramJS keeps an update loop alive after a bare `disconnect()`.
 */
export async function connectMtproto(credentials: MtprotoCredentials): Promise<TelegramClient> {
  const client = createMtprotoClient(credentials);
  await client.connect();

  if (!(await client.checkAuthorization())) {
    await client.destroy();
    throw new Error("the MTProto session is not authorised; run `npm run mtproto:login`");
  }

  return client;
}
