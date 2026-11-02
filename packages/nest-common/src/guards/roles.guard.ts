import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RastaError } from '../errors/rasta-error';
import { OVERSIGHT_ROLE, SUPER_ROLE, assertRolesAdmitted } from './role-admission';
import { AUDITOR_SELF_SERVICE_KEY, IS_PUBLIC_KEY, REQUIRED_ROLES_KEY } from '../decorators';
import { tryGetContext } from '../context/request-context';

/**
 * Coarse, role-level authorization.
 *
 * This answers "may this kind of user do this kind of thing". It does **not**
 * answer "may they touch this particular record" — that is object-level
 * authorization and belongs in the service layer, where the record and its
 * owning organization are actually known.
 *
 * A handler protected only by this guard is protected against the wrong role,
 * not against a caller reaching into another tenant. Both checks are required;
 * neither substitutes for the other.
 *
 * ## The oversight role is refused unless a handler names it
 *
 * `AUDITOR` has aggregate access only (`docs/09`). A caller whose roles in
 * the resolved organization include it is refused on every handler that does
 * not list it in `@Roles` or carry `@AuditorSelfService`. That includes
 * handlers with no `@Roles`, which admit any other authenticated caller.
 * **Holding another role does not rescue it**, `SYSTEM_ADMIN` included — the
 * same rule marketplace's `viewerParties` applies to an order. Otherwise an
 * auditor who was also, say, a fleet manager in the same organization would
 * reach that organization's records through the other role, and the
 * separation the oversight role exists for would depend on nobody ever being
 * granted two roles.
 *
 * The rule itself is `assertRolesAdmitted` (`role-admission.ts`), the one
 * predicate every role decision applies — this guard to the token's roles, a
 * live decision to the database's.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  /** Bypasses every role requirement. Deliberately a single, greppable name. */
  static readonly SUPER_ROLE = SUPER_ROLE;

  /** Refused wherever it is not named. See the class comment. */
  static readonly OVERSIGHT_ROLE = OVERSIGHT_ROLE;

  constructor(private readonly reflector: Reflector) {}

  canActivate(execution: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<{ public: boolean } | undefined>(
      IS_PUBLIC_KEY,
      [execution.getHandler(), execution.getClass()],
    );
    if (isPublic?.public) return true;

    const required = this.reflector.getAllAndOverride<string[] | undefined>(REQUIRED_ROLES_KEY, [
      execution.getHandler(),
      execution.getClass(),
    ]);

    const context = tryGetContext();
    if (!context) {
      // No @Roles() and no context can only be a request AuthGuard did not
      // authenticate; there is nothing here to decide it on.
      if (!required || required.length === 0) return true;
      throw RastaError.unauthenticated('No request context available for authorization');
    }

    if (context.authType === 'SERVICE') {
      // Service calls are authorized by AuthGuard against @AllowService, which
      // is a different and stricter question than user role membership.
      return true;
    }

    // The platform's one role predicate, the oversight denial first
    // (`assertRolesAdmitted`). A live decision on the database's roles applies
    // the same function, so the two cannot disagree (task 130).
    assertRolesAdmitted(context.roles, {
      required,
      oversightSelfService:
        this.reflector.getAllAndOverride<{ allowed: boolean } | undefined>(
          AUDITOR_SELF_SERVICE_KEY,
          [execution.getHandler(), execution.getClass()],
        )?.allowed === true,
    });

    return true;
  }
}
