import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { ENV_VARS, requireEnv } from "./env.js";

const ORIGINAL = { ...process.env };

beforeEach(() => {
  process.env = { ...ORIGINAL };
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("requireEnv", () => {
  test("returns the configured value", () => {
    process.env.TELEGATOR_MESSAGES_TABLE = "telegator-dev-messages";

    expect(requireEnv(ENV_VARS.messagesTable)).toBe("telegator-dev-messages");
  });

  /**
   * A missing variable must fail loudly at the first invocation rather than
   * produce a client pointed at `undefined`, which DynamoDB would reject with a
   * message naming neither the Lambda nor the variable.
   */
  test("throws naming the variable when it is unset", () => {
    process.env.TELEGATOR_MESSAGES_TABLE = undefined;

    expect(() => requireEnv(ENV_VARS.messagesTable)).toThrow(/TELEGATOR_MESSAGES_TABLE/);
  });

  test("treats an empty value as unset", () => {
    process.env.TELEGATOR_MESSAGES_TABLE = "";

    expect(() => requireEnv(ENV_VARS.messagesTable)).toThrow(/TELEGATOR_MESSAGES_TABLE/);
  });
});

describe("ENV_VARS", () => {
  test("names every variable the stacks must supply", () => {
    expect(ENV_VARS).toEqual({
      sourcesTable: "TELEGATOR_SOURCES_TABLE",
      messagesTable: "TELEGATOR_MESSAGES_TABLE",
      analyzeQueueUrl: "TELEGATOR_ANALYZE_QUEUE_URL",
      aggregateQueueUrl: "TELEGATOR_AGGREGATE_QUEUE_URL",
      publishQueueUrl: "TELEGATOR_PUBLISH_QUEUE_URL",
      telegramSecretArn: "TELEGATOR_TELEGRAM_SECRET_ARN",
    });
  });

  /**
   * AWS_REGION is reserved: Lambda sets it and CloudFormation rejects an
   * attempt to declare it, so it is read directly and never listed here.
   */
  test("does not claim the reserved AWS_REGION", () => {
    expect(Object.values(ENV_VARS)).not.toContain("AWS_REGION");
  });
});
