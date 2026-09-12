import { PATH_METADATA } from '@nestjs/common/constants';
import {
  ALLOW_SERVICE_KEY,
  REQUIRED_ROLES_KEY,
  RastaError,
  runWithContext,
  type RequestContext,
} from '@rasta/nest-common';
import { AuditInternalController } from './audit-internal.controller';
import { AuditTargetLookupService, auditTargetLookupQuerySchema } from './audit.lookup';
import type { AuditRepository } from './audit.repository';

/**
 * The internal correction-target lookup (AUD-003 correction): one caller, one exact
 * record, three fields, and a `404` that says nothing about why.
 */

const ID = '01JAUDIT0000000000000001';
const AT = new Date('2026-09-12T10:00:00.000Z');

const service = (overrides: Partial<RequestContext> = {}): RequestContext => ({
  correlationId: 'COR-LOOKUP',
  requestId: 'REQ-LOOKUP',
  organizationIds: [],
  roles: ['SERVICE'],
  authType: 'SERVICE',
  callerService: 'identity-service',
  startedAt: 0,
  ...overrides,
});

function lookupWith(row: { id: string; occurredAt: Date; organizationId: string | null } | null) {
  const findTarget = jest.fn(async () => row);
  const lookups = new AuditTargetLookupService({ findTarget } as unknown as AuditRepository);
  return { lookups, findTarget };
}

async function refusal(promise: Promise<unknown>): Promise<RastaError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(RastaError);
    return error as RastaError;
  }
  throw new Error('expected a refusal');
}

describe('AuditTargetLookupService', () => {
  it('answers identity-service with exactly the id, the organization and the instant', async () => {
    const { lookups, findTarget } = lookupWith({
      id: ID,
      occurredAt: AT,
      organizationId: 'ORG-DEH-0001',
    });

    const view = await runWithContext(service(), () => lookups.lookup(ID, AT));

    expect(view).toEqual({ id: ID, organizationId: 'ORG-DEH-0001', occurredAt: AT.toISOString() });
    expect(findTarget).toHaveBeenCalledWith(ID, AT);
  });

  it('names a platform-scoped record as null, not as a missing organization', async () => {
    const { lookups } = lookupWith({ id: ID, occurredAt: AT, organizationId: null });

    await expect(runWithContext(service(), () => lookups.lookup(ID, AT))).resolves.toMatchObject({
      organizationId: null,
    });
  });

  it.each<[string, Partial<RequestContext>]>([
    ['another service', { callerService: 'fleet-service' }],
    [
      'a SYSTEM_ADMIN user',
      { authType: 'USER', userId: 'USR-1', roles: ['SYSTEM_ADMIN'], callerService: undefined },
    ],
    [
      'a UNION_ADMIN user',
      { authType: 'USER', userId: 'USR-1', roles: ['UNION_ADMIN'], callerService: undefined },
    ],
    ['an anonymous caller', { authType: 'ANONYMOUS', roles: [], callerService: undefined }],
  ])('refuses %s before reading anything', async (_label, overrides) => {
    const { lookups, findTarget } = lookupWith({ id: ID, occurredAt: AT, organizationId: null });

    const error = await refusal(runWithContext(service(overrides), () => lookups.lookup(ID, AT)));

    expect(error.code).toBe('FORBIDDEN');
    expect(findTarget).not.toHaveBeenCalled();
  });

  it.each([
    ['no such record', null],
    [
      'a record at another instant',
      { id: ID, occurredAt: new Date(AT.getTime() + 1), organizationId: null },
    ],
    [
      'a record with another id',
      { id: '01JAUDIT0000000000000002', occurredAt: AT, organizationId: null },
    ],
  ])('answers %s with the same 404', async (_label, row) => {
    const { lookups } = lookupWith(row);

    const error = await refusal(runWithContext(service(), () => lookups.lookup(ID, AT)));

    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).not.toContain(ID);
  });
});

describe('auditTargetLookupQuerySchema', () => {
  it('requires the instant and refuses anything else', () => {
    expect(auditTargetLookupQuerySchema.safeParse({}).success).toBe(false);
    expect(auditTargetLookupQuerySchema.safeParse({ occurredAt: 'yesterday' }).success).toBe(false);
    expect(
      auditTargetLookupQuerySchema.safeParse({ occurredAt: AT.toISOString(), organizationId: 'x' })
        .success,
    ).toBe(false);
    expect(auditTargetLookupQuerySchema.parse({ occurredAt: AT.toISOString() }).occurredAt).toEqual(
      AT,
    );
  });
});

describe('AuditInternalController', () => {
  it('lives under /internal, which the gateway routes nowhere, and admits only identity-service', () => {
    expect(Reflect.getMetadata(PATH_METADATA, AuditInternalController)).toBe(
      'internal/audit-events',
    );
    const handler = AuditInternalController.prototype.lookup;
    expect(Reflect.getMetadata(ALLOW_SERVICE_KEY, handler)).toEqual(['identity-service']);
    // No role grants it: the service decides, and refuses every user.
    expect(Reflect.getMetadata(REQUIRED_ROLES_KEY, AuditInternalController)).toBeUndefined();
    expect(Reflect.getMetadata(REQUIRED_ROLES_KEY, handler)).toBeUndefined();
  });

  it('delegates the id and the parsed instant', async () => {
    const lookup = jest.fn(async () => ({
      id: ID,
      organizationId: null,
      occurredAt: AT.toISOString(),
    }));
    const controller = new AuditInternalController({
      lookup,
    } as unknown as AuditTargetLookupService);

    await controller.lookup(ID, { occurredAt: AT });

    expect(lookup).toHaveBeenCalledWith(ID, AT);
  });
});
