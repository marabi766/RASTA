import type { ReactNode } from 'react';

import {
  Alert,
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
  partSourceLabel,
  repairOrderStatusLabel,
  severityLabel,
} from '@/lib/labels';
import {
  PERSIAN_DECIMAL_SEPARATOR,
  formatJalaliDateLong,
  formatMoney,
  toPersianDigits,
} from '@/lib/format';
import type { RequestCommandNotice } from '@/lib/maintenance-fields';
import type { RepairCommandName, RepairCommandNotice } from '@/lib/repair-order-fields';
import { repairCommandsFor } from '@/lib/repair-order-fields';
import type {
  MaintenanceRequestDetail,
  ReadResult,
  RepairOrderDetail,
  RepairOrderSummary,
} from '@/server/maintenance';

/**
 * The maintenance request detail (docs/16 § 16.6, `/maintenance/[id]`).
 *
 * Same shape as `DossierScreen` (PR #67): pure, every state reachable in a
 * test. It renders what the request has done, and — for a person who may act
 * on it — the commands the request's status leaves open: refer to a workshop
 * while the work is open and unreferred, approve the cost once it is completed,
 * cancel until it is final. The forms arrive as slots (`commandForms`) built by
 * the page, which alone has the session to mint their ids; this screen only
 * decides which of them the status allows, and the service decides again.
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
  /**
   * What the write that sent the person here did — decided by the page, which
   * accepts it only from a flash the server signed for this session and this
   * request (`server/flash.ts`), never from a bare query value. Not rendered at
   * all when the read failed.
   */
  readonly notice?: 'created' | RequestCommandNotice | RepairCommandNotice;
  /**
   * The three commands, present only for a person the page found allowed to
   * use them (`canManageMaintenance`) and only when the request read.
   */
  readonly commandForms?: {
    readonly assign: ReactNode;
    readonly approve: ReactNode;
    readonly cancel: ReactNode;
  };
  /**
   * What each repair order has recorded under it, by order id: `null` for an
   * order whose lines could not be read, which then shows the summary alone and
   * says so — the page does not fail for the lines.
   */
  readonly orderDetails?: Readonly<Record<string, RepairOrderDetail | null>>;
  /**
   * The repair-order commands, by order id, built by the page for the orders it
   * minted baselines for. Which of them an order's status leaves open is
   * decided here (`repairCommandsFor`); the service decides again.
   */
  readonly orderForms?: Readonly<Record<string, OrderForms>>;
}

export type OrderForms = Partial<Record<RepairCommandName, ReactNode>>;

const NOTICES: Record<
  'created' | RequestCommandNotice | RepairCommandNotice,
  { tone: 'success' | 'warning'; text: string }
> = {
  created: { tone: 'success', text: 'درخواست ثبت شد. کار از همین صفحه دنبال می‌شود.' },
  assigned: { tone: 'success', text: 'کار به تعمیرگاه ارجاع شد.' },
  approved: { tone: 'success', text: 'هزینه تأیید شد. درخواست نهایی است.' },
  cancelled: { tone: 'success', text: 'درخواست لغو شد.' },
  costChanged: {
    tone: 'warning',
    text: 'هزینه از زمان نمایش تغییر کرده بود، پس تأیید انجام نشد. مبلغ تازه را بررسی کنید و اگر درست بود دوباره تأیید کنید.',
  },
  repairStarted: { tone: 'success', text: 'تعمیر آغاز شد. ماشین از سرویس خارج می‌شود.' },
  repairCompleted: {
    tone: 'success',
    text: 'تعمیر تکمیل شد و ماشین به سرویس بازمی‌گردد. درخواست در انتظار تأیید هزینه است.',
  },
  repairCancelled: {
    tone: 'success',
    text: 'ارجاع پس گرفته شد. درخواست باز است و می‌توان آن را به تعمیرگاه دیگری ارجاع داد.',
  },
  repairCostChanged: {
    tone: 'warning',
    text: 'هزینهٔ ارجاع از زمان نمایش تغییر کرده بود، پس تعمیر تکمیل نشد. مبلغ تازه را بررسی کنید و اگر درست بود دوباره تکمیل کنید.',
  },
  partRecorded: { tone: 'success', text: 'قطعه ثبت شد.' },
  labourRecorded: { tone: 'success', text: 'اجرت ثبت شد.' },
  costRecorded: { tone: 'success', text: 'هزینه ثبت شد.' },
};

/** Work that can still be referred on: open, and not already with a workshop. */
function canBeReferred(request: MaintenanceRequestDetail): boolean {
  return (
    (request.status === 'OPEN' || request.status === 'IN_PROGRESS') &&
    request.repairOrders.every((order) => order.status === 'CANCELLED')
  );
}

const CANCELLABLE = ['OPEN', 'IN_PROGRESS', 'COMPLETED'];

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

/** `12.5` as «۱۲٫۵»: the service's decimal, in the reader's digits and mark. */
function formatQuantity(latin: string): string {
  return toPersianDigits(latin).replace('.', PERSIAN_DECIMAL_SEPARATOR);
}

function RecordedLines({ detail }: { detail: RepairOrderDetail }) {
  // A line written by recording a part or labour is listed with that work; what
  // is left is what a person entered directly.
  const direct = detail.costs.filter((cost) => !cost.partUsageId && !cost.laborEntryId);
  if (detail.parts.length === 0 && detail.labour.length === 0 && direct.length === 0) {
    return (
      <p className="mt-4 text-sm text-content-muted">هنوز قطعه، اجرت یا هزینه‌ای ثبت نشده است.</p>
    );
  }

  return (
    <div className="mt-4 flex flex-col gap-4">
      {detail.parts.length > 0 ? (
        <div>
          <h3 className="text-sm text-content-subtle">قطعه‌ها</h3>
          <ul className="mt-2 flex flex-col gap-2 text-sm">
            {detail.parts.map((part) => (
              <li key={part.id} className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-content">
                  {part.partName} — {formatQuantity(part.quantity)} {part.unit} ×{' '}
                  {formatMoney(part.unitCostMinor)}
                  <span className="text-content-muted"> ({partSourceLabel(part.source)})</span>
                </span>
                <span className="text-content">{formatMoney(part.totalCostMinor)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {detail.labour.length > 0 ? (
        <div>
          <h3 className="text-sm text-content-subtle">اجرت</h3>
          <ul className="mt-2 flex flex-col gap-2 text-sm">
            {detail.labour.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-content">
                  {entry.description}
                  {entry.technician ? ` — ${entry.technician}` : ''} — {formatQuantity(entry.hours)}{' '}
                  ساعت × {formatMoney(entry.hourlyRateMinor)}
                </span>
                <span className="text-content">{formatMoney(entry.totalCostMinor)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {direct.length > 0 ? (
        <div>
          <h3 className="text-sm text-content-subtle">هزینه‌های دیگر</h3>
          <ul className="mt-2 flex flex-col gap-2 text-sm">
            {direct.map((cost) => (
              <li key={cost.id} className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-content">
                  {costCategoryLabel(cost.category)}
                  {cost.description ? ` — ${cost.description}` : ''}
                </span>
                <span className="text-content">{formatMoney(cost.amountMinor)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function RepairOrderCard({
  order,
  detail,
  forms,
}: {
  order: RepairOrderSummary;
  /** `undefined` when the page did not read it, `null` when it could not. */
  detail?: RepairOrderDetail | null;
  forms?: OrderForms;
}) {
  const open = repairCommandsFor(order.status);
  const has = (command: RepairCommandName) => Boolean(forms?.[command]) && open.includes(command);
  const work = (['start', 'complete'] as const).filter(has);
  const cost = (['part', 'labour', 'cost'] as const).filter(has);

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

      {detail ? (
        <RecordedLines detail={detail} />
      ) : detail === null ? (
        <p className="mt-4 text-sm text-content-muted">
          ریز قطعه‌ها و هزینه‌های این ارجاع الان خوانده نشد؛ صفحه را تازه کنید.
        </p>
      ) : null}

      {work.length > 0 || cost.length > 0 || has('cancel') ? (
        <div className="mt-6 flex flex-col gap-4 border-t border-border pt-4">
          {work.map((command) => (
            <div key={command}>{forms?.[command]}</div>
          ))}
          {cost.map((command) => (
            <div key={command}>{forms?.[command]}</div>
          ))}
          {has('cancel') ? <div>{forms?.cancel}</div> : null}
        </div>
      ) : null}
    </li>
  );
}

export function RequestDetailScreen({
  result,
  requestId,
  notice,
  commandForms,
  orderDetails,
  orderForms,
}: RequestDetailScreenProps) {
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

      {notice ? <Alert tone={NOTICES[notice].tone}>{NOTICES[notice].text}</Alert> : null}

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
              <RepairOrderCard
                key={order.id}
                order={order}
                detail={orderDetails?.[order.id]}
                forms={orderForms?.[order.id]}
              />
            ))}
          </ul>
        )}
        {commandForms && canBeReferred(request) ? (
          <div className="mt-6">{commandForms.assign}</div>
        ) : null}
      </Section>

      {commandForms && request.status === 'COMPLETED' ? (
        <Section headingId="approve" title="تأیید هزینه">
          {commandForms.approve}
        </Section>
      ) : null}

      {commandForms && CANCELLABLE.includes(request.status) ? (
        <Section headingId="cancel" title="لغو">
          {commandForms.cancel}
        </Section>
      ) : null}
    </>
  );
}
