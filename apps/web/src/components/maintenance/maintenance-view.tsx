'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import {
  DUE_BASIS_LABELS,
  DUE_STATE_LABELS,
  MAINTENANCE_TYPE_LABELS,
  REPAIR_ORDER_STATUS_LABELS,
  REQUEST_STATUS_LABELS,
  SEVERITY_LABELS,
  listDueSchedules,
  listMaintenanceRequests,
  listRepairOrders,
  type ScheduleDue,
} from '@/lib/api/adapters/maintenance';
import { formatInteger, formatJalaliDate, formatMoneyMinor, toPersianDigits } from '@/lib/format';
import { useApiResource } from '@/lib/use-api-resource';
import { Badge, Button, Card, PageHeader, type Tone } from '../ui/primitives';
import { Code, DataTable, DataView, Maybe, Section } from '../ui/data-view';

/**
 * Maintenance: what needs servicing, what was reported, and what it cost.
 *
 * ## Why the due list is the thing to show
 *
 * The verdict is **computed on every call** from the machine's current meter
 * and the clock — never read from a stored flag. A background scan that has not
 * run therefore cannot make an overdue machine look compliant, which is the
 * usual failure of a maintenance module. Each row names the trigger that came
 * due (time, hours or kilometres) and how much is left, so the table renders
 * that attribution rather than a single "overdue" word.
 *
 * Costs come from the service already totalled. Nothing here adds parts to
 * labour: `totalCostMinor` was computed under a row lock and a second
 * arithmetic in a browser could disagree with the ledger (ADR-028).
 */
export function MaintenanceView(): ReactNode {
  const [includeNotDue, setIncludeNotDue] = useState(false);
  const [openOnly, setOpenOnly] = useState(true);

  const due = useApiResource(
    (client, signal) => listDueSchedules(client, { includeNotDue }, signal),
    [includeNotDue],
  );

  const requests = useApiResource(
    (client, signal) => listMaintenanceRequests(client, { openOnly }, signal),
    [openOnly],
  );

  const repairOrders = useApiResource((client, signal) => listRepairOrders(client, signal), []);

  return (
    <>
      <PageHeader
        title="نگهداری و تعمیرات"
        description="سررسید سرویس، درخواست‌های تعمیر و دستور کار تعمیرگاه. سررسید در لحظهٔ درخواست محاسبه می‌شود، نه از یک Flag ذخیره‌شده."
      />

      <Section
        id="due"
        title="چه چیزی سررسید شده است"
        description="هر ردیف می‌گوید کدام محرک — زمان، ساعت کارکرد یا کیلومتر — سررسید را ایجاد کرده و چقدر باقی مانده است."
      >
        <div className="mb-3">
          <Button
            variant={includeNotDue ? 'primary' : 'secondary'}
            onClick={() => setIncludeNotDue((current) => !current)}
          >
            {includeNotDue ? 'فقط موارد سررسیده' : 'نمایش همهٔ برنامه‌ها، شامل سررسید نشده'}
          </Button>
        </div>

        <DataView
          resource={due}
          context="فهرست سررسیدهای نگهداری"
          loadingLabel="در حال ارزیابی سررسیدها"
          empty={{
            title: includeNotDue ? 'برنامهٔ سرویسی تعریف نشده' : 'هیچ سرویسی سررسید نشده است',
            description: includeNotDue
              ? 'با تعریف نخستین برنامهٔ سرویس، ارزیابی سررسید همین‌جا انجام می‌شود.'
              : 'برای دیدن برنامه‌های سررسید نشده، دکمهٔ بالا را بزنید.',
          }}
        >
          {(rows) => (
            <DataTable
              rows={rows}
              rowKey={(row) => row.id}
              caption={`${formatInteger(rows.length)} برنامهٔ سرویس ارزیابی شد.`}
              minWidth="52rem"
              columns={[
                {
                  key: 'title',
                  header: 'برنامه و ماشین',
                  render: (row: ScheduleDue) => (
                    <>
                      <span dir="auto">{row.title}</span>
                      <Link
                        href={`/assets/${encodeURIComponent(row.assetId)}`}
                        className="mt-0.5 block text-xs text-[var(--tx3)] hover:text-[var(--pri)] hover:underline"
                      >
                        <Maybe value={row.assetName} /> <Code>{row.assetId}</Code>
                      </Link>
                    </>
                  ),
                },
                {
                  key: 'type',
                  header: 'نوع',
                  render: (row) =>
                    MAINTENANCE_TYPE_LABELS[row.maintenanceType] ?? row.maintenanceType,
                },
                {
                  key: 'due',
                  header: 'وضعیت سررسید',
                  render: (row) => (
                    <Badge tone={dueTone(row.due.state)}>
                      {DUE_STATE_LABELS[row.due.state] ?? row.due.state}
                      <Code>{row.due.state}</Code>
                    </Badge>
                  ),
                },
                {
                  key: 'triggers',
                  header: 'محرک‌ها و باقی‌مانده',
                  render: (row) =>
                    row.due.triggers.length === 0 ? (
                      <span className="text-[var(--tx3)]">—</span>
                    ) : (
                      <ul className="space-y-1 text-xs">
                        {row.due.triggers.map((trigger) => (
                          <li key={trigger.basis}>
                            <span className="font-semibold text-[var(--tx)]">
                              {DUE_BASIS_LABELS[trigger.basis] ?? trigger.basis}
                            </span>{' '}
                            <Code>{trigger.state}</Code>
                            <span className="block text-[var(--tx2)]">
                              باقی‌مانده: {toPersianDigits(trigger.remaining)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ),
                },
                {
                  key: 'meter',
                  header: 'کنتور فعلی',
                  render: (row) => (
                    <>
                      <span className="block text-xs">
                        ساعت: {toPersianDigits(row.meter.hourMeter)}
                      </span>
                      <span className="block text-xs">
                        کیلومتر: {toPersianDigits(row.meter.odometer)}
                      </span>
                    </>
                  ),
                },
                {
                  key: 'open',
                  header: 'درخواست باز',
                  render: (row) =>
                    row.openRequestId ? (
                      <Link
                        href={`/maintenance/${encodeURIComponent(row.openRequestId)}`}
                        className="hover:text-[var(--pri)] hover:underline"
                      >
                        <Code>{row.openRequestId}</Code>
                      </Link>
                    ) : (
                      <span className="text-[var(--tx3)]">—</span>
                    ),
                },
              ]}
            />
          )}
        </DataView>
      </Section>

      <Section
        id="requests"
        title="درخواست‌های تعمیر"
        description="کار برنامه‌ریزی‌شده و خرابی، در یک صف. ثبت درخواست تکراری روی یک ماشین با یک Partial Unique Index رد می‌شود."
      >
        <div className="mb-3">
          <Button
            variant={openOnly ? 'primary' : 'secondary'}
            onClick={() => setOpenOnly((current) => !current)}
          >
            {openOnly ? 'فقط درخواست‌های باز' : 'نمایش همهٔ درخواست‌ها'}
          </Button>
        </div>

        <DataView
          resource={requests}
          context="فهرست درخواست‌های تعمیر"
          loadingLabel="در حال خواندن درخواست‌های تعمیر"
          empty={{
            title: openOnly ? 'درخواست بازی وجود ندارد' : 'درخواستی ثبت نشده است',
          }}
        >
          {(rows) => (
            <DataTable
              rows={rows}
              rowKey={(row) => row.id}
              caption={`${formatInteger(rows.length)} درخواست، تازه‌ترین نخست.`}
              minWidth="48rem"
              columns={[
                {
                  key: 'title',
                  header: 'درخواست',
                  render: (row) => (
                    <Link
                      href={`/maintenance/${encodeURIComponent(row.id)}`}
                      className="hover:text-[var(--pri)] hover:underline"
                    >
                      <span dir="auto">{row.title}</span>
                      <Code>{row.id}</Code>
                    </Link>
                  ),
                },
                {
                  key: 'asset',
                  header: 'ماشین',
                  render: (row) => <Code>{row.assetId}</Code>,
                },
                {
                  key: 'type',
                  header: 'نوع',
                  render: (row) => MAINTENANCE_TYPE_LABELS[row.type] ?? row.type,
                },
                {
                  key: 'severity',
                  header: 'شدت',
                  render: (row) =>
                    row.severity ? (
                      <Badge tone={severityTone(row.severity)}>
                        {SEVERITY_LABELS[row.severity] ?? row.severity}
                      </Badge>
                    ) : (
                      <span className="text-[var(--tx3)]">—</span>
                    ),
                },
                {
                  key: 'status',
                  header: 'وضعیت',
                  render: (row) => (
                    <Badge tone={requestTone(row.status)}>
                      {REQUEST_STATUS_LABELS[row.status] ?? row.status}
                      <Code>{row.status}</Code>
                    </Badge>
                  ),
                },
                {
                  key: 'cost',
                  header: 'هزینهٔ ثبت‌شده',
                  render: (row) => formatMoneyMinor(row.totalCostMinor, row.currency),
                },
                {
                  key: 'reported',
                  header: 'گزارش',
                  render: (row) => formatJalaliDate(row.reportedAt),
                },
              ]}
            />
          )}
        </DataView>
      </Section>

      <Section
        id="repair-orders"
        title="دستور کارهای تعمیرگاه"
        description="هزینه به تفکیک قطعه، دستمزد و سایر. هر رقم، منشأ خودش را دارد و همان چیزی است که سرویس اقتصادی بعداً حسابرسی می‌کند."
      >
        <DataView
          resource={repairOrders}
          context="فهرست دستور کارها"
          loadingLabel="در حال خواندن دستور کارها"
          empty={{
            title: 'دستور کاری برای شما قابل مشاهده نیست',
            description:
              'این فهرست تنها برای نقش‌های سرپرستی باز است؛ گزارش‌دهندهٔ خرابی، صفحهٔ خالی می‌بیند نه خطای دسترسی.',
          }}
        >
          {(rows) => (
            <DataTable
              rows={rows}
              rowKey={(row) => row.id}
              caption={`${formatInteger(rows.length)} دستور کار.`}
              minWidth="52rem"
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
                    <Badge tone={requestTone(row.status)}>
                      {REPAIR_ORDER_STATUS_LABELS[row.status] ?? row.status}
                      <Code>{row.status}</Code>
                    </Badge>
                  ),
                },
                {
                  key: 'parts',
                  header: 'قطعه',
                  render: (row) => formatMoneyMinor(row.partsCostMinor, row.currency),
                },
                {
                  key: 'labour',
                  header: 'دستمزد',
                  render: (row) => formatMoneyMinor(row.labourCostMinor, row.currency),
                },
                {
                  key: 'total',
                  header: 'مجموع',
                  render: (row) => (
                    <span className="font-bold">
                      {formatMoneyMinor(row.totalCostMinor, row.currency)}
                    </span>
                  ),
                },
              ]}
            />
          )}
        </DataView>
      </Section>

      <Card>
        <p className="text-xs text-[var(--tx2)]">
          هزینه‌ها همان‌طور که سرویس محاسبه کرده نمایش داده می‌شوند و در مرورگر دوباره جمع نمی‌شوند.
          جمع دوبارهٔ ارقام در سمت کلاینت، یک حساب دوم است که می‌تواند با دفتر کل اختلاف پیدا کند.
        </p>
      </Card>
    </>
  );
}

function dueTone(state: string): Tone {
  if (state === 'OVERDUE') return 'danger';
  if (state === 'DUE_SOON') return 'warning';
  return 'neutral';
}

function severityTone(severity: string): Tone {
  if (severity === 'CRITICAL' || severity === 'HIGH') return 'danger';
  if (severity === 'MEDIUM') return 'warning';
  return 'neutral';
}

function requestTone(status: string): Tone {
  switch (status) {
    case 'APPROVED':
    case 'COMPLETED':
      return 'success';
    case 'IN_PROGRESS':
      return 'warning';
    case 'CANCELLED':
      return 'danger';
    default:
      return 'neutral';
  }
}
