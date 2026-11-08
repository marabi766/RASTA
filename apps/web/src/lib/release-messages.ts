import type { ReleaseOutcome } from '@/server/unresolved-request';

/** A release the action refused itself, before it asked the store: nothing was released. */
export type ReleaseRefusal = 'CSRF_REFUSED' | 'CONSENT_MISSING';

/** Everything a release page can say: the store's answer, the action's own refusal, or "not done". */
export type ReleaseFeedbackKey = ReleaseOutcome | ReleaseRefusal | 'NOT_DONE';

/**
 * The single source of the release results' wording (wallet top-up, asset, driver). `satisfies` makes
 * a new `ReleaseOutcome` a compile error here until it has its own sentence.
 */
export const RELEASE_MESSAGES = {
  RELEASED: 'درخواست پیشین با تأیید شما رها شد. اکنون می‌توانید درخواست تازه ثبت کنید.',
  GONE: 'درخواست پیشین دیگر در نگهداری نیست. پیش از درخواست تازه، فهرست را بررسی کنید.',
  STALE: 'این فرم رهاسازی قدیمی یا نامعتبر است. درخواست فعلی را دوباره بررسی کنید.',
  IN_PROGRESS:
    'درخواست هنوز در حال بررسی است و رها نشد. وضعیت را بررسی کنید؛ پس از پایان اجرا، رها کردن به تأیید دوباره نیاز دارد.',
  UNAVAILABLE:
    'امکان رها کردن درخواست اکنون نیست. درخواست همچنان نگهداری می‌شود؛ بعداً دوباره بررسی کنید.',
  CSRF_REFUSED:
    'اعتبار این فرم به پایان رسیده است و درخواست رها نشد. صفحه را دوباره باز کنید و دوباره تلاش کنید.',
  CONSENT_MISSING:
    'درخواست رها نشد، زیرا تأیید بررسی علامت نخورده بود. پس از بررسی، گزینهٔ تأیید را علامت بزنید و دوباره تلاش کنید.',
  NOT_DONE: 'رها کردن درخواست انجام نشد. دوباره تلاش کنید.',
} as const satisfies Record<ReleaseFeedbackKey, string>;

/** An answer this build does not know is "not done", never a success. */
export function releaseFeedbackKey(outcome: unknown): ReleaseFeedbackKey {
  return typeof outcome === 'string' && Object.hasOwn(RELEASE_MESSAGES, outcome)
    ? (outcome as ReleaseFeedbackKey)
    : 'NOT_DONE';
}
