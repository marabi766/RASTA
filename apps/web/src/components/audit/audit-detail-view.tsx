'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import {
  AUDIT_ACTOR_TYPE_LABELS,
  AUDIT_OUTCOME_LABELS,
  fetchAuditEvent,
  type AuditOutcome,
} from '@/lib/api/adapters/audit';
import { formatJalaliDateTime, isoToUtcInputValue, utcInputValueToIso } from '@/lib/format';
import { useApiResource } from '@/lib/use-api-resource';
import { Badge, Button, Card, PageHeader } from '../ui/primitives';
import { Code, DataView, DescriptionList, Maybe, Section } from '../ui/data-view';

const OUTCOME_TONE: Record<AuditOutcome, 'success' | 'danger' | 'warning'> = {
  SUCCESS: 'success',
  FAILURE: 'danger',
  REFUSED: 'warning',
};

function defaultWindow(): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - 90 * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * `GET /v1/audit-events/{id}` — one record, in full.
 *
 * `from`/`to` are required here too, for the reason `audit.controller.ts`
 * states: `audit_event` is partitioned by `occurredAt`, and a lookup by id
 * alone would scan every partition. The window defaults to the last 90 days
 * so a link followed straight from the list (whose own window this screen
 * does not know) has a reasonable chance of landing inside it; a presenter
 * can widen it if the record sits further back.
 */
export function AuditDetailView({ auditEventId }: { auditEventId: string }): ReactNode {
  const [window_, setWindow] = useState(defaultWindow);

  const resource = useApiResource(
    (client, signal) => fetchAuditEvent(client, auditEventId, window_, {}, signal),
    [auditEventId, window_],
  );

  return (
    <>
      <PageHeader
        title="جزئیات رویداد حسابرسی"
        description={<Code>{auditEventId}</Code>}
        actions={
          <Link
            href="/audit"
            className="inline-flex min-h-[var(--tap)] items-center rounded-[var(--radius-md)] border border-[var(--control-border)] px-4 text-sm text-[var(--tx)]"
          >
            بازگشت به فهرست
          </Link>
        }
      />

      <Card className="mb-6">
        <form
          onSubmit={(event) => event.preventDefault()}
          className="flex flex-wrap items-end gap-3"
        >
          <label className="block text-xs font-semibold text-[var(--tx2)]">
            <span className="mb-1 block">از (UTC)</span>
            <input
              type="datetime-local"
              value={isoToUtcInputValue(window_.from)}
              onChange={(event) =>
                setWindow((current) => ({
                  ...current,
                  from: utcInputValueToIso(event.target.value),
                }))
              }
              className={INPUT_CLASS}
            />
          </label>
          <label className="block text-xs font-semibold text-[var(--tx2)]">
            <span className="mb-1 block">تا (UTC)</span>
            <input
              type="datetime-local"
              value={isoToUtcInputValue(window_.to)}
              onChange={(event) =>
                setWindow((current) => ({ ...current, to: utcInputValueToIso(event.target.value) }))
              }
              className={INPUT_CLASS}
            />
          </label>
          <p className="max-w-sm text-xs text-[var(--tx3)]">
            رکورد بر اساس زمان رخداد افراز شده؛ اگر خطای «یافت نشد» دیدید، بازهٔ بالا را گسترش دهید.
          </p>
        </form>
      </Card>

      <DataView resource={resource} context="رویداد حسابرسی" loadingLabel="در حال خواندن رویداد">
        {(record) => (
          <>
            <div className="grid gap-4 lg:grid-cols-3">
              <Card className="lg:col-span-2">
                <h2 className="text-lg font-bold text-[var(--tx)]">رویداد</h2>
                <DescriptionList
                  items={[
                    { term: 'نام رویداد', value: <Code>{record.action}</Code> },
                    { term: 'رویداد مبدأ', value: <Code>{record.sourceEventName}</Code> },
                    {
                      term: 'نسخهٔ سرویس مبدأ',
                      value: <Maybe value={record.sourceServiceVersion} />,
                    },
                    { term: 'زمان رخداد', value: formatJalaliDateTime(record.occurredAt) },
                    {
                      term: 'زمان ثبت در مخزن شواهد',
                      value: formatJalaliDateTime(record.recordedAt),
                    },
                    {
                      term: 'نتیجه',
                      value: (
                        <Badge tone={OUTCOME_TONE[record.outcome]}>
                          {AUDIT_OUTCOME_LABELS[record.outcome]}
                        </Badge>
                      ),
                    },
                    { term: 'کد خطا', value: <Maybe value={record.errorCode} /> },
                    { term: 'دلیل', value: <Maybe value={record.reason} /> },
                  ]}
                />
              </Card>

              <Card>
                <h2 className="text-sm font-bold text-[var(--tx)]">زنجیرهٔ Hash</h2>
                <div className="mt-3">
                  <Badge tone={record.integrity === 'CHAINED' ? 'info' : 'neutral'}>
                    {record.integrity === 'CHAINED' ? 'دارای پیوند زنجیره' : 'پیش از AUD-003'}
                  </Badge>
                </div>
                <p className="mt-3 text-xs leading-relaxed text-[var(--tx2)]">
                  {record.integrity === 'CHAINED'
                    ? 'این رکورد در زنجیرهٔ Hash ماهانهٔ سازمان خود ثبت شده است. این فیلد فقط می‌گوید رکورد پوشش دارد، نه اینکه بازمحاسبه شده — برای آن از «تأیید زنجیره» در فهرست استفاده کنید.'
                    : 'این رکورد پیش از راه‌اندازی زنجیرهٔ Hash (AUD-003) ثبت شده و هرگز عقب‌نگر تکمیل نمی‌شود؛ بازه‌های شامل آن «غیرقابل‌تأیید» گزارش می‌شوند، نه «نامعتبر».'}
                </p>
                {record.changes !== null ? (
                  <p className="mt-3 rounded-[var(--radius-md)] border border-[var(--bd)] bg-[var(--sunken)] px-3 py-2 text-xs text-[var(--tx2)]">
                    این رکورد دادهٔ تغییرات دارد. این نسخه محتوای خام آن را نمایش نمی‌دهد.
                  </p>
                ) : null}
              </Card>
            </div>

            <Section id="actor-resource" title="عامل و منبع">
              <Card>
                <DescriptionList
                  items={[
                    {
                      term: 'نوع عامل',
                      value: AUDIT_ACTOR_TYPE_LABELS[record.actorType],
                    },
                    { term: 'شناسهٔ عامل', value: <Maybe value={record.actorId} /> },
                    {
                      term: 'سازمان',
                      value: record.organizationId ? (
                        <Code>{record.organizationId}</Code>
                      ) : (
                        <span className="text-[var(--tx3)]">رویداد سطح پلتفرم</span>
                      ),
                    },
                    { term: 'نوع منبع', value: <Code>{record.resourceType}</Code> },
                    { term: 'شناسهٔ منبع', value: <Maybe value={record.resourceId} /> },
                    { term: 'سرویس مبدأ', value: <Code>{record.sourceService}</Code> },
                  ]}
                />
              </Card>
            </Section>

            <Section
              id="correlation"
              title="همبستگی و ردیابی"
              description="شناسه‌هایی که این رکورد را به درخواست و رویدادهای مرتبطش پیوند می‌دهند."
            >
              <Card>
                <DescriptionList
                  items={[
                    { term: 'شناسهٔ همبستگی', value: <Code>{record.correlationId}</Code> },
                    { term: 'شناسهٔ سببیت', value: <Maybe value={record.causationId} /> },
                    { term: 'traceparent', value: <Maybe value={record.traceparent} /> },
                    { term: 'شناسهٔ رویداد مبدأ', value: <Code>{record.sourceEventId}</Code> },
                    { term: 'موضوع Kafka مبدأ', value: <Code>{record.sourceTopic}</Code> },
                    { term: 'شمارهٔ ترتیب (درون‌افرازی)', value: <Code>{record.sequenceNo}</Code> },
                  ]}
                />
              </Card>
            </Section>
          </>
        )}
      </DataView>

      <div className="mt-6">
        <Button variant="secondary" onClick={resource.reload}>
          بارگذاری دوباره
        </Button>
      </div>
    </>
  );
}

const INPUT_CLASS =
  'min-h-[var(--tap)] rounded-[var(--radius-md)] border border-[var(--control-border)] bg-[var(--surf)] px-3 text-sm text-[var(--tx)]';
