'use client';

import type { ReactNode } from 'react';
import { listUsers, type OrganizationUser } from '@/lib/api/adapters/identity';
import { formatInteger, formatJalaliDate } from '@/lib/format';
import { useApiResource } from '@/lib/use-api-resource';
import { Badge, Card, PageHeader } from '../ui/primitives';
import { Code, DataTable, DataView, Maybe, Section } from '../ui/data-view';

/**
 * Users in the acting organization.
 *
 * Route roles are `ORGANIZATION_ADMIN` and `UNION_ADMIN`. Every other role gets
 * `403`, and that is rendered as a refusal rather than as a fault — the
 * platform behaving exactly as designed. It is also a useful thing to show
 * during a demo: switch to a role without the permission and the screen changes
 * its answer, without any code branching on the role.
 *
 * The `roles` column is per-organization. A user can hold different roles in
 * different organizations, which is the whole reason membership lives in
 * `identity-service` rather than in the identity provider (ADR-008).
 */
export function UsersView(): ReactNode {
  const resource = useApiResource((client, signal) => listUsers(client, signal), []);

  return (
    <>
      <PageHeader
        title="کاربران سازمان"
        description="کاربران سازمان فعال و نقش‌هایی که در همین سازمان دارند. نقش‌ها به‌ازای هر سازمان تعریف می‌شوند، نه به‌ازای هر حساب."
      />

      <DataView
        resource={resource}
        context="فهرست کاربران سازمان"
        loadingLabel="در حال خواندن کاربران سازمان"
        empty={{
          title: 'کاربری در این سازمان ثبت نشده است',
          description: 'با افزودن نخستین عضویت، این فهرست پر می‌شود.',
        }}
      >
        {(users) => (
          <DataTable
            rows={users}
            rowKey={(row) => row.id}
            caption={`${formatInteger(users.length)} کاربر در سازمان فعال.`}
            minWidth="48rem"
            columns={[
              {
                key: 'name',
                header: 'کاربر',
                render: (row: OrganizationUser) => (
                  <>
                    <span dir="auto">
                      {`${row.firstName} ${row.lastName}`.trim() || row.username}
                    </span>
                    <Code>{row.username}</Code>
                  </>
                ),
              },
              {
                key: 'email',
                header: 'رایانامه',
                render: (row) => <span dir="ltr">{row.email}</span>,
              },
              {
                key: 'phone',
                header: 'تلفن',
                render: (row) => (
                  <Maybe value={row.phone ? <span dir="ltr">{row.phone}</span> : null} />
                ),
              },
              {
                key: 'roles',
                header: 'نقش‌ها در این سازمان',
                render: (row) =>
                  row.roles.length === 0 ? (
                    <span className="text-[var(--tx3)]">—</span>
                  ) : (
                    <span className="flex flex-wrap gap-1">
                      {row.roles.map((role) => (
                        <Badge key={role} tone="primary">
                          <Code>{role}</Code>
                        </Badge>
                      ))}
                    </span>
                  ),
              },
              {
                key: 'status',
                header: 'وضعیت',
                render: (row) => (
                  <Badge tone={row.status === 'ACTIVE' ? 'success' : 'neutral'}>
                    <Code>{row.status}</Code>
                  </Badge>
                ),
              },
              {
                key: 'created',
                header: 'ایجاد',
                render: (row) => formatJalaliDate(row.createdAt),
              },
            ]}
          />
        )}
      </DataView>

      <Section id="read-only" title="چرا این صفحه فقط می‌خواند">
        <Card>
          <p className="text-sm text-[var(--tx2)]">
            ساخت کاربر، افزودن عضویت و تغییر نقش، همگی مسیر واقعی دارند و همگی وضعیت مشترک را تغییر
            می‌دهند. یک نسخهٔ پیش‌نمایش نباید روی دادهٔ مشترک، کاربر بسازد یا سطح دسترسی کسی را عوض
            کند؛ بنابراین این صفحه فقط می‌خواند.
          </p>
        </Card>
      </Section>
    </>
  );
}
