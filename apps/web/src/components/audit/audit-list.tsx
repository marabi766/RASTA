'use client';

import Link from 'next/link';
import { useState, type FormEvent, type ReactNode } from 'react';
import {
  AUDIT_ACTOR_TYPES,
  AUDIT_ACTOR_TYPE_LABELS,
  AUDIT_OUTCOMES,
  AUDIT_OUTCOME_LABELS,
  searchAuditEvents,
  type AuditActorType,
  type AuditEventView,
  type AuditOutcome,
} from '@/lib/api/adapters/audit';
import {
  formatInteger,
  formatJalaliDateTime,
  isoToUtcInputValue,
  utcInputValueToIso,
} from '@/lib/format';
import { useApiResource } from '@/lib/use-api-resource';
import { Badge, Button, Card, EmptyState, cx } from '../ui/primitives';
import { Code, DataTable, DataView, Section } from '../ui/data-view';

interface AuditFilters {
  readonly from: string;
  readonly to: string;
  readonly organizationId: string;
  readonly actorId: string;
  readonly actorType: AuditActorType | '';
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly correlationId: string;
  readonly outcome: AuditOutcome | '';
}

function defaultWindow(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

function defaultFilters(): AuditFilters {
  const window = defaultWindow();
  return {
    from: window.from,
    to: window.to,
    organizationId: '',
    actorId: '',
    actorType: '',
    action: '',
    resourceType: '',
    resourceId: '',
    correlationId: '',
    outcome: '',
  };
}

const OUTCOME_TONE: Record<AuditOutcome, 'success' | 'danger' | 'warning'> = {
  SUCCESS: 'success',
  FAILURE: 'danger',
  REFUSED: 'warning',
};

/**
 * `GET /v1/audit-events` — search within a mandatory window.
 *
 * `from`/`to` are required by the service (`audit_event` is partitioned by
 * `occurredAt`, and an unbounded window would scan every partition), so this
 * form cannot be submitted without them — there is no "clear dates" control,
 * only "reset to the last 24 hours".
 *
 * The cursor in `nextCursor` is carried forward exactly as the service
 * published it and never inspected: `loadMore` appends it to the next
 * request's `cursor` field and nothing else in this component looks inside it.
 */
export function AuditEventList(): ReactNode {
  const [filters, setFilters] = useState<AuditFilters>(defaultFilters);
  const [draft, setDraft] = useState<AuditFilters>(filters);
  const [items, setItems] = useState<readonly AuditEventView[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);

  const resource = useApiResource(
    (client, signal) =>
      searchAuditEvents(
        client,
        { from: filters.from, to: filters.to },
        {
          organizationId: filters.organizationId.trim() || undefined,
          actorId: filters.actorId.trim() || undefined,
          actorType: filters.actorType || undefined,
          action: filters.action.trim() || undefined,
          resourceType: filters.resourceType.trim() || undefined,
          resourceId: filters.resourceId.trim() || undefined,
          correlationId: filters.correlationId.trim() || undefined,
          outcome: filters.outcome || undefined,
          cursor,
        },
        signal,
      ).then((page) => {
        setItems((current) => (cursor ? [...current, ...page.items] : page.items));
        return page;
      }),
    [filters, cursor],
  );

  const onSubmit = (event: FormEvent): void => {
    event.preventDefault();
    setCursor(undefined);
    setItems([]);
    setFilters(draft);
  };

  const onReset = (): void => {
    const next = defaultFilters();
    setDraft(next);
    setCursor(undefined);
    setItems([]);
    setFilters(next);
  };

  return (
    <Section
      id="audit-list"
      title="فهرست رویدادهای حسابرسی"
      description="بازهٔ زمانی اجباری است. پیمایش صفحه‌ها با همان نشانگر مات (Cursor) که سرویس منتشر می‌کند انجام می‌شود؛ این برنامه هیچ مقدار داخل آن را نمی‌خواند."
    >
      <Card className="mb-4">
        <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="از (UTC) *">
            <input
              type="datetime-local"
              required
              value={isoToUtcInputValue(draft.from)}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  from: utcInputValueToIso(event.target.value),
                }))
              }
              className={INPUT_CLASS}
            />
          </Field>
          <Field label="تا (UTC) *">
            <input
              type="datetime-local"
              required
              value={isoToUtcInputValue(draft.to)}
              onChange={(event) =>
                setDraft((current) => ({ ...current, to: utcInputValueToIso(event.target.value) }))
              }
              className={INPUT_CLASS}
            />
          </Field>
          <Field label="شناسهٔ سازمان">
            <input
              value={draft.organizationId}
              onChange={(event) =>
                setDraft((current) => ({ ...current, organizationId: event.target.value }))
              }
              placeholder="خالی = بر اساس دامنهٔ نقش"
              className={INPUT_CLASS}
            />
          </Field>
          <Field label="نام رویداد (action)">
            <input
              value={draft.action}
              onChange={(event) =>
                setDraft((current) => ({ ...current, action: event.target.value }))
              }
              placeholder="مثلاً asset.asset_registered"
              className={INPUT_CLASS}
            />
          </Field>
          <Field label="شناسهٔ عامل (actorId)">
            <input
              value={draft.actorId}
              onChange={(event) =>
                setDraft((current) => ({ ...current, actorId: event.target.value }))
              }
              className={INPUT_CLASS}
            />
          </Field>
          <Field label="نوع عامل">
            <select
              value={draft.actorType}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  actorType: event.target.value as AuditActorType | '',
                }))
              }
              className={INPUT_CLASS}
            >
              <option value="">همه</option>
              {AUDIT_ACTOR_TYPES.map((value) => (
                <option key={value} value={value}>
                  {AUDIT_ACTOR_TYPE_LABELS[value]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="نتیجه">
            <select
              value={draft.outcome}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  outcome: event.target.value as AuditOutcome | '',
                }))
              }
              className={INPUT_CLASS}
            >
              <option value="">همه</option>
              {AUDIT_OUTCOMES.map((value) => (
                <option key={value} value={value}>
                  {AUDIT_OUTCOME_LABELS[value]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="شناسهٔ همبستگی (correlationId)">
            <input
              value={draft.correlationId}
              onChange={(event) =>
                setDraft((current) => ({ ...current, correlationId: event.target.value }))
              }
              className={INPUT_CLASS}
            />
          </Field>
          <Field label="نوع منبع (resourceType)">
            <input
              value={draft.resourceType}
              onChange={(event) =>
                setDraft((current) => ({ ...current, resourceType: event.target.value }))
              }
              placeholder="مثلاً Asset"
              className={INPUT_CLASS}
            />
          </Field>
          <Field label="شناسهٔ منبع (resourceId)">
            <input
              value={draft.resourceId}
              disabled={draft.resourceType.trim() === ''}
              onChange={(event) =>
                setDraft((current) => ({ ...current, resourceId: event.target.value }))
              }
              title={
                draft.resourceType.trim() === ''
                  ? 'این فیلتر فقط همراه با «نوع منبع» قابل استفاده است'
                  : undefined
              }
              className={INPUT_CLASS}
            />
          </Field>

          <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-4">
            <Button type="submit">جست‌وجو</Button>
            <Button type="button" variant="secondary" onClick={onReset}>
              بازگشت به ۲۴ ساعت اخیر
            </Button>
          </div>
        </form>
      </Card>

      <DataView
        resource={resource}
        context="فهرست رویدادهای حسابرسی"
        loadingLabel="در حال خواندن رویدادهای حسابرسی"
      >
        {(page) =>
          items.length === 0 ? (
            // `DataView`'s own empty check only fires for an array resource;
            // this one exposes the full `{ items, nextCursor, hasMore }` page
            // so the "page بعد" button can reach `hasMore`, so the empty
            // state is rendered here instead of through that shortcut.
            <EmptyState
              title="رویدادی در این بازه یافت نشد"
              description="بازهٔ زمانی یا فیلترها را تغییر دهید."
            />
          ) : (
            <>
              <DataTable
                rows={items}
                rowKey={(row) => row.id}
                caption={`${formatInteger(items.length)} رویداد.`}
                minWidth="56rem"
                columns={[
                  {
                    key: 'occurredAt',
                    header: 'زمان رخداد',
                    render: (row) => (
                      <Link
                        href={`/audit/${encodeURIComponent(row.id)}`}
                        className="hover:underline"
                      >
                        {formatJalaliDateTime(row.occurredAt)}
                      </Link>
                    ),
                  },
                  { key: 'action', header: 'رویداد', render: (row) => <Code>{row.action}</Code> },
                  {
                    key: 'resource',
                    header: 'منبع',
                    render: (row) => (
                      <>
                        <Code>{row.resourceType}</Code>
                        {row.resourceId ? (
                          <span className="ms-1 text-[var(--tx3)]">{row.resourceId}</span>
                        ) : null}
                      </>
                    ),
                  },
                  {
                    key: 'actor',
                    header: 'عامل',
                    render: (row) => (
                      <>
                        {AUDIT_ACTOR_TYPE_LABELS[row.actorType]}
                        {row.actorId ? (
                          <span className="ms-1 text-[var(--tx3)]">{row.actorId}</span>
                        ) : null}
                      </>
                    ),
                  },
                  {
                    key: 'outcome',
                    header: 'نتیجه',
                    render: (row) => (
                      <Badge tone={OUTCOME_TONE[row.outcome]}>
                        {AUDIT_OUTCOME_LABELS[row.outcome]}
                      </Badge>
                    ),
                  },
                  {
                    key: 'integrity',
                    header: 'زنجیرهٔ Hash',
                    render: (row) => (
                      <Badge tone={row.integrity === 'CHAINED' ? 'info' : 'neutral'}>
                        {row.integrity === 'CHAINED' ? 'دارای زنجیره' : 'پیش از AUD-003'}
                      </Badge>
                    ),
                  },
                ]}
              />

              {page.hasMore ? (
                <div className="mt-4 flex justify-center">
                  <Button
                    variant="secondary"
                    onClick={() => {
                      if (page.nextCursor) setCursor(page.nextCursor);
                    }}
                  >
                    صفحهٔ بعد
                  </Button>
                </div>
              ) : null}
            </>
          )
        }
      </DataView>
    </Section>
  );
}

const INPUT_CLASS =
  'min-h-[var(--tap)] w-full rounded-[var(--radius-md)] border border-[var(--control-border)] bg-[var(--surf)] px-3 text-sm text-[var(--tx)]';

function Field({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <label className={cx('block text-xs font-semibold text-[var(--tx2)]')}>
      <span className="mb-1 block">{label}</span>
      {children}
    </label>
  );
}
