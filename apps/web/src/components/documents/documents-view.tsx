'use client';

import type { ReactNode } from 'react';
import {
  DOCUMENT_CLASS_LABELS,
  SCAN_STATE_PRESENTATION,
  listDocuments,
  type DocumentView as DocumentRow,
} from '@/lib/api/adapters/document';
import { formatInteger, formatJalaliDate } from '@/lib/format';
import { useApiResource } from '@/lib/use-api-resource';
import { Badge, Card, PageHeader, type Tone } from '../ui/primitives';
import { Code, DataTable, DataView, Maybe, Section } from '../ui/data-view';
import { DocumentScenarioGate } from './document-scenario-gate';

/**
 * Document metadata, and what each scan verdict actually means.
 *
 * ## Why the scan column has four different "not clean" states
 *
 * `PENDING` and `NOT_SCANNED` look interchangeable and are not: one is a scan
 * that has not finished, the other is a document no engine ever looked at.
 * `FAILED` is a third thing again — an engine that ran and could not reach a
 * conclusion. All three refuse a download, for different reasons, and
 * flattening them into "unknown" throws away the only information an operator
 * could act on.
 *
 * The policy behind all of it is fail-closed: only `CLEAN` is ever handed over,
 * and no environment variable changes that (ADR-049).
 *
 * ## Why there is no download button and no upload form
 *
 * Both are real endpoints. Neither is shown, and the reasons are stated on the
 * page rather than left as a gap: a download button that correctly fails on
 * every `PENDING` row teaches an audience the wrong thing about a working
 * control, and an upload writes to shared storage and a shared database, which
 * this session must not do.
 */
export function DocumentsView(): ReactNode {
  const resource = useApiResource((client, signal) => listDocuments(client, signal), []);

  return (
    <>
      <PageHeader
        title="اسناد"
        description="فراداده اسناد سازمان فعال. کلید ذخیره‌سازی، نام سطل و هیچ نشانی دانلودی هرگز از مرز API عبور نمی‌کند."
      />

      <DocumentScenarioGate onApplied={resource.reload} />

      <DataView
        resource={resource}
        context="فهرست اسناد"
        loadingLabel="در حال خواندن فهرست اسناد"
        empty={{
          title: 'سندی ثبت نشده است',
          description: 'اسناد پس از آپلود مستقیم به فضای ذخیره‌سازی، در این فهرست ثبت می‌شوند.',
        }}
      >
        {(documents) => (
          <DataTable
            rows={documents}
            rowKey={(row) => row.id}
            caption={`${formatInteger(documents.length)} سند. تنها وضعیت «پاک» اجازهٔ دانلود می‌دهد.`}
            minWidth="56rem"
            columns={[
              {
                key: 'filename',
                header: 'فایل',
                render: (row: DocumentRow) => (
                  <>
                    <span dir="auto">{row.filename}</span>
                    <Code>{row.id}</Code>
                  </>
                ),
              },
              {
                key: 'class',
                header: 'دسته',
                render: (row) => DOCUMENT_CLASS_LABELS[row.documentClass] ?? row.documentClass,
              },
              {
                key: 'scan',
                header: 'وضعیت اسکن بدافزار',
                render: (row) => {
                  const presentation = SCAN_STATE_PRESENTATION[row.scanState];

                  return (
                    <>
                      <Badge tone={scanTone(row.scanState)} title={presentation.meaning}>
                        {presentation.label}
                        <Code>{row.scanState}</Code>
                      </Badge>
                      <span className="mt-1 block max-w-sm text-xs text-[var(--tx2)]">
                        {presentation.meaning}
                      </span>
                    </>
                  );
                },
              },
              {
                key: 'engine',
                header: 'موتور و امضا',
                render: (row) => (
                  <>
                    <Maybe value={row.scanEngine ? <Code>{row.scanEngine}</Code> : null} />
                    {row.scanSignatureVersion ? (
                      <span className="mt-0.5 block text-xs text-[var(--tx3)]">
                        نسخهٔ پایگاه امضا: <Code>{row.scanSignatureVersion}</Code>
                      </span>
                    ) : null}
                    {row.scanSignature ? (
                      <span className="mt-0.5 block text-xs text-[var(--dgr-tx)]">
                        امضای شناسایی‌شده: <Code>{row.scanSignature}</Code>
                      </span>
                    ) : null}
                  </>
                ),
              },
              {
                key: 'downloadable',
                header: 'قابل دانلود',
                render: (row) =>
                  SCAN_STATE_PRESENTATION[row.scanState].downloadable ? (
                    <Badge tone="success">بله</Badge>
                  ) : (
                    <Badge tone="warning">خیر</Badge>
                  ),
              },
              {
                key: 'created',
                header: 'ثبت',
                render: (row) => formatJalaliDate(row.createdAt),
              },
            ]}
          />
        )}
      </DataView>

      <Section id="policy" title="سیاست دانلود و آپلود در این نسخه">
        <Card>
          <ul className="space-y-3 text-sm text-[var(--tx2)]">
            <li>
              <span className="font-semibold text-[var(--tx)]">دانلود در این نسخه فعال نیست.</span>{' '}
              مسیر واقعی آن <Code>POST /v1/documents/{'{id}'}/download-url</Code> است که یک
              اعتبارنامهٔ امضاشده صادر می‌کند، نه یک خواندن ساده. سیاست Fail-Closed است: هر سندی جز
              «پاک» با <Code>422</Code> رد می‌شود، و چون هر سند تازه در وضعیت «در انتظار بررسی» ثبت
              می‌شود، دکمه‌ای که تقریباً همیشه به‌درستی شکست می‌خورد، تصویر نادرستی از یک کنترلِ
              سالم می‌دهد.
            </li>
            <li>
              <span className="font-semibold text-[var(--tx)]">
                آپلود در این نشست انجام نمی‌شود.
              </span>{' '}
              جریان واقعی، آپلود مستقیم کلاینت به فضای ذخیره‌سازی است — فایل هرگز از سرویس عبور
              نمی‌کند — اما نوشتن در سطل و پایگاه دادهٔ مشترک، تغییر زیرساخت مشترک است و این نشست
              چنین کاری نمی‌کند.
            </li>
            <li>
              <span className="font-semibold text-[var(--tx)]">
                نوع فایل از روی بایت‌ها بررسی می‌شود
              </span>{' '}
              نه از روی ادعای کلاینت؛ فایل HTML که با ادعای PDF فرستاده شود رد می‌شود.
            </li>
          </ul>
        </Card>
      </Section>
    </>
  );
}

function scanTone(state: DocumentRow['scanState']): Tone {
  switch (state) {
    case 'CLEAN':
      return 'success';
    case 'INFECTED':
      return 'danger';
    case 'FAILED':
      return 'danger';
    case 'PENDING':
      return 'warning';
    case 'NOT_SCANNED':
    default:
      return 'neutral';
  }
}
