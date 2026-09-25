import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RastaError } from '../errors/rasta-error';
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
 */
@Injectable()
export class RolesGuard implements CanActivate {
  /** Bypasses every role requirement. Deliberately a single, greppable name. */
  static readonly SUPER_ROLE = 'SYSTEM_ADMIN';

  /** Refused wherever it is not named. See the class comment. */
  static readonly OVERSIGHT_ROLE = 'AUDITOR';

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

    if (context.roles.includes(RolesGuard.OVERSIGHT_ROLE)) {
      const selfService = this.reflector.getAllAndOverride<{ allowed: boolean } | undefined>(
        AUDITOR_SELF_SERVICE_KEY,
        [execution.getHandler(), execution.getClass()],
      );
      const named = required?.includes(RolesGuard.OVERSIGHT_ROLE) ?? false;
      if (!named && selfService?.allowed !== true) {
        // A role refusal like any other, so every service's refusal capture
        // records it as one. `required` names the roles that would have been
        // admitted, and it is empty where the handler admits any role but this.
        throw RastaError.insufficientRole(required ?? [], context.roles);
      }
    }

    // No @Roles() means the endpoint is open to any authenticated caller.
    // Authentication itself is already enforced by AuthGuard.
    if (!required || required.length === 0) return true;

    if (context.roles.includes(RolesGuard.SUPER_ROLE)) return true;

    const granted = required.some((role) => context.roles.includes(role));
    if (!granted) {
      throw RastaError.insufficientRole(required, context.roles);
    }

    return true;
  }
}
