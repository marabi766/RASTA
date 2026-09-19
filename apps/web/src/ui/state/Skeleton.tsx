import { cn } from '../cn';

/**
 * A placeholder shaped like the content that is coming.
 *
 * It is `aria-hidden` and carries no text. A screen reader should hear the one
 * "در حال بارگذاری" that `LoadingState` announces, not one per placeholder bar.
 *
 * The pulse is a Tailwind animation, which the reduced-motion rule in
 * `globals.css` already reduces to nothing for anyone who has asked their
 * system for that.
 */

const HEIGHTS = {
  text: 'h-4',
  heading: 'h-7',
  row: 'h-12',
  card: 'h-24',
} as const;

const WIDTHS = {
  full: 'w-full',
  half: 'w-1/2',
  third: 'w-1/3',
  quarter: 'w-1/4',
} as const;

export function Skeleton({
  height = 'text',
  width = 'full',
  className,
}: {
  height?: keyof typeof HEIGHTS;
  width?: keyof typeof WIDTHS;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'animate-pulse rounded-md bg-surface-sunken',
        HEIGHTS[height],
        WIDTHS[width],
        className,
      )}
    />
  );
}
