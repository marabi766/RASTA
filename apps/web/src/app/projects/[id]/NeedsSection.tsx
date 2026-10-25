import Link from 'next/link';

import {
  Alert,
  ButtonLink,
  EmptyState,
  ErrorState,
  Identifier,
  NoAccessState,
  Section,
  StatusBadge,
} from '@/ui';
import { PERSIAN_DECIMAL_SEPARATOR, formatJalaliDateLong, toPersianDigits } from '@/lib/format';
import {
  NEED_COMMAND_LABELS,
  NEED_PENDING_UNCHECKED_MESSAGE,
  NEED_RELEASE_STALE_MESSAGE,
  NEED_HELD_IN_PROGRESS_MESSAGE,
  NEED_LIST_UNREAD_MESSAGE,
  needStatusLabel,
  type NeedCommand,
  type NeedFormValues,
} from '@/lib/project-need-commands';
import type { ProjectNeed, ProjectNeedPage, ReadResult } from '@/server/projects';
import type { UnresolvedRequest } from '@/server/unresolved-request';

import { formatEstimate } from '../ProjectsScreen';
import { AddNeedForm, EditNeedForm, SubmitNeedForm, WithdrawNeedForm } from './NeedForms';
import { UnresolvedNeedNotice } from './UnresolvedNeedNotice';

/**
 * A project's needs (docs/16 § ۱۶٫۶, `/projects/[id]`): the list the service
 * answers, and for a person who may write projects the commands their status and
 * their project's status offer.
 *
 * The page decides **which** commands to draw — `offeredNeedCommands`, from the
 * need's status and the project's, for a token holding a project-writing role —
 * and signs a baseline for each (`sealNeedBaseline`); this renders exactly the
 * ones it was given a token for, so there is no status or role logic here to
 * drift from the page's. The service decides again on every send.
 *
 * Every outcome of the read is drawn: an empty project is said, a page past the
 * end is said, a service that did not answer is an error with its trace code (and
 * no command is drawn from a list that was not read), and a refusal is not an empty
 * list.
 */

export interface NeedToken {
  /** Minted for this render and bound to this session. */
  readonly submissionId: string;
  /** Signed for this command, this need and its version. */
  readonly baseline: string;
}

/** The commands drawn for each need, by need id. */
export type NeedTokens = Readonly<Record<string, Partial<Record<NeedCommand, NeedToken>>>>;

/** What the area under the list draws instead of nothing, and why. */
export type AddNeedSlot =
  /** The add form, for a submission id minted now. */
  | {
      readonly kind: 'FORM';
      readonly submission: { readonly id: string; readonly replay: string };
    }
  /** An earlier add is unresolved: said, with its release; no form beside it. */
  | {
      readonly kind: 'PENDING';
      readonly request: UnresolvedRequest;
      readonly releaseToken: string;
    }
  /** The store of unresolved requests could not say: no form, because none may mint a fresh key. */
  | { readonly kind: 'UNCHECKED' }
  /** The needs could not be read: no form, because an add is only sent after the needs were checked. */
  | { readonly kind: 'LIST_UNREAD' }
  | { readonly kind: 'NOT_OFFERED'; readonly reason: 'ROLE' | 'STATUS' };

export interface NeedsSectionProps {
  readonly projectId: string;
  readonly csrfToken: string;
  readonly result: ReadResult<ProjectNeedPage>;
  /** The cursor this page was read with; null on the first page. */
  readonly cursor: string | null;
  readonly tokens: NeedTokens;
  /** Each need's record as its edit form's text, by need id. */
  readonly editValues: Readonly<Record<string, NeedFormValues>>;
  readonly add: AddNeedSlot;
  /** Why the last release did nothing (`?release=`), when it did not. */
  readonly releaseRefused: 'STALE' | 'IN_PROGRESS' | null;
}

function quantityText(need: ProjectNeed): string {
  if (need.quantity === null) return 'مقدار نامشخص';
  const text = toPersianDigits(need.quantity).replace('.', PERSIAN_DECIMAL_SEPARATOR);
  return need.unit ? `${text} ${need.unit}` : text;
}

function NeedItem({
  need,
  projectId,
  csrfToken,
  tokens,
  editValues,
}: {
  need: ProjectNeed;
  projectId: string;
  csrfToken: string;
  tokens: Partial<Record<NeedCommand, NeedToken>>;
  editValues: NeedFormValues | undefined;
}) {
  const identity = (command: NeedCommand) => {
    const token = tokens[command];
    return token ? { projectId, needId: need.id, csrfToken, ...token } : null;
  };
  const edit = identity('edit');
  const submit = identity('submit');
  const withdraw = identity('withdraw');

  return (
    <li className="flex flex-col gap-3 rounded-lg border border-border bg-surface-raised p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-medium">{need.title}</h3>
        <StatusBadge status={need.status} label={needStatusLabel(need.status)} />
      </div>
      <p className="whitespace-pre-line text-sm">{need.description}</p>
      <dl className="grid gap-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-content-muted">مقدار</dt>
          <dd>{quantityText(need)}</dd>
        </div>
        <div>
          <dt className="text-content-muted">برآورد هزینه</dt>
          <dd>{formatEstimate(need.estimatedCostMinor)}</dd>
        </div>
        <div>
          <dt className="text-content-muted">ثبت در</dt>
          <dd>{formatJalaliDateLong(need.createdAt)}</dd>
        </div>
      </dl>
      {need.submittedAt ? (
        <p className="text-sm text-content-muted">
          ارسال در {formatJalaliDateLong(need.submittedAt)}
        </p>
      ) : null}
      {need.withdrawnAt ? (
        <p className="text-sm text-content-muted">
          پس‌گرفته در {formatJalaliDateLong(need.withdrawnAt)}
          {need.withdrawalReason ? ` — دلیل: ${need.withdrawalReason}` : ''}
        </p>
      ) : null}
      <p className="text-sm text-content-muted">
        شناسه <Identifier>{need.id}</Identifier>
      </p>

      {edit && editValues ? (
        <EditNeedForm {...edit} needTitle={need.title} initialValues={editValues} />
      ) : null}
      {submit ? <SubmitNeedForm {...submit} needTitle={need.title} /> : null}
      {withdraw ? <WithdrawNeedForm {...withdraw} needTitle={need.title} /> : null}
    </li>
  );
}

function NeedList({
  result,
  cursor,
  projectId,
  csrfToken,
  tokens,
  editValues,
}: Pick<
  NeedsSectionProps,
  'result' | 'cursor' | 'projectId' | 'csrfToken' | 'tokens' | 'editValues'
>) {
  if (result.kind === 'FORBIDDEN') {
    return <NoAccessState description="نیازهای این پروژه در اختیار شما نیست." />;
  }
  if (result.kind === 'NOT_FOUND') {
    return (
      <EmptyState
        title="نیازها پیدا نشد"
        description="پروژه یا نیازهای آن پیدا نشد یا در سازمان فعال شما نیست."
      />
    );
  }
  if (result.kind === 'UNAVAILABLE' || result.kind === 'MALFORMED') {
    return (
      <ErrorState
        description="نیازهای پروژه خوانده نشد، پس اقدامی روی آنها نشان داده نمی‌شود. کمی بعد دوباره تلاش کنید."
        correlationId={result.correlationId}
      />
    );
  }

  const page = result.data;
  const href = (next: string | null) =>
    next === null
      ? `/projects/${encodeURIComponent(projectId)}`
      : `/projects/${encodeURIComponent(projectId)}?needs=${encodeURIComponent(next)}`;

  return (
    <>
      {page.items.length === 0 ? (
        <EmptyState
          title={cursor === null ? 'نیازی ثبت نشده' : 'نیاز دیگری نیست'}
          description={
            cursor === null
              ? 'برای این پروژه هنوز نیازی ثبت نشده است.'
              : 'این صفحه از نیازها خالی است.'
          }
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {page.items.map((need) => (
            <NeedItem
              key={need.id}
              need={need}
              projectId={projectId}
              csrfToken={csrfToken}
              tokens={tokens[need.id] ?? {}}
              editValues={editValues[need.id]}
            />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {cursor !== null ? (
          <Link href={href(null)} className="underline">
            بازگشت به نخستین نیازها
          </Link>
        ) : null}
        {page.hasMore && page.nextCursor ? (
          <ButtonLink href={href(page.nextCursor)} tone="secondary">
            نیازهای بعدی
          </ButtonLink>
        ) : null}
        {page.hasMore && !page.nextCursor ? (
          <p className="text-sm text-content-muted">نیازهای بیشتری هست که از اینجا دیده نمی‌شود.</p>
        ) : null}
      </div>
    </>
  );
}

function AddArea({
  add,
  projectId,
  csrfToken,
}: {
  add: AddNeedSlot;
  projectId: string;
  csrfToken: string;
}) {
  switch (add.kind) {
    case 'FORM':
      return (
        <div className="flex flex-col gap-3">
          <h3 className="text-base font-semibold text-content">{NEED_COMMAND_LABELS.add}</h3>
          <AddNeedForm projectId={projectId} csrfToken={csrfToken} submission={add.submission} />
        </div>
      );
    case 'PENDING':
      return (
        <UnresolvedNeedNotice
          projectId={projectId}
          request={add.request}
          csrfToken={csrfToken}
          releaseToken={add.releaseToken}
        />
      );
    case 'UNCHECKED':
      // Not "no hold": the store could not say, so no add form is drawn (and none mints a fresh key);
      // the action refuses too.
      return <Alert tone="warning">{NEED_PENDING_UNCHECKED_MESSAGE}</Alert>;
    case 'LIST_UNREAD':
      return <Alert tone="warning">{NEED_LIST_UNREAD_MESSAGE}</Alert>;
    case 'NOT_OFFERED':
      return (
        <EmptyState
          title="افزودن نیاز در دسترس نیست"
          description={
            add.reason === 'ROLE'
              ? 'نقش شما اجازه تغییر پروژه ندارد. نقش‌های مجاز را تنظیمات استقرار تعیین می‌کند.'
              : 'نیازها فقط تا وقتی پروژه پیش‌نویس یا نیازمند اصلاح است تغییر می‌کنند.'
          }
        />
      );
  }
}

export function NeedsSection({
  projectId,
  csrfToken,
  result,
  cursor,
  tokens,
  editValues,
  add,
  releaseRefused,
}: NeedsSectionProps) {
  return (
    <Section
      headingId="project-need-list"
      title="فهرست نیازها"
      description="هر نیاز یک سطر از آنچه پروژه لازم دارد است. نیاز پیش‌نویس ویرایش و ارسال می‌شود، نیاز ارسال‌شده فقط پس گرفته می‌شود. سرویس پروژه‌ها در هر ارسال دوباره تصمیم می‌گیرد."
    >
      {releaseRefused ? (
        <Alert tone="warning">
          {releaseRefused === 'IN_PROGRESS'
            ? NEED_HELD_IN_PROGRESS_MESSAGE
            : NEED_RELEASE_STALE_MESSAGE}
        </Alert>
      ) : null}
      <NeedList
        result={result}
        cursor={cursor}
        projectId={projectId}
        csrfToken={csrfToken}
        tokens={tokens}
        editValues={editValues}
      />
      <AddArea add={add} projectId={projectId} csrfToken={csrfToken} />
    </Section>
  );
}
