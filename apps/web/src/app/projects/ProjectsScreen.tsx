import Link from 'next/link';

import {
  ButtonLink,
  EmptyState,
  ErrorState,
  Identifier,
  NoAccessState,
  Section,
  StatusBadge,
} from '@/ui';
import { IRR, formatJalaliDateLong, formatMoney, toPersianDigits } from '@/lib/format';
import {
  PROJECT_STATUSES,
  PROJECT_STATUS_LABELS,
  projectStatusLabel,
  type ProjectStatus,
} from '@/lib/project-fields';
import type { ProjectListQuery, ProjectPage, ProjectSummary, ReadResult } from '@/server/projects';

/**
 * The project list (docs/16 § ۱۶٫۶, `/projects`).
 *
 * A pure function of what the server read, like `OrdersScreen`: every state is
 * renderable in a test. Status and paging live in the URL, so no JavaScript is
 * involved and a filtered list is a link somebody can send.
 *
 * Projects are the owner's planning record. Nothing about a tender's bids is
 * read or shown here — sealed-bid confidentiality (ADR-066) is a concern of
 * the tender screens, which are separate slices.
 */

export interface ProjectsScreenProps {
  readonly result: ReadResult<ProjectPage>;
  readonly query: ProjectListQuery;
}

function hrefWith(query: ProjectListQuery, changes: Partial<ProjectListQuery>): string {
  const merged = { ...query, ...changes };
  const params = new URLSearchParams();
  if (merged.status) params.set('status', merged.status);
  if (merged.cursor) params.set('cursor', merged.cursor);
  const text = params.toString();
  return text ? `/projects?${text}` : '/projects';
}

function StatusFilter({ query }: { query: ProjectListQuery }) {
  const items: readonly (ProjectStatus | undefined)[] = [undefined, ...PROJECT_STATUSES];
  return (
    <nav aria-label="وضعیت پروژه" className="flex flex-wrap gap-2">
      {items.map((status) => (
        <Link
          key={status ?? 'ALL'}
          href={hrefWith(query, { status, cursor: undefined })}
          aria-current={status === query.status ? 'page' : undefined}
          className={
            status === query.status
              ? 'rounded-md border border-border-strong bg-surface-raised px-3 py-2 text-sm font-medium'
              : 'rounded-md border border-border px-3 py-2 text-sm text-content-muted'
          }
        >
          {status ? PROJECT_STATUS_LABELS[status] : 'همه'}
        </Link>
      ))}
    </nav>
  );
}

/** An estimate, from the string it arrived as; absent is said, not shown as zero. */
export function formatEstimate(minorUnits: string | null): string {
  return minorUnits === null ? 'برآورد نشده' : formatMoney(minorUnits, IRR);
}

function ProjectRow({ project }: { project: ProjectSummary }) {
  return (
    <li className="rounded-lg border border-border bg-surface-raised p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link
          href={`/projects/${encodeURIComponent(project.id)}`}
          className="font-medium underline"
        >
          {project.title}
        </Link>
        <StatusBadge status={project.status} label={projectStatusLabel(project.status)} />
      </div>
      <p className="mt-2 text-sm text-content-muted">
        {project.operationType} · {project.locationDescription}
      </p>
      <p className="mt-1 text-sm">
        برآورد هزینه:{' '}
        <span className="font-medium">{formatEstimate(project.estimatedCostMinor)}</span>
      </p>
      <p className="mt-1 text-sm text-content-muted">
        شناسه <Identifier>{project.id}</Identifier> · آخرین تغییر{' '}
        {formatJalaliDateLong(project.statusChangedAt)}
      </p>
    </li>
  );
}

export function ProjectsScreen({ result, query }: ProjectsScreenProps) {
  return (
    <div className="flex flex-col gap-4">
      <StatusFilter query={query} />
      <ProjectsBody result={result} query={query} />
    </div>
  );
}

function ProjectsBody({ result, query }: ProjectsScreenProps) {
  if (result.kind === 'FORBIDDEN') {
    return <NoAccessState description="فهرست پروژه‌های این سازمان در اختیار شما نیست." />;
  }

  if (result.kind === 'NOT_FOUND') {
    return <EmptyState title="پروژه‌ای یافت نشد" description="این نشست سازمان فعالی ندارد." />;
  }

  if (result.kind === 'UNAVAILABLE' || result.kind === 'MALFORMED') {
    return (
      <ErrorState
        description="فهرست پروژه‌ها خوانده نشد. کمی بعد دوباره تلاش کنید."
        correlationId={result.correlationId}
      />
    );
  }

  const page = result.data;

  return (
    <Section headingId="projects" title="پروژه‌ها">
      {page.items.length === 0 ? (
        <EmptyState
          title="پروژه‌ای نیست"
          description={
            query.status
              ? `پروژه‌ای در وضعیت «${projectStatusLabel(query.status)}» نیست.`
              : 'این سازمان هنوز پروژه‌ای ثبت نکرده است.'
          }
        />
      ) : (
        <>
          <p className="mb-3 text-sm text-content-muted">
            {toPersianDigits(String(page.items.length))} پروژه در این صفحه
          </p>
          <ul className="flex flex-col gap-3">
            {page.items.map((project) => (
              <ProjectRow key={project.id} project={project} />
            ))}
          </ul>
        </>
      )}

      {page.nextCursor ? (
        <div className="mt-4">
          <ButtonLink href={hrefWith(query, { cursor: page.nextCursor })} tone="secondary">
            صفحهٔ بعد
          </ButtonLink>
        </div>
      ) : null}
    </Section>
  );
}
