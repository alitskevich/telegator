import { Stack } from "aws-cdk-lib";

/**
 * §9.1 L800 — two DynamoDB tables with their GSIs, PITR on `messages`.
 *
 * Empty for now: item 1.4 needs one stack because `cdk synth` exits 1 on an app
 * with none ("This app contains no stacks"). The resources land in item 4.2.
 */
export class TelegatorDataStack extends Stack {}
