import { describe, expect, test } from "vitest";
import { hasRole, isRole, ROLE_GROUPS, RoleSchema } from "./roles";

const principal = (roles: readonly string[], enabled = true) => ({ roles, enabled });

describe("ROLE_GROUPS", () => {
  /**
   * §8.6 L780 — "one group per role", and the table at L782-786 lists exactly
   * three. This module is the single definition; `infra/lib/auth-stack.ts`
   * imports it to name the Cognito groups. The dependency runs this way and not
   * the other because the dashboard would otherwise pull `aws-cdk-lib` into its
   * bundle to learn three strings.
   */
  test("is the three §8.6 roles, least privileged first", () => {
    expect([...ROLE_GROUPS]).toEqual(["viewer", "editor", "admin"]);
  });

  test("parses a Cognito group name into a Role", () => {
    expect(RoleSchema.parse("admin")).toBe("admin");
    expect(RoleSchema.safeParse("root").success).toBe(false);
  });

  test("isRole narrows an unknown claim", () => {
    expect(isRole("editor")).toBe(true);
    expect(isRole("Editor")).toBe(false);
    expect(isRole(undefined)).toBe(false);
  });
});

describe("hasRole", () => {
  /**
   * §8.6 L784-785 — the grants are cumulative: `editor` is viewer "+", `admin`
   * is editor "+". So a check is a floor, not an equality.
   */
  test("an admin satisfies an editor check", () => {
    expect(hasRole(principal(["admin"]), "editor")).toBe(true);
  });

  test("an admin satisfies a viewer check", () => {
    expect(hasRole(principal(["admin"]), "viewer")).toBe(true);
  });

  test("an editor satisfies a viewer check", () => {
    expect(hasRole(principal(["editor"]), "viewer")).toBe(true);
  });

  test("a viewer does not satisfy an editor check", () => {
    expect(hasRole(principal(["viewer"]), "editor")).toBe(false);
  });

  test("an editor does not satisfy an admin check", () => {
    expect(hasRole(principal(["editor"]), "admin")).toBe(false);
  });

  test("every role satisfies its own check", () => {
    for (const role of ROLE_GROUPS) {
      expect(hasRole(principal([role]), role)).toBe(true);
    }
  });

  /**
   * A Cognito group list is arbitrary strings — anyone with pool administration
   * can create a group called `superadmin`. An unrecognised name must carry no
   * privilege at all rather than sorting above `admin`.
   */
  test("an unknown role never satisfies any check", () => {
    for (const role of ROLE_GROUPS) {
      expect(hasRole(principal(["superadmin"]), role)).toBe(false);
      expect(hasRole(principal(["Admin"]), role)).toBe(false);
      expect(hasRole(principal([""]), role)).toBe(false);
    }
  });

  test("the highest of several roles wins", () => {
    expect(hasRole(principal(["viewer", "admin"]), "admin")).toBe(true);
    expect(hasRole(principal(["superadmin", "viewer"]), "editor")).toBe(false);
  });

  test("no roles satisfies nothing", () => {
    expect(hasRole(principal([]), "viewer")).toBe(false);
  });

  /**
   * §8.6 L788 — "a new user is created **disabled** with no roles and must be
   * enabled manually; **a disabled user is rejected at every action**." Disabling
   * is the revocation mechanism, so it has to outrank group membership: an
   * operator who disables a compromised admin has not removed them from the
   * `admin` group, and expects the account to stop working regardless.
   */
  test("a disabled user is rejected however privileged", () => {
    for (const role of ROLE_GROUPS) {
      expect(hasRole(principal([...ROLE_GROUPS], false), role)).toBe(false);
    }
  });

  /**
   * §8.4 L757 — "every action ... re-checks the caller's role server-side". An
   * unauthenticated caller has no principal at all, and the check must answer
   * that question rather than throw, so a missing session cannot become a 500
   * that some error boundary swallows into a success.
   */
  test("an absent principal is rejected, not an error", () => {
    expect(hasRole(null, "viewer")).toBe(false);
    expect(hasRole(undefined, "viewer")).toBe(false);
  });
});
