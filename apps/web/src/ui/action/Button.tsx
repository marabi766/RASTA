import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from 'react';

import { cn } from '../cn';

export type ButtonTone = 'primary' | 'secondary' | 'quiet';

/**
 * The one place a control's appearance is decided.
 *
 * Two elements share it on purpose. A link that navigates must be an `<a>`,
 * because middle-click, "open in new tab" and the browser's own status bar all
 * come from the element rather than from how it looks; a control that performs
 * an action must be a `<button>`, because that is what a keyboard and a screen
 * reader expect to activate. Styling them from one table is what stops the two
 * drifting apart visually while staying correct semantically.
 *
 * The focus ring is not optional and not overridable. `docs/16 § 16.9` follows
 * WCAG 2.1 AA, and a control nobody can see they have focused is a control
 * nobody can use from a keyboard.
 */
const TONES: Record<ButtonTone, string> = {
  primary: 'bg-accent text-accent-text hover:bg-accent-hover',
  secondary: 'border border-border-strong bg-surface-raised text-content hover:bg-surface-sunken',
  quiet: 'text-accent-on-surface hover:bg-surface-sunken',
};

const BASE =
  'inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-bold ' +
  'transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-focus disabled:cursor-not-allowed disabled:opacity-60';

export function Button({
  tone = 'primary',
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: ButtonTone; children?: ReactNode }) {
  return (
    <button {...props} className={cn(BASE, TONES[tone], className)}>
      {children}
    </button>
  );
}

export function ButtonLink({
  tone = 'primary',
  className,
  children,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { tone?: ButtonTone; children?: ReactNode }) {
  return (
    <a {...props} className={cn(BASE, TONES[tone], className)}>
      {children}
    </a>
  );
}
