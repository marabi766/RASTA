import type { ReactNode } from 'react';

import { cn } from '../cn';

/**
 * A titled region of a page.
 *
 * The heading and the region are tied together with `aria-labelledby` rather
 * than left as two unrelated elements. That is what lets a screen-reader user
 * jump between regions and hear what each one is, which on a dense operations
 * screen is the difference between navigable and unusable.
 *
 * `headingId` is required for that reason: a caller cannot accidentally create
 * an unlabelled region, and two sections on one page cannot collide on an id.
 */
export function Section({
  headingId,
  title,
  description,
  actions,
  children,
  className,
}: {
  headingId: string;
  title: ReactNode;
  description?: ReactNode;
  /** Controls that act on this section — a filter, an "add" button. */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        'flex flex-col gap-4 rounded-lg border border-border bg-surface-raised p-6 shadow-sm',
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h2 id={headingId} className="text-lg font-semibold text-content">
            {title}
          </h2>
          {description ? <p className="text-sm text-content-muted">{description}</p> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}
