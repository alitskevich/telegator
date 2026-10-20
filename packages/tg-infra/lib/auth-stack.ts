import { CfnOutput, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import {
  AccountRecovery,
  CfnUserPoolGroup,
  OAuthScope,
  UserPool,
  type UserPoolClient,
  type UserPoolDomain,
} from "aws-cdk-lib/aws-cognito";
import type { Construct } from "constructs";
import { ROLE_GROUPS } from "tg-enums/roles";
import type { TelegatorConfig } from "./config";
import { callbackUrl, webOrigins } from "./web";

/**
 * §9.1 L896 — Cognito user pool, groups, app client.
 *
 * §8.6 L884 is a prohibition this stack has to honour structurally: "The
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
 * `tg-auth/roles.ts` — the dashboard authorises against the same array that
 * names these groups, and it cannot import a CDK module to get it.
 */
export { ROLE_GROUPS };

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
       * §8.6 L882 — "a new user is created **disabled** with no roles and must be
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

    /** §8.6 L855 — "hosted UI", which requires a domain. */
    this.userPoolDomain = this.userPool.addDomain("HostedUiDomain", {
      cognitoDomain: { domainPrefix: poolName },
    });

    /**
     * §9.3 — the console is a static SPA that signs in and out at its root, so
     * each origin it is served from is both a callback and a logout URL. The
     * list is shared with the API's CORS (`./web.ts`).
     */
    const callbackUrls = webOrigins(this.node).map(callbackUrl);

    this.userPoolClient = this.userPool.addClient("DashboardClient", {
      userPoolClientName: config.name("dashboard"),
      // Authorization-code flow with PKCE: the implicit flow returns tokens in
      // the URL fragment, where they land in browser history and referrer
      // headers. A public client — a browser cannot keep a secret — so the
      // code verifier is what binds the exchange to the tab that started it.
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [OAuthScope.OPENID, OAuthScope.EMAIL, OAuthScope.PROFILE],
        callbackUrls,
        logoutUrls: callbackUrls,
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

    // §9.3 — what the console needs to start a sign-in; none of it is secret.
    // `scripts/deploy-web.ts` reads these to write the console's `config.json`.
    new CfnOutput(this, "UserPoolId", { value: this.userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", { value: this.userPoolClient.userPoolClientId });
    new CfnOutput(this, "HostedUiDomain", { value: this.userPoolDomain.baseUrl() });
  }
}
