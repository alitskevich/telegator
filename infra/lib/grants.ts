import type { ITable } from "aws-cdk-lib/aws-dynamodb";
import { Effect, type IGrantable, PolicyStatement } from "aws-cdk-lib/aws-iam";

/**
 * §7.6's per-function least privilege, expressed as the actions a stage calls
 * rather than as CDK's `grantReadWriteData`.
 *
 * That helper matches §7.6's "read/write" wording literally and includes
 * `DeleteItem` and `BatchWriteItem`. No consumer in this build deletes a record:
 * §7.2 makes `messages` the only durable record of a Telegram post, §1.3 L49
 * says a post that never merges "leaves no row anywhere", and §8.4 L751 makes
 * even an operator's delete soft. "Read/write" is a summary of intent — read as
 * an API list it would also let `scrape` drop every source.
 */

/**
 * A Query is authorised against the index's ARN, not the table's.
 *
 * This is the trap that makes narrowing riskier than leaving it wide:
 * `table.grant()` grants the table alone, so a narrowed Query would pass synth
 * and every template assertion, then fail at runtime on §3.1 L187's source
 * selection and §6 L515's dedup read. A Scan here is always a table scan
 * (`listAll`), so only Query pulls in the index ARNs.
 */
const NEEDS_INDEX = "dynamodb:Query";

export function grantTableActions(
  table: ITable,
  grantee: IGrantable,
  ...actions: readonly string[]
): void {
  const resources = [table.tableArn];
  if (actions.includes(NEEDS_INDEX)) resources.push(`${table.tableArn}/index/*`);

  grantee.grantPrincipal.addToPrincipalPolicy(
    new PolicyStatement({ effect: Effect.ALLOW, actions: [...actions], resources }),
  );
}
