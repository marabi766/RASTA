import {
  EmptyState,
  ErrorState,
  Grid,
  Identifier,
  NoAccessState,
  PageHeader,
  Section,
  StatusBadge,
} from '@/ui';
import { assignmentEndReasonLabel, driverStatusLabel } from '@/lib/labels';
import { formatJalaliDateLong } from '@/lib/format';
import type { AssignmentPage, DriverDetail, ReadResult } from '@/server/drivers';

import { AssignDriverForm } from './AssignDriverForm';
import { ChangeStatusForm } from './ChangeStatusForm';
import { EndAssignmentForm } from './EndAssignmentForm';
import { UpdateDriverForm } from './UpdateDriverForm';

/**
 * The driver detail (docs/16 § 16.6, `/drivers/[id]`).
 *
 * Same shape as `RequestDetailScreen` (PR #73) for the read half — every
 * outcome the server can hand back is rendered rather than reachable only
 * live — extended with the four forms this page adds, each bound to this one
 * driver (`actions.ts`).
 *
 * ## Two reads, told apart
 *
 * The driver record and its assignment history are two independent calls
 * (`fetchDriver`, `fetchDriverAssignments`); a failure in one does not hide
 * the other. What gates the forms is the driver read succeeding — editing a
 * driver nobody can see is not a state this screen can be in.
 *
 * ## At most one active assignment decides which form shows
 *
 * fleet-service's exclusivity index guarantees at most one `active: true`
 * row. Its presence, not a separate flag, is what this screen reads to
 * decide between "assign this driver to a machine" and "end their current
 * assignment" — there is no third state to represent.
 */

export interface DriverDetailScreenProps {
  readonly result: ReadResult<DriverDetail>;
  readonly assignments: ReadResult<AssignmentPage>;
  readonly driverId: string;
  readonly csrfToken: string;
  readonly submissionIds: {
    readonly update: string;
    readonly status: string;
    readonly assign: string;
    readonly end: string;
  };
}

function AssignmentHistory({ page }: { page: AssignmentPage }) {
  if (page.items.length === 0) {
    return (
      <EmptyState
        title="هنوز تخصیصی ثبت نشده"
        description="پس از نخستین تخصیص این راننده به یک ماشین، همین‌جا دیده می‌شود."
      />
    );
  }

  return (
    <ol className="flex flex-col gap-4">
      {page.items.map((assignment) => (
        <li key={assignment.id} className="border-s-2 border-border ps-4">
          <p className="text-content">
            <Identifier>{assignment.assetId}</Identifier>
          </p>
          <p className="text-sm text-content-muted">
            {formatJalaliDateLong(assignment.startedAt)}
            {assignment.endedAt ? ` تا ${formatJalaliDateLong(assignment.endedAt)}` : ' — جاری'}
            {assignment.endReason ? ` · ${assignmentEndReasonLabel(assignment.endReason)}` : ''}
          </p>
          {assignment.purpose ? (
            <p className="text-sm text-content-muted">{assignment.purpose}</p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export function DriverDetailScreen({
  result,
  assignments,
  driverId,
  csrfToken,
  submissionIds,
}: DriverDetailScreenProps) {
  if (result.kind === 'FORBIDDEN') {
    return (
      <>
        <PageHeader title="جزئیات راننده" />
        <NoAccessState />
      </>
    );
  }

  if (result.kind === 'NOT_FOUND') {
    return (
      <>
        <PageHeader title="جزئیات راننده" />
        {/* The same answer a cross-tenant read gets, and deliberately so: a
            distinct "exists but not yours" would confirm the id to somebody
            who should not learn it. */}
        <EmptyState
          title="این راننده پیدا نشد"
          description="شناسه اشتباه است یا در سازمان فعال شما نیست."
        />
      </>
    );
  }

  if (result.kind === 'UNAVAILABLE') {
    return (
      <>
        <PageHeader title="جزئیات راننده" />
        <ErrorState correlationId={result.correlationId} code={`UPSTREAM_${result.status}`} />
      </>
    );
  }

  if (result.kind === 'MALFORMED') {
    return (
      <>
        <PageHeader title="جزئیات راننده" />
        <ErrorState correlationId={result.correlationId} code="CONTRACT_MISMATCH" />
      </>
    );
  }

  const driver = result.data;
  const active =
    assignments.kind === 'OK'
      ? assignments.data.items.find((assignment) => assignment.active)
      : undefined;

  return (
    <>
      <PageHeader
        title={driver.employeeNo ?? driver.userId}
        description={`گواهینامه ${driver.licenceNumber ?? 'ثبت نشده'}`}
      />

      <Section headingId="identity" title="شناسنامه">
        <Grid columns={2}>
          <dl className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-content-subtle">وضعیت</dt>
              <dd>
                <StatusBadge status={driver.status} label={driverStatusLabel(driver.status)} />
              </dd>
            </div>
            {driver.statusReason ? (
              <div className="flex flex-col gap-1">
                <dt className="text-sm text-content-subtle">دلیل وضعیت</dt>
                <dd className="text-content">{driver.statusReason}</dd>
              </div>
            ) : null}
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-content-subtle">شناسهٔ کاربر</dt>
              <dd>
                <Identifier>{driver.userId}</Identifier>
              </dd>
            </div>
          </dl>

          <dl className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-content-subtle">پایهٔ گواهینامه</dt>
              <dd className="text-content">{driver.licenceClass ?? 'ثبت نشده'}</dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-content-subtle">اعتبار گواهینامه</dt>
              <dd className="text-content">
                {driver.licenceValidTo ? formatJalaliDateLong(driver.licenceValidTo) : 'ثبت نشده'}
              </dd>
            </div>
          </dl>
        </Grid>

        {driver.notes ? <p className="mt-4 text-sm text-content-muted">{driver.notes}</p> : null}
      </Section>

      <Section headingId="edit" title="ویرایش اطلاعات">
        <UpdateDriverForm
          driverId={driverId}
          csrfToken={csrfToken}
          submissionId={submissionIds.update}
          initialValues={{
            employeeNo: driver.employeeNo ?? '',
            licenceNumber: driver.licenceNumber ?? '',
            licenceClass: driver.licenceClass ?? '',
            licenceValidTo: driver.licenceValidTo ? driver.licenceValidTo.slice(0, 10) : '',
            notes: driver.notes ?? '',
          }}
        />
      </Section>

      <Section headingId="status" title="تغییر وضعیت">
        <ChangeStatusForm
          driverId={driverId}
          currentStatus={driver.status}
          csrfToken={csrfToken}
          submissionId={submissionIds.status}
        />
      </Section>

      <Section headingId="assignment" title="تخصیص">
        {assignments.kind === 'FORBIDDEN' ? <NoAccessState /> : null}
        {assignments.kind === 'UNAVAILABLE' ? (
          <ErrorState
            correlationId={assignments.correlationId}
            code={`UPSTREAM_${assignments.status}`}
          />
        ) : null}
        {assignments.kind === 'MALFORMED' ? (
          <ErrorState correlationId={assignments.correlationId} code="CONTRACT_MISMATCH" />
        ) : null}
        {assignments.kind === 'NOT_FOUND' ? (
          <EmptyState title="یافت نشد" description="این مسیر در سرویس ناوگان پاسخی نداشت." />
        ) : null}

        {assignments.kind === 'OK' ? (
          active ? (
            <div className="flex flex-col gap-4">
              <div className="rounded-md border border-border p-4">
                <p className="text-content">
                  هم‌اکنون به <Identifier>{active.assetId}</Identifier> تخصیص دارد
                </p>
                <p className="text-sm text-content-muted">
                  از {formatJalaliDateLong(active.startedAt)}
                  {active.purpose ? ` · ${active.purpose}` : ''}
                </p>
              </div>
              <EndAssignmentForm
                driverId={driverId}
                assignmentId={active.id}
                csrfToken={csrfToken}
                submissionId={submissionIds.end}
              />
            </div>
          ) : (
            <AssignDriverForm
              driverId={driverId}
              csrfToken={csrfToken}
              submissionId={submissionIds.assign}
            />
          )
        ) : null}
      </Section>

      <Section headingId="history" title="تاریخچهٔ تخصیص">
        {assignments.kind === 'OK' ? <AssignmentHistory page={assignments.data} /> : null}
      </Section>
    </>
  );
}
