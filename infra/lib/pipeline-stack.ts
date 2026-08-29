import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import { ENV_VARS } from "../../handlers/env.js";
import type { TelegatorConfig } from "./config.js";
import type { TelegatorDataStack } from "./data-stack.js";
import type { TelegatorQueueStack } from "./queue-stack.js";

/**
 * §9.1 L802 — the pipeline's five Lambdas. Their triggers, IAM and alarms are
 * item 4.6; this item is the function inventory of §7.5 L645–653.
 *
 * §9.1 L806 puts this stack after Data and Queue, which is why both arrive as
 * props: passing the constructs directly lets CDK emit the exports and imports
 * itself, rather than importing by a hardcoded name that would not exist until
 * the other stack had deployed.
 */

export const PIPELINE_FUNCTIONS = [
  "scrape",
  "analyze",
  "aggregate",
  "publish",
  "dlqReplay",
] as const;

export type PipelineFunction = (typeof PIPELINE_FUNCTIONS)[number];

export interface TelegatorPipelineStackProps extends StackProps {
  readonly config: TelegatorConfig;
  readonly data: TelegatorDataStack;
  readonly queues: TelegatorQueueStack;
}

/** Every row of §7.5's table gives 300 s. */
const TIMEOUT = Duration.seconds(300);

/** §7.5 L645 — "All Node.js 22, ARM64, bundled with esbuild." */
const RUNTIME = Runtime.NODEJS_22_X;

/**
 * Bundling settings shared by all five.
 *
 * `forceDockerBundling: false` is not a preference: there is no Docker on the
 * build machine, and CDK falls back to a container image when it cannot find a
 * local esbuild. With esbuild installed as a devDependency it bundles in
 * process, which is what keeps `cdk synth` runnable here at all.
 */
const BUNDLING = {
  forceDockerBundling: false,
  minify: true,
  sourceMap: true,
  // The Node 22 runtime ships the AWS SDK v3, so bundling it would add
  // megabytes to every artifact for no behavioural gain.
  externalModules: ["@aws-sdk/*"] as string[],
  format: OutputFormat.ESM,
  // ESM output needs this shim: several transitive dependencies still call
  // `require`, which does not exist in an ESM module scope.
  banner: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);",
} as const;

interface FunctionSpec {
  readonly key: PipelineFunction;
  /** The §7.5 name, before the environment prefix. */
  readonly name: string;
  readonly entry: string;
  readonly memorySize: number;
  /**
   * §7.5 L651–652 write "by message group" rather than a number for aggregate
   * and publish, and §3.3 L260 is explicit that the FIFO group "replaces a
   * blunt reserved-concurrency-of-1". Reserving there would serialise across
   * dates too, undoing the parallelism the groups exist to allow.
   */
  readonly reservedConcurrency?: number;
  /** §12.5 L887 gives a retention only for analyze. */
  readonly logRetention?: RetentionDays;
}

const SPECS: readonly FunctionSpec[] = [
  { key: "scrape", name: "scrape", entry: "scrape.ts", memorySize: 512, reservedConcurrency: 1 },
  {
    key: "analyze",
    name: "analyze",
    entry: "analyze.ts",
    memorySize: 512,
    reservedConcurrency: 5,
    // §12.5 L887 — 90 days. Not decoration: §7.7 L695 sources §8.5 L771's
    // category chart from a Logs Insights query over these logs, so retention
    // is a functional setting rather than a cost one.
    logRetention: RetentionDays.THREE_MONTHS,
  },
  // §7.5 L657 — 1024 MB "because it holds a day of 4 KB vectors plus a 10-item
  // embedding batch".
  { key: "aggregate", name: "aggregate", entry: "aggregate.ts", memorySize: 1024 },
  { key: "publish", name: "publish", entry: "publish.ts", memorySize: 512 },
  {
    key: "dlqReplay",
    name: "dlq-replay",
    entry: "dlqReplay.ts",
    memorySize: 512,
    reservedConcurrency: 1,
  },
];

export class TelegatorPipelineStack extends Stack {
  public readonly functions: Record<PipelineFunction, NodejsFunction>;

  constructor(scope: Construct, id: string, props: TelegatorPipelineStackProps) {
    super(scope, id, props);

    const { config, data, queues } = props;

    /**
     * Every variable `handlers/env.ts` requires, on every function.
     *
     * One environment for all five rather than a per-function subset: the
     * handlers read what they need lazily, an unused variable costs nothing,
     * and a single map means a stack that forgets one fails the same way for
     * every function instead of only the one nobody invoked yet. `AWS_REGION`
     * is absent because Lambda sets it and CloudFormation rejects declaring it.
     */
    const environment: Record<string, string> = {
      [ENV_VARS.sourcesTable]: data.sources.tableName,
      [ENV_VARS.messagesTable]: data.messages.tableName,
      [ENV_VARS.analyzeQueueUrl]: queues.analyze.queueUrl,
      [ENV_VARS.aggregateQueueUrl]: queues.aggregate.queueUrl,
      [ENV_VARS.publishQueueUrl]: queues.publish.queueUrl,
      [ENV_VARS.analyzeDlqUrl]: dlqUrl(queues, "analyze"),
      [ENV_VARS.aggregateDlqUrl]: dlqUrl(queues, "aggregate"),
      [ENV_VARS.publishDlqUrl]: dlqUrl(queues, "publish"),
      // §7.6 L663 — the one secret. Its ARN is a context parameter rather than
      // a lookup: a `Secret.fromLookup` would make synth an authenticated call.
      [ENV_VARS.telegramSecretArn]: String(
        this.node.tryGetContext("telegramSecretArn") ?? "telegram-bot-token-arn-not-configured",
      ),
    };

    const built = SPECS.map((spec) => {
      const fn = new NodejsFunction(this, `${spec.key}Function`, {
        functionName: config.name(spec.name),
        entry: `handlers/${spec.entry}`,
        handler: "handler",
        runtime: RUNTIME,
        architecture: Architecture.ARM_64,
        timeout: TIMEOUT,
        memorySize: spec.memorySize,
        environment,
        bundling: { ...BUNDLING },
        ...(spec.reservedConcurrency === undefined
          ? {}
          : { reservedConcurrentExecutions: spec.reservedConcurrency }),
      });

      if (spec.logRetention !== undefined) {
        new LogGroup(this, `${spec.key}LogGroup`, {
          logGroupName: `/aws/lambda/${config.name(spec.name)}`,
          retention: spec.logRetention,
          removalPolicy: RemovalPolicy.DESTROY,
        });
      }

      return [spec.key, fn] as const;
    });

    this.functions = Object.fromEntries(built) as Record<PipelineFunction, NodejsFunction>;
  }
}

/** §7.3 L610 — "Each has a matching DLQ", in the order the queue stack exposes them. */
function dlqUrl(queues: TelegatorQueueStack, name: "analyze" | "aggregate" | "publish"): string {
  const index = { analyze: 0, aggregate: 1, publish: 2 }[name];
  const dlq = queues.deadLetterQueues[index];
  if (dlq === undefined) throw new Error(`the queue stack exposes no ${name} DLQ`);
  return dlq.queueUrl;
}
