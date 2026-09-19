import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../cn';

/**
 * A message about the state of the page.
 *
 * The `role` is the part that matters and the part most often wrong. An alert
 * a user must act on now is `role="alert"`, which interrupts a screen reader
 * mid-sentence; anything else is `role="status"`, which waits for a pause.
 * Making every message an alert trains people to ignore all of them, so only
 * `danger` and `warning` interrupt here.
 *
 * The heading level is the caller's, because an alert's place in the document
 * outline depends on where the caller put it, and a component that guessed
 * would break the outline on half the screens that used it.
 */

const TONES = {
  success: {
    className: 'bg-success-surface text-success-text border-success',
    Icon: CheckCircle2,
    role: 'status',
  },
  info: {
    className: 'bg-info-surface text-info-text border-info',
    Icon: Info,
    role: 'status',
  },
  warning: {
    className: 'bg-warning-surface text-warning-text border-warning',
    Icon: AlertTriangle,
    role: 'alert',
  },
  danger: {
    className: 'bg-danger-surface text-danger-text border-danger',
    Icon: XCircle,
    role: 'alert',
  },
} as const;

export type AlertTone = keyof typeof TONES;

export function Alert({
  tone = 'info',
  title,
  children,
  actions,
  className,
}: {
  tone?: AlertTone;
  title?: ReactNode;
  children: ReactNode;
  /** A way out of the situation the alert describes. */
  actions?: ReactNode;
  className?: string;
}) {
  const { className: toneClassName, Icon, role } = TONES[tone];

  return (
    <div
      role={role}
      className={cn(
        'flex items-start gap-3 rounded-lg border-s-4 p-4 text-sm',
        toneClassName,
        className,
      )}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
      <div className="flex flex-1 flex-col gap-2">
        {title ? <p className="font-semibold">{title}</p> : null}
        <div className="leading-relaxed">{children}</div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
