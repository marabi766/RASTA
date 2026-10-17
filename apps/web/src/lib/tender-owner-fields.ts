/**
 * The vocabulary of the owner's tender commands on `/tenders/[id]` (EXP-004;
 * construction-service CON-002, ADR-065, ADR-066, Q-84, Q-91) — client-safe,
 * so the forms and the server share one copy. Pinned to the service's source
 * by `server/tender-owner.contract.spec.ts`.
 */

/**
 * - `PUBLISH`: `POST /v1/tenders/{id}/publish` — opens the publication's
 *   approval request, or, once it is approved, publishes (the same command).
 * - `GRANT`/`REJECT`: `POST /v1/approvals/{id}/decision` on the request's step.
 * - `PROPOSE_OPENING`, `OPEN_BIDS`, `WITHDRAW_PROPOSAL`: the two-person opening.
 */
export const OWNER_COMMANDS = [
  'PUBLISH',
  'GRANT',
  'REJECT',
  'PROPOSE_OPENING',
  'OPEN_BIDS',
  'WITHDRAW_PROPOSAL',
] as const;
export type OwnerCommand = (typeof OWNER_COMMANDS)[number];

export function isOwnerCommand(value: unknown): value is OwnerCommand {
  return typeof value === 'string' && (OWNER_COMMANDS as readonly string[]).includes(value);
}

export const OWNER_COMMAND_LABELS: Readonly<Record<OwnerCommand, string>> = {
  PUBLISH: 'انتشار مناقصه',
  GRANT: 'موافقت با انتشار',
  REJECT: 'رد درخواست انتشار',
  PROPOSE_OPENING: 'پیشنهاد گشایش پیشنهادها',
  OPEN_BIDS: 'گشایش پیشنهادها (نفر دوم)',
  WITHDRAW_PROPOSAL: 'پس‌گرفتن پیشنهاد گشایش',
};

/** What each command does, said before it is sent. */
export const OWNER_COMMAND_CONSEQUENCES: Readonly<Record<OwnerCommand, string>> = {
  PUBLISH:
    'اگر موافقت با انتشار هنوز گرفته نشده باشد، درخواست موافقت برای همین نسخهٔ مناقصه ثبت می‌شود و مرجعی که سیاست نام برده آن را بررسی می‌کند — نه کسی که درخواست داده است. پس از موافقت، همین فرمان مناقصه را منتشر می‌کند و معیارها منجمد می‌شوند.',
  GRANT:
    'موافقت شما با انتشار همین نسخهٔ مناقصه ثبت می‌شود. کسی که درخواست انتشار را داده خودش آن را تأیید نمی‌کند.',
  REJECT:
    'درخواست انتشار رد می‌شود و دور موافقت پایان می‌یابد؛ برای انتشار باید دوباره درخواست داد. دلیل رد لازم است.',
  PROPOSE_OPENING:
    'گشایش دو نفره است: شما گشایش را پیشنهاد می‌دهید و نفر دومی که مجاز است آن را انجام می‌دهد. با پیشنهاد هیچ پیشنهادی خوانده یا گشوده نمی‌شود.',
  OPEN_BIDS:
    'پیشنهادی را که شخص دیگری داده تأیید می‌کنید و همهٔ پیشنهادهای مناقصه گشوده می‌شوند؛ مناقصه به «در حال ارزیابی» می‌رود. این کار بازگشت ندارد.',
  WITHDRAW_PROPOSAL:
    'پیشنهاد گشایشی که خودتان داده‌اید پس گرفته می‌شود تا شخص مجاز دیگری بتواند از نو پیشنهاد دهد.',
};

/** The confirmation after the redirect (`server/flash.ts`). */
export const OWNER_COMMAND_DONE = {
  PUBLISHED: 'مناقصه منتشر شد و معیارهای آن منجمد شدند.',
  REQUESTED: 'درخواست موافقت با انتشار ثبت شد و در انتظار مرجع است.',
  GRANT: 'موافقت شما ثبت شد.',
  REJECT: 'درخواست انتشار رد شد.',
  PROPOSE_OPENING: 'پیشنهاد گشایش ثبت شد؛ گشایش با تأیید نفر دوم انجام می‌شود.',
  OPEN_BIDS: 'پیشنهادها گشوده شدند و مناقصه در حال ارزیابی است.',
  WITHDRAW_PROPOSAL: 'پیشنهاد گشایش پس گرفته شد.',
} as const;
export type OwnerDone = keyof typeof OWNER_COMMAND_DONE;
export const OWNER_DONE = Object.keys(OWNER_COMMAND_DONE) as OwnerDone[];

/** `TENDER_REQUEST_STATUSES`. */
const REQUEST_STATUS_LABELS: Readonly<Record<string, string>> = {
  PENDING: 'در انتظار موافقت',
  APPROVED: 'موافقت‌شده، آمادهٔ اجرا',
  REJECTED: 'ردشده',
  STALE: 'کهنه‌شده (مناقصه پس از درخواست تغییر کرد)',
  CONSUMED: 'اجراشده',
};

export const requestStatusLabel = (status: string): string =>
  REQUEST_STATUS_LABELS[status] ?? status;

/** `APPROVAL_STATES`. */
const STEP_STATUS_LABELS: Readonly<Record<string, string>> = {
  QUEUED: 'در صف',
  PENDING: 'در انتظار تصمیم',
  GRANTED: 'موافقت',
  REJECTED: 'رد',
  SUPERSEDED: 'کنارگذاشته',
};

export const stepStatusLabel = (status: string): string => STEP_STATUS_LABELS[status] ?? status;

/** `statedReason` of a rejection: 8 to 500 characters. */
export const REJECT_REASON_MIN = 8;
export const REJECT_REASON_MAX = 500;
export const REASON_FIELD = 'reason';

/**
 * Every closed reason the owner's commands are refused for, by area, each with
 * the fixed sentence a person reads — never the service's English:
 * `PUBLICATION_REFUSALS` (a publication names every reason it fails),
 * `TENDER_APPROVAL_REFUSALS` (the gate) and `OPENING_REFUSALS`.
 */
export const PUBLICATION_REFUSAL_TEXT: Readonly<Record<string, string>> = {
  NATURE_REQUIRED: 'نوع مناقصه (مناقصه، استعلام، …) تعیین نشده است.',
  VISIBILITY_REQUIRED: 'دسترسی مناقصه (عمومی یا فقط دعوت‌شدگان) تعیین نشده است.',
  WINDOW_REQUIRED: 'بازهٔ پذیرش پیشنهاد تعیین نشده است.',
  WINDOW_TOO_SHORT: 'بازهٔ پذیرش پیشنهاد از کوتاه‌ترین بازهٔ پیکربندی‌شده کوتاه‌تر است.',
  WINDOW_ALREADY_CLOSED: 'پایان بازهٔ پذیرش پیشنهاد گذشته است و کسی نمی‌تواند پیشنهاد بدهد.',
  CRITERIA_REQUIRED: 'معیار ارزیابی‌ای برای مناقصه تعیین نشده است.',
  CRITERIA_WEIGHTS_INCOMPLETE: 'جمع وزن معیارهای ارزیابی دقیقاً ۱۰۰٪ نیست.',
  INVITATION_REQUIRED: 'مناقصهٔ «فقط دعوت‌شدگان» هنوز هیچ دعوت‌شده‌ای ندارد.',
  APPROVAL_POLICY_REQUIRED:
    'سیاست موافقتِ برقراری برای انتشار مناقصه‌های این سازمان نیست؛ سامانه بی موافقت منتشر نمی‌کند.',
};

export const APPROVAL_REFUSAL_TEXT: Readonly<Record<string, string>> = {
  APPROVAL_POLICY_REQUIRED:
    'سیاست موافقتِ برقراری برای این کار نیست؛ سامانه بی موافقت چیزی را اجرا نمی‌کند.',
  APPROVAL_STALE:
    'موافقت برای نسخهٔ دیگری از مناقصه گرفته شده بود و دیگر معتبر نیست؛ چیزی اجرا نشد. دوباره درخواست موافقت کنید.',
  CONFLICT_OF_INTEREST:
    'تعارض منافع: شما عضو سازمانی هستید که در این مناقصه پیشنهاد داده است؛ چیزی ثبت نشد.',
  APPROVER_IS_EVALUATOR: 'تفکیک وظایف: ارزیاب این مناقصه موافقت آن را بررسی نمی‌کند؛ چیزی ثبت نشد.',
  READ_ROLE_NOT_HELD: 'نقشی که خواندن این موافقت لازم دارد را اکنون ندارید.',
};

export const OPENING_REFUSAL_TEXT: Readonly<Record<string, string>> = {
  NOT_CLOSED:
    'مناقصه هنوز بسته نشده است؛ پیشنهادها فقط پس از بسته‌شدن مناقصه در پایان مهلت گشوده می‌شوند.',
  NOT_OPENED: 'پیشنهادها هنوز گشوده نشده‌اند و چیزی برای خواندن نیست.',
  EVIDENCE_UNAVAILABLE:
    'سرویس ممیزی، که رسیدهای پیشنهادها را نگه می‌دارد، در دسترس نبود؛ چیزی گشوده نشد. کمی بعد دوباره تلاش کنید.',
  EVIDENCE_BEHIND:
    'سرویس ممیزی هنوز همهٔ رسیدهای پیشنهادها را دریافت نکرده است؛ چیزی گشوده نشد. کمی بعد دوباره تلاش کنید.',
  INTEGRITY:
    'زنجیرهٔ رسیدها یا یکی از پیشنهادها با شواهد سرویس ممیزی نمی‌خواند؛ چیزی گشوده نشد و موضوع باید بررسی شود.',
  CONFLICT_OF_INTEREST:
    'تعارض منافع: شما عضو سازمانی هستید که در این مناقصه پیشنهاد داده است؛ پیشنهادها برای شما گشوده یا خوانده نمی‌شوند.',
  KEY_UNAVAILABLE: 'کلید گشایش این مناقصه در دسترس نبود؛ چیزی گشوده نشد.',
  PROPOSAL_REQUIRED:
    'گشایش دو نفره است و هنوز کسی آن را پیشنهاد نداده است؛ نخست شخص مجاز دیگری گشایش را پیشنهاد دهد.',
  SECOND_PERSON_REQUIRED:
    'تفکیک وظایف: گشایش را شخصی جز پیشنهاددهنده انجام می‌دهد؛ چیزی گشوده نشد.',
  NO_PROPOSAL: 'پیشنهاد گشایشی برای پس‌گرفتن نیست.',
  TENDER_OVER_LIMIT:
    'شمار پیشنهادهای این مناقصه از سقف پیکربندی‌شده بیشتر است؛ چیزی گشوده نشد و تصمیم با بهره‌بردار سامانه است.',
};

/** A refusal said by its platform code, when it names no closed reason. */
export const OWNER_CODE_TEXT: Readonly<Record<string, string>> = {
  OPTIMISTIC_LOCK_FAILED:
    'از وقتی این صفحه باز شد چیزی تغییر کرده است و چیزی ثبت نشد. صفحه را تازه کنید.',
  INVALID_STATE_TRANSITION:
    'این کار در وضعیت کنونی مناقصه ممکن نیست و چیزی ثبت نشد. صفحه را تازه کنید.',
  ACTOR_IDENTITY_UNKNOWN:
    'هویت پایدار شما یا شخص دیگرِ این کار ثبت نشده است و تفکیک وظایف قابل اثبات نیست؛ چیزی ثبت نشد.',
  VALIDATION_FAILED: 'بخشی از فرم پذیرفتنی نیست؛ چیزی ثبت نشد. فرم را بررسی کنید.',
  UPSTREAM_UNAVAILABLE:
    'سرویسی که این کار به آن نیاز دارد در دسترس نبود؛ چیزی ثبت نشد. کمی بعد دوباره تلاش کنید.',
};

/** For anything the tables above do not cover; the service's own sentence is never shown. */
export const OWNER_REFUSAL_FALLBACK =
  'این درخواست پذیرفته نشد و چیزی ثبت نشد. صفحه را تازه کنید و دوباره بررسی کنید.';

/**
 * A `403` the service gives without a closed reason, per command: the
 * separation-of-duties refusal of the requester approving their own request
 * (`assertDistinctActors`), a proposer withdrawing someone else's proposal,
 * or a role no longer held as identity-service says now.
 */
export const OWNER_FORBIDDEN_TEXT: Readonly<Record<OwnerCommand, string>> = {
  PUBLISH: 'انتشار این مناقصه در اختیار شما نیست.',
  GRANT:
    'این مرحله را شما نمی‌توانید بررسی کنید: یا درخواست انتشار را خودتان داده‌اید (تفکیک وظایف)، یا اکنون عضو سازمان مرجع با نقشِ نام‌برده نیستید.',
  REJECT: 'این مرحله را شما نمی‌توانید بررسی کنید: اکنون عضو سازمان مرجع با نقشِ نام‌برده نیستید.',
  PROPOSE_OPENING:
    'گشایش پیشنهادهای این مناقصه در اختیار شما نیست، یا اکنون نقش آن را ندارید، یا عضو سازمانی هستید که پیشنهاد داده است.',
  OPEN_BIDS:
    'گشایش پیشنهادهای این مناقصه در اختیار شما نیست، یا اکنون نقش آن را ندارید، یا خودتان یا پیشنهاددهندهٔ گشایش عضو سازمانی هستید که پیشنهاد داده است.',
  WITHDRAW_PROPOSAL: 'پیشنهاد گشایش را فقط کسی که آن را داده پس می‌گیرد.',
};
