/**
 * The vocabulary of a tender's evaluation and award on `/tenders/[id]`
 * (EXP-004; construction-service CON-002 PRs 9–11, ADR-067, Q-84, Q-88..Q-93)
 * — client-safe, so the forms and the server share one copy. Pinned to the
 * service's source by `server/tender-evaluation.contract.spec.ts`.
 */

/** `SCORE_SCALE`: a score crosses the API as the points × 100, an integer. */
export const SCORE_SCALE = 100;

/** `qualifyBidSchema`'s `reasonText`: trimmed, 1 to 2000 characters. */
export const DISQUALIFY_TEXT_MAX = 2000;

/** `MAX_JUSTIFICATION_LENGTH`: an award's justification, trimmed, 1 to 2000 characters. */
export const JUSTIFICATION_MAX = 2000;

export const REASON_CODE_FIELD = 'reasonCode';
export const REASON_TEXT_FIELD = 'reasonText';
export const JUSTIFICATION_FIELD = 'justification';

/** The field of one criterion's score in a scoring form. */
export const scoreField = (criterionCode: string): string => `score.${criterionCode}`;

/** `DISQUALIFICATION_REASONS` (provisional, Q-92), each in words. */
export const DISQUALIFICATION_REASON_LABELS: Readonly<Record<string, string>> = {
  NOT_ELIGIBLE: 'فاقد صلاحیت',
  NON_RESPONSIVE: 'پاسخ‌گو نبودن به الزامات مناقصه',
  INTEGRITY_VIOLATION: 'ناسازگاری محتوای پیشنهاد با تعهد ثبت‌شده',
  OTHER: 'دلیل دیگر',
};
export const DISQUALIFICATION_REASONS = Object.keys(DISQUALIFICATION_REASON_LABELS);

export const disqualificationLabel = (code: string): string =>
  DISQUALIFICATION_REASON_LABELS[code] ?? code;

/** `RECUSAL_REASONS` (provisional, Q-92) — shown, never sent: standing down is not in this slice. */
const RECUSAL_REASON_LABELS: Readonly<Record<string, string>> = {
  CONFLICT_OF_INTEREST: 'تعارض منافع',
  OTHER: 'دلیل دیگر',
};

export const recusalLabel = (code: string): string => RECUSAL_REASON_LABELS[code] ?? code;

/** `matrixViewSchema.readinessBlockedBy`: why the counted evaluators keep it from completing. */
export const READINESS_BLOCKED_TEXT: Readonly<Record<string, string>> = {
  SAME_PERSON_AS_EVALUATOR:
    'یک نفر بیش از یک بار ارزیاب یک پیشنهاد شمرده می‌شود، یا امتیاز پیشنهادی را که از آن کنار رفته نگه داشته است؛ ارزیابی کامل نمی‌شود. راه آن لغو مناقصه و ارزیابی دوباره است.',
  ACTOR_IDENTITY_UNKNOWN:
    'سوابق نمی‌توانند نشان دهند که ارزیاب‌های شمرده‌شده افراد جداگانه‌ای هستند؛ ارزیابی کامل نمی‌شود. راه آن لغو مناقصه و ارزیابی دوباره است.',
};

/**
 * Every closed reason an evaluation command or the matrix read is refused for
 * (`EVALUATION_REFUSALS`), in the fixed words a person reads.
 */
export const EVALUATION_REFUSAL_TEXT: Readonly<Record<string, string>> = {
  CONFLICT_OF_INTEREST:
    'تعارض منافع: شما عضو سازمانی هستید که در این مناقصه پیشنهاد داده است؛ ارزیابی پیشنهادها با شما نیست و چیزی ثبت نشد.',
  EVALUATOR_IS_TENDER_AUTHOR:
    'تفکیک وظایف: کسی که مناقصه را ساخته یا منتشر کرده، پیشنهادهای آن را ارزیابی نمی‌کند؛ چیزی ثبت نشد.',
  RECUSED:
    'شما از ارزیابی این پیشنهاد کنار رفته‌اید و دیگر دربارهٔ آن تصمیم نمی‌گیرید یا امتیاز نمی‌دهید؛ چیزی ثبت نشد.',
  SAME_PERSON_AS_EVALUATOR:
    'یک نفر یک ارزیاب است: شما با شناسهٔ کاربری دیگری ارزیاب همین پیشنهادید یا از آن کنار رفته‌اید؛ چیزی ثبت نشد.',
  NOT_OPENED: 'پیشنهادهای این مناقصه هنوز گشوده نشده‌اند و ارزیابی‌ای در کار نیست.',
  NOT_EVALUATING:
    'مناقصه در حال ارزیابی نیست: ارزیابی یا هنوز آغاز نشده یا پایان یافته و ماتریس منجمد است. چیزی ثبت نشد.',
  BID_NOT_OPENED:
    'دربارهٔ این پیشنهاد دیگر تصمیمی گرفته نمی‌شود: گشوده‌شده و بی‌تصمیم نیست. صفحه را تازه کنید.',
  BID_NOT_QUALIFIED:
    'این پیشنهاد واجد شرایط شناخته نشده است و فقط پیشنهاد واجد شرایط امتیاز می‌گیرد؛ چیزی ثبت نشد.',
  BID_ALREADY_DECIDED:
    'دربارهٔ این پیشنهاد پیش‌تر تصمیم دیگری گرفته شده و تصمیم بازگشت ندارد؛ چیزی ثبت نشد. صفحه را تازه کنید.',
  BID_NOT_EVALUABLE: 'این پیشنهاد در وضعیتی نیست که بتوان از ارزیابی آن کنار رفت؛ چیزی ثبت نشد.',
  BIDDER_NOT_ELIGIBLE:
    'به گفتهٔ سرویس تأمین‌کنندگان، پیشنهاددهنده اکنون واجد صلاحیت نیست، پس پیشنهاد واجد شرایط شناخته نشد. اگر لازم است، آن را فاقد شرایط اعلام کنید.',
  UNKNOWN_CRITERION:
    'یکی از معیارهای فرم از معیارهای این مناقصه نیست؛ چیزی ثبت نشد. صفحه را تازه کنید.',
  SCORE_OUT_OF_RANGE:
    'امتیازی بیرون از بازهٔ معیارش است (معیار قبول/رد فقط صفر یا بیشینه می‌پذیرد)؛ چیزی ثبت نشد.',
  EVALUATOR_LIMIT:
    'این پیشنهاد به سقف شمار ارزیاب‌ها رسیده است و ارزیاب تازه نمی‌پذیرد؛ چیزی ثبت نشد.',
  NO_QUALIFIED_BID:
    'هیچ پیشنهاد واجد شرایطی نیست، پس ارزیابی کامل نمی‌شود؛ این مناقصه فقط لغو می‌شود.',
  EVALUATION_INCOMPLETE:
    'ارزیابی هنوز کامل نیست: پیشنهادی بی‌تصمیم مانده، یا پیشنهاد واجد شرایطی به شمار لازم ارزیاب کامل ندارد. چیزی ثبت نشد.',
};

/** Every closed reason an award is refused for (`AWARD_REFUSALS`), in fixed words. */
export const AWARD_REFUSAL_TEXT: Readonly<Record<string, string>> = {
  CONFLICT_OF_INTEREST:
    'تعارض منافع: شما عضو سازمانی هستید که در این مناقصه پیشنهاد داده است؛ واگذاری با شما نیست و چیزی ثبت نشد.',
  AWARDER_IS_EVALUATOR:
    'تفکیک وظایف: کسی که در ارزیابی این مناقصه نقش داشته، آن را واگذار نمی‌کند؛ چیزی ثبت نشد.',
  ACTOR_IDENTITY_UNKNOWN:
    'سوابق نمی‌توانند نشان دهند که شما کسی جز ارزیاب‌های این مناقصه هستید (هویت پایدار ثبت نشده است)؛ چیزی ثبت نشد.',
  NOT_EVALUATED: 'ارزیابی این مناقصه کامل نشده است و فقط مناقصهٔ ارزیابی‌شده واگذار می‌شود.',
  BID_NOT_QUALIFIED: 'این پیشنهاد واجد شرایط نیست و مناقصه به آن واگذار نمی‌شود.',
  JUSTIFICATION_REQUIRED:
    'این پیشنهاد تنها رتبهٔ نخست ماتریس نیست (رتبهٔ دیگری دارد یا رتبه‌اش مشترک است)؛ انتخاب آن دلیل نوشته لازم دارد.',
  WINNER_NOT_ELIGIBLE:
    'به گفتهٔ سرویس تأمین‌کنندگان، این پیشنهاددهنده اکنون واجد صلاحیت نیست؛ چیزی واگذار نشد و مناقصه ارزیابی‌شده می‌ماند. می‌توانید پیشنهاد واجد شرایط دیگری را برگزینید.',
  ALREADY_AWARDED: 'این مناقصه پیش‌تر به پیشنهاد دیگری واگذار شده است.',
  APPROVAL_POLICY_REQUIRED:
    'سیاست موافقتِ برقراری برای واگذاری مناقصه‌های این سازمان نیست؛ سامانه بی موافقت واگذار نمی‌کند.',
};

/** `TENDER_REQUEST_STATUSES`, for the award's request. */
const AWARD_REQUEST_STATUS_LABELS: Readonly<Record<string, string>> = {
  PENDING: 'در انتظار موافقت',
  APPROVED: 'موافقت‌شده، آمادهٔ اجرا',
  REJECTED: 'ردشده',
  STALE: 'کهنه‌شده (انتخاب یا مناقصه پس از درخواست تغییر کرد)',
  CONSUMED: 'اجراشده',
};

export const awardRequestStatusLabel = (status: string): string =>
  AWARD_REQUEST_STATUS_LABELS[status] ?? status;

/** `TENDER_STATES` past the opening, as the evaluation section says them. */
export const EVALUATION_STAGE_TEXT: Readonly<Record<string, string>> = {
  EVALUATING: 'ارزیابی در جریان است.',
  EVALUATED: 'ارزیابی کامل شده و ماتریس منجمد است؛ مناقصه در انتظار واگذاری است.',
  AWARDED: 'مناقصه واگذار شده و ماتریس منجمد است.',
  CANCELLED: 'مناقصه لغو شده است.',
};
