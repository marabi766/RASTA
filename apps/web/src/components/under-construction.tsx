import type { ReactNode } from 'react';
import { capabilityByKey } from '@/lib/capabilities';
import { Card, PageHeader } from './ui/primitives';
import { CapabilityBadge, READINESS_PRESENTATION, STATE_PRESENTATION } from './capability';

/**
 * The «در حال ساخت» screen.
 *
 * Every capability that is not `LIVE` routes here, and this component is the
 * reason those routes are safe to show an investor: it has no form, no chart,
 * no rating, no figure and no success toast. There is nothing here that could
 * be mistaken for a working feature, because there is nothing here that does
 * anything.
 *
 * It also does not call `fetch`. That is asserted by a test rather than left to
 * inspection — a placeholder that quietly probed an endpoint would be claiming,
 * in the network tab, exactly what the page says it is not doing.
 *
 * What it does say is the part that is actually useful to a reader: which of
 * the three reasons applies. "Architecture-ready" and "waiting on a product
 * decision" are very different answers to "when will this work", and
 * collapsing both into «به‌زودی» throws away the only information the screen
 * has.
 */
export function UnderConstruction({ capabilityKey }: { capabilityKey: string }): ReactNode {
  const capability = capabilityByKey(capabilityKey);

  if (!capability) {
    // Unreachable through the manifest-generated routes; kept because a wrong
    // key should fail visibly rather than render a blank page.
    throw new Error(`Unknown capability key: ${capabilityKey}`);
  }

  const state = STATE_PRESENTATION[capability.state];

  return (
    <>
      <PageHeader
        title={capability.title}
        description={capability.summary}
        actions={<CapabilityBadge state={capability.state} />}
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <h2 className="text-lg font-bold text-[var(--tx)]">این بخش در حال ساخت است</h2>
          <p className="mt-3 text-sm text-[var(--tx2)]">{state.description}</p>

          {capability.readiness ? (
            <p className="mt-3 text-sm text-[var(--tx2)]">
              {READINESS_PRESENTATION[capability.readiness]}
            </p>
          ) : null}

          <p className="mt-4 rounded-[var(--radius-md)] border border-[var(--bd)] bg-[var(--sunken)] px-4 py-3 text-sm font-semibold text-[var(--tx)]">
            در این صفحه هیچ تراکنش واقعی انجام نمی‌شود و هیچ داده‌ای ثبت یا ارسال نمی‌گردد.
          </p>
        </Card>

        <Card>
          <h2 className="text-sm font-bold text-[var(--tx)]">مبنای این وضعیت</h2>
          <p className="mt-3 text-xs leading-relaxed text-[var(--tx2)]" dir="auto">
            {capability.evidence}
          </p>

          <dl className="mt-4 space-y-2 text-xs">
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-[var(--tx3)]">وضعیت</dt>
              <dd dir="ltr" className="rasta-code text-[var(--tx)]">
                {capability.state}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-2">
              <dt className="text-[var(--tx3)]">سرویس مالک داده</dt>
              <dd dir="ltr" className="rasta-code text-[var(--tx)]">
                {capability.service ?? '—'}
              </dd>
            </div>
          </dl>
        </Card>
      </div>
    </>
  );
}
