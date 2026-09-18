import { cn } from '../cn';
import { Skeleton } from './Skeleton';

/**
 * The loading half of the three states docs/16 § 16.4 makes mandatory.
 *
 * The document is specific about the shape: *«Skeleton هم‌شکل با محتوای نهایی،
 * نه Spinner وسط صفحه»*. A spinner says only that something is happening. A
 * skeleton that matches the layout tells a user what is about to arrive and,
 * because it occupies the same space, stops the page jumping under their
 * finger when it does.
 *
 * `aria-busy` with a polite live region is the announced half. It is polite
 * rather than assertive because a load is not an emergency — interrupting
 * someone mid-sentence to say a table is loading is worse than telling them a
 * moment later.
 *
 * `variant` exists so the shape can match what is coming rather than being one
 * generic block. A list of records looks nothing like a page of form fields,
 * and a skeleton that pretends otherwise reintroduces the jump it was meant to
 * prevent.
 */
export function LoadingState({
  variant = 'list',
  rows = 3,
  label = 'در حال بارگذاری',
  className,
}: {
  variant?: 'list' | 'table' | 'cards' | 'form';
  /** How many repeated shapes to draw. Match the page size you expect. */
  rows?: number;
  label?: string;
  className?: string;
}) {
  const items = Array.from({ length: Math.max(1, rows) }, (_, index) => index);

  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      className={cn('flex flex-col gap-3', className)}
    >
      {/* The only text in the component, and the only thing announced. */}
      <span className="sr-only">{label}</span>

      {variant === 'table' ? (
        <>
          <Skeleton height="text" width="quarter" />
          {items.map((index) => (
            <Skeleton key={index} height="row" />
          ))}
        </>
      ) : null}

      {variant === 'list'
        ? items.map((index) => (
            <div key={index} className="flex flex-col gap-2">
              <Skeleton height="text" width="third" />
              <Skeleton height="text" width="full" />
            </div>
          ))
        : null}

      {variant === 'cards' ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((index) => (
            <Skeleton key={index} height="card" />
          ))}
        </div>
      ) : null}

      {variant === 'form'
        ? items.map((index) => (
            <div key={index} className="flex flex-col gap-2">
              <Skeleton height="text" width="quarter" />
              <Skeleton height="row" />
            </div>
          ))
        : null}
    </div>
  );
}
