import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { PROJECT_ID } from "tg-configs/firebase";
import type { YoutubeCredentials } from "tg-youtube/credentials";
import { z } from "zod";

/**
 * `npm run youtube:login` — lets the absorber edit the playlist owner's YouTube
 * playlists, once, and stores `{clientId, clientSecret, refreshToken}` as the
 * `YOUTUBE_OAUTH` function secret. YT_CLIENT_ID and YT_CLIENT_SECRET come from a
 * Desktop-app OAuth client in the Google Cloud console (docs/telegator.md §10).
 */

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Removing a playlist item needs the full scope; `youtube.readonly` cannot. */
const SCOPE = "https://www.googleapis.com/auth/youtube";

function requireVar(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; take it from the Desktop OAuth client`);
  return value;
}

/** Opens the consent page and waits for Google to send the browser back with `?code=`. */
function authorize(clientId: string): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    let redirectUri = "";
    const server = createServer((request, response) => {
      const params = new URL(request.url ?? "/", redirectUri).searchParams;
      const code = params.get("code");
      const error = params.get("error");
      if (!code && !error) {
        response.writeHead(404).end();
        return;
      }
      response.end(code ? "Signed in. Close this tab." : `Not signed in: ${error}`);
      server.close();
      if (code) resolve({ code, redirectUri });
      else reject(new Error(`consent refused: ${error}`));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") return reject(new Error("no port"));
      redirectUri = `http://127.0.0.1:${address.port}`;
      const url = `${AUTH_URL}?${new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: SCOPE,
        access_type: "offline",
        prompt: "consent",
      })}`;
      console.log(`Sign in with the playlist owner's account:\n${url}`);
      spawnSync("open", [url]);
    });
  });
}

async function main(): Promise<void> {
  const clientId = requireVar("YT_CLIENT_ID");
  const clientSecret = requireVar("YT_CLIENT_SECRET");
  const { code, redirectUri } = await authorize(clientId);

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok) throw new Error(`token exchange: HTTP ${response.status}`);
  const { refresh_token } = z.object({ refresh_token: z.string() }).parse(await response.json());
  const secret: YoutubeCredentials = { clientId, clientSecret, refreshToken: refresh_token };

  const stored = spawnSync(
    "firebase",
    ["functions:secrets:set", "YOUTUBE_OAUTH", "--data-file", "-", "-P", PROJECT_ID],
    { input: JSON.stringify(secret), stdio: ["pipe", "inherit", "inherit"] },
  );
  if (stored.status !== 0) throw new Error("firebase functions:secrets:set failed");
  console.log("refresh token stored in YOUTUBE_OAUTH");
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
