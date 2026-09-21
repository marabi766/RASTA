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

function lookup(table: Readonly<Record<string, string>>, value: string): string {
  return table[value] ?? value;
}

export const assetTypeLabel = (value: string): string => lookup(ASSET_TYPES, value);
export const assetStatusLabel = (value: string): string => lookup(ASSET_STATUSES, value);
export const blockerLabel = (value: string): string => lookup(COMPLIANCE_BLOCKERS, value);
export const timelineCategoryLabel = (value: string): string => lookup(TIMELINE_CATEGORIES, value);

/** The options a filter offers, in the order a person reads them. */
export const assetTypeOptions = Object.entries(ASSET_TYPES).map(([value, label]) => ({
  value,
  label,
}));

export const assetStatusOptions = Object.entries(ASSET_STATUSES).map(([value, label]) => ({
  value,
  label,
}));
