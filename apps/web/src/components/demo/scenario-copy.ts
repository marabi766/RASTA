import { FIXTURE_ENTRY_POINTS } from '@/lib/demo/entry-points';
import type {
  PresentationPersona,
  ScenarioRejectionReason,
  ScenarioStage,
} from '@/lib/demo/scenario';

/**
 * Persian presentation copy for the scenario engine's Phase C UI.
 *
 * Kept separate from the engine itself (`lib/demo/scenario/`): everything here
 * is wording and routing, not state or transition rules, and none of it needs
 * to sit behind the engine's own "reachable from N gated modules" architecture
 * test. `ScenarioStage`, `PresentationPersona` and `ScenarioRejectionReason`
 * are imported as types only, but the barrel re-export still counts as
 * reaching the engine for that test's purposes, so this module *is* on the
 * approved-importer list in `fixture-integration.spec.ts` alongside the panels
 * that use it.
 */

export const STAGE_LABELS: Record<ScenarioStage, string> = {
  ORGANIZATION_SELECTED: 'سازمان انتخاب شد',
  MAINTENANCE_REQUESTED: 'درخواست تعمیر ثبت شد',
  ESTIMATE_APPROVED: 'برآورد هزینه تأیید شد',
  OFFER_SELECTED: 'پیشنهاد تأمین‌کننده انتخاب شد',
  ORDER_PLACED: 'سفارش ثبت شد',
  PAYMENT_CAPTURED: 'پرداخت نهایی شد',
  DOCUMENT_ATTACHED: 'سند پیوست شد',
  DOCUMENT_SCAN_COMPLETED: 'اسکن سند کامل شد',
};

export const PERSONA_LABELS: Record<PresentationPersona, string> = {
  ORGANIZATION_ADMIN: 'مدیر سازمان',
  FLEET_MANAGER: 'مدیر ناوگان',
  PROCUREMENT_USER: 'کارشناس تأمین',
};

/**
 * What each closed rejection reason means, in Persian, for a presenter to
 * read aloud.
 *
 * Deliberately not the reducer's own `message` — that string is English and
 * developer-facing (`reducer.ts`'s `reject(...)` calls). The UI never shows
 * it; every rejection surfaces through this map instead; see `lib/demo/scenario/model.ts`'s
 * `SCENARIO_REJECTION_REASONS` for the closed set this mirrors.
 */
export const REJECTION_MESSAGES: Record<ScenarioRejectionReason, string> = {
  UNKNOWN_ACTION: 'این کنش در سناریوی نمایشی تعریف نشده است.',
  MALFORMED_ACTION: 'مقدار واردشده برای این کنش نامعتبر است.',
  CROSS_ORGANIZATION_REFERENCE:
    'این کنش به سازمان یا تأمین‌کننده‌ای بیرون از سناریوی نمونه اشاره می‌کند.',
  UNKNOWN_REFERENCE: 'این کنش به موجودیتی بیرون از سناریوی نمونه اشاره می‌کند.',
  INVALID_TRANSITION: 'این گام پیش از موعد یا به‌صورت تکراری اجرا شد — ترتیب داستان را دنبال کنید.',
  INSUFFICIENT_WALLET_BALANCE: 'این پرداخت مانده کیف پول سناریو را منفی می‌کرد.',
};

/** A fixed, new document id for this phase's "attach a document" step — distinct from the three static demo documents already in the fixture dataset. */
export const SCENARIO_DOCUMENT_ID = 'doc_demo_scenario_service_report';

/** Money the narrative uses, deliberately equal to figures already on screen before any dispatch (see `lib/demo/scenario/initial-state.ts`), so approving, ordering and paying do not contradict the static story the fixture dataset already tells. */
export const SCENARIO_AMOUNTS = {
  /** Matches `MAINTENANCE_REQUEST.totalCostMinor` in the fixture dataset. */
  estimateMinor: '128500000',
  /** Matches `OFFER_OIL_A.unitPriceMinor`. */
  unitPriceMinor: '142000000',
  /** `unitPriceMinor × 2`, matching the static `ORDER.totalAmountMinor` and the scenario wallet's initial `pendingBalanceMinor`. */
  orderTotalMinor: '284000000',
} as const;

export const SCENARIO_MAINTENANCE_TITLE = 'تعویض روغن و فیلتر — سرویس ۲۵۰ ساعت';

interface StoryStep {
  readonly stage: ScenarioStage;
  /** What the presenter says is happening right now. */
  readonly summary: string;
  /** Where the control for the *next* action lives. */
  readonly nextHref: string;
  readonly nextLabel: string;
}

/**
 * One row per stage, read by the central panel (`scenario-status-card.tsx`)
 * to show "you are here" and "go here next" — the one clear next destination
 * every stage owes the presenter.
 */
export const STORY_STEPS: readonly StoryStep[] = [
  {
    stage: 'ORGANIZATION_SELECTED',
    summary: 'داستان از سازمان و دارایی نمونه شروع می‌شود.',
    nextHref: `/assets/${FIXTURE_ENTRY_POINTS.assetId}`,
    nextLabel: 'باز کردن دارایی و ثبت درخواست تعمیر',
  },
  {
    stage: 'MAINTENANCE_REQUESTED',
    summary: 'درخواست تعمیر ثبت شد؛ اکنون برآورد هزینه را تأیید کنید.',
    nextHref: `/maintenance/${FIXTURE_ENTRY_POINTS.maintenanceRequestId}`,
    nextLabel: 'تأیید برآورد هزینه',
  },
  {
    stage: 'ESTIMATE_APPROVED',
    summary: 'برآورد تأیید شد؛ اکنون پیشنهاد تأمین‌کننده را انتخاب کنید.',
    nextHref: `/marketplace/${FIXTURE_ENTRY_POINTS.productId}`,
    nextLabel: 'انتخاب پیشنهاد تأمین‌کننده',
  },
  {
    stage: 'OFFER_SELECTED',
    summary: 'پیشنهاد انتخاب شد؛ اکنون سفارش را ثبت کنید.',
    nextHref: `/marketplace/${FIXTURE_ENTRY_POINTS.productId}`,
    nextLabel: 'ثبت سفارش',
  },
  {
    stage: 'ORDER_PLACED',
    summary: 'سفارش ثبت شد؛ اکنون پرداخت شبیه‌سازی‌شده را نهایی کنید.',
    nextHref: `/orders/${FIXTURE_ENTRY_POINTS.orderId}`,
    nextLabel: 'نهایی‌کردن پرداخت',
  },
  {
    stage: 'PAYMENT_CAPTURED',
    summary: 'پرداخت نهایی شد؛ اکنون سند نمونه را پیوست کنید.',
    nextHref: '/documents',
    nextLabel: 'پیوست سند',
  },
  {
    stage: 'DOCUMENT_ATTACHED',
    summary: 'سند پیوست شد؛ اکنون اسکن بدافزار شبیه‌سازی‌شده را کامل کنید.',
    nextHref: '/documents',
    nextLabel: 'تکمیل اسکن سند',
  },
  {
    stage: 'DOCUMENT_SCAN_COMPLETED',
    summary: 'داستان کامل شد؛ نتیجه را در خط زمانی حسابرسی ببینید.',
    nextHref: '/audit',
    nextLabel: 'مشاهدهٔ خط زمانی حسابرسی',
  },
];
