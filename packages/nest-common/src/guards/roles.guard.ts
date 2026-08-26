import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RastaError } from '../errors/rasta-error';
import { IS_PUBLIC_KEY, REQUIRED_ROLES_KEY } from '../decorators';
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
 */
@Injectable()
export class RolesGuard implements CanActivate {
  /** Bypasses every role requirement. Deliberately a single, greppable name. */
  static readonly SUPER_ROLE = 'SYSTEM_ADMIN';

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

    // No @Roles() means the endpoint is open to any authenticated caller.
    // Authentication itself is already enforced by AuthGuard.
    if (!required || required.length === 0) return true;

    const context = tryGetContext();
    if (!context) {
      throw RastaError.unauthenticated('No request context available for authorization');
    }

    if (context.authType === 'SERVICE') {
      // Service calls are authorized by AuthGuard against @AllowService, which
      // is a different and stricter question than user role membership.
      return true;
    }

    if (context.roles.includes(RolesGuard.SUPER_ROLE)) return true;

    const granted = required.some((role) => context.roles.includes(role));
    if (!granted) {
      throw RastaError.insufficientRole(required, context.roles);
    }

    return true;
  }
}
