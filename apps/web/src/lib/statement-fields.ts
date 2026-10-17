import { toPersianDigits } from './format';

/**
 * The statement vocabulary the `/contracts/[id]` screens render (EXP-004;
 * contract-service `statement/statement.state-machine.ts`, `statement/dto.ts`
 * and `shared/refusal.ts`, ADR-068 § 5). Pinned to that source by
 * `server/contract-statements.contract.spec.ts`.
 *
 * Client-safe: the forms import it. Nothing here decides who may act — that is
 * `server/contract-statements.ts`, from the token — only what is said.
 */

export const STATEMENT_STATES = [
  'DRAFT',
  'SUBMITTED',
  'TECHNICALLY_APPROVED',
  'APPROVED',
  'REJECTED',
] as const;

export type StatementStatus = (typeof STATEMENT_STATES)[number];

export const STATEMENT_STATE_LABELS: Readonly<Record<StatementStatus, string>> = {
  DRAFT: 'پیش‌نویس',
  SUBMITTED: 'ارسال‌شده، در انتظار تأیید فنی',
  TECHNICALLY_APPROVED: 'تأیید فنی شده، در انتظار تأیید مالی',
  APPROVED: 'تأییدشده',
  REJECTED: 'ردشده',
};

export function isStatementStatus(value: string | undefined): value is StatementStatus {
  return (STATEMENT_STATES as readonly string[]).includes(value ?? '');
}

/** A status the portal has no word for renders as itself (`contract-fields.ts`'s rule). */
export function statementStatusLabel(status: string): string {
  return isStatementStatus(status) ? STATEMENT_STATE_LABELS[status] : status;
}

/** The two approval chains, technical first (Q-96 (2)). */
export const STATEMENT_CHAINS = ['TECHNICAL', 'FINANCIAL'] as const;
export type StatementChain = (typeof STATEMENT_CHAINS)[number];

export const STATEMENT_CHAIN_LABELS: Readonly<Record<StatementChain, string>> = {
  TECHNICAL: 'زنجیرهٔ تأیید فنی',
  FINANCIAL: 'زنجیرهٔ تأیید مالی',
};

export const STEP_OUTCOME_LABELS: Readonly<Record<'APPROVED' | 'REJECTED', string>> = {
  APPROVED: 'تأیید شد',
  REJECTED: 'رد شد',
};

/**
 * The commands a person can issue on statements from this portal, each its own
 * route and its own idempotency key. A decision is two commands, not one with
 * a choice inside: each has its own form and submission id, so the same key
 * can never carry an approval once and a rejection the next time.
 */
export const STATEMENT_COMMANDS = ['DRAFT', 'SUBMIT', 'APPROVE', 'REJECT'] as const;
export type StatementCommand = (typeof STATEMENT_COMMANDS)[number];

export function isStatementCommand(value: unknown): value is StatementCommand {
  return typeof value === 'string' && (STATEMENT_COMMANDS as readonly string[]).includes(value);
}

/** The commands that act on one statement; drafting acts on the contract. */
export type StatementStepCommand = Exclude<StatementCommand, 'DRAFT'>;

export const STATEMENT_COMMAND_LABELS: Readonly<Record<StatementCommand, string>> = {
  DRAFT: 'ثبت پیش‌نویس صورت‌وضعیت',
  SUBMIT: 'ارسال صورت‌وضعیت برای تأیید',
  APPROVE: 'تأیید این مرحله',
  REJECT: 'رد صورت‌وضعیت',
};

/** What happens, said before the button — none of these can be undone. */
export const STATEMENT_COMMAND_CONSEQUENCES: Readonly<Record<StatementCommand, string>> = {
  DRAFT:
    'سامانه صورت‌وضعیت را شماره‌گذاری می‌کند و مبلغ ناخالص را از جمع ردیف‌ها حساب می‌کند. آنچه در پیش‌نویس ثبت شود دیگر تغییر نمی‌کند.',
  SUBMIT:
    'با ارسال، دو زنجیرهٔ تأیید (فنی، سپس مالی) از سیاست‌های برقرار کارفرما برای این صورت‌وضعیت ثبت می‌شود و Milestoneهای ردیف‌ها دیگر تغییر نمی‌کنند. ارسال پس‌گرفتنی نیست.',
  APPROVE:
    'تأیید این مرحله ثبت می‌شود و پس‌گرفتنی نیست. تأیید آخرین مرحلهٔ زنجیرهٔ مالی صورت‌وضعیت را نهایی می‌کند؛ هیچ پولی جابه‌جا نمی‌شود.',
  REJECT: 'رد در هر مرحله صورت‌وضعیت را برای همیشه رد می‌کند و این شماره دیگر بررسی نمی‌شود.',
};

/**
 * The statement's lines, as the draft form takes them. The bounds are the
 * DTO's (`MAX_LINE_DESCRIPTION_LENGTH`, `MAX_STATEMENT_LINES`); the form offers
 * fewer rows than the service accepts, which only limits what one form holds.
 */
export const LINE_DESCRIPTION_MAX = 500;
export const MAX_STATEMENT_LINES = 100;
export const FORM_LINE_ROWS = 10;

export interface StatementLineValues {
  readonly description: string;
  readonly amount: string;
  readonly milestoneId: string;
}

export const EMPTY_LINE: StatementLineValues = { description: '', amount: '', milestoneId: '' };

/** The form field of row `index`, as the draft form names it. */
export const lineField = (index: number, part: keyof StatementLineValues): string =>
  `line.${index}.${part}`;

export const LINE_FIELD_LABELS: Readonly<Record<keyof StatementLineValues, string>> = {
  description: 'شرح کار',
  amount: 'مبلغ (ریال)',
  milestoneId: 'Milestone (اختیاری)',
};

/** "ردیف ۳" — a row as a person reads it. */
export const rowLabel = (index: number): string => `ردیف ${toPersianDigits(String(index + 1))}`;

/**
 * The closed reasons contract-service gives in `details[].code` for a refused
 * statement command (`REFUSAL_REASONS.statement` and `.decision`), each with
 * the fixed sentence a person reads. The service's own English is never shown:
 * a refusal is said in these words or not at all. Separation of duties (Q-96
 * (3)) is among them — the backend refuses it and the page says why, in its
 * own words, never echoing the refusal.
 */
export const STATEMENT_REFUSAL_TEXT: Readonly<Record<string, string>> = {
  // Drafting and submitting.
  AUTHOR_NOT_CONTRACTOR: 'صورت‌وضعیت را فقط پیمانکار همین قرارداد پیش‌نویس و ارسال می‌کند.',
  CONTRACT_NOT_SIGNED: 'صورت‌وضعیت فقط روی قرارداد امضاشده ثبت، ارسال یا بررسی می‌شود.',
  DEDUCTION_NOT_CONFIGURED: 'کسری اعمال می‌شود که کارفرما پیکربندی کرده و برقرار نگه داشته است.',
  STATEMENT_NET_NEGATIVE: 'کسورات از مبلغ ناخالص بیشتر می‌شود؛ پیش‌نویس ثبت نشد.',
  STATEMENT_EXCEEDS_LIMIT: 'جمع ردیف‌ها از بیشترین مبلغ قابل ثبت فراتر می‌رود؛ پیش‌نویس ثبت نشد.',
  MILESTONE_NOT_OF_CONTRACT: 'ردیفی به Milestoneی اشاره می‌کند که از این قرارداد نیست.',
  STATEMENT_NOT_DRAFT: 'فقط صورت‌وضعیت پیش‌نویس ارسال می‌شود؛ این صورت‌وضعیت دیگر پیش‌نویس نیست.',
  ACTOR_IDENTITY_UNKNOWN:
    'هویت پایدار شما از نشست خوانده نشد و تفکیک وظایف قابل اثبات نیست؛ چیزی ثبت نشد. دوباره وارد شوید.',
  TECHNICAL_POLICY_REQUIRED:
    'کارفرما سیاست برقراری برای زنجیرهٔ تأیید فنی ندارد؛ صورت‌وضعیت ارسال نشد. سامانه هرگز پیش‌فرض تأیید نمی‌کند.',
  FINANCIAL_POLICY_REQUIRED:
    'کارفرما سیاست برقراری برای زنجیرهٔ تأیید مالی ندارد؛ صورت‌وضعیت ارسال نشد. سامانه هرگز پیش‌فرض تأیید نمی‌کند.',
  TECHNICAL_STEP_NOT_APPLICABLE:
    'سیاست تأیید فنی کارفرما مرحله‌ای برای مبلغ این صورت‌وضعیت ندارد؛ صورت‌وضعیت ارسال نشد.',
  FINANCIAL_STEP_NOT_APPLICABLE:
    'سیاست تأیید مالی کارفرما مرحله‌ای برای مبلغ این صورت‌وضعیت ندارد؛ صورت‌وضعیت ارسال نشد.',
  APPROVAL_STEP_NAMES_CONTRACTOR:
    'مرحله‌ای از زنجیرهٔ تأیید، سازمان خود پیمانکار را نام می‌برد و پیمانکار ادعای خودش را تأیید نمی‌کند؛ صورت‌وضعیت ارسال نشد.',
  POLICY_AUTHOR_NOT_GOVERNING:
    'اتحادیه‌ای که سیاست تأیید را نوشته دیگر بر کارفرما حاکم نیست؛ صورت‌وضعیت ارسال نشد.',
  // Deciding a step.
  NOT_STEP_AUTHORITY: 'این مرحله را فقط سازمانی بررسی می‌کند که مرحله نام برده است.',
  MEMBER_OF_CONTRACTOR:
    'تفکیک وظایف: عضو سازمان پیمانکار، صورت‌وضعیت همان پیمانکار را بررسی نمی‌کند؛ چیزی ثبت نشد.',
  SUBMITTER_MAY_NOT_DECIDE:
    'تفکیک وظایف: کسی که صورت‌وضعیت را ارسال کرده آن را بررسی نمی‌کند؛ چیزی ثبت نشد.',
  ALREADY_DECIDED_STATEMENT:
    'تفکیک وظایف: هر شخص از یک صورت‌وضعیت، در هر دو زنجیره، فقط یک مرحله را بررسی می‌کند و شما پیش‌تر مرحله‌ای از آن را بررسی کرده‌اید؛ چیزی ثبت نشد.',
  STATEMENT_NOT_SUBMITTED: 'صورت‌وضعیت پیش‌نویس هنوز ارسال نشده و بررسی نمی‌شود.',
  STATEMENT_DECIDED: 'این صورت‌وضعیت پیش‌تر تأیید یا رد شده و دیگر بررسی نمی‌شود.',
  STEP_NOT_IN_CHAIN: 'زنجیره‌های تأیید این صورت‌وضعیت چنین مرحله‌ای ندارند.',
  CHAIN_NOT_OPEN: 'زنجیرهٔ مالی فقط پس از تأیید کامل زنجیرهٔ فنی باز می‌شود.',
  STEP_NOT_NEXT: 'مرحلهٔ پیشینِ این زنجیره هنوز بررسی نشده است.',
  STEP_DECIDED: 'این مرحله پیش‌تر بررسی شده است؛ صفحه را تازه کنید.',
  APPROVED_TOTAL_EXCEEDS_CAP:
    'تأیید این صورت‌وضعیت جمع تأییدشدهٔ قرارداد را از مبلغ قرارداد و الحاقیه‌های اجراشده فراتر می‌برد؛ چیزی ثبت نشد.',
};

/**
 * What is said for a refusal by its platform error code, when it names no
 * closed reason (`docs/06` § 6.7).
 */
export const STATEMENT_CODE_TEXT: Readonly<Record<string, string>> = {
  OPTIMISTIC_LOCK_FAILED:
    'این صورت‌وضعیت از وقتی صفحه باز شد تغییر کرده است و چیزی ثبت نشد. صفحه را تازه کنید.',
  IDEMPOTENCY_KEY_REUSED:
    'این شناسهٔ ارسال پیش‌تر با درخواست دیگری به کار رفته است و چیزی ثبت نشد. صفحه را تازه کنید.',
  CONFLICT:
    'هم‌زمان یکی از سیاست‌های تأیید برقرار یا برداشته شد و چیزی ثبت نشد. صفحه را تازه کنید و دوباره بفرستید.',
  INSUFFICIENT_ROLE: 'نقشی که این اقدام لازم دارد را در این سازمان ندارید.',
};

/** For anything the two tables above do not cover; the service's own sentence is never shown. */
export const STATEMENT_REFUSAL_FALLBACK =
  'این درخواست پذیرفته نشد و چیزی ثبت نشد. صفحه را تازه کنید و دوباره بررسی کنید.';
