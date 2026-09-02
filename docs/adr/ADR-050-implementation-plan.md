# ADR-050 — طرح اجرا (Phase B)

> پیوست [ADR-050](ADR-050-outbox-durable-claim.md). **هیچ‌چیز از این سند اجرا
> نشده است.** Phase A فقط طراحی و شواهد بود.

## دامنه — دقیقاً چه چیزی لمس می‌شود

### هشت پایگاه داده

هر سرویس پایگاه داده خودش را دارد (A-01)، پس هشت Migration مستقل — نه یکی.

| سرویس                  | پایگاه داده          | Migration |
| ---------------------- | -------------------- | --------- |
| `identity-service`     | `rasta_identity`     | ✅ لازم   |
| `organization-service` | `rasta_organization` | ✅ لازم   |
| `asset-service`        | `rasta_asset`        | ✅ لازم   |
| `fleet-service`        | `rasta_fleet`        | ✅ لازم   |
| `maintenance-service`  | `rasta_maintenance`  | ✅ لازم   |
| `economic-service`     | `rasta_economic`     | ✅ لازم   |
| `marketplace-service`  | `rasta_marketplace`  | ✅ لازم   |
| `document-service`     | `rasta_document`     | ✅ لازم   |

### فایل‌ها

**مشترک (`packages/`):**

- `packages/nest-common/src/outbox/outbox.ts` — قرارداد `OutboxStore`
  (`claimPending` امضای تازه، `markPublished` مقدار برگشتی)، `OutboxRelay`
  (بررسی انقضا پیش از Publish، شمارش Conflict)، و **حذف ادعای نادرست** در
  Docstring خط ۱۳۹.
- `packages/observability/src/…` — سه Metric تازه.
- `packages/config/src/env.ts` — `OUTBOX_CLAIM_LEASE_SECONDS` در
  `kafkaEnvSchema`.

**به‌ازای هر یک از هشت سرویس:**

- `services/<s>/prisma/schema.prisma` — سه ستون و دو Index.
- `services/<s>/prisma/migrations/<ts>_outbox_durable_claim/migration.sql`
- `services/<s>/src/outbox/outbox.store.ts` — `claimPending` و
  `markPublished` و `markFailed`، و **اصلاح Docstring** خطوط ۹–۱۱.

**مستندات:**

- `docs/adr/ADR-021-outbox-pattern.md` — ارجاع به ADR-050.
- `docs/07-event-architecture.md`
- `docs/runbooks/outbox-stuck.md` — خط ۱۲۶ ادعای نادرست دارد.
- `docs/runbooks/malware-scanner-down.md` — خط ۱۳۹ دربارهٔ **Scan** است و
  درست است (آنجا Lease هست)؛ فقط بازبینی لازم دارد، نه اصلاح.

### آیا Store مشترک شود؟

**بله، اما نه در این ADR.** هشت `outbox.store.ts` امروز تقریباً یکسان‌اند و
هشت‌بار تغییر دادنشان همان بدهی‌ای است که PROJECT_MEMORY § ۲۲ برای
`openapi/zod-schema.ts` ثبت کرده. یک Helper خالص زیر
`packages/nest-common/src/outbox/` که SQL را می‌سازد و `PrismaClient` را
به‌عنوان پارامتر می‌گیرد، A-03 را نقض نمی‌کند: هیچ منطق دامنه‌ای ندارد و هیچ
سرویسی به پایگاه دادهٔ دیگری دست نمی‌زند — هر سرویس Client خودش را می‌دهد.

اما استخراج + تغییر رفتار در یک PR یعنی Diffای که نه قابل بازبینی است و نه
قابل Revert. پس: **Commit ۱ فقط استخراج بدون تغییر رفتار**، و بقیه روی همان
Helper.

## توالی Commit

هر Commit به‌تنهایی سبز است و به‌تنهایی قابل Revert.

| #   | Commit                                                            | چه چیزی                                                                     | Revert |
| --- | ----------------------------------------------------------------- | --------------------------------------------------------------------------- | ------ |
| ۱   | `refactor(outbox): extract the shared store SQL into nest-common` | استخراج خالص، بدون تغییر رفتار. هشت Store به Helper مشترک می‌رسند.          | امن    |
| ۲   | `docs(outbox): correct the SKIP LOCKED claim in every store`      | فقط Comment — هشت Docstring، قرارداد `OutboxStore`، دو Runbook.             | امن    |
| ۳   | `feat(db): add nullable outbox claim columns to all eight`        | فقط Migration. سه ستون Nullable + دو Index. **هیچ کدی آن‌ها را نمی‌خواند.** | امن    |
| ۴   | `feat(config): add OUTBOX_CLAIM_LEASE_SECONDS`                    | پیکربندی با پیش‌فرض ۳۰. هنوز مصرف‌کننده ندارد.                              | امن    |
| ۵   | `feat(outbox): claim rows with a durable lease`                   | `claimPending` به `UPDATE … RETURNING` تبدیل می‌شود. **نقطهٔ تغییر رفتار.** | ⚠️     |
| ۶   | `feat(outbox): make markPublished conditional on the lease`       | Mark مشروط + مقدار برگشتی + شمارش Conflict.                                 | ⚠️     |
| ۷   | `feat(observability): expose the three claim metrics`             | Metric و Alert.                                                             | امن    |
| ۸   | `test(outbox): the deterministic lease suite`                     | یازده آزمون بخش بعد.                                                        | امن    |
| ۹   | `docs: mark D-026 resolved and ADR-050 Accepted`                  | فقط پس از سبزشدن ۸.                                                         | امن    |

Commit ۳ باید **پیش از** ۵ روی همه محیط‌ها مستقر شود. این تنها ترتیب اجباری است.

## مراحل Migration

```sql
-- forward
ALTER TABLE outbox_message ADD COLUMN claim_owner      TEXT;
ALTER TABLE outbox_message ADD COLUMN claim_expires_at TIMESTAMP(3);
ALTER TABLE outbox_message ADD COLUMN claim_count      INTEGER NOT NULL DEFAULT 0;

CREATE INDEX ix_outbox_claimable
    ON outbox_message (created_at, id)
 WHERE published_at IS NULL;

CREATE INDEX ix_outbox_claim_expiry
    ON outbox_message (claim_expires_at)
 WHERE published_at IS NULL AND claim_expires_at IS NOT NULL;
```

`ix_outbox_pending` موجود روی `(published_at, created_at)` می‌ماند —
`pendingCount()` از آن استفاده می‌کند.

**Index جزئی** انتخاب شد چون ردیف منتشرشده هرگز Claim نمی‌شود و نگه‌داشتنش در
Index فقط هزینهٔ نوشتن است. `purgePublished` هم آن‌ها را پاک می‌کند.

```sql
-- backward
DROP INDEX IF EXISTS ix_outbox_claim_expiry;
DROP INDEX IF EXISTS ix_outbox_claimable;
ALTER TABLE outbox_message DROP COLUMN IF EXISTS claim_count;
ALTER TABLE outbox_message DROP COLUMN IF EXISTS claim_expires_at;
ALTER TABLE outbox_message DROP COLUMN IF EXISTS claim_owner;
```

`pnpm test:migration` (up → down → up) روی هر هشت باید سبز باشد.

**`ADD COLUMN` با `DEFAULT 0` روی PostgreSQL ۱۱+ جدول را بازنویسی نمی‌کند**،
پس روی Outbox بزرگ هم قفل طولانی نمی‌گیرد. `CREATE INDEX` باید
`CONCURRENTLY` باشد اگر جدول در Production بزرگ است — که Prisma Migrate
مستقیم پشتیبانی نمی‌کند و نیازمند SQL دستی در Migration است. **این نکته باید
پیش از اجرا تصمیم‌گیری شود.**

## رفتار در Rolling Deployment

| مرحله | نسخه‌های فعال      | رفتار                                                      | G1        |
| ----- | ------------------ | ---------------------------------------------------------- | --------- |
| ۰     | فقط قدیم           | امروز — Claim تکراری ممکن                                  | ❌        |
| ۱     | قدیم (Migration ۳) | ستون‌ها هستند، کسی نمی‌خواندشان                            | ❌        |
| ۲     | قدیم + جدید        | قدیم Lease را نادیده می‌گیرد؛ جدید Leaseدارها را رد می‌کند | ❌ موقتاً |
| ۳     | فقط جدید           | Lease برقرار                                               | ✅        |

مرحلهٔ ۲ بدتر از مرحلهٔ ۰ **نیست** — همان رفتار امروز است. اما G1 در طول
Rollout برقرار نیست و این باید پذیرفته شود، نه کشف.

## بازیابی پس از Clock Skew یا مرگ پروسه

- **مرگ پروسه:** Lease منقضی می‌شود و ردیف پس از حداکثر
  `OUTBOX_CLAIM_LEASE_SECONDS` دوباره Claimشدنی است.
- **Clock skew:** `now()` **همیشه ساعت پایگاه داده** است، نه ساعت برنامه.
  همهٔ مقایسه‌ها در SQL انجام می‌شوند، پس Skew میان Replicaها بی‌اثر است.
  این یک الزام است، نه یک جزئیات: هر مقایسهٔ زمانی که به `Date.now()` جاوااسکریپت
  برسد، Skew را وارد می‌کند.
- **Restart:** `claim_owner` تازه ساخته می‌شود، پس پروسهٔ جدید Leaseهای قدیمی
  خودش را هم نمی‌تواند Ack کند — که درست است، چون نمی‌داند آن‌ها منتشر شده‌اند
  یا نه.

## تعامل با Cleanup

`purgePublished(retentionDays)` فقط `published_at IS NOT NULL AND < cutoff` را
حذف می‌کند و **بدون تغییر می‌ماند**. یک ردیف Claimشده هرگز `published_at`
ندارد، پس هرگز پاک نمی‌شود — که درست است.

## آزمون‌های الزامی فاز اجرا

همه قطعی؛ بدون Sleep، بدون Timing، بدون `runInBand`.

| #   | آزمون                                      | چگونه قطعی می‌شود                                                                            |
| --- | ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| ۱   | دو Replica، Batchهای مجزا                  | دو Store مستقل، Claim پیاپی؛ اشتراک باید **۰** باشد                                          |
| ۲   | انقضای Lease و Claim مجدد                  | Lease با `leaseSeconds = 0` تنظیم می‌شود، نه با انتظار                                       |
| ۳   | A نمی‌تواند Lease B را Ack کند             | A Claim می‌کند، Lease دستی به B داده می‌شود، `markPublished` توسط A باید **۰ ردیف** برگرداند |
| ۴   | Publish موفق + Mark ناموفق → At-Least-Once | Mark با خطا Mock می‌شود؛ ردیف باید دوباره Claimشدنی باشد                                     |
| ۵   | ردیف مسموم → آزادسازی Lease                | `markFailed` باید `claim_owner` را `NULL` کند و `attempts` را ببرد بالا                      |
| ۶   | کران Batch                                 | با Backlog بزرگ‌تر از `limit`، دقیقاً `limit` ردیف                                           |
| ۷   | ترتیب قطعی در برابری `created_at`          | ده ردیف با `created_at` **یکسان**؛ دو Claim پیاپی باید همان ترتیب را بدهند                   |
| ۸   | Restart پروسه                              | Owner تازه؛ ردیف‌های Lease‌دار قبلی پس از انقضا Claimشدنی                                    |
| ۹   | بدون فیلتر تنانت                           | ردیف دو سازمان؛ هر دو باید Claim شوند                                                        |
| ۱۰  | نبودِ گم‌شدن رویداد                        | N ردیف، Claim و Publish و Mark تا خالی‌شدن؛ مجموع منتشرشده باید دقیقاً N باشد                |
| ۱۱  | مصرف‌کنندهٔ ایدمپوتنت با تکرار             | همان رویداد دوبار؛ اثر تجاری باید یک‌بار باشد                                                |

آزمون ۷ نکتهٔ ظریفی دارد: چون `id` درون یک میلی‌ثانیه تصادفی است، آزمون باید
**پایداری** ترتیب را بسنجد (دو Claim یکسان)، نه انطباقش با ترتیب درج.

## ماتریس ریسک و Rollback

| ریسک                                     | احتمال | اثر                                        | کاهش                                                      | Rollback                       |
| ---------------------------------------- | ------ | ------------------------------------------ | --------------------------------------------------------- | ------------------------------ |
| Lease کوتاه‌تر از زمان Publish           | متوسط  | انتشار تکراری — همان امروز                 | پیش‌فرض ۳۰ ثانیه؛ `claim_conflict_total` Alert می‌دهد     | افزایش متغیر، بدون Deploy      |
| Lease بلند + مرگ پروسه                   | پایین  | تأخیر تا ۳۰ ثانیه در انتشار                | `oldest_pending_age_seconds` موجود این را می‌بیند         | کاهش متغیر                     |
| `UPDATE` روی هر Poll، بار WAL            | متوسط  | نوشتن بیشتر روی Outbox داغ                 | زیرپرسش خالی → صفر ردیف؛ سنجش پیش از Rollout سراسری       | Revert Commit ۵                |
| `CREATE INDEX` قفل‌کننده روی جدول بزرگ   | پایین  | وقفهٔ کوتاه در نوشتن                       | `CONCURRENTLY` اگر لازم شد — پیش از اجرا تصمیم‌گیری شود   | `DROP INDEX`                   |
| Rollback پس از Commit ۵ با Leaseهای زنده | پایین  | نسخهٔ قدیم `claim_*` را نادیده می‌گیرد     | بی‌خطر: قدیم فقط `published_at` را می‌بیند                | Revert کد، ستون‌ها بمانند      |
| Revert Migration با کد جدید فعال         | پایین  | `claimPending` روی ستون ناموجود خطا می‌دهد | **ترتیب اجباری: کد قبل از Schema برگردد**                 | ابتدا Revert کد، سپس Migration |
| هشت Migration، یکی جا بماند              | متوسط  | آن سرویس روی مسیر قدیم می‌ماند             | `pnpm db:migrate` همه را می‌زند؛ Checklist هشت‌تایی در PR | همان سرویس جدا Revert شود      |

**محدودیت Rollback که باید صریح بماند:** پس از Commit ۵، ردیفی که Claim شده و
هنوز Mark نشده، با برگشت به نسخهٔ قدیم **بلافاصله** دوباره Claimشدنی می‌شود —
یعنی برگشت خودش می‌تواند یک انتشار تکراری بسازد. این پذیرفتنی است (At-Least-Once
از قبل فرض است) اما باید در Runbook نوشته شود.

## Observability

- سه Metric تازه (ADR-050).
- `docs/runbooks/outbox-stuck.md` باید بخش تازه بگیرد: «Claimشده اما
  منتشرنشده» چه شکلی است و چه فرقی با «اصلاً Claim نشده» دارد.
