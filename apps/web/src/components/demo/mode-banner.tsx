'use client';

import type { ReactNode } from 'react';
import { FIXTURE_DISCLOSURE, LIVE_DISCLOSURE, isFixtureMode } from '@/lib/demo/mode';
import { useSession } from '@/lib/auth/session';
import { Badge } from '../ui/primitives';

/**
 * Which data source the viewer is looking at.
 *
 * ## Why the fixture banner is persistent and the live one is not
 *
 * They are not symmetrical claims. "This is real data" is the default a viewer
 * already assumes, so stating it is a courtesy. "This is invented data" is
 * information the viewer cannot recover from the screen — the fixtures are
 * deliberately coherent, which is exactly what makes them indistinguishable
 * from real ones at a glance. So the fixture banner sits above the content on
 * every page, cannot be dismissed, and says so in plain Persian.
 *
 * The live indicator is a quiet chip in the toolbar instead, because a
 * permanent bar announcing "this is real" on a live deployment would be noise
 * that people learn to stop reading — and a banner people stop reading is worse
 * than none when it eventually needs to say something different.
 */
export function DemoModeBanner(): ReactNode {
  const { dataMode } = useSession();

  if (!isFixtureMode(dataMode)) return null;

  return (
    <div
      role="note"
      aria-live="polite"
      data-testid="fixture-disclosure"
      className="border-b border-[var(--warn)] bg-[var(--warn-soft)] px-4 py-2.5 text-center text-sm font-bold text-[var(--warn-tx)] sm:px-6"
    >
      {FIXTURE_DISCLOSURE}
    </div>
  );
}

/** The compact indicator, for the presentation toolbar. */
export function DemoModeChip(): ReactNode {
  const { dataMode } = useSession();
  const fixture = isFixtureMode(dataMode);

  return (
    <Badge
      tone={fixture ? 'warning' : 'success'}
      title={fixture ? FIXTURE_DISCLOSURE : LIVE_DISCLOSURE}
    >
      <span>{fixture ? 'دادهٔ نمایشی' : 'دادهٔ زنده'}</span>
      <span dir="ltr" className="rasta-code opacity-70">
        {fixture ? 'FIXTURE' : 'LIVE'}
      </span>
    </Badge>
  );
}
