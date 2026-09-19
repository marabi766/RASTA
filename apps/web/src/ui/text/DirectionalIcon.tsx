import type { ReactNode } from 'react';

import { cn } from '../cn';

/**
 * An icon that points somewhere, mirrored for the writing direction.
 *
 * docs/16 § 16.3 puts it plainly: *«آیکون‌های جهت‌دار در RTL آینه می‌شوند — فلش
 * «بعدی» به چپ اشاره می‌کند.»* An arrow is not decoration; it means "onward",
 * and onward in a right-to-left document is to the left. An unmirrored "next"
 * chevron in this portal points back the way the reader came.
 *
 * The flip is `rtl:-scale-x-100`, which reads the document's direction rather
 * than a prop, so the same element is correct in a Persian page and in a Latin
 * one without a component knowing which it is in.
 *
 * It is only for icons that carry direction: a chevron, an arrow, an undo
 * curve, a send paper-plane. A search glass or a trash can mirrored for no
 * reason just looks wrong, which is why this is a wrapper a caller opts into
 * rather than something applied to every icon.
 */
export function DirectionalIcon({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span aria-hidden="true" className={cn('inline-flex rtl:-scale-x-100', className)}>
      {children}
    </span>
  );
}
