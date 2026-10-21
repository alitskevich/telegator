import { describe, expect, test } from "vitest";
import { parseYoutubeCredentials } from "./credentials";

const valid = { clientId: "id.apps", clientSecret: "GOCSPX-x", refreshToken: "1//0token" };

describe("parseYoutubeCredentials", () => {
  test("parses the secret's JSON", () => {
    expect(parseYoutubeCredentials(JSON.stringify(valid))).toEqual(valid);
  });

  test("names the bad field and never echoes the token", () => {
    const secret = JSON.stringify({ ...valid, refreshToken: "" });

    expect(() => parseYoutubeCredentials(secret)).toThrow("malformed at: refreshToken");
    expect(() => parseYoutubeCredentials("1//0token not json")).toThrow(/^the YouTube secret/);
    try {
      parseYoutubeCredentials("1//0token not json");
    } catch (error) {
      expect(String(error)).not.toContain("1//0token");
    }
  });
});
