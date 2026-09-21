import { render } from '@testing-library/react';
import { axe } from 'jest-axe';

import { AssetsScreen } from './AssetsScreen';
import { DossierScreen } from './[id]/DossierScreen';
import type { AssetDossier, AssetPage, ReadResult } from '@/server/assets';

/**
 * The two asset screens, in every state the server can put them in.
 *
 * Both are pure functions of a read result, which is what makes this possible
 * without a database, a gateway or a session. The states that matter most are
 * the unhappy ones: they are the ones a developer never sees by accident and a
 * user meets on their worst day.
 */

const ASSET = {
  id: 'AST_1',
  assetTag: '۱۲ ب ۳۴۵',
  name: 'لودر کوماتسو',
  type: 'HEAVY_MACHINERY',
  status: 'ACTIVE',
  manufacturer: 'کوماتسو',
  model: 'WA320',
  manufactureYear: 2018,
  commissionedAt: '2026-01-01T00:00:00.000Z',
};

const page = (overrides: Partial<AssetPage> = {}): ReadResult<AssetPage> => ({
  kind: 'OK',
  data: { items: [ASSET], nextCursor: null, hasMore: false, ...overrides },
});

describe('the machinery list', () => {
  it('shows a row per asset, linking to its dossier', () => {
    const { getByRole } = render(<AssetsScreen result={page()} query={{}} />);
    expect(getByRole('link', { name: 'لودر کوماتسو' })).toHaveAttribute('href', '/assets/AST_1');
  });

  it('translates the type and the status without translating the data', () => {
    // CLAUDE.md: the label is presentation; the value stays Latin everywhere
    // a comparison or a filter could see it. Scoped to the table, because the
    // filter above it offers every label as an option too.
    const { getByRole } = render(<AssetsScreen result={page()} query={{}} />);
    const row = getByRole('row', { name: /لودر کوماتسو/ });
    expect(row).toHaveTextContent('ماشین‌آلات سنگین');
    expect(row).toHaveTextContent('فعال');
    // And the option that carries that label still carries the Latin value.
    expect(getByRole('option', { name: 'ماشین‌آلات سنگین' })).toHaveValue('HEAVY_MACHINERY');
  });

  it('shows an unknown status as it arrived, rather than hiding it', () => {
    const { getByText } = render(
      <AssetsScreen result={page({ items: [{ ...ASSET, status: 'IMPOUNDED' }] })} query={{}} />,
    );
    expect(getByText('IMPOUNDED')).toBeInTheDocument();
  });

  it('offers the next page only when there is one', () => {
    const { queryByRole } = render(<AssetsScreen result={page()} query={{}} />);
    expect(queryByRole('link', { name: 'صفحهٔ بعد' })).toBeNull();

    const { getByRole } = render(
      <AssetsScreen
        result={page({ hasMore: true, nextCursor: 'CUR_2' })}
        query={{ status: 'ACTIVE' }}
      />,
    );
    // The filter travels with the cursor: a second page of a filtered list is
    // still that filtered list.
    expect(getByRole('link', { name: 'صفحهٔ بعد' })).toHaveAttribute(
      'href',
      '/assets?status=ACTIVE&cursor=CUR_2',
    );
  });

  it('says something different when a filter matched nothing', () => {
    // Telling somebody "nothing is registered" when they have simply typed a
    // name that does not match is a small lie with a real cost.
    const empty = page({ items: [] });

    const unfiltered = render(<AssetsScreen result={empty} query={{}} />);
    expect(unfiltered.getByText('هنوز ماشین‌آلاتی ثبت نشده')).toBeInTheDocument();

    const filtered = render(<AssetsScreen result={empty} query={{ q: 'چیزی' }} />);
    expect(filtered.getByText('چیزی با این پالایش پیدا نشد')).toBeInTheDocument();
    expect(filtered.getByRole('link', { name: 'نمایش همه' })).toHaveAttribute('href', '/assets');
  });

  it('renders a refusal as a refusal and an outage as an outage', () => {
    const forbidden = render(<AssetsScreen result={{ kind: 'FORBIDDEN' }} query={{}} />);
    expect(forbidden.getByText('دسترسی ندارید')).toBeInTheDocument();

    const down = render(
      <AssetsScreen
        result={{ kind: 'UNAVAILABLE', status: 503, correlationId: 'COR_9' }}
        query={{}}
      />,
    );
    // docs/16 § 16.11: the correlation id is on screen so support can find the
    // rest without the page showing it.
    expect(down.getByText(/COR_9/)).toBeInTheDocument();
  });

  it('filters through the URL, with no javascript', () => {
    // A filtered list is then a link somebody can send to a colleague, which a
    // client-side filter never is.
    const { getByRole } = render(<AssetsScreen result={page()} query={{}} />);
    const form = getByRole('form', { name: 'پالایش فهرست' });
    expect(form).toHaveAttribute('method', 'get');
    expect(form).toHaveAttribute('action', '/assets');
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<AssetsScreen result={page()} query={{}} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});

const DOSSIER: AssetDossier = {
  asset: ASSET,
  organizationName: 'دهیاری نمونه',
  compliance: {
    operable: false,
    blockers: ['INSURANCE_EXPIRED', 'INSPECTION_EXPIRED'],
    activeInsurance: null,
    latestInspection: {
      certificateNo: 'C-1',
      centerName: 'مرکز نمونه',
      validTo: '2026-01-01T00:00:00.000Z',
      result: 'PASSED',
      daysUntilExpiry: -30,
    },
  },
  costs: {
    totalMinor: '120000000',
    maintenanceMinor: '90000000',
    partsAndOrdersMinor: '30000000',
    entryCount: 7,
  },
  recentActivity: [
    {
      id: 'TL_1',
      category: 'MAINTENANCE',
      title: 'سرویس دوره‌ای',
      description: null,
      amountMinor: '90000000',
      occurredAt: '2026-02-01T00:00:00.000Z',
    },
  ],
  transferCount: 2,
};

describe('the electronic dossier', () => {
  const ok = (data: AssetDossier = DOSSIER): ReadResult<AssetDossier> => ({ kind: 'OK', data });

  it('lists every reason the asset cannot be dispatched', () => {
    // asset-service answers with all of them on purpose; a screen that showed
    // the first would send an operator back a second time.
    const { getByText } = render(<DossierScreen result={ok()} assetId="AST_1" />);
    expect(getByText('قابل اعزام نیست')).toBeInTheDocument();
    expect(getByText('بیمه‌نامه منقضی شده')).toBeInTheDocument();
    expect(getByText('معاینهٔ فنی منقضی شده')).toBeInTheDocument();
  });

  it('says an expiry has passed rather than showing a negative number', () => {
    const { getByText } = render(<DossierScreen result={ok()} assetId="AST_1" />);
    expect(getByText(/۳۰ روز از انقضا گذشته|30 روز از انقضا گذشته/)).toBeInTheDocument();
  });

  it('says plainly when nothing is blocking', () => {
    const clear: AssetDossier = {
      ...DOSSIER,
      compliance: { ...DOSSIER.compliance, operable: true, blockers: [] },
    };
    const { getByText } = render(<DossierScreen result={ok(clear)} assetId="AST_1" />);
    expect(getByText('آمادهٔ بهره‌برداری است')).toBeInTheDocument();
  });

  it('answers a missing asset the same way it answers somebody else’s', () => {
    // A distinct "exists but not yours" would confirm the id to somebody who
    // should not learn it. asset-service answers 404 for both, and so does this.
    const { getByText } = render(<DossierScreen result={{ kind: 'NOT_FOUND' }} assetId="AST_X" />);
    expect(getByText('این دارایی پیدا نشد')).toBeInTheDocument();
  });

  it('shows an empty history as empty, not as an error', () => {
    const quiet: AssetDossier = { ...DOSSIER, recentActivity: [] };
    const { getByText } = render(<DossierScreen result={ok(quiet)} assetId="AST_1" />);
    expect(getByText('رویدادی ثبت نشده')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = render(<DossierScreen result={ok()} assetId="AST_1" />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
