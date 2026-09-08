import Link from 'next/link';
import type { ReactNode } from 'react';
import type { Capability, CapabilityState, ReadinessReason } from '@/lib/capabilities';
import { Badge, Card, type Tone } from './ui/primitives';

/**
 * How a capability's status is written on screen.
 *
 * The label is Persian and the state name is kept alongside it in Latin,
 * because the state is what a reviewer greps for in this repository and what
 * the report cites. The description is the sentence that has to survive an
 * investor asking "so does it work?" — each one answers that literally.
 */
export const STATE_PRESENTATION: Record<
  CapabilityState,
  { label: string; tone: Tone; description: string }
> = {
  LIVE: {
    label: 'فعال',
    tone: 'success',
    description: 'به یک API پیاده‌شده وصل است و در همین نسخه واقعاً فراخوانی می‌شود.',
  },
  BETA: {
    label: 'ناقص',
    tone: 'warning',
    description: 'بخشی از دامنه در Backend پیاده و Merge شده؛ فاز بعدی هنوز شروع نشده است.',
  },
  BACKEND_READY: {
    label: 'آمادهٔ Backend',
    tone: 'info',
    description:
      'سرویس و قرارداد API آن پیاده و تأیید شده است، اما صفحهٔ آن در این نسخه ساخته نشده.',
  },
  PREVIEW: {
    label: 'پیش‌نمایش',
    tone: 'warning',
    description: 'فقط نمایش بصری. هیچ عملیات واقعی انجام نمی‌شود.',
  },
  PLANNED: {
    label: 'ساخته‌نشده',
    tone: 'neutral',
    description: 'هیچ پیاده‌سازی‌ای وجود ندارد. مسیر Gateway یا طرح گرافیکی، پیاده‌سازی نیست.',
  },
};

export const READINESS_PRESENTATION: Record<ReadinessReason, string> = {
  ARCHITECTURE_READY:
    'از نظر معماری آماده است: سرویس، قرارداد API و تست‌های آن وجود دارند؛ فقط رابط کاربری این بخش در این مرحله ساخته نشده.',
  PLANNED: 'برنامه‌ریزی‌شده اما ساخته نشده: نه سرویسی، نه Schema‌ای و نه Handler‌ای وجود دارد.',
  BLOCKED_BY_PRODUCT_DECISION:
    'منتظر یک تصمیم محصولی یا حاکمیتی است، نه منتظر مهندسی. تا آن تصمیم، هیچ قاعده‌ای اختراع نمی‌شود.',
  PARTIAL: 'بخشی از دامنه تحویل شده و بخش دیگر هنوز شروع نشده است.',
};

export function CapabilityBadge({ state }: { state: CapabilityState }): ReactNode {
  const presentation = STATE_PRESENTATION[state];
  return (
    <Badge tone={presentation.tone} title={presentation.description}>
      <span>{presentation.label}</span>
      <span dir="ltr" className="rasta-code opacity-70">
        {state}
      </span>
    </Badge>
  );
}

/**
 * A dashboard card.
 *
 * Carries the status and the evidence for it — no counts, no volumes, no
 * percentages. The platform has no analytics service, so any number here would
 * have to be invented, and docs/16 § 16.7 is explicit that an empty dashboard
 * beats a dashboard showing fabricated figures.
 */
export function CapabilityCard({ capability }: { capability: Capability }): ReactNode {
  return (
    <Card as="li" className="flex h-full flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-base font-bold text-[var(--tx)]">
          <Link href={capability.href} className="hover:text-[var(--pri)] hover:underline">
            {capability.title}
          </Link>
        </h3>
        <CapabilityBadge state={capability.state} />
      </div>

      <p className="flex-1 text-sm text-[var(--tx2)]">{capability.summary}</p>

      <p className="text-xs text-[var(--tx3)]">
        {capability.service ? (
          <>
            سرویس:{' '}
            <span dir="ltr" className="rasta-code">
              {capability.service}
            </span>
          </>
        ) : (
          'سرویسی برای این دامنه وجود ندارد.'
        )}
      </p>
    </Card>
  );
}
