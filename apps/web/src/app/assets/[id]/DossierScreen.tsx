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
  timelineCategoryLabel,
} from '@/lib/labels';
import { formatJalaliDateLong, formatMoney } from '@/lib/format';
import type { AssetDossier, ReadResult } from '@/server/assets';

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
}

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
                <StatusBadge status={compliance.latestInspection.result} />
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
 * person to work out what a negative expiry means.
 */
function expiryWording(days: number): string {
  if (days > 0) return `${days} روز مانده`;
  if (days === 0) return 'امروز منقضی می‌شود';
  return `${Math.abs(days)} روز از انقضا گذشته`;
}

export function DossierScreen({ result, assetId }: DossierScreenProps) {
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
      />

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
              <dd className="text-content">{asset.manufactureYear ?? 'ثبت نشده'}</dd>
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
          بر پایهٔ {costs.entryCount} رویداد ثبت‌شده روی این دارایی.
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
    </>
  );
}
