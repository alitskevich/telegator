import { App } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { describe, expect, test } from "vitest";
import { ROLE_GROUPS, TelegatorAuthStack } from "./auth-stack.js";
import { resolveConfig } from "./config.js";

function stackFor(context: Record<string, unknown> = {}) {
  const app = new App({ context });
  const stack = new TelegatorAuthStack(app, "TelegatorAuthStack", { config: resolveConfig(app) });
  return { stack, template: Template.fromStack(stack) };
}

const pool = (t: Template) =>
  Object.values(t.findResources("AWS::Cognito::UserPool"))[0]?.Properties;

const groups = (t: Template) =>
  Object.values(t.findResources("AWS::Cognito::UserPoolGroup")).map(
    (r) => r.Properties?.GroupName as string,
  );

describe("TelegatorAuthStack", () => {
  test("declares one user pool (§8.6 L780)", () => {
    stackFor().template.resourceCountIs("AWS::Cognito::UserPool", 1);
  });

  /**
   * §8.6 L788 — "a new user is created **disabled** with no roles and must be
   * enabled manually". Self-sign-up would let anyone create an enabled account
   * with no operator in the loop, so AdminCreateUser has to be the only path.
   * This is the single most security-relevant assertion in the stack.
   */
  test("permits only an administrator to create users", () => {
    expect(pool(stackFor().template)?.AdminCreateUserConfig).toMatchObject({
      AllowAdminCreateUserOnly: true,
    });
  });

  test("declares one group per role (§8.6 L782-786)", () => {
    expect(groups(stackFor().template).sort()).toEqual(["admin", "editor", "viewer"]);
  });

  test("exports the role names the dashboard checks against", () => {
    expect([...ROLE_GROUPS]).toEqual(["viewer", "editor", "admin"]);
  });

  test("orders the groups by precedence, most privileged first", () => {
    const byName = Object.fromEntries(
      Object.values(stackFor().template.findResources("AWS::Cognito::UserPoolGroup")).map((r) => [
        r.Properties?.GroupName as string,
        r.Properties?.Precedence as number,
      ]),
    );

    expect(byName.admin).toBeLessThan(byName.editor ?? 0);
    expect(byName.editor).toBeLessThan(byName.viewer ?? 0);
  });

  /** §8.6 L780 — "hosted UI", which needs a domain. */
  test("declares a hosted-UI domain", () => {
    stackFor().template.resourceCountIs("AWS::Cognito::UserPoolDomain", 1);
  });

  test("names the pool and domain with the §9.2 L810 environment prefix", () => {
    const { template } = stackFor({ env: "prod" });

    expect(pool(template)?.UserPoolName).toBe("telegator-prod-users");
    expect(
      Object.values(template.findResources("AWS::Cognito::UserPoolDomain"))[0]?.Properties?.Domain,
    ).toBe("telegator-prod-users");
  });

  test("declares an app client for the dashboard", () => {
    stackFor().template.resourceCountIs("AWS::Cognito::UserPoolClient", 1);
  });

  /**
   * The callback URL is a context parameter because §9.1 L806 deploys Auth
   * *before* App, so the Amplify domain does not exist yet — and a lookup would
   * break the credential-free synth gate.
   */
  test("takes its callback URLs from context", () => {
    const { template } = stackFor({ callbackUrls: ["https://example.test/api/auth/callback"] });
    const client = Object.values(template.findResources("AWS::Cognito::UserPoolClient"))[0];

    expect(client?.Properties?.CallbackURLs).toEqual(["https://example.test/api/auth/callback"]);
  });

  test("falls back to a localhost callback so a dev synth needs no context", () => {
    const client = Object.values(
      stackFor().template.findResources("AWS::Cognito::UserPoolClient"),
    )[0];
    const urls = client?.Properties?.CallbackURLs;

    if (!Array.isArray(urls)) throw new Error("the app client declares no callback URLs");
    expect(urls).toHaveLength(1);
    expect(String(urls[0])).toContain("localhost");
  });

  test("exposes the pool and client to the App stack", () => {
    const { stack } = stackFor();

    expect(stack.userPool.userPoolId).toBeDefined();
    expect(stack.userPoolClient.userPoolClientId).toBeDefined();
  });

  test("is environment-agnostic and requests no context lookup", () => {
    const app = new App({ context: {} });
    new TelegatorAuthStack(app, "TelegatorAuthStack", { config: resolveConfig(app) });
    const assembly = app.synth();

    expect(assembly.manifest.missing ?? []).toEqual([]);
    for (const s of assembly.stacks) {
      expect(s.environment.account).toBe("unknown-account");
    }
  });
});
