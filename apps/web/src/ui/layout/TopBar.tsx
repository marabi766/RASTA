import type { ReactNode } from 'react';

import { cn } from '../cn';

/**
 * The bar across the top of the application shell.
 *
 * `<header role="banner">` is implicit for a header that is not inside another
 * landmark, and it is what lets assistive technology offer "skip to the
 * banner". The organisation name lives here because every screen in a
 * multi-tenant product has to answer "whose data am I looking at" without the
 * user having to go and check.
 */
export function TopBar({
  organizationName,
  children,
  className,
}: {
  /** Which tenant's data is on screen. */
  organizationName?: ReactNode;
  /** Account menu, notifications, search. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        'flex items-center justify-between gap-4 border-b border-border bg-surface-raised px-4 py-3',
        className,
      )}
    >
      <div className="flex items-center gap-3">
        <span className="text-base font-bold text-content">رستا</span>
        {organizationName ? (
          <>
            <span aria-hidden="true" className="text-content-subtle">
              /
            </span>
            <span className="text-sm text-content-muted">{organizationName}</span>
          </>
        ) : null}
      </div>
      {children ? <div className="flex items-center gap-2">{children}</div> : null}
    </header>
  );
}
