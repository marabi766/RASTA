import Link from 'next/link';
import type { ReactNode } from 'react';

import {
  ButtonLink,
  EmptyState,
  ErrorState,
  Identifier,
  NoAccessState,
  Section,
  StatusBadge,
} from '@/ui';
import { formatJalaliDateLong, toPersianDigits } from '@/lib/format';
import {
  SUPPLIER_CAPABILITIES,
  SUPPLIER_STATUSES,
  supplierCapabilityLabel,
  supplierStatusLabel,
  type SupplierCapability,
  type SupplierStatus,
} from '@/lib/supplier-fields';
import type {
  SupplierListQuery,
  SupplierPage,
  SupplierSummary,
  ReadResult,
} from '@/server/suppliers';

/**
 * The supplier directory (docs/16 § ۱۶٫۶, `/suppliers`).
 *
 * A pure function of what the server read, like `ProjectsScreen`: every state
 * is renderable in a test. Filters and paging live in the URL, so no
 * JavaScript is involved and a filtered list is a link somebody can send.
 *
 * This is the cross-tenant directory (`GET /v1/suppliers`): catalogue-safe
 * fields only, the same object for every organization that may browse it.
 * The private record — qualification history and suspension episodes — is on
 * `/suppliers/[id]`, and only for the caller's own organization or a platform
 * operator.
 */

export interface SuppliersScreenProps {
  readonly result: ReadResult<SupplierPage>;
  readonly query: SupplierListQuery;
  /**
   * The organization this session acts for: its own row is marked, because the
   * API has no "my supplier" lookup and this is the only way to find it.
   */
  readonly ownOrganizationId?: string | null;
  /** The registration form, when the page found the person may register (`page.tsx`). */
  readonly register?: ReactNode;
}

function hrefWith(query: SupplierListQuery, changes: Partial<SupplierListQuery>): string {
  const merged = { ...query, ...changes };
  const params = new URLSearchParams();
  if (merged.status) params.set('status', merged.status);
  if (merged.capability) params.set('capability', merged.capability);
  if (merged.cursor) params.set('cursor', merged.cursor);
  const text = params.toString();
  return text ? `/suppliers?${text}` : '/suppliers';
}

function StatusFilter({ query }: { query: SupplierListQuery }) {
  const items: readonly (SupplierStatus | undefined)[] = [undefined, ...SUPPLIER_STATUSES];
  return (
    <nav aria-label="وضعیت تأمین‌کننده" className="flex flex-wrap gap-2">
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
          {status ? supplierStatusLabel(status) : 'همه وضعیت‌ها'}
        </Link>
      ))}
    </nav>
  );
}

function CapabilityFilter({ query }: { query: SupplierListQuery }) {
  const items: readonly (SupplierCapability | undefined)[] = [undefined, ...SUPPLIER_CAPABILITIES];
  return (
    <nav aria-label="دستهٔ تأمین‌کننده" className="flex flex-wrap gap-2">
      {items.map((capability) => (
        <Link
          key={capability ?? 'ALL'}
          href={hrefWith(query, { capability, cursor: undefined })}
          aria-current={capability === query.capability ? 'page' : undefined}
          className={
            capability === query.capability
              ? 'rounded-md border border-border-strong bg-surface-raised px-3 py-2 text-sm font-medium'
              : 'rounded-md border border-border px-3 py-2 text-sm text-content-muted'
          }
        >
          {capability ? supplierCapabilityLabel(capability) : 'همه دسته‌ها'}
        </Link>
      ))}
    </nav>
  );
}

function SupplierRow({ supplier, own }: { supplier: SupplierSummary; own: boolean }) {
  return (
    <li className="rounded-lg border border-border bg-surface-raised p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link
          href={`/suppliers/${encodeURIComponent(supplier.id)}`}
          className="font-medium underline"
        >
          {supplier.displayName}
        </Link>
        {own ? <span className="text-sm font-medium">سازمان شما</span> : null}
        <StatusBadge status={supplier.status} label={supplierStatusLabel(supplier.status)} />
      </div>
      <p className="mt-2 text-sm text-content-muted">
        {supplier.capabilities.length === 0
          ? 'بدون دستهٔ اعلام‌شده'
          : supplier.capabilities
              .map((capability) => supplierCapabilityLabel(capability))
              .join(' · ')}
      </p>
      <p className="mt-1 text-sm">
        {supplier.qualifiedFor.length === 0
          ? 'در حال حاضر برای هیچ دسته‌ای صلاحیت فعال ندارد'
          : `صلاحیت فعال برای: ${supplier.qualifiedFor
              .map((capability) => supplierCapabilityLabel(capability))
              .join(' · ')}`}
      </p>
      <p className="mt-1 text-sm text-content-muted">
        شناسه <Identifier>{supplier.id}</Identifier> · شناسهٔ سازمان{' '}
        <Identifier>{supplier.organizationId}</Identifier> · ثبت در{' '}
        {formatJalaliDateLong(supplier.registeredAt)}
      </p>
    </li>
  );
}

export function SuppliersScreen({
  result,
  query,
  ownOrganizationId = null,
  register = null,
}: SuppliersScreenProps) {
  return (
    <div className="flex flex-col gap-4">
      {register ? (
        <Section headingId="supplier-register" title="ثبت پرونده تامین‌کننده برای سازمان شما">
          {register}
        </Section>
      ) : null}
      <StatusFilter query={query} />
      <CapabilityFilter query={query} />
      <SuppliersBody result={result} query={query} ownOrganizationId={ownOrganizationId} />
    </div>
  );
}

function SuppliersBody({
  result,
  query,
  ownOrganizationId,
}: SuppliersScreenProps & { ownOrganizationId: string | null }) {
  if (result.kind === 'FORBIDDEN') {
    return <NoAccessState description="فهرست تأمین‌کنندگان در اختیار شما نیست." />;
  }

  if (result.kind === 'NOT_FOUND') {
    return (
      <EmptyState title="تأمین‌کننده‌ای یافت نشد" description="این نشست سازمان فعالی ندارد." />
    );
  }

  if (result.kind === 'UNAVAILABLE' || result.kind === 'MALFORMED') {
    return (
      <ErrorState
        description="فهرست تأمین‌کنندگان خوانده نشد. کمی بعد دوباره تلاش کنید."
        correlationId={result.correlationId}
      />
    );
  }

  const page = result.data;

  return (
    <Section headingId="suppliers" title="تأمین‌کنندگان">
      {page.items.length === 0 ? (
        <EmptyState
          title="تأمین‌کننده‌ای نیست"
          description={
            query.status || query.capability
              ? 'تأمین‌کننده‌ای با این فیلتر یافت نشد.'
              : 'هنوز تأمین‌کننده‌ای در این فهرست نیست.'
          }
        />
      ) : (
        <>
          <p className="mb-3 text-sm text-content-muted">
            {toPersianDigits(String(page.items.length))} تأمین‌کننده در این صفحه
          </p>
          <ul className="flex flex-col gap-3">
            {page.items.map((supplier) => (
              <SupplierRow
                key={supplier.id}
                supplier={supplier}
                own={ownOrganizationId !== null && supplier.organizationId === ownOrganizationId}
              />
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
