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
import {
  costCategoryLabel,
  maintenanceRequestStatusLabel,
  maintenanceTypeLabel,
  repairOrderStatusLabel,
  severityLabel,
} from '@/lib/labels';
import { formatJalaliDateLong, formatMoney, toPersianDigits } from '@/lib/format';
import type {
  MaintenanceRequestDetail,
  ReadResult,
  RepairOrderSummary,
} from '@/server/maintenance';

/**
 * The maintenance request detail (docs/16 § 16.6, `/maintenance/[id]`).
 *
 * Same shape as `DossierScreen` (PR #67): pure, every state reachable in a
 * test, and it renders what the request has done rather than what it could
 * do — there is no approve, assign or cancel control here, because this
 * portal has no write path yet (EXP-002 scope).
 *
 * ## The workflow list is built, not stored
 *
 * `MaintenanceRequestDetail` carries one timestamp per milestone
 * (`startedAt`, `completedAt`, `approvedAt`, `cancelledAt`…), each null until
 * it happens. Rendering every field unconditionally would show four empty
 * rows for a request an hour old; this screen turns the ones that are set
 * into an ordered history instead; the same idea as the asset dossier's
 * "every blocker, not only the first".
 */

export interface RequestDetailScreenProps {
  readonly result: ReadResult<MaintenanceRequestDetail>;
  readonly requestId: string;
}

interface Milestone {
  readonly label: string;
  readonly at: string;
  readonly note?: string | null;
}

function workflowHistory(request: MaintenanceRequestDetail): Milestone[] {
  const milestones: Milestone[] = [{ label: 'گزارش شد', at: request.reportedAt }];
  if (request.startedAt) milestones.push({ label: 'تعمیر آغاز شد', at: request.startedAt });
  if (request.completedAt) milestones.push({ label: 'تعمیر تکمیل شد', at: request.completedAt });
  if (request.returnedToServiceAt) {
    milestones.push({ label: 'دستگاه به سرویس بازگشت', at: request.returnedToServiceAt });
  }
  if (request.approvedAt) {
    milestones.push({
      label: 'هزینه تأیید شد',
      at: request.approvedAt,
      note: request.approvalNotes,
    });
  }
  if (request.cancelledAt) {
    milestones.push({
      label: 'لغو شد',
      at: request.cancelledAt,
      note: request.cancellationReason,
    });
  }
  return milestones;
}

function RepairOrderCard({ order }: { order: RepairOrderSummary }) {
  return (
    <li className="rounded-md border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-content">{order.workshopName ?? 'تعمیرگاه ثبت نشده'}</span>
        <StatusBadge status={order.status} label={repairOrderStatusLabel(order.status)} />
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div className="flex flex-col gap-1">
          <dt className="text-content-subtle">ارجاع</dt>
          <dd className="text-content-muted">{formatJalaliDateLong(order.assignedAt)}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-content-subtle">قطعه</dt>
          <dd className="text-content-muted">{formatMoney(order.partsCostMinor)}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-content-subtle">اجرت</dt>
          <dd className="text-content-muted">{formatMoney(order.labourCostMinor)}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-content-subtle">جمع</dt>
          <dd className="text-content">{formatMoney(order.totalCostMinor)}</dd>
        </div>
      </dl>

      {order.workPerformed ? (
        <p className="mt-3 text-sm text-content-muted">{order.workPerformed}</p>
      ) : order.workSummary ? (
        <p className="mt-3 text-sm text-content-muted">{order.workSummary}</p>
      ) : null}

      {order.cancellationReason ? (
        <p className="mt-3 text-sm text-content-muted">دلیل لغو: {order.cancellationReason}</p>
      ) : null}
    </li>
  );
}

export function RequestDetailScreen({ result, requestId }: RequestDetailScreenProps) {
  if (result.kind === 'FORBIDDEN') {
    return (
      <>
        <PageHeader title="جزئیات درخواست تعمیر" />
        <NoAccessState />
      </>
    );
  }

  if (result.kind === 'NOT_FOUND') {
    return (
      <>
        <PageHeader title="جزئیات درخواست تعمیر" />
        {/* The same answer a cross-tenant read gets, and deliberately so: a
            distinct "exists but not yours" would confirm the id to somebody
            who should not learn it. */}
        <EmptyState
          title="این درخواست پیدا نشد"
          description="شناسه اشتباه است یا در سازمان فعال شما نیست."
        />
      </>
    );
  }

  if (result.kind === 'UNAVAILABLE') {
    return (
      <>
        <PageHeader title="جزئیات درخواست تعمیر" />
        <ErrorState correlationId={result.correlationId} code={`UPSTREAM_${result.status}`} />
      </>
    );
  }

  if (result.kind === 'MALFORMED') {
    return (
      <>
        <PageHeader title="جزئیات درخواست تعمیر" />
        <ErrorState correlationId={result.correlationId} code="CONTRACT_MISMATCH" />
      </>
    );
  }

  const request = result.data;
  const history = workflowHistory(request);

  return (
    <>
      <PageHeader
        title={request.title}
        description={`${maintenanceTypeLabel(request.type)} — گزارش‌شده در ${formatJalaliDateLong(request.reportedAt)}`}
      />

      <Section headingId="identity" title="شناسنامه">
        <Grid columns={2}>
          <dl className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-content-subtle">وضعیت</dt>
              <dd>
                <StatusBadge
                  status={request.status}
                  label={maintenanceRequestStatusLabel(request.status)}
                />
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-content-subtle">دارایی</dt>
              <dd className="text-content">
                <a
                  href={`/assets/${encodeURIComponent(request.assetId)}`}
                  className="font-mono text-accent-on-surface underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                >
                  {request.assetId}
                </a>
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-content-subtle">شناسهٔ سامانه</dt>
              <dd>
                <Identifier>{requestId}</Identifier>
              </dd>
            </div>
          </dl>

          <dl className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-content-subtle">وخامت</dt>
              <dd className="text-content">
                {request.severity ? severityLabel(request.severity) : 'ندارد — کار پیشگیرانه'}
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-content-subtle">مهلت</dt>
              <dd className="text-content">
                {request.dueDate ? formatJalaliDateLong(request.dueDate) : 'تعیین نشده'}
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-content-subtle">مدت توقف</dt>
              <dd className="text-content">
                {request.downtimeMinutes !== null
                  ? `${toPersianDigits(String(request.downtimeMinutes))} دقیقه`
                  : 'محاسبه نشده'}
              </dd>
            </div>
          </dl>
        </Grid>

        {request.description ? (
          <p className="mt-4 text-sm text-content-muted">{request.description}</p>
        ) : null}
      </Section>

      <Section headingId="history" title="روند کار">
        <ol className="flex flex-col gap-4">
          {history.map((milestone, index) => (
            // Positional key: this list is rebuilt from the read result on
            // every render and never reordered or spliced by the client.
            <li key={index} className="border-s-2 border-border ps-4">
              <p className="text-content">{milestone.label}</p>
              <p className="text-sm text-content-muted">{formatJalaliDateLong(milestone.at)}</p>
              {milestone.note ? (
                <p className="text-sm text-content-muted">{milestone.note}</p>
              ) : null}
            </li>
          ))}
        </ol>
      </Section>

      <Section headingId="cost" title="هزینه">
        <p className="text-xl text-content">{formatMoney(request.totalCostMinor)}</p>
        {request.costBreakdown.length > 0 ? (
          <dl className="mt-4 flex flex-col gap-2">
            {request.costBreakdown.map((line, index) => (
              // Positional key: a category can repeat across cost lines, so it
              // is not itself a stable identity, and this list is read-only.
              <div key={index} className="flex items-center justify-between text-sm">
                <dt className="text-content-muted">{costCategoryLabel(line.category)}</dt>
                <dd className="text-content">{formatMoney(line.amountMinor)}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </Section>

      <Section headingId="repair-orders" title="ارجاع به تعمیرگاه">
        {request.repairOrders.length === 0 ? (
          <EmptyState
            title="هنوز ارجاع نشده"
            description="این درخواست هنوز به هیچ تعمیرگاهی ارجاع داده نشده است."
          />
        ) : (
          <ul className="flex flex-col gap-4">
            {request.repairOrders.map((order) => (
              <RepairOrderCard key={order.id} order={order} />
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
