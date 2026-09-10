'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  ASSET_TYPE_LABELS,
  fetchDossier,
  fetchTimeline,
  type AssetDossier,
  type TimelineEntry,
} from '@/lib/api/adapters/asset';
import { formatInteger, formatJalaliDate, formatMoneyMinor, formatYear } from '@/lib/format';
import { useApiResource } from '@/lib/use-api-resource';
import { Badge, Card, PageHeader } from '../ui/primitives';
import { Code, DataView, DescriptionList, Maybe, Section } from '../ui/data-view';
import { StatusBadge } from './assets-view';

/**
 * The electronic dossier — «پروندهٔ الکترونیکی».
 *
 * The single most useful screen to show, because it is the visible proof that
 * the event architecture does something. Nothing on this page is stored on the
 * asset: the compliance verdict, the accumulated costs and the timeline are
 * assembled from facts that `fleet-service`, `maintenance-service`,
 * `economic-service` and `document-service` own, delivered as Kafka events and
 * projected here.
 *
 * ## The two rules this screen must not soften
 *
 *  - **Every blocker, not the first.** `compliance.blockers` is a list on
 *    purpose: an operator who fixes one blocker should not have to re-check to
 *    discover the next. Rendering only the first would undo a deliberate
 *    decision in the service.
 *  - **Costs are strings.** `totalMinor` and friends are accumulated rial
 *    figures. They are rendered by grouping the string; nothing here adds them
 *    up, because the service already did and a second arithmetic could
 *    disagree with the ledger.
 */
export function DossierView({ assetId }: { assetId: string }): ReactNode {
  const dossier = useApiResource(
    (client, signal) => fetchDossier(client, assetId, signal),
    [assetId],
  );

  const timeline = useApiResource(
    (client, signal) => fetchTimeline(client, assetId, signal),
    [assetId],
  );

  return (
    <DataView
      resource={dossier}
      context="پروندهٔ این ماشین"
      loadingLabel="در حال خواندن پروندهٔ الکترونیکی"
      loadingRows={4}
    >
      {(data) => (
        <>
          <PageHeader
            title={data.asset.name}
            description={
              <>
                پروندهٔ الکترونیکی — <Code>{data.asset.id}</Code>
                {data.organizationName ? ` · ${data.organizationName}` : null}
              </>
            }
            actions={
              <>
                <StatusBadge status={data.asset.status} />
                <Link
                  href="/assets"
                  className="inline-flex min-h-[var(--tap)] items-center rounded-[var(--radius-md)] border border-[var(--control-border)] px-4 text-sm text-[var(--tx)]"
                >
                  بازگشت به فهرست
                </Link>
              </>
            }
          />

          <ComplianceCard compliance={data.compliance} />

          <Section
            id="identity"
            title="هویت ماشین"
            description="مالکیت و مشخصات پایه. با انتقال مالکیت، هویت و تاریخچه حفظ می‌شوند."
          >
            <Card>
              <DescriptionList
                items={[
                  {
                    term: 'نوع',
                    value: ASSET_TYPE_LABELS[data.asset.type] ?? data.asset.type,
                  },
                  {
                    term: 'پلاک / شمارهٔ ناوگان',
                    value: (
                      <Maybe
                        value={data.asset.assetTag ? <Code>{data.asset.assetTag}</Code> : null}
                      />
                    ),
                  },
                  { term: 'سازنده', value: <Maybe value={data.asset.manufacturer} /> },
                  { term: 'مدل', value: <Maybe value={data.asset.model} /> },
                  {
                    term: 'شمارهٔ سریال',
                    value: (
                      <Maybe
                        value={
                          data.asset.serialNumber ? <Code>{data.asset.serialNumber}</Code> : null
                        }
                      />
                    ),
                  },
                  {
                    term: 'سال ساخت',
                    value: (
                      <Maybe
                        value={
                          data.asset.manufactureYear ? formatYear(data.asset.manufactureYear) : null
                        }
                      />
                    ),
                  },
                  {
                    term: 'آغاز بهره‌برداری',
                    value: (
                      <Maybe
                        value={
                          data.asset.commissionedAt
                            ? formatJalaliDate(data.asset.commissionedAt)
                            : null
                        }
                      />
                    ),
                  },
                  { term: 'تعداد انتقال مالکیت', value: formatInteger(data.transferCount) },
                ]}
                columns={3}
              />
            </Card>
          </Section>

          <Section
            id="costs"
            title="هزینهٔ انباشته"
            description="از خط زمانی همین ماشین جمع شده است؛ رقم‌ها ریال و رشته‌اند و در مرورگر بازمحاسبه نمی‌شوند."
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <CostTile label="مجموع" amount={data.costs.totalMinor} />
              <CostTile label="نگهداری و تعمیر" amount={data.costs.maintenanceMinor} />
              <CostTile label="قطعه و سفارش" amount={data.costs.partsAndOrdersMinor} />
              <Card>
                <p className="text-xs text-[var(--tx3)]">تعداد رویداد هزینه‌دار</p>
                <p className="mt-1 text-2xl font-extrabold text-[var(--tx)]">
                  {formatInteger(data.costs.entryCount)}
                </p>
              </Card>
            </div>
          </Section>

          {data.currentLocation ? (
            <Section id="location" title="آخرین موقعیت ثبت‌شده">
              <Card>
                <DescriptionList
                  items={[
                    { term: 'محل', value: <Maybe value={data.currentLocation.siteName} /> },
                    { term: 'نشانی', value: <Maybe value={data.currentLocation.addressLine} /> },
                    { term: 'منبع', value: <Code>{data.currentLocation.source}</Code> },
                    {
                      term: 'زمان ثبت',
                      value: formatJalaliDate(data.currentLocation.recordedAt),
                    },
                  ]}
                />
              </Card>
            </Section>
          ) : null}

          <Section
            id="documents"
            title="اسناد پیوست"
            description="فراداده از سرویس اسناد می‌آید. فایل هرگز از سرویس عبور نمی‌کند و کلید ذخیره‌سازی هرگز از مرز API رد نمی‌شود."
          >
            <Card>
              {data.documents.length === 0 ? (
                <p className="text-sm text-[var(--tx2)]">سندی به این ماشین پیوست نشده است.</p>
              ) : (
                <ul className="space-y-3">
                  {data.documents.map((document) => (
                    <li
                      key={document.id}
                      className="border-b border-[var(--bd)] pb-3 last:border-b-0 last:pb-0"
                    >
                      <p className="text-sm font-semibold text-[var(--tx)]" dir="auto">
                        {document.title}
                      </p>
                      <p className="mt-1 text-xs text-[var(--tx3)]">
                        <Code>{document.kind}</Code>
                        {document.expiresAt
                          ? ` · انقضا ${formatJalaliDate(document.expiresAt)}`
                          : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </Section>

          <Section
            id="timeline"
            title="خط زمانی"
            description="هر ردیف از یک رویداد دامنه‌ای ساخته شده که سرویس دیگری منتشر کرده است — نه از یک ستون روی خود دارایی."
          >
            <DataView
              resource={timeline}
              context="خط زمانی این ماشین"
              loadingLabel="در حال خواندن خط زمانی"
              loadingRows={3}
              empty={{
                title: 'هنوز رویدادی برای این ماشین ثبت نشده',
                description: 'خط زمانی با نخستین رویداد دامنه‌ای پر می‌شود.',
              }}
            >
              {(entries) => <Timeline entries={entries} />}
            </DataView>
          </Section>
        </>
      )}
    </DataView>
  );
}

function ComplianceCard({ compliance }: { compliance: AssetDossier['compliance'] }): ReactNode {
  return (
    <Card className={compliance.operable ? 'mb-8 border-[var(--ok)]' : 'mb-8 border-[var(--dgr)]'}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold text-[var(--tx)]">آیا امروز قابل اعزام است؟</h2>
        <Badge tone={compliance.operable ? 'success' : 'danger'}>
          {compliance.operable ? 'قابل اعزام' : 'غیرقابل اعزام'}
        </Badge>
      </div>

      {compliance.blockers.length > 0 ? (
        <>
          <p className="mt-3 text-sm text-[var(--tx2)]">
            همهٔ موانع فهرست می‌شوند، نه فقط نخستین مورد — تا کسی که یکی را رفع می‌کند، مجبور نباشد
            دوباره بررسی کند تا مانع بعدی را پیدا کند.
          </p>
          <ul className="mt-3 space-y-2">
            {compliance.blockers.map((blocker) => (
              <li
                key={blocker}
                className="rounded-[var(--radius-md)] border border-[var(--dgr)] bg-[var(--dgr-soft)] px-3 py-2 text-sm text-[var(--dgr-tx)]"
                dir="auto"
              >
                {blocker}
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="mt-3 text-sm text-[var(--tx2)]">
          هیچ مانعی برای اعزام این ماشین ثبت نشده است.
        </p>
      )}

      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <p className="text-xs font-bold text-[var(--tx3)]">بیمه‌نامهٔ فعال</p>
          {compliance.activeInsurance ? (
            <p className="mt-1 text-sm text-[var(--tx)]">
              <span dir="auto">{compliance.activeInsurance.insurerName}</span> ·{' '}
              <Code>{compliance.activeInsurance.policyNumber}</Code>
              <span className="mt-1 block text-xs text-[var(--tx2)]">
                {expiryText(compliance.activeInsurance.daysUntilExpiry)}
              </span>
            </p>
          ) : (
            <p className="mt-1 text-sm text-[var(--tx3)]">بیمه‌نامهٔ فعالی ثبت نشده است.</p>
          )}
        </div>

        <div>
          <p className="text-xs font-bold text-[var(--tx3)]">آخرین معاینهٔ فنی</p>
          {compliance.latestInspection ? (
            <p className="mt-1 text-sm text-[var(--tx)]">
              <Code>{compliance.latestInspection.certificateNo}</Code> ·{' '}
              <Code>{compliance.latestInspection.result}</Code>
              <span className="mt-1 block text-xs text-[var(--tx2)]">
                {expiryText(compliance.latestInspection.daysUntilExpiry)}
              </span>
            </p>
          ) : (
            <p className="mt-1 text-sm text-[var(--tx3)]">معاینه‌ای ثبت نشده است.</p>
          )}
        </div>
      </div>
    </Card>
  );
}

/** `daysUntilExpiry` goes negative once lapsed; the copy has to follow it. */
function expiryText(days: number): string {
  if (days < 0) return `${formatInteger(Math.abs(days))} روز از انقضا گذشته است`;
  if (days === 0) return 'امروز منقضی می‌شود';
  return `${formatInteger(days)} روز تا انقضا`;
}

function CostTile({ label, amount }: { label: string; amount: string }): ReactNode {
  return (
    <Card>
      <p className="text-xs text-[var(--tx3)]">{label}</p>
      <p className="mt-1 text-lg font-extrabold text-[var(--tx)]">{formatMoneyMinor(amount)}</p>
    </Card>
  );
}

function Timeline({ entries }: { entries: readonly TimelineEntry[] }): ReactNode {
  return (
    <Card>
      <ol className="space-y-4">
        {entries.map((entry) => (
          <li key={entry.id} className="border-s-2 border-[var(--bd2)] ps-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-semibold text-[var(--tx)]" dir="auto">
                {entry.title}
              </p>
              <p className="text-xs text-[var(--tx3)]">{formatJalaliDate(entry.occurredAt)}</p>
            </div>

            {entry.description ? (
              <p className="mt-1 text-sm text-[var(--tx2)]" dir="auto">
                {entry.description}
              </p>
            ) : null}

            <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--tx3)]">
              <Badge>{entry.category}</Badge>
              {/* The producing service is named, because "who said this" is the
                  question a timeline row invites and the projector knows it. */}
              <span>
                منتشرشده توسط <Code>{entry.sourceService}</Code> · <Code>{entry.eventName}</Code>
              </span>
              {entry.amountMinor ? (
                <span className="font-semibold text-[var(--tx2)]">
                  {formatMoneyMinor(entry.amountMinor)}
                </span>
              ) : null}
            </p>
          </li>
        ))}
      </ol>
    </Card>
  );
}
