import { UpdateCommand } from "@aws-sdk/lib-dynamodb";

/**
 * An attribute-level `SET`, shared by every partial write in this build.
 *
 * Partial rather than whole-record for the reason R9 records: a `PutItem` built
 * from anything less than a base-table read erases the attributes it never
 * loaded. That is true of an operator edit as much as of a dedup merge — two
 * operators editing different columns of the same source would otherwise
 * overwrite each other completely rather than not at all.
 */
export function updateAttributes(
  tableName: string,
  id: string,
  delta: Readonly<Record<string, unknown>>,
): UpdateCommand | undefined {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const assignments: string[] = [];

  Object.entries(delta).forEach(([attribute, value], index) => {
    if (value === undefined) return;
    names[`#p${index}`] = attribute;
    values[`:p${index}`] = value;
    assignments.push(`#p${index} = :p${index}`);
  });

  // An empty patch is a no-op, not an UpdateItem with an empty SET — which
  // DynamoDB rejects outright.
  if (assignments.length === 0) return undefined;

  return new UpdateCommand({
    TableName: tableName,
    Key: { id },
    UpdateExpression: `SET ${assignments.join(", ")}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  });
}

/**
 * §8.4 L751 — "Deletes are **soft**, matching the source."
 *
 * The row survives and R16's repository-level filter hides it from every read.
 * A hard delete would also destroy the `members` map, which §1.3 L49 makes
 * unrecoverable: nothing else records that those items were ever grouped.
 */
export const softDeleteCommand = (tableName: string, id: string): UpdateCommand =>
  new UpdateCommand({
    TableName: tableName,
    Key: { id },
    UpdateExpression: "SET #deleted = :deleted",
    ExpressionAttributeNames: { "#deleted": "deleted" },
    ExpressionAttributeValues: { ":deleted": true },
  });
