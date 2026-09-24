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
 */
export const PORTAL_NAV: readonly SidebarItem[] = [
  { href: '/', label: 'خانه' },
  { href: '/assets', label: 'ماشین‌آلات' },
  { href: '/drivers', label: 'راننده و تخصیص' },
  { href: '/usage', label: 'ثبت کارکرد' },
  { href: '/maintenance', label: 'نگهداری و تعمیرات' },
  { href: '/marketplace', label: 'بازار' },
  { href: '/wallet', label: 'کیف پول' },
  { href: '/organizations', label: 'سازمان و اعضا' },
];
