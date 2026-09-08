'use client';

import type { ReactNode } from 'react';
import { listVisibleOrganizations, type OrganizationView } from '@/lib/api/adapters/organization';
import { useSession } from '@/lib/auth/session';
import { formatInteger, formatJalaliDate } from '@/lib/format';
import { useApiResource } from '@/lib/use-api-resource';
import { ApiErrorView } from '../api-error';
import { Badge, Card, EmptyState, LoadingState, PageHeader } from '../ui/primitives';

/**
 * Organizations, and the distinction between seeing one and acting as one.
 *
 * `GET /v1/organizations` answers "visible to the caller" — a subtree question,
 * so it can include organizations far outside the user's memberships. The
 * membership set comes from somewhere else entirely: the signed `org_ids` claim
 * that the gateway validates `X-Organization-Id` against (ADR-035).
 *
 * The table below marks the difference explicitly rather than quietly merging
 * the two, because merging them is how a tenant switcher offers an
 * organization the platform will then refuse.
 */
export function OrganizationsView(): ReactNode {
  const { claims, organizationId } = useSession();
  const memberships = new Set(claims?.organizationIds ?? []);

  const { state, reload } = useApiResource(
    (client, signal) => listVisibleOrganizations(client, signal),
    [],
  );

  return (
    <>
      <PageHeader
        title="سازمان‌ها"
        description="سازمان‌هایی که این حساب می‌تواند ببیند، و اینکه کدام‌یک را می‌تواند به‌عنوان سازمان فعال انتخاب کند. این دو، یکی نیستند."
      />

      <Card className="mb-6">
        <h2 className="text-sm font-bold text-[var(--tx)]">عضویت‌های اعلام‌شده در توکن</h2>
        <p className="mt-2 text-sm text-[var(--tx2)]">
          {memberships.size === 0
            ? 'توکن شما هیچ عضویت سازمانی اعلام نکرده است.'
            : `${formatInteger(memberships.size)} عضویت. فقط همین‌ها در انتخابگر سازمان ظاهر می‌شوند، چون درگاه API هدر سازمان را در برابر همین ادعای امضاشده اعتبارسنجی می‌کند.`}
        </p>
      </Card>

      {state.status === 'loading' ? (
        <LoadingState rows={4} label="در حال خواندن فهرست سازمان‌ها" />
      ) : null}

      {state.status === 'error' ? (
        <ApiErrorView failure={state.failure} onRetry={reload} context="فهرست سازمان‌ها" />
      ) : null}

      {state.status === 'success' && state.data.length === 0 ? (
        <EmptyState
          title="سازمانی برای نمایش نیست"
          description="این حساب به هیچ زیردرختی از سلسله‌مراتب سازمانی دسترسی خواندن ندارد."
        />
      ) : null}

      {state.status === 'success' && state.data.length > 0 ? (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[44rem] border-collapse text-sm">
            <caption className="p-4 text-start text-xs text-[var(--tx3)]">
              {formatInteger(state.data.length)} سازمان قابل مشاهده.
            </caption>
            <thead>
              <tr className="border-b border-[var(--bd)] text-xs text-[var(--tx3)]">
                <th scope="col" className="p-3 text-start font-semibold">
                  نام
                </th>
                <th scope="col" className="p-3 text-start font-semibold">
                  نوع
                </th>
                <th scope="col" className="p-3 text-start font-semibold">
                  وضعیت
                </th>
                <th scope="col" className="p-3 text-start font-semibold">
                  سطح
                </th>
                <th scope="col" className="p-3 text-start font-semibold">
                  ثبت
                </th>
                <th scope="col" className="p-3 text-start font-semibold">
                  دسترسی شما
                </th>
              </tr>
            </thead>
            <tbody>
              {state.data.map((organization) => (
                <OrganizationRow
                  key={organization.id}
                  organization={organization}
                  isMember={memberships.has(organization.id)}
                  isActive={organization.id === organizationId}
                />
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
    </>
  );
}

function OrganizationRow({
  organization,
  isMember,
  isActive,
}: {
  organization: OrganizationView;
  isMember: boolean;
  isActive: boolean;
}): ReactNode {
  return (
    <tr className="border-b border-[var(--bd)] last:border-b-0">
      <th scope="row" className="p-3 text-start font-semibold text-[var(--tx)]">
        <span dir="auto">{organization.name}</span>
        <span dir="ltr" className="mt-0.5 block rasta-code text-[var(--tx3)]">
          {organization.id}
        </span>
      </th>
      <td className="p-3" dir="ltr">
        <span className="rasta-code">{organization.type}</span>
      </td>
      <td className="p-3">
        <Badge tone={organization.status === 'ACTIVE' ? 'success' : 'neutral'}>
          <span dir="ltr" className="rasta-code">
            {organization.status}
          </span>
        </Badge>
      </td>
      <td className="p-3">{formatInteger(organization.depth)}</td>
      <td className="p-3">{formatJalaliDate(organization.createdAt)}</td>
      <td className="p-3">
        {isActive ? (
          <Badge tone="primary">سازمان فعال</Badge>
        ) : isMember ? (
          <Badge tone="info">قابل انتخاب</Badge>
        ) : (
          <Badge tone="neutral" title="در ادعای عضویت توکن نیست، پس نمی‌توان به نام آن عمل کرد.">
            فقط مشاهده
          </Badge>
        )}
      </td>
    </tr>
  );
}
