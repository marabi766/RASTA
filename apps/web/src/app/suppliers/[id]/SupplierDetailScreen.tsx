import type { ReactNode } from 'react';

import {
  Alert,
  EmptyState,
  ErrorState,
  Identifier,
  NoAccessState,
  Section,
  StatusBadge,
} from '@/ui';
import { formatJalaliDateLong, toPersianDigits } from '@/lib/format';
import {
  qualificationStateLabel,
  supplierCapabilityLabel,
  supplierStatusLabel,
} from '@/lib/supplier-fields';
import { SUPPLIER_NOTICE_TEXT, type SupplierNotice } from '@/lib/supplier-commands';
import { NO_COMMANDS, type SupplierCommandsView } from './SupplierCommands';
import type {
  QualificationRecord,
  ReadResult,
  SupplierDetail,
  SuspensionRecord,
} from '@/server/suppliers';

/**
 * The supplier's private record (docs/16 § ۱۶٫۶, `/suppliers/[id]`):
 * qualification history per category and every suspension episode, with its
 * reason and whether it is still open — and the commands the page was given
 * (`SupplierCommands.tsx`), each drawn only for a person the service would admit.
 *
 * Every outcome the server can hand back is rendered. A supplier of another
 * organization answers 404 from the service, and is shown with the same
 * words as an id that does not exist: a distinct "exists but not yours" would
 * confirm the id to somebody who should not learn it.
 */

export interface SupplierDetailScreenProps {
  readonly result: ReadResult<SupplierDetail>;
  /**
   * What the write that sent the person here did — decided by the page, which
   * accepts it only from a flash the server signed for this session and this
   * supplier (`server/flash.ts`), never from a bare query value.
   */
  readonly notice?: SupplierNotice;
  readonly commands?: SupplierCommandsView;
}

export function SupplierDetailScreen({
  result,
  notice,
  commands = NO_COMMANDS,
}: SupplierDetailScreenProps) {
  if (result.kind === 'FORBIDDEN') {
    return <NoAccessState description="این تامین‌کننده در اختیار شما نیست." />;
  }

  if (result.kind === 'NOT_FOUND') {
    return (
      <EmptyState
        title="این تامین‌کننده پیدا نشد"
        description="شناسه اشتباه است یا در سازمان فعال شما نیست."
      />
    );
  }

  if (result.kind === 'UNAVAILABLE' || result.kind === 'MALFORMED') {
    return (
      <ErrorState
        description="پرونده‌ی تامین‌کننده خوانده نشد. کمی بعد دوباره تلاش کنید."
        correlationId={result.correlationId}
      />
    );
  }

  const supplier = result.data;

  return (
    <div className="flex flex-col gap-6">
      {notice ? (
        <Alert tone={SUPPLIER_NOTICE_TEXT[notice].tone}>{SUPPLIER_NOTICE_TEXT[notice].text}</Alert>
      ) : null}
      <Section headingId="supplier-summary" title={supplier.displayName}>
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={supplier.status} label={supplierStatusLabel(supplier.status)} />
          <span className="text-sm text-content-muted">
            شناسه <Identifier>{supplier.id}</Identifier>
          </span>
          <span className="text-sm text-content-muted">
            شناسه‌ی سازمان <Identifier>{supplier.organizationId}</Identifier>
          </span>
        </div>
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-sm text-content-muted">دسته‌های اعلام‌شده</dt>
            <dd>
              {supplier.capabilities.length === 0
                ? 'بدون دسته‌ی اعلام‌شده'
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

      <QualificationsSection
        qualifications={supplier.qualifications}
        decisions={commands.decisions}
        submit={commands.submit}
      />
      <SuspensionsSection suspensions={supplier.suspensions} suspension={commands.suspension} />
      {commands.note ? <p className="text-sm text-content-muted">{commands.note}</p> : null}
    </div>
  );
}

function EvidenceList({ evidence }: { evidence: QualificationRecord['evidence'] }) {
  if (evidence.length === 0) return null;
  return (
    <div className="mt-2">
      <p className="text-sm text-content-muted">
        سند پیوست‌شده (فقط شناسه در سرویس اسناد؛ سامانه آن را نگشوده و نسنجیده است):
      </p>
      <ul className="mt-1 flex flex-col gap-1 text-sm">
        {evidence.map((item) => (
          <li key={item.documentId} className="flex flex-wrap items-baseline gap-2">
            {item.label ? <span>{item.label}</span> : null}
            <Identifier>{item.documentId}</Identifier>
          </li>
        ))}
      </ul>
    </div>
  );
}

function QualificationRow({
  qualification,
  decision,
}: {
  qualification: QualificationRecord;
  decision: ReactNode;
}) {
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
      {qualification.state === 'REJECTED' ? (
        <p className="mt-2 text-sm">
          دلیل رد: {qualification.rejectionReason ?? 'دلیلی روی این پرونده ثبت نشده است.'}
        </p>
      ) : null}
      {qualification.decisionNote ? (
        <p className="mt-2 text-sm text-content-muted">
          یادداشت خصوصی بازبین (فقط بازبینان پلتفرم می‌بینند): {qualification.decisionNote}
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
      <EvidenceList evidence={qualification.evidence} />
      {decision ? <div className="mt-4 border-t border-border pt-4">{decision}</div> : null}
    </li>
  );
}

function QualificationsSection({
  qualifications,
  decisions,
  submit,
}: {
  qualifications: readonly QualificationRecord[];
  decisions: Readonly<Record<string, ReactNode>>;
  submit: ReactNode;
}) {
  return (
    <Section headingId="supplier-qualifications" title="صلاحیت‌ها">
      {qualifications.length === 0 ? (
        <EmptyState
          title="هیچ درخواست صلاحیتی ثبت نشده"
          description="این تامین‌کننده هنوز برای هیچ دسته‌ای صلاحیت ارسال نکرده است."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {qualifications.map((qualification) => (
            <QualificationRow
              key={qualification.id}
              qualification={qualification}
              decision={decisions[qualification.id] ?? null}
            />
          ))}
        </ul>
      )}
      {submit ? (
        <div className="mt-6 border-t border-border pt-4">
          <h3 className="mb-3 text-base font-semibold text-content">ارسال درخواست صلاحیت</h3>
          {submit}
        </div>
      ) : null}
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

function SuspensionsSection({
  suspensions,
  suspension,
}: {
  suspensions: readonly SuspensionRecord[];
  suspension: ReactNode;
}) {
  return (
    <Section headingId="supplier-suspensions" title="تاریخچه‌ی تعلیق">
      {suspensions.length === 0 ? (
        <EmptyState
          title="هیچ تعلیقی ثبت نشده"
          description="این تامین‌کننده تا کنون تعلیق نشده است."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {suspensions.map((episode) => (
            <SuspensionRow key={episode.id} suspension={episode} />
          ))}
        </ul>
      )}
      {suspension ? <div className="mt-6 border-t border-border pt-4">{suspension}</div> : null}
    </Section>
  );
}
