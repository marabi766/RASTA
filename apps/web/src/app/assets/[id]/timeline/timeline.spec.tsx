import { render } from '@testing-library/react';
import { axe } from 'jest-axe';

import { TimelineScreen } from './TimelineScreen';
import { formatMoney } from '@/lib/format';
import type { AssetTimelinePage, ReadResult } from '@/server/assets';
import { TEST_CONTEXT } from '@/test/page-context';
import { withContext } from '@/lib/page-context';

/**
 * The full asset history screen, in every state the server can put it in.
 *
 * Mirrors `maintenance.spec.tsx`: a pure function of a read result, so every
 * state is testable without a database, a gateway or a session.
 */

const ENTRY = {
  id: 'TL_1',
  eventName: 'MAINTENANCE_COMPLETED',
  sourceService: 'maintenance-service',
  category: 'MAINTENANCE',
  title: 'سرویس دوره‌ای تکمیل شد',
  description: 'تعویض روغن و فیلتر',
  amountMinor: '90000000',
  detail: {},
  occurredAt: '2026-02-01T00:00:00.000Z',
};

const page = (overrides: Partial<AssetTimelinePage> = {}): ReadResult<AssetTimelinePage> => ({
  kind: 'OK',
  data: { items: [ENTRY], nextCursor: null, hasMore: false, ...overrides },
});

describe('the asset timeline', () => {
  it('shows each entry with its category, date and amount', () => {
    const { getByText } = render(
      <TimelineScreen
        demoMode="REAL"
        result={page()}
        assetId="AST_1"
        query={{ context: TEST_CONTEXT }}
      />,
    );
    expect(getByText('سرویس دوره‌ای تکمیل شد')).toBeInTheDocument();
    expect(getByText('تعویض روغن و فیلتر')).toBeInTheDocument();
    expect(getByText(new RegExp(formatMoney(ENTRY.amountMinor)))).toBeInTheDocument();
  });

  it('words a status change in Persian: the status code inside the title becomes its label', () => {
    const { container, getByText } = render(
      <TimelineScreen
        demoMode="REAL"
        result={page({ items: [{ ...ENTRY, title: 'تغییر وضعیت به IN_MAINTENANCE' }] })}
        assetId="AST_1"
        query={{ context: TEST_CONTEXT }}
      />,
    );
    expect(getByText('تغییر وضعیت به در تعمیر')).toBeInTheDocument();
    expect(container.textContent).not.toContain('IN_MAINTENANCE');
  });

  it('shows a stored reason that carries a bidi override isolated, and without the override', () => {
    // A status reason written before #220, copied into the line by asset-service.
    const RLO = String.fromCodePoint(0x202e);
    const { container } = render(
      <TimelineScreen
        demoMode="REAL"
        result={page({ items: [{ ...ENTRY, description: `فصل ${RLO}غیرکاری ۱۲۳۴` }] })}
        assetId="AST_1"
        query={{ context: TEST_CONTEXT }}
      />,
    );
    const shown = [...container.querySelectorAll('bdi')].find((bdi) =>
      bdi.textContent?.includes('غیرکاری'),
    );
    expect(shown).toHaveAttribute('dir', 'auto');
    expect(shown?.textContent).toBe('فصل غیرکاری ۱۲۳۴');
    expect(container.textContent).not.toContain(RLO);
  });

  it('translates the category without translating the data', () => {
    // CLAUDE.md: the label is presentation; the value stays Latin in the filter.
    const { getByRole } = render(
      <TimelineScreen
        demoMode="REAL"
        result={page()}
        assetId="AST_1"
        query={{ context: TEST_CONTEXT }}
      />,
    );
    expect(getByRole('option', { name: 'نگهداری' })).toHaveValue('MAINTENANCE');
  });

  it('shows an unknown category as it arrived, rather than hiding it', () => {
    const { getByText } = render(
      <TimelineScreen
        demoMode="REAL"
        result={page({ items: [{ ...ENTRY, category: 'ESCALATION' }] })}
        assetId="AST_1"
        query={{ context: TEST_CONTEXT }}
      />,
    );
    expect(getByText(/ESCALATION/)).toBeInTheDocument();
  });

  it('links back to the asset dossier', () => {
    const { getByRole } = render(
      <TimelineScreen
        demoMode="REAL"
        result={page()}
        assetId="AST_1"
        query={{ context: TEST_CONTEXT }}
      />,
    );
    expect(getByRole('link', { name: 'بازگشت به پرونده' })).toHaveAttribute(
      'href',
      '/assets/AST_1',
    );
  });

  it('offers the next page only when there is one, carrying the filter', () => {
    const { queryByRole } = render(
      <TimelineScreen
        demoMode="REAL"
        result={page()}
        assetId="AST_1"
        query={{ context: TEST_CONTEXT }}
      />,
    );
    expect(queryByRole('link', { name: 'صفحهٔ بعد' })).toBeNull();

    const { getByRole } = render(
      <TimelineScreen
        demoMode="REAL"
        result={page({ hasMore: true, nextCursor: 'CUR_2' })}
        assetId="AST_1"
        query={{ context: TEST_CONTEXT, category: 'MAINTENANCE' }}
      />,
    );
    expect(getByRole('link', { name: 'صفحهٔ بعد' })).toHaveAttribute(
      'href',
      withContext(TEST_CONTEXT, '/assets/AST_1/timeline?category=MAINTENANCE&cursor=CUR_2'),
    );
  });

  it('says something different when a filter matched nothing', () => {
    const empty = page({ items: [] });

    const unfiltered = render(
      <TimelineScreen
        demoMode="REAL"
        result={empty}
        assetId="AST_1"
        query={{ context: TEST_CONTEXT }}
      />,
    );
    expect(unfiltered.getByText('رویدادی ثبت نشده')).toBeInTheDocument();

    const filtered = render(
      <TimelineScreen
        demoMode="REAL"
        result={empty}
        assetId="AST_1"
        query={{ context: TEST_CONTEXT, category: 'INSURANCE' }}
      />,
    );
    expect(filtered.getByText('چیزی با این پالایش پیدا نشد')).toBeInTheDocument();
    expect(filtered.getByRole('link', { name: 'نمایش همه' })).toHaveAttribute(
      'href',
      '/assets/AST_1/timeline',
    );
  });

  it('renders a refusal as a refusal, a missing asset as missing, and an outage as an outage', () => {
    const forbidden = render(
      <TimelineScreen
        demoMode="REAL"
        result={{ kind: 'FORBIDDEN' }}
        assetId="AST_1"
        query={{ context: TEST_CONTEXT }}
      />,
    );
    expect(forbidden.getByText('دسترسی ندارید')).toBeInTheDocument();

    const missing = render(
      <TimelineScreen
        demoMode="REAL"
        result={{ kind: 'NOT_FOUND' }}
        assetId="AST_X"
        query={{ context: TEST_CONTEXT }}
      />,
    );
    expect(missing.getByText('این دارایی پیدا نشد')).toBeInTheDocument();

    const down = render(
      <TimelineScreen
        demoMode="REAL"
        result={{ kind: 'UNAVAILABLE', status: 503, correlationId: 'COR_9' }}
        assetId="AST_1"
        query={{ context: TEST_CONTEXT }}
      />,
    );
    // docs/16 § 16.11: the correlation id is on screen so support can find the
    // rest without the page showing it.
    expect(down.getByText(/COR_9/)).toBeInTheDocument();
  });

  it('filters through the URL, with no javascript', () => {
    const { getByRole } = render(
      <TimelineScreen
        demoMode="REAL"
        result={page()}
        assetId="AST_1"
        query={{ context: TEST_CONTEXT }}
      />,
    );
    const form = getByRole('form', { name: 'پالایش تاریخچه' });
    expect(form).toHaveAttribute('method', 'get');
    expect(form).toHaveAttribute('action', '/assets/AST_1/timeline');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(
      <TimelineScreen
        demoMode="REAL"
        result={page()}
        assetId="AST_1"
        query={{ context: TEST_CONTEXT }}
      />,
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});

describe('the asset timeline: «حالت نمایشی» over its amounts (Q-14)', () => {
  const LABEL = 'حالت نمایشی';
  const UNKNOWN = 'وضعیت درگاه پرداخت معلوم نیست';

  it('is drawn while the provider is simulated, and says so when it is unknown', () => {
    const simulated = render(
      <TimelineScreen
        demoMode="SIMULATED"
        result={page()}
        assetId="AST_1"
        query={{ context: TEST_CONTEXT }}
      />,
    );
    expect(simulated.getByText(LABEL)).toBeInTheDocument();
    simulated.unmount();
    const unknown = render(
      <TimelineScreen
        demoMode="UNKNOWN"
        result={page()}
        assetId="AST_1"
        query={{ context: TEST_CONTEXT }}
      />,
    );
    expect(unknown.getByText(UNKNOWN)).toBeInTheDocument();
    expect(unknown.queryByText(LABEL)).toBeNull();
  });

  it('is absent once the provider is real', () => {
    const { queryByText } = render(
      <TimelineScreen
        demoMode="REAL"
        result={page()}
        assetId="AST_1"
        query={{ context: TEST_CONTEXT }}
      />,
    );
    expect(queryByText(LABEL)).toBeNull();
    expect(queryByText(UNKNOWN)).toBeNull();
  });
});
