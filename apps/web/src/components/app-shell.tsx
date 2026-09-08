'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { CAPABILITIES, type Capability } from '@/lib/capabilities';
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

const GROUP_LABELS: Record<Capability['group'], string> = {
  operations: 'عملیات و ناوگان',
  commerce: 'بازار و تأمین',
  finance: 'مالی',
  platform: 'پلتفرم',
};

const GROUP_ORDER: Capability['group'][] = ['operations', 'commerce', 'finance', 'platform'];

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
          {GROUP_ORDER.map((group) => (
            <NavGroup key={group} group={group} pathname={pathname} />
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

function NavGroup({
  group,
  pathname,
}: {
  group: Capability['group'];
  pathname: string;
}): ReactNode {
  const items = CAPABILITIES.filter((capability) => capability.group === group);
  if (items.length === 0) return null;

  return (
    <div className="flex flex-none flex-row gap-2 lg:mb-4 lg:flex-col lg:gap-0.5">
      <p className="hidden px-2 pb-1 text-xs font-bold uppercase tracking-wide text-[var(--tx3)] lg:block">
        {GROUP_LABELS[group]}
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
        'border border-[var(--control-border)] lg:border-transparent',
        active
          ? 'bg-[var(--pri-soft)] font-bold text-[var(--pri-tx)]'
          : 'text-[var(--tx2)] hover:bg-[var(--sunken)] hover:text-[var(--tx)]',
      )}
    >
      <span>{capability.title}</span>
      {capability.state === 'LIVE' ? null : (
        <span className="hidden lg:inline">
          <CapabilityBadge state={capability.state} />
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
