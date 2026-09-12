import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuditView } from './audit-view';
import { AuditDetailView } from './audit-detail-view';
import { AuditVerifyPanel } from './audit-verify';
import {
  expectNoAxeViolations,
  makeHarness,
  renderRoute,
  renderWithSession,
  respondError,
} from '@/test/harness';
import { capabilityByKey } from '@/lib/capabilities';
import { resolveTourStops } from '@/lib/demo/tour';

/**
 * The audit evidence screens (AUD-001 through AUD-003).
 *
 * What is protected here is narrower than "the page renders": it is the set
 * of claims a screenshot of this page could make that the backend does not
 * back. `docs/runbooks` and ADR-053 are explicit that the hash chain is
 * tamper-*evident*, not tamper-proof, and that AUD-004 (correction) does not
 * exist yet — both are exactly the kind of overstatement a UI slips into by
 * accident, so both are asserted against directly rather than trusted to
 * prose review.
 */

const EVENT = {
  id: 'aev_1',
  occurredAt: '2026-01-01T10:00:00.000Z',
  recordedAt: '2026-01-01T10:00:01.000Z',
  actorType: 'USER',
  actorId: 'usr_1',
  actorRoles: [],
  organizationId: 'org_one',
  action: 'asset.asset_registered',
  resourceType: 'Asset',
  resourceId: 'ast_1',
  outcome: 'SUCCESS',
  errorCode: null,
  reason: null,
  changes: null,
  occurrenceCount: 1,
  sourceService: 'asset-service',
  sourceServiceVersion: '1.0.0',
  sourceEventId: 'evt_1',
  sourceEventName: 'ASSET_REGISTERED',
  sourceTopic: 'rasta.asset.v1',
  sourceIp: null,
  sourceUserAgent: null,
  correlationId: 'cid_1',
  causationId: null,
  traceparent: null,
  sourceStreamSeq: '1',
  sequenceNo: '1',
  integrity: 'CHAINED',
};

const PAGE = { items: [EVENT], nextCursor: null, hasMore: false };

const baseVerification = (status: string, extra: Record<string, unknown> = {}) => ({
  scope: 'ORGANIZATION',
  organizationId: 'org_one',
  from: '2026-01-01T00:00:00.000Z',
  to: '2026-01-02T00:00:00.000Z',
  status,
  valid: status === 'VALID',
  canonicalVersion: 1,
  recordsInRange: 1,
  recordsVerified: status === 'VALID' ? 1 : 0,
  unchainedRecords: status === 'UNVERIFIABLE_LEGACY' ? 1 : 0,
  months: [],
  firstDivergence: null,
  ...extra,
});

describe('AuditView: the list and the verify panel', () => {
  it('no longer claims AuditEvent is unimplemented', async () => {
    const { session, fetchMock } = makeHarness();
    fetchMock.mockImplementation(
      renderRoute({
        '/v1/audit-events': PAGE,
        '/v1/audit-events/verify': baseVerification('VALID'),
      }),
    );

    renderWithSession(<AuditView />, session);
    await screen.findByText('asset.asset_registered');

    expect(screen.queryByText(/AuditEvent.*(نشده|not implemented)/)).not.toBeInTheDocument();
    expect(screen.queryByText(/هنوز ساخته نشده/)).not.toBeInTheDocument();
  });

  it('reaches the backend only through the list endpoint, with the mandatory window', async () => {
    const { session, fetchMock } = makeHarness();
    fetchMock.mockImplementation(
      renderRoute({
        '/v1/audit-events': PAGE,
        '/v1/audit-events/verify': baseVerification('VALID'),
      }),
    );

    renderWithSession(<AuditView />, session);
    await screen.findByText('asset.asset_registered');

    const listCall = fetchMock.mock.calls.find((call) =>
      String(call[0]).includes('/v1/audit-events?'),
    );
    expect(listCall).toBeDefined();
    const url = new URL(String(listCall![0]));
    expect(url.searchParams.has('from')).toBe(true);
    expect(url.searchParams.has('to')).toBe(true);
  });

  it('exposes no control that writes', async () => {
    const { session, fetchMock } = makeHarness();
    fetchMock.mockImplementation(
      renderRoute({
        '/v1/audit-events': PAGE,
        '/v1/audit-events/verify': baseVerification('VALID'),
      }),
    );

    const { container } = renderWithSession(<AuditView />, session);
    await screen.findByText('asset.asset_registered');

    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit | undefined;
      expect(init?.method ?? 'GET').toBe('GET');
    }
    // No button on this screen claims to submit, delete, export or correct —
    // every one of them either searches, verifies, resets, or paginates.
    const buttonLabels = within(container)
      .getAllByRole('button')
      .map((button) => button.textContent);
    for (const label of buttonLabels) {
      expect(label).not.toMatch(/اصلاح|حذف|خروجی|Export|Purge|Correct/i);
    }
  });

  it('names AUD-004 only as an exclusion, never as a working control', async () => {
    const { session, fetchMock } = makeHarness();
    fetchMock.mockImplementation(
      renderRoute({
        '/v1/audit-events': PAGE,
        '/v1/audit-events/verify': baseVerification('VALID'),
      }),
    );

    const { container } = renderWithSession(<AuditView />, session);
    await screen.findByText('asset.asset_registered');

    // The page is allowed to *say* AUD-004 does not exist yet — that is the
    // honest disclosure the task asks for — but it must never offer a control
    // for it: no button or link whose name suggests correcting, exporting or
    // purging a record.
    expect(container.textContent).toMatch(/AUD-004.*ساخته نشده/);
    for (const button of within(container).getAllByRole('button')) {
      expect(button.textContent).not.toMatch(/اصلاح|حذف|خروجی|Export|Purge|Correct/i);
    }
    for (const link of within(container).queryAllByRole('link')) {
      expect(link.textContent).not.toMatch(/اصلاح|خروجی|Export|Purge/i);
    }
  });

  it('has no accessibility violations', async () => {
    const { session, fetchMock } = makeHarness();
    fetchMock.mockImplementation(
      renderRoute({
        '/v1/audit-events': PAGE,
        '/v1/audit-events/verify': baseVerification('VALID'),
      }),
    );

    const { container } = renderWithSession(<AuditView />, session);
    await screen.findByText('asset.asset_registered');
    await expectNoAxeViolations(container);
  });

  it('shows the forbidden-scope state rather than a generic error for AUDITOR', async () => {
    const { session, fetchMock } = makeHarness();
    fetchMock.mockImplementation(respondError(403, 'INSUFFICIENT_ROLE'));

    renderWithSession(<AuditView />, session);

    // Both the list and the verify panel fetch on mount and both are refused,
    // so the refusal message legitimately appears twice on the page.
    const refusals = await screen.findAllByText('این بخش برای نقش شما باز نیست');
    expect(refusals.length).toBeGreaterThanOrEqual(1);
  });
});

describe('AuditVerifyPanel: the four outcomes, and nothing stronger than they are', () => {
  it('renders VALID without ever calling it tamper-proof', async () => {
    const { session, fetchMock } = makeHarness();
    fetchMock.mockImplementation(
      renderRoute({ '/v1/audit-events/verify': baseVerification('VALID') }),
    );

    const { container } = renderWithSession(<AuditVerifyPanel />, session);
    await userEvent.click(screen.getByRole('button', { name: 'بررسی زنجیره' }));

    await screen.findByText('معتبر');
    // The explanation is allowed to *deny* tamper-proofness ("نه اینکه
    // غیرقابل دست‌کاری باشد") — that denial is the honest claim. What must
    // never appear is an affirmative claim of it, or the banned absolute
    // phrasing AGENTS.md S-10 forbids everywhere in this repository.
    expect(container.textContent).not.toMatch(/زنجیره(ٔ)? غیرقابل دست‌کاری است/);
    expect(container.textContent).not.toMatch(/تمام‌عیار|100%|Military Grade/i);
    expect(container.textContent).toMatch(/نه اینکه غیرقابل دست‌کاری باشد/);
    expect(container.textContent).toMatch(/مشهود/);
    expect(container.textContent).toMatch(/نه امضای دیجیتال/);
  });

  it('renders DIVERGENT with its first divergence', async () => {
    const { session, fetchMock } = makeHarness();
    fetchMock.mockImplementation(
      renderRoute({
        '/v1/audit-events/verify': baseVerification('DIVERGENT', {
          recordsInRange: 3,
          recordsVerified: 2,
          firstDivergence: {
            month: '2026-01',
            auditEventId: 'aev_bad',
            occurredAt: '2026-01-01T10:00:00.000Z',
            sequenceNo: '7',
            reason: 'RECORD_HASH_MISMATCH',
          },
        }),
      }),
    );

    renderWithSession(<AuditVerifyPanel />, session);
    await userEvent.click(screen.getByRole('button', { name: 'بررسی زنجیره' }));

    await screen.findByText('واگرا');
    expect(screen.getByText('aev_bad')).toBeInTheDocument();
  });

  it('renders EMPTY', async () => {
    const { session, fetchMock } = makeHarness();
    fetchMock.mockImplementation(
      renderRoute({
        '/v1/audit-events/verify': baseVerification('EMPTY', { recordsInRange: 0 }),
      }),
    );

    renderWithSession(<AuditVerifyPanel />, session);
    await userEvent.click(screen.getByRole('button', { name: 'بررسی زنجیره' }));

    expect(await screen.findByText('بدون رکورد')).toBeInTheDocument();
  });

  it('renders UNVERIFIABLE_LEGACY and does not call it invalid', async () => {
    const { session, fetchMock } = makeHarness();
    fetchMock.mockImplementation(
      renderRoute({
        '/v1/audit-events/verify': baseVerification('UNVERIFIABLE_LEGACY', {
          recordsInRange: 5,
          unchainedRecords: 5,
        }),
      }),
    );

    const { container } = renderWithSession(<AuditVerifyPanel />, session);
    await userEvent.click(screen.getByRole('button', { name: 'بررسی زنجیره' }));

    await screen.findByText('غیرقابل‌تأیید (پیش از AUD-003)');
    expect(container.textContent).not.toMatch(/نامعتبر است/);
  });
});

describe('AuditDetailView', () => {
  it('renders the record without dumping raw JSON changes', async () => {
    const { session, fetchMock } = makeHarness();
    fetchMock.mockImplementation(renderRoute({ '/v1/audit-events/aev_1': EVENT }));

    const { container } = renderWithSession(<AuditDetailView auditEventId="aev_1" />, session);

    await screen.findByText('asset.asset_registered');
    expect(container.querySelector('pre')).toBeNull();
    expect(screen.getByText('ast_1')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { session, fetchMock } = makeHarness();
    fetchMock.mockImplementation(renderRoute({ '/v1/audit-events/aev_1': EVENT }));

    const { container } = renderWithSession(<AuditDetailView auditEventId="aev_1" />, session);
    await screen.findByText('asset.asset_registered');
    await expectNoAxeViolations(container);
  });
});

describe('capability state and tour state derive from the same manifest', () => {
  it('resolves the audit tour stop to the audit capability', () => {
    const stop = resolveTourStops(false).find((entry) => entry.id === 'audit');
    expect(stop?.capability).toBe(capabilityByKey('audit'));
    expect(stop?.capability.state).toBe('BETA');
  });
});
