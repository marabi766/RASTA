import type { ReactNode } from 'react';
import { CapabilityCard, STATE_PRESENTATION } from '@/components/capability';
import { Card, PageHeader } from '@/components/ui/primitives';
import { CAPABILITIES, CAPABILITY_STATES, type CapabilityState } from '@/lib/capabilities';
import { formatInteger } from '@/lib/format';

/**
 * The dashboard.
 *
 * ## What is deliberately not here
 *
 * No fleet count, no transaction volume, no revenue, no user count, no uptime,
 * no percentage of anything operational. Not because those would be hard, but
 * because nothing computes them: `analytics-service` is not built, and every
 * such figure would have to be invented. docs/16 § 16.7 settles it — «یک
 * داشبورد که عدد جعلی نشان می‌دهد، بدتر از داشبورد خالی است».
 *
 * What the counts below measure is this repository's own delivery status, read
 * from the capability manifest. Those are honest because the manifest is
 * checked against the adapter registry, and because each capability carries the
 * source citation behind its status.
 */
export default function DashboardPage(): ReactNode {
  const counts = CAPABILITY_STATES.map((state) => ({
    state,
    count: CAPABILITIES.filter((capability) => capability.state === state).length,
  })).filter((entry) => entry.count > 0);

  return (
    <>
      <PageHeader
        title="وضعیت قابلیت‌های پلتفرم"
        description="این صفحه فقط وضعیت ساخت را گزارش می‌کند. هیچ شاخص عملیاتی — حجم تراکنش، تعداد ناوگان، درآمد یا تعداد کاربر — در این نسخه محاسبه نمی‌شود، چون سرویس تحلیلی ساخته نشده و عدد ساختگی بدتر از نبود عدد است."
      />

      <section aria-labelledby="summary-heading" className="mb-8">
        <h2 id="summary-heading" className="sr-only">
          خلاصهٔ وضعیت
        </h2>
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {counts.map(({ state, count }) => (
            <StateTile key={state} state={state} count={count} />
          ))}
        </ul>
      </section>

      <section aria-labelledby="capabilities-heading">
        <h2 id="capabilities-heading" className="mb-4 text-lg font-bold text-[var(--tx)]">
          قابلیت‌ها
        </h2>
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {CAPABILITIES.map((capability) => (
            <CapabilityCard key={capability.key} capability={capability} />
          ))}
        </ul>
      </section>
    </>
  );
}

function StateTile({ state, count }: { state: CapabilityState; count: number }): ReactNode {
  const presentation = STATE_PRESENTATION[state];

  return (
    <Card as="li">
      <p className="text-xs font-semibold text-[var(--tx3)]">
        {presentation.label}{' '}
        <span dir="ltr" className="rasta-code">
          {state}
        </span>
      </p>
      <p className="mt-1 text-3xl font-extrabold text-[var(--tx)]">{formatInteger(count)}</p>
      <p className="mt-2 text-xs text-[var(--tx2)]">{presentation.description}</p>
    </Card>
  );
}
