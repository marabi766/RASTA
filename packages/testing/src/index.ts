export {
  TEST_ORG_A,
  TEST_ORG_B,
  TEST_ORG_UNION,
  TEST_USER_A,
  TEST_USER_B,
  testContext,
  otherTenantContext,
  serviceContext,
  anonymousContext,
  idFactory,
  realId,
} from './context';
export type { TestRequestContext } from './context';

export {
  expectBalancedJournal,
  expectValidId,
  expectOrganizationAgnosticId,
  expectApiError,
  expectTenantIsolated,
} from './matchers';
export type { LedgerEntryLike, ApiErrorLike } from './matchers';

export {
  DML,
  INSUFFICIENT_PRIVILEGE,
  createAttempts,
  expectedTablePrivileges,
  liftAttempts,
  runtimeRoleFacts,
  schemaTriggers,
  tablePrivileges,
} from './runtime-role';
export type { RawSqlClient, RuntimeRoleFacts } from './runtime-role';

export {
  describeTenantScopeCoverage,
  tenantScopeProblems,
  MIN_REASON_LENGTH,
} from './tenant-scope';
export type { DmmfModelLike, TenantScopeInput } from './tenant-scope';

export { StubKafkaBroker, reserveFreePort } from './stub-kafka-broker';
export type { StubKafkaBrokerOptions } from './stub-kafka-broker';

export { publisherCloseProblems, runOutboxShutdownProvider } from './outbox-shutdown-wiring';
export type { ParticipantStop, ShutdownFactoryProvider } from './outbox-shutdown-wiring';

export { SAGA_DISPUTE_RECOVERY } from './saga-dispute-recovery';
export type { SagaDisputeRecoveryRow } from './saga-dispute-recovery';

export { expireClaim, makeDue } from './eligibility-clock';

export { withRedirectProbe, REDIRECT_CASES } from './redirect-probe';
export type { RedirectProbe } from './redirect-probe';

export {
  GENERATED_VALUE_SHAPES,
  absenceHazard,
  correlationId,
  errorEnvelope,
  expectNotDisclosed,
  generatedValuesIn,
  instant,
  oneOf,
  thisRun,
} from './disclosure';
export { absenceRefusal, guardedAbsenceMatchers } from './absence-guard';
export type { AbsenceMatcherResult } from './absence-guard';
export type {
  DisclosureOptions,
  GeneratedShape,
  GeneratedValue,
  MetadataExpectation,
  MetadataMatcher,
} from './disclosure';
