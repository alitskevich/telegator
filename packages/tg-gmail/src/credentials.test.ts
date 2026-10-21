import { describe, expect, test } from "vitest";
import { parseGmailCredentials } from "./credentials";

const valid = { clientId: "id.apps", clientSecret: "GOCSPX-x", refreshToken: "1//0token" };

describe("parseGmailCredentials", () => {
  test("parses the secret's JSON", () => {
    expect(parseGmailCredentials(JSON.stringify(valid))).toEqual(valid);
  });

  test("names the bad field and never echoes the token", () => {
    const secret = JSON.stringify({ ...valid, refreshToken: "" });

    expect(() => parseGmailCredentials(secret)).toThrow("malformed at: refreshToken");
    expect(() => parseGmailCredentials("1//0token not json")).toThrow(/^the Gmail secret/);
    try {
      parseGmailCredentials("1//0token not json");
    } catch (error) {
      expect(String(error)).not.toContain("1//0token");
    }
  });
});
