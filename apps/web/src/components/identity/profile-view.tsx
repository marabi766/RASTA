'use client';

import type { ReactNode } from 'react';
import { fetchCurrentUser, type MembershipView } from '@/lib/api/adapters/identity';
import { useSession } from '@/lib/auth/session';
import { formatJalaliDate } from '@/lib/format';
import { useApiResource } from '@/lib/use-api-resource';
import { Badge, Card, PageHeader } from '../ui/primitives';
import { Code, DataTable, DataView, DescriptionList, Maybe, Section } from '../ui/data-view';

/**
 * The signed-in user, their memberships and the tenant they are acting as.
 *
 * ## Why this screen shows two sources side by side
 *
 * ADR-008 splits authentication from membership: Keycloak decides who you are,
 * `identity-service` decides which organizations you belong to and with what
 * roles. Both appear here because a viewer asking "why can't I see that?" is
 * almost always looking at a gap between them.
 *
 * What is deliberately **not** shown: the raw token, its claims verbatim, the
 * subject identifier, or anything that would put a bearer credential on screen
 * during a presentation (S-09). The organization ids are shown because they are
 * already on every offer the marketplace serves and are what a buyer uses to
 * place an order; the token is not.
 */
export function ProfileView(): ReactNode {
  const { claims, organizationId } = useSession();

  const resource = useApiResource((client, signal) => fetchCurrentUser(client, signal), []);

  return (
    <>
      <PageHeader
        title="حساب کاربری و عضویت‌ها"
        description="اینکه چه کسی وارد شده، به کدام سازمان‌ها تعلق دارد، و درخواست‌های این نشست به نام کدام سازمان فرستاده می‌شوند."
      />

      <Section
        id="acting-as"
        title="در حال حاضر به‌نام چه کسی عمل می‌کنید"
        description="این همان چیزی است که در هدر هر درخواست می‌رود و درگاه API آن را در برابر ادعای امضاشدهٔ توکن اعتبارسنجی می‌کند."
      >
        <Card>
          <DescriptionList
            items={[
              {
                term: 'سازمان فعال',
                value: organizationId ? <Code>{organizationId}</Code> : <Maybe value={null} />,
              },
              {
                term: 'نقش‌های اعلام‌شده در توکن',
                value:
                  claims && claims.roles.length > 0 ? (
                    <span className="flex flex-wrap gap-1">
                      {claims.roles.map((role) => (
                        <Badge key={role} tone="primary">
                          <Code>{role}</Code>
                        </Badge>
                      ))}
                    </span>
                  ) : (
                    <Maybe value={null} />
                  ),
              },
            ]}
          />
          <p className="mt-4 text-xs text-[var(--tx3)]">
            نمایش یا پنهان کردن یک دکمه در این رابط، کنترل امنیتی نیست. هر مجوز، مستقلاً در درگاه
            API و دوباره در خود سرویس بررسی می‌شود.
          </p>
        </Card>
      </Section>

      <DataView
        resource={resource}
        context="اطلاعات حساب کاربری"
        loadingLabel="در حال خواندن حساب کاربری"
        loadingRows={2}
      >
        {(user) => (
          <>
            <Section id="account" title="مشخصات کاربر">
              <Card>
                <DescriptionList
                  items={[
                    { term: 'نام', value: `${user.firstName} ${user.lastName}`.trim() || '—' },
                    { term: 'نام کاربری', value: <Code>{user.username}</Code> },
                    { term: 'رایانامه', value: <span dir="ltr">{user.email}</span> },
                    { term: 'تلفن', value: <Maybe value={user.phone} /> },
                    { term: 'وضعیت حساب', value: <Code>{user.status}</Code> },
                    { term: 'شناسهٔ کاربر در پلتفرم', value: <Code>{user.id}</Code> },
                    {
                      term: 'سازمان فعال اعلام‌شده در سرویس هویت',
                      value: user.activeOrganizationId ? (
                        <Code>{user.activeOrganizationId}</Code>
                      ) : (
                        <Maybe value={null} />
                      ),
                    },
                    { term: 'تاریخ ایجاد', value: formatJalaliDate(user.createdAt) },
                  ]}
                  columns={2}
                />
              </Card>
            </Section>

            <Section
              id="effective-roles"
              title="نقش‌های مؤثر در سازمان فعال"
              description="نقش‌هایی که سرویس هویت برای همین سازمان محاسبه می‌کند — نه لزوماً همهٔ نقش‌هایی که کاربر در کل پلتفرم دارد."
            >
              <Card>
                {user.effectiveRoles.length === 0 ? (
                  <p className="text-sm text-[var(--tx2)]">
                    برای این سازمان هیچ نقش مؤثری اعلام نشده است.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {user.effectiveRoles.map((role) => (
                      <Badge key={role} tone="success">
                        <Code>{role}</Code>
                      </Badge>
                    ))}
                  </div>
                )}
              </Card>
            </Section>

            <Section
              id="memberships"
              title="عضویت‌های سازمانی"
              description="رکوردهای واقعی عضویت از سرویس هویت. یک عضویت که در ادعای توکن نیامده باشد، تا زمان همگام‌سازی بعدی قابل انتخاب نیست."
            >
              {user.memberships.length === 0 ? (
                <Card>
                  <p className="text-sm text-[var(--tx2)]">هیچ عضویت سازمانی ثبت نشده است.</p>
                </Card>
              ) : (
                <DataTable
                  rows={user.memberships}
                  rowKey={(row) => row.id}
                  caption="هر سطر یک عضویت است، با نقش‌هایی که در همان سازمان اعمال می‌شود."
                  minWidth="40rem"
                  columns={[
                    {
                      key: 'organization',
                      header: 'سازمان',
                      render: (row: MembershipView) => (
                        <>
                          <span dir="auto">
                            <Maybe value={row.organizationName} />
                          </span>
                          <Code>{row.organizationId}</Code>
                        </>
                      ),
                    },
                    {
                      key: 'roles',
                      header: 'نقش‌ها',
                      render: (row) => (
                        <span className="flex flex-wrap gap-1">
                          {row.roles.map((role) => (
                            <Badge key={role}>
                              <Code>{role}</Code>
                            </Badge>
                          ))}
                        </span>
                      ),
                    },
                    {
                      key: 'status',
                      header: 'وضعیت',
                      render: (row) => <Code>{row.status}</Code>,
                    },
                    {
                      key: 'selectable',
                      header: 'قابل انتخاب در این نشست',
                      render: (row) =>
                        claims?.organizationIds.includes(row.organizationId) ? (
                          <Badge tone="success">بله</Badge>
                        ) : (
                          <Badge tone="warning" title="در ادعای امضاشدهٔ توکن این نشست نیست.">
                            خیر
                          </Badge>
                        ),
                    },
                    {
                      key: 'validFrom',
                      header: 'از تاریخ',
                      render: (row) => formatJalaliDate(row.validFrom),
                    },
                  ]}
                />
              )}
            </Section>
          </>
        )}
      </DataView>
    </>
  );
}
