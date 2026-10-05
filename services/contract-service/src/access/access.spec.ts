import { isRastaError, runWithContext, type RequestContext } from '@rasta/nest-common';
import { loadContractEnv, type ContractEnv } from '../config/env';
import {
  ContractAccess,
  assertNotAuditor,
  assertNotServiceCaller,
  assertPartyOf,
  type ReadingParties,
} from './access';

/**
 * Authorization, written from the refused caller's side: who is refused and with which
 * code. The employer's readers come from configuration (Q-95), so each case builds the
 * access object from an environment rather than from a constant.
 */

const ORG = 'ORG-A';

function env(overrides: NodeJS.ProcessEnv = {}): ContractEnv {
  return loadContractEnv({
    KAFKA_BROKERS: 'localhost:9092',
    OIDC_ISSUER_URL: 'http://localhost:8080/realms/rasta',
    OIDC_JWKS_URI: 'http://localhost:8080/realms/rasta/protocol/openid-connect/certs',
    OIDC_AUDIENCE: 'rasta-api',
    INTERNAL_TOKEN_SECRET: 'a-throwaway-value-used-only-by-this-spec-32',
    DATABASE_URL: 'postgresql://u:p@localhost:5433/rasta_contract?schema=public',
    ...overrides,
  });
}

function context(overrides: Partial<RequestContext>): RequestContext {
  return {
    requestId: 'req-1',
    correlationId: 'corr-1',
    authType: 'USER',
    roles: [],
    startedAt: 0,
    organizationId: ORG,
    userId: 'USR_1',
    ...overrides,
  } as RequestContext;
}

function outcome(access: ContractAccess, overrides: Partial<RequestContext>) {
  return runWithContext(context(overrides), () => {
    try {
      return access.assertCanRead();
    } catch (error) {
      return isRastaError(error) ? error.code : `NOT_A_PLATFORM_ERROR: ${String(error)}`;
    }
  });
}

describe('with the default configuration', () => {
  const access = new ContractAccess(env());

  it('lets ORGANIZATION_ADMIN read as the employer of its own organization', () => {
    expect(outcome(access, { roles: ['ORGANIZATION_ADMIN'] })).toEqual({
      organizationId: ORG,
      employer: true,
      contractor: false,
    });
  });

  it('lets CONTRACTOR read as a contractor only', () => {
    expect(outcome(access, { roles: ['CONTRACTOR'] })).toEqual({
      organizationId: ORG,
      employer: false,
      contractor: true,
    });
  });

  it('lets a caller who is both read both sides', () => {
    expect(outcome(access, { roles: ['ORGANIZATION_ADMIN', 'CONTRACTOR'] })).toEqual({
      organizationId: ORG,
      employer: true,
      contractor: true,
    });
  });

  it('accepts SYSTEM_ADMIN on the employer side only, and never as a contractor', () => {
    expect(outcome(access, { roles: ['SYSTEM_ADMIN', 'CONTRACTOR'] })).toEqual({
      organizationId: ORG,
      employer: true,
      contractor: false,
    });
  });

  it.each([['DRIVER'], ['FLEET_MANAGER'], ['PROCUREMENT_USER'], ['SUPPLIER'], ['UNION_ADMIN']])(
    'refuses %s with INSUFFICIENT_ROLE (the default readers are not widened)',
    (role) => {
      expect(outcome(access, { roles: [role] })).toBe('INSUFFICIENT_ROLE');
    },
  );

  it('refuses a caller with no role at all', () => {
    expect(outcome(access, { roles: [] })).toBe('INSUFFICIENT_ROLE');
  });

  it('refuses AUDITOR, whatever else the token carries', () => {
    expect(outcome(access, { roles: ['AUDITOR'] })).toBe('FORBIDDEN');
    expect(outcome(access, { roles: ['AUDITOR', 'ORGANIZATION_ADMIN'] })).toBe('FORBIDDEN');
    expect(outcome(access, { roles: ['AUDITOR', 'CONTRACTOR'] })).toBe('FORBIDDEN');
  });

  it('refuses a service caller', () => {
    expect(outcome(access, { roles: ['ORGANIZATION_ADMIN'], authType: 'SERVICE' })).toBe(
      'FORBIDDEN',
    );
  });

  it('refuses a SYSTEM_ADMIN who selected no organization, with a reason', () => {
    expect(outcome(access, { roles: ['SYSTEM_ADMIN'], organizationId: undefined })).toBe(
      'FORBIDDEN',
    );
  });
});

describe('configuration decides who reads for the employer', () => {
  it('widens the readers to a configured role', () => {
    const access = new ContractAccess(
      env({ CONTRACT_READER_ROLES: 'ORGANIZATION_ADMIN,PROCUREMENT_USER' }),
    );
    expect(outcome(access, { roles: ['PROCUREMENT_USER'] })).toMatchObject({ employer: true });
  });

  it('narrows the readers: a role not configured is refused', () => {
    const access = new ContractAccess(env({ CONTRACT_READER_ROLES: 'PROCUREMENT_USER' }));
    expect(outcome(access, { roles: ['ORGANIZATION_ADMIN'] })).toBe('INSUFFICIENT_ROLE');
  });

  it('refuses to start with AUDITOR among the readers', () => {
    expect(() => env({ CONTRACT_READER_ROLES: 'ORGANIZATION_ADMIN,AUDITOR' })).toThrow();
  });

  it('refuses to start with an unknown role, or none', () => {
    expect(() => env({ CONTRACT_READER_ROLES: 'WIZARD' })).toThrow();
    expect(() => env({ CONTRACT_READER_ROLES: ' , ' })).toThrow();
  });

  it('still refuses AUDITOR if the guard is asked directly', () => {
    expect(() => runWithContext(context({ roles: ['AUDITOR'] }), assertNotAuditor)).toThrow();
    expect(() => runWithContext(context({ roles: ['DRIVER'] }), assertNotAuditor)).not.toThrow();
  });

  it('still refuses a service caller if the guard is asked directly', () => {
    expect(() =>
      runWithContext(context({ authType: 'SERVICE' }), assertNotServiceCaller),
    ).toThrow();
    expect(() => runWithContext(context({}), assertNotServiceCaller)).not.toThrow();
  });
});

describe('assertPartyOf: the row-level half', () => {
  const contract = { id: 'CTR_1', organizationId: 'ORG-A', contractorOrganizationId: 'ORG-B' };
  const parties = (overrides: Partial<ReadingParties>): ReadingParties => ({
    organizationId: 'ORG-A',
    employer: true,
    contractor: false,
    ...overrides,
  });

  it('passes the employer of the contract, and its winning contractor', () => {
    expect(() => assertPartyOf(contract, parties({}))).not.toThrow();
    expect(() =>
      assertPartyOf(
        contract,
        parties({ organizationId: 'ORG-B', employer: false, contractor: true }),
      ),
    ).not.toThrow();
  });

  it.each([
    ['another organization as employer', { organizationId: 'ORG-C' }],
    [
      'another organization as contractor',
      { organizationId: 'ORG-C', employer: false, contractor: true },
    ],
    [
      'the employer’s organization with only the contractor side',
      { employer: false, contractor: true },
    ],
    [
      'the contractor’s organization with only the employer side',
      { organizationId: 'ORG-B', employer: true, contractor: false },
    ],
    ['no side at all', { employer: false, contractor: false }],
  ])('answers 404 for %s', (_label, change) => {
    let code: string | undefined;
    try {
      assertPartyOf(contract, parties(change));
    } catch (error) {
      code = isRastaError(error) ? error.code : undefined;
    }
    expect(code).toBe('NOT_FOUND');
  });
});
