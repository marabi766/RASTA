// ---------------------------------------------------------------------------
// @rasta/nest-common
//
// Shared NestJS building blocks. Cross-cutting mechanism only — request
// context, authentication, authorization plumbing, tenant scoping, error
// mapping, outbox. No business rules, ever (ADR-018).
// ---------------------------------------------------------------------------

// Request context ------------------------------------------------------------
export {
  runWithContext,
  upgradeContext,
  tryGetContext,
  getContext,
  getOrganizationId,
  isMemberOfOrganization,
  hasRole,
  hasAnyRole,
  toLogContext,
  createSystemContext,
} from './context/request-context';
export type { RequestContext, AuthType } from './context/request-context';

// Errors ---------------------------------------------------------------------
export {
  RastaError,
  isRastaError,
  RETRY_AFTER_MAX_SECONDS,
  RETRY_AFTER_MIN_SECONDS,
} from './errors/rasta-error';

// Decorators -----------------------------------------------------------------
export {
  Public,
  Roles,
  AllowService,
  AuditorSelfService,
  Idempotent,
  SkipTenantScope,
  Ctx,
  OrgId,
  CurrentUser,
  IS_PUBLIC_KEY,
  REQUIRED_ROLES_KEY,
  ALLOW_SERVICE_KEY,
  IDEMPOTENT_KEY,
  SKIP_TENANT_SCOPE_KEY,
  AUDITOR_SELF_SERVICE_KEY,
} from './decorators';

// Authentication -------------------------------------------------------------
export { TokenVerifier, InternalTokenService } from './auth/token-verifier';
export { internalGet } from './auth/internal-get';
export type { InternalGetOptions, InternalGetResult } from './auth/internal-get';
export type {
  UserClaims,
  ServiceClaims,
  TokenVerifierOptions,
  InternalTokenPurpose,
} from './auth/token-verifier';

export { AuthGuard, AUTH_OPTIONS, resolveOrganization } from './guards/auth.guard';
export {
  PLATFORM_ROLES,
  GLOBAL_ROLES,
  parseOrganizationRoles,
  rolesForRequest,
} from './auth/tenant-roles';
export type { PlatformRole, ParsedOrganizationRoles } from './auth/tenant-roles';
export type {
  AuthGuardOptions,
  AuthState,
  AuthenticatedRequest,
  MalformedOrganizationRoles,
  ServiceAuthorizationRefusal,
  UserTenantMismatch,
} from './guards/auth.guard';

export { RolesGuard } from './guards/roles.guard';

// Request pipeline -----------------------------------------------------------
export {
  RequestContextMiddleware,
  parseTraceparent,
  CORRELATION_ID_HEADER,
  REQUEST_ID_HEADER,
  TRACEPARENT_HEADER,
} from './middleware/request-context.middleware';

export {
  AllExceptionsFilter,
  EXCEPTION_FILTER_LOGGER,
  httpStatusToCode,
} from './filters/exception.filter';

export {
  ZodValidationPipe,
  zodPipe,
  toErrorDetails,
  formatPath,
} from './pipes/zod-validation.pipe';

// Tenancy --------------------------------------------------------------------
export {
  createTenantGuardExtension,
  runUnscoped,
  isUnscoped,
  currentUnscopedReason,
  injectTenantFilter,
  injectTenantOnCreate,
  assertTenantOwned,
} from './tenancy/tenant-guard.extension';
export type { TenantGuardOptions } from './tenancy/tenant-guard.extension';

// Kafka connection (RUN-006) ---------------------------------------------------
export {
  kafkaConnection,
  kafkaConnectionFor,
  kafkaClientConfig,
  KafkaConnectionConfigError,
} from './kafka/connection';
export type { KafkaConnectionOptions, KafkaConnectionEnv } from './kafka/connection';

// Event consumption ----------------------------------------------------------
export { EventConsumer, UnprocessableEventError } from './consumer/event-consumer';
export type {
  EventConsumerOptions,
  EventDelivery,
  EventHandler,
  HandlerOutcome,
  ConsumerLogger,
} from './consumer/event-consumer';
export { isRetryDelivery, originalDelivery } from './consumer/original-delivery';

// Outbox ---------------------------------------------------------------------
export {
  buildOutboxRow,
  OutboxRelay,
  renewalIntervalMs,
  renewalDeadlineMs,
  RENEWAL_INTERVAL_DIVISOR,
  RENEWAL_DEADLINE_CEILING_MS,
} from './outbox/outbox';
export type {
  OutboxMessageInput,
  OutboxRow,
  OutboxStore,
  EventPublisher,
  OutboxRelayOptions,
  BuildOutboxOptions,
  OutboxClaim,
  ClaimRequest,
  RetryBackoff,
} from './outbox/outbox';
export {
  claimPendingSql,
  markPublishedSql,
  markFailedSql,
  releaseSql,
  renewSql,
  oldestPendingAgeSecondsSql,
  activeLeaseCountSql,
  toOutboxRow,
  allocateStreamSeqSql,
  STREAM_SEQUENCE_TABLE,
} from './outbox/outbox-sql';
export type {
  OutboxSqlClient,
  RawOutboxRow,
  OutboxClaimResult,
  ClaimOptions,
  OutboxTxRunner,
} from './outbox/outbox-sql';
