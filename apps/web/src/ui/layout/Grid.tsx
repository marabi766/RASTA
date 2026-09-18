import type { ReactNode } from 'react';

import { cn } from '../cn';

/**
 * A responsive column grid.
 *
 * The column counts are a closed set rather than a number a caller passes,
 * because Tailwind generates utilities from the classes it can see in the
 * source: `grid-cols-${columns}` would produce a class that exists in the
 * markup and not in the stylesheet, and the layout would silently collapse to
 * one column in production while looking right in development.
 *
 * Every step starts at one column. docs/16 § 16.2 expects this portal on a
 * phone in the field far more often than on a desk, so the narrow case is the
 * default and the wider ones are the additions.
 */
const COLUMNS = {
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4',
} as const;

export function Grid({
  columns = 3,
  children,
  className,
}: {
  columns?: keyof typeof COLUMNS;
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn('grid gap-4', COLUMNS[columns], className)}>{children}</div>;
}
