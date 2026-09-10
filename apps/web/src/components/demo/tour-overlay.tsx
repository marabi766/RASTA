'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { isFixtureMode } from '@/lib/demo/mode';
import type { StopNarration } from '@/lib/demo/tour-narration';
import { useSession } from '@/lib/auth/session';
import { formatInteger } from '@/lib/format';
import { Badge, Button, cx } from '../ui/primitives';
import { CapabilityBadge } from '../capability';
import { useTour } from './tour-provider';

/**
 * The tour, docked at the bottom of the viewport.
 *
 * ## Why the bottom, and why not a modal
 *
 * The point of every step is the screen behind it. A centred dialog would cover
 * the thing the presenter is talking about, and a spotlight cut-out would need
 * to know each screen's layout — which is exactly the coupling that makes tour
 * libraries break whenever a page changes. A bar along the bottom edge obscures
 * nothing that matters and needs to know nothing about the page it sits on.
 *
 * ## Focus
 *
 * On each step the heading receives focus. That is what makes the tour usable
 * without a mouse: after a route change the browser would otherwise leave focus
 * wherever it was, and a screen-reader user would get no announcement that the
 * step changed. The heading is `tabIndex={-1}` so it is programmatically
 * focusable without joining the tab order, and `aria-live` announces the step
 * for anyone not following focus.
 *
 * `Escape` exits. The arrow keys are deliberately *not* bound here: a tour
 * whose steps are full screens must leave the arrows to the screen — a table
 * that scrolls, a select that opens — and stealing them would break the very
 * pages it is showing.
 *
 * ## Why the narration arrives asynchronously
 *
 * The presenter text is several kilobytes of gzipped Persian that only this
 * component ever renders, and only once a tour is running. Importing it
 * statically would put it in the portal layout's shared chunk — the initial
 * download of every screen, including the ones nobody tours. It loads on the
 * first step instead, from a local module, so the wait is a parsed chunk rather
 * than a network round trip.
 */
export function TourOverlay(): ReactNode {
  const { active, index, stops, current, detailed, next, previous, exit, restart } = useTour();
  const { dataMode } = useSession();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [narration, setNarration] = useState<Readonly<Record<string, StopNarration>> | null>(null);

  useEffect(() => {
    if (!active || narration) return;

    let cancelled = false;
    void import('@/lib/demo/tour-narration').then((module) => {
      if (!cancelled) setNarration(module.TOUR_NARRATION);
    });

    return () => {
      cancelled = true;
    };
  }, [active, narration]);

  useEffect(() => {
    if (!active) return;
    headingRef.current?.focus();
  }, [active, index]);

  useEffect(() => {
    if (!active) return;

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') exit();
    };

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [active, exit]);

  if (!active || !current) return null;

  const first = index === 0;
  const last = index === stops.length - 1;
  const text = narration?.[current.id];

  return (
    <section
      aria-label="روایت هدایت‌شدهٔ سرمایه‌گذار"
      data-testid="tour-overlay"
      className="sticky bottom-0 z-40 border-t-2 border-[var(--pri)] bg-[var(--surf)] shadow-[var(--sh2)]"
    >
      <div className="mx-auto flex max-w-5xl flex-col gap-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="primary">
            گام {formatInteger(index + 1)} از {formatInteger(stops.length)}
          </Badge>

          {/* The status comes from the capability registry, so the tour cannot
              claim something the dashboard denies. */}
          <CapabilityBadge state={current.capability.state} />

          {isFixtureMode(dataMode) ? (
            <Badge tone="warning">این صفحه با دادهٔ نمایشی پر شده است</Badge>
          ) : null}
        </div>

        <h2
          ref={headingRef}
          tabIndex={-1}
          aria-live="polite"
          className="text-lg font-extrabold text-[var(--tx)] outline-none sm:text-xl"
        >
          {/* The capability's own title until the narration lands, so the
              panel never renders empty or shifts height when it arrives. */}
          {text?.headline ?? current.capability.title}
        </h2>

        <p className="text-sm leading-relaxed text-[var(--tx2)]">
          {text ? (detailed ? text.detail : text.compact) : current.capability.summary}
        </p>

        <TourProgress index={index} total={stops.length} />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={previous} disabled={first}>
              گام پیشین
            </Button>
            <Button onClick={next} disabled={last}>
              گام بعدی
            </Button>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={restart}>
              از ابتدا
            </Button>
            <Button variant="secondary" onClick={exit}>
              پایان روایت (Esc)
            </Button>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * A bar, not a list of clickable dots.
 *
 * At 360px a dot per step is under the 44px touch target the accessibility
 * requirement sets, and eleven of them would wrap into two rows of targets too
 * small to hit. Progress is information here, not navigation — the buttons are
 * the navigation, and the jump-to-step control lives on the entry page where
 * there is room for it.
 */
function TourProgress({ index, total }: { index: number; total: number }): ReactNode {
  return (
    <div className="flex gap-1" role="img" aria-label={`پیشرفت: گام ${index + 1} از ${total}`}>
      {Array.from({ length: total }, (_, position) => (
        <span
          key={position}
          aria-hidden="true"
          className={cx(
            'h-1.5 flex-1 rounded-full',
            position <= index ? 'bg-[var(--pri)]' : 'bg-[var(--bd2)]',
          )}
        />
      ))}
    </div>
  );
}
