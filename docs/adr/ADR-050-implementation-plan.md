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
  (`claimPending` با Token برگشتی، `markPublished`/`markFailed`/`release`/
  `renew` همه با پارامتر Token و مقدار برگشتیِ «چند ردیف»)، `OutboxRelay`
  (Heartbeat تمدید، توقف روی ازدست‌رفتن مالکیت)، و **حذف ادعای نادرست** در
  Docstring خط ۱۳۹.
- `packages/observability/src/…` — پنج Metric بخش پایین.
- `packages/config/src/env.ts` — سه متغیر تازه در `kafkaEnvSchema`.

**به‌ازای هر یک از هشت سرویس:**

- `services/<s>/prisma/schema.prisma`
- `services/<s>/prisma/migrations/<ts>_outbox_durable_claim/migration.sql`
- `services/<s>/src/outbox/outbox.store.ts` — و **اصلاح Docstring** خطوط ۹–۱۱.

**مستندات:** `docs/adr/ADR-021-outbox-pattern.md`،
`docs/07-event-architecture.md`، `docs/runbooks/outbox-stuck.md` (خط ۱۲۶ ادعای
نادرست دارد). `docs/runbooks/malware-scanner-down.md` خط ۱۳۹ دربارهٔ **Scan**
است و درست است — بازبینی لازم دارد، نه اصلاح.

### آیا Store مشترک شود؟

**بله، اما به‌عنوان Commit اول و بدون تغییر رفتار.** هشت `outbox.store.ts`
تقریباً یکسان‌اند. یک Helper خالص زیر `packages/nest-common/src/outbox/` که SQL
را می‌سازد و `PrismaClient` را پارامتر می‌گیرد، A-01 و A-03 را نقض نمی‌کند: نه
منطق دامنه دارد، نه سرویسی به پایگاه دادهٔ دیگری دست می‌زند.

## توالی Commit

| #   | Commit                                                            | چه چیزی                                                             | Revert |
| --- | ----------------------------------------------------------------- | ------------------------------------------------------------------- | ------ |
| ۱   | `refactor(outbox): extract the shared store SQL into nest-common` | استخراج خالص، بدون تغییر رفتار                                      | امن    |
| ۲   | `docs(outbox): correct the SKIP LOCKED claim in every store`      | فقط Comment — هشت Docstring، قرارداد، یک Runbook                    | امن    |
| ۳   | `feat(db): add nullable outbox claim columns to all eight`        | Migration: پنج ستون، سه Index، سه CHECK. **هیچ کدی نمی‌خواندشان.**  | امن    |
| ۴   | `feat(config): add the three outbox claim variables`              | پیکربندی با کران‌های صحیح. بدون مصرف‌کننده.                         | امن    |
| ۵   | `feat(outbox): claim rows with a fencing token`                   | `claimPending` → `UPDATE … RETURNING claim_token`. **تغییر رفتار.** | ⚠️     |
| ۶   | `feat(outbox): fence every mutation on the claim token`           | Ack/Fail/Release/Renew مشروط بر Token، با مقدار برگشتی              | ⚠️     |
| ۷   | `feat(outbox): renew the lease while a batch is in flight`        | Heartbeat + توقف روی ازدست‌رفتن مالکیت                              | ⚠️     |
| ۸   | `feat(outbox): schedule retries with next_attempt_at`             | Backoff نمایی سقف‌دار با ساعت پایگاه داده                           | ⚠️     |
| ۹   | `feat(observability): expose the five claim metrics`              | Metric و Alert                                                      | امن    |
| ۱۰  | `test(outbox): the deterministic fencing and lease suite`         | چهارده آزمون بخش پایین                                              | امن    |
| ۱۱  | `docs: mark D-026 resolved and ADR-050 Accepted`                  | فقط پس از سبزشدن ۱۰                                                 | امن    |

Commit ۳ باید **پیش از** ۵ روی همه محیط‌ها مستقر شود. تنها ترتیب اجباری همین است.

## Migration

```sql
-- forward
ALTER TABLE outbox_message ADD COLUMN claim_token      TEXT;
ALTER TABLE outbox_message ADD COLUMN claim_owner      TEXT;
ALTER TABLE outbox_message ADD COLUMN claim_expires_at TIMESTAMP(3);
ALTER TABLE outbox_message ADD COLUMN claim_count      INTEGER   NOT NULL DEFAULT 0;
ALTER TABLE outbox_message ADD COLUMN next_attempt_at  TIMESTAMP(3);

-- Token و Expiry با هم زندگی می‌کنند: یک Lease نیمه‌نوشته یعنی ردیفی که نه
-- Fence دارد نه واجد شرایط Claim است.
ALTER TABLE outbox_message ADD CONSTRAINT ck_outbox_claim_pairing
  CHECK ((claim_token IS NULL) = (claim_expires_at IS NULL));

ALTER TABLE outbox_message ADD CONSTRAINT ck_outbox_claim_count_nonneg
  CHECK (claim_count >= 0);

ALTER TABLE outbox_message ADD CONSTRAINT ck_outbox_attempts_nonneg
  CHECK (attempts >= 0);

-- یک ردیف منتشرشده هیچ Lease زنده‌ای ندارد و هیچ تلاش بعدی‌ای ندارد.
ALTER TABLE outbox_message ADD CONSTRAINT ck_outbox_published_is_unclaimed
  CHECK (published_at IS NULL OR (claim_token IS NULL AND next_attempt_at IS NULL));

CREATE INDEX ix_outbox_claimable
    ON outbox_message (created_at, id)
 WHERE published_at IS NULL;

CREATE INDEX ix_outbox_claim_expiry
    ON outbox_message (claim_expires_at)
 WHERE published_at IS NULL AND claim_expires_at IS NOT NULL;

CREATE INDEX ix_outbox_next_attempt
    ON outbox_message (next_attempt_at)
 WHERE published_at IS NULL AND next_attempt_at IS NOT NULL;
```

`ix_outbox_pending` روی `(published_at, created_at)` می‌ماند — `pendingCount()`
از آن استفاده می‌کند.

```sql
-- backward
DROP INDEX IF EXISTS ix_outbox_next_attempt;
DROP INDEX IF EXISTS ix_outbox_claim_expiry;
DROP INDEX IF EXISTS ix_outbox_claimable;
ALTER TABLE outbox_message DROP CONSTRAINT IF EXISTS ck_outbox_published_is_unclaimed;
ALTER TABLE outbox_message DROP CONSTRAINT IF EXISTS ck_outbox_attempts_nonneg;
ALTER TABLE outbox_message DROP CONSTRAINT IF EXISTS ck_outbox_claim_count_nonneg;
ALTER TABLE outbox_message DROP CONSTRAINT IF EXISTS ck_outbox_claim_pairing;
ALTER TABLE outbox_message DROP COLUMN IF EXISTS next_attempt_at;
ALTER TABLE outbox_message DROP COLUMN IF EXISTS claim_count;
ALTER TABLE outbox_message DROP COLUMN IF EXISTS claim_expires_at;
ALTER TABLE outbox_message DROP COLUMN IF EXISTS claim_owner;
ALTER TABLE outbox_message DROP COLUMN IF EXISTS claim_token;
```

`pnpm test:migration` (up → down → up) روی هر هشت باید سبز باشد.

### `CREATE INDEX CONCURRENTLY` — تصمیم گرفته شد، نه معلق

**آزمایش شد، نه فرض.** روی PostgreSQL و Prisma همین Repository:

```
$ psql -c "BEGIN; CREATE INDEX CONCURRENTLY …; COMMIT;"
ERROR:  CREATE INDEX CONCURRENTLY cannot run inside a transaction block

$ prisma@6.19.3 migrate deploy    # با CONCURRENTLY در فایل Migration
Error: P3018 … Database error code: 25001
ERROR: CREATE INDEX CONCURRENTLY cannot run inside a transaction block
```

یعنی **Prisma Migrate هر فایل Migration را در یک تراکنش می‌پیچد** و
`CONCURRENTLY` داخل آن **ممکن نیست** — نه «پشتیبانی مستقیم ندارد»، بلکه شکست
قطعی با SQLSTATE 25001.

**تصمیم: Index ها بدون `CONCURRENTLY` ساخته می‌شوند.** توجیه: جدول Outbox
به‌شکل ساختاری کوچک می‌ماند — `purgePublished` ردیف‌های منتشرشدهٔ قدیمی‌تر از
هفت روز را حذف می‌کند و ردیف‌های منتشرنشده پیوسته تخلیه می‌شوند. قفل
`ACCESS EXCLUSIVE` روی جدولی در این اندازه کوتاه است.

**اگر** استقراری Outbox بزرگ داشته باشد، مسیر جایگزین **خارج از Prisma
Migrate** است: اجرای دستی `CREATE INDEX CONCURRENTLY` پیش از Deploy، سپس
Migration که با `IF NOT EXISTS` از آن عبور می‌کند. این در Runbook نوشته می‌شود،
نه در Migration.

## رفتار در Rolling Deployment

| مرحله | نسخه‌های فعال      | رفتار                                                      | G1        |
| ----- | ------------------ | ---------------------------------------------------------- | --------- |
| ۰     | فقط قدیم           | امروز — Claim تکراری ممکن                                  | ❌        |
| ۱     | قدیم (Migration ۳) | ستون‌ها هستند، کسی نمی‌خواندشان                            | ❌        |
| ۲     | قدیم + جدید        | قدیم Lease را نادیده می‌گیرد؛ جدید Leaseدارها را رد می‌کند | ❌ موقتاً |
| ۳     | فقط جدید           | Fencing برقرار                                             | ✅        |

مرحلهٔ ۲ بدتر از مرحلهٔ ۰ نیست — همان رفتار امروز. اما G1 در طول Rollout برقرار
نیست و این باید پذیرفته شود، نه کشف.

## بازیابی پس از Clock Skew یا مرگ پروسه

- **مرگ پروسه:** Lease منقضی می‌شود؛ ردیف پس از حداکثر
  `OUTBOX_CLAIM_LEASE_SECONDS` واجد شرایط Claim مجدد است. Token قدیمی برای
  همیشه بی‌اثر می‌شود چون Claim بعدی آن را بازنویسی می‌کند.
- **Clock skew:** هر مقایسه و هر محاسبهٔ زمانی — انقضا، تمدید، Backoff — در SQL
  با `now()` **پایگاه داده** انجام می‌شود. هیچ `Date.now()` جاوااسکریپتی وارد
  تصمیم نمی‌شود. این الزام است، نه سلیقه.
- **Restart:** `claim_owner` تازه ساخته می‌شود و Tokenهای قبلی در حافظه نیستند،
  پس پروسهٔ جدید نمی‌تواند Leaseهای پروسهٔ قبل را Ack کند — درست است، چون
  نمی‌داند منتشر شده‌اند یا نه.

## تعامل با Cleanup

`purgePublished(retentionDays)` بدون تغییر می‌ماند. `ck_outbox_published_is_unclaimed`
تضمین می‌کند ردیف منتشرشده هیچ فراداده Claim زنده‌ای ندارد، پس Purge هرگز یک
Lease فعال را حذف نمی‌کند.

## Metric — آنچه اندازه‌گیری می‌شود، نه آنچه استنباط

نسخهٔ اول یک Metric داشت به نام «Conflict» با توضیح «یعنی انتشار تکراری قطعی
رخ داده». **این استنباط بود، نه اندازه‌گیری**: کوتاه‌بودن یک `UPDATE` ثابت
نمی‌کند پیامی به Kafka رسیده.

| نام                                  | نوع     | دقیقاً چه چیزی را می‌شمارد                                                                     |
| ------------------------------------ | ------- | ---------------------------------------------------------------------------------------------- |
| `rasta_outbox_ack_fenced_total`      | Counter | تعداد ردیف‌هایی که یک Mutation به‌دلیل عدم تطابق Token لمس نکرد. **رویداد Fencing، نه تکرار.** |
| `rasta_outbox_lease_reclaimed_total` | Counter | تعداد ردیف‌هایی که با Lease منقضی دوباره Claim شدند                                            |
| `rasta_outbox_claim_attempts_total`  | Counter | تعداد Claimها (مجموع افزایش `claim_count`)                                                     |
| `rasta_outbox_leases_active`         | Gauge   | ردیف‌های دارای Lease زنده                                                                      |
| `rasta_outbox_pending_total`         | Gauge   | بدون تغییر — `published_at IS NULL` سراسری                                                     |

**تحویل تکراری واقعی در سمت Producer قابل مشاهده نیست.** رله نمی‌داند یک
`sendBatch` که Timeout خورد به Broker رسید یا نه. `ack_fenced_total` یک
**نشانگر کران‌پایین** است: هر مقدار غیرصفر یعنی یک انتشار تکراری _ممکن_ است رخ
داده باشد. متن Alert باید همین را بگوید و نه بیشتر:

> «Fencing در Outbox رخ داد: N ردیف پس از ازدست‌رفتن مالکیت Ack نشدند. ممکن
> است تحویل تکراری رخ داده باشد؛ در سمت Producer قابل تأیید نیست.»

**Gauge ها هرگز `inc`/`dec` نمی‌شوند.** هر دو Gauge با یک `SELECT count(*)` در
همان Tick نمونه‌برداری `set` می‌شوند. الگوی امروزی
`onBatchPublished: (count) => outboxPendingTotal.dec(…)` در `app.module.ts`
دقیقاً همان چیزی است که پس از Restart یا یک خطای ازدست‌رفته Drift می‌کند و
**باید در Commit ۹ به `set` تبدیل شود**.

## آزمون‌های الزامی Phase B

همه قطعی؛ بدون Sleep، بدون Timing، بدون `runInBand`.

| #   | آزمون                                                        | چگونه قطعی می‌شود                                                                              |
| --- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| ۱   | دو Replica، Batchهای مجزا                                    | دو Store مستقل، Claim پیاپی؛ اشتراک باید **۰** باشد                                            |
| ۲   | **Token منقضی اما پس‌گرفته‌نشده می‌تواند Ack کند**           | `leaseSeconds = 0`؛ بدون Claim مجدد؛ Ack با Token اصلی → **۱ ردیف**                            |
| ۳   | **Token منقضی و پس‌گرفته‌شده نمی‌تواند Ack کند**             | `leaseSeconds = 0`؛ B پس می‌گیرد؛ Ack توسط A → **۰ ردیف**                                      |
| ۴   | مدعی کهنه نمی‌تواند `markFailed` بزند                        | همان‌طور؛ `markFailed` توسط A → **۰ ردیف**                                                     |
| ۵   | مدعی کهنه نمی‌تواند Release کند                              | → **۰ ردیف**                                                                                   |
| ۶   | مدعی کهنه نمی‌تواند Renew کند                                | → **۰ ردیف**                                                                                   |
| ۷   | **تمدید مالکیت را در یک انتشار عمداً طولانی نگه می‌دارد**    | Publisher ساختگی که تا آزادسازی صریح برنمی‌گردد؛ Heartbeat می‌زند؛ Ack در پایان → **موفق**     |
| ۸   | **ازدست‌رفتن تمدید مانع Mutation بعدی می‌شود**               | حین انتشار طولانی، B پس می‌گیرد؛ Renew صفر برمی‌گرداند؛ Ack بعدی → **۰ ردیف**                  |
| ۹   | **Fallback تکی نمی‌تواند از Lease تمدیدنشده عمر بیشتری کند** | Publisher که برای هر ردیف شکست می‌دهد؛ بدون تمدید، Ack ردیف‌های بعدی → **۰ ردیف**              |
| ۱۰  | ردیف مسموم → آزادسازی + Backoff                              | `markFailed` باید Token را پاک و `next_attempt_at` را در آینده بگذارد؛ Claim بعدی نباید بگیردش |
| ۱۱  | کران Batch                                                   | Backlog بزرگ‌تر از `limit` → دقیقاً `limit`                                                    |
| ۱۲  | ترتیب قطعی در برابری `created_at`                            | ده ردیف با `created_at` یکسان؛ دو Claim پیاپی همان ترتیب                                       |
| ۱۳  | بازیابی پس از Crash و انقضا                                  | اتصال A بسته می‌شود؛ پس از انقضا B می‌گیرد                                                     |
| ۱۴  | بدون فیلتر تنانت                                             | ردیف دو سازمان؛ هر دو Claim می‌شوند                                                            |
| ۱۵  | **نبودِ گم‌شدن رویداد** — بازنویسی‌شده                       | پایین                                                                                          |
| ۱۶  | مصرف‌کنندهٔ ایدمپوتنت با تکرار                               | همان رویداد دوبار؛ اثر تجاری یک‌بار                                                            |

### آزمون ۱۵، اصلاح‌شده

نسخهٔ اول می‌گفت «مجموع منتشرشده باید دقیقاً N باشد». **این با تضمین
At-Least-Once خودِ ADR در تناقض است** و با شکست تزریق‌شدهٔ Publish-before-Mark
می‌افتد. صورت درست:

- **هیچ رویدادی گم نمی‌شود:** مجموعهٔ شناسه‌های یکتای مشاهده‌شده در Kafka باید
  دقیقاً برابر N شناسهٔ ورودی باشد.
- **صفر گم‌شده.**
- **تعداد کل تلاش‌های انتشار می‌تواند از N بیشتر باشد** وقتی شکست
  Publish-before-Mark تزریق شده — چون تحویل At-Least-Once است.

## ماتریس ریسک و Rollback

| ریسک                                           | احتمال | اثر                             | کاهش                                                                      | Rollback                  |
| ---------------------------------------------- | ------ | ------------------------------- | ------------------------------------------------------------------------- | ------------------------- |
| Lease کوتاه‌تر از فاصلهٔ تمدید                 | پایین  | Fencing مکرر، انتشار تکراری     | کف ۱۰ ثانیه در اعتبارسنجی؛ فاصلهٔ تمدید = Lease/۳                         | افزایش متغیر، بدون Deploy |
| Heartbeat می‌میرد اما Publish ادامه دارد       | متوسط  | ازدست‌رفتن مالکیت؛ تحویل تکراری | Fencing در SQL جلوی خرابی داده را می‌گیرد؛ `ack_fenced_total` دیده می‌شود | —                         |
| درخواست Kafka در پرواز پس از ازدست‌رفتن مالکیت | متوسط  | تحویل تکراری                    | **قابل رفع نیست** — At-Least-Once؛ A-09 مهارش می‌کند                      | —                         |
| Backoff خیلی تهاجمی                            | پایین  | ردیف مسموم دیر Retry می‌شود     | سقف `OUTBOX_CLAIM_BACKOFF_MAX_SECONDS`؛ `oldest_pending_age` دیده می‌شود  | کاهش متغیر                |
| `UPDATE` روی هر Poll + Heartbeat، بار WAL      | متوسط  | نوشتن بیشتر                     | زیرپرسش خالی → صفر ردیف؛ سنجش پیش از Rollout سراسری                       | Revert ۵–۷                |
| Index بدون `CONCURRENTLY` روی جدول بزرگ        | پایین  | قفل کوتاه `ACCESS EXCLUSIVE`    | Outbox با Purge کوچک می‌ماند؛ مسیر دستی در Runbook                        | `DROP INDEX`              |
| CHECK روی داده موجود شکست بخورد                | پایین  | Migration نمی‌نشیند             | ستون‌ها تازه و NULL‌اند؛ `attempts >= 0` از قبل برقرار است                | حذف CONSTRAINT            |
| Revert Migration با کد جدید فعال               | پایین  | خطای ستون ناموجود               | **ترتیب اجباری: کد قبل از Schema برگردد**                                 | ابتدا کد، سپس Migration   |
| هشت Migration، یکی جا بماند                    | متوسط  | آن سرویس روی مسیر قدیم          | `pnpm db:migrate`؛ Checklist هشت‌تایی در PR                               | همان سرویس جدا            |

**محدودیت Rollback:** پس از Commit ۵، ردیفی که Claim شده و Ack نشده با برگشت به
نسخهٔ قدیم **بلافاصله** دوباره Claimشدنی می‌شود — یعنی خودِ Rollback می‌تواند یک
انتشار تکراری بسازد. پذیرفتنی است (At-Least-Once از قبل فرض است) اما باید در
Runbook نوشته شود.

## Observability

- پنج Metric بالا، با Gauge‌های `set`-محور.
- `docs/runbooks/outbox-stuck.md` بخش تازه می‌گیرد: «Claimشده اما منتشرنشده»
  در برابر «اصلاً Claim نشده» در برابر «در Backoff» — سه حالت متفاوت با سه
  اقدام متفاوت.
