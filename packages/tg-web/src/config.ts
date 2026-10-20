import { z } from "zod";

/**
 * §9.3 — what the console needs to know about its deployment, served beside
 * it as `/config.json` and read once before launch.
 *
 * A file rather than a build-time constant: one bundle serves every
 * environment, and `scripts/deploy-web.ts` writes the file from the stacks'
 * outputs, so nothing here is typed by hand. None of it is secret — a browser
 * has to be told all of it to sign in at all.
 */
export const WebConfigSchema = z.object({
  apiUrl: z.url(),
  userPoolClientId: z.string().min(1),
  hostedUiDomain: z.url().transform((url) => url.replace(/\/+$/, "")),
});

export type WebConfig = z.infer<typeof WebConfigSchema>;

export const CONFIG_PATH = "/config.json";

export async function loadConfig(fetchImpl: typeof fetch = fetch): Promise<WebConfig> {
  const response = await fetchImpl(CONFIG_PATH, { cache: "no-store" });
  if (!response.ok) throw new Error(`${CONFIG_PATH} answered ${response.status}`);
  return WebConfigSchema.parse(await response.json());
}
