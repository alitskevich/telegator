import {
  AdminGetUserCommand,
  type AdminGetUserCommandOutput,
} from "@aws-sdk/client-cognito-identity-provider";
import type { UserStatusReader } from "./ports.js";

/**
 * The production `UserStatusReader` (R34).
 *
 * §8.6 L788 — "a disabled user is rejected at every action" — needs a live
 * answer, and Cognito's is `AdminGetUser`. R24 withheld Cognito *administration*
 * from the dashboard role because §8.2–§8.4 define no user-management surface;
 * this is a read of one field, and it is required by a rule the spec states
 * normatively, so `infra/lib/app-stack.ts` grants `cognito-idp:AdminGetUser`
 * and nothing else from that service.
 */

/** The slice of `CognitoIdentityProviderClient` this uses; injected so tests build none. */
export interface AdminGetUserClient {
  send(command: AdminGetUserCommand): Promise<AdminGetUserCommandOutput>;
}

export interface UserStatusConfig {
  readonly userPoolId: string;
}

export function cognitoUserStatusReader(
  config: UserStatusConfig,
  client: AdminGetUserClient,
): UserStatusReader {
  return {
    async isEnabled(sub) {
      try {
        const user = await client.send(
          // The `sub` claim is a valid `Username` for a pool whose users are
          // created by an administrator, which §8.6 L788 requires them to be.
          new AdminGetUserCommand({ UserPoolId: config.userPoolId, Username: sub }),
        );
        return user.Enabled === true;
      } catch {
        /**
         * Every uncertain answer is "no". §8.6 L788 makes `enabled` the
         * revocation mechanism, so a deleted user, a throttled call or a
         * network fault must not read as enabled — an authorisation check that
         * opens under load is worse than one that closes under load, because
         * the failure is silent and the audit trail looks normal.
         */
        return false;
      }
    },
  };
}
