import { render } from '@testing-library/react';
import { axe } from 'jest-axe';

import { DriverDetailScreen } from './DriverDetailScreen';
import type { AssignmentPage, DriverDetail, ReadResult } from '@/server/drivers';

/**
 * The driver detail screen's read side: which section renders for which
 * outcome, and — the one piece of logic genuinely new to this screen —
 * which of the two assignment forms appears.
 *
 * `useActionState` is not mocked here, unlike `driver-forms.spec.tsx`: this
 * file is about composition and branching, not about any one form's states,
 * so the four embedded forms render in their ordinary idle shape and the
 * assertions never look inside them beyond "is it here".
 */

const DRIVER: DriverDetail = {
  id: 'DRV_1',
  userId: 'USR_9',
  employeeNo: 'EMP-1',
  licenceNumber: 'LIC-1',
  licenceClass: 'B',
  licenceValidTo: '2027-01-01T00:00:00.000Z',
  status: 'ACTIVE',
  statusReason: null,
  notes: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const SUBMISSION_IDS = {
  update: 'sub_AAAAAAAAAAAAAAAAAAAA',
  status: 'sub_BBBBBBBBBBBBBBBBBBBB',
  assign: 'sub_CCCCCCCCCCCCCCCCCCCC',
  end: 'sub_DDDDDDDDDDDDDDDDDDDD',
};

function render_(result: ReadResult<DriverDetail>, assignments: ReadResult<AssignmentPage>) {
  return render(
    <DriverDetailScreen
      result={result}
      assignments={assignments}
      driverId="DRV_1"
      csrfToken="csrf-token-for-this-session"
      submissionIds={SUBMISSION_IDS}
    />,
  );
}

const NO_ASSIGNMENTS: ReadResult<AssignmentPage> = {
  kind: 'OK',
  data: { items: [], nextCursor: null, hasMore: false },
};

describe('the driver record', () => {
  it('shows the identity and status of a found driver', () => {
    const { getByText } = render_({ kind: 'OK', data: DRIVER }, NO_ASSIGNMENTS);
    expect(getByText('فعال')).toBeInTheDocument();
    expect(getByText('گواهینامه LIC-1')).toBeInTheDocument();
  });

  it('renders a refusal as a refusal', () => {
    const { getByText } = render_({ kind: 'FORBIDDEN' }, NO_ASSIGNMENTS);
    expect(getByText('دسترسی ندارید')).toBeInTheDocument();
  });

  it('answers a missing driver the same way it answers somebody else’s', () => {
    const { getByText } = render_({ kind: 'NOT_FOUND' }, NO_ASSIGNMENTS);
    expect(getByText('این راننده پیدا نشد')).toBeInTheDocument();
  });

  it('shows the correlation id on an outage', () => {
    const { getByText } = render_(
      { kind: 'UNAVAILABLE', status: 503, correlationId: 'COR_9' },
      NO_ASSIGNMENTS,
    );
    expect(getByText(/COR_9/)).toBeInTheDocument();
  });

  it('does not render any form when the driver itself could not be read', () => {
    const { queryByRole } = render_({ kind: 'FORBIDDEN' }, NO_ASSIGNMENTS);
    expect(queryByRole('button', { name: /ذخیره|ثبت|تخصیص/ })).toBeNull();
  });
});

describe('which assignment form shows', () => {
  it('offers to assign a machine when the driver holds none', () => {
    const { getByRole, queryByText } = render_({ kind: 'OK', data: DRIVER }, NO_ASSIGNMENTS);
    expect(getByRole('button', { name: 'تخصیص به این ماشین' })).toBeInTheDocument();
    expect(queryByText('پایان تخصیص')).toBeNull();
  });

  it('offers to end the assignment, and shows it, when the driver holds one', () => {
    const active: ReadResult<AssignmentPage> = {
      kind: 'OK',
      data: {
        items: [
          {
            id: 'ASG_1',
            driverId: 'DRV_1',
            assetId: 'AST_1',
            active: true,
            startedAt: '2026-09-01T00:00:00.000Z',
            endedAt: null,
            purpose: null,
            endReason: null,
            endNotes: null,
          },
        ],
        nextCursor: null,
        hasMore: false,
      },
    };
    const { getByRole, getByText, queryByRole } = render_({ kind: 'OK', data: DRIVER }, active);
    expect(getByText(/هم‌اکنون به/)).toBeInTheDocument();
    expect(getByRole('button', { name: 'پایان تخصیص' })).toBeInTheDocument();
    expect(queryByRole('button', { name: 'تخصیص به این ماشین' })).toBeNull();
  });

  it('shows only the ended history, and still offers a new assignment, once one has ended', () => {
    const ended: ReadResult<AssignmentPage> = {
      kind: 'OK',
      data: {
        items: [
          {
            id: 'ASG_1',
            driverId: 'DRV_1',
            assetId: 'AST_1',
            active: false,
            startedAt: '2026-09-01T00:00:00.000Z',
            endedAt: '2026-09-02T00:00:00.000Z',
            purpose: null,
            endReason: 'COMPLETED',
            endNotes: null,
          },
        ],
        nextCursor: null,
        hasMore: false,
      },
    };
    const { getByRole, getByText } = render_({ kind: 'OK', data: DRIVER }, ended);
    expect(getByRole('button', { name: 'تخصیص به این ماشین' })).toBeInTheDocument();
    // The reason is joined into the same line as the dates, not its own node.
    expect(getByText(/پایان کار/)).toBeInTheDocument();
  });
});

describe('the assignment read failing independently of the driver read', () => {
  it('still shows the driver record when only the assignment read fails', () => {
    const { getByText } = render_(
      { kind: 'OK', data: DRIVER },
      { kind: 'UNAVAILABLE', status: 503, correlationId: 'COR_7' },
    );
    expect(getByText('فعال')).toBeInTheDocument();
    expect(getByText(/COR_7/)).toBeInTheDocument();
  });
});

describe('accessibility', () => {
  it('has no violations with no active assignment', async () => {
    const { container } = render_({ kind: 'OK', data: DRIVER }, NO_ASSIGNMENTS);
    expect(await axe(container)).toHaveNoViolations();
  });
});
