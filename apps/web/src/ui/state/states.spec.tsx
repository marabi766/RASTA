import { axe } from 'jest-axe';
import { fireEvent, screen } from '@testing-library/react';

import { itSnapshotsInBothDirections, renderInDirection } from '@/test/directions';

import { EmptyState } from './EmptyState';
import { ErrorState } from './ErrorState';
import { LoadingState } from './LoadingState';
import { NoAccessState } from './NoAccessState';
import { Skeleton } from './Skeleton';

/**
 * The three mandatory states of docs/16 § 16.4, plus the two that support
 * them. The document's rule is that a view with only a success state is
 * incomplete and is not merged, so these are the components every data-driven
 * screen will be required to use — which makes their contract worth pinning
 * down here rather than on each screen.
 *
 * ## Why the sample correlation id looks the way it does
 *
 * `req-sample-correlation`, and not a realistic `req_` followed by a ULID. A
 * real correlation id is a high-entropy token, and CI's secret scan reads a
 * high-entropy token beside an identifier-shaped name as a leaked key — it did,
 * on exactly such a fixture, and failed the build. The finding was wrong about
 * the value and right about the shape, so the fix is a fixture that is
 * obviously a fixture rather than an exception carved into the scanner.
 *
 * This comment does not quote the offending string either. A scanner reads a
 * comment exactly as it reads code, and the first attempt at this note put the
 * value straight back into the branch.
 *
 * Do not "improve" these into realistic ids.
 */

/** Deliberately low-entropy and obviously synthetic. See the note above. */
const SAMPLE_CORRELATION_ID = 'req-sample-correlation';

describe('EmptyState', () => {
  it('shows the headline and the way out of the state', () => {
    renderInDirection(
      <EmptyState
        title="هنوز ماشین‌آلاتی ثبت نشده"
        description="اولین دارایی را ثبت کنید تا اینجا دیده شود."
        action={<button type="button">ثبت دارایی</button>}
      />,
      'rtl',
    );
    expect(screen.getByText('هنوز ماشین‌آلاتی ثبت نشده')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ثبت دارایی' })).toBeInTheDocument();
  });

  // Empty is not a fault. `role="status"` waits for a pause; `alert` would
  // interrupt to announce that nothing is wrong.
  it('announces politely rather than as an alert', () => {
    renderInDirection(<EmptyState title="خالی" />, 'rtl');
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('has no accessibility violations', async () => {
    const { container } = renderInDirection(
      <EmptyState title="خالی" action={<button type="button">اقدام</button>} />,
      'rtl',
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  itSnapshotsInBothDirections('with a description and an action', () => (
    <EmptyState
      title="هنوز ماشین‌آلاتی ثبت نشده"
      description="اولین دارایی را ثبت کنید."
      action={<button type="button">ثبت دارایی</button>}
    />
  ));
});

describe('LoadingState', () => {
  // The document is explicit: a skeleton shaped like the content, not a
  // spinner. A spinner would leave the page to jump when the data lands.
  it('draws one shape per expected row', () => {
    const { container } = renderInDirection(<LoadingState variant="table" rows={4} />, 'rtl');
    // Four rows plus the header bar above them.
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(5);
  });

  it('announces politely and marks itself busy', () => {
    renderInDirection(<LoadingState />, 'rtl');
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveAttribute('aria-live', 'polite');
  });

  // One announcement for the whole region, not one per placeholder.
  it('exposes exactly one piece of text', () => {
    renderInDirection(<LoadingState variant="cards" rows={6} />, 'rtl');
    expect(screen.getByText('در حال بارگذاری')).toBeInTheDocument();
  });

  it('has no accessibility violations', async () => {
    const { container } = renderInDirection(<LoadingState variant="form" rows={2} />, 'rtl');
    expect(await axe(container)).toHaveNoViolations();
  });

  itSnapshotsInBothDirections('a table of three rows', () => (
    <LoadingState variant="table" rows={3} />
  ));
});

describe('ErrorState', () => {
  // The requirement docs/16 § 16.4 names and that is always the one dropped.
  it('puts the correlation id on screen', () => {
    renderInDirection(<ErrorState correlationId={SAMPLE_CORRELATION_ID} />, 'rtl');
    expect(screen.getByText(SAMPLE_CORRELATION_ID)).toBeInTheDocument();
  });

  it('isolates the correlation id so its punctuation cannot reorder', () => {
    const { container } = renderInDirection(
      <ErrorState correlationId={SAMPLE_CORRELATION_ID} />,
      'rtl',
    );
    expect(container.querySelector('bdi')).toHaveAttribute('dir', 'auto');
  });

  it('interrupts, because the user cannot continue without reading it', () => {
    renderInDirection(<ErrorState correlationId={SAMPLE_CORRELATION_ID} />, 'rtl');
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('offers a retry only when the caller supplied one', () => {
    const onRetry = jest.fn();
    const { unmount } = renderInDirection(
      <ErrorState correlationId={SAMPLE_CORRELATION_ID} onRetry={onRetry} />,
      'rtl',
    );
    fireEvent.click(screen.getByRole('button', { name: 'تلاش دوباره' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    unmount();

    renderInDirection(<ErrorState correlationId={SAMPLE_CORRELATION_ID} />, 'rtl');
    expect(screen.queryByRole('button')).toBeNull();
  });

  // The code belongs to support tooling. Showing it to a user explains
  // nothing and invites them to quote it instead of the correlation id.
  it('carries the platform error code as data, not as text', () => {
    const { container } = renderInDirection(
      <ErrorState correlationId={SAMPLE_CORRELATION_ID} code="UPSTREAM_TIMEOUT" />,
      'rtl',
    );
    expect(container.firstElementChild).toHaveAttribute('data-error-code', 'UPSTREAM_TIMEOUT');
    expect(screen.queryByText('UPSTREAM_TIMEOUT')).toBeNull();
  });

  it('has no accessibility violations', async () => {
    const { container } = renderInDirection(
      <ErrorState correlationId={SAMPLE_CORRELATION_ID} onRetry={() => {}} />,
      'rtl',
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  itSnapshotsInBothDirections('with a retry and a correlation id', () => (
    <ErrorState correlationId={SAMPLE_CORRELATION_ID} code="UPSTREAM_TIMEOUT" onRetry={() => {}} />
  ));
});

describe('NoAccessState', () => {
  // A refusal will not become an acceptance on the next attempt. Offering a
  // retry teaches people to hammer an endpoint that keeps saying no.
  it('offers no retry', () => {
    renderInDirection(<NoAccessState />, 'rtl');
    expect(screen.queryByRole('button')).toBeNull();
  });

  // Naming the resource would confirm that it exists and who holds it, which
  // is the enumeration the object-level authorization rule exists to stop.
  it('says nothing about what is behind the refusal', () => {
    renderInDirection(<NoAccessState />, 'rtl');
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).not.toMatch(/\d/);
  });

  it('has no accessibility violations', async () => {
    const { container } = renderInDirection(
      <NoAccessState correlationId={SAMPLE_CORRELATION_ID} />,
      'rtl',
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  itSnapshotsInBothDirections('with a correlation id', () => (
    <NoAccessState correlationId={SAMPLE_CORRELATION_ID} />
  ));
});

describe('Skeleton', () => {
  it('is hidden from assistive technology', () => {
    const { container } = renderInDirection(<Skeleton />, 'rtl');
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
  });

  itSnapshotsInBothDirections('a half-width text bar', () => (
    <Skeleton height="text" width="half" />
  ));
});
