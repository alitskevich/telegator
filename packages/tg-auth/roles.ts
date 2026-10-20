import { ROLE_GROUPS, type Role, RoleSchema } from "tg-enums/roles";

/** Whether an arbitrary Cognito group name is one of the three roles. */
export function isRole(value: unknown): value is Role {
  return RoleSchema.safeParse(value).success;
}

/**
 * The subset of a session that authorisation actually reads. `tg-auth/session.ts`
 * returns something wider; keeping the parameter structural means the role check
 * can be unit-tested without constructing a Cognito session, and means an action
 * cannot accidentally authorise against a token field instead of a group.
 */
export interface Principal {
  /** Raw `cognito:groups`. Arbitrary strings — anything unrecognised is ignored. */
  readonly roles: readonly string[];
  /** §8.6 L882. False for a user who has not been enabled, or has been disabled. */
  readonly enabled: boolean;
}

/** Position in `ROLE_GROUPS`, or `undefined` for a group name that is not a role. */
function rankOf(value: string): number | undefined {
  return isRole(value) ? ROLE_GROUPS.indexOf(value) : undefined;
}

/**
 * Whether `principal` holds at least `min`, per the cumulative grants of §8.6
 * L844-845 — `editor` is viewer "+", `admin` is editor "+" — so a check is a
 * floor and not an equality.
 *
 * Rejects, in order: an absent principal (§8.4 L820 re-checks server-side, and an
 * unauthenticated caller must answer `false` rather than throw); a disabled user
 * (§8.6 L882, "rejected at every action" — disabling is the revocation mechanism,
 * so it has to outrank group membership, because an operator disabling a
 * compromised admin does not also remove them from the `admin` group); and any
 * group name that is not one of the three, which carries no privilege rather than
 * sorting above `admin`.
 */
export function hasRole(principal: Principal | null | undefined, min: Role): boolean {
  if (!principal?.enabled) return false;

  const required = ROLE_GROUPS.indexOf(min);

  return principal.roles.some((role) => {
    const rank = rankOf(role);
    return rank !== undefined && rank >= required;
  });
}
