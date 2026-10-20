import { z } from "zod";

/** Ordered: each role holds every grant of the ones before it. */
export const ROLES = ["viewer", "editor", "admin"] as const;

export const RoleSchema = z.enum(ROLES);

export type Role = z.infer<typeof RoleSchema>;

export interface Principal {
  readonly roles: readonly string[];
  readonly enabled: boolean;
}

/** True when the principal is enabled and holds `min` or a higher role. */
export function hasRole(principal: Principal | null | undefined, min: Role): boolean {
  if (!principal?.enabled) return false;
  const required = ROLES.indexOf(min);
  return principal.roles.some((role) => ROLES.indexOf(role as Role) >= required);
}
