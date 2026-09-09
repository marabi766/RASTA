import { screen, within } from '@testing-library/react';
import { DocumentsView } from './documents-view';
import { SCAN_STATE_PRESENTATION } from '@/lib/api/adapters/document';
import {
  expectNoAxeViolations,
  makeHarness,
  renderWithSession,
  respondError,
  respondJson,
} from '@/test/harness';

/**
 * Document metadata.
 *
 * The scan column is the whole point of the screen, and the risk it guards
 * against is a UI being *tidy*: four states that all mean "you cannot download
 * this" invite being flattened into one, and flattening them throws away the
 * only information an operator could act on.
 */

function doc(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc_1',
    organizationId: 'org_one',
    documentClass: 'INSURANCE_POLICY',
    status: 'REGISTERED',
    contentType: 'application/pdf',
    sizeBytes: 12345,
    filename: 'bimeh.pdf',
    scanState: 'PENDING',
    scanInspectedContent: false,
    scanEngine: null,
    scanSignatureVersion: null,
    scanSignature: null,
    scanFailureReason: null,
    quarantinedAt: null,
    scannedAt: null,
    ownerResourceType: null,
    ownerResourceId: null,
    createdAt: '2026-02-01T00:00:00.000Z',
    createdBy: 'usr_1',
    deletedAt: null,
    deletionReason: null,
    ...overrides,
  };
}

const SCAN_STATES = ['CLEAN', 'PENDING', 'NOT_SCANNED', 'INFECTED', 'FAILED'] as const;

describe('scan verdicts', () => {
  it('gives each of the five states its own distinct meaning', () => {
    // A structural assertion. Two states sharing an explanation would be the
    // first symptom of the flattening this screen exists to avoid.
    const meanings = SCAN_STATES.map((state) => SCAN_STATE_PRESENTATION[state].meaning);
    expect(new Set(meanings).size).toBe(SCAN_STATES.length);
  });

  it('permits a download only for CLEAN', () => {
    for (const state of SCAN_STATES) {
      expect(SCAN_STATE_PRESENTATION[state].downloadable).toBe(state === 'CLEAN');
    }
  });

  it.each(SCAN_STATES)('renders %s with its own explanation', async (state) => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(
      respondJson({ items: [doc({ scanState: state })], nextCursor: null }),
    );

    renderWithSession(<DocumentsView />, session);
    await screen.findByRole('table');

    const row = screen.getByRole('row', { name: /bimeh\.pdf/ });
    expect(row).toHaveTextContent(state);
    expect(row).toHaveTextContent(SCAN_STATE_PRESENTATION[state].label);
    expect(within(row).getByText(SCAN_STATE_PRESENTATION[state].meaning)).toBeInTheDocument();
  });

  it('separates "not scanned" from "clean" in the copy', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(
      respondJson({ items: [doc({ scanState: 'NOT_SCANNED' })], nextCursor: null }),
    );

    renderWithSession(<DocumentsView />, session);
    await screen.findByRole('table');

    expect(screen.getByText(/با «پاک» یکی نیست/)).toBeInTheDocument();
  });

  it('shows the signature database behind a clean verdict', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(
      respondJson({
        items: [
          doc({
            scanState: 'CLEAN',
            scanInspectedContent: true,
            scanEngine: 'clamav',
            scanSignatureVersion: '27100',
            scannedAt: '2026-02-01T01:00:00.000Z',
          }),
        ],
        nextCursor: null,
      }),
    );

    renderWithSession(<DocumentsView />, session);
    await screen.findByRole('table');

    // A clean verdict without a dated signature database is an undated claim.
    expect(screen.getByText('clamav')).toBeInTheDocument();
    expect(screen.getByText('27100')).toBeInTheDocument();
  });
});

describe('what this screen deliberately omits', () => {
  it('offers no download control and no upload form', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(
      respondJson({ items: [doc({ scanState: 'CLEAN' })], nextCursor: null }),
    );

    const { container } = renderWithSession(<DocumentsView />, session);
    await screen.findByRole('table');

    expect(container.querySelector('form')).toBeNull();
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(screen.queryByRole('button', { name: /دانلود|آپلود/ })).not.toBeInTheDocument();
    // And says why, rather than leaving the absence to be noticed.
    expect(screen.getByText('دانلود در این نسخه فعال نیست.')).toBeInTheDocument();
  });

  it('renders a role refusal as a refusal', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondError(403, 'FORBIDDEN'));

    renderWithSession(<DocumentsView />, session);

    expect(await screen.findByText('این بخش برای نقش شما باز نیست')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { fetchMock, session } = makeHarness();
    fetchMock.mockImplementation(respondJson({ items: [doc()], nextCursor: null }));

    const { container } = renderWithSession(<DocumentsView />, session);
    await screen.findByRole('table');

    await expectNoAxeViolations(container);
  });
});
