import type { ReactNode } from 'react';

/**
 * A wide table that scrolls inside its own box.
 *
 * Without it a table wider than the screen makes the **page** scroll
 * sideways: on a phone, everything after it — the pager, the next section — is
 * reached by dragging, and the page's own header slides out of view. With it
 * the page keeps the width of the screen and only this region moves, which is
 * what a person expects of a table.
 *
 * It is a keyboard stop (`tabIndex={0}`) because a scrollable region nobody
 * can reach with a keyboard is an accessibility failure in its own right (WCAG
 * 2.1.1; axe's `scrollable-region-focusable`), and it carries a name because a
 * focusable element with none is announced as nothing. A `group` rather than a
 * `region`: a page of tables would otherwise become a page of landmarks.
 *
 * The scrolling is horizontal only, so the direction is the reading direction:
 * in a right-to-left page the first column starts at the right edge and the
 * rest is reached by scrolling left, with no per-direction code here.
 */
export function TableScroll({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      role="group"
      aria-label={label}
      // The one place this rule is wrong: the element is not interactive, but it
      // *scrolls*, and WCAG 2.1.1 (axe `scrollable-region-focusable`) requires
      // anything that scrolls to be reachable from a keyboard. Without the stop
      // the overflowing columns are unreachable without a pointer.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      className="overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
    >
      {children}
    </div>
  );
}
