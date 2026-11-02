import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { PUBLICATION_REFUSAL_TEXT } from '@/lib/tender-owner-fields';
import * as messages from '@/lib/procurement-threshold-fields';
import { PENDING_REQUEST, TENDER_ID } from '@/test/owner-fixtures';
import { ThresholdPreviewView, RequestView } from './[id]/OwnerSections';
import { AuthorityScreen } from './[id]/AuthoritySections';

describe('procurement threshold pre-decision visibility', () => {
  it.each([
    ['WARN', messages.THRESHOLD_WARNING_TEXT],
    ['REJECT', messages.THRESHOLD_REJECT_TEXT],
    ['ESTIMATE_REQUIRED', messages.THRESHOLD_REQUIRED_TEXT],
  ] as const)('shows %s before publication', async (decision, message) => {
    const { container } = render(
      <ThresholdPreviewView
        tenderVersion={2}
        result={{
          kind: 'OK',
          data: { tenderVersion: 2, decision, procurementThresholdPolicyId: 'POL-test' },
        }}
      />,
    );
    expect(screen.getByText(message)).toBeVisible();
    expect(container.textContent).not.toMatch(/[\u0654أإؤئ]/u);
    expect(await axe(container)).toHaveNoViolations();
  });
  it('does not present a stale preview as current', () => {
    render(
      <ThresholdPreviewView
        tenderVersion={3}
        result={{
          kind: 'OK',
          data: { tenderVersion: 2, decision: 'WARN', procurementThresholdPolicyId: 'POL-test' },
        }}
      />,
    );
    expect(screen.getByText(messages.THRESHOLD_UNREAD_TEXT)).toBeVisible();
    expect(screen.queryByText(messages.THRESHOLD_WARNING_TEXT)).toBeNull();
  });
  it('keeps an unavailable preview unknown', () => {
    render(
      <ThresholdPreviewView
        tenderVersion={2}
        result={{ kind: 'UNAVAILABLE', status: 503, correlationId: 'test-unavailable' }}
      />,
    );
    expect(screen.getByText(messages.THRESHOLD_UNREAD_TEXT)).toBeVisible();
  });
  it('shows the approval round warning to the owner', () => {
    render(
      <RequestView
        request={{
          kind: 'OK',
          data: {
            ...PENDING_REQUEST,
            procurementThresholdWarning: 'PROCUREMENT_AMOUNT_OUTSIDE_RANGE',
          },
        }}
      />,
    );
    expect(screen.getByText(messages.THRESHOLD_WARNING_TEXT)).toBeVisible();
  });
  it('shows the stored warning before an external authority decides', async () => {
    const { container } = render(
      <AuthorityScreen
        tenderId={TENDER_ID}
        truncated={false}
        steps={[
          {
            step: {
              id: 'APR-test',
              tenderId: TENDER_ID,
              workflowKey: 'tender.publication',
              stepOrder: 1,
              status: 'PENDING',
              authorityOrganizationId: 'ORG-authority',
              authorityRole: 'ORGANIZATION_ADMIN',
              authorityLabel: 'بازبین',
              requestedAt: '2026-10-23T12:00:00.000Z',
              version: 1,
              project: { title: 'راه' },
              request: {
                requestId: 'REQ-test',
                tenderVersion: 2,
                status: 'PENDING',
                requestedBy: 'USR-owner',
                bid: null,
                procurementThresholdWarning: 'PROCUREMENT_AMOUNT_OUTSIDE_RANGE',
              },
            },
            notes: [],
            commands: <button>موافقت</button>,
          },
        ]}
      />,
    );
    expect(screen.getByText(messages.THRESHOLD_WARNING_TEXT)).toBeVisible();
    expect(screen.getByRole('button', { name: 'موافقت' })).toBeVisible();
    expect(await axe(container)).toHaveNoViolations();
  });
  it('threshold refusal uses the configured ZWNJ spelling', () => {
    expect(PUBLICATION_REFUSAL_TEXT.PROCUREMENT_AMOUNT_OUTSIDE_RANGE).toContain('پیکربندی‌شده');
  });
  it('all new fixed threshold messages have no hamza', () => {
    for (const message of Object.values(messages)) expect(message).not.toMatch(/[\u0654أإؤئ]/u);
  });
});
