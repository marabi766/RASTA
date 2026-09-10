import { apiErrorSchema, type ApiError } from '@rasta/contracts';

/**
 * The client half of the platform error model.
 *
 * Every service answers with the envelope in
 * `packages/contracts/src/common/errors.ts`, so this file parses that envelope
 * rather than inventing a second shape. Branching is on `code`, never on the
 * message (localized, may change) and never on the status alone (too coarse) —
 * the same rule the contract states for every client.
 */

/** Failures that never reached a service, so they have no platform code. */
export const CLIENT_ERROR_CODES = {
  /** `fetch` rejected: DNS, TLS, CORS, offline. */
  NETWORK_UNAVAILABLE: 'NETWORK_UNAVAILABLE',
  /** A 2xx body that did not match the contract this client was compiled against. */
  MALFORMED_RESPONSE: 'MALFORMED_RESPONSE',
  /** Refused before the request was sent, because no session exists. */
  NO_SESSION: 'NO_SESSION',
  /**
   * Refused before the request was sent, because the selected organization is
   * not in the authenticated user's membership set.
   *
   * This is a UX guard, not a security control — the gateway validates
   * `X-Organization-Id` against real memberships and answers `TENANT_MISMATCH`
   * regardless of what this client does (ADR-009 Compliance, docs/16 § 16.11).
   */
  TENANT_NOT_IN_MEMBERSHIPS: 'TENANT_NOT_IN_MEMBERSHIPS',
  /** A request was aimed somewhere other than the API Gateway. */
  NON_GATEWAY_TARGET: 'NON_GATEWAY_TARGET',
  /**
   * A write was attempted while the presentation fixture source was selected.
   *
   * Refused rather than faked. A read-only source that answered a `POST` with a
   * cheerful result would be teaching an audience that a mutation succeeded,
   * which is the single most damaging thing a demo can do.
   */
  FIXTURE_WRITE_REFUSED: 'FIXTURE_WRITE_REFUSED',
  /**
   * The presentation dataset has no record for this route.
   *
   * A gap in the demo, deliberately distinct from `NOT_FOUND`: the latter means
   * the service looked and there was nothing, and conflating the two would hide
   * an unfinished fixture behind a legitimate-looking empty state.
   */
  FIXTURE_MISSING: 'FIXTURE_MISSING',
} as const;

export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[keyof typeof CLIENT_ERROR_CODES];

/**
 * A failed API call, in the form the UI renders.
 *
 * `message` is Persian and safe to show. Nothing here carries a token, a
 * header value or an upstream stack — S-09 forbids sensitive data in an error
 * surface, and an investor demo is exactly where somebody screenshots one.
 */
export class ApiFailure extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly correlationId: string;
  readonly details: ApiError['details'];
  /** Whether trying the same request again could plausibly succeed. */
  readonly retryable: boolean;

  constructor(init: {
    code: string;
    status: number | null;
    correlationId: string;
    details?: ApiError['details'];
  }) {
    super(persianMessageFor(init.code, init.status));
    this.name = 'ApiFailure';
    this.code = init.code;
    this.status = init.status;
    this.correlationId = init.correlationId;
    this.details = init.details;
    this.retryable = RETRYABLE_CODES.has(init.code);
  }
}

const RETRYABLE_CODES = new Set<string>([
  'RATE_LIMIT_EXCEEDED',
  'UPSTREAM_UNAVAILABLE',
  'UPSTREAM_TIMEOUT',
  'INTERNAL_ERROR',
  CLIENT_ERROR_CODES.NETWORK_UNAVAILABLE,
]);

/**
 * Persian copy, keyed by platform error code.
 *
 * One entry per distinct meaning, not per status. `403 FORBIDDEN` and
 * `403 TENANT_MISMATCH` arrive with the same status and mean entirely
 * different things to the person reading the screen: one is «شما اجازه ندارید»,
 * the other is «این داده متعلق به سازمان دیگری است».
 */
const MESSAGES: Record<string, string> = {
  VALIDATION_FAILED: 'ورودی درخواست معتبر نیست. مقادیر واردشده را بررسی کنید.',
  MALFORMED_REQUEST: 'درخواست ناقص یا نادرست ساخته شده است.',

  UNAUTHENTICATED: 'برای مشاهدهٔ این بخش باید وارد شوید.',
  TOKEN_EXPIRED: 'نشست شما منقضی شده است. دوباره وارد شوید.',
  TOKEN_INVALID: 'نشست شما معتبر نیست. دوباره وارد شوید.',

  FORBIDDEN: 'نقش شما اجازهٔ دسترسی به این بخش را ندارد.',
  INSUFFICIENT_ROLE: 'این عملیات به نقش دیگری نیاز دارد.',
  TENANT_MISMATCH: 'این داده متعلق به سازمان دیگری است و از سازمان فعال شما قابل دسترسی نیست.',
  SERVICE_TENANT_CONTEXT_INVALID: 'زمینهٔ سازمانی این درخواست معتبر نیست.',

  NOT_FOUND: 'موردی با این مشخصات یافت نشد.',
  ALREADY_EXISTS: 'این مورد از پیش ثبت شده است.',
  CONFLICT: 'وضعیت فعلی با این درخواست سازگار نیست.',
  IDEMPOTENCY_KEY_REUSED: 'همین کلید پیش‌تر با محتوای دیگری استفاده شده است.',
  INVALID_STATE_TRANSITION: 'این تغییر وضعیت در مرحلهٔ فعلی مجاز نیست.',
  OPTIMISTIC_LOCK_FAILED: 'این مورد هم‌زمان توسط شخص دیگری تغییر کرده است. دوباره بارگذاری کنید.',

  BUSINESS_RULE_VIOLATION: 'درخواست درست ساخته شده اما یک قاعدهٔ کسب‌وکاری آن را نمی‌پذیرد.',
  INSUFFICIENT_BALANCE: 'موجودی قابل استفاده برای این عملیات کافی نیست.',
  LEDGER_UNBALANCED: 'ثبت مالی متوازن نیست و پذیرفته نشد.',

  RATE_LIMIT_EXCEEDED: 'تعداد درخواست‌ها از حد مجاز گذشت. کمی بعد دوباره تلاش کنید.',

  INTERNAL_ERROR: 'خطای داخلی سامانه. تیم پشتیبانی با شناسهٔ پیگیری می‌تواند آن را ردیابی کند.',
  UPSTREAM_UNAVAILABLE: 'سرویس مربوطه در حال حاضر در دسترس نیست. کمی بعد دوباره تلاش کنید.',
  UPSTREAM_TIMEOUT: 'پاسخ سرویس مربوطه در زمان مجاز نرسید.',
  NOT_IMPLEMENTED: 'این قابلیت هنوز پیاده‌سازی نشده است.',

  [CLIENT_ERROR_CODES.NETWORK_UNAVAILABLE]:
    'ارتباط با سامانه برقرار نشد. اتصال شبکه یا در دسترس بودن درگاه API را بررسی کنید.',
  [CLIENT_ERROR_CODES.MALFORMED_RESPONSE]:
    'پاسخ سرویس با قرارداد مورد انتظار این نسخه از رابط کاربری هم‌خوان نیست.',
  [CLIENT_ERROR_CODES.NO_SESSION]: 'برای مشاهدهٔ این بخش باید وارد شوید.',
  [CLIENT_ERROR_CODES.TENANT_NOT_IN_MEMBERSHIPS]:
    'سازمان انتخاب‌شده در فهرست عضویت‌های نشست شما نیست.',
  [CLIENT_ERROR_CODES.NON_GATEWAY_TARGET]:
    'این درخواست به مقصدی جز درگاه API هدف‌گیری شده بود و ارسال نشد.',
  [CLIENT_ERROR_CODES.FIXTURE_WRITE_REFUSED]:
    'حالت نمایشی فقط-خواندنی است و هیچ عملیات تغییردهنده‌ای انجام نمی‌دهد.',
  [CLIENT_ERROR_CODES.FIXTURE_MISSING]:
    'برای این بخش دادهٔ نمایشی تعریف نشده است. در حالت زنده این صفحه از سرویس واقعی خوانده می‌شود.',
};

const STATUS_FALLBACK: Record<number, string> = {
  400: 'درخواست نامعتبر است.',
  401: 'برای مشاهدهٔ این بخش باید وارد شوید.',
  403: 'دسترسی به این بخش برای شما مجاز نیست.',
  404: 'موردی با این مشخصات یافت نشد.',
  409: 'وضعیت فعلی با این درخواست سازگار نیست.',
  422: 'یک قاعدهٔ کسب‌وکاری این درخواست را نمی‌پذیرد.',
  429: 'تعداد درخواست‌ها از حد مجاز گذشت. کمی بعد دوباره تلاش کنید.',
  503: 'سرویس مربوطه در حال حاضر در دسترس نیست.',
};

export function persianMessageFor(code: string, status: number | null): string {
  return (
    MESSAGES[code] ??
    (status !== null ? STATUS_FALLBACK[status] : undefined) ??
    'خطای پیش‌بینی‌نشده‌ای رخ داد.'
  );
}

/**
 * Turns whatever a non-2xx response carried into an `ApiFailure`.
 *
 * A body that is not the platform envelope is not trusted to describe itself:
 * the status decides the code, and the message comes from this file. An
 * upstream that answers HTML on 503 must not be able to put its own text on a
 * Rasta screen.
 */
export function failureFromResponse(
  status: number,
  body: unknown,
  fallbackCorrelationId: string,
): ApiFailure {
  const parsed = apiErrorSchema.safeParse(body);

  if (parsed.success) {
    return new ApiFailure({
      code: parsed.data.code,
      status,
      correlationId: parsed.data.correlationId || fallbackCorrelationId,
      details: parsed.data.details,
    });
  }

  return new ApiFailure({
    code: CODE_BY_STATUS[status] ?? 'INTERNAL_ERROR',
    status,
    correlationId: fallbackCorrelationId,
  });
}

const CODE_BY_STATUS: Record<number, string> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  422: 'BUSINESS_RULE_VIOLATION',
  429: 'RATE_LIMIT_EXCEEDED',
  500: 'INTERNAL_ERROR',
  501: 'NOT_IMPLEMENTED',
  503: 'UPSTREAM_UNAVAILABLE',
  504: 'UPSTREAM_TIMEOUT',
};
