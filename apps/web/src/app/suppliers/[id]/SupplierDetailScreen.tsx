import { EmptyState, ErrorState, Identifier, NoAccessState, Section, StatusBadge } from '@/ui';
import { formatJalaliDateLong, toPersianDigits } from '@/lib/format';
import {
  qualificationStateLabel,
  supplierCapabilityLabel,
  supplierStatusLabel,
} from '@/lib/supplier-fields';
import type {
  QualificationRecord,
  ReadResult,
  SupplierDetail,
  SuspensionRecord,
} from '@/server/suppliers';

/**
 * The supplier's private record (docs/16 § ۱۶٫۶, `/suppliers/[id]`),
 * read-only: qualification history per category and every suspension
 * episode, with its reason and whether it is still open.
 *
 * Every outcome the server can hand back is rendered. A supplier of another
 * organization answers 404 from the service, and is shown with the same
 * words as an id that does not exist: a distinct "exists but not yours" would
 * confirm the id to somebody who should not learn it.
 */

export interface SupplierDetailScreenProps {
  readonly result: ReadResult<SupplierDetail>;
}

export function SupplierDetailScreen({ result }: SupplierDetailScreenProps) {
  if (result.kind === 'FORBIDDEN') {
    return <NoAccessState description="این تأمین‌کننده در اختیار شما نیست." />;
  }

  if (result.kind === 'NOT_FOUND') {
    return (
      <EmptyState
        title="این تأمین‌کننده پیدا نشد"
        description="شناسه اشتباه است یا در سازمان فعال شما نیست."
      />
    );
  }

  if (result.kind === 'UNAVAILABLE' || result.kind === 'MALFORMED') {
    return (
      <ErrorState
        description="پروندهٔ تأمین‌کننده خوانده نشد. کمی بعد دوباره تلاش کنید."
        correlationId={result.correlationId}
      />
    );
  }

  const supplier = result.data;

  return (
    <div className="flex flex-col gap-6">
      <Section headingId="supplier-summary" title={supplier.displayName}>
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={supplier.status} label={supplierStatusLabel(supplier.status)} />
          <span className="text-sm text-content-muted">
            شناسه <Identifier>{supplier.id}</Identifier>
          </span>
          <span className="text-sm text-content-muted">
            شناسهٔ سازمان <Identifier>{supplier.organizationId}</Identifier>
          </span>
        </div>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-sm text-content-muted">دسته‌های اعلام‌شده</dt>
            <dd>
              {supplier.capabilities.length === 0
                ? 'بدون دستهٔ اعلام‌شده'
                : supplier.capabilities
                    .map((capability) => supplierCapabilityLabel(capability))
                    .join(' · ')}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-content-muted">صلاحیت فعال برای</dt>
            <dd>
              {supplier.qualifiedFor.length === 0
                ? 'در حال حاضر هیچ دسته‌ای'
                : supplier.qualifiedFor
                    .map((capability) => supplierCapabilityLabel(capability))
                    .join(' · ')}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-content-muted">ثبت در</dt>
            <dd>{formatJalaliDateLong(supplier.registeredAt)}</dd>
          </div>
        </dl>
      </Section>

      <QualificationsSection qualifications={supplier.qualifications} />
      <SuspensionsSection suspensions={supplier.suspensions} />
    </div>
  );
}

function QualificationRow({ qualification }: { qualification: QualificationRecord }) {
  return (
    <li className="rounded-lg border border-border bg-surface-raised p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">{supplierCapabilityLabel(qualification.capability)}</span>
        <StatusBadge
          status={qualification.state}
          label={qualificationStateLabel(qualification.state)}
        />
      </div>
      <p className="mt-1 text-sm text-content-muted">
        {qualification.current ? 'در حال حاضر معتبر' : 'در حال حاضر معتبر نیست'}
      </p>
      {qualification.statement ? <p className="mt-2 text-sm">{qualification.statement}</p> : null}
      {qualification.decisionNote ? (
        <p className="mt-2 text-sm text-content-muted">
          یادداشت بازبین: {qualification.decisionNote}
        </p>
      ) : null}
      <p className="mt-1 text-sm text-content-muted">
        ارسال در {formatJalaliDateLong(qualification.submittedAt)}
        {qualification.decidedAt
          ? ` · تصمیم در ${formatJalaliDateLong(qualification.decidedAt)}`
          : ''}
        {' · '}
        {qualification.evidenceCount === 0
          ? 'بدون سند پیوست‌شده'
          : `${toPersianDigits(String(qualification.evidenceCount))} سند پیوست‌شده`}
      </p>
    </li>
  );
}

function QualificationsSection({
  qualifications,
}: {
  qualifications: readonly QualificationRecord[];
}) {
  return (
    <Section headingId="supplier-qualifications" title="صلاحیت‌ها">
      {qualifications.length === 0 ? (
        <EmptyState
          title="هیچ درخواست صلاحیتی ثبت نشده"
          description="این تأمین‌کننده هنوز برای هیچ دسته‌ای صلاحیت ارسال نکرده است."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {qualifications.map((qualification) => (
            <QualificationRow key={qualification.id} qualification={qualification} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function SuspensionRow({ suspension }: { suspension: SuspensionRecord }) {
  return (
    <li className="rounded-lg border border-border bg-surface-raised p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium">{suspension.open ? 'باز' : 'بسته‌شده'}</span>
        <span className="text-sm text-content-muted">
          تعلیق در {formatJalaliDateLong(suspension.suspendedAt)}
        </span>
      </div>
      <p className="mt-2 text-sm">{suspension.reason}</p>
      {suspension.reinstatedAt ? (
        <p className="mt-1 text-sm text-content-muted">
          رفع تعلیق در {formatJalaliDateLong(suspension.reinstatedAt)}
          {suspension.reinstatementNote ? ` — ${suspension.reinstatementNote}` : ''}
        </p>
      ) : null}
    </li>
  );
}

function SuspensionsSection({ suspensions }: { suspensions: readonly SuspensionRecord[] }) {
  return (
    <Section headingId="supplier-suspensions" title="تاریخچهٔ تعلیق">
      {suspensions.length === 0 ? (
        <EmptyState
          title="هیچ تعلیقی ثبت نشده"
          description="این تأمین‌کننده تا کنون تعلیق نشده است."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {suspensions.map((suspension) => (
            <SuspensionRow key={suspension.id} suspension={suspension} />
          ))}
        </ul>
      )}
    </Section>
  );
}
