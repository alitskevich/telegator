import { SecretValue, Stack, type StackProps } from "aws-cdk-lib";
import { CfnApp } from "aws-cdk-lib/aws-amplify";
import { Effect, PolicyStatement, Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import { DASHBOARD_ENV_VARS, ENV_VARS } from "../../handlers/env.js";
import type { TelegatorAuthStack } from "./auth-stack.js";
import type { TelegatorConfig } from "./config.js";
import type { TelegatorDataStack } from "./data-stack.js";
import type { TelegatorPipelineStack } from "./pipeline-stack.js";
import type { TelegatorQueueStack } from "./queue-stack.js";

/**
 * §9.1 L804 — the Amplify Hosting app, its environment config and the app's
 * IAM role.
 *
 * §9.3 L814 chooses Amplify because it "supports the App Router (SSR, server
 * actions, streaming) natively with no OpenNext adapter or Fargate service".
 * Last in §9.1 L806's order, since it consumes every other stack.
 */

/** Env vars the dashboard needs beyond the pipeline's own (`handlers/env.ts`). */
/**
 * Re-exported so this stack keeps one import surface, but *defined* in
 * `handlers/env.ts` — a server action reads the same names and cannot import a
 * CDK module to get them.
 */
export { DASHBOARD_ENV_VARS };

/**
 * Amplify assigns the app's domain after the app exists, so it cannot be read at
 * synth without a circular reference. It is deployment configuration the spec
 * does not state, so it comes from context, defaulting to the dev origin that
 * `infra/lib/auth-stack.ts` already registers as a callback URL.
 */
const DEFAULT_APP_URL = "http://localhost:3000";

export interface TelegatorAppStackProps extends StackProps {
  readonly config: TelegatorConfig;
  readonly data: TelegatorDataStack;
  readonly queues: TelegatorQueueStack;
  readonly auth: TelegatorAuthStack;
  readonly pipeline: TelegatorPipelineStack;
}

export class TelegatorAppStack extends Stack {
  public readonly appRole: Role;

  constructor(scope: Construct, id: string, props: TelegatorAppStackProps) {
    super(scope, id, props);

    const { config, data, queues, auth, pipeline } = props;

    this.appRole = new Role(this, "DashboardRole", {
      roleName: config.name("dashboard"),
      assumedBy: new ServicePrincipal("amplify.amazonaws.com"),
    });

    const sessionSecretArn = String(
      this.node.tryGetContext("sessionSecretArn") ??
        `arn:aws:secretsmanager:${this.region}:${this.account}:secret:${config.name("session-key")}`,
    );

    this.grantAppPermissions(data, queues, pipeline, auth, sessionSecretArn);

    const [analyzeDlq, aggregateDlq, publishDlq] = queues.deadLetterQueues;
    if (analyzeDlq === undefined || aggregateDlq === undefined || publishDlq === undefined) {
      throw new Error("the queue stack must expose all three DLQs");
    }

    const environmentVariables = [
      // The dashboard reads the same tables and queues the pipeline writes, so
      // the names come from `handlers/env.ts` rather than a second vocabulary.
      [ENV_VARS.sourcesTable, data.sources.tableName],
      [ENV_VARS.messagesTable, data.messages.tableName],
      [ENV_VARS.analyzeQueueUrl, queues.analyze.queueUrl],
      [ENV_VARS.aggregateQueueUrl, queues.aggregate.queueUrl],
      [ENV_VARS.publishQueueUrl, queues.publish.queueUrl],
      [ENV_VARS.analyzeDlqUrl, analyzeDlq.queueUrl],
      [ENV_VARS.aggregateDlqUrl, aggregateDlq.queueUrl],
      [ENV_VARS.publishDlqUrl, publishDlq.queueUrl],
      // §8.4 L752/L754 — the two functions the manual triggers invoke by name.
      [DASHBOARD_ENV_VARS.scrapeFunctionName, pipeline.functions.scrape.functionName],
      [DASHBOARD_ENV_VARS.dlqReplayFunctionName, pipeline.functions.dlqReplay.functionName],
      // §8.6 L780 — the hosted-UI session layer.
      [DASHBOARD_ENV_VARS.userPoolId, auth.userPool.userPoolId],
      [DASHBOARD_ENV_VARS.userPoolClientId, auth.userPoolClient.userPoolClientId],
      // `baseUrl()` is the hosted UI's origin, derived from the domain this
      // build already creates rather than reconstructed from a string template.
      [DASHBOARD_ENV_VARS.hostedUiDomain, auth.userPoolDomain.baseUrl()],
      [DASHBOARD_ENV_VARS.appUrl, String(this.node.tryGetContext("appUrl") ?? DEFAULT_APP_URL)],
      /**
       * The ARN, never the value. A literal key here would sit in the
       * CloudFormation template and be readable by anyone who can describe the
       * Amplify app — and this key seals the session cookie, so it forges admin
       * sessions. `handlers/publish.ts` treats the bot token the same way.
       */
      [DASHBOARD_ENV_VARS.sessionSecretArn, sessionSecretArn],
    ].map(([name, value]) => ({ name: String(name), value: String(value) }));

    new CfnApp(this, "DashboardApp", {
      name: config.name("dashboard"),
      // §9.3 L814 — only WEB_COMPUTE runs server-side. WEB would deploy a static
      // export, and every server action of §8.4 would 404.
      platform: "WEB_COMPUTE",
      // `iamServiceRole`, not `iamServiceRoleArn`. The L1 construct accepts an
      // unknown property at runtime, so this compiled and synthesised happily
      // while the app ran with no role at all — tsc is what caught it.
      iamServiceRole: this.appRole.roleArn,
      environmentVariables,
      /**
       * The repository connection is deployment configuration the spec never
       * states, so it comes from context. `SecretValue.secretsManager` resolves
       * at deploy time and leaves a token in the template — unlike
       * `Secret.fromLookup`, which would make synth an authenticated call and
       * break the only infrastructure gate this build has.
       */
      ...repositoryConnection(this),
    });
  }

  /**
   * §7.6 L673's app role, plus R24's additions.
   *
   * R24 records that §7.6's list is incomplete for what §8 actually does; each
   * addition below names the section that needs it. Cognito administration is
   * deliberately **not** granted: §8.2, §8.3 and §8.4 define no
   * user-management route, page or action, so the grant §8.6 L786 implies would
   * exceed the task.
   */
  private grantAppPermissions(
    data: TelegatorDataStack,
    queues: TelegatorQueueStack,
    pipeline: TelegatorPipelineStack,
    auth: TelegatorAuthStack,
    sessionSecretArn: string,
  ): void {
    // §7.6 L673 — "read both tables, write `sources`/`messages`". Soft deletes
    // (§8.4 L751) are writes, so no DeleteItem is needed.
    data.sources.grantReadWriteData(this.appRole);
    data.messages.grantReadWriteData(this.appRole);

    /**
     * R34. §8.6 L788 — "a disabled user is rejected at every action" — needs a
     * live read, and this is it. R24 withheld Cognito from this role because
     * §8.2–§8.4 define no user-management surface; that still holds, and this
     * grant does not reopen it: one read action, on this pool only. The
     * user-management APIs of §8.6 L786 remain ungranted, and a test names them.
     */
    this.appRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["cognito-idp:AdminGetUser"],
        resources: [auth.userPool.userPoolArn],
      }),
    );

    // The cookie sealing key, read at runtime rather than carried in the app's
    // environment. Scoped to the one secret; `secretsmanager:GetSecretValue` on
    // `*` would also read the Telegram bot token of §7.6 L663.
    this.appRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["secretsmanager:GetSecretValue"],
        resources: [sessionSecretArn],
      }),
    );

    this.appRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        // §8.5 L765–767's cards. GetMetricData takes no resource-level ARN.
        actions: ["cloudwatch:GetMetricData"],
        resources: ["*"],
      }),
    );

    this.appRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        // R24 — §7.6 L673 grants only StartQuery, which on its own returns
        // nothing: §8.5 L771's category chart needs the results too.
        actions: ["logs:StartQuery", "logs:GetQueryResults", "logs:StopQuery"],
        resources: ["*"],
      }),
    );

    // §8.5 L769–770's queue-depth strip and error card.
    for (const queue of [queues.analyze, queues.aggregate, queues.publish]) {
      queue.grant(this.appRole, "sqs:GetQueueAttributes");
    }

    // R24 — §8.2 L723's "DLQ inspection" reads message bodies, which
    // GetQueueAttributes cannot do.
    for (const dlq of queues.deadLetterQueues) {
      dlq.grant(this.appRole, "sqs:GetQueueAttributes", "sqs:ReceiveMessage");
    }

    // R24 — §8.4 L753's republishMessage "sets `topublish`, enqueues", and §7.6
    // L673 grants no send at all.
    queues.publish.grantSendMessages(this.appRole);

    /**
     * §7.6 L673 — "lambda:InvokeFunction on the scraper and the replay
     * handler", and only those two.
     *
     * §8.2 L734 is what makes the narrowness matter: the dashboard must not
     * import `lib/pipeline/`, so invoking is its only route into the pipeline.
     * A broader grant would let it invoke the stages directly and the boundary
     * would exist only in the source tree.
     */
    this.appRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["lambda:InvokeFunction"],
        resources: [
          pipeline.functions.scrape.functionArn,
          pipeline.functions.dlqReplay.functionArn,
        ],
      }),
    );
  }
}

/**
 * The GitHub connection, when one is configured.
 *
 * Amplify needs a repository and an access token to build. Both are deployment
 * facts the spec never states, so they arrive as context and are simply absent
 * from a local synth — which keeps `cdk synth` runnable with no credentials and
 * no repository.
 */
function repositoryConnection(stack: Stack): {
  repository?: string;
  oauthToken?: string;
} {
  const repository = stack.node.tryGetContext("repository");
  const tokenSecretName = stack.node.tryGetContext("githubTokenSecretName");

  if (typeof repository !== "string" || typeof tokenSecretName !== "string") return {};

  return {
    repository,
    oauthToken: SecretValue.secretsManager(tokenSecretName).unsafeUnwrap(),
  };
}
