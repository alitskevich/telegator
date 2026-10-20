import { describe, expect, test } from "vitest";
import { parseWebDeployArgs, webConfigFromOutputs } from "./deploy";

describe("parseWebDeployArgs", () => {
  test("defaults to a dry run", () => {
    expect(parseWebDeployArgs([])).toEqual({ execute: false, configOnly: false });
  });

  test("reads the two modes", () => {
    expect(parseWebDeployArgs(["--execute"]).execute).toBe(true);
    expect(parseWebDeployArgs(["--config-only"]).configOnly).toBe(true);
  });

  test("refuses a typo rather than ignoring it", () => {
    expect(() => parseWebDeployArgs(["--exectue"])).toThrow(/unknown argument/);
  });

  test("refuses both modes at once", () => {
    expect(() => parseWebDeployArgs(["--execute", "--config-only"])).toThrow();
  });
});

describe("webConfigFromOutputs", () => {
  const outputs = {
    ApiUrl: "https://abc.execute-api.eu-central-1.amazonaws.com/rpc",
    UserPoolClientId: "client-123",
    HostedUiDomain: "https://telegator-dev-users.auth.eu-central-1.amazoncognito.com",
    UnrelatedOutput: "x",
  };

  test("picks the three values the console reads", () => {
    expect(webConfigFromOutputs(outputs)).toEqual({
      apiUrl: outputs.ApiUrl,
      userPoolClientId: "client-123",
      hostedUiDomain: outputs.HostedUiDomain,
    });
  });

  test("names a missing output", () => {
    const { ApiUrl: _missing, ...partial } = outputs;
    expect(() => webConfigFromOutputs(partial)).toThrow(/ApiUrl/);
  });
});
