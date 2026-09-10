'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  CAPABILITIES,
  CAPABILITY_STATES,
  DOMAINS,
  capabilitiesInDomain,
  type Capability,
  type CapabilityState,
  type Domain,
} from '@/lib/capabilities';
import { FIXTURE_DISCLOSURE, LIVE_DISCLOSURE, isFixtureMode } from '@/lib/demo/mode';
import { useSession } from '@/lib/auth/session';
import { formatInteger } from '@/lib/format';
import { CapabilityBadge, STATE_PRESENTATION } from '../capability';
import { Badge, Button, Card, PageHeader } from '../ui/primitives';
import { PresentationToolbar } from './presentation-toolbar';
import { useTour } from './tour-provider';

/**
 * Where an investor presentation starts.
 *
 * Three things in order: what the product is, what is actually built, and a way
 * into the guided tour. Everything on the page is derived from the capability
 * registry, so there is no second list of routes to keep in step — adding a
 * capability makes it appear here, with its real status, without anyone editing
 * this file.
 *
 * The disclosure is the part that must not be missed. A viewer cannot tell
 * fixtures from live data by looking, because the fixtures are deliberately
 * coherent; so the mode is stated in a panel of its own rather than implied.
 */
export function DemoHome(): ReactNode {
  const { dataMode } = useSession();
  const { start, stops } = useTour();
  const fixture = isFixtureMode(dataMode);

  const counts = CAPABILITY_STATES.map((state) => ({
    state,
    count: CAPABILITIES.filter((capability) => capability.state === state).length,
  })).filter((entry) => entry.count > 0);

  const live = CAPABILITIES.filter(
    (capability) => capability.state === 'LIVE' || capability.state === 'BETA',
  );

  return (
    <>
      <PageHeader
        title="رستا — ارائهٔ سرمایه‌گذار"
        description="پلتفرم چندمستأجری مدیریت ناوگان، زنجیره تأمین، خدمات و عملیات عمرانی برای دهیاری‌های استان یزد. این صفحه نقطهٔ شروع ارائه است: می‌گوید محصول چیست، چه بخشی از آن ساخته شده، و چه بخشی نه."
        actions={
          <Button onClick={start}>شروع روایت هدایت‌شده ({formatInteger(stops.length)} گام)</Button>
        }
      />

      <PresentationToolbar />

      <section aria-labelledby="mode-heading" className="mb-8">
        <h2 id="mode-heading" className="mb-3 text-lg font-bold text-[var(--tx)]">
          این نشست به چه چیزی وصل است؟
        </h2>

        <Card className={fixture ? 'border-[var(--warn)]' : 'border-[var(--ok)]'}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-base font-bold text-[var(--tx)]">
              {fixture ? FIXTURE_DISCLOSURE : LIVE_DISCLOSURE}
            </p>
            <Badge tone={fixture ? 'warning' : 'success'}>
              <span dir="ltr" className="rasta-code">
                {fixture ? 'FIXTURE' : 'LIVE'}
              </span>
            </Badge>
          </div>

          <p className="mt-3 text-sm text-[var(--tx2)]">
            {fixture
              ? 'این نشست به هیچ سرویس واقعی وصل نیست. تمام رکوردها ساختگی و ثابت‌اند، هیچ درخواستی به شبکه فرستاده نمی‌شود، و هیچ عملیات تغییردهنده‌ای — حتی اگر خواسته شود — انجام نخواهد شد. هویت نمایش‌دهنده نیز شبیه‌سازی‌شده است و هیچ توکنی در این حالت وجود ندارد.'
              : 'داده‌ها از درگاه API واقعی و با توکن نشست شما خوانده می‌شوند. اگر سرویسی در دسترس نباشد، همان صفحه خطای واقعی را نشان می‌دهد و هرگز به دادهٔ نمایشی برنمی‌گردد.'}
          </p>
        </Card>
      </section>

      <section aria-labelledby="what-exists" className="mb-8">
        <h2 id="what-exists" className="mb-1 text-lg font-bold text-[var(--tx)]">
          چه چیزی ساخته شده است
        </h2>
        <p className="mb-4 text-sm text-[var(--tx2)]">
          {formatInteger(live.length)} قابلیت در همین نسخه به API واقعی وصل‌اند. بقیه، وضعیت واقعی
          خودشان را اعلام می‌کنند. هیچ شاخص عملیاتی — حجم تراکنش، درآمد، تعداد ناوگان — در این نسخه
          محاسبه نمی‌شود، چون سرویس تحلیلی ساخته نشده.
        </p>

        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {counts.map(({ state, count }) => (
            <StateTile key={state} state={state} count={count} />
          ))}
        </ul>
      </section>

      <section aria-labelledby="domains-heading" className="mb-8">
        <h2 id="domains-heading" className="mb-3 text-lg font-bold text-[var(--tx)]">
          حوزه‌های محصول
        </h2>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {DOMAINS.map((domain) => (
            <DomainPanel key={domain.key} domain={domain} />
          ))}
        </div>
      </section>

      <Card>
        <p className="text-xs text-[var(--tx2)]">
          هیچ‌یک از دامنه‌های حسابرسی، اعلان، انبار، تأمین، عمران و قرارداد در این نسخه کامل نیست و
          هیچ‌کدام به‌عنوان کامل ارائه نمی‌شوند. صفحهٔ هرکدام می‌گوید در چه وضعیتی است و چرا.
        </p>
      </Card>
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

/**
 * One product area, with every capability in it and where each one goes.
 *
 * The links are the point: this page is an index into the real application, not
 * a brochure beside it. A viewer who wants to leave the tour and look at
 * something can, and lands on the same screen the tour would have shown them.
 */
function DomainPanel({ domain }: { domain: Domain }): ReactNode {
  const capabilities = capabilitiesInDomain(domain.key);

  return (
    <Card>
      <h3 className="text-base font-bold text-[var(--tx)]">{domain.title}</h3>
      <p className="mt-2 text-sm text-[var(--tx2)]">{domain.proposition}</p>

      <ul className="mt-4 space-y-2">
        {capabilities.map((capability) => (
          <CapabilityRow key={capability.key} capability={capability} />
        ))}
      </ul>
    </Card>
  );
}

function CapabilityRow({ capability }: { capability: Capability }): ReactNode {
  return (
    <li>
      <Link
        href={capability.href}
        className="flex min-h-[var(--tap)] flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--bd)] px-3 py-2 text-sm hover:border-[var(--pri)] hover:bg-[var(--sunken)]"
      >
        <span className="font-semibold text-[var(--tx)]">{capability.title}</span>
        <CapabilityBadge state={capability.state} compact />
      </Link>
    </li>
  );
}
