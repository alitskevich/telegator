import { describe, expect, test } from "vitest";
import { SESSION_KEY_BYTES } from "./config.js";
import { createSessionKeyReader } from "./sessionKey.js";

const ARN = "arn:aws:secretsmanager:eu-central-1:000000000000:secret:telegator/session-key";
const SECRET = Buffer.alloc(SESSION_KEY_BYTES, 9).toString("base64");

function secretsClient(reply: () => unknown) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    send: (async () => {
      calls += 1;
      return reply();
      // biome-ignore lint/suspicious/noExplicitAny: as above.
    }) as any,
  };
}

describe("createSessionKeyReader", () => {
  test("reads and decodes the key", async () => {
    const read = createSessionKeyReader(
      ARN,
      secretsClient(() => ({ SecretString: SECRET })),
    );
    expect(await read()).toHaveLength(SESSION_KEY_BYTES);
  });

  /**
   * Amplify's server runtime reuses a process across requests, and this is a
   * network call on the sign-in path. Fetching per request would add a round
   * trip to every authenticated page for a value that does not change.
   */
  test("fetches once and caches", async () => {
    const client = secretsClient(() => ({ SecretString: SECRET }));
    const read = createSessionKeyReader(ARN, client);

    await read();
    await read();

    expect(client.calls).toBe(1);
  });

  /**
   * A binary secret has no `SecretString`. Failing loudly beats sealing every
   * cookie with a key derived from `undefined`.
   */
  test("throws when the secret has no string value", async () => {
    const read = createSessionKeyReader(
      ARN,
      secretsClient(() => ({})),
    );
    await expect(read()).rejects.toThrow(/SecretString/);
  });

  test("a failed read is not cached", async () => {
    let attempt = 0;
    const client = secretsClient(() => {
      attempt += 1;
      if (attempt === 1) throw new Error("throttled");
      return { SecretString: SECRET };
    });
    const read = createSessionKeyReader(ARN, client);

    await expect(read()).rejects.toThrow(/throttled/);
    expect(await read()).toHaveLength(SESSION_KEY_BYTES);
  });
});
