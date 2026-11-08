import type { ReleaseOutcome } from '@/server/unresolved-request';

/** The hidden form field that names the held record a release was drawn for (a signed token); the one spelling. */
export const RELEASE_FIELD = 'release';
/** The query parameter a release redirect carries its signed outcome in (`server/release-feedback.ts` only). */
export const RELEASE_QUERY = 'release';

/** A release the action refused itself, before it asked the store: nothing was released. */
export type ReleaseRefusal = 'CSRF_REFUSED' | 'CONSENT_MISSING';

/** Everything a release page can say: the store's answer, the action's own refusal, or "not done". */
export type ReleaseFeedbackKey = ReleaseOutcome | ReleaseRefusal | 'NOT_DONE';

/**
 * Every screen that offers to let go of a held request. The name is also the namespace of the signed
 * feedback (`server/release-feedback.ts`): a token minted for one surface is read by no other.
 */
export type ReleaseSurface =
  | 'wallet'
  | 'asset-registration'
  | 'driver-creation'
  | 'project-creation'
  | 'demand-submission'
  | 'supplier-write'
  | 'supplier-record';

/**
 * What the person is told to look at before sending anything new, per surface (the wallet's money
 * screen says «تراکنش‌ها», not a generic list). `satisfies` makes a new surface a compile error until it
 * has its noun.
 */
const WHAT_TO_CHECK = {
  wallet: 'تراکنش‌ها',
  'asset-registration': 'فهرست دارایی‌ها',
  'driver-creation': 'فهرست رانندگان',
  'project-creation': 'فهرست پروژه‌ها',
  'demand-submission': 'فهرست نیازها',
  'supplier-write': 'فهرست تأمین‌کنندگان',
  'supplier-record': 'پرونده‌ی این تأمین‌کننده',
} as const satisfies Record<ReleaseSurface, string>;

export const RELEASE_SURFACES = Object.keys(WHAT_TO_CHECK) as ReleaseSurface[];

/**
 * The single source of the release results' wording. `satisfies` makes a new `ReleaseOutcome` a
 * compile error here until it has its own sentence; `what` is the surface's noun.
 */
export const RELEASE_TEMPLATES = {
  RELEASED: () => 'درخواست پیشین با تأیید شما رها شد. اکنون می‌توانید درخواست تازه ثبت کنید.',
  GONE: (what) => `درخواست پیشین دیگر در نگهداری نیست. پیش از درخواست تازه، ${what} را بررسی کنید.`,
  STALE: () => 'این فرم رهاسازی قدیمی یا نامعتبر است. درخواست فعلی را دوباره بررسی کنید.',
  IN_PROGRESS: (what) =>
    `درخواست هنوز در حال بررسی است و رها نشد. ${what} را بررسی کنید؛ پس از پایان اجرا، رها کردن به تأیید دوباره نیاز دارد.`,
  UNAVAILABLE: () =>
    'امکان رها کردن درخواست اکنون نیست. درخواست همچنان نگهداری می‌شود؛ بعداً دوباره بررسی کنید.',
  CSRF_REFUSED: () =>
    'اعتبار این فرم به پایان رسیده است و درخواست رها نشد. صفحه را دوباره باز کنید و دوباره تلاش کنید.',
  CONSENT_MISSING: () =>
    'درخواست رها نشد، زیرا تأیید بررسی علامت نخورده بود. پس از بررسی، گزینهٔ تأیید را علامت بزنید و دوباره تلاش کنید.',
  NOT_DONE: () => 'رها کردن درخواست انجام نشد. دوباره تلاش کنید.',
} as const satisfies Record<ReleaseFeedbackKey, (what: string) => string>;

/** An answer this build does not know is "not done", never a success. */
export function releaseFeedbackKey(outcome: unknown): ReleaseFeedbackKey {
  return typeof outcome === 'string' && Object.hasOwn(RELEASE_TEMPLATES, outcome)
    ? (outcome as ReleaseFeedbackKey)
    : 'NOT_DONE';
}

/** The sentence for `outcome` on `surface`; an unknown outcome reads as "not done". */
export function releaseMessage(outcome: unknown, surface: ReleaseSurface): string {
  return RELEASE_TEMPLATES[releaseFeedbackKey(outcome)](WHAT_TO_CHECK[surface]);
}
