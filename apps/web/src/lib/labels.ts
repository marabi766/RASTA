/**
 * Persian wording for the platform's closed vocabularies.
 *
 * Presentation, and only presentation. The data, the API and every comparison
 * stay in the Latin upper-snake-case the services send (CLAUDE.md): a label is
 * what a person reads, never what a filter matches on.
 *
 * Every lookup falls back to the raw value rather than to a guess or an empty
 * string. A value this portal does not know means a service has moved ahead of
 * it, and showing `TRACTOR_UNIT` is honest — a reader can see it is untranslated
 * and report it. An empty cell hides the fact, and a guessed translation
 * invents one.
 */

import {
  ASSET_STATUSES,
  ASSET_TYPES,
  TIMELINE_CATEGORIES,
  type AssetStatus,
  type AssetType,
  type InspectionResult,
  type TimelineCategory,
} from './asset-fields';

/** `ASSET_TYPES`, `./asset-fields.ts` — typed, so a type added there without a label does not compile. */
const ASSET_TYPE_LABELS: Readonly<Record<AssetType, string>> = {
  GRADER: 'گریدر',
  LOADER: 'لودر',
  EXCAVATOR: 'بیل مکانیکی',
  BULLDOZER: 'بولدوزر',
  TRUCK: 'کامیون',
  LIGHT_TRUCK: 'کامیون سبک',
  TRACTOR: 'تراکتور',
  WATER_TANKER: 'تانکر آب',
  WASTE_COLLECTOR: 'خودرو جمع‌آوری پسماند',
  EMERGENCY_VEHICLE: 'خودرو امدادی',
  PASSENGER_VEHICLE: 'خودرو مسافری',
  FIXED_EQUIPMENT: 'تجهیزات ثابت',
  OTHER: 'سایر',
};

/** `ASSET_STATUSES`, `./asset-fields.ts`. */
const ASSET_STATUS_LABELS: Readonly<Record<AssetStatus, string>> = {
  REGISTERED: 'ثبت‌شده',
  ACTIVE: 'فعال',
  ASSIGNED: 'تخصیص‌یافته',
  IDLE: 'بیکار',
  IN_MAINTENANCE: 'در تعمیر',
  OUT_OF_SERVICE: 'خارج از سرویس',
  DECOMMISSIONED: 'از رده خارج',
};

/** `INSPECTION_RESULTS`, `./asset-fields.ts` — the dossier's latest technical inspection. */
const INSPECTION_RESULT_LABELS: Readonly<Record<InspectionResult, string>> = {
  PASSED: 'قبول',
  CONDITIONAL: 'مشروط',
  FAILED: 'مردود',
};

/**
 * Why an asset may not be dispatched, keyed by the exact sentence
 * asset-service sends.
 *
 * Sentences, not codes, because that is the contract today:
 * `AssetService.complianceBlockers()` pushes English prose into
 * `compliance.blockers`. This table used to be keyed by codes
 * (`NO_ACTIVE_INSURANCE`, …) the service has never sent, so every blocker
 * reached a Persian reader untranslated (audit finding L5-02).
 * `labels.contract.spec.ts` reads the sentences out of the service's source,
 * so a reworded one fails a test here rather than going quietly English on
 * screen. Stable codes on the service's side would be the better contract;
 * that change belongs to asset-service, not to this file.
 *
 * The service returns every blocker rather than the first, because an
 * operator who clears one should not have to discover the next by trying
 * again. The labels keep that shape: one line per reason.
 */
const COMPLIANCE_BLOCKERS: Readonly<Record<string, string>> = {
  'No insurance policy is currently in force': 'بیمه‌نامهٔ معتبری ندارد',
  'No technical inspection on record': 'معاینهٔ فنی ثبت نشده',
  'The most recent technical inspection failed': 'آخرین معاینهٔ فنی مردود شده',
  'The technical inspection certificate has expired': 'گواهی معاینهٔ فنی منقضی شده',
};

/** The one blocker that carries a value: `Asset status is ${status}`. */
const STATUS_BLOCKER = /^Asset status is ([A-Z_]+)$/;

/**
 * `TIMELINE_CATEGORIES`, `./asset-fields.ts` — the nine
 * sections `appendTimeline()` writes into, shared by the dossier's recent
 * activity and the full `/assets/[id]/timeline` history.
 */
const TIMELINE_CATEGORY_LABELS: Readonly<Record<TimelineCategory, string>> = {
  LIFECYCLE: 'چرخهٔ عمر',
  USAGE: 'کارکرد',
  MAINTENANCE: 'نگهداری',
  INSURANCE: 'بیمه',
  INSPECTION: 'معاینهٔ فنی',
  DOCUMENT: 'مدرک',
  COST: 'هزینه',
  PROJECT: 'پروژه',
  TRANSFER: 'انتقال',
};

/** `docs/17-mvp-scope.md`: planned work versus a reported fault. */
const MAINTENANCE_TYPES: Readonly<Record<string, string>> = {
  PREVENTIVE: 'پیشگیرانه',
  CORRECTIVE: 'اصلاحی',
};

/**
 * `REQUEST_STATUS_VALUES` in `services/maintenance-service/src/maintenance/dto.ts`.
 *
 * `APPROVED` is worded apart from `COMPLETED`: the product document's mandatory
 * control is that settlement cannot happen before an owner approves the
 * finished work and its cost, and the two words on screen should not read as
 * the same thing.
 */
const MAINTENANCE_REQUEST_STATUSES: Readonly<Record<string, string>> = {
  OPEN: 'باز',
  IN_PROGRESS: 'در جریان تعمیر',
  COMPLETED: 'تکمیل‌شده — در انتظار تأیید',
  APPROVED: 'تأییدشده',
  CANCELLED: 'لغوشده',
};

/** `REPAIR_ORDER_STATUS_VALUES`, same file. */
const REPAIR_ORDER_STATUSES: Readonly<Record<string, string>> = {
  OPEN: 'ارجاع‌شده',
  IN_PROGRESS: 'در حال تعمیر',
  COMPLETED: 'تکمیل‌شده',
  CANCELLED: 'لغوشده',
};

/** `BREAKDOWN_SEVERITIES`, same file — only meaningful for a `CORRECTIVE` request. */
const SEVERITIES: Readonly<Record<string, string>> = {
  LOW: 'کم',
  MEDIUM: 'متوسط',
  HIGH: 'زیاد',
  CRITICAL: 'بحرانی',
};

/** `DIRECT_COST_CATEGORIES` plus `PART`/`LABOUR`, the categories a cost line can carry. */
const COST_CATEGORIES: Readonly<Record<string, string>> = {
  PART: 'قطعه',
  LABOUR: 'اجرت',
  SERVICE: 'خدمت',
  EXTERNAL_REPAIR: 'تعمیر برون‌سپاری',
  OTHER: 'سایر',
};

/** `DRIVER_STATUSES`, `services/fleet-service/src/fleet/driver-lifecycle.ts`. */
const DRIVER_STATUSES: Readonly<Record<string, string>> = {
  ACTIVE: 'فعال',
  SUSPENDED: 'معلق',
  DEACTIVATED: 'از رده خارج',
};

/**
 * `ASSIGNMENT_END_REASONS`, `services/fleet-service/src/fleet/dto.ts`. Also
 * the vocabulary an assignment's own `endReason` carries once it has ended.
 */
const ASSIGNMENT_END_REASONS: Readonly<Record<string, string>> = {
  COMPLETED: 'پایان کار',
  CANCELLED: 'لغوشده',
  DRIVER_UNAVAILABLE: 'راننده در دسترس نیست',
  ASSET_UNAVAILABLE: 'ماشین در دسترس نیست',
  REASSIGNED: 'تخصیص مجدد',
};

/** `TRANSACTION_STATUSES`, `services/economic-service/src/transaction/dto.ts`. */
const TRANSACTION_STATUSES: Readonly<Record<string, string>> = {
  CREATED: 'ثبت‌شده',
  HELD: 'در وثیقه',
  PENDING_SETTLEMENT: 'در انتظار تسویه',
  DISPUTED: 'معترض‌شده',
  SETTLED: 'تسویه‌شده',
  REFUNDED: 'بازگشت‌داده‌شده',
  CANCELLED: 'لغوشده',
  FAILED: 'ناموفق',
};

/**
 * `TRANSACTION_TYPES` plus `WALLET_TOP_UP`, same file — the latter is a
 * filter value only; no endpoint accepts it as a type to *create*
 * (`createTransactionSchema` omits it on purpose).
 */
const TRANSACTION_TYPES: Readonly<Record<string, string>> = {
  MARKETPLACE_ORDER: 'سفارش بازار',
  MAINTENANCE_SERVICE: 'خدمت نگهداری',
  LOGISTICS: 'حمل‌ونقل',
  CONSTRUCTION_STATEMENT: 'صورت‌وضعیت عمرانی',
  PROCUREMENT_ORDER: 'سفارش تدارکات',
  WALLET_TOP_UP: 'افزایش موجودی',
};

/** `HoldStatus`, `services/economic-service/prisma/schema.prisma`. */
const WALLET_HOLD_STATUSES: Readonly<Record<string, string>> = {
  ACTIVE: 'در وثیقه',
  RELEASED: 'آزادشده',
  REFUNDED: 'بازگشت‌داده‌شده',
};

/** `kind`, `services/marketplace-service/src/offer/dto.ts`'s `createProductSchema`. */
const PRODUCT_KINDS: Readonly<Record<string, string>> = {
  GOOD: 'کالا',
  SERVICE: 'خدمت',
};

function lookup(table: Readonly<Record<string, string>>, value: string): string {
  return table[value] ?? value;
}

export const assetTypeLabel = (value: string): string => lookup(ASSET_TYPE_LABELS, value);
export const assetStatusLabel = (value: string): string => lookup(ASSET_STATUS_LABELS, value);
export const inspectionResultLabel = (value: string): string =>
  lookup(INSPECTION_RESULT_LABELS, value);
export const timelineCategoryLabel = (value: string): string =>
  lookup(TIMELINE_CATEGORY_LABELS, value);

export function blockerLabel(value: string): string {
  const status = STATUS_BLOCKER.exec(value)?.[1];
  if (status !== undefined) return `وضعیت دارایی «${assetStatusLabel(status)}» است`;
  return lookup(COMPLIANCE_BLOCKERS, value);
}
export const maintenanceTypeLabel = (value: string): string => lookup(MAINTENANCE_TYPES, value);
export const maintenanceRequestStatusLabel = (value: string): string =>
  lookup(MAINTENANCE_REQUEST_STATUSES, value);
export const repairOrderStatusLabel = (value: string): string =>
  lookup(REPAIR_ORDER_STATUSES, value);
export const severityLabel = (value: string): string => lookup(SEVERITIES, value);
export const costCategoryLabel = (value: string): string => lookup(COST_CATEGORIES, value);
export const driverStatusLabel = (value: string): string => lookup(DRIVER_STATUSES, value);
export const assignmentEndReasonLabel = (value: string): string =>
  lookup(ASSIGNMENT_END_REASONS, value);
export const transactionStatusLabel = (value: string): string =>
  lookup(TRANSACTION_STATUSES, value);
export const transactionTypeLabel = (value: string): string => lookup(TRANSACTION_TYPES, value);
export const walletHoldStatusLabel = (value: string): string => lookup(WALLET_HOLD_STATUSES, value);
export const productKindLabel = (value: string): string => lookup(PRODUCT_KINDS, value);

/** The options a filter offers, in the order a person reads them. */
export const assetTypeOptions = ASSET_TYPES.map((value) => ({
  value,
  label: ASSET_TYPE_LABELS[value],
}));

export const assetStatusOptions = ASSET_STATUSES.map((value) => ({
  value,
  label: ASSET_STATUS_LABELS[value],
}));

export const maintenanceTypeOptions = Object.entries(MAINTENANCE_TYPES).map(([value, label]) => ({
  value,
  label,
}));

export const maintenanceRequestStatusOptions = Object.entries(MAINTENANCE_REQUEST_STATUSES).map(
  ([value, label]) => ({ value, label }),
);

export const severityOptions = Object.entries(SEVERITIES).map(([value, label]) => ({
  value,
  label,
}));

export const driverStatusOptions = Object.entries(DRIVER_STATUSES).map(([value, label]) => ({
  value,
  label,
}));

export const assignmentEndReasonOptions = Object.entries(ASSIGNMENT_END_REASONS).map(
  ([value, label]) => ({ value, label }),
);

export const timelineCategoryOptions = TIMELINE_CATEGORIES.map((value) => ({
  value,
  label: TIMELINE_CATEGORY_LABELS[value],
}));

export const transactionStatusOptions = Object.entries(TRANSACTION_STATUSES).map(
  ([value, label]) => ({ value, label }),
);

export const transactionTypeOptions = Object.entries(TRANSACTION_TYPES).map(([value, label]) => ({
  value,
  label,
}));
