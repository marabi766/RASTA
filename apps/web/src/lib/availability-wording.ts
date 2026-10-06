/**
 * Persian wording for fleet-service's availability blockers (EXP-002, slice 7).
 *
 * fleet-service names, for every reason a machine cannot be dispatched, a closed
 * `code`, the service that `owner`s the fact and — for the two safety causes —
 * a structured `cause` and the lapsed `coverages`. The wording here is built
 * from those and **never from the English `detail` sentence**, which is the
 * service's to reword. A blocker this file does not know is shown with its owner
 * and code rather than dropped or guessed at: a service that has moved ahead of
 * the portal is visible, not hidden.
 *
 * ## Who can lift it
 *
 * `imposedBy` says what kind of fact a blocker is, and that is the line the page
 * draws around its one control:
 *
 * - `DECLARATION` — a statement a fleet manager made. The only blocker with a
 *   window behind it, and the only one the portal offers to withdraw.
 * - `PLATFORM` — a fact another service owns and keeps current: an expired
 *   policy, a failed inspection, a withdrawal for repair, a status that does not
 *   dispatch. Not a window; no endpoint withdraws it from here.
 * - `ASSIGNMENT` — the machine is in use; the assignment ends where it was made.
 */

import { assetStatusLabel, policyCoverageLabel } from './labels';

export type BlockerImposedBy = 'DECLARATION' | 'PLATFORM' | 'ASSIGNMENT';

export interface BlockerWording {
  readonly imposedBy: BlockerImposedBy;
  /** What is wrong, as one sentence. */
  readonly title: string;
  /** Who owns the fact — where it is resolved. */
  readonly owner: string;
}

/** The services that own an availability fact, as a person knows them. */
const OWNER_LABELS: Readonly<Record<string, string>> = {
  'asset-service': 'سامانهٔ دارایی',
  'maintenance-service': 'تعمیر و نگهداری',
  'fleet-service': 'ناوگان',
};

/** Said for a lapse whose coverage the producing event did not name. */
const UNKNOWN_COVERAGE = 'UNKNOWN';

export interface AvailabilityBlockerInput {
  readonly code: string;
  readonly owner: string;
  readonly cause?: string | undefined;
  readonly coverages?: readonly string[] | undefined;
}

export function blockerWording(
  blocker: AvailabilityBlockerInput,
  assetStatus?: string,
): BlockerWording {
  const owner = OWNER_LABELS[blocker.owner] ?? blocker.owner;

  switch (blocker.code) {
    case 'DISPATCH_BLOCKED':
      if (blocker.cause === 'INSPECTION') {
        return { imposedBy: 'PLATFORM', owner, title: 'آخرین معاینهٔ فنی مردود شده است' };
      }
      if (blocker.cause === 'INSURANCE') {
        const named = (blocker.coverages ?? []).filter((coverage) => coverage !== UNKNOWN_COVERAGE);
        const unnamed = (blocker.coverages ?? []).includes(UNKNOWN_COVERAGE);
        const parts = [...named.map(policyCoverageLabel), ...(unnamed ? ['نوع پوشش نامشخص'] : [])];
        return {
          imposedBy: 'PLATFORM',
          owner,
          title:
            parts.length > 0
              ? `بیمه‌نامهٔ منقضی‌شده: ${parts.join('، ')}`
              : 'بیمه‌نامهٔ دارایی منقضی شده است',
        };
      }
      return { imposedBy: 'PLATFORM', owner, title: 'مانع ایمنی اعزام (معاینه یا بیمه)' };
    case 'IN_MAINTENANCE':
      return { imposedBy: 'PLATFORM', owner, title: 'دارایی برای تعمیر از مدار خارج شده است' };
    case 'ASSET_STATUS':
      return {
        imposedBy: 'PLATFORM',
        owner,
        title:
          assetStatus === undefined
            ? 'وضعیت دارایی اعزام را نمی‌پذیرد'
            : `وضعیت دارایی «${assetStatusLabel(assetStatus)}» است و اعزام را نمی‌پذیرد`,
      };
    case 'ACTIVE_ASSIGNMENT':
      return {
        imposedBy: 'ASSIGNMENT',
        owner,
        title: 'دارایی هم‌اکنون به یک راننده تخصیص داده شده است',
      };
    case 'DECLARED_UNAVAILABLE':
      return {
        imposedBy: 'DECLARATION',
        owner,
        title: 'در ناوگان «غیرقابل‌استفاده» اعلام شده است',
      };
    default:
      // Not translated and not hidden: the code is the part a person can report.
      return { imposedBy: 'PLATFORM', owner, title: `مانع دیگر (${blocker.code})` };
  }
}
