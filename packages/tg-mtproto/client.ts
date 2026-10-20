import { Logger, TelegramClient } from "telegram";
import { LogLevel } from "telegram/extensions/Logger";
import { StringSession } from "telegram/sessions";
import type { MtprotoCredentials } from "./credentials";

/**
 * Building and opening the GramJS client. The one module here that touches the
 * network, so it holds no logic: mapping and paging live in `reader.ts`.
 */

/** GramJS's own default; stated so a library default cannot change it silently. */
const CONNECTION_RETRIES = 5;

/**
 * One factory for the function and for `scripts/mtproto-login.ts`, so the saved
 * session is opened with the settings that will read it. GramJS logs at `error`
 * only, so its plain text does not interleave with our JSON log lines.
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
 * Connects with a saved session and refuses one Telegram no longer honours:
 * `connect()` succeeds on a revoked session. The client is destroyed on refusal,
 * because GramJS keeps an update loop alive after a bare `disconnect()`.
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
