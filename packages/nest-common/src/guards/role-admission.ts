import { RastaError } from '../errors/rasta-error';

/** Bypasses every role requirement. Deliberately a single, greppable name. */
export const SUPER_ROLE = 'SYSTEM_ADMIN';

/** Refused wherever it is not named. See {@link assertRolesAdmitted}. */
export const OVERSIGHT_ROLE = 'AUDITOR';

/** What a handler admits: its `@Roles`, and whether it carries `@AuditorSelfService`. */
export interface RoleAdmission {
  /** The roles admitted (`@Roles`). Empty or omitted admits any role but the oversight role. */
  readonly required?: readonly string[];
  /** `@AuditorSelfService`: the oversight role is admitted without being named. */
  readonly oversightSelfService?: boolean;
}

/**
 * The platform's one role predicate: refuses `held` unless `admission` admits
 * it, with the refusal `RolesGuard` has always given (`403 INSUFFICIENT_ROLE`).
 *
 * `RolesGuard` applies it to the token's roles. A decision made later on the
 * caller's **live** roles — identity-service's `liveAuthority`, under the
 * write's locks — applies this same function to the roles read from the
 * database, so a live decision can never admit a set of roles the guard would
 * refuse in a fresh token (task 130, PR #483 r1 R1). There is no second copy
 * to drift.
 *
 * In order — the denial first:
 *
 * 1. **The oversight role is refused unless the handler names it** or carries
 *    `@AuditorSelfService`, whatever else is held — `SYSTEM_ADMIN` included.
 *    `AUDITOR` has aggregate access only (`docs/09`); otherwise an auditor who
 *    was also, say, a fleet manager in the same organization would reach that
 *    organization's records through the other role, and the separation the
 *    oversight role exists for would depend on nobody ever being granted two
 *    roles. The same rule marketplace's `viewerParties` applies to an order.
 * 2. No required roles: admitted (authentication is the AuthGuard's).
 * 3. `SYSTEM_ADMIN`: admitted.
 * 4. Any one of the required roles: admitted. Otherwise refused.
 */
export function assertRolesAdmitted(held: readonly string[], admission: RoleAdmission): void {
  const required = admission.required ?? [];

  if (held.includes(OVERSIGHT_ROLE)) {
    const named = required.includes(OVERSIGHT_ROLE);
    if (!named && admission.oversightSelfService !== true) {
      // A role refusal like any other, so every service's refusal capture
      // records it as one. `required` names the roles that would have been
      // admitted, and it is empty where the handler admits any role but this.
      throw RastaError.insufficientRole(required, held);
    }
  }

  if (required.length === 0) return;
  if (held.includes(SUPER_ROLE)) return;
  if (!required.some((role) => held.includes(role))) {
    throw RastaError.insufficientRole(required, held);
  }
}
