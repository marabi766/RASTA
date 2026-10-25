import { ownValue } from '@/lib/own-key';
/**
 * The vocabulary of the contract commands on `/contracts/[id]` (EXP-004;
 * contract-service `contract/`, `amendment/`, `milestone/` and
 * `shared/refusal.ts`, ADR-068, CON-003 PRs 2–3). Pinned to that source by
 * `server/contract-commands.contract.spec.ts`.
 *
 * Client-safe: the forms import it. Nothing here decides who may act — that is
 * `server/contract-commands.ts`, from the token — only what is said.
 */

/**
 * The commands a person can issue on a contract from this portal, each its own
 * route and its own idempotency key: accepting the draft for one's side,
 * cancelling a draft, proposing and signing an amendment, planning and
 * changing a milestone.
 */
export const CONTRACT_COMMANDS = [
  'SIGN',
  'CANCEL',
  'PROPOSE_AMENDMENT',
  'SIGN_AMENDMENT',
  'PLAN_MILESTONE',
  'CHANGE_MILESTONE',
] as const;
export type ContractCommand = (typeof CONTRACT_COMMANDS)[number];

export function isContractCommand(value: unknown): value is ContractCommand {
  return typeof value === 'string' && (CONTRACT_COMMANDS as readonly string[]).includes(value);
}

/**
 * Which slot a command's outcome is held in until it is known: the contract
 * itself (its signature and its cancellation share one), a new amendment, one
 * amendment, a new milestone, or one milestone. Each object has one slot, so
 * a lost signature can never be overwritten by a cancellation sent after it.
 */
export const CONTRACT_SLOTS = [
  'CONTRACT',
  'NEW_AMENDMENT',
  'AMENDMENT',
  'NEW_MILESTONE',
  'MILESTONE',
] as const;
export type ContractSlot = (typeof CONTRACT_SLOTS)[number];

export const SLOT_OF: Readonly<Record<ContractCommand, ContractSlot>> = {
  SIGN: 'CONTRACT',
  CANCEL: 'CONTRACT',
  PROPOSE_AMENDMENT: 'NEW_AMENDMENT',
  SIGN_AMENDMENT: 'AMENDMENT',
  PLAN_MILESTONE: 'NEW_MILESTONE',
  CHANGE_MILESTONE: 'MILESTONE',
};

/** Whether a slot names one object (an amendment, a milestone) rather than the contract's. */
export function slotHasSubject(slot: ContractSlot): boolean {
  return slot === 'AMENDMENT' || slot === 'MILESTONE';
}

/** The two parties (`sideOf` in contract-service). */
export const CONTRACT_SIDES = ['EMPLOYER', 'CONTRACTOR'] as const;
export type ContractSide = (typeof CONTRACT_SIDES)[number];

export const SIDE_LABELS: Readonly<Record<ContractSide, string>> = {
  EMPLOYER: 'کارفرما',
  CONTRACTOR: 'پیمانکار',
};

export const CONTRACT_COMMAND_LABELS: Readonly<Record<ContractCommand, string>> = {
  SIGN: 'امضای قرارداد',
  CANCEL: 'لغو پیش‌نویس قرارداد',
  PROPOSE_AMENDMENT: 'پیشنهاد الحاقیه',
  SIGN_AMENDMENT: 'امضای الحاقیه',
  PLAN_MILESTONE: 'برنامه‌ریزی Milestone',
  CHANGE_MILESTONE: 'ویرایش Milestone',
};

/** What happens, said before the button. */
export const CONTRACT_COMMAND_CONSEQUENCES: Readonly<Record<ContractCommand, string>> = {
  SIGN: 'پذیرش پیش‌نویس از سوی طرف شما ثبت می‌شود و پس‌گرفتنی نیست. قرارداد وقتی امضاشده می‌شود که هر دو طرف پذیرفته باشند. این پذیرشِ ثبت‌شده است، نه امضای حقوقی.',
  CANCEL:
    'پیش‌نویس برای همیشه لغو می‌شود و دیگر امضا نمی‌شود. دلیل لغو را هر دو طرف می‌بینند؛ یادداشت اختیاری است.',
  PROPOSE_AMENDMENT:
    'الحاقیه مبلغی به قرارداد می‌افزاید و تنها وقتی اجرا می‌شود که هر دو طرف آن را امضا کنند؛ تا آن زمان چیزی به مبلغ قرارداد افزوده نمی‌شود.',
  SIGN_AMENDMENT:
    'امضای طرف شما ثبت می‌شود و پس‌گرفتنی نیست. با امضای هر دو طرف، مبلغ الحاقیه به مبلغ جاری قرارداد افزوده می‌شود.',
  PLAN_MILESTONE:
    'Milestone با عنوان، روز برنامه‌ریزی‌شده و در صورت تمایل سهمی از مبلغ قرارداد ثبت می‌شود. Milestone حذف نمی‌شود.',
  CHANGE_MILESTONE:
    'تا وقتی هیچ صورت‌وضعیتی به این Milestone اشاره نکرده، می‌توان آن را ویرایش کرد. سهم خالی، سهم را برمی‌دارد.',
};

/** The banner a confirmed command earns (`server/flash.ts`). */
export const CONTRACT_COMMAND_DONE: Readonly<Record<ContractCommand, string>> = {
  SIGN: 'پذیرش قرارداد از سوی طرف شما ثبت شد.',
  CANCEL: 'پیش‌نویس قرارداد لغو شد.',
  PROPOSE_AMENDMENT: 'الحاقیه پیشنهاد شد.',
  SIGN_AMENDMENT: 'امضای الحاقیه از سوی طرف شما ثبت شد.',
  PLAN_MILESTONE: 'Milestone برنامه‌ریزی شد.',
  CHANGE_MILESTONE: 'Milestone ویرایش شد.',
};

/**
 * Persian words for the **default** reason codes of contract-service
 * (`CONTRACT_CANCEL_REASON_CODES`, `CONTRACT_AMENDMENT_REASON_CODES`) —
 * descriptive codes with no legal meaning, which the client may replace. A
 * code with no word here is shown as itself, visibly untranslated.
 */
export const CANCEL_REASON_LABELS: Readonly<Record<string, string>> = {
  TERMS_NOT_AGREED: 'توافق نشدن بر شرایط',
  CONTRACTOR_WITHDREW: 'انصراف پیمانکار',
  AWARD_ERROR: 'خطا در واگذاری',
  OTHER: 'سایر',
};

export const AMENDMENT_REASON_LABELS: Readonly<Record<string, string>> = {
  SCOPE_CHANGE: 'تغییر دامنهٔ کار',
  PRICE_ADJUSTMENT: 'تعدیل مبلغ',
  SCHEDULE_CHANGE: 'تغییر زمان‌بندی',
  OTHER: 'سایر',
};

export function cancelReasonLabel(code: string): string {
  return ownValue(CANCEL_REASON_LABELS, code) ?? code;
}

export function amendmentReasonLabel(code: string): string {
  return ownValue(AMENDMENT_REASON_LABELS, code) ?? code;
}

/**
 * The bounds of what the forms take — the DTOs' (`MAX_CANCEL_NOTE_LENGTH`,
 * `MAX_AMENDMENT_REASON_LENGTH`, `MAX_MILESTONE_TITLE_LENGTH`,
 * `MAX_PLANNED_SHARE_BP`).
 */
export const CANCEL_NOTE_MAX = 1000;
export const AMENDMENT_REASON_MAX = 1000;
export const MILESTONE_TITLE_MAX = 200;
export const PLANNED_SHARE_BP_MAX = 10_000;

/** The form fields, named as the request body names them so a refusal lands on its field. */
export const CONTRACT_FIELDS = [
  'reasonCode',
  'note',
  'deltaMinor',
  'reasonText',
  'title',
  'plannedDate',
  'plannedShareBp',
] as const;
export type ContractField = (typeof CONTRACT_FIELDS)[number];

export const CONTRACT_FIELD_LABELS: Readonly<Record<ContractField, string>> = {
  reasonCode: 'دلیل',
  note: 'یادداشت (اختیاری)',
  deltaMinor: 'مبلغ الحاقیه (ریال)',
  reasonText: 'شرح دلیل',
  title: 'عنوان',
  plannedDate: 'روز برنامه‌ریزی‌شده',
  plannedShareBp: 'سهم از مبلغ قرارداد (درصد، اختیاری)',
};

/**
 * The closed reasons contract-service gives in `details[].code` for a refused
 * contract command (`REFUSAL_REASONS.signature`, `.cancellation`,
 * `.amendment` and `.milestone`), each with the fixed sentence a person reads.
 * The service's own English is never shown: a refusal is said in these words
 * or not at all. Separation of duties (one person is never both parties) and
 * the signing policy are among them — the backend refuses, the page says why.
 */
export const CONTRACT_REFUSAL_TEXT: Readonly<Record<string, string>> = {
  // Signing the contract or an amendment.
  SIGNATURE_POLICY_REQUIRED:
    'برای کارفرما سیاست امضای برقراری نیست و هنوز کسی از سوی کارفرما امضا نمی‌کند؛ چیزی ثبت نشد. سامانه هرگز پیش‌فرض اختیار نمی‌دهد.',
  POLICY_AUTHOR_NOT_GOVERNING:
    'اتحادیه‌ای که سیاست امضای برقرار را نوشته دیگر بر کارفرما حاکم نیست؛ چیزی ثبت نشد.',
  CONTRACT_NOT_DRAFT:
    'فقط قرارداد پیش‌نویس امضا یا لغو می‌شود و این قرارداد دیگر پیش‌نویس نیست؛ چیزی ثبت نشد.',
  ACTOR_IDENTITY_UNKNOWN:
    'هویت پایدار شما از نشست خوانده نشد و تفکیک وظایف قابل اثبات نیست؛ چیزی ثبت نشد. دوباره وارد شوید.',
  MEMBER_OF_BOTH_PARTIES:
    'تفکیک وظایف: کسی که عضو هر دو طرف قرارداد است از سوی هیچ‌کدام امضا نمی‌کند؛ چیزی ثبت نشد.',
  SAME_PERSON_BOTH_SIDES:
    'تفکیک وظایف: یک شخص از سوی هر دو طرف امضا نمی‌کند و شما پیش‌تر از سوی طرف دیگر امضا کرده‌اید؛ چیزی ثبت نشد.',
  SIDE_ALREADY_SIGNED: 'شخص دیگری پیش‌تر از سوی طرف شما امضا کرده است؛ صفحه را تازه کنید.',
  // Cancelling a draft.
  CANCEL_REASON_NOT_ALLOWED: 'این دلیل از دلیل‌های پذیرفتهٔ لغو نیست؛ قرارداد لغو نشد.',
  SIGNATURE_RECORDED:
    'یکی از طرفین این پیش‌نویس را امضا کرده است و دیگر لغو نمی‌شود؛ چیزی ثبت نشد.',
  // Amendments.
  PROPOSER_NOT_EMPLOYER: 'الحاقیه را فقط کارفرمای همین قرارداد پیشنهاد می‌کند.',
  CONTRACT_NOT_SIGNED:
    'الحاقیه و Milestone فقط روی قرارداد امضاشده ثبت می‌شود و این قرارداد امضاشده نیست؛ چیزی ثبت نشد.',
  AMENDMENT_NOT_PROPOSED: 'این الحاقیه دیگر در انتظار امضا نیست؛ صفحه را تازه کنید.',
  AMENDMENT_DELTA_NOT_POSITIVE: 'مبلغ الحاقیه باید مثبت باشد؛ کاهش مبلغ پذیرفته نیست.',
  AMENDMENT_EXCEEDS_LIMIT:
    'مبلغ قرارداد با الحاقیه‌هایش از بیشترین مبلغ قابل ثبت فراتر می‌رود؛ چیزی ثبت نشد.',
  AMENDMENT_REASON_NOT_ALLOWED: 'این دلیل از دلیل‌های پذیرفتهٔ الحاقیه نیست؛ الحاقیه ثبت نشد.',
  // Milestones.
  EDITOR_NOT_EMPLOYER: 'Milestone را فقط کارفرمای همین قرارداد برنامه‌ریزی و ویرایش می‌کند.',
  MILESTONE_REFERENCED:
    'صورت‌وضعیتی به این Milestone اشاره کرده است و دیگر ویرایش نمی‌شود؛ چیزی ثبت نشد.',
  MILESTONE_LIMIT_REACHED: 'این قرارداد به بیشترین شمار Milestoneها رسیده است؛ چیزی ثبت نشد.',
};

/**
 * What is said for a refusal by its platform error code, when it names no
 * closed reason (`docs/06` § 6.7).
 */
export const CONTRACT_CODE_TEXT: Readonly<Record<string, string>> = {
  OPTIMISTIC_LOCK_FAILED:
    'این مورد از وقتی صفحه باز شد تغییر کرده است و چیزی ثبت نشد. صفحه را تازه کنید.',
  IDEMPOTENCY_KEY_REUSED:
    'این شناسهٔ ارسال پیش‌تر با درخواست دیگری به کار رفته است و چیزی ثبت نشد. صفحه را تازه کنید.',
  CONFLICT:
    'هم‌زمان سیاست امضای کارفرما برقرار یا برداشته شد و چیزی ثبت نشد. صفحه را تازه کنید و دوباره بفرستید.',
  INSUFFICIENT_ROLE: 'نقشی که این اقدام لازم دارد را در این سازمان ندارید.',
};

/** For anything the two tables above do not cover; the service's own sentence is never shown. */
export const CONTRACT_REFUSAL_FALLBACK =
  'این درخواست پذیرفته نشد و چیزی ثبت نشد. صفحه را تازه کنید و دوباره بررسی کنید.';
