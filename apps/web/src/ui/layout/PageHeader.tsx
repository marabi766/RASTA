import type { ReactNode } from 'react';

import { cn } from '../cn';

/**
 * The title block at the top of a page.
 *
 * It renders the page's single `<h1>`. A page with two first-level headings
 * has no answer to "what is this page", and a page with none leaves a screen
 * reader announcing the document title and nothing else.
 *
 * The breadcrumb slot sits above the title because that is its reading order
 * in a right-to-left document as much as a left-to-right one: context first,
 * then the thing itself.
 */
export function PageHeader({
  title,
  description,
  breadcrumb,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  breadcrumb?: ReactNode;
  /** Primary actions for the page — "new request", "export". */
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('flex flex-col gap-3', className)}>
      {breadcrumb}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold text-content">{title}</h1>
          {description ? (
            <p className="text-base leading-relaxed text-content-muted">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}
