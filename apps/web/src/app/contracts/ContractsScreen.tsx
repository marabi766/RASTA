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
import { DemoModeNotice } from '@/app/DemoModeNotice';
import { IRR, formatJalaliDateLong, formatMoney, toPersianDigits } from '@/lib/format';
import {
  CONTRACT_STATES,
  CONTRACT_STATE_LABELS,
  contractStatusLabel,
  type ContractStatus,
} from '@/lib/contract-fields';
import type {
  ContractListQuery,
  ContractPage,
  ContractSummary,
  ReadResult,
} from '@/server/contracts';

/**
 * The contract list (docs/16 § ۱۶٫۶, `/contracts`), read-only.
 *
 * A pure function of what the server read, like `ProjectsScreen`: every state
 * is renderable in a test. Status and paging live in the URL, so no
 * JavaScript is involved and a filtered list is a link somebody can send.
 *
 * `GET /v1/contracts` already answers for both sides of a contract — the
 * employer's organization and the winning contractor's — so one list shows
 * both, with no separate "view" to choose (ADR-068 § 7).
 */

export interface ContractsScreenProps {
  readonly result: ReadResult<ContractPage>;
  readonly query: ContractListQuery;
  /** The provider is simulated (`fetchDemoMode`, Q-14): draw «حالت نمایشی». */
  readonly demoMode?: boolean;
}

function hrefWith(query: ContractListQuery, changes: Partial<ContractListQuery>): string {
  const merged = { ...query, ...changes };
  const params = new URLSearchParams();
  if (merged.status) params.set('status', merged.status);
  if (merged.cursor) params.set('cursor', merged.cursor);
  const text = params.toString();
  return text ? `/contracts?${text}` : '/contracts';
}

function StatusFilter({ query }: { query: ContractListQuery }) {
  const items: readonly (ContractStatus | undefined)[] = [undefined, ...CONTRACT_STATES];
  return (
    <nav aria-label="وضعیت قرارداد" className="flex flex-wrap gap-2">
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
          {status ? CONTRACT_STATE_LABELS[status] : 'همه'}
        </Link>
      ))}
    </nav>
  );
}

function ContractRow({ contract }: { contract: ContractSummary }) {
  return (
    <li className="rounded-lg border border-border bg-surface-raised p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link
          href={`/contracts/${encodeURIComponent(contract.id)}`}
          className="font-medium underline"
        >
          <Identifier>{contract.id}</Identifier>
        </Link>
        <StatusBadge status={contract.status} label={contractStatusLabel(contract.status)} />
      </div>
      <p className="mt-2 text-sm">
        مبلغ جاری:{' '}
        <span className="font-medium">{formatMoney(contract.currentAmountMinor, IRR)}</span>
      </p>
      <p className="mt-1 text-sm text-content-muted">
        کارفرما <Identifier>{contract.organizationId}</Identifier> · پیمانکار{' '}
        <Identifier>{contract.contractorOrganizationId}</Identifier>
      </p>
      <p className="mt-1 text-sm text-content-muted">
        پروژه <Identifier>{contract.projectId}</Identifier> · واگذاری در{' '}
        {formatJalaliDateLong(contract.awardedAt)}
      </p>
    </li>
  );
}

export function ContractsScreen({ result, query, demoMode }: ContractsScreenProps) {
  return (
    <div className="flex flex-col gap-4">
      {demoMode ? <DemoModeNotice /> : null}
      <StatusFilter query={query} />
      <ContractsBody result={result} query={query} />
    </div>
  );
}

function ContractsBody({ result, query }: ContractsScreenProps) {
  if (result.kind === 'FORBIDDEN') {
    return <NoAccessState description="فهرست قراردادهای این سازمان در اختیار شما نیست." />;
  }

  if (result.kind === 'NOT_FOUND') {
    return <EmptyState title="قراردادی یافت نشد" description="این نشست سازمان فعالی ندارد." />;
  }

  if (result.kind === 'UNAVAILABLE' || result.kind === 'MALFORMED') {
    return (
      <ErrorState
        description="فهرست قراردادها خوانده نشد. کمی بعد دوباره تلاش کنید."
        correlationId={result.correlationId}
      />
    );
  }

  const page = result.data;

  return (
    <Section headingId="contracts" title="قراردادها">
      {page.items.length === 0 ? (
        <EmptyState
          title="قراردادی نیست"
          description={
            query.status
              ? `قراردادی در وضعیت «${contractStatusLabel(query.status)}» نیست.`
              : 'این سازمان هنوز طرف هیچ قراردادی نیست.'
          }
        />
      ) : (
        <>
          <p className="mb-3 text-sm text-content-muted">
            {toPersianDigits(String(page.items.length))} قرارداد در این صفحه
          </p>
          <ul className="flex flex-col gap-3">
            {page.items.map((contract) => (
              <ContractRow key={contract.id} contract={contract} />
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
