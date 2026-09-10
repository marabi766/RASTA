import 'reflect-metadata';
import { PATH_METADATA, VERSION_METADATA } from '@nestjs/common/constants';
import { ALLOW_SERVICE_KEY, IS_PUBLIC_KEY, REQUIRED_ROLES_KEY } from '@rasta/nest-common';
import { AuditController } from './audit.controller';
import { AUDIT_READER_ROLES } from '../access/access';
import type { AuditQueryService } from './audit.query.service';
import type { AuditVerificationService } from './audit.verification.service';
import type { AuditVerifyQuery, AuditEventQuery, AuditEventDetailQuery } from './audit.query.dto';

/**
 * The HTTP surface itself, asserted from the metadata Nest actually reads.
 *
 * Two of these assertions are load-bearing in a way a reviewer cannot see by
 * reading the class:
 *
 *   **Route order.** Nest matches in declaration order, so a static path
 *   declared *after* a parameter of the same depth is unreachable. With
 *   `verify` below `:id`, every call to `/v1/audit-events/verify` becomes a
 *   lookup for a record whose id is the word "verify" and answers `404` — which
 *   looks like the endpoint failing rather than like a routing mistake, and no
 *   other test in this service would notice.
 *
 *   **The role list is a closed set of two.** ADR-053 § 10, and the gateway
 *   prefix pins the same two. AUD-003 adds an endpoint to this controller and
 *   must not widen the list to reach it.
 *
 * The whole controller is exercised against real route metadata rather than
 * through a booted application, so this stays a unit test; the same properties
 * are asserted end to end against the real guards in `test/authorization.int-spec.ts`.
 */

/** Method names in declaration order — the order Nest's scanner walks. */
const handlers = Object.getOwnPropertyNames(AuditController.prototype).filter(
  (name) => name !== 'constructor',
);

const pathOf = (handler: string): string =>
  Reflect.getMetadata(
    PATH_METADATA,
    (AuditController.prototype as unknown as Record<string, () => unknown>)[handler],
  ) as string;

describe('the audit read controller', () => {
  it('serves exactly three endpoints and no fourth', () => {
    // A fourth route here is either the write surface `docs/04` § 4.15 forbids,
    // an export AUD-002 does not build, or the correction endpoint ADR-053 § 7
    // routes through path B instead. Each should have to change this line.
    expect(handlers).toEqual(['search', 'verify', 'findOne']);
  });

  it('declares `verify` before the `:id` parameter, or it is unreachable', () => {
    expect(handlers.indexOf('verify')).toBeLessThan(handlers.indexOf('findOne'));
    expect(pathOf('verify')).toBe('verify');
    expect(pathOf('findOne')).toBe(':id');
  });

  it('mounts on the versioned audit-events prefix the gateway routes to', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AuditController)).toBe('audit-events');
    expect(Reflect.getMetadata(VERSION_METADATA, AuditController)).toBe('1');
  });

  it('is closed to every role but the two ADR-053 § 10 names', () => {
    const roles = Reflect.getMetadata(REQUIRED_ROLES_KEY, AuditController) as string[];

    expect(roles).toEqual([...AUDIT_READER_ROLES]);
    expect(roles).toEqual(['SYSTEM_ADMIN', 'UNION_ADMIN']);
    expect(roles).not.toContain('AUDITOR');
    expect(roles).not.toContain('ORGANIZATION_ADMIN');
  });

  it('carries the class-level role requirement onto every route, verify included', () => {
    // Nest resolves `@Roles` from the handler first and the class second, so a
    // route-level list would silently override the class one. There is none:
    // the closed-by-default surface is the same for all three.
    for (const handler of handlers) {
      const method = (AuditController.prototype as unknown as Record<string, () => unknown>)[
        handler
      ];
      expect(Reflect.getMetadata(REQUIRED_ROLES_KEY, method)).toBeUndefined();
    }
  });

  it('opens no route to a service token and none to an anonymous caller', () => {
    // `AuthGuard` refuses a service token on a route with no `@AllowService`,
    // and `assertNotServiceCaller()` refuses it again inside the services.
    for (const target of [
      AuditController,
      ...handlers.map(
        (handler) =>
          (AuditController.prototype as unknown as Record<string, () => unknown>)[handler],
      ),
    ]) {
      expect(Reflect.getMetadata(ALLOW_SERVICE_KEY, target as object)).toBeUndefined();
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, target as object)).toBeUndefined();
    }
  });

  it('publishes no write, correction or export route', () => {
    // `correction_of` stays inert until path B exists (AUD-004); recording one
    // through an HTTP route today would be the direct insert ADR-053 § 7 exists
    // to forbid.
    expect(handlers).not.toContain('create');
    expect(handlers).not.toContain('correct');
    expect(handlers).not.toContain('export');
  });
});

describe('what each route does with the parsed query', () => {
  const verification = {
    verify: jest.fn(async (_query: AuditVerifyQuery) => ({ status: 'VALID' })),
  } as unknown as AuditVerificationService;

  const queries = {
    search: jest.fn(async (_query: AuditEventQuery) => ({ items: [], nextCursor: null })),
    findOne: jest.fn(async (_id: string, _query: AuditEventDetailQuery) => ({ id: 'x' })),
  } as unknown as AuditQueryService;

  const controller = new AuditController(queries, verification);

  const window = {
    from: new Date('2026-08-01T00:00:00.000Z'),
    to: new Date('2026-08-31T00:00:00.000Z'),
  };

  it('hands the verification query straight to the verification service', () => {
    // A controller is HTTP↔DTO and nothing else (AGENTS.md A-10): the
    // authorization decision belongs where the chain is read, not here.
    const query = { ...window, scope: 'ORGANIZATION' } as AuditVerifyQuery;
    void controller.verify(query);

    expect(verification.verify).toHaveBeenCalledWith(query);
  });

  it('takes no authority from the request itself', () => {
    // Nothing in the signature reads a header, a role or an organization: the
    // scope comes from the verified token inside the service (ADR-053 § 10,
    // defect D-2).
    expect(controller.verify.length).toBe(1);
  });
});
