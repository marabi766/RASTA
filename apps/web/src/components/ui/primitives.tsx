import type { ReactNode } from 'react';

/**
 * The smallest set of shared surfaces the portal needs.
 *
 * Deliberately small. docs/16 § 16.4 lists a full component library, and
 * building all of it before there are screens to use it would be guessing at
 * APIs. What is here is what this milestone's screens actually consume; the
 * next one extracts more as real second uses appear.
 */

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(' ');
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function Card({
  children,
  className,
  as: Element = 'div',
}: {
  children: ReactNode;
  className?: string;
  as?: 'div' | 'article' | 'section' | 'li';
}): ReactNode {
  return (
    <Element
      className={cx(
        'rounded-[var(--radius-lg)] border border-[var(--bd)] bg-[var(--surf)] p-4 shadow-[var(--sh1)] sm:p-5',
        className,
      )}
    >
      {children}
    </Element>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}): ReactNode {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="max-w-2xl">
        <h1 className="text-2xl font-extrabold tracking-tight text-[var(--tx)]">{title}</h1>
        {description ? <p className="mt-2 text-sm text-[var(--tx2)]">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

const BUTTON_BASE =
  'inline-flex min-h-[var(--tap)] items-center justify-center gap-2 rounded-[var(--radius-md)] ' +
  'px-4 text-sm font-semibold transition-colors duration-150 ' +
  'disabled:cursor-not-allowed disabled:opacity-60';

const BUTTON_VARIANTS = {
  primary: 'bg-[var(--pri)] text-white hover:bg-[var(--pri-h)]',
  secondary:
    'border border-[var(--control-border)] bg-[var(--surf)] text-[var(--tx)] hover:bg-[var(--sunken)]',
  quiet: 'text-[var(--pri-tx)] hover:bg-[var(--pri-soft)]',
} as const;

export type ButtonVariant = keyof typeof BUTTON_VARIANTS;

export function Button({
  children,
  onClick,
  variant = 'primary',
  type = 'button',
  disabled,
  className,
  ariaLabel,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: ButtonVariant;
  type?: 'button' | 'submit';
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}): ReactNode {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      className={cx(BUTTON_BASE, BUTTON_VARIANTS[variant], className)}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Badges
// ---------------------------------------------------------------------------

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'primary';

const TONE_CLASSES: Record<Tone, string> = {
  success: 'bg-[var(--ok-soft)] text-[var(--ok-tx)] border-[var(--ok)]',
  warning: 'bg-[var(--warn-soft)] text-[var(--warn-tx)] border-[var(--warn)]',
  danger: 'bg-[var(--dgr-soft)] text-[var(--dgr-tx)] border-[var(--dgr)]',
  info: 'bg-[var(--info-soft)] text-[var(--info-tx)] border-[var(--info)]',
  neutral: 'bg-[var(--neu-soft)] text-[var(--tx2)] border-[var(--bd2)]',
  primary: 'bg-[var(--pri-soft)] text-[var(--pri-tx)] border-[var(--pri)]',
};

/**
 * A status chip.
 *
 * `label` is always present. docs/16 § 16.9: «هرگز رنگ به‌تنهایی حامل معنا
 * نیست» — a colour-only signal is invisible to a colour-blind reader and to a
 * screen reader alike.
 */
export function Badge({
  tone = 'neutral',
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string;
}): ReactNode {
  return (
    <span
      title={title}
      className={cx(
        'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold',
        TONE_CLASSES[tone],
      )}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The four states every data view owes the reader (docs/16 § 16.4)
// ---------------------------------------------------------------------------

/**
 * A skeleton shaped like the content that will replace it.
 *
 * Not a centred spinner: docs/16 § 16.4 asks for «Skeleton هم‌شکل با محتوای
 * نهایی», because a layout that jumps when data arrives is a layout shift, and
 * CLS is a stated budget (§ 16.10).
 */
export function LoadingState({ rows = 3, label }: { rows?: number; label: string }): ReactNode {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="space-y-3">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          aria-hidden="true"
          className="h-16 rounded-[var(--radius-md)] bg-[var(--sunken)]"
          style={{ animation: 'rasta-skeleton 1.6s ease-in-out infinite' }}
        />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
}): ReactNode {
  return (
    <Card className="text-center">
      <p className="text-base font-bold text-[var(--tx)]">{title}</p>
      {description ? (
        <p className="mx-auto mt-2 max-w-md text-sm text-[var(--tx2)]">{description}</p>
      ) : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </Card>
  );
}

/**
 * A failure the reader can act on.
 *
 * The correlation id is not decoration. It is the same id the gateway put on
 * the request and every service logged against it, so quoting it to support
 * turns "the page broke" into one trace lookup (docs/16 § 16.4, § 16.11).
 */
export function ErrorState({
  title,
  message,
  correlationId,
  onRetry,
  retryLabel = 'تلاش دوباره',
}: {
  title: string;
  message: string;
  correlationId?: string | null;
  onRetry?: () => void;
  retryLabel?: string;
}): ReactNode {
  return (
    <Card className="border-[var(--dgr)]">
      <div role="alert" className="space-y-3">
        <p className="text-base font-bold text-[var(--dgr-tx)]">{title}</p>
        <p className="text-sm text-[var(--tx)]">{message}</p>
        {correlationId ? (
          <p className="text-xs text-[var(--tx3)]">
            شناسهٔ پیگیری:{' '}
            <span dir="ltr" className="rasta-code">
              {correlationId}
            </span>
          </p>
        ) : null}
        {onRetry ? (
          <Button variant="secondary" onClick={onRetry}>
            {retryLabel}
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

/** Refused on purpose. A role without permission is not an error. */
export function NoAccessState({
  title,
  description,
}: {
  title: string;
  description: ReactNode;
}): ReactNode {
  return (
    <Card className="border-[var(--warn)]">
      <p className="text-base font-bold text-[var(--warn-tx)]">{title}</p>
      <p className="mt-2 text-sm text-[var(--tx2)]">{description}</p>
    </Card>
  );
}

/**
 * The label any non-operational surface must carry.
 *
 * Required wording, not a suggestion: a mockup shown without it is
 * indistinguishable from a working feature in a screenshot, and a screenshot is
 * how an investor demo travels.
 */
export function PreviewDisclosure({ children }: { children?: ReactNode }): ReactNode {
  return (
    <div
      role="note"
      className="rounded-[var(--radius-md)] border border-[var(--warn)] bg-[var(--warn-soft)] px-4 py-3 text-xs font-semibold text-[var(--warn-tx)]"
    >
      <p>PREVIEW — داده نمایشی، عملیات واقعی نیست</p>
      {children ? <p className="mt-1 font-normal">{children}</p> : null}
    </div>
  );
}
