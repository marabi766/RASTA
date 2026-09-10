import type { ReactNode } from 'react';
import { DOMAINS, PREVIEW_DISCLOSURE, capabilityByKey } from '@/lib/capabilities';
import { TourContinue } from './demo/tour-continue';
import { Card, PageHeader } from './ui/primitives';
import { Code, DescriptionList, Section } from './ui/data-view';
import { CapabilityBadge, READINESS_PRESENTATION, STATE_PRESENTATION } from './capability';

/**
 * The screen behind every capability this application does not operate.
 *
 * ## What it may and may not contain
 *
 * It explains: the roadmap position, the architectural state, and what the
 * capability is *for* — because "not built" is a poor answer to an investor and
 * "here is exactly where it sits and what has to happen first" is a good one.
 *
 * It does not contain: a form, an input, a chart, a rating, a figure, a success
 * toast, or a button that looks like it does something. A test asserts each of
 * those absences, and another asserts the page never calls `fetch` — a
 * placeholder that quietly probed an endpoint would be doing, in the network
 * tab, exactly what it tells the reader it is not doing.
 *
 * The required disclosure is rendered unconditionally, in the exact wording,
 * because a screenshot of this page will travel further than the room it was
 * shown in.
 */
export function UnderConstruction({
  capabilityKey,
  /** Why this capability is worth building. Optional; omitted rather than invented. */
  value,
  /** What must be true before it can start. Optional. */
  prerequisites,
}: {
  capabilityKey: string;
  value?: readonly string[];
  prerequisites?: readonly string[];
}): ReactNode {
  const capability = capabilityByKey(capabilityKey);

  if (!capability) {
    // Unreachable through the manifest-generated routes; kept because a wrong
    // key should fail visibly rather than render a blank page.
    throw new Error(`Unknown capability key: ${capabilityKey}`);
  }

  const state = STATE_PRESENTATION[capability.state];
  const domain = DOMAINS.find((entry) => entry.key === capability.domain);

  return (
    <>
      <PageHeader
        title={capability.title}
        description={capability.summary}
        actions={<CapabilityBadge state={capability.state} />}
      />

      <div
        role="note"
        className="mb-6 rounded-[var(--radius-md)] border border-[var(--warn)] bg-[var(--warn-soft)] px-4 py-3 text-sm font-bold text-[var(--warn-tx)]"
      >
        {PREVIEW_DISCLOSURE}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <h2 className="text-lg font-bold text-[var(--tx)]">وضعیت این بخش</h2>
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

          <div className="mt-4">
            <DescriptionList
              columns={1}
              items={[
                { term: 'وضعیت', value: <Code>{capability.state}</Code> },
                { term: 'حوزهٔ محصول', value: domain?.title ?? capability.domain },
                {
                  term: 'سرویس مالک داده',
                  value: capability.service ? (
                    <Code>{capability.service}</Code>
                  ) : (
                    <span className="text-[var(--tx3)]">سرویسی وجود ندارد</span>
                  ),
                },
              ]}
            />
          </div>
        </Card>
      </div>

      {domain ? (
        <Section id="domain" title={`جای این بخش در «${domain.title}»`}>
          <Card>
            <p className="text-sm text-[var(--tx2)]">{domain.proposition}</p>
          </Card>
        </Section>
      ) : null}

      {value && value.length > 0 ? (
        <Section
          id="value"
          title="این قابلیت چه مشکلی را حل می‌کند"
          description="شرح مسئله، نه ادعای قابلیت. هیچ‌کدام از موارد زیر امروز کار نمی‌کند."
        >
          <Card>
            <ul className="space-y-2 text-sm text-[var(--tx2)]">
              {value.map((item) => (
                <li key={item} className="border-s-2 border-[var(--bd2)] ps-3" dir="auto">
                  {item}
                </li>
              ))}
            </ul>
          </Card>
        </Section>
      ) : null}

      {prerequisites && prerequisites.length > 0 ? (
        <Section
          id="prerequisites"
          title="پیش‌نیازهای شروع"
          description="آنچه باید پیش از نوشتن نخستین خط کد این بخش روشن یا آماده باشد."
        >
          <Card>
            <ul className="space-y-2 text-sm text-[var(--tx2)]">
              {prerequisites.map((item) => (
                <li key={item} className="border-s-2 border-[var(--bd2)] ps-3" dir="auto">
                  {item}
                </li>
              ))}
            </ul>
          </Card>
        </Section>
      ) : null}

      <TourContinue />
    </>
  );
}
