'use client';

import type { ReactNode } from 'react';
import type { ApiFailure } from '@/lib/api/errors';
import type { Resource, ResourceState } from '@/lib/use-api-resource';
import { ApiErrorView } from '../api-error';
import { Card, EmptyState, LoadingState, cx } from './primitives';

/**
 * The four states, in one place.
 *
 * docs/16 § 16.4 makes loading, empty and error mandatory on every data view
 * and says a view with only a success path is incomplete and does not merge.
 * Writing that branch out on each of a dozen screens is how one of them
 * quietly ends up with three states instead of four, so it is written once.
 *
 * `DataView` renders the success case through a child function, which keeps the
 * data typed all the way through rather than widening to `unknown` at the
 * boundary.
 */
export function DataView<T>({
  resource,
  context,
  loadingLabel,
  loadingRows = 3,
  empty,
  children,
}: {
  resource: Resource<T>;
  /** What the reader was trying to see, used in the failure heading. */
  context: string;
  loadingLabel: string;
  loadingRows?: number;
  /** Shown when the child reports nothing to render. */
  empty?: { title: string; description?: ReactNode };
  children: (data: T) => ReactNode;
}): ReactNode {
  const { state, reload } = resource;

  if (state.status === 'loading') {
    return <LoadingState rows={loadingRows} label={loadingLabel} />;
  }

  if (state.status === 'error') {
    return <ApiErrorView failure={state.failure} onRetry={reload} context={context} />;
  }

  if (empty && isEmpty(state.data)) {
    return <EmptyState title={empty.title} description={empty.description} />;
  }

  return <>{children(state.data)}</>;
}

function isEmpty(data: unknown): boolean {
  return Array.isArray(data) && data.length === 0;
}

/** Narrows a resource state to its failure, for callers that branch manually. */
export function failureOf<T>(state: ResourceState<T>): ApiFailure | null {
  return state.status === 'error' ? state.failure : null;
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export interface Column<T> {
  readonly key: string;
  readonly header: string;
  /** The first column becomes the row header cell, so it should identify the row. */
  readonly render: (row: T) => ReactNode;
  readonly align?: 'start' | 'end';
}

/**
 * A read-only table.
 *
 * Wide content scrolls inside its own container rather than pushing the page
 * sideways — a horizontal document scrollbar is the classic RTL regression and
 * the browser tests assert against it.
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  caption,
  minWidth = '46rem',
}: {
  rows: readonly T[];
  columns: ReadonlyArray<Column<T>>;
  rowKey: (row: T) => string;
  caption: ReactNode;
  minWidth?: string;
}): ReactNode {
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full border-collapse text-sm" style={{ minWidth }}>
        <caption className="p-4 text-start text-xs text-[var(--tx3)]">{caption}</caption>
        <thead>
          <tr className="border-b border-[var(--bd)] text-xs text-[var(--tx3)]">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={cx(
                  'p-3 font-semibold',
                  column.align === 'end' ? 'text-end' : 'text-start',
                )}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className="border-b border-[var(--bd)] last:border-b-0">
              {columns.map((column, index) =>
                index === 0 ? (
                  <th
                    key={column.key}
                    scope="row"
                    className="p-3 text-start font-semibold text-[var(--tx)]"
                  >
                    {column.render(row)}
                  </th>
                ) : (
                  <td
                    key={column.key}
                    className={cx('p-3', column.align === 'end' ? 'text-end' : 'text-start')}
                  >
                    {column.render(row)}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Description list
// ---------------------------------------------------------------------------

export function DescriptionList({
  items,
  columns = 2,
}: {
  items: ReadonlyArray<{ term: string; value: ReactNode }>;
  columns?: 1 | 2 | 3;
}): ReactNode {
  return (
    <dl
      className={cx(
        'grid gap-x-6 gap-y-3 text-sm',
        columns === 1 ? 'grid-cols-1' : columns === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-3',
      )}
    >
      {items.map((item) => (
        <div key={item.term} className="min-w-0">
          <dt className="text-xs text-[var(--tx3)]">{item.term}</dt>
          <dd className="mt-0.5 break-words text-[var(--tx)]">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A Latin identifier inside Persian prose, isolated so its punctuation holds. */
export function Code({ children }: { children: ReactNode }): ReactNode {
  return (
    <span dir="ltr" className="rasta-code">
      {children}
    </span>
  );
}

/** A value the contract may legitimately not carry. Never rendered as zero. */
export function Maybe({ value }: { value: ReactNode }): ReactNode {
  return value === null || value === undefined || value === '' ? (
    <span className="text-[var(--tx3)]">—</span>
  ) : (
    <>{value}</>
  );
}

export function Section({
  title,
  description,
  children,
  id,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  id?: string;
}): ReactNode {
  const headingId = id ?? `section-${title}`;

  return (
    <section aria-labelledby={headingId} className="mb-8">
      <h2 id={headingId} className="mb-1 text-lg font-bold text-[var(--tx)]">
        {title}
      </h2>
      {description ? <p className="mb-3 text-sm text-[var(--tx2)]">{description}</p> : null}
      {children}
    </section>
  );
}
