'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  MAINTENANCE_TYPE_LABELS,
  REPAIR_ORDER_STATUS_LABELS,
  REQUEST_STATUS_LABELS,
  SEVERITY_LABELS,
  fetchMaintenanceRequest,
} from '@/lib/api/adapters/maintenance';
import { formatInteger, formatJalaliDate, formatMoneyMinor } from '@/lib/format';
import { useApiResource } from '@/lib/use-api-resource';
import { Badge, Card, PageHeader } from '../ui/primitives';
import { Code, DataTable, DataView, DescriptionList, Maybe, Section } from '../ui/data-view';
import { MaintenanceScenarioGate } from './maintenance-scenario-gate';

/**
 * One maintenance request, with its referrals and cost breakdown.
 *
 * The approval fields are the interesting part and the reason this screen
 * exists. The product document requires approval before settlement, and the
 * service enforces it as a state machine rather than a checkbox: approving
 * early answers `409`, approving against a stale amount answers `422`, and
 * approving twice answers `409` again. What is rendered here is the record of
 * that — who approved, when, and against what total.
 *
 * The cost breakdown is shown as the service returned it. It is not re-summed.
 */
export function MaintenanceRequestDetailView({ requestId }: { requestId: string }): ReactNode {
  const resource = useApiResource(
    (client, signal) => fetchMaintenanceRequest(client, requestId, signal),
    [requestId],
  );

  return (
    <DataView
      resource={resource}
      context="این درخواست تعمیر"
      loadingLabel="در حال خواندن درخواست تعمیر"
      loadingRows={3}
    >
      {(request) => (
        <>
          <PageHeader
            title={request.title}
            description={
              <>
                درخواست تعمیر — <Code>{request.id}</Code>
              </>
            }
            actions={
              <>
                <Badge tone={request.status === 'APPROVED' ? 'success' : 'neutral'}>
                  {REQUEST_STATUS_LABELS[request.status] ?? request.status}
                  <Code>{request.status}</Code>
                </Badge>
                <Link
                  href="/maintenance"
                  className="inline-flex min-h-[var(--tap)] items-center rounded-[var(--radius-md)] border border-[var(--control-border)] px-4 text-sm text-[var(--tx)]"
                >
                  بازگشت
                </Link>
              </>
            }
          />

          <Section id="summary" title="خلاصه">
            <Card>
              <DescriptionList
                columns={3}
                items={[
                  {
                    term: 'ماشین',
                    value: (
                      <Link
                        href={`/assets/${encodeURIComponent(request.assetId)}`}
                        className="hover:text-[var(--pri)] hover:underline"
                      >
                        <Code>{request.assetId}</Code>
                      </Link>
                    ),
                  },
                  {
                    term: 'نوع کار',
                    value: MAINTENANCE_TYPE_LABELS[request.type] ?? request.type,
                  },
                  {
                    term: 'شدت',
                    value: (
                      <Maybe
                        value={
                          request.severity
                            ? (SEVERITY_LABELS[request.severity] ?? request.severity)
                            : null
                        }
                      />
                    ),
                  },
                  { term: 'گزارش‌شده در', value: formatJalaliDate(request.reportedAt) },
                  { term: 'گزارش‌دهنده', value: <Code>{request.reportedBy}</Code> },
                  {
                    term: 'برنامهٔ سرویس مرتبط',
                    value: (
                      <Maybe
                        value={request.scheduleId ? <Code>{request.scheduleId}</Code> : null}
                      />
                    ),
                  },
                  {
                    term: 'خارج از سرویس از',
                    value: (
                      <Maybe
                        value={
                          request.outOfServiceAt ? formatJalaliDate(request.outOfServiceAt) : null
                        }
                      />
                    ),
                  },
                  {
                    term: 'بازگشت به سرویس',
                    value: (
                      <Maybe
                        value={
                          request.returnedToServiceAt
                            ? formatJalaliDate(request.returnedToServiceAt)
                            : null
                        }
                      />
                    ),
                  },
                  {
                    term: 'مدت توقف (دقیقه)',
                    value: (
                      <Maybe
                        value={
                          request.downtimeMinutes === null
                            ? null
                            : formatInteger(request.downtimeMinutes)
                        }
                      />
                    ),
                  },
                ]}
              />

              {request.description ? (
                <p
                  className="mt-4 border-t border-[var(--bd)] pt-4 text-sm text-[var(--tx2)]"
                  dir="auto"
                >
                  {request.description}
                </p>
              ) : null}
            </Card>
          </Section>

          <Section
            id="approval"
            title="تأیید پیش از تسویه"
            description="کنترل صریح سند محصول: تا کار تأیید نشده، هیچ تعهد مالی تسویه نمی‌شود. تأیید زودهنگام، تأیید تکراری و تأیید روی مبلغ کهنه، هر سه از سمت سرویس رد می‌شوند."
          >
            <Card className={request.approvedAt ? 'border-[var(--ok)]' : 'border-[var(--bd)]'}>
              <DescriptionList
                items={[
                  {
                    term: 'وضعیت تأیید',
                    value: request.approvedAt ? (
                      <Badge tone="success">تأیید شده</Badge>
                    ) : (
                      <Badge tone="warning">تأیید نشده</Badge>
                    ),
                  },
                  {
                    term: 'تأییدکننده',
                    value: (
                      <Maybe
                        value={request.approvedBy ? <Code>{request.approvedBy}</Code> : null}
                      />
                    ),
                  },
                  {
                    term: 'زمان تأیید',
                    value: (
                      <Maybe
                        value={request.approvedAt ? formatJalaliDate(request.approvedAt) : null}
                      />
                    ),
                  },
                  {
                    term: 'هزینهٔ ثبت‌شده',
                    value: (
                      <span className="font-bold">
                        {formatMoneyMinor(request.totalCostMinor, request.currency)}
                      </span>
                    ),
                  },
                ]}
              />
              {request.approvalNotes ? (
                <p className="mt-3 text-sm text-[var(--tx2)]" dir="auto">
                  {request.approvalNotes}
                </p>
              ) : null}
            </Card>
          </Section>

          <MaintenanceScenarioGate requestId={request.id} onApplied={resource.reload} />

          <Section id="cost-breakdown" title="تفکیک هزینه">
            {request.costBreakdown.length === 0 ? (
              <Card>
                <p className="text-sm text-[var(--tx2)]">
                  هنوز هزینه‌ای برای این درخواست ثبت نشده است.
                </p>
              </Card>
            ) : (
              <DataTable
                rows={request.costBreakdown}
                rowKey={(row) => row.category}
                caption="ارقام همان‌طور که سرویس محاسبه کرده است؛ در مرورگر بازمحاسبه نمی‌شوند."
                minWidth="28rem"
                columns={[
                  { key: 'category', header: 'دسته', render: (row) => <Code>{row.category}</Code> },
                  {
                    key: 'amount',
                    header: 'مبلغ',
                    render: (row) => formatMoneyMinor(row.amountMinor, row.currency),
                  },
                ]}
              />
            )}
          </Section>

          <Section id="repair-orders" title="ارجاع به تعمیرگاه">
            {request.repairOrders.length === 0 ? (
              <Card>
                <p className="text-sm text-[var(--tx2)]">
                  این درخواست به تعمیرگاهی ارجاع نشده است.
                </p>
              </Card>
            ) : (
              <DataTable
                rows={request.repairOrders}
                rowKey={(row) => row.id}
                caption={`${formatInteger(request.repairOrders.length)} دستور کار.`}
                minWidth="44rem"
                columns={[
                  { key: 'id', header: 'دستور کار', render: (row) => <Code>{row.id}</Code> },
                  {
                    key: 'workshop',
                    header: 'تعمیرگاه',
                    render: (row) => (
                      <>
                        <span dir="auto">
                          <Maybe value={row.workshopName} />
                        </span>
                        <Code>{row.workshopOrganizationId}</Code>
                      </>
                    ),
                  },
                  {
                    key: 'status',
                    header: 'وضعیت',
                    render: (row) => (
                      <Badge>
                        {REPAIR_ORDER_STATUS_LABELS[row.status] ?? row.status}
                        <Code>{row.status}</Code>
                      </Badge>
                    ),
                  },
                  {
                    key: 'total',
                    header: 'مجموع',
                    render: (row) => formatMoneyMinor(row.totalCostMinor, row.currency),
                  },
                ]}
              />
            )}
          </Section>
        </>
      )}
    </DataView>
  );
}
