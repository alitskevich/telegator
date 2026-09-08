# target-table · Task 4: the `targets` table, its environment variable and its two grants

**Plan:** docs/.spectomat/plans/target-table.md **Spec:** docs/.spectomat/specs/target-table.md — #6, #8.1, #13 **Covers:** TT-17, TT-18 **Depends on:** none

## Goal

`cdk synth` emits a third DynamoDB table with no index, every pipeline function and the dashboard carry `TELEGATOR_TARGETS_TABLE`, and the two roles hold exactly the actions each one calls.

## Constraints

- The table is `config.name("targets")` — `telegator-{env}-targets` — partition key `id` (STRING), `BillingMode.PAY_PER_REQUEST`, `RemovalPolicy.RETAIN`, and **no** `addGlobalSecondaryIndex` call (D8). No PITR: the operator's templates are re-typeable and the durable record of a post is `messages`.
- `RETAIN` is what keeps an operator's templates through a stack replacement.
- `ENV_VARS` gains exactly one row: `targetsTable: "TELEGATOR_TARGETS_TABLE"`. The stacks import that map; both the pipeline stack's per-function environment and the app stack's environment set it.
- Publish is granted `dynamodb:GetItem` and `dynamodb:UpdateItem` on `targets` and nothing else — the same two it already holds on `messages`, so the function's total DynamoDB action set is unchanged and only the resource list grows.
- The app role is granted `dynamodb:GetItem`, `dynamodb:Scan`, `dynamodb:PutItem`, `dynamodb:UpdateItem` on `targets` — the same four it holds on `sources`, so the role's total action set is unchanged.
- Use `grantTableActions` from `./grants`, never `grantReadWriteData`: that helper also grants `DeleteItem` and `BatchWriteItem`, and no consumer in this build hard-deletes a row.
- No CDK context lookup (`fromLookup`, `valueFromLookup`) — `cdk synth` must stay credential-free.
- Code cites this spec as `target-table#<section>`, **never** with `§`. Criteria are `TT-n`, never `AC-x.y`. Do not add any new `§x.y Lnnn` citation; comments may name **R58**, the reconciliation Task 8 writes into `docs/telegator.md` §25 (wave 3 ruling: the spec's D12 said R56, which the repository owner's own §25 work already holds).
- Relative imports carry no extension. No `any`, no suppression. No test touches the network.
- Gates before commit: `npm run gates`, `npm run build`, `npx cdk synth`.

## Files

- Modify: `handlers/env.ts` (the `ENV_VARS` map), `handlers/env.test.ts` (its `toEqual`)
- Modify: `infra/lib/data-stack.ts`, `infra/lib/data-stack.test.ts`
- Modify: `infra/lib/pipeline-stack.ts` (the `environment` map and `grantLeastPrivilege`), `infra/lib/pipeline-stack.test.ts`
- Modify: `infra/lib/pipeline-events.test.ts`
- Modify: `infra/lib/app-stack.ts` (`environmentVariables` and `grantAppPermissions`), `infra/lib/app-stack.test.ts`

## Interfaces

- Consumes: `grantTableActions(table, grantee, ...actions)` from `infra/lib/grants.ts`; `config.name(resource)` from `infra/lib/config.ts`; `ENV_VARS` from `handlers/env.ts`.
- Produces:
  - `ENV_VARS.targetsTable === "TELEGATOR_TARGETS_TABLE"`
  - `TelegatorDataStack.targets: Table` — consumed by Task 6's handler wiring only through the environment variable, and by no other task's code.

## Steps

- [x] **Step 1: Write the failing test** — four edits.

  (a) `handlers/env.test.ts` — add one row to the `toEqual` object in "names every variable the stacks must supply", after `messagesTable`:

```ts
      targetsTable: "TELEGATOR_TARGETS_TABLE",
```

  (b) `infra/lib/data-stack.test.ts` — update the existing counts, then append the TT-17 block inside the top-level `describe("TelegatorDataStack", …)`:

  - `test("declares exactly the two tables §7.2 L629 names")`: `resourceCountIs("AWS::DynamoDB::Table", 2)` → `3`, and rename the test to `"declares the three tables: §7.2 L629's two, plus targets (R56)"`.
  - `test("names them with the §9.2 L896 environment prefix")`: add `expect(table(t, "telegator-prod-targets")).toBeDefined();`.
  - both `test.each([...])` arrays (`"%s bills per request"` and `"%s is keyed by id"`): add `"telegator-dev-targets"`.
  - `test("declares no resource beyond the two tables")`: both `2`s become `3`, and rename it to `"declares no resource beyond the three tables"`.

```ts
  describe("targets (target-table#2.2, R56)", () => {
    test("TT-17: is keyed by id, bills per request and is retained", () => {
      const properties = table(templateFor(), "telegator-dev-targets");

      expect(properties?.KeySchema).toEqual([{ AttributeName: "id", KeyType: "HASH" }]);
      expect(properties?.BillingMode).toBe("PAY_PER_REQUEST");
    });

    /** D1 — an operator's templates outlive the stack that created the table. */
    test("TT-17: is retained when the stack goes", () => {
      const retained = Object.values(templateFor().findResources("AWS::DynamoDB::Table")).find(
        (resource) => resource.Properties?.TableName === "telegator-dev-targets",
      );

      expect(retained?.DeletionPolicy).toBe("Retain");
    });

    /**
     * D8 — tens of rows, one access pattern by id and one full listing. A
     * projection is the one thing that cannot be changed in place later, so the
     * absence of an index is worth pinning rather than assuming.
     */
    test("TT-17: has no global secondary index", () => {
      expect(
        table(templateFor(), "telegator-dev-targets")?.GlobalSecondaryIndexes,
      ).toBeUndefined();
    });

    /** The templates are re-typeable; `messages` is the record that is not. */
    test("TT-17: needs no point-in-time recovery", () => {
      expect(
        table(templateFor(), "telegator-dev-targets")?.PointInTimeRecoverySpecification,
      ).toBeUndefined();
    });
  });
```

  (c) `infra/lib/pipeline-stack.test.ts` — append inside the top-level `describe`, beside the existing "supplies every environment variable" test:

```ts
  /** target-table#13 — every function carries it, so a stack that forgets is a grep away. */
  test("TT-18: every function carries the targets table name", () => {
    const template = stackFor().template;

    for (const fn of functions(template)) {
      const variables =
        (fn.Environment as { Variables?: Record<string, unknown> } | undefined)?.Variables ?? {};

      expect(variables.TELEGATOR_TARGETS_TABLE).toBeDefined();
    }
  });
```

  (d) `infra/lib/pipeline-events.test.ts` — append beside the existing "publish may read and update messages" test, inside the same `describe` (the one that defines `statementsByFunction`):

```ts
  /**
   * TT-18 — publish now reads two tables and updates two tables, with the same
   * two actions on each. The count is what says the targets grant exists at
   * all; the action set is what says it added no third verb.
   */
  test("TT-18: publish reaches both tables with GetItem and UpdateItem only", () => {
    const dynamo = (statementsByFunction(templateFor()).get("telegator-dev-publish") ?? []).filter(
      (statement) =>
        [statement.Action]
          .flat()
          .map(String)
          .some((action) => action.startsWith("dynamodb:")),
    );

    const actions = new Set(dynamo.flatMap((statement) => [statement.Action].flat().map(String)));
    expect(actions).toEqual(new Set(["dynamodb:GetItem", "dynamodb:UpdateItem"]));

    // One resource per table, and no index ARN: the targets table has no GSI.
    const resources = dynamo.flatMap((statement) => [statement.Resource].flat());
    expect(resources).toHaveLength(2);
    expect(JSON.stringify(resources)).not.toContain("/index/");
  });
```

  (e) `infra/lib/app-stack.test.ts` — append inside the `describe("the app role (§7.6 L712, R24)", …)` block:

```ts
    /**
     * TT-18 — the dashboard reads and writes three tables now. The action set
     * is unchanged, so only the statement count says the targets grant landed.
     */
    test("TT-18: holds a DynamoDB statement for each of the three tables", () => {
      const dynamo = policyStatements(templateFor()).filter((s) =>
        actionsOf(s).some((action) => action.startsWith("dynamodb:")),
      );

      expect(dynamo).toHaveLength(3);
    });
```

- [x] **Step 2: Run it, expect FAIL** — `npx vitest run handlers/env.test.ts infra/lib/data-stack.test.ts infra/lib/pipeline-stack.test.ts infra/lib/pipeline-events.test.ts infra/lib/app-stack.test.ts`, fails on the table count (`Expected 3 resources of type AWS::DynamoDB::Table but found 2`) and on `TELEGATOR_TARGETS_TABLE` being undefined.
- [x] **Step 3: Minimal implementation** — four edits.

  (a) `handlers/env.ts` — one row in `ENV_VARS`, after `messagesTable`:

```ts
  /** target-table#13 (R56) — the third table: the publish registry. */
  targetsTable: "TELEGATOR_TARGETS_TABLE",
```

  (b) `infra/lib/data-stack.ts` — declare the field beside the other two and build it after `messages`:

```ts
  /** target-table#2.2 (R56) — one row per publish destination. */
  public readonly targets: Table;
```

```ts
    /**
     * target-table#2.2 — the registry (R56).
     *
     * §7.2 L629's "two tables" becomes three: a target is not a source, and
     * §7.2's own reasoning holds — nothing is co-queried across them, so
     * single-table modelling would add ceremony with no payoff.
     *
     * No index (D8): tens of rows, one `GetItem` by id and one `Scan`. No PITR
     * either — an operator's template is re-typeable, and `messages` is the
     * record that is not. `RETAIN` all the same, so a stack replacement does
     * not take the templates with it.
     */
    this.targets = new Table(this, "TargetsTable", {
      tableName: config.name("targets"),
      partitionKey: { name: "id", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
    });
```

  (c) `infra/lib/pipeline-stack.ts` — one row in `environment`, after `messagesTable`:

```ts
      [ENV_VARS.targetsTable]: data.targets.tableName,
```

  and one grant in `grantLeastPrivilege`, immediately after the existing `grantTableActions(data.messages, publish, …)` line:

```ts
    /**
     * target-table#5.3 — publish reads the row before it assembles and mirrors
     * the two `lastPosted*` fields after it records. `GetItem` and `UpdateItem`,
     * the same two it holds on `messages`: the mirror write creates the row
     * when there is none, so no `PutItem` is needed (D5).
     */
    grantTableActions(data.targets, publish, "dynamodb:GetItem", "dynamodb:UpdateItem");
```

  (d) `infra/lib/app-stack.ts` — one row in `environmentVariables`, after `messagesTable`:

```ts
      [ENV_VARS.targetsTable, data.targets.tableName],
```

  and one grant in `grantAppPermissions`, after the existing `sources` grant:

```ts
    // target-table#3.2 — `/targets` lists (a Scan), creates (PutItem), edits
    // and soft-deletes (both UpdateItem). The same four the Sources page needs.
    grantTableActions(
      data.targets,
      this.appRole,
      "dynamodb:GetItem",
      "dynamodb:Scan",
      "dynamodb:PutItem",
      "dynamodb:UpdateItem",
    );
```

- [x] **Step 4: Run it, expect PASS** — same command; then the full gates: `npm run gates && npm run build && npx cdk synth` all exit 0. `npx cdk synth` is the one that proves the stack still assembles credential-free.
- [x] **Step 5: Commit** — message `feat(target-table): targets table, env var and grants (TT-17, TT-18)`; the controller stages this task's Files and commits — an implementer subagent never runs git

## Rulings

## Result

- Task 4 is **R58**, not the spec D12's **R56** — `docs/telegator.md:1576` already defines R56 as the tables' select-all toolbars and `:1577` defines R57 as the DLQ "Cleanup all", both the repository owner's own work, landed while this plan was being written. R58 is the table, R59 the per-target template; the five comments this task shipped were re-pointed in fix round 1, and the six references Tasks 1, 2, 3 and 5 already committed are swept by the new Task 9 — cost if wrong: two numbers in §25 and a comment sweep.
- Step 1(e)'s literal `expect(dynamo).toHaveLength(3)` is unreachable and was replaced — `@aws-cdk/aws-iam:minimizePolicies` is `true` in `cdk.json:49`, and the app role's `sources` and `targets` grants carry identical action sets, so IAM policy minimization merges them into one statement over two resources and the role synthesises **two** DynamoDB statements, not three. The replacement asserts the count of distinct table ARNs is 3 *and* pins the `targets` statement's own action set to the four the task requires — cost if wrong: none; the weaker form was caught in review and strengthened in fix round 1.
- Review round 1 Minor 5 (`data-stack.test.ts` "exposes both tables to the stacks that consume them" is stale for three tables) and Minor 6 (a test named "…and is retained" whose body asserts only `KeySchema` and `BillingMode`) are **parked**: the second is the task's own verbatim text, and both are naming, not coverage — retention is pinned by the very next test — cost if wrong: two test names a later reader has to look past.
- Review round 1 Minor 4 (`pipeline-events.test.ts`'s action-set assertion duplicates the pre-existing test at `:284`) is **parked**: the duplication is the task's prescribed text, and the two now differ — the pre-existing one pins the union, the new one pins each table — cost if wrong: one redundant assertion.
- Review round 2 Minor 1 (`toContain("MessagesTable"/"TargetsTable")` is subsumed by the per-table `toHaveLength(1)`) and Minor 2 (one `test` carries three separable claims) are **parked**: the redundancy buys a clearer first failure message, and step 1(d) prescribed the single test — cost if wrong: a coarser failure name.

## Result

**Commits:** `2fc87f6` (implementation) · `6274429` (fix round 1: R58 renumber, per-table action set on the app role) · `147143e` (fix round 2: per-table action set for publish). Range `197088a..147143e`, restricted to this task's nine Files.

**Covers:** TT-17 (four tests: key schema and billing, retention, no GSI, no PITR) and TT-18 (three tests: the env var on every pipeline function, publish's two actions per table, the app role's four on `targets`), plus one row in `handlers/env.test.ts` and three widened `test.each` arrays.

**Tests:** focused run 136 passed; full suite 1723 passed across 112 files.

**Gates:** `npm run gates` (tsc 0, 1723/1723, biome 268 clean), `npm run build` 0, `npx cdk synth` 0 — the numbers in the wave's log line are from the controller's own run after the fix rounds.

**Review:** round 1 spec ✅ quality ✅ with 2 Important (both fixed) and 4 Minor (parked); round 2 spec ✅ quality ✅ with 2 Minor (parked). Both fix rounds were verified by mutation — the reviewer's failure scenario was reproduced, the new assertion watched go red, and the implementation restored.
