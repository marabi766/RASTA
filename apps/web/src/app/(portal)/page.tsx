import Link from 'next/link';
import type { ReactNode } from 'react';
import { CapabilityCard, STATE_PRESENTATION } from '@/components/capability';
import { Card, PageHeader } from '@/components/ui/primitives';
import {
  CAPABILITIES,
  CAPABILITY_STATES,
  DOMAINS,
  capabilitiesInDomain,
  type CapabilityState,
  type Domain,
} from '@/lib/capabilities';
import { formatInteger } from '@/lib/format';

/**
 * The executive dashboard.
 *
 * ## What is deliberately not here
 *
 * No fleet count, no transaction volume, no revenue, no user count, no uptime,
 * no percentage of anything operational. Not because those would be hard, but
 * because nothing computes them: `analytics-service` is not built, and every
 * such figure would have to be invented. docs/16 § 16.7 settles it — «یک
 * داشبورد که عدد جعلی نشان می‌دهد، بدتر از داشبورد خالی است».
 *
 * What it does show is the product in five areas, each with what it is *for*,
 * and then the capability map with a checked status per capability. The counts
 * measure this repository's delivery status, which is honest because the
 * manifest is verified against the adapter registry and every entry cites its
 * source.
 */
export default function DashboardPage(): ReactNode {
  const counts = CAPABILITY_STATES.map((state) => ({
    state,
    count: CAPABILITIES.filter((capability) => capability.state === state).length,
  })).filter((entry) => entry.count > 0);

  return (
    <>
      <PageHeader
        title="رستا — نمای کلی پلتفرم"
        description="پلتفرم چندمستأجری مدیریت ناوگان، زنجیره تأمین، خدمات و عملیات عمرانی. این صفحه وضعیت ساخت را گزارش می‌کند و هیچ شاخص عملیاتی — حجم تراکنش، تعداد ناوگان، درآمد یا تعداد کاربر — در این نسخه محاسبه نمی‌شود، چون سرویس تحلیلی ساخته نشده و عدد ساختگی بدتر از نبود عدد است."
        actions={
          <Link
            href="/present"
            className="inline-flex min-h-[var(--tap)] items-center rounded-[var(--radius-md)] bg-[var(--pri)] px-4 text-sm font-bold text-white hover:bg-[var(--pri-h)]"
          >
            شروع روایت هدایت‌شده
          </Link>
        }
      />

      <section aria-labelledby="domains-heading" className="mb-8">
        <h2 id="domains-heading" className="mb-3 text-lg font-bold text-[var(--tx)]">
          پنج حوزهٔ محصول
        </h2>
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {DOMAINS.map((domain) => (
            <DomainCard key={domain.key} domain={domain} />
          ))}
        </ul>
      </section>

      <section aria-labelledby="summary-heading" className="mb-8">
        <h2 id="summary-heading" className="mb-3 text-lg font-bold text-[var(--tx)]">
          وضعیت ساخت
        </h2>
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {counts.map(({ state, count }) => (
            <StateTile key={state} state={state} count={count} />
          ))}
        </ul>
      </section>

      <section aria-labelledby="capabilities-heading">
        <h2 id="capabilities-heading" className="mb-1 text-lg font-bold text-[var(--tx)]">
          نقشهٔ قابلیت‌ها
        </h2>
        <p className="mb-4 text-sm text-[var(--tx2)]">
          هر قابلیت، وضعیتش و مبنای آن وضعیت. برچسب «فعال» تنها زمانی داده می‌شود که کدی در همین
          نسخه یک مسیر واقعی را از راه درگاه API فراخوانی کند.
        </p>
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {CAPABILITIES.map((capability) => (
            <CapabilityCard key={capability.key} capability={capability} />
          ))}
        </ul>
      </section>
    </>
  );
}

function DomainCard({ domain }: { domain: Domain }): ReactNode {
  const capabilities = capabilitiesInDomain(domain.key);
  const live = capabilities.filter(
    (capability) => capability.state === 'LIVE' || capability.state === 'BETA',
  ).length;

  return (
    <Card as="li" className="flex h-full flex-col gap-3">
      <h3 className="text-base font-bold text-[var(--tx)]">{domain.title}</h3>
      <p className="flex-1 text-sm text-[var(--tx2)]">{domain.proposition}</p>
      <p className="text-xs text-[var(--tx3)]">
        {live === 0
          ? `${formatInteger(capabilities.length)} قابلیت، هیچ‌کدام در این نسخه فعال نیست.`
          : `${formatInteger(live)} از ${formatInteger(capabilities.length)} قابلیت در همین نسخه به API واقعی وصل است.`}
      </p>
    </Card>
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
