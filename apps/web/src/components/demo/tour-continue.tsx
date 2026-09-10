'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { Button } from '../ui/primitives';
import { useOptionalTour } from './tour-provider';

/**
 * The way out of a screen that has nothing to do.
 *
 * A «در حال ساخت» page is, by design, a dead end: there is no form to fill and
 * no data to explore. Without an exit, a viewer who clicked into one during a
 * presentation has to use the browser's back button, which is a small but
 * visible stumble in front of an audience.
 *
 * Which control appears depends on where they came from. Mid-tour, "continue"
 * is the useful action and it advances the itinerary. Outside a tour, the
 * useful action is the presentation index — not `router.back()`, which lands
 * somewhere unpredictable when the page was opened from a pasted link.
 */
export function TourContinue(): ReactNode {
  const tour = useOptionalTour();
  const active = tour?.active === true;
  const last = tour ? tour.index === tour.stops.length - 1 : true;

  return (
    <div className="mt-6 flex flex-wrap items-center gap-3">
      {active && !last && tour ? (
        <Button onClick={tour.next}>ادامهٔ روایت</Button>
      ) : (
        <Link
          href="/demo"
          className="inline-flex min-h-[var(--tap)] items-center rounded-[var(--radius-md)] border border-[var(--control-border)] px-4 text-sm font-semibold text-[var(--tx)] hover:bg-[var(--sunken)]"
        >
          بازگشت به صفحهٔ ارائه
        </Link>
      )}

      <Link
        href="/"
        className="inline-flex min-h-[var(--tap)] items-center rounded-[var(--radius-md)] border border-[var(--control-border)] px-4 text-sm text-[var(--tx2)] hover:bg-[var(--sunken)]"
      >
        داشبورد
      </Link>
    </div>
  );
}
