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
import { PROJECT_NOTICE_TEXT, type ProjectNotice } from '@/lib/project-commands';
import { projectStatusLabel } from '@/lib/project-fields';
import type { ProjectDetail, ReadResult } from '@/server/projects';
import { DemoModeNotice } from '@/app/DemoModeNotice';
import type { DemoMode } from '@/lib/demo-mode';

import { formatEstimate } from '../ProjectsScreen';

/**
 * The project detail (docs/16 § ۱۶٫۶, `/projects/[id]`): the record, and the
 * write slots the page fills in — the commands the status offers, the approval
 * rounds with their policy.
 *
 * Every outcome the server can hand back is rendered. A project of another
 * organization answers 404 from the service, and is shown with the same words
 * as an id that does not exist: a distinct "exists but not yours" would
 * confirm the id to somebody who should not learn it.
 *
 * Needs, tenders and progress reports are separate slices; this screen shows
 * the record, its approvals and the commands on the project itself.
 */

export interface ProjectDetailScreenProps {
  readonly result: ReadResult<ProjectDetail>;
  /**
   * What the write that sent the person here did — decided by the page, which
   * accepts it only from a flash the server signed for this session and this
   * project (`readFlash`).
   */
  readonly notice?: ProjectNotice;
  /** What the provider says (`fetchDemoMode`, Q-14), over the estimate. Nothing here moves money. */
  readonly demoMode: DemoMode;
  /** The approval policy's state and the rounds, built by the page. */
  readonly approvals?: ReactNode;
  /** The commands the status offers, built by the page from the same read. */
  readonly commands?: ReactNode;
}

export function ProjectDetailScreen({
  result,
  demoMode,
  notice,
  approvals,
  commands,
}: ProjectDetailScreenProps) {
  if (result.kind === 'FORBIDDEN') {
    return <NoAccessState description="این پروژه در اختیار شما نیست." />;
  }

  if (result.kind === 'NOT_FOUND') {
    return (
      <EmptyState
        title="این پروژه پیدا نشد"
        description="شناسه اشتباه است یا در سازمان فعال شما نیست."
      />
    );
  }

  if (result.kind === 'UNAVAILABLE' || result.kind === 'MALFORMED') {
    return (
      <ErrorState
        description="جزئیات پروژه خوانده نشد. کمی بعد دوباره تلاش کنید."
        correlationId={result.correlationId}
      />
    );
  }

  const project = result.data;
  const needs = project.needsSummary;

  return (
    <div className="flex flex-col gap-6">
      <DemoModeNotice mode={demoMode} />
      {notice ? (
        <Alert tone={PROJECT_NOTICE_TEXT[notice].tone}>{PROJECT_NOTICE_TEXT[notice].text}</Alert>
      ) : null}
      <Section headingId="project-summary" title={project.title}>
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge status={project.status} label={projectStatusLabel(project.status)} />
          <span className="text-sm text-content-muted">
            شناسه <Identifier>{project.id}</Identifier>
          </span>
        </div>
        {project.statusReason ? (
          <p className="mt-2 text-sm">دلیل ثبت‌شده برای این وضعیت: {project.statusReason}</p>
        ) : null}
        <dl className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-sm text-content-muted">نوع عملیات</dt>
            <dd>{project.operationType}</dd>
          </div>
          <div>
            <dt className="text-sm text-content-muted">محل</dt>
            <dd>{project.locationDescription}</dd>
          </div>
          <div>
            <dt className="text-sm text-content-muted">برآورد هزینه</dt>
            <dd className="font-medium">{formatEstimate(project.estimatedCostMinor)}</dd>
          </div>
          <div>
            <dt className="text-sm text-content-muted">محدودهٔ عملیات</dt>
            <dd>{project.hasArea ? 'ثبت شده' : 'ثبت نشده'}</dd>
          </div>
          <div>
            <dt className="text-sm text-content-muted">ثبت در</dt>
            <dd>{formatJalaliDateLong(project.createdAt)}</dd>
          </div>
          <div>
            <dt className="text-sm text-content-muted">آخرین تغییر وضعیت</dt>
            <dd>{formatJalaliDateLong(project.statusChangedAt)}</dd>
          </div>
        </dl>
      </Section>

      <Section headingId="project-scope" title="شرح کار">
        {project.scopeOfWork ? (
          <p className="whitespace-pre-line">{project.scopeOfWork}</p>
        ) : (
          <EmptyState
            title="شرح کاری ثبت نشده"
            description="برای این پروژه شرح کار نوشته نشده است."
          />
        )}
      </Section>

      {needs ? (
        <Section headingId="project-needs" title="نیازها">
          <ul className="flex flex-col gap-1">
            <li>پیش‌نویس: {toPersianDigits(String(needs.draft))}</li>
            <li>ارسال‌شده: {toPersianDigits(String(needs.submitted))}</li>
            <li>پس‌گرفته: {toPersianDigits(String(needs.withdrawn))}</li>
          </ul>
        </Section>
      ) : null}

      {approvals}
      {commands}
    </div>
  );
}
