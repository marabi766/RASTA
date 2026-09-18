import { axe } from 'jest-axe';
import { screen } from '@testing-library/react';

import { itSnapshotsInBothDirections, renderInDirection } from '@/test/directions';

import { Alert } from './Alert';
import { STATUS_TONES, StatusBadge } from './StatusBadge';

describe('StatusBadge', () => {
  // The table of docs/16 § 16.5, asserted entry by entry. This is the whole
  // point of the component: one status, one colour, on every screen.
  it.each([
    ['ACTIVE', 'success'],
    ['APPROVED', 'success'],
    ['COMPLETED', 'success'],
    ['SETTLED', 'success'],
    ['PENDING_APPROVAL', 'warning'],
    ['BID_OPEN', 'warning'],
    ['IN_PROGRESS', 'warning'],
    ['REJECTED', 'danger'],
    ['CANCELLED', 'danger'],
    ['FAILED', 'danger'],
    ['OUT_OF_SERVICE', 'danger'],
    ['DRAFT', 'neutral'],
    ['IDLE', 'neutral'],
    ['IN_MAINTENANCE', 'info'],
    ['EVALUATION', 'info'],
  ])('gives %s the %s tone', (status, tone) => {
    expect(STATUS_TONES[status]).toBe(tone);
    const { container } = renderInDirection(<StatusBadge status={status} />, 'rtl');
    expect(container.firstElementChild).toHaveAttribute('data-tone', tone);
  });

  // A service that adds a status before the portal knows about it should get a
  // plain badge, not a thrown render.
  it('falls back to neutral for a status it does not know', () => {
    const { container } = renderInDirection(<StatusBadge status="SOMETHING_NEW" />, 'rtl');
    expect(container.firstElementChild).toHaveAttribute('data-tone', 'neutral');
    expect(screen.getByText('SOMETHING_NEW')).toBeInTheDocument();
  });

  it('lets a screen name the status in its own words', () => {
    renderInDirection(<StatusBadge status="ACTIVE" label="در سرویس" />, 'rtl');
    expect(screen.getByText('در سرویس')).toBeInTheDocument();
  });

  // WCAG 1.4.1: colour is never the only carrier of meaning.
  it('carries a symbol beside the colour', () => {
    const { container } = renderInDirection(<StatusBadge status="REJECTED" />, 'rtl');
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('has no accessibility violations', async () => {
    const { container } = renderInDirection(<StatusBadge status="PENDING_APPROVAL" />, 'rtl');
    expect(await axe(container)).toHaveNoViolations();
  });

  itSnapshotsInBothDirections('one badge of each tone', () => (
    <div>
      <StatusBadge status="ACTIVE" />
      <StatusBadge status="PENDING_APPROVAL" />
      <StatusBadge status="REJECTED" />
      <StatusBadge status="IN_MAINTENANCE" />
      <StatusBadge status="DRAFT" />
    </div>
  ));
});

describe('Alert', () => {
  // Only what the user must act on now interrupts. Making everything an alert
  // trains people to ignore all of them.
  it.each([
    ['success', 'status'],
    ['info', 'status'],
    ['warning', 'alert'],
    ['danger', 'alert'],
  ] as const)('gives the %s tone role="%s"', (tone, role) => {
    renderInDirection(<Alert tone={tone}>پیام</Alert>, 'rtl');
    expect(screen.getByRole(role)).toHaveTextContent('پیام');
  });

  it('shows a title and an action when given them', () => {
    renderInDirection(
      <Alert tone="danger" title="ارسال نشد" actions={<button type="button">تلاش دوباره</button>}>
        اتصال برقرار نشد.
      </Alert>,
      'rtl',
    );
    expect(screen.getByText('ارسال نشد')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'تلاش دوباره' })).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = renderInDirection(
      <Alert tone="warning" title="سررسید نزدیک است">
        سه بیمه‌نامه تا ده روز دیگر منقضی می‌شوند.
      </Alert>,
      'rtl',
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  itSnapshotsInBothDirections('a danger alert with a title and an action', () => (
    <Alert tone="danger" title="ارسال نشد" actions={<button type="button">تلاش دوباره</button>}>
      اتصال برقرار نشد.
    </Alert>
  ));
});
