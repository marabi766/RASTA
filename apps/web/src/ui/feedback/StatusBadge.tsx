import { AlertTriangle, Ban, CheckCircle2, CircleDashed, Wrench } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '../cn';

/**
 * The platform's visual language for status.
 *
 * docs/16 § 16.5 fixes the mapping: every status has one colour and one symbol,
 * the same on every screen. That is the whole value of the component — a user
 * who learns "red outline means refused" on the orders screen should not have
 * to learn it again on contracts.
 *
 * A symbol accompanies the colour on purpose. WCAG 1.4.1 forbids colour as the
 * only carrier of meaning, and roughly one man in twelve cannot separate the
 * success green from the danger red at a glance.
 *
 * The **colour** is fixed by the document. The **label** is presentation and a
 * caller may override it — a status means the same thing everywhere, but the
 * word a particular screen uses for it is that screen's business.
 */

const TONES = {
  success: {
    className: 'bg-success-surface text-success-text',
    Icon: CheckCircle2,
  },
  warning: {
    className: 'bg-warning-surface text-warning-text',
    Icon: AlertTriangle,
  },
  danger: {
    className: 'bg-danger-surface text-danger-text',
    Icon: Ban,
  },
  info: {
    className: 'bg-info-surface text-info-text',
    Icon: Wrench,
  },
  neutral: {
    className: 'bg-muted-surface text-muted-text',
    Icon: CircleDashed,
  },
} as const;

export type StatusTone = keyof typeof TONES;

/**
 * The statuses docs/16 § 16.5 tabulates, with the tone each one carries.
 *
 * A status that is not in this table is shown as `neutral` rather than being
 * refused: an unknown status is a sign that a service has moved ahead of the
 * portal, and a badge that renders plainly is a better outcome than a screen
 * that throws.
 */
export const STATUS_TONES: Readonly<Record<string, StatusTone>> = {
  ACTIVE: 'success',
  APPROVED: 'success',
  COMPLETED: 'success',
  SETTLED: 'success',
  // An assigned machine is a working machine. EXP-002 added the three asset
  // statuses docs/16 § 16.5 had not tabulated; the table there now names them.
  ASSIGNED: 'success',

  PENDING_APPROVAL: 'warning',
  BID_OPEN: 'warning',
  IN_PROGRESS: 'warning',
  // A maintenance request just reported, not yet referred anywhere — the
  // status a fleet manager most needs to notice (EXP-002).
  OPEN: 'warning',

  REJECTED: 'danger',
  CANCELLED: 'danger',
  FAILED: 'danger',
  OUT_OF_SERVICE: 'danger',
  // Terminal: the machine is gone from service for good, which is closer to
  // "refused" than to "idle" for somebody scanning a list for something to use.
  DECOMMISSIONED: 'danger',

  DRAFT: 'neutral',
  IDLE: 'neutral',
  // Registered but not yet commissioned — on the books, not in service.
  REGISTERED: 'neutral',

  IN_MAINTENANCE: 'info',
  EVALUATION: 'info',
};

/** Default Persian wording. Presentation only; `label` overrides it. */
const STATUS_LABELS: Readonly<Record<string, string>> = {
  ACTIVE: 'فعال',
  APPROVED: 'تأییدشده',
  COMPLETED: 'تکمیل‌شده',
  SETTLED: 'تسویه‌شده',
  PENDING_APPROVAL: 'در انتظار تأیید',
  BID_OPEN: 'پذیرش پیشنهاد',
  IN_PROGRESS: 'در جریان',
  REJECTED: 'ردشده',
  CANCELLED: 'لغوشده',
  FAILED: 'ناموفق',
  OUT_OF_SERVICE: 'خارج از سرویس',
  DRAFT: 'پیش‌نویس',
  IDLE: 'بیکار',
  REGISTERED: 'ثبت‌شده',
  ASSIGNED: 'تخصیص‌یافته',
  DECOMMISSIONED: 'از رده خارج',
  IN_MAINTENANCE: 'در تعمیر',
  EVALUATION: 'در ارزیابی',
  OPEN: 'باز',
};

export function StatusBadge({
  status,
  label,
  className,
}: {
  /** The status as the API sends it — Latin, upper snake case. */
  status: string;
  /** Overrides the default wording. */
  label?: ReactNode;
  className?: string;
}) {
  const tone = STATUS_TONES[status] ?? 'neutral';
  const { className: toneClassName, Icon } = TONES[tone];

  return (
    <span
      data-status={status}
      data-tone={tone}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium',
        toneClassName,
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {label ?? STATUS_LABELS[status] ?? status}
    </span>
  );
}
