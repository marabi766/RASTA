import { render, screen, within } from '@testing-library/react';
import { axe } from 'jest-axe';

import type { AssetDocumentSummary } from '@/server/asset-documents';

import { AssetDocuments } from './AssetDocuments';

/**
 * The documents list: what a person reads about each reference — and whether it
 * has expired, judged on the clock the page was handed (the server's), never the
 * machine's.
 */

const NOW = new Date('2027-01-10T08:00:00.000Z');

const document = (over: Partial<AssetDocumentSummary> = {}): AssetDocumentSummary => ({
  id: 'ADR_1',
  documentId: 'DOC_01J00000000000000000000001',
  kind: 'OWNERSHIP_TITLE',
  title: 'سند مالکیت لودر',
  issuedAt: '2026-03-20T20:30:00.000Z',
  expiresAt: '2028-03-20T20:30:00.000Z',
  ...over,
});

const PHYSICAL_DIRECTION = /\b(?:m[lr]|p[lr]|left|right|text-left|text-right)-/;

describe('the documents', () => {
  it('shows title, kind in Persian, dates in Solar Hijri and the document id', () => {
    render(<AssetDocuments documents={[document()]} now={NOW} />);
    const list = screen.getByTestId('document-list');
    expect(within(list).getByText('سند مالکیت لودر')).toBeInTheDocument();
    expect(within(list).getByText('سند مالکیت')).toBeInTheDocument();
    expect(list.textContent).toMatch(/۱۴۰۵/);
    expect(within(list).getByText('DOC_01J00000000000000000000001')).toBeInTheDocument();
  });

  it('says there is none, and what could be attached', () => {
    render(<AssetDocuments documents={[]} now={NOW} />);
    expect(screen.getByText('مدرکی پیوست نشده')).toBeInTheDocument();
    expect(screen.queryByTestId('document-list')).toBeNull();
  });

  it.each([
    ['current', '2027-01-10T08:00:00.000Z', {}, 'CURRENT', 'معتبر'],
    ['expired', '2029-01-10T08:00:00.000Z', {}, 'EXPIRED', 'منقضی'],
    ['without an expiry', '2090-01-10T08:00:00.000Z', { expiresAt: null }, 'NO_EXPIRY', null],
  ])(
    'judges a document %s against the clock it was handed',
    (_name, now, over, validity, label) => {
      render(<AssetDocuments documents={[document(over)]} now={new Date(now)} />);
      const item = screen.getByTestId('document-list').querySelector('li')!;
      expect(item).toHaveAttribute('data-validity', validity);
      if (label) expect(within(item).getByText(label)).toBeInTheDocument();
      else expect(within(item).queryByText('معتبر')).toBeNull();
    },
  );

  it('does not use the machine’s clock: a clock far in the future changes nothing', () => {
    jest.useFakeTimers({ now: new Date('2090-01-01T00:00:00Z') });
    try {
      render(<AssetDocuments documents={[document()]} now={NOW} />);
      expect(screen.getByTestId('document-list').querySelector('li')).toHaveAttribute(
        'data-validity',
        'CURRENT',
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('shows a kind it does not know as it arrived, not as a guess', () => {
    render(<AssetDocuments documents={[document({ kind: 'NEW_KIND' })]} now={NOW} />);
    expect(screen.getByText('NEW_KIND')).toBeInTheDocument();
  });

  it('draws the attach form where it was handed, and nothing where it was not', () => {
    const { rerender } = render(
      <AssetDocuments documents={[]} now={NOW} attachForm={<form aria-label="پیوست مدرک" />} />,
    );
    expect(screen.getByRole('form', { name: 'پیوست مدرک' })).toBeInTheDocument();
    rerender(<AssetDocuments documents={[]} now={NOW} />);
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('shows the title isolated and without a bidi override (#220)', () => {
    const RLO = String.fromCodePoint(0x202e);
    const { container } = render(
      <AssetDocuments documents={[document({ title: `سند${RLO} مالکیت` })]} now={NOW} />,
    );
    expect(container.textContent).not.toContain(RLO);
    expect([...container.querySelectorAll('bdi')].map((bdi) => bdi.textContent)).toContain(
      'سند مالکیت',
    );
  });

  it('uses no physical-direction utility, and has no accessibility violations', async () => {
    const { container } = render(
      <AssetDocuments
        documents={[document(), document({ id: 'ADR_2', expiresAt: null })]}
        now={NOW}
      />,
    );
    expect(container.innerHTML).not.toMatch(PHYSICAL_DIRECTION);
    expect(await axe(container)).toHaveNoViolations();
  });
});
