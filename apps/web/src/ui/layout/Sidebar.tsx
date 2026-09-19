import type { ReactNode } from 'react';

import { cn } from '../cn';

export interface SidebarItem {
  readonly href: string;
  readonly label: string;
  readonly icon?: ReactNode;
}

/**
 * The application's primary navigation.
 *
 * Three things here are accessibility requirements rather than preferences,
 * and each is the kind that is invisible until someone cannot use the product:
 *
 *   - `<nav aria-label>`. A page has more than one navigation landmark, and an
 *     unlabelled one is announced as "navigation" with no way to tell which.
 *   - `aria-current="page"`. Colour alone marks the active item for everyone
 *     who can see it and for nobody who cannot.
 *   - `aria-hidden` on the icon. It repeats the label beside it, and a screen
 *     reader that reads both says everything twice.
 *
 * The border sits on the inline-start edge through a logical property, so it
 * lands on the right in this Persian document and on the left in a Latin one
 * without the component knowing which it is in.
 */
export function Sidebar({
  items,
  currentHref,
  label = 'ناوبری اصلی',
  className,
}: {
  items: readonly SidebarItem[];
  /** The route being shown. Compared exactly; the caller owns the matching. */
  currentHref?: string;
  label?: string;
  className?: string;
}) {
  return (
    <nav
      aria-label={label}
      className={cn('flex flex-col gap-1 border-e border-border bg-surface-raised p-3', className)}
    >
      {items.map((item) => {
        const current = item.href === currentHref;
        return (
          <a
            key={item.href}
            href={item.href}
            aria-current={current ? 'page' : undefined}
            className={cn(
              'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
              current
                ? 'bg-accent text-accent-text font-medium'
                : 'text-content-muted hover:bg-surface-sunken hover:text-content',
            )}
          >
            {item.icon ? (
              <span aria-hidden="true" className="flex shrink-0 items-center">
                {item.icon}
              </span>
            ) : null}
            {item.label}
          </a>
        );
      })}
    </nav>
  );
}
