'use client';

import Link from 'next/link';
import { useState, type FormEvent, type ReactNode } from 'react';
import {
  ASSET_TYPE_LABELS,
  OPERATIONAL_STATUSES,
  OPERATIONAL_STATUS_LABELS,
  listAssets,
  type AssetView,
  type OperationalStatus,
} from '@/lib/api/adapters/asset';
import { formatInteger, formatJalaliDate } from '@/lib/format';
import { useApiResource } from '@/lib/use-api-resource';
import { Badge, Button, Card, PageHeader, cx, type Tone } from '../ui/primitives';
import { Code, DataTable, DataView, Maybe } from '../ui/data-view';

/**
 * The machine register.
 *
 * `GET /v1/assets` is tenant-scoped by the gateway: this is the caller's own
 * organization's machines, never the province's. That is the opposite of the
 * marketplace read on the next screen over, and the contrast is worth pointing
 * out during a demo — the same platform does both, deliberately, and each read
 * says which it is.
 *
 * The status filter is the real `OPERATIONAL_STATUSES` enum. `expiringWithinDays`
 * is offered as one preset rather than a free number field, because a demo
 * needs a button that finds something, not a form.
 */
export function AssetsView(): ReactNode {
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState<{
    q: string;
    status?: OperationalStatus;
    expiringWithinDays?: number;
  }>({ q: '' });

  const resource = useApiResource(
    (client, signal) => listAssets(client, query, signal),
    [query.q, query.status, query.expiringWithinDays],
  );

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    setQuery((current) => ({ ...current, q: draft }));
  };

  return (
    <>
      <PageHeader
        title="ماشین‌آلات"
        description="دارایی‌های سازمان فعال. هر ردیف به پروندهٔ الکترونیکی همان ماشین می‌رود: هویت، انطباق، هزینهٔ انباشته و خط زمانی رویدادها."
      />

      <Card className="mb-6">
        <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-3">
          <div className="min-w-56 flex-1">
            <label htmlFor="asset-q" className="mb-1 block text-xs font-semibold text-[var(--tx2)]">
              جست‌وجو
            </label>
            <input
              id="asset-q"
              type="search"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="نام، پلاک یا شمارهٔ سریال"
              className="min-h-[var(--tap)] w-full rounded-[var(--radius-md)] border border-[var(--control-border)] bg-[var(--surf)] px-3 text-sm text-[var(--tx)]"
            />
          </div>

          <div>
            <label
              htmlFor="asset-status"
              className="mb-1 block text-xs font-semibold text-[var(--tx2)]"
            >
              وضعیت عملیاتی
            </label>
            <select
              id="asset-status"
              value={query.status ?? ''}
              onChange={(event) =>
                setQuery((current) => ({
                  ...current,
                  status: (event.target.value || undefined) as OperationalStatus | undefined,
                }))
              }
              className="min-h-[var(--tap)] rounded-[var(--radius-md)] border border-[var(--control-border)] bg-[var(--surf)] px-3 text-sm text-[var(--tx)]"
            >
              <option value="">همه</option>
              {OPERATIONAL_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {OPERATIONAL_STATUS_LABELS[status] ?? status}
                </option>
              ))}
            </select>
          </div>

          <Button type="submit">اعمال</Button>

          <Button
            variant={query.expiringWithinDays ? 'primary' : 'secondary'}
            onClick={() =>
              setQuery((current) => ({
                ...current,
                expiringWithinDays: current.expiringWithinDays ? undefined : 30,
              }))
            }
          >
            بیمه یا معاینهٔ رو به انقضا (۳۰ روز)
          </Button>
        </form>
      </Card>

      <DataView
        resource={resource}
        context="فهرست ماشین‌آلات"
        loadingLabel="در حال خواندن فهرست ماشین‌آلات"
        loadingRows={4}
        empty={{
          title: 'ماشینی با این مشخصات پیدا نشد',
          description:
            'ممکن است این سازمان هنوز دارایی ثبت‌شده‌ای نداشته باشد، یا فیلترهای بالا نتیجه‌ای نداشته باشند.',
        }}
      >
        {(assets) => (
          <DataTable
            rows={assets}
            rowKey={(row) => row.id}
            caption={`${formatInteger(assets.length)} ماشین در سازمان فعال.`}
            columns={[
              {
                key: 'name',
                header: 'ماشین',
                render: (row: AssetView) => (
                  <Link
                    href={`/assets/${encodeURIComponent(row.id)}`}
                    className="hover:text-[var(--pri)] hover:underline"
                  >
                    <span dir="auto">{row.name}</span>
                    <Code>{row.id}</Code>
                  </Link>
                ),
              },
              {
                key: 'type',
                header: 'نوع',
                render: (row) => ASSET_TYPE_LABELS[row.type] ?? row.type,
              },
              {
                key: 'tag',
                header: 'پلاک / شمارهٔ ناوگان',
                render: (row) => (
                  <Maybe value={row.assetTag ? <Code>{row.assetTag}</Code> : null} />
                ),
              },
              {
                key: 'status',
                header: 'وضعیت',
                render: (row) => <StatusBadge status={row.status} />,
              },
              {
                key: 'manufacturer',
                header: 'سازنده و مدل',
                render: (row) => (
                  <Maybe
                    value={[row.manufacturer, row.model].filter(Boolean).join(' — ') || null}
                  />
                ),
              },
              {
                key: 'commissioned',
                header: 'بهره‌برداری از',
                render: (row) => (
                  <Maybe value={row.commissionedAt ? formatJalaliDate(row.commissionedAt) : null} />
                ),
              },
            ]}
          />
        )}
      </DataView>
    </>
  );
}

/**
 * The platform's status colour language (docs/16 § 16.5).
 *
 * The Latin enum travels with the Persian label, always. A colour alone never
 * carries meaning (§ 16.9), and the enum is what a developer greps for.
 */
export function StatusBadge({ status }: { status: string }): ReactNode {
  return (
    <Badge tone={statusTone(status)}>
      <span className={cx('whitespace-nowrap')}>{OPERATIONAL_STATUS_LABELS[status] ?? status}</span>
      <Code>{status}</Code>
    </Badge>
  );
}

function statusTone(status: string): Tone {
  switch (status) {
    case 'ACTIVE':
    case 'ASSIGNED':
      return 'success';
    case 'IN_MAINTENANCE':
      return 'info';
    case 'OUT_OF_SERVICE':
    case 'DECOMMISSIONED':
      return 'danger';
    case 'IDLE':
    case 'REGISTERED':
    default:
      return 'neutral';
  }
}
