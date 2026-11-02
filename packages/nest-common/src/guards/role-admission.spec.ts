import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { runWithContext, type RequestContext } from '../context/request-context';
import { AUDITOR_SELF_SERVICE_KEY, REQUIRED_ROLES_KEY } from '../decorators';
import { RastaError } from '../errors/rasta-error';
import { OVERSIGHT_ROLE, SUPER_ROLE, assertRolesAdmitted } from './role-admission';
import { RolesGuard } from './roles.guard';

/**
 * The platform's one role predicate (task 130, PR #483 r1 R1).
 *
 * `RolesGuard` applies it to the token's roles; identity-service's live
 * authority applies it to the roles read from the database under the write's
 * locks. The finding it closes: the live check had a copy of the positive
 * rules only, so `AUDITOR` beside `ORGANIZATION_ADMIN` — refused by the guard
 * in a fresh token — was admitted live, through a token minted before the
 * auditor role was added.
 */

const refused = (held: string[], required?: string[], oversightSelfService?: boolean) => {
  try {
    assertRolesAdmitted(held, { required, oversightSelfService });
    return false;
  } catch (error) {
    expect(error).toBeInstanceOf(RastaError);
    expect((error as RastaError).code).toBe('INSUFFICIENT_ROLE');
    return true;
  }
};

describe('assertRolesAdmitted — the oversight denial comes before every grant', () => {
  const ADMIN = ['ORGANIZATION_ADMIN', 'UNION_ADMIN'];

  it.each([
    ['AUDITOR beside the required role', ['ORGANIZATION_ADMIN', OVERSIGHT_ROLE], ADMIN],
    ['AUDITOR beside SYSTEM_ADMIN', [SUPER_ROLE, OVERSIGHT_ROLE], ADMIN],
    ['AUDITOR alone, on a handler with no @Roles', [OVERSIGHT_ROLE], undefined],
    ['AUDITOR beside another role, on a handler with no @Roles', ['DRIVER', OVERSIGHT_ROLE], []],
  ])('refuses %s', (_label, held, required) => {
    expect(refused(held, required)).toBe(true);
  });

  it.each([
    ['the required role', ['ORGANIZATION_ADMIN'], ADMIN, false],
    ['SYSTEM_ADMIN', [SUPER_ROLE], ADMIN, false],
    ['any role, on a handler with no @Roles', ['DRIVER'], undefined, false],
    ['AUDITOR where the handler names it', [OVERSIGHT_ROLE, 'DRIVER'], [OVERSIGHT_ROLE], false],
    ['AUDITOR on @AuditorSelfService', [OVERSIGHT_ROLE, 'ORGANIZATION_ADMIN'], undefined, true],
  ])('admits %s', (_label, held, required, selfService) => {
    expect(refused(held, required, selfService)).toBe(false);
  });

  it('refuses a caller holding none of the required roles', () => {
    expect(refused(['DRIVER'], ADMIN)).toBe(true);
    expect(refused([], ADMIN)).toBe(true);
  });

  it('the refusal names the roles that would have been admitted, as the guard’s always did', () => {
    expect(() =>
      assertRolesAdmitted(['ORGANIZATION_ADMIN', OVERSIGHT_ROLE], { required: ADMIN }),
    ).toThrow(RastaError.insufficientRole(ADMIN, ['ORGANIZATION_ADMIN', OVERSIGHT_ROLE]).message);
  });
});

describe('RolesGuard decides exactly as the predicate, for every role set', () => {
  const ROLES = [SUPER_ROLE, OVERSIGHT_ROLE, 'ORGANIZATION_ADMIN', 'UNION_ADMIN', 'DRIVER'];
  const subsets = (items: string[]): string[][] =>
    items.reduce<string[][]>((sets, item) => [...sets, ...sets.map((set) => [...set, item])], [[]]);
  const handlers: Array<{ required?: string[]; selfService?: boolean }> = [
    {},
    { required: ['ORGANIZATION_ADMIN', 'UNION_ADMIN'] },
    { required: ['UNION_ADMIN'] },
    { required: [OVERSIGHT_ROLE] },
    { selfService: true },
    { required: ['ORGANIZATION_ADMIN'], selfService: true },
  ];

  const guardRefuses = (held: string[], handler: (typeof handlers)[number]) => {
    const reflector = {
      getAllAndOverride: (key: string) =>
        key === REQUIRED_ROLES_KEY
          ? handler.required
          : key === AUDITOR_SELF_SERVICE_KEY && handler.selfService
            ? { allowed: true }
            : undefined,
    } as unknown as Reflector;
    const execution = {
      getHandler: () => function handler() {},
      getClass: () => class Controller {},
    } as unknown as ExecutionContext;
    const context: RequestContext = {
      correlationId: 'COR_RA',
      requestId: 'REQ_RA',
      userId: 'USR_RA',
      organizationId: 'ORG_RA',
      roles: held,
      organizationIds: ['ORG_RA'],
      authType: 'USER',
      startedAt: 0,
    };
    return runWithContext(context, () => {
      try {
        new RolesGuard(reflector).canActivate(execution);
        return false;
      } catch {
        return true;
      }
    });
  };

  it('over all 32 role sets and six handler shapes', () => {
    for (const held of subsets(ROLES)) {
      for (const handler of handlers) {
        expect([held, handler, guardRefuses(held, handler)]).toEqual([
          held,
          handler,
          refused(held, handler.required, handler.selfService),
        ]);
      }
    }
  });
});
