import { AWARD_REFUSAL_TEXT, EVALUATION_REFUSAL_TEXT } from './tender-evaluation-fields';

/**
 * The vocabulary of the owner's tender commands on `/tenders/[id]` (EXP-004;
 * construction-service CON-002, ADR-065, ADR-066, Q-84, Q-91) — client-safe,
 * so the forms and the server share one copy. Pinned to the service's source
 * by `server/tender-owner.contract.spec.ts`.
 */

/**
 * - `PUBLISH`: `POST /v1/tenders/{id}/publish` — opens the publication's
 *   approval request, or, once it is approved, publishes (the same command).
 * - `GRANT`/`REJECT`: `POST /v1/approvals/{id}/decision` on the publication
 *   request's step.
 * - `PROPOSE_OPENING`, `OPEN_BIDS`, `WITHDRAW_PROPOSAL`: the two-person opening.
 * - `QUALIFY`/`DISQUALIFY`: `POST …/bids/{bidId}/qualification`, one decision
 *   per opened bid.
 * - `SCORE`: `POST …/bids/{bidId}/scores`, the caller's scores for a qualified bid.
 * - `EVALUATE`: `POST …/evaluate`, completing the evaluation.
 * - `AWARD`: `POST …/award` — opens the award's approval request, or, once it
 *   is approved, awards (the same command).
 * - `GRANT_AWARD`/`REJECT_AWARD`: `POST /v1/approvals/{id}/decision` on the
 *   award request's step.
 */
export const OWNER_COMMANDS = [
  'PUBLISH',
  'GRANT',
  'REJECT',
  'PROPOSE_OPENING',
  'OPEN_BIDS',
  'WITHDRAW_PROPOSAL',
  'QUALIFY',
  'DISQUALIFY',
  'SCORE',
  'EVALUATE',
  'AWARD',
  'GRANT_AWARD',
  'REJECT_AWARD',
] as const;
export type OwnerCommand = (typeof OWNER_COMMANDS)[number];

export function isOwnerCommand(value: unknown): value is OwnerCommand {
  return typeof value === 'string' && (OWNER_COMMANDS as readonly string[]).includes(value);
}

/**
 * The commands construction-service answers again, with the first answer, to
 * the same `Idempotency-Key` and body (`IdempotencyStore.run`, task 060 /
 * PR 350): a re-send after a lost answer is the same request, not a new one.
 * The service judges the tender's state inside the work, binds the request to
 * its caller, and answers a different body under the key `409
 * IDEMPOTENCY_KEY_REUSED`:
 *
 * - **publish** and **award** — a retry gets the first answer, a 202 of a
 *   round rejected since included; it never opens a new round;
 * - **propose / open / withdraw the proposal** — each keeps its answer; a
 *   withdrawal also names the proposal it takes back (`proposedAt`).
 *
 * A score has been kept under its key from the start.
 */
export const KEYED_REPLAY_OWNER_COMMANDS: readonly OwnerCommand[] = [
  'PUBLISH',
  'PROPOSE_OPENING',
  'OPEN_BIDS',
  'WITHDRAW_PROPOSAL',
  'AWARD',
];

/**
 * The commands that may be sent again after a lost answer, in the same page,
 * under the same key with the body the stamp binds.
 */
export const REPEATABLE_OWNER_COMMANDS: readonly OwnerCommand[] = [
  ...KEYED_REPLAY_OWNER_COMMANDS,
  'SCORE',
];

/**
 * The commands a lost answer is never sent again for: the rest — **every
 * command construction-service keeps no result for**, whose re-send is a new
 * request against the tender as it is when it arrives:
 *
 * - **a decision on a step** (publication's or award's, `POST
 *   /approvals/:id/decision`) — decides the step as it stands when it arrives;
 * - **a decision on a bid** — the recorded decision answers its repeat, but
 *   that answer cannot tell the first send from somebody else's;
 * - **completing the evaluation** — freezes the matrix as it stands when it
 *   arrives, a change made since the first send included.
 */
export const UNREPEATABLE_OWNER_COMMANDS: readonly OwnerCommand[] = OWNER_COMMANDS.filter(
  (command) => !REPEATABLE_OWNER_COMMANDS.includes(command),
);

/** The decisions on an approval step: the publication's and the award's. */
export const DECISION_COMMANDS: readonly OwnerCommand[] = [
  'GRANT',
  'REJECT',
  'GRANT_AWARD',
  'REJECT_AWARD',
];

/** The decisions that name a reason. */
export const REJECTION_COMMANDS: readonly OwnerCommand[] = ['REJECT', 'REJECT_AWARD'];

/** The evaluators' commands. */
export const EVALUATION_COMMANDS: readonly OwnerCommand[] = [
  'QUALIFY',
  'DISQUALIFY',
  'SCORE',
  'EVALUATE',
];

export const OWNER_COMMAND_LABELS: Readonly<Record<OwnerCommand, string>> = {
  PUBLISH: 'انتشار مناقصه',
  GRANT: 'موافقت با انتشار',
  REJECT: 'رد درخواست انتشار',
  PROPOSE_OPENING: 'پیشنهاد گشایش پیشنهادها',
  OPEN_BIDS: 'گشایش پیشنهادها (نفر دوم)',
  WITHDRAW_PROPOSAL: 'پس‌گرفتن پیشنهاد گشایش',
  QUALIFY: 'اعلام واجد شرایط بودن',
  DISQUALIFY: 'اعلام فاقد شرایط بودن',
  SCORE: 'ثبت امتیاز',
  EVALUATE: 'تکمیل ارزیابی',
  AWARD: 'درخواست واگذاری',
  GRANT_AWARD: 'موافقت با واگذاری',
  REJECT_AWARD: 'رد درخواست واگذاری',
};

/** What each command does, said before it is sent. */
export const OWNER_COMMAND_CONSEQUENCES: Readonly<Record<OwnerCommand, string>> = {
  PUBLISH:
    'اگر موافقت با انتشار هنوز گرفته نشده باشد، درخواست موافقت برای همین نسخهٔ مناقصه ثبت می‌شود و مرجعی که سیاست نام برده آن را بررسی می‌کند؛ کسی که درخواست داده با آن موافقت نمی‌کند. پس از موافقت، همین فرمان مناقصه را منتشر می‌کند و معیارها منجمد می‌شوند.',
  GRANT:
    'موافقت شما با انتشار همین نسخهٔ مناقصه ثبت می‌شود. کسی که درخواست انتشار را داده خودش آن را تأیید نمی‌کند.',
  REJECT:
    'درخواست انتشار رد می‌شود و دور موافقت پایان می‌یابد؛ برای انتشار باید دوباره درخواست داد. دلیل رد لازم است. ردکردن، برخلاف موافقت، از کسی که درخواست داده هم پذیرفته می‌شود.',
  PROPOSE_OPENING:
    'گشایش دو نفره است: شما گشایش را پیشنهاد می‌دهید و نفر دومی که مجاز است آن را انجام می‌دهد. با پیشنهاد هیچ پیشنهادی خوانده یا گشوده نمی‌شود.',
  OPEN_BIDS:
    'پیشنهادی را که شخص دیگری داده تأیید می‌کنید و همهٔ پیشنهادهای مناقصه گشوده می‌شوند؛ مناقصه به «در حال ارزیابی» می‌رود. این کار بازگشت ندارد.',
  WITHDRAW_PROPOSAL:
    'پیشنهاد گشایشی که خودتان داده‌اید پس گرفته می‌شود تا شخص مجاز دیگری بتواند از نو پیشنهاد دهد.',
  QUALIFY:
    'دربارهٔ هر پیشنهاد یک بار تصمیم گرفته می‌شود و تصمیم بازگشت ندارد. پیش از ثبت، صلاحیت کنونی پیشنهاددهنده از سرویس تأمین‌کنندگان پرسیده می‌شود و اگر واجد صلاحیت نباشد، پذیرفته نمی‌شود.',
  DISQUALIFY:
    'دربارهٔ هر پیشنهاد یک بار تصمیم گرفته می‌شود و تصمیم بازگشت ندارد. یکی از دلیل‌های بسته و شرح آن لازم است؛ شرح در سامانه نگه داشته می‌شود و به پیشنهاددهنده نشان داده نمی‌شود.',
  SCORE:
    'امتیاز شما برای هر معیار ثبت می‌شود؛ تغییر بعدی نسخهٔ تازه‌ای می‌افزاید و نسخه‌های پیشین می‌مانند. اگر از وقتی این صفحه باز شد امتیاز شما برای یکی از این معیارها تغییر کرده باشد، هیچ‌کدام ثبت نمی‌شود.',
  EVALUATE:
    'ارزیابی پایان می‌یابد و ماتریس امتیازها منجمد می‌شود؛ پس از آن هیچ تصمیم یا امتیازی تغییر نمی‌کند. رتبهٔ نخست برنده نیست: شخصی برنده را برمی‌گزیند.',
  AWARD:
    'سامانه رتبه‌بندی می‌کند و انتخاب نمی‌کند: پیشنهاد برنده را شما برمی‌گزینید. اگر موافقت با واگذاری هنوز گرفته نشده باشد، درخواست موافقت برای همین انتخاب ثبت می‌شود و انتخاب دیگری، درخواستِ در انتظار را پایان می‌دهد. پس از موافقت، همین فرمان واگذار می‌کند؛ پیش از آن صلاحیت کنونی برنده دوباره پرسیده می‌شود.',
  GRANT_AWARD:
    'موافقت شما با واگذاری به پیشنهادی که درخواست نام برده ثبت می‌شود. کسی که درخواست واگذاری را داده، خودش آن را تأیید نمی‌کند.',
  REJECT_AWARD:
    'درخواست واگذاری رد می‌شود و دور موافقت پایان می‌یابد؛ برای واگذاری باید دوباره درخواست داد. دلیل رد لازم است. ردکردن از کسی که درخواست داده هم پذیرفته می‌شود.',
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
  QUALIFY: 'پیشنهاد واجد شرایط شناخته شد.',
  DISQUALIFY: 'پیشنهاد فاقد شرایط اعلام شد.',
  SCORE: 'امتیازهای شما ثبت شد.',
  EVALUATE: 'ارزیابی کامل شد و ماتریس امتیازها منجمد شد.',
  AWARDED: 'مناقصه واگذار شد.',
  AWARD_REQUESTED: 'درخواست موافقت با واگذاری ثبت شد و در انتظار مرجع است.',
  GRANT_AWARD: 'موافقت شما با واگذاری ثبت شد.',
  REJECT_AWARD: 'درخواست واگذاری رد شد.',
} as const;
export type OwnerOutcomeDone = keyof typeof OWNER_COMMAND_DONE;

/**
 * The outcomes of a command construction-service answers again to the same key
 * (`KEYED_REPLAY_OWNER_COMMANDS`): when the answer came from a re-send, the
 * flash is `<outcome>_RESENT` and says what a replay is.
 */
const KEYED_REPLAY_OUTCOMES = [
  'PUBLISHED',
  'REQUESTED',
  'PROPOSE_OPENING',
  'OPEN_BIDS',
  'WITHDRAW_PROPOSAL',
  'AWARDED',
  'AWARD_REQUESTED',
] as const satisfies readonly OwnerOutcomeDone[];

export type OwnerResentDone = `${(typeof KEYED_REPLAY_OUTCOMES)[number]}_RESENT`;
export type OwnerDone = OwnerOutcomeDone | OwnerResentDone;

export const OWNER_DONE: readonly OwnerDone[] = [
  ...(Object.keys(OWNER_COMMAND_DONE) as OwnerOutcomeDone[]),
  ...KEYED_REPLAY_OUTCOMES.map((outcome): OwnerResentDone => `${outcome}_RESENT`),
];

/** The flash of an outcome reached by sending the same request again. */
export function resentOutcome(outcome: OwnerOutcomeDone): OwnerDone {
  return (KEYED_REPLAY_OUTCOMES as readonly string[]).includes(outcome)
    ? (`${outcome}_RESENT` as OwnerResentDone)
    : outcome;
}

/** The sentence an outcome is confirmed with, and whether it was reached by a re-send. */
export function ownerDoneText(done: OwnerDone): { text: string; resent: boolean } {
  const resent = done.endsWith('_RESENT');
  const outcome = (resent ? done.slice(0, -'_RESENT'.length) : done) as OwnerOutcomeDone;
  return { text: OWNER_COMMAND_DONE[outcome], resent };
}

/**
 * What a re-sent request's answer is: the answer the service gave the first
 * send under the same key, replayed — a record of that moment, not of the
 * tender now.
 */
export const OWNER_RESENT_NOTE =
  'این پاسخِ ارسال دوبارهٔ همان درخواست است و ممکن است همان پاسخ ثبت‌شدهٔ نخستین ارسال باشد؛ پاسخ تکراری وضعیت همان لحظه را می‌گوید، نه وضعیت کنونی مناقصه. وضعیت کنونی را از خوانده‌های همین صفحه ببینید.';

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
  PROCUREMENT_ESTIMATE_REQUIRED:
    'برای بررسی حدود مبلغ، برآورد مبلغ این مناقصه را به ریال وارد کنید.',
  PROCUREMENT_AMOUNT_OUTSIDE_RANGE:
    'مبلغ برآورد با حدود پیکربندی‌شده برای نوع فرایند انتخابی سازگار نیست؛ انتشار انجام نشد.',
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
  PROPOSAL_SUPERSEDED:
    'پیشنهاد گشایشی که نام برده شد دیگر پیشنهاد جاری نیست و پیشنهاد دیگری جای آن را گرفته است؛ چیزی پس گرفته نشد.',
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
  IDEMPOTENCY_KEY_REUSED:
    'این شناسهٔ ارسال پیش‌تر با درخواست دیگری به کار رفته است و این ارسال چیزی ثبت نکرد. این دربارهٔ درخواست نخست چیزی نمی‌گوید؛ وضعیت مناقصه را با تازه‌کردن صفحه ببینید.',
  VALIDATION_FAILED: 'بخشی از فرم پذیرفتنی نیست؛ چیزی ثبت نشد. فرم را بررسی کنید.',
  UPSTREAM_UNAVAILABLE:
    'سرویسی که این کار به آن نیاز دارد در دسترس نبود؛ چیزی ثبت نشد. کمی بعد دوباره تلاش کنید.',
};

/** For anything the tables above do not cover; the service's own sentence is never shown. */
export const OWNER_REFUSAL_FALLBACK =
  'این درخواست پذیرفته نشد و چیزی ثبت نشد. صفحه را تازه کنید و دوباره بررسی کنید.';

const EVALUATION_FORBIDDEN =
  'ارزیابی پیشنهادهای این مناقصه در اختیار شما نیست، یا اکنون نقش آن را ندارید.';

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
  QUALIFY: EVALUATION_FORBIDDEN,
  DISQUALIFY: EVALUATION_FORBIDDEN,
  SCORE: EVALUATION_FORBIDDEN,
  EVALUATE: EVALUATION_FORBIDDEN,
  AWARD: 'واگذاری این مناقصه در اختیار شما نیست، یا اکنون نقش آن را ندارید.',
  GRANT_AWARD:
    'این مرحله را شما نمی‌توانید بررسی کنید: یا درخواست واگذاری را خودتان داده‌اید (تفکیک وظایف)، یا اکنون عضو سازمان مرجع با نقشِ نام‌برده نیستید، یا نقشی دارید که با پیشنهادها کاری ندارد.',
  REJECT_AWARD:
    'این مرحله را شما نمی‌توانید بررسی کنید: اکنون عضو سازمان مرجع با نقشِ نام‌برده نیستید، یا نقشی دارید که با پیشنهادها کاری ندارد.',
};

/**
 * The closed reasons a command can be refused for, each in fixed words — one
 * table per command, since a code such as `CONFLICT_OF_INTEREST` says a
 * different thing for an opening, an evaluation and an award.
 */
export function refusalTextFor(command: OwnerCommand): Readonly<Record<string, string>> {
  switch (command) {
    case 'PUBLISH':
      return { ...APPROVAL_REFUSAL_TEXT, ...PUBLICATION_REFUSAL_TEXT };
    case 'GRANT':
    case 'REJECT':
    case 'GRANT_AWARD':
    case 'REJECT_AWARD':
      return APPROVAL_REFUSAL_TEXT;
    case 'PROPOSE_OPENING':
    case 'OPEN_BIDS':
    case 'WITHDRAW_PROPOSAL':
      return OPENING_REFUSAL_TEXT;
    case 'AWARD':
      return { ...APPROVAL_REFUSAL_TEXT, ...AWARD_REFUSAL_TEXT };
    default:
      return EVALUATION_REFUSAL_TEXT;
  }
}
