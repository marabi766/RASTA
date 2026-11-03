'use client';

import { useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode } from 'react';

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
 * ## Collapsing on a phone
 *
 * Below the `md` breakpoint the shell stacks the navigation above the page,
 * and sixteen links in a column filled the whole first screen of every page
 * (demo run 2026-10-24). There the list sits behind a disclosure button; from
 * `md` up it is always shown and the button is not drawn.
 *
 * **Without JavaScript the list is simply visible.** The server renders the
 * links with no button and no `hidden` class; the button and the collapsed
 * state appear only once the component has hydrated (`useHydrated`), so a
 * browser that never runs the script keeps a complete, reachable navigation
 * instead of a closed menu it cannot open.
 *
 * The button is a real `<button>` with a fixed accessible name,
 * `aria-expanded` and `aria-controls`; the closed list is `display: none`, so
 * it is also out of the tab order and the accessibility tree. Escape closes an
 * open menu from anywhere inside it and returns focus to the button, so
 * a keyboard user is never left on a link that has just disappeared. The
 * links are the same `items` in the same order whatever the state: what a
 * person is offered is decided by the caller (`portalNavForSession`), not here.
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
  const hydrated = useHydrated();
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);

  // Collapsed only when there is a button to open it again.
  const collapsed = hydrated && !open;

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Escape' || !open) return;
    event.stopPropagation();
    setOpen(false);
    toggle.current?.focus();
  }

  return (
    // Escape is handled where the keystroke bubbles to, so it works from the
    // button and from any link in the list; the element itself is not interactive.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <nav
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn(
        'flex flex-col gap-1 border-b border-border bg-surface-raised p-3 md:border-b-0 md:border-e',
        className,
      )}
    >
      {hydrated ? (
        <button
          ref={toggle}
          type="button"
          aria-expanded={open}
          aria-controls={LIST_ID}
          onClick={() => setOpen((value) => !value)}
          className="flex items-center justify-between gap-2 rounded-md border border-border-strong px-3 py-2 text-sm font-medium text-content focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus md:hidden"
        >
          منوی ناوبری
          <span aria-hidden="true">{open ? '▴' : '▾'}</span>
        </button>
      ) : null}
      <div id={LIST_ID} className={cn('flex-col gap-1 md:flex', collapsed ? 'hidden' : 'flex')}>
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
      </div>
    </nav>
  );
}

/** One primary navigation per page (the shell has a single sidebar slot), so one fixed id. */
const LIST_ID = 'sidebar-links';

const subscribeNever = () => () => undefined;

/** False on the server and during hydration, true once the client has taken over. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
}
