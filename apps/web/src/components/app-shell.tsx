'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { CAPABILITIES, DOMAINS, type Capability, type DomainKey } from '@/lib/capabilities';
import { useSession } from '@/lib/auth/session';
import { Button, cx } from './ui/primitives';
import { CapabilityBadge } from './capability';
import { OrganizationSwitcher } from './org-switcher';

/**
 * The application frame: a navigation rail, a top bar and the page.
 *
 * The rail is generated from the capability manifest rather than written out,
 * so a status change is a one-line edit in one file and cannot leave the
 * navigation claiming something the dashboard denies. Every entry carries its
 * state badge — an item that leads to «در حال ساخت» says so before it is
 * clicked, which is the difference between an honest map and a demo that
 * punishes curiosity.
 *
 * Layout uses logical properties throughout (`border-e`, `ms-*`, `start-*`), so
 * the same markup is correct in both directions. docs/16 § 16.3 treats that as
 * an architectural requirement, not a preference.
 */

/**
 * Grouped by product domain, in the order the platform is built up: an asset
 * exists, it is operated and maintained, it is bought for and paid for, and the
 * whole thing is governed. The guided walkthrough follows the same order, so a
 * viewer who wandered off the tour still recognises where they are.
 */
const DOMAIN_ORDER: DomainKey[] = ['fleet', 'commerce', 'finance', 'civil', 'platform'];

export function AppShell({ children }: { children: ReactNode }): ReactNode {
  const pathname = usePathname();

  return (
    <div className="grid min-h-screen grid-cols-1 lg:grid-cols-[262px_minmax(0,1fr)]">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded-[var(--radius-md)] focus:bg-[var(--pri)] focus:px-4 focus:py-2 focus:text-white"
      >
        رفتن به محتوای اصلی
      </a>

      <aside
        aria-label="ناوبری اصلی"
        className="sticky top-0 z-30 flex max-h-[45vh] flex-row gap-2 overflow-x-auto border-b border-[var(--bd)] bg-[var(--surf)] p-3 lg:h-screen lg:max-h-none lg:flex-col lg:overflow-y-auto lg:border-b-0 lg:border-e lg:p-5"
      >
        <BrandMark />
        <nav className="flex flex-row gap-2 lg:flex-col lg:gap-0" aria-label="قابلیت‌ها">
          <PresentLink pathname={pathname} />
          {DOMAIN_ORDER.map((domain) => (
            <NavGroup key={domain} domain={domain} pathname={pathname} />
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-col">
        <TopBar />
        <main id="main" className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8">
          {children}
        </main>
        <Footer />
      </div>
    </div>
  );
}

function BrandMark(): ReactNode {
  return (
    <Link
      href="/"
      className="flex flex-none items-center gap-2.5 pb-0 lg:pb-5"
      aria-label="رستا — صفحهٔ اصلی"
    >
      <span
        aria-hidden="true"
        className="grid size-8 flex-none place-items-center rounded-[var(--radius-md)] bg-[var(--pri)] text-sm font-black text-white"
      >
        ر
      </span>
      <span className="hidden flex-col lg:flex">
        <span dir="ltr" className="text-base font-extrabold leading-none tracking-widest">
          RASTA
        </span>
        <span className="text-xs leading-tight text-[var(--tx3)]">پورتال کاربر</span>
      </span>
    </Link>
  );
}

/**
 * The walkthrough entry point, pinned above the domains.
 *
 * A presenter should never have to remember a URL, and an investor who clicks
 * away mid-tour needs one obvious way back — which is also why this link is in
 * the rail rather than only on the dashboard.
 */
function PresentLink({ pathname }: { pathname: string }): ReactNode {
  const active = pathname.startsWith('/present');

  return (
    <div className="flex flex-none lg:mb-4 lg:block">
      <Link
        href="/present"
        aria-current={active ? 'page' : undefined}
        className={cx(
          'flex min-h-[var(--tap)] flex-none items-center gap-2 whitespace-nowrap rounded-[var(--radius-md)] border px-3 text-sm font-bold lg:w-full',
          active
            ? 'border-[var(--pri)] bg-[var(--pri)] text-white'
            : 'border-[var(--pri)] text-[var(--pri-tx)] hover:bg-[var(--pri-soft)]',
        )}
      >
        <span aria-hidden="true">▸</span>
        روایت هدایت‌شده
      </Link>
    </div>
  );
}

function NavGroup({ domain, pathname }: { domain: DomainKey; pathname: string }): ReactNode {
  // `secondary` capabilities stay routable and stay in the capability map, but
  // a rail listing every one of them stops being a map and becomes a list.
  const items = CAPABILITIES.filter(
    (capability) => capability.domain === domain && !capability.secondary,
  );
  if (items.length === 0) return null;

  const label = DOMAINS.find((entry) => entry.key === domain)?.title ?? domain;

  return (
    <div className="flex flex-none flex-row gap-2 lg:mb-4 lg:flex-col lg:gap-0.5">
      <p className="hidden px-2 pb-1 text-xs font-bold uppercase tracking-wide text-[var(--tx3)] lg:block">
        {label}
      </p>
      {items.map((capability) => (
        <NavItem key={capability.key} capability={capability} pathname={pathname} />
      ))}
    </div>
  );
}

function NavItem({
  capability,
  pathname,
}: {
  capability: Capability;
  pathname: string;
}): ReactNode {
  const active = pathname === capability.href;

  return (
    <Link
      href={capability.href}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'flex min-h-[var(--tap)] flex-none items-center justify-between gap-2 whitespace-nowrap rounded-[var(--radius-md)] px-3 text-sm',
        'border border-[var(--control-border)] lg:w-full lg:border-transparent lg:whitespace-normal',
        active
          ? 'bg-[var(--pri-soft)] font-bold text-[var(--pri-tx)]'
          : 'text-[var(--tx2)] hover:bg-[var(--sunken)] hover:text-[var(--tx)]',
      )}
    >
      {/* `min-w-0` plus `truncate` is what keeps a long Persian title from
          pushing the badge out of a 262px rail and off the visible edge. */}
      <span className="min-w-0 lg:truncate">{capability.title}</span>
      {capability.state === 'LIVE' ? null : (
        <span className="hidden shrink-0 lg:inline">
          <CapabilityBadge state={capability.state} compact />
        </span>
      )}
    </Link>
  );
}

function TopBar(): ReactNode {
  const { status, claims, signIn, signOut } = useSession();

  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--bd)] bg-[var(--surf)] px-4 py-3 sm:px-6">
      {status === 'authenticated' ? <OrganizationSwitcher /> : <span />}

      <div className="flex items-center gap-3">
        {status === 'authenticated' && claims ? (
          <>
            <span className="hidden text-xs text-[var(--tx2)] sm:inline" dir="auto">
              {claims.displayName}
            </span>
            <Button
              variant="secondary"
              onClick={() => {
                void signOut();
              }}
            >
              خروج
            </Button>
          </>
        ) : null}

        {status === 'anonymous' ? (
          <Button
            onClick={() => {
              void signIn();
            }}
          >
            ورود
          </Button>
        ) : null}

        {status === 'loading' ? (
          <span className="text-xs text-[var(--tx3)]">در حال بررسی نشست…</span>
        ) : null}
      </div>
    </header>
  );
}

/**
 * The standing disclosure.
 *
 * ADR-024 requires the simulated payment provider to be visible in the UI, the
 * documentation, the demo and the presentation. The wallet screen asks the API
 * and shows the live answer; this line is the version that is true on every
 * screen and does not depend on a request succeeding.
 */
function Footer(): ReactNode {
  return (
    <footer className="border-t border-[var(--bd)] px-4 py-4 text-xs text-[var(--tx3)] sm:px-6">
      <p>
        نسخهٔ پیش‌نمایش سرمایه‌گذار. پرداخت در این نسخه شبیه‌سازی‌شده است و هیچ اتصال بانکی وجود
        ندارد. وضعیت هر قابلیت روی همان صفحه اعلام می‌شود.
      </p>
    </footer>
  );
}
