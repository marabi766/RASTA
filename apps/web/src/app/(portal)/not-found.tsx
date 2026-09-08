import Link from 'next/link';
import type { ReactNode } from 'react';
import { Card, PageHeader } from '@/components/ui/primitives';

export default function NotFound(): ReactNode {
  return (
    <>
      <PageHeader title="این صفحه وجود ندارد" />
      <Card>
        <p className="text-sm text-[var(--tx2)]">
          نشانی واردشده به هیچ قابلیتی در این نسخه نگاشت نمی‌شود. فهرست کامل قابلیت‌ها و وضعیت
          هرکدام در داشبورد آمده است.
        </p>
        <Link
          href="/"
          className="mt-4 inline-flex min-h-[var(--tap)] items-center rounded-[var(--radius-md)] border border-[var(--control-border)] px-4 text-sm font-semibold text-[var(--tx)]"
        >
          بازگشت به داشبورد
        </Link>
      </Card>
    </>
  );
}
