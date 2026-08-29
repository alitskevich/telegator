import { RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import {
  AccountRecovery,
  CfnUserPoolGroup,
  OAuthScope,
  UserPool,
  type UserPoolClient,
  type UserPoolDomain,
} from "aws-cdk-lib/aws-cognito";
import type { Construct } from "constructs";
import { ROLE_GROUPS } from "../../lib/auth/roles.js";
import type { TelegatorConfig } from "./config.js";

/**
 * §9.1 L803 — Cognito user pool, groups, app client.
 *
 * §8.6 L790 is a prohibition this stack has to honour structurally: "The
 * source's API handler bypasses authentication entirely when an emulator
 * environment variable is set... No code path skips authorisation." That is why
 * local development points at a real dev pool rather than at a stub, and why
 * this stack exists in both environments.
 */

export interface TelegatorAuthStackProps extends StackProps {
  readonly config: TelegatorConfig;
}

/**
 * Re-exported so this stack keeps a single import surface, but *defined* in
 * `lib/auth/roles.ts` — the dashboard authorises against the same array that
 * names these groups, and it cannot import a CDK module to get it.
 */
export { ROLE_GROUPS };

/** A dev synth must not require context, so the callback falls back to localhost. */
const DEFAULT_CALLBACK_URLS = ["http://localhost:3000/api/auth/callback"];

export class TelegatorAuthStack extends Stack {
  public readonly userPool: UserPool;
  public readonly userPoolClient: UserPoolClient;
  public readonly userPoolDomain: UserPoolDomain;

  constructor(scope: Construct, id: string, props: TelegatorAuthStackProps) {
    super(scope, id, props);

    const { config } = props;
    const poolName = config.name("users");

    this.userPool = new UserPool(this, "UserPool", {
      userPoolName: poolName,
      /**
       * §8.6 L788 — "a new user is created **disabled** with no roles and must be
       * enabled manually". Self-sign-up would let anyone create an enabled
       * account with no operator in the loop, so `AdminCreateUser` is the only
       * path in. This is the security-critical property of the whole stack.
       */
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      // An operator pool outliving its stack is the safe default: losing it
      // locks every operator out of the dashboard, and it holds no pipeline data
      // that could be reconstructed from elsewhere.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    /** §8.6 L780 — "hosted UI", which requires a domain. */
    this.userPoolDomain = this.userPool.addDomain("HostedUiDomain", {
      cognitoDomain: { domainPrefix: poolName },
    });

    /**
     * §9.1 L806 deploys Auth **before** App, so the Amplify domain does not
     * exist yet and the callback URL cannot be derived from it. A context
     * parameter rather than a lookup: `valueFromLookup` would turn synth into an
     * authenticated call and break the only infrastructure gate this build has.
     */
    const callbackUrls = readUrls(this.node.tryGetContext("callbackUrls"), DEFAULT_CALLBACK_URLS);
    const logoutUrls = readUrls(this.node.tryGetContext("logoutUrls"), callbackUrls);

    this.userPoolClient = this.userPool.addClient("DashboardClient", {
      userPoolClientName: config.name("dashboard"),
      // Authorization-code flow: the implicit flow returns tokens in the URL
      // fragment, where they land in browser history and referrer headers.
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE],
        callbackUrls,
        logoutUrls,
      },
      generateSecret: false,
    });

    ROLE_GROUPS.forEach((role, index) => {
      new CfnUserPoolGroup(this, `${role}Group`, {
        groupName: role,
        userPoolId: this.userPool.userPoolId,
        // Cognito treats a lower precedence as more privileged, and §8.6's
        // grants are cumulative, so the most privileged role gets the lowest
        // number. Derived from the array order so the two cannot drift.
        precedence: ROLE_GROUPS.length - index,
      });
    });
  }
}

function readUrls(raw: unknown, fallback: readonly string[]): string[] {
  if (raw === undefined) return [...fallback];
  if (Array.isArray(raw) && raw.every((entry) => typeof entry === "string")) return raw;
  if (typeof raw === "string") return raw.split(",").map((url) => url.trim());
  throw new Error(`expected a list of URLs, received ${String(raw)}`);
}
