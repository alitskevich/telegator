import { z } from "zod";

/**
 * §8.6 L855-861. One Cognito group per role, least privileged first.
 *
 * This module — not the CDK stack — is where the list lives. `tg-infra/lib/auth-stack.ts`
 * imports it to name the groups, so the Cognito group names and the dashboard's
 * role names are one array and a rename cannot deny access on one side while
 * granting it on the other. The dependency runs in this direction because the
 * reverse would pull `aws-cdk-lib` into the Next.js bundle to learn three strings.
 */
export const ROLE_GROUPS = ["viewer", "editor", "admin"] as const;

export const RoleSchema = z.enum(ROLE_GROUPS);

export type Role = z.infer<typeof RoleSchema>;
