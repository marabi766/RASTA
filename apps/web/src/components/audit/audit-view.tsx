'use client';

import type { ReactNode } from 'react';
import { Card, PageHeader } from '../ui/primitives';
import { CapabilityBadge, READINESS_PRESENTATION } from '../capability';
import { AuditEventList } from './audit-list';
import { AuditVerifyPanel } from './audit-verify';

/**
 * Audit evidence — AUD-001 through AUD-003.
 *
 * ## Why this screen says "BETA" rather than "LIVE"
 *
 * Every route below is real and every request goes through the same
 * `GatewayClient` boundary every other screen uses. What has not happened is
 * a run of this exact code against a live `audit-service` — the task that
 * produced this screen was explicitly forbidden from starting, stopping,
 * resetting or reseeding the shared integration stack, so the only
 * end-to-end proof available in this session is the fixture dataset, and the
 * fixture disclosure already says that on every screen. `lib/capabilities.ts`
 * states the same limit in the one place a reviewer would check it, so this
 * notice and the manifest cannot drift apart.
 *
 * ## What is deliberately absent
 *
 * AUD-004 (correction workflow), export, purge, and external anchoring are
 * not stable on `main` and are not represented here — no button, no disabled
 * control hinting at one, no mention beyond this sentence.
 */
export function AuditView(): ReactNode {
  return (
    <>
      <PageHeader
        title="سوابق حسابرسی"
        description="رویداد حسابرسی فقط‌الحاقی، زنجیرهٔ Hash برای مشهودسازی دست‌کاری، و بدون هیچ عملیات نوشتنی."
        actions={<CapabilityBadge state="BETA" />}
      />

      <Card className="mb-6 border-[var(--warn)]">
        <p className="text-sm font-semibold text-[var(--warn-tx)]">
          این صفحه در این نشست در برابر Backend واقعی اجرا نشده است.
        </p>
        <p className="mt-2 text-sm text-[var(--tx2)]">{READINESS_PRESENTATION.NOT_LIVE_VERIFIED}</p>
        <p className="mt-2 text-sm text-[var(--tx2)]">
          AUD-001 تا AUD-003 روی{' '}
          <code className="rasta-code" dir="ltr">
            main
          </code>{' '}
          مرج و در CI همان شاخه تأیید شده‌اند (PR #39، #40، #41). اصلاح رکورد (AUD-004)، خروجی‌گیری،
          حذف قطعی و لنگر خارجی در این نسخه ساخته نشده‌اند و در این صفحه نمایش داده نمی‌شوند.
        </p>
      </Card>

      <AuditEventList />
      <AuditVerifyPanel />
    </>
  );
}
