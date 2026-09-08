'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  BLOCKER_LABELS,
  listAssignments,
  listAvailability,
  listDrivers,
  listUsageRecords,
  listUtilization,
  type AvailabilityView,
} from '@/lib/api/adapters/fleet';
import { formatInteger, formatJalaliDate, toPersianDigits } from '@/lib/format';
import { useApiResource } from '@/lib/use-api-resource';
import { Badge, PageHeader } from '../ui/primitives';
import { Code, DataTable, DataView, Maybe, Section } from '../ui/data-view';

/**
 * Fleet operations: what can be dispatched, who drives it, and what it did.
 *
 * ## The point of the availability table
 *
 * `GET /v1/fleet/availability` composes facts owned by four different services
 * and names the owner of every blocker. That attribution is the feature. An
 * operator told only "unavailable" cannot know whether to call the workshop,
 * renew a policy or end an assignment — so this screen renders each blocker
 * with the service that owns the fact behind it, rather than collapsing them
 * into one word.
 *
 * ## Why utilisation can say "no data"
 *
 * `utilizationPercent` is `null`, never `0`, when a window holds no readings.
 * "We have no data" and "the machine sat idle" are different facts, and
 * reporting the first as the second is how a dashboard invents data
 * (docs/04 § 4.15). The cell says «داده‌ای ثبت نشده».
 */
export function FleetView(): ReactNode {
  const availability = useApiResource((client, signal) => listAvailability(client, {}, signal), []);
  const utilization = useApiResource((client, signal) => listUtilization(client, signal), []);
  const drivers = useApiResource((client, signal) => listDrivers(client, signal), []);
  const assignments = useApiResource((client, signal) => listAssignments(client, {}, signal), []);
  const usage = useApiResource((client, signal) => listUsageRecords(client, {}, signal), []);

  return (
    <>
      <PageHeader
        title="ناوگان"
        description="آمادگی اعزام، بهره‌برداری، راننده، تخصیص و کارکرد ثبت‌شده — همه از سرویس ناوگان و از راه درگاه API."
      />

      <Section
        id="availability"
        title="آمادگی اعزام"
        description="هر مانع، سرویسی را که مالک آن واقعیت است نام می‌برد. این تنها راهی است که یک اپراتور بداند باید به تعمیرگاه زنگ بزند یا بیمه را تمدید کند."
      >
        <DataView
          resource={availability}
          context="وضعیت آمادگی ناوگان"
          loadingLabel="در حال خواندن وضعیت آمادگی"
          empty={{
            title: 'ماشینی برای ارزیابی نیست',
            description: 'وقتی دارایی ثبت شود، وضعیت آمادگی آن همین‌جا محاسبه می‌شود.',
          }}
        >
          {(rows) => (
            <DataTable
              rows={rows}
              rowKey={(row) => row.assetId}
              caption={`${formatInteger(rows.length)} ماشین ارزیابی شد.`}
              columns={[
                {
                  key: 'asset',
                  header: 'ماشین',
                  render: (row: AvailabilityView) => (
                    <Link
                      href={`/assets/${encodeURIComponent(row.assetId)}`}
                      className="hover:text-[var(--pri)] hover:underline"
                    >
                      <span dir="auto">
                        <Maybe value={row.assetName} />
                      </span>
                      <Code>{row.assetId}</Code>
                    </Link>
                  ),
                },
                {
                  key: 'available',
                  header: 'قابل اعزام',
                  render: (row) => (
                    <Badge tone={row.available ? 'success' : 'danger'}>
                      {row.available ? 'بله' : 'خیر'}
                    </Badge>
                  ),
                },
                {
                  key: 'blockers',
                  header: 'موانع، و سرویس مالک هر مانع',
                  render: (row) =>
                    row.blockers.length === 0 ? (
                      <span className="text-[var(--tx3)]">—</span>
                    ) : (
                      <ul className="space-y-1">
                        {row.blockers.map((blocker) => (
                          <li key={blocker.code} className="text-xs">
                            <span className="font-semibold text-[var(--tx)]">
                              {BLOCKER_LABELS[blocker.code] ?? blocker.code}
                            </span>{' '}
                            <Code>{blocker.owner}</Code>
                            <span className="block text-[var(--tx2)]" dir="auto">
                              {blocker.detail}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ),
                },
                {
                  key: 'assignment',
                  header: 'تخصیص جاری',
                  render: (row) =>
                    row.currentAssignment ? (
                      <>
                        <Code>{row.currentAssignment.driverId}</Code>
                        <span className="block text-xs text-[var(--tx3)]">
                          از {formatJalaliDate(row.currentAssignment.startedAt)}
                        </span>
                      </>
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
        id="utilization"
        title="بهره‌برداری"
        description="نسبت ساعت کارکرد به ساعت در دسترس. جایی که هیچ قرائتی ثبت نشده، عدد صفر نشان داده نمی‌شود."
      >
        <DataView
          resource={utilization}
          context="بهره‌برداری ناوگان"
          loadingLabel="در حال خواندن بهره‌برداری"
          empty={{ title: 'داده‌ای برای این بازه نیست' }}
        >
          {(rows) => (
            <DataTable
              rows={rows}
              rowKey={(row) => row.assetId}
              caption="بازهٔ پیش‌فرض پیکربندی‌شدهٔ سرویس."
              minWidth="42rem"
              columns={[
                {
                  key: 'asset',
                  header: 'ماشین',
                  render: (row) => (
                    <>
                      <span dir="auto">
                        <Maybe value={row.assetName} />
                      </span>
                      <Code>{row.assetId}</Code>
                    </>
                  ),
                },
                {
                  key: 'used',
                  header: 'ساعت کارکرد',
                  render: (row) => toPersianDigits(row.usedHours),
                },
                {
                  key: 'available',
                  header: 'ساعت در دسترس',
                  render: (row) => toPersianDigits(row.availableHours),
                },
                {
                  key: 'percent',
                  header: 'نرخ بهره‌برداری',
                  render: (row) =>
                    row.utilizationPercent === null ? (
                      <span
                        className="text-[var(--tx3)]"
                        title="هیچ قرائتی در این بازه ثبت نشده است. این با «بیکار بودن ماشین» یکی نیست."
                      >
                        داده‌ای ثبت نشده
                      </span>
                    ) : (
                      <span className="font-semibold">
                        {toPersianDigits(row.utilizationPercent)}٪
                      </span>
                    ),
                },
                {
                  key: 'records',
                  header: 'تعداد قرائت',
                  render: (row) => formatInteger(row.recordCount),
                },
              ]}
            />
          )}
        </DataView>
      </Section>

      <Section id="drivers" title="راننده‌ها">
        <DataView
          resource={drivers}
          context="فهرست راننده‌ها"
          loadingLabel="در حال خواندن راننده‌ها"
          empty={{ title: 'راننده‌ای ثبت نشده است' }}
        >
          {(rows) => (
            <DataTable
              rows={rows}
              rowKey={(row) => row.id}
              caption={`${formatInteger(rows.length)} راننده در سازمان فعال.`}
              minWidth="40rem"
              columns={[
                { key: 'id', header: 'راننده', render: (row) => <Code>{row.id}</Code> },
                {
                  key: 'employee',
                  header: 'شمارهٔ پرسنلی',
                  render: (row) => <Maybe value={row.employeeNo} />,
                },
                {
                  key: 'licence',
                  header: 'گواهی‌نامه',
                  render: (row) => (
                    <>
                      <Maybe value={row.licenceNumber ? <Code>{row.licenceNumber}</Code> : null} />
                      {row.licenceClass ? (
                        <span className="block text-xs text-[var(--tx3)]">
                          پایه <Code>{row.licenceClass}</Code>
                        </span>
                      ) : null}
                    </>
                  ),
                },
                {
                  key: 'validTo',
                  header: 'اعتبار تا',
                  render: (row) => (
                    <Maybe
                      value={row.licenceValidTo ? formatJalaliDate(row.licenceValidTo) : null}
                    />
                  ),
                },
                {
                  key: 'status',
                  header: 'وضعیت',
                  render: (row) => (
                    <Badge tone={row.status === 'ACTIVE' ? 'success' : 'neutral'}>
                      <Code>{row.status}</Code>
                    </Badge>
                  ),
                },
              ]}
            />
          )}
        </DataView>
      </Section>

      <Section
        id="assignments"
        title="تخصیص‌ها"
        description="انحصار تخصیص با یک Partial Unique Index در پایگاه داده تضمین می‌شود، نه با یک بررسی در کد."
      >
        <DataView
          resource={assignments}
          context="فهرست تخصیص‌ها"
          loadingLabel="در حال خواندن تخصیص‌ها"
          empty={{ title: 'تخصیصی ثبت نشده است' }}
        >
          {(rows) => (
            <DataTable
              rows={rows}
              rowKey={(row) => row.id}
              caption={`${formatInteger(rows.length)} تخصیص، تازه‌ترین نخست.`}
              minWidth="40rem"
              columns={[
                { key: 'id', header: 'تخصیص', render: (row) => <Code>{row.id}</Code> },
                { key: 'asset', header: 'ماشین', render: (row) => <Code>{row.assetId}</Code> },
                { key: 'driver', header: 'راننده', render: (row) => <Code>{row.driverId}</Code> },
                {
                  key: 'active',
                  header: 'فعال',
                  render: (row) => (
                    <Badge tone={row.active ? 'success' : 'neutral'}>
                      {row.active ? 'بله' : 'پایان‌یافته'}
                    </Badge>
                  ),
                },
                {
                  key: 'started',
                  header: 'از',
                  render: (row) => formatJalaliDate(row.startedAt),
                },
                {
                  key: 'ended',
                  header: 'تا',
                  render: (row) => (
                    <Maybe value={row.endedAt ? formatJalaliDate(row.endedAt) : null} />
                  ),
                },
              ]}
            />
          )}
        </DataView>
      </Section>

      <Section
        id="usage"
        title="کارکرد ثبت‌شده"
        description="ثبت کارکرد می‌تواند آفلاین انجام و بعداً همگام شود؛ کلید Idempotency تضمین می‌کند ارسال دوباره، رکورد دوم نسازد."
      >
        <DataView
          resource={usage}
          context="رکوردهای کارکرد"
          loadingLabel="در حال خواندن رکوردهای کارکرد"
          empty={{ title: 'کارکردی ثبت نشده است' }}
        >
          {(rows) => (
            <DataTable
              rows={rows}
              rowKey={(row) => row.id}
              caption={`${formatInteger(rows.length)} رکورد کارکرد، تازه‌ترین نخست.`}
              minWidth="44rem"
              columns={[
                { key: 'asset', header: 'ماشین', render: (row) => <Code>{row.assetId}</Code> },
                {
                  key: 'period',
                  header: 'بازه',
                  render: (row) => (
                    <>
                      {formatJalaliDate(row.periodStart)}
                      <span className="block text-xs text-[var(--tx3)]">
                        تا {formatJalaliDate(row.periodEnd)}
                      </span>
                    </>
                  ),
                },
                {
                  key: 'hours',
                  header: 'ساعت',
                  render: (row) => <Maybe value={row.hours ? toPersianDigits(row.hours) : null} />,
                },
                {
                  key: 'km',
                  header: 'کیلومتر',
                  render: (row) => (
                    <Maybe value={row.kilometres ? toPersianDigits(row.kilometres) : null} />
                  ),
                },
                {
                  key: 'meter',
                  header: 'کنتور',
                  render: (row) => (
                    <Maybe value={row.hourMeter ? toPersianDigits(row.hourMeter) : null} />
                  ),
                },
                { key: 'source', header: 'منبع', render: (row) => <Code>{row.source}</Code> },
              ]}
            />
          )}
        </DataView>
      </Section>
    </>
  );
}
