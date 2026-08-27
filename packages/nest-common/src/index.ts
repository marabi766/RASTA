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
  hasRole,
  hasAnyRole,
  toLogContext,
  createSystemContext,
} from './context/request-context';
export type { RequestContext, AuthType } from './context/request-context';

// Errors ---------------------------------------------------------------------
export { RastaError, isRastaError } from './errors/rasta-error';

// Decorators -----------------------------------------------------------------
export {
  Public,
  Roles,
  AllowService,
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
} from './decorators';

// Authentication -------------------------------------------------------------
export { TokenVerifier, InternalTokenService } from './auth/token-verifier';
export type {
  UserClaims,
  ServiceClaims,
  TokenVerifierOptions,
  InternalTokenPurpose,
} from './auth/token-verifier';

export { AuthGuard, AUTH_OPTIONS, resolveOrganization } from './guards/auth.guard';
export type { AuthGuardOptions, AuthState, AuthenticatedRequest } from './guards/auth.guard';

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

// Event consumption ----------------------------------------------------------
export { EventConsumer } from './consumer/event-consumer';
export type {
  EventConsumerOptions,
  EventHandler,
  HandlerOutcome,
  ConsumerLogger,
} from './consumer/event-consumer';

// Outbox ---------------------------------------------------------------------
export { buildOutboxRow, OutboxRelay } from './outbox/outbox';
export type {
  OutboxMessageInput,
  OutboxRow,
  OutboxStore,
  EventPublisher,
  OutboxRelayOptions,
  BuildOutboxOptions,
} from './outbox/outbox';
