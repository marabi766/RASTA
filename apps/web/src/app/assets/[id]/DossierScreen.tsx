import type { ReactNode } from 'react';
import {
  Alert,
  ButtonLink,
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
  assetStatusLabel,
  assetTypeLabel,
  blockerLabel,
  inspectionResultLabel,
  timelineCategoryLabel,
} from '@/lib/labels';
import { formatJalaliDateLong, formatMoney, toPersianDigits } from '@/lib/format';
import type { AssetDossier, ReadResult } from '@/server/assets';
import type { RecordNotice } from '@/lib/asset-record-fields';

/**
 * The electronic dossier (docs/16 § 16.6, `/assets/[id]`).
 *
 * `CLAUDE.md` calls this platform asset-centric, and this is the screen that
 * claim is about: one machine, and everything the platform knows about it —
 * whether it may be dispatched today, what its compliance documents say, what
 * it has cost, and what has happened to it recently.
 *
 * ## The compliance box is the point of the page
 *
 * asset-service answers "may this be dispatched" with a boolean **and every
 * reason it is false**, not only the first. The screen keeps that shape: an
 * operator who renews the insurance and comes back to find an expired
 * inspection waiting has been told twice what could have been said once.
 *
 * Pure, like the list next to it: every state is reachable in a test.
 */

export interface DossierScreenProps {
  readonly result: ReadResult<AssetDossier>;
  readonly assetId: string;
  /**
   * The edit form, when this person may use it. Built by the page from the
   * read this screen renders, so its pre-filled values are the ones on show.
   */
  readonly editForm?: ReactNode;
  /**
   * The lifecycle commands this person may use on this machine as it is now —
   * commission, change status, decommission — built by the page like the edit
   * form, from the same read. Absent when there is nothing to offer.
   */
  readonly lifecycle?: ReactNode;
  /**
   * The machine's insurance policies and technical inspections with their record
   * forms (`AssetRecords`), built by the page — which owns the server clock the
   * "in force" judgement is made against. Drawn below the compliance box, whose
   * blockers it is what clears.
   */
  readonly records?: ReactNode;
  /**
   * What the write that sent the person here did — decided by the page, which
   * accepts it only from a flash the server signed for this session and this
   * machine (`server/flash.ts`), never from a bare query value. Not rendered at
   * all when the read failed.
   */
  readonly notice?:
    | 'created'
    | 'updated'
    | 'conflict'
    | 'activated'
    | 'statusChanged'
    | 'decommissioned'
    | 'lifecycleConflict'
    | RecordNotice;
}

const NOTICES = {
  created: { tone: 'success', text: 'ماشین ثبت شد.' },
  updated: { tone: 'success', text: 'مشخصات ماشین ذخیره شد.' },
  conflict: {
    tone: 'warning',
    text: 'همین ماشین پس از باز شدن فرم ویرایش، توسط کسی تغییر کرده بود؛ ویرایش شما ذخیره نشد. مشخصات فعلی را در فرم ببینید و اگر هنوز لازم است دوباره ویرایش کنید.',
  },
  activated: { tone: 'success', text: 'دارایی فعال شد و به ناوگان پیوست.' },
  statusChanged: { tone: 'success', text: 'وضعیت دارایی تغییر کرد.' },
  decommissioned: { tone: 'success', text: 'دارایی اسقاط شد. این وضعیت نهایی است.' },
  policyRecorded: { tone: 'success', text: 'بیمه‌نامه ثبت شد.' },
  inspectionRecorded: { tone: 'success', text: 'معاینهٔ فنی ثبت شد.' },
  lifecycleConflict: {
    tone: 'warning',
    text: 'این دارایی پس از باز شدن این صفحه تغییر کرده بود — شاید همین دستور پیش‌تر اعمال شده باشد. این بار چیزی نوشته نشد. وضعیت فعلی را در همین صفحه ببینید و اگر هنوز لازم است دوباره اقدام کنید.',
  },
} as const;

function Compliance({ dossier }: { dossier: AssetDossier }) {
  const { compliance } = dossier;

  return (
    <Section headingId="compliance" title="آمادگی بهره‌برداری">
      {compliance.operable ? (
        <Alert tone="success" title="آمادهٔ بهره‌برداری است">
          هیچ مانع انطباقی برای اعزام این دستگاه ثبت نشده است.
        </Alert>
      ) : (
        <Alert tone="danger" title="قابل اعزام نیست">
          <ul className="list-inside list-disc">
            {compliance.blockers.map((blocker) => (
              <li key={blocker}>{blockerLabel(blocker)}</li>
            ))}
          </ul>
        </Alert>
      )}

      <Grid columns={2}>
        <dl className="flex flex-col gap-2">
          <dt className="text-sm text-content-subtle">بیمه‌نامهٔ فعال</dt>
          <dd className="text-content">
            {compliance.activeInsurance ? (
              <>
                <Identifier>{compliance.activeInsurance.policyNumber}</Identifier>
                <span className="mx-2 text-content-muted">
                  {compliance.activeInsurance.insurerName}
                </span>
                <span className="block text-sm text-content-muted">
                  اعتبار تا {formatJalaliDateLong(compliance.activeInsurance.validTo)} —{' '}
                  {expiryWording(compliance.activeInsurance.daysUntilExpiry)}
                </span>
              </>
            ) : (
              'ثبت نشده'
            )}
          </dd>
        </dl>

        <dl className="flex flex-col gap-2">
          <dt className="text-sm text-content-subtle">آخرین معاینهٔ فنی</dt>
          <dd className="text-content">
            {compliance.latestInspection ? (
              <>
                <StatusBadge
                  status={compliance.latestInspection.result}
                  label={inspectionResultLabel(compliance.latestInspection.result)}
                />
                <span className="block text-sm text-content-muted">
                  اعتبار تا {formatJalaliDateLong(compliance.latestInspection.validTo)} —{' '}
                  {expiryWording(compliance.latestInspection.daysUntilExpiry)}
                </span>
              </>
            ) : (
              'ثبت نشده'
            )}
          </dd>
        </dl>
      </Grid>
    </Section>
  );
}

/**
 * "In N days" or "N days ago".
 *
 * asset-service sends a negative number once the date has passed, precisely so
 * a client can say the second thing. Rendering the raw number would leave a
 * person to work out what a negative expiry means. The count is written in
 * Persian digits here, at render, and nowhere earlier (docs/16 § 16.3).
 */
function expiryWording(days: number): string {
  if (days > 0) return `${toPersianDigits(String(days))} روز مانده`;
  if (days === 0) return 'امروز منقضی می‌شود';
  return `${toPersianDigits(String(Math.abs(days)))} روز از انقضا گذشته`;
}

export function DossierScreen({
  result,
  assetId,
  editForm,
  lifecycle,
  records,
  notice,
}: DossierScreenProps) {
  if (result.kind === 'FORBIDDEN') {
    return (
      <>
        <PageHeader title="پروندهٔ دارایی" />
        <NoAccessState />
      </>
    );
  }

  if (result.kind === 'NOT_FOUND') {
    return (
      <>
        <PageHeader title="پروندهٔ دارایی" />
        {/* The same answer a cross-tenant read gets, and deliberately so: a
            distinct "exists but not yours" would confirm the id to somebody
            who should not learn it. */}
        <EmptyState
          title="این دارایی پیدا نشد"
          description="شناسه اشتباه است یا در سازمان فعال شما نیست."
        />
      </>
    );
  }

  if (result.kind === 'UNAVAILABLE') {
    return (
      <>
        <PageHeader title="پروندهٔ دارایی" />
        <ErrorState correlationId={result.correlationId} code={`UPSTREAM_${result.status}`} />
      </>
    );
  }

  if (result.kind === 'MALFORMED') {
    return (
      <>
        <PageHeader title="پروندهٔ دارایی" />
        <ErrorState correlationId={result.correlationId} code="CONTRACT_MISMATCH" />
      </>
    );
  }

  const { asset, costs, recentActivity } = result.data;

  return (
    <>
      <PageHeader
        title={asset.name}
        description={`${assetTypeLabel(asset.type)} — ${result.data.organizationName ?? 'سازمان نامشخص'}`}
        actions={
          // Only a link. Whether this person may report work is decided on the
          // page it leads to, which offers the form to the roles that can use
          // it and nothing to the rest — so there is no role check to keep in
          // step with maintenance-service here.
          <ButtonLink
            tone="secondary"
            href={`/maintenance?assetId=${encodeURIComponent(assetId)}#report-request`}
          >
            ثبت درخواست نگهداری
          </ButtonLink>
        }
      />

      {notice ? <Alert tone={NOTICES[notice].tone}>{NOTICES[notice].text}</Alert> : null}

      <Section headingId="identity" title="شناسنامه">
        <Grid columns={2}>
          <dl className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-content-subtle">شمارهٔ دارایی</dt>
              <dd className="text-content">
                {asset.assetTag ? <Identifier>{asset.assetTag}</Identifier> : 'ثبت نشده'}
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-content-subtle">وضعیت</dt>
              <dd>
                <StatusBadge status={asset.status} label={assetStatusLabel(asset.status)} />
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-content-subtle">شناسهٔ سامانه</dt>
              <dd>
                <Identifier>{assetId}</Identifier>
              </dd>
            </div>
          </dl>

          <dl className="flex flex-col gap-4">
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-content-subtle">سازنده و مدل</dt>
              <dd className="text-content">
                {asset.manufacturer || asset.model ? (
                  <Identifier>
                    {[asset.manufacturer, asset.model].filter(Boolean).join(' — ')}
                  </Identifier>
                ) : (
                  'ثبت نشده'
                )}
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-content-subtle">سال ساخت</dt>
              <dd className="text-content">
                {asset.manufactureYear !== null
                  ? toPersianDigits(String(asset.manufactureYear))
                  : 'ثبت نشده'}
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-sm text-content-subtle">آغاز بهره‌برداری</dt>
              <dd className="text-content">
                {asset.commissionedAt ? formatJalaliDateLong(asset.commissionedAt) : 'ثبت نشده'}
              </dd>
            </div>
          </dl>
        </Grid>
      </Section>

      <Compliance dossier={result.data} />

      {records}

      <Section headingId="costs" title="هزینه‌ها">
        <Grid columns={3}>
          <div className="flex flex-col gap-1">
            <span className="text-sm text-content-subtle">مجموع</span>
            <span className="text-xl text-content">{formatMoney(costs.totalMinor)}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-sm text-content-subtle">نگهداری و تعمیرات</span>
            <span className="text-xl text-content">{formatMoney(costs.maintenanceMinor)}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-sm text-content-subtle">قطعات و سفارش‌ها</span>
            <span className="text-xl text-content">{formatMoney(costs.partsAndOrdersMinor)}</span>
          </div>
        </Grid>
        <p className="mt-4 text-sm text-content-muted">
          بر پایهٔ {toPersianDigits(String(costs.entryCount))} رویداد ثبت‌شده روی این دارایی.
        </p>
      </Section>

      <Section
        headingId="activity"
        title="رویدادهای اخیر"
        actions={
          <ButtonLink tone="secondary" href={`/assets/${encodeURIComponent(assetId)}/timeline`}>
            مشاهدهٔ تاریخچهٔ کامل
          </ButtonLink>
        }
      >
        {recentActivity.length === 0 ? (
          <EmptyState
            title="رویدادی ثبت نشده"
            description="هر تخصیص، کارکرد، تعمیر یا هزینه‌ای که ثبت شود، اینجا می‌آید."
          />
        ) : (
          <ol className="flex flex-col gap-4">
            {recentActivity.map((entry) => (
              <li key={entry.id} className="border-s-2 border-border ps-4">
                <p className="text-content">{entry.title}</p>
                <p className="text-sm text-content-muted">
                  {timelineCategoryLabel(entry.category)} · {formatJalaliDateLong(entry.occurredAt)}
                  {entry.amountMinor ? ` · ${formatMoney(entry.amountMinor)}` : ''}
                </p>
                {entry.description ? (
                  <p className="text-sm text-content-muted">{entry.description}</p>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </Section>

      {asset.status === 'DECOMMISSIONED' ? (
        <Alert tone="info" title="این دارایی اسقاط شده است">
          اسقاط نهایی است: وضعیت و مشخصات این دارایی دیگر تغییر نمی‌کند و ردیف آن برای سوابق مالی و
          حسابرسی می‌ماند.
        </Alert>
      ) : null}

      {lifecycle ? (
        <Section headingId="lifecycle" title="وضعیت و چرخهٔ حیات">
          {lifecycle}
        </Section>
      ) : null}

      {editForm ? (
        <Section headingId="edit-asset" title="ویرایش مشخصات">
          {editForm}
        </Section>
      ) : null}
    </>
  );
}
