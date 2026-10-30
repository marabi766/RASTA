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
export type { LedgerUnbalancedReason } from './errors/rasta-error';
export { safeLogText } from './errors/safe-log-text';

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
  RequirePlatformUserId,
  REQUIRE_PLATFORM_USER_ID_KEY,
} from './decorators';

// Authentication -------------------------------------------------------------
export { TokenVerifier, InternalTokenService } from './auth/token-verifier';
export { internalGet } from './auth/internal-get';
export { RedirectRefusedError, internalFetch } from './http/internal-fetch';
export {
  currentActor,
  compareActors,
  sameActor,
  assertDistinctActors,
  actorIdentityUnknown,
  platformUserIdRequired,
} from './auth/separation-of-duties';
export type { ActorIdentity, ActorComparison } from './auth/separation-of-duties';
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
export {
  OVERSIGHT_ROLE,
  SUPER_ROLE,
  assertRolesAdmitted,
  type RoleAdmission,
} from './guards/role-admission';

// Request pipeline -----------------------------------------------------------
export {
  RequestContextMiddleware,
  parseTraceparent,
  requestPath,
  isWellFormedCorrelationId,
  isServiceCorrelationId,
  CORRELATION_ID_HEADER,
  CORRELATION_ID_MAX_LENGTH,
  REQUEST_ID_HEADER,
  TRACEPARENT_HEADER,
} from './middleware/request-context.middleware';

export {
  AllExceptionsFilter,
  EXCEPTION_FILTER_LOGGER,
  httpStatusToCode,
} from './filters/exception.filter';

export {
  NestLoggerAdapter,
  bootstrapLogger,
  installNestLogger,
  logFatal,
  scrubLogValue,
} from './logging/nest-logger';
export { kafkaLogCreator } from './kafka/log-creator';
export type { LoggerHost } from './logging/nest-logger';

export {
  ZodValidationPipe,
  zodPipe,
  toErrorDetails,
  validateRequestInput,
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
export { boundedDisconnect, kafkaShutdownDeadline } from './kafka/bounded-disconnect';
export type {
  BoundedDisconnectOptions,
  Disconnectable,
  DisconnectLogger,
  DisconnectOutcome,
} from './kafka/bounded-disconnect';
export {
  KafkaReadinessProbe,
  kafkaProbeTimeoutMs,
  KAFKA_PROBE_MAX_TIMEOUT_MS,
} from './kafka/readiness-probe';
export type {
  AdminFactory,
  KafkaReadinessProbeOptions,
  ProbeLogger,
} from './kafka/readiness-probe';

// Event consumption ----------------------------------------------------------
export {
  EventConsumer,
  ConsumerStoppingError,
  UnprocessableEventError,
  deadLetterHeaders,
  DeadLetterHeaderError,
  DLQ_ADDED_HEADERS_MAX_BYTES,
  utf8Prefix,
  HANDLER_MESSAGE_MAX,
  CONSUMER_SESSION_TIMEOUT_MS,
  DEFAULT_MAX_RETRIES,
  DEFAULT_BACKOFF_MS,
} from './consumer/event-consumer';
export type {
  DeadLetterDescription,
  EventConsumerOptions,
  EventDelivery,
  EventHandler,
  HandlerOutcome,
  ConsumerLogger,
} from './consumer/event-consumer';
export { isRetryDelivery, originalDelivery } from './consumer/original-delivery';
export {
  invalidPayloadError,
  missingTenantError,
  replicaOwnerMismatchError,
  requireEnvelopeTenant,
  tenantMismatchError,
} from './consumer/invalid-payload';

// Outbox ---------------------------------------------------------------------
export {
  buildOutboxRow,
  buildHeaders as envelopeHeaders,
  orderForPublish,
  OutboxRelay,
  OutboxReleaseAbandoned,
  releaseWithin,
  renewalIntervalMs,
  renewalDeadlineMs,
  RENEWAL_INTERVAL_DIVISOR,
  RENEWAL_DEADLINE_CEILING_MS,
  RENEWAL_TRANSACTION_MARGIN_MS,
  outboxRenewalOperationBudget,
  withinDeadline,
  buildRestoredOutboxRow,
} from './outbox/outbox';
// Provenance across a durable queue (PR #483 r3). `restoreOutboxProvenance` and
// `buildRestoredOutboxRow` are the registration intake's only: the restoration
// guard (scripts/outbox-provenance-restoration-guard.test.mjs) fails on any
// other file that names them.
export {
  captureOutboxProvenance,
  isOutboxProvenance,
  persistedOutboxProvenance,
  restoreOutboxProvenance,
} from './outbox/outbox-provenance';
export type {
  OutboxActor,
  OutboxProvenance,
  PersistedOutboxProvenance,
} from './outbox/outbox-provenance';
export type {
  OutboxMessageInput,
  RestoredOutboxMessageInput,
  OutboxRow,
  OutboxStore,
  EventPublisher,
  OutboxRelayOptions,
  OutboxStopOptions,
  OutboxReleaseBound,
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
  boundedReleaseSql,
  renewSql,
  oldestPendingAgeSecondsSql,
  activeLeaseCountSql,
  toOutboxRow,
  allocateStreamSeqSql,
  STREAM_SEQUENCE_TABLE,
  purgePublishedSql,
  MANUALLY_SKIPPED_PREFIX,
} from './outbox/outbox-sql';
export type {
  OutboxSqlClient,
  RawOutboxRow,
  OutboxClaimResult,
  ClaimOptions,
  OutboxTxRunner,
  OutboxPurgeTxRunner,
  PurgePublishedOptions,
  PurgePublishedBatch,
} from './outbox/outbox-sql';
export { OutboxPurgeScheduler, outboxPurgeSettings } from './outbox/outbox-purge';
export type {
  OutboxPurgeStore,
  OutboxPurgeSettings,
  OutboxPurgeLogger,
  OutboxPurgeSchedulerOptions,
  OutboxPurgeOutcome,
  OutboxPurgeRun,
} from './outbox/outbox-purge';
export { OutboxShutdown } from './outbox/outbox-shutdown';
export type { OutboxShutdownOptions, OutboxStoppable } from './outbox/outbox-shutdown';

// Lifecycle ------------------------------------------------------------------
export {
  installGracefulShutdown,
  DEFAULT_AFTER_CLOSE_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_SIGNALS,
} from './lifecycle/graceful-shutdown';
export type {
  GracefulShutdown,
  GracefulShutdownOptions,
  ShutdownLogger,
  ShutdownSignalSource,
  ShutdownTarget,
} from './lifecycle/graceful-shutdown';

export {
  CONNECTED_ROLE_SQL,
  RuntimeRoleRefusedError,
  RuntimeRoleUnverifiedError,
  assertDemoSeedRuntimeRole,
  assertRuntimeRole,
  connectedRoleProblems,
  preflightRuntimeRole,
} from './database/runtime-role';
export type {
  AssertRuntimeRoleOptions,
  ConnectedRoleFacts,
  RuntimeRolePreflightClient,
  RuntimeRoleQueryClient,
} from './database/runtime-role';

// OpenAPI --------------------------------------------------------------------
export {
  toJsonSchema,
  codePointLength,
  isOptionalField,
  objectShapeOf,
} from './openapi/zod-schema';
export type { JsonSchema } from './openapi/zod-schema';
export { publishedApiErrorSchema, publishedErrorDetailSchema } from './openapi/api-error';
// Conformance checks of a published document against the real error bodies; for tests.
export {
  errorEnvelopeProblems,
  httpErrorBodyProblems,
  publishedErrorResponses,
  publishedPathOf,
  publishedResponseSchemaOf,
  realFilterResponse,
  validatePublishedBody,
  PROBE_CONTEXTS,
  PROBE_TRACEPARENT,
} from './openapi/published-body';
export type {
  EnvelopeOptions,
  ProbeContext,
  PublishedDocument,
  PublishedErrorResponse,
  PublishedSchema,
} from './openapi/published-body';
