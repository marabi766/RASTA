/**
 * Whether the platform's `RolesGuard` (`packages/nest-common`,
 * `guards/roles.guard.ts`) would admit these roles to a route whose `@Roles`
 * names `required` — the one rule every write form's "may this person use it"
 * mirrors, so no screen offers a form the guard refuses or hides one it admits
 * (PR 325 review 1, finding 2). In the guard's own order:
 *
 * 1. **The oversight role is refused unless the route names it.** `AUDITOR` is
 *    refused whatever else the person holds, `SYSTEM_ADMIN` included — an
 *    auditor who is also a fleet manager does not get the fleet manager's
 *    forms. (`@AuditorSelfService` also admits it; no route a portal write form
 *    posts to carries it.)
 * 2. **The administrator is admitted to every route that names roles.**
 *    `SYSTEM_ADMIN` — scoped, or the global realm role `tokenRoles` adds —
 *    passes whatever `required` lists.
 * 3. Otherwise any one of the `required` roles.
 *
 * **Presentation only.** The service applies the guard again on every request,
 * and any object-level rule after it; this decides what to draw. The
 * guard's constants and order are pinned by `roles-guard.contract.spec.ts`.
 */

/** `RolesGuard.SUPER_ROLE`: bypasses every role requirement. */
export const SUPER_ROLE = 'SYSTEM_ADMIN';

/** `RolesGuard.OVERSIGHT_ROLE`: refused wherever it is not named. */
export const OVERSIGHT_ROLE = 'AUDITOR';

export function rolesGuardAdmits(roles: readonly string[], required: readonly string[]): boolean {
  if (roles.includes(OVERSIGHT_ROLE) && !required.includes(OVERSIGHT_ROLE)) return false;
  if (roles.includes(SUPER_ROLE)) return true;
  return required.some((role) => roles.includes(role));
}
