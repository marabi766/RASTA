import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { act, render, screen } from '@testing-library/react';

import * as nav from '@/app/nav';
import * as demandCommands from '@/lib/demand-commands';
import * as labels from '@/lib/labels';
import { SESSION_REFUSAL_MESSAGES } from '@/lib/session-refusal';
import * as unconfirmed from '@/lib/unconfirmed-write';
import type { AggregationRecord, DemandRecord } from '@/server/demands';
import { nonStandardSpelling } from '@/test/orthography';

import { DemandDetailScreen } from './[id]/DemandDetailScreen';
import { DemandForm } from './DemandForm';
import type { DemandFormState } from './demand-form-state';
import { DemandsScreen } from './DemandsScreen';
import { UnresolvedDemandNotice } from './UnresolvedDemandNotice';

/**
 * The demand screens as rendered: every outcome a read can have, the honest
 * empty states (checklist D 8–9), what the detail shows, the form in every
 * state, and the Persian orthography of everything they say (checklist I 19).
 */

jest.mock('./demand-actions', () => ({
  submitDemandRequest: jest.fn(),
  releaseUnresolvedDemand: jest.fn(),
}));

Object.assign(process.env, {
  API_GATEWAY_URL: 'http://gateway.test:3000',
  OIDC_ISSUER_URL: 'http://keycloak.test/realms/rasta',
  OIDC_CLIENT_ID: 'rasta-web',
  WEB_PUBLIC_ORIGIN: 'http://localhost:3200',
  WEB_SESSION_SECRET: 'a-secret-that-is-long-enough-to-be-a-key',
});

const DEMAND: DemandRecord = {
  id: 'DMR_1',
  organizationId: 'ORG-BUYER',
  productId: 'PRD_01J00000000000000000000000',
  quantity: 1200,
  status: 'WITHDRAWN',
  aggregationId: 'AGG_1',
  note: 'برای کارگاه شمالی',
  submittedAt: '2026-11-01T08:00:00.000Z',
  withdrawnAt: '2026-11-01T09:00:00.000Z',
  withdrawReason: 'نیاز برطرف شد',
  version: 2,
};

const AGGREGATION: AggregationRecord = {
  id: 'AGG_1',
  organizationId: 'ORG-BUYER',
  productId: DEMAND.productId,
  status: 'CANCELLED',
  openedAt: '2026-11-01T08:00:00.000Z',
  closesAt: '2026-11-02T08:00:00.000Z',
  totalQuantity: 4000,
  demandCount: 3,
  extensionCount: 1,
  setting: { windowHours: 24, minQuantity: 3000, shortfallPolicy: 'EXTEND', settingVersion: 2 },
  closedAt: '2026-11-02T08:00:00.000Z',
  cancelledAt: '2026-11-02T10:00:00.000Z',
  cancelReason: 'بودجه تغییر کرد',
  rfqId: null,
  version: 4,
};

const QUERY = { context: 'ctx-1' };

describe('the list', () => {
  it('draws each demand with its status and a link to it', () => {
    render(
      <DemandsScreen
        result={{ kind: 'OK', data: { items: [DEMAND], nextCursor: null } }}
        query={QUERY}
      />,
    );
    expect(
      screen.getByText(labels.demandStatusLabel('WITHDRAWN'), { selector: 'span' }),
    ).toBeTruthy();
    const link = screen.getByRole('link', { name: /DMR_1/ });
    expect(link.getAttribute('href')).toContain('/procurement/demands/DMR_1');
  });

  it('says "none" only at the end of the list', () => {
    render(
      <DemandsScreen
        result={{ kind: 'OK', data: { items: [], nextCursor: null } }}
        query={QUERY}
      />,
    );
    expect(screen.getByText('نیازی نیست')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'صفحه بعد' })).toBeNull();
  });

  it('an empty page with a cursor says more may exist and links on — never "none"', () => {
    render(
      <DemandsScreen
        result={{ kind: 'OK', data: { items: [], nextCursor: 'MORE' } }}
        query={{ ...QUERY, status: 'LAPSED' }}
      />,
    );
    expect(screen.queryByText('نیازی نیست')).toBeNull();
    expect(screen.getByText('در صفحه‌های خوانده‌شده نیازی نبود')).toBeTruthy();
    const next = screen.getByRole('link', { name: 'صفحه بعد' }).getAttribute('href') ?? '';
    expect(next).toContain('cursor=MORE');
    expect(next).toContain('status=LAPSED');
  });

  it('a refusal is "not available to your role", not an empty list', () => {
    render(<DemandsScreen result={{ kind: 'FORBIDDEN' }} query={QUERY} />);
    expect(screen.queryByText('نیازی نیست')).toBeNull();
    expect(screen.getByText('نیازهای این سازمان برای نقش شما در دسترس نیست.')).toBeTruthy();
  });

  it('a filter link starts from the first page', () => {
    render(
      <DemandsScreen
        result={{ kind: 'OK', data: { items: [], nextCursor: null } }}
        query={{ ...QUERY, cursor: 'C9' }}
      />,
    );
    const filter = screen.getByRole('link', { name: labels.demandStatusLabel('SUBMITTED') });
    expect(filter.getAttribute('href')).not.toContain('cursor=');
  });
});

describe('the detail', () => {
  it('shows the demand and the window it joined, read-only', () => {
    const { container } = render(
      <DemandDetailScreen
        result={{ kind: 'OK', data: DEMAND }}
        aggregation={{ kind: 'OK', data: AGGREGATION }}
        notice="submitted"
      />,
    );
    const text = container.textContent ?? '';
    for (const expected of [
      'نیاز برطرف شد',
      'بودجه تغییر کرد',
      labels.aggregationStatusLabel('CANCELLED'),
      labels.shortfallPolicyLabel('EXTEND'),
      '۱۲۰۰',
      '۴۰۰۰',
      demandCommands.DEMAND_NOTICE_TEXT.submitted,
    ]) {
      expect(text).toContain(expected);
    }
    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });

  it('another organization’s demand reads exactly like one that does not exist', () => {
    const { container } = render(
      <DemandDetailScreen result={{ kind: 'NOT_FOUND' }} aggregation={null} />,
    );
    expect(container.textContent).toContain('این نیاز پیدا نشد');
    expect(container.textContent).toContain('در سازمان فعال شما نیست');
  });

  it('an aggregation that could not be read is said apart from the demand', () => {
    const { container } = render(
      <DemandDetailScreen
        result={{ kind: 'OK', data: DEMAND }}
        aggregation={{ kind: 'UNAVAILABLE', status: 503, correlationId: 'corr-agg' }}
      />,
    );
    expect(container.textContent).toContain('پنجره تجمیع این نیاز خوانده نشد');
    expect(container.textContent).toContain('corr-agg');
  });
});

const STATES: readonly DemandFormState[] = [
  { kind: 'IDLE' },
  {
    kind: 'INVALID',
    submissionId: 's',
    replay: 'r',
    values: demandCommands.EMPTY_DEMAND_FORM,
    fieldErrors: { productId: 'x' },
    message: demandCommands.KEY_REUSED_MESSAGE,
  },
  { kind: 'REFUSED', reason: 'CSRF' },
  { kind: 'REFUSED', reason: 'SUBMISSION' },
  { kind: 'REFUSED', reason: 'NO_SESSION' as never },
  { kind: 'FORBIDDEN', correlationId: 'c' },
  { kind: 'FAILED', status: 429, correlationId: 'c' },
  { kind: 'FAILED', status: 401, correlationId: 'c' },
  { kind: 'UNCONFIRMED', correlationId: 'c' },
  {
    kind: 'IN_PROGRESS',
    submissionId: 's',
    replay: 'r',
    values: demandCommands.EMPTY_DEMAND_FORM,
    retryAfterSeconds: 1,
    correlationId: 'c',
  },
  { kind: 'EXPIRED', values: demandCommands.EMPTY_DEMAND_FORM },
  { kind: 'HELD', reason: 'CHANGED_BODY', values: demandCommands.EMPTY_DEMAND_FORM },
  { kind: 'HELD', reason: 'IN_PROGRESS', values: demandCommands.EMPTY_DEMAND_FORM },
  { kind: 'HELD', reason: 'OTHER_REQUEST', values: demandCommands.EMPTY_DEMAND_FORM },
  { kind: 'NOT_CHECKED', values: demandCommands.EMPTY_DEMAND_FORM },
  { kind: 'CAPACITY', values: demandCommands.EMPTY_DEMAND_FORM },
];

async function drawAnswered(state: DemandFormState) {
  const actions = jest.requireMock('./demand-actions') as Record<string, jest.Mock>;
  actions.submitDemandRequest!.mockResolvedValue(state);
  const view = render(
    <DemandForm csrfToken="csrf" submission={{ id: 'sub-1', replay: 'stamp-1' }} />,
  );
  await act(async () => {
    view.container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true }));
  });
  return view;
}

describe('the form', () => {
  it('carries the key and the stamp, and names no organization', () => {
    const { container } = render(
      <DemandForm csrfToken="csrf" submission={{ id: 'sub-1', replay: 'stamp-1' }} />,
    );
    const hidden = Object.fromEntries(
      [...container.querySelectorAll('input[type=hidden]')].map((input) => [
        input.getAttribute('name'),
        input.getAttribute('value'),
      ]),
    );
    expect(hidden).toEqual({ csrf: 'csrf', submission: 'sub-1', replay: 'stamp-1' });
    // The note limit is code points: no browser maxLength (UTF-16 units) on it.
    expect(container.querySelector('textarea[name=note]')?.hasAttribute('maxlength')).toBe(false);
  });

  it('after an unconfirmed answer the send is closed: check the list first', async () => {
    const { container } = await drawAnswered({ kind: 'UNCONFIRMED', correlationId: 'c' });
    expect(container.querySelector('button[type=submit]')?.hasAttribute('disabled')).toBe(true);
  });

  it('a request in progress is retried with the values it sent, under the same key', async () => {
    const values = { productId: 'PRD_01J00000000000000000000000', quantity: '5', note: 'n' };
    const { container } = await drawAnswered({
      kind: 'IN_PROGRESS',
      submissionId: 'sub-1',
      replay: 'stamp-1',
      values,
      retryAfterSeconds: 1,
      correlationId: 'c',
    });
    const hidden = [...container.querySelectorAll('input[type=hidden]')].map((input) => [
      input.getAttribute('name'),
      input.getAttribute('value'),
    ]);
    expect(hidden).toEqual(
      expect.arrayContaining([
        ['submission', 'sub-1'],
        ['productId', values.productId],
        ['quantity', '5'],
        ['note', 'n'],
      ]),
    );
    expect(
      container.querySelector('input[name=productId]:not([type=hidden])')?.hasAttribute('disabled'),
    ).toBe(true);
  });
});

describe('Persian orthography of everything the demand screens say', () => {
  function strings(value: unknown, out: string[] = []): string[] {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) for (const item of value) strings(item, out);
    else if (value !== null && typeof value === 'object') {
      for (const item of Object.values(value)) strings(item, out);
    }
    return out;
  }

  it.each([
    ['lib/demand-commands', demandCommands],
    ['lib/unconfirmed-write', unconfirmed],
    ['lib/session-refusal messages', SESSION_REFUSAL_MESSAGES],
    ['app/nav', nav],
  ])('%s', (_name, exported) => {
    expect(strings(exported).filter((text) => nonStandardSpelling(text) !== null)).toEqual([]);
  });

  it('the status labels', () => {
    const rendered = [
      ...demandCommands.DEMAND_STATUSES.map(labels.demandStatusLabel),
      ...['OPEN', 'READY', 'RFQ_ISSUED', 'REFERRED', 'LAPSED', 'CANCELLED'].map(
        labels.aggregationStatusLabel,
      ),
      ...['EXTEND', 'REFER', 'CLOSE'].map(labels.shortfallPolicyLabel),
    ];
    expect(rendered.filter((text) => /^[A-Z_]+$/.test(text))).toEqual([]);
    expect(rendered.filter((text) => nonStandardSpelling(text) !== null)).toEqual([]);
  });

  const root = __dirname;
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) return walk(full);
      return /\.(ts|tsx)$/.test(entry) && !/\.spec\./.test(entry) ? [full] : [];
    });
  const files = [
    ...walk(root),
    path.join(root, '..', '..', '..', 'lib', 'demand-commands.ts'),
    path.join(root, '..', '..', '..', 'server', 'demands.ts'),
    path.join(root, '..', '..', '..', 'server', 'demand-commands.ts'),
  ];

  it('covers the screens', () => expect(files.length).toBeGreaterThanOrEqual(12));

  it.each(files.map((file) => [path.relative(root, file), file]))('source %s', (_name, file) => {
    expect(nonStandardSpelling(readFileSync(file, 'utf8'))).toBeNull();
  });

  it.each(STATES.map((state) => [state.kind, state] as const))(
    'the form answering %s',
    async (_kind, state) => {
      const { container, unmount } = await drawAnswered(state);
      expect(nonStandardSpelling(container.textContent ?? '')).toBeNull();
      unmount();
    },
  );

  it('the screens and the unresolved notice', () => {
    for (const element of [
      <DemandsScreen
        key="l"
        result={{ kind: 'OK', data: { items: [DEMAND], nextCursor: 'C' } }}
        query={QUERY}
      />,
      <DemandsScreen
        key="e"
        result={{ kind: 'OK', data: { items: [], nextCursor: null } }}
        query={QUERY}
      />,
      <DemandsScreen key="f" result={{ kind: 'FORBIDDEN' }} query={QUERY} />,
      <DemandsScreen key="n" result={{ kind: 'NOT_FOUND' }} query={QUERY} />,
      <DemandDetailScreen
        key="d"
        result={{ kind: 'OK', data: DEMAND }}
        aggregation={{ kind: 'OK', data: AGGREGATION }}
        notice="submitted"
      />,
      <DemandDetailScreen key="x" result={{ kind: 'NOT_FOUND' }} aggregation={null} />,
      <DemandDetailScreen
        key="a"
        result={{ kind: 'OK', data: DEMAND }}
        aggregation={{ kind: 'FORBIDDEN' }}
      />,
      <UnresolvedDemandNotice
        key="u"
        request={{ id: 'r', key: 'k', digest: 'd', deadline: null, ref: 'ref', inFlight: true }}
        csrfToken="csrf"
        releaseToken="t"
        now={0}
        listHref="/procurement/demands"
      />,
      <UnresolvedDemandNotice
        key="v"
        request={{ id: 'r', key: 'k', digest: 'd', deadline: 1, ref: 'ref', inFlight: false }}
        csrfToken="csrf"
        releaseToken="t"
        now={10_000_000}
        listHref="/procurement/demands"
      />,
    ]) {
      const { container, unmount } = render(element);
      expect(nonStandardSpelling(container.textContent ?? '')).toBeNull();
      unmount();
    }
  });
});
