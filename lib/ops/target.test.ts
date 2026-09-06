import { describe, expect, test } from "vitest";
import { parseTarget, REGION } from "./target";

describe("parseTarget", () => {
  test("defaults to dev", () => {
    expect(parseTarget([])).toEqual({ env: "dev" });
  });

  test("accepts --env in both spellings", () => {
    expect(parseTarget(["--env", "prod"]).env).toBe("prod");
    expect(parseTarget(["--env=prod"]).env).toBe("prod");
  });

  /**
   * The default is `dev`, so a fumbled flag does not fail — it silently
   * operates on the wrong environment's resources while looking like it worked.
   */
  test("an unknown argument throws rather than being ignored", () => {
    expect(() => parseTarget(["--environment=prod"])).toThrow("--environment=prod");
    expect(() => parseTarget(["prod"])).toThrow("prod");
  });

  test("--env with no value throws", () => {
    expect(() => parseTarget(["--env"])).toThrow("--env");
  });
});

describe("REGION", () => {
  /** §9.2 L810. A script pointed elsewhere addresses a second, silent copy. */
  test("is the one region the project deploys to", () => {
    expect(REGION).toBe("eu-central-1");
  });
});
