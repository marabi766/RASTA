import { render, screen, within } from '@testing-library/react';
import { axe } from 'jest-axe';

import type { InspectionSummary, InsurancePolicySummary } from '@/server/asset-records';

import { AssetRecords } from './AssetRecords';

/**
 * The lists: what a person reads about each policy and inspection, and — the
 * point of the section — whether each is in force, judged on the clock the page
 * was handed (the server's), never the machine's.
 */

const NOW = new Date('2027-01-10T08:00:00.000Z');

const policy = (over: Partial<InsurancePolicySummary> = {}): InsurancePolicySummary => ({
  id: 'INS_1',
  policyNumber: 'POL-1405-77',
  insurerName: 'بیمه ایران',
  coverage: 'COMPREHENSIVE',
  premiumMinor: '120000000',
  insuredValueMinor: '5000000000',
  validFrom: '2026-09-30T20:30:00.000Z',
  validTo: '2027-09-30T20:30:00.000Z',
  status: 'ACTIVE',
  daysUntilExpiry: 264,
  ...over,
});

const inspection = (over: Partial<InspectionSummary> = {}): InspectionSummary => ({
  id: 'INSP_1',
  certificateNo: 'INSP-4471',
  centerName: 'مرکز معاینه فنی شمال',
  inspectedAt: '2026-09-19T20:30:00.000Z',
  validTo: '2027-09-19T20:30:00.000Z',
  result: 'PASSED',
  notes: 'بدون ایراد',
  daysUntilExpiry: 252,
  ...over,
});

const ok = <T,>(data: T) => ({ kind: 'OK' as const, data });

const PHYSICAL_DIRECTION = /\b(?:m[lr]|p[lr]|left|right|text-left|text-right)-/;

describe('the policies', () => {
  it('shows coverage, insurer, number, validity window and the amounts, in Persian', () => {
    render(<AssetRecords policies={ok([policy()])} inspections={ok([])} now={NOW} />);
    const list = screen.getByTestId('policy-list');
    expect(within(list).getByText('بیمه ایران')).toBeInTheDocument();
    expect(within(list).getByText('POL-1405-77')).toBeInTheDocument();
    expect(within(list).getByText('جامع (بدنه)')).toBeInTheDocument();
    expect(within(list).getByText('معتبر')).toBeInTheDocument();
    // Solar Hijri, Persian digits.
    expect(list.textContent).toMatch(/۱۴۰۵/);
    expect(list.textContent).toMatch(/۲۶۴ روز مانده/);
    expect(list.textContent).toMatch(/حق بیمه/);
    expect(list.textContent).toMatch(/سرمایهٔ بیمه/);
  });

  it.each([
    ['current', '2027-01-10T08:00:00.000Z', 'CURRENT', 'معتبر'],
    ['expired', '2028-01-10T08:00:00.000Z', 'EXPIRED', 'منقضی'],
    ['future', '2026-06-01T08:00:00.000Z', 'FUTURE', 'هنوز آغاز نشده'],
  ])('judges a %s policy against the clock it was handed', (_name, now, window, label) => {
    render(<AssetRecords policies={ok([policy()])} inspections={ok([])} now={new Date(now)} />);
    const item = screen.getByTestId('policy-list').querySelector('li')!;
    expect(item).toHaveAttribute('data-window', window);
    expect(within(item).getByText(label)).toBeInTheDocument();
  });

  it('does not use the machine’s clock: a clock far in the future changes nothing', () => {
    jest.useFakeTimers({ now: new Date('2090-01-01T00:00:00Z') });
    try {
      render(<AssetRecords policies={ok([policy()])} inspections={ok([])} now={NOW} />);
      expect(screen.getByTestId('policy-list').querySelector('li')).toHaveAttribute(
        'data-window',
        'CURRENT',
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('says a cancelled policy is cancelled, whatever its dates say', () => {
    render(
      <AssetRecords
        policies={ok([policy({ status: 'CANCELLED' })])}
        inspections={ok([])}
        now={NOW}
      />,
    );
    expect(within(screen.getByTestId('policy-list')).getByText('لغوشده')).toBeInTheDocument();
  });

  it('leaves out an amount the policy does not have', () => {
    render(
      <AssetRecords
        policies={ok([policy({ premiumMinor: null, insuredValueMinor: null })])}
        inspections={ok([])}
        now={NOW}
      />,
    );
    const text = screen.getByTestId('policy-list').textContent;
    expect(text).not.toMatch(/حق بیمه/);
    expect(text).not.toMatch(/سرمایهٔ بیمه/);
  });

  it('lists more than one, in the order it was given', () => {
    render(
      <AssetRecords
        policies={ok([
          policy({ id: 'INS_2', policyNumber: 'NEW-2' }),
          policy({ id: 'INS_1', policyNumber: 'OLD-1' }),
        ])}
        inspections={ok([])}
        now={NOW}
      />,
    );
    const numbers = [...screen.getByTestId('policy-list').querySelectorAll('li')].map((li) =>
      li.getAttribute('data-policy-number'),
    );
    expect(numbers).toEqual(['NEW-2', 'OLD-1']);
  });

  it('renders text with markup as text, never as markup', () => {
    render(
      <AssetRecords
        policies={ok([policy({ insurerName: '<img src=x onerror=alert(1)>' })])}
        inspections={ok([])}
        now={NOW}
      />,
    );
    expect(screen.getByTestId('policy-list').querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
  });

  it('says there are none, and that activation needs one', () => {
    render(<AssetRecords policies={ok([])} inspections={ok([])} now={NOW} />);
    expect(screen.getByText('بیمه‌نامه‌ای ثبت نشده')).toBeInTheDocument();
  });
});

describe('the inspections', () => {
  it('shows result, date, certificate, centre and the next due date', () => {
    render(<AssetRecords policies={ok([])} inspections={ok([inspection()])} now={NOW} />);
    const list = screen.getByTestId('inspection-list');
    expect(within(list).getByText('قبول')).toBeInTheDocument();
    expect(within(list).getByText('INSP-4471')).toBeInTheDocument();
    expect(within(list).getByText('مرکز معاینه فنی شمال')).toBeInTheDocument();
    expect(within(list).getByText('معاینهٔ بعدی تا')).toBeInTheDocument();
    expect(within(list).getByText('تاریخ معاینه')).toBeInTheDocument();
    expect(list.textContent).toMatch(/۱۴۰۶/);
    expect(list.textContent).toMatch(/۲۵۲ روز مانده/);
    expect(within(list).getByText('بدون ایراد')).toBeInTheDocument();
  });

  it.each([
    ['PASSED', 'قبول', 'success'],
    ['CONDITIONAL', 'مشروط', 'warning'],
    ['FAILED', 'مردود', 'danger'],
  ])('shows %s as %s, in the tone the status table gives it', (result, label, tone) => {
    render(<AssetRecords policies={ok([])} inspections={ok([inspection({ result })])} now={NOW} />);
    const badge = within(screen.getByTestId('inspection-list')).getByText(label).closest('span');
    expect(badge).toHaveAttribute('data-tone', tone);
  });

  it('judges an expired certificate against the clock it was handed', () => {
    render(
      <AssetRecords
        policies={ok([])}
        inspections={ok([inspection()])}
        now={new Date('2028-06-01T00:00:00Z')}
      />,
    );
    expect(screen.getByTestId('inspection-list').querySelector('li')).toHaveAttribute(
      'data-window',
      'EXPIRED',
    );
    expect(within(screen.getByTestId('inspection-list')).getByText('منقضی')).toBeInTheDocument();
  });

  it('leaves out a centre and notes that were not given', () => {
    render(
      <AssetRecords
        policies={ok([])}
        inspections={ok([inspection({ centerName: null, notes: null })])}
        now={NOW}
      />,
    );
    const text = screen.getByTestId('inspection-list').textContent;
    expect(text).not.toMatch(/مرکز معاینه/);
    expect(text).not.toMatch(/یادداشت/);
  });

  it('says there are none', () => {
    render(<AssetRecords policies={ok([])} inspections={ok([])} now={NOW} />);
    expect(screen.getByText('معاینهٔ فنی‌ای ثبت نشده')).toBeInTheDocument();
  });
});

describe('when a read does not come back', () => {
  it.each([
    [{ kind: 'FORBIDDEN' } as const, /اجازهٔ دیدن/],
    [{ kind: 'NOT_FOUND' } as const, /این دارایی پیدا نشد/],
    [{ kind: 'UNAVAILABLE', status: 503, correlationId: 'corr-503' } as const, /corr-503/],
    [{ kind: 'MALFORMED', correlationId: 'corr-bad' } as const, /corr-bad/],
  ])('says so for %j, in the section it concerns, and keeps the other', (failure, expected) => {
    render(<AssetRecords policies={failure} inspections={ok([inspection()])} now={NOW} />);
    const policies = screen.getByRole('region', { name: 'بیمه‌نامه‌ها' });
    expect(policies).toHaveTextContent(expected);
    expect(screen.getByTestId('inspection-list')).toBeInTheDocument();
  });
});

describe('the forms', () => {
  it('draws the forms it was handed, each in its own section', () => {
    render(
      <AssetRecords
        policies={ok([])}
        inspections={ok([])}
        now={NOW}
        policyForm={<p>policy-form-slot</p>}
        inspectionForm={<p>inspection-form-slot</p>}
      />,
    );
    expect(
      within(screen.getByRole('region', { name: 'بیمه‌نامه‌ها' })).getByText('policy-form-slot'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'معاینهٔ فنی' })).getByText('inspection-form-slot'),
    ).toBeInTheDocument();
  });

  it('draws no form it was not handed — the roles that may not record see only the lists', () => {
    render(<AssetRecords policies={ok([policy()])} inspections={ok([inspection()])} now={NOW} />);
    expect(screen.queryByRole('form')).toBeNull();
  });
});

it('uses no physical-direction utility, and has no accessibility violations', async () => {
  const { container } = render(
    <AssetRecords
      policies={ok([policy(), policy({ id: 'INS_2', status: 'CANCELLED' })])}
      inspections={ok([inspection(), inspection({ id: 'INSP_2', result: 'FAILED' })])}
      now={NOW}
    />,
  );
  expect(container.innerHTML).not.toMatch(PHYSICAL_DIRECTION);
  expect(await axe(container)).toHaveNoViolations();

  const failed = render(
    <AssetRecords
      policies={{ kind: 'UNAVAILABLE', status: 503, correlationId: 'c' }}
      inspections={{ kind: 'FORBIDDEN' }}
      now={NOW}
    />,
  );
  expect(await axe(failed.container)).toHaveNoViolations();
});
