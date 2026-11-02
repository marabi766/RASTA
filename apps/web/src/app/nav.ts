import type { SidebarItem } from '@/ui';

/**
 * The portal's primary navigation, in one place.
 *
 * It was duplicated in each page while there was one page. A second screen is
 * the moment that stops being harmless: two copies drift, and the copy that
 * drifts is the one on the screen nobody opened while testing.
 *
 * **Only routes that exist are listed.** docs/16 § 16.6 maps many more, and a
 * link to a screen that answers 404 is a promise the product does not keep.
 * Each one joins this list when its page lands.
 *
 * ## A link is not a permission
 *
 * An entry may be shown to some roles only (`portalNavFor`), so a person is not
 * offered a screen that will refuse them. That is a courtesy and nothing more:
 * the backend decides who may read, and a person who opens the address anyway
 * is given its answer.
 */

const NAV_BEFORE_PROJECTS: readonly SidebarItem[] = [
  { href: '/', label: 'خانه' },
  { href: '/assets', label: 'ماشین‌آلات' },
  { href: '/drivers', label: 'راننده و تخصیص' },
  { href: '/usage', label: 'ثبت کارکرد' },
  { href: '/maintenance', label: 'نگهداری و تعمیرات' },
  { href: '/orders', label: 'سفارش‌ها' },
  { href: '/marketplace', label: 'بازار' },
];

/** Shown only to a role that may read return requests (`server/returns.ts`, `canReadReturns`). */
export const RETURNS_NAV_ITEM: SidebarItem = { href: '/returns', label: 'بازگشت کالا' };

/** Shown only to a role that may read projects (`server/portal-nav.ts`). */
const PROJECTS_ITEM: SidebarItem = { href: '/projects', label: 'پروژه‌های عمرانی' };

/** Shown only to a role that may read tenders, on either side (`server/portal-nav.ts`). */
const TENDERS_ITEM: SidebarItem = { href: '/tenders', label: 'مناقصه‌ها' };

/** Shown only to a role that may read contracts, on either side (`server/portal-nav.ts`). */
const CONTRACTS_ITEM: SidebarItem = { href: '/contracts', label: 'قراردادها' };

/** Shown only to a role that may read the supplier directory (`server/portal-nav.ts`). */
const SUPPLIERS_ITEM: SidebarItem = { href: '/suppliers', label: 'تامین‌کنندگان' };

const NAV_AFTER_PROJECTS: readonly SidebarItem[] = [
  { href: '/wallet', label: 'کیف پول' },
  { href: '/organizations', label: 'سازمان و اعضا' },
];

/** The entries every signed-in person is offered, none of them role-gated. */
export const PORTAL_NAV: readonly SidebarItem[] = [...NAV_BEFORE_PROJECTS, ...NAV_AFTER_PROJECTS];

/**
 * Offered only to the roles `GET /v1/settlements` admits, so it is not in
 * `PORTAL_NAV`; `portalNavFor` adds it for them.
 */
export const SETTLEMENTS_NAV_ITEM: SidebarItem = { href: '/settlements', label: 'تسویه‌ها' };

/** Shown only to a role that may read warehouses (`server/portal-nav.ts`). */
export const INVENTORY_NAV_ITEM: SidebarItem = { href: '/inventory', label: 'انبار' };

/** The navigation for a caller, with role-gated entries only when they apply. */
export function portalNavFor(options: {
  readonly canReadProjects: boolean;
  readonly canReadTenders?: boolean;
  readonly canReadContracts?: boolean;
  readonly canReadSettlements?: boolean;
  readonly canReadInventory?: boolean;
  readonly canReadSuppliers?: boolean;
  readonly canReadReturns?: boolean;
}): readonly SidebarItem[] {
  const before = options.canReadReturns
    ? NAV_BEFORE_PROJECTS.flatMap((item) =>
        item.href === '/orders' ? [item, RETURNS_NAV_ITEM] : [item],
      )
    : NAV_BEFORE_PROJECTS;
  const items = [
    ...before,
    ...(options.canReadProjects ? [PROJECTS_ITEM] : []),
    ...(options.canReadTenders ? [TENDERS_ITEM] : []),
    ...(options.canReadContracts ? [CONTRACTS_ITEM] : []),
    ...(options.canReadInventory ? [INVENTORY_NAV_ITEM] : []),
    ...(options.canReadSuppliers ? [SUPPLIERS_ITEM] : []),
    ...NAV_AFTER_PROJECTS,
  ];
  if (!options.canReadSettlements) return items;

  // After the wallet, the other money screen.
  const at = items.findIndex((item) => item.href === '/wallet');
  const index = at === -1 ? items.length : at + 1;
  return [...items.slice(0, index), SETTLEMENTS_NAV_ITEM, ...items.slice(index)];
}
