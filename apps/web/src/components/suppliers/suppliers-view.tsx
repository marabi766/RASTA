'use client';

import { useState, type ReactNode } from 'react';
import {
  CAPABILITY_LABELS,
  SUPPLIER_CAPABILITIES,
  SUPPLIER_STATUS_LABELS,
  searchSuppliers,
  type SupplierCapability,
  type SupplierDirectoryEntry,
} from '@/lib/api/adapters/supplier';
import { formatInteger, formatJalaliDate } from '@/lib/format';
import { useApiResource } from '@/lib/use-api-resource';
import { Badge, Button, Card, PageHeader, cx } from '../ui/primitives';
import { Code, DataTable, DataView, Section } from '../ui/data-view';
import { CapabilityBadge } from '../capability';

/**
 * The supplier directory — Phase 1.
 *
 * ## The distinction this screen is built around
 *
 * A **claimed** capability is a supplier saying what it does. A **qualified**
 * one is an approval that a named operator recorded at a stated time. The two
 * are separate columns, because collapsing them would turn a self-declaration
 * into a platform endorsement.
 *
 * Even the qualified column is narrower than it looks, and the page says so:
 * an approval records that somebody approved a submission. It does not assert
 * that any evidence document was fetched, opened, scanned, or found authentic,
 * current or legally valid — `supplier-service` does not read documents.
 *
 * There is **no score, no star rating and no rating sort**, because no scoring
 * engine exists (Q-12, COM-005 still `IN_PROGRESS`). That absence is the honest
 * state of the domain and is labelled as such rather than hidden.
 */
export function SuppliersView(): ReactNode {
  const [capability, setCapability] = useState<SupplierCapability | undefined>();
  const [qualifiedOnly, setQualifiedOnly] = useState(false);

  const resource = useApiResource(
    (client, signal) =>
      searchSuppliers(
        client,
        qualifiedOnly && capability ? { qualifiedFor: capability } : { capability },
        signal,
      ),
    [capability, qualifiedOnly],
  );

  return (
    <>
      <PageHeader
        title="تأمین‌کنندگان"
        description="فهرست عمومی تأمین‌کنندگان. این خواندن عمداً میان‌سازمانی است: پیدا کردن یک تعمیرگاه در سازمانی دیگر، دلیل وجود این فهرست است."
        actions={<CapabilityBadge state="BETA" />}
      />

      <Card className="mb-6 border-[var(--warn)]">
        <p className="text-sm font-semibold text-[var(--warn-tx)]">
          این دامنه ناقص است و کامل اعلام نمی‌شود.
        </p>
        <p className="mt-2 text-sm text-[var(--tx2)]">
          فاز ۱ — پروفایل، احراز صلاحیت، تعلیق و فهرست — روی <Code>main</Code> است و همین صفحه به
          API واقعی آن وصل است. سنجش عملکرد تأمین‌کننده (فاز ۲) شروع نشده و <Code>COM-005</Code>{' '}
          هنوز <Code>IN_PROGRESS</Code> است. بنابراین هیچ امتیاز، ستاره یا رتبه‌بندی‌ای در این فهرست
          وجود ندارد — نه پنهان‌شده، بلکه اصلاً ساخته نشده.
        </p>
      </Card>

      <Card className="mb-6">
        <fieldset>
          <legend className="mb-2 text-xs font-semibold text-[var(--tx2)]">قابلیت</legend>
          <div className="flex flex-wrap gap-2">
            <Button
              variant={capability === undefined ? 'primary' : 'secondary'}
              onClick={() => {
                setCapability(undefined);
                setQualifiedOnly(false);
              }}
            >
              همه
            </Button>
            {SUPPLIER_CAPABILITIES.map((value) => (
              <Button
                key={value}
                variant={capability === value ? 'primary' : 'secondary'}
                onClick={() => setCapability(value)}
              >
                {CAPABILITY_LABELS[value] ?? value}
              </Button>
            ))}
          </div>

          <label
            className={cx(
              'mt-3 inline-flex min-h-[var(--tap)] items-center gap-2 rounded-[var(--radius-md)] border px-3 text-sm',
              capability
                ? 'cursor-pointer border-[var(--control-border)] text-[var(--tx)]'
                : 'border-[var(--bd)] text-[var(--tx3)]',
            )}
          >
            <input
              type="checkbox"
              checked={qualifiedOnly}
              disabled={!capability}
              onChange={(event) => setQualifiedOnly(event.target.checked)}
              className="size-4 accent-[var(--pri)]"
            />
            فقط دارندگان صلاحیت تأییدشده برای این قابلیت
          </label>

          <p className="mt-2 text-xs text-[var(--tx3)]">
            «صلاحیت تأییدشده» یعنی تأییدی جاری روی تأمین‌کننده‌ای که تعلیق نشده است. این فیلتر پیش
            از صفحه‌بندی اعمال می‌شود، نه بعد از آن.
          </p>
        </fieldset>
      </Card>

      <DataView
        resource={resource}
        context="فهرست تأمین‌کنندگان"
        loadingLabel="در حال خواندن فهرست تأمین‌کنندگان"
        empty={{
          title: 'تأمین‌کننده‌ای با این مشخصات پیدا نشد',
          description: 'ممکن است هنوز تأمین‌کننده‌ای ثبت نشده باشد یا فیلتر نتیجه‌ای نداشته باشد.',
        }}
      >
        {(suppliers) => (
          <DataTable
            rows={suppliers}
            rowKey={(row) => row.id}
            caption={`${formatInteger(suppliers.length)} تأمین‌کننده.`}
            minWidth="52rem"
            columns={[
              {
                key: 'name',
                header: 'تأمین‌کننده',
                render: (row: SupplierDirectoryEntry) => (
                  <>
                    <span dir="auto">{row.displayName}</span>
                    <Code>{row.organizationId}</Code>
                  </>
                ),
              },
              {
                key: 'status',
                header: 'وضعیت',
                render: (row) => (
                  <Badge tone={row.status === 'ACTIVE' ? 'success' : 'danger'}>
                    {SUPPLIER_STATUS_LABELS[row.status] ?? row.status}
                    <Code>{row.status}</Code>
                  </Badge>
                ),
              },
              {
                key: 'claimed',
                header: 'قابلیت‌های اعلامی',
                render: (row) =>
                  row.capabilities.length === 0 ? (
                    <span className="text-[var(--tx3)]">—</span>
                  ) : (
                    <span className="flex flex-wrap gap-1">
                      {row.capabilities.map((value) => (
                        <Badge key={value} tone="neutral">
                          {CAPABILITY_LABELS[value] ?? value}
                        </Badge>
                      ))}
                    </span>
                  ),
              },
              {
                key: 'qualified',
                header: 'صلاحیت تأییدشده',
                render: (row) =>
                  row.qualifiedFor.length === 0 ? (
                    <span
                      className="text-[var(--tx3)]"
                      title="هیچ تأیید جاری‌ای ثبت نشده است. این با «رد شده» یکی نیست."
                    >
                      تأییدی ثبت نشده
                    </span>
                  ) : (
                    <span className="flex flex-wrap gap-1">
                      {row.qualifiedFor.map((value) => (
                        <Badge key={value} tone="success">
                          {CAPABILITY_LABELS[value] ?? value}
                        </Badge>
                      ))}
                    </span>
                  ),
              },
              {
                key: 'registered',
                header: 'ثبت',
                render: (row) => formatJalaliDate(row.registeredAt),
              },
            ]}
          />
        )}
      </DataView>

      <Section id="what-approval-means" title="یک تأیید دقیقاً چه چیزی را می‌گوید">
        <Card>
          <p className="text-sm text-[var(--tx2)]">
            یک تأیید ثبت می‌کند که اپراتوری با نام مشخص، در زمانی مشخص، یک درخواست را تأیید کرده
            است. این ادعا نمی‌کند که مدرکی دریافت، باز، اسکن یا از نظر اصالت، اعتبار زمانی و اعتبار
            حقوقی راستی‌آزمایی شده باشد — سرویس تأمین‌کننده اصلاً سند نمی‌خواند. نمایش چیزی بیش از
            این، تبدیل یک ثبت اداری به یک تأیید حرفه‌ای است.
          </p>
        </Card>
      </Section>
    </>
  );
}
