import { ulid } from 'ulid';

/**
 * Deterministic identifiers for tests.
 *
 * Seeded so a failing test reproduces exactly, and so demo data is stable
 * across `pnpm db:seed` runs — a dashboard screenshot that changes every reset
 * is useless for review.
 */

export const TEST_ORG_A = 'ORG_01JBQ8Z4K7M2N5P8R1T3V6X9YA';
export const TEST_ORG_B = 'ORG_01JBQ8Z4K7M2N5P8R1T3V6X9YB';
export const TEST_ORG_UNION = 'ORG_01JBQ8Z4K7M2N5P8R1T3V6X9YU';
export const TEST_USER_A = 'USR_01JBQ8Z4K7M2N5P8R1T3V6X9YA';
export const TEST_USER_B = 'USR_01JBQ8Z4K7M2N5P8R1T3V6X9YB';

/**
 * The shape @rasta/nest-common's RequestContext expects.
 *
 * Redeclared structurally rather than imported: @rasta/testing must be usable
 * from packages that do not depend on Nest, and duplicating six fields is
 * cheaper than the coupling.
 */
export interface TestRequestContext {
  correlationId: string;
  requestId: string;
  traceId?: string;
  spanId?: string;
  organizationId?: string;
  userId?: string;
  roles: readonly string[];
  authType: 'USER' | 'SERVICE' | 'ANONYMOUS';
  callerService?: string;
  ip?: string;
  userAgent?: string;
  method?: string;
  path?: string;
  startedAt: number;
}

export function testContext(overrides: Partial<TestRequestContext> = {}): TestRequestContext {
  return {
    correlationId: 'CORR_TEST_0000000000000000',
    requestId: 'REQ_TEST_00000000000000000',
    organizationId: TEST_ORG_A,
    userId: TEST_USER_A,
    roles: ['ORGANIZATION_ADMIN'],
    authType: 'USER',
    startedAt: 0,
    ...overrides,
  };
}

/** Context for the *other* tenant. The counterpart in every isolation test. */
export function otherTenantContext(
  overrides: Partial<TestRequestContext> = {},
): TestRequestContext {
  return testContext({
    organizationId: TEST_ORG_B,
    userId: TEST_USER_B,
    correlationId: 'CORR_TEST_OTHER_000000000',
    ...overrides,
  });
}

export function serviceContext(callerService: string): TestRequestContext {
  return testContext({
    authType: 'SERVICE',
    callerService,
    userId: undefined,
    roles: ['SERVICE'],
  });
}

export function anonymousContext(): TestRequestContext {
  return testContext({
    authType: 'ANONYMOUS',
    organizationId: undefined,
    userId: undefined,
    roles: [],
  });
}

/**
 * A counter-based id generator.
 *
 * Uses a fixed prefix and a padded counter so ids are readable in failure
 * output and stable between runs. Real ULIDs are only needed where sort order
 * by creation time matters.
 */
export function idFactory(prefix: string): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `${prefix}_${String(counter).padStart(26, '0')}`;
  };
}

/** A genuine ULID, for the few tests that depend on time-ordering. */
export function realId(prefix: string): string {
  return `${prefix}_${ulid()}`;
}
