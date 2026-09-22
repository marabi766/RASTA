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

const ASSET_TYPES: Readonly<Record<string, string>> = {
  HEAVY_MACHINERY: 'ماشین‌آلات سنگین',
  LIGHT_VEHICLE: 'خودرو سبک',
  WASTE_COLLECTOR: 'خودرو جمع‌آوری پسماند',
  EMERGENCY_VEHICLE: 'خودرو امدادی',
  PASSENGER_VEHICLE: 'خودرو مسافری',
  FIXED_EQUIPMENT: 'تجهیزات ثابت',
  OTHER: 'سایر',
};

const ASSET_STATUSES: Readonly<Record<string, string>> = {
  REGISTERED: 'ثبت‌شده',
  ACTIVE: 'فعال',
  ASSIGNED: 'تخصیص‌یافته',
  IDLE: 'بیکار',
  IN_MAINTENANCE: 'در تعمیر',
  OUT_OF_SERVICE: 'خارج از سرویس',
  DECOMMISSIONED: 'از رده خارج',
};

/**
 * Why an asset may not be dispatched, in the words asset-service uses.
 *
 * The service returns every blocker rather than the first, because an operator
 * who clears one should not have to discover the next by trying again. The
 * labels keep that shape: one line per reason.
 */
const COMPLIANCE_BLOCKERS: Readonly<Record<string, string>> = {
  NO_ACTIVE_INSURANCE: 'بیمه‌نامهٔ معتبر ندارد',
  INSURANCE_EXPIRED: 'بیمه‌نامه منقضی شده',
  NO_TECHNICAL_INSPECTION: 'معاینهٔ فنی ندارد',
  INSPECTION_EXPIRED: 'معاینهٔ فنی منقضی شده',
  INSPECTION_FAILED: 'معاینهٔ فنی مردود شده',
  OUT_OF_SERVICE: 'خارج از سرویس است',
  DECOMMISSIONED: 'از رده خارج شده',
};

const TIMELINE_CATEGORIES: Readonly<Record<string, string>> = {
  REGISTRATION: 'ثبت',
  ASSIGNMENT: 'تخصیص',
  USAGE: 'کارکرد',
  MAINTENANCE: 'نگهداری',
  COST: 'هزینه',
  COMPLIANCE: 'انطباق',
  LOCATION: 'مکان',
  TRANSFER: 'انتقال',
  STATUS: 'وضعیت',
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

function lookup(table: Readonly<Record<string, string>>, value: string): string {
  return table[value] ?? value;
}

export const assetTypeLabel = (value: string): string => lookup(ASSET_TYPES, value);
export const assetStatusLabel = (value: string): string => lookup(ASSET_STATUSES, value);
export const blockerLabel = (value: string): string => lookup(COMPLIANCE_BLOCKERS, value);
export const timelineCategoryLabel = (value: string): string => lookup(TIMELINE_CATEGORIES, value);
export const maintenanceTypeLabel = (value: string): string => lookup(MAINTENANCE_TYPES, value);
export const maintenanceRequestStatusLabel = (value: string): string =>
  lookup(MAINTENANCE_REQUEST_STATUSES, value);
export const repairOrderStatusLabel = (value: string): string =>
  lookup(REPAIR_ORDER_STATUSES, value);
export const severityLabel = (value: string): string => lookup(SEVERITIES, value);
export const costCategoryLabel = (value: string): string => lookup(COST_CATEGORIES, value);

/** The options a filter offers, in the order a person reads them. */
export const assetTypeOptions = Object.entries(ASSET_TYPES).map(([value, label]) => ({
  value,
  label,
}));

export const assetStatusOptions = Object.entries(ASSET_STATUSES).map(([value, label]) => ({
  value,
  label,
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
