import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import { CorsHttpMethod, HttpApi, HttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Architecture, LoggingFormat } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import type { Construct } from "constructs";
import { AUTH_ENV_VARS } from "tg-configs/auth";
import { DASHBOARD_ENV_VARS, ENV_VARS } from "tg-configs/env";
import type { TelegatorAuthStack } from "./auth-stack";
import type { TelegatorConfig } from "./config";
import type { TelegatorDataStack } from "./data-stack";
import { grantTableActions } from "./grants";
import { BUNDLING, RUNTIME } from "./lambda";
import type { TelegatorPipelineStack } from "./pipeline-stack";
import type { TelegatorQueueStack } from "./queue-stack";
import { webOrigins } from "./web";

/**
 * §9.1 — the dashboard's server side: one API Lambda behind an HTTP API.
 *
 * §9.3 serves the console itself as static files from Firebase Hosting, so
 * nothing here hosts a page. What remains is the part a browser cannot do —
 * hold AWS permissions — and that is all this stack grants. Last in §9.1's
 * order, since it consumes every other stack.
 */

/**
 * Re-exported so this stack keeps one import surface, but *defined* in
 * `tg-configs/env.ts` — the API reads the same names and must not import a CDK
 * module to get them.
 */
export { DASHBOARD_ENV_VARS };

/** §8.4 — the one route (`tg-api/http.ts`). */
export const RPC_PATH = "/rpc";

/**
 * `publishPending` invokes the publish stage once per pending message, up to its
 * cap, and `runScraper` waits for a scrape that may poll ten channels. API
 * Gateway's own ceiling is 30 s, so the function gets that and no more: a longer
 * timeout would run on after the browser had already been told it failed.
 */
const API_TIMEOUT = Duration.seconds(29);

/** The SDK clients and the JWKS cache are all it holds; the pipeline's smallest size suffices. */
const API_MEMORY_MB = 512;

export interface TelegatorAppStackProps extends StackProps {
  readonly config: TelegatorConfig;
  readonly data: TelegatorDataStack;
  readonly queues: TelegatorQueueStack;
  readonly auth: TelegatorAuthStack;
  readonly pipeline: TelegatorPipelineStack;
}

export class TelegatorAppStack extends Stack {
  public readonly api: HttpApi;
  public readonly apiFunction: NodejsFunction;

  constructor(scope: Construct, id: string, props: TelegatorAppStackProps) {
    super(scope, id, props);

    const { config, data, queues, auth, pipeline } = props;

    const [analyzeDlq, aggregateDlq, publishDlq] = queues.deadLetterQueues;
    if (analyzeDlq === undefined || aggregateDlq === undefined || publishDlq === undefined) {
      throw new Error("the queue stack must expose all three DLQs");
    }

    this.apiFunction = new NodejsFunction(this, "ApiFunction", {
      functionName: config.name("api"),
      entry: "packages/tg-api/handler.ts",
      handler: "handler",
      runtime: RUNTIME,
      architecture: Architecture.ARM_64,
      loggingFormat: LoggingFormat.TEXT,
      timeout: API_TIMEOUT,
      memorySize: API_MEMORY_MB,
      bundling: { ...BUNDLING },
      environment: {
        // The API reads the same tables and queues the pipeline writes, so the
        // names come from `tg-configs/env.ts` rather than a second vocabulary.
        [ENV_VARS.sourcesTable]: data.sources.tableName,
        [ENV_VARS.messagesTable]: data.messages.tableName,
        [ENV_VARS.targetsTable]: data.targets.tableName,
        [ENV_VARS.analyzeQueueUrl]: queues.analyze.queueUrl,
        [ENV_VARS.aggregateQueueUrl]: queues.aggregate.queueUrl,
        [ENV_VARS.publishQueueUrl]: queues.publish.queueUrl,
        [ENV_VARS.analyzeDlqUrl]: analyzeDlq.queueUrl,
        [ENV_VARS.aggregateDlqUrl]: aggregateDlq.queueUrl,
        [ENV_VARS.publishDlqUrl]: publishDlq.queueUrl,
        // §8.4 — the functions the manual triggers invoke by name.
        [DASHBOARD_ENV_VARS.scrapeFunctionName]: pipeline.functions.scrape.functionName,
        [DASHBOARD_ENV_VARS.dlqReplayFunctionName]: pipeline.functions.dlqReplay.functionName,
        [DASHBOARD_ENV_VARS.publishFunctionName]: pipeline.functions.publish.functionName,
        [DASHBOARD_ENV_VARS.consumeFunctionName]: pipeline.functions.consume.functionName,
        // §8.6 — what the token verifier checks issuer and audience against.
        [AUTH_ENV_VARS.userPoolId]: auth.userPool.userPoolId,
        [AUTH_ENV_VARS.userPoolClientId]: auth.userPoolClient.userPoolClientId,
        // §8.5 — taken from the function's own log group rather than rebuilt as
        // `/aws/lambda/${name}`, so a change to either stays in step.
        [DASHBOARD_ENV_VARS.analyzeLogGroup]: pipeline.functions.analyze.logGroup.logGroupName,
      },
    });

    this.grantApiPermissions(data, queues, pipeline, auth);

    /**
     * The JWT authorizer is the edge half of §8.6: an anonymous or foreign
     * token is refused before the Lambda is invoked, so unauthenticated traffic
     * costs nothing. It is not the gate — `tg-api` verifies the token again
     * and re-checks role and status per action — because HTTP API flattens the
     * `cognito:groups` array into a string, and the role must be read from the
     * real claim.
     */
    const authorizer = new HttpJwtAuthorizer(
      "CognitoAuthorizer",
      `https://cognito-idp.${this.region}.amazonaws.com/${auth.userPool.userPoolId}`,
      { jwtAudience: [auth.userPoolClient.userPoolClientId] },
    );

    this.api = new HttpApi(this, "Api", {
      apiName: config.name("api"),
      // The preflight is answered by API Gateway itself, ahead of the
      // authorizer — a browser sends no token on an OPTIONS request.
      corsPreflight: {
        allowOrigins: webOrigins(this.node),
        allowMethods: [CorsHttpMethod.POST],
        allowHeaders: ["authorization", "content-type"],
        maxAge: Duration.hours(1),
      },
    });

    this.api.addRoutes({
      path: RPC_PATH,
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration("RpcIntegration", this.apiFunction),
      authorizer,
    });

    // `scripts/deploy-web.ts` reads these to write the console's `config.json`.
    new CfnOutput(this, "ApiUrl", { value: `${this.api.apiEndpoint}${RPC_PATH}` });
  }

  /**
   * §7.6's dashboard permission set, plus R24's additions — each names the
   * section that needs it. Cognito administration is deliberately not granted:
   * §8.2–§8.4 define no user-management surface. R34 admits exactly one read.
   */
  private grantApiPermissions(
    data: TelegatorDataStack,
    queues: TelegatorQueueStack,
    pipeline: TelegatorPipelineStack,
    auth: TelegatorAuthStack,
  ): void {
    const role = this.apiFunction;

    // §7.6 — "read both tables, write `sources`/`messages`". Soft deletes
    // (§8.4) are writes, so no DeleteItem is needed. The Sources table is a
    // Scan (`listAll`); "add" is a PutItem and an edit an UpdateItem.
    grantTableActions(
      data.sources,
      role,
      "dynamodb:GetItem",
      "dynamodb:Scan",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    );

    // target-table#3.2 — the same four the Sources table needs.
    grantTableActions(
      data.targets,
      role,
      "dynamodb:GetItem",
      "dynamodb:Scan",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    );

    // §8.3's tabs and §8.5's count are Queries on `status-index`. No PutItem:
    // R37 — a message id is minted by the scrape stage, so the console cannot
    // create one.
    grantTableActions(
      data.messages,
      role,
      "dynamodb:GetItem",
      "dynamodb:Query",
      "dynamodb:UpdateItem",
    );

    /**
     * R34. §8.6 — "a disabled user is rejected at every action" — needs a live
     * read, and this is it: one read action, on this pool only. The
     * user-management APIs remain ungranted, and a test names them.
     */
    role.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["cognito-idp:AdminGetUser"],
        resources: [auth.userPool.userPoolArn],
      }),
    );

    role.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        // §8.5's cards. GetMetricData takes no resource-level ARN.
        actions: ["cloudwatch:GetMetricData"],
        resources: ["*"],
      }),
    );

    /**
     * §8.5's category chart runs one Logs Insights query over one log group —
     * the analyze function's. `StartQuery` takes a resource, so it is scoped to
     * that group; on `*` this role could query every log group in the account.
     */
    role.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["logs:StartQuery"],
        resources: [pipeline.functions.analyze.logGroup.logGroupArn],
      }),
    );

    /**
     * R24 — `StartQuery` returns nothing on its own. These two key off an
     * ephemeral query id rather than a log group, so `*` is the only form AWS
     * accepts; kept separate so the narrowing above is not undone by grouping.
     */
    role.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["logs:GetQueryResults", "logs:StopQuery"],
        resources: ["*"],
      }),
    );

    // §8.5's queue-depth figures and error card.
    for (const queue of [queues.analyze, queues.aggregate, queues.publish]) {
      queue.grant(role, "sqs:GetQueueAttributes");
    }

    /**
     * R24 — DLQ inspection reads message bodies, which GetQueueAttributes
     * cannot do. R57 adds `PurgeQueue`, and only here: the grant is per
     * dead-letter queue, so nothing in this stack can purge a *source* queue
     * and discard work still in flight.
     */
    for (const dlq of queues.deadLetterQueues) {
      dlq.grant(role, "sqs:GetQueueAttributes", "sqs:ReceiveMessage", "sqs:PurgeQueue");
    }

    // R24 — §8.4's republishMessage "sets `topublish`, enqueues".
    queues.publish.grantSendMessages(role);

    /**
     * §7.6 — "lambda:InvokeFunction on the scraper and the replay handler".
     * §8.2 makes the narrowness matter: the API must not import `tg-pipeline/`,
     * so a broader grant would let it invoke the stages directly and the
     * boundary would exist only in the source tree.
     *
     * R53 — `publish` is a recorded third, because "Publish now" has no other
     * route. R61 — `consume` is a fourth, and it is what keeps the boundary
     * intact: one pump Lambda holds the queue and stage grants, and this role
     * may only ask it to run. `analyze` and `aggregate` stay ungranted.
     */
    role.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["lambda:InvokeFunction"],
        resources: [
          pipeline.functions.scrape.functionArn,
          pipeline.functions.dlqReplay.functionArn,
          pipeline.functions.publish.functionArn,
          pipeline.functions.consume.functionArn,
        ],
      }),
    );
  }
}
