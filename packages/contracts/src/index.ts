// ---------------------------------------------------------------------------
// @rasta/contracts
//
// Cross-service contracts only: identifiers, money, errors, pagination and the
// event envelope. Business logic never lives here — a rule enforced by review
// and stated in ADR-018. If two services would share a *decision*, they must
// duplicate it rather than couple through this package.
// ---------------------------------------------------------------------------

export {
  ID_PREFIXES,
  ULID_REGEX,
  prefixedIdSchema,
  seedIdSchema,
  organizationIdSchema,
  userIdSchema,
  assetIdSchema,
} from './common/identifiers';
export type { IdPrefix, OrganizationId, UserId, AssetId } from './common/identifiers';

export {
  CURRENCIES,
  currencySchema,
  amountMinorSchema,
  signedAmountMinorSchema,
  moneySchema,
  signedMoneySchema,
  money,
  toBigInt,
  addMoney,
  subtractMoney,
  applyBasisPoints,
} from './common/money';
export type { Currency, Money, SignedMoney } from './common/money';

export { ERROR_CODES, ERROR_STATUS, errorDetailSchema, apiErrorSchema } from './common/errors';
export type { ErrorCode, ErrorDetail, ApiError } from './common/errors';

export {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  cursorPaginationSchema,
  offsetPaginationSchema,
  sortDirectionSchema,
  sortSchema,
  emptyCursorPage,
} from './common/pagination';
export type {
  CursorPagination,
  OffsetPagination,
  SortDirection,
  CursorPage,
  OffsetPage,
} from './common/pagination';

export {
  actorTypeSchema,
  eventActorSchema,
  eventEnvelopeSchema,
  parseEnvelope,
  isEventName,
  topicFor,
  retryTopicFor,
  deadLetterTopicFor,
  AUDIT_TRAIL_TOPIC,
  EVENT_HEADERS,
  DLQ_HEADERS,
  DLQ_REASONS,
  NEVER_AUTO_REPLAY,
  isAutoReplayable,
} from './events/envelope';
export type { ActorType, EventActor, EventEnvelope, DlqReason } from './events/envelope';
