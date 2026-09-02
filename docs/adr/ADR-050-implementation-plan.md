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
| ۳   | `feat(db): add nullable outbox claim columns to all eight`        | Migration: پنج ستون، سه Index، پنج CHECK. **هیچ کدی نمی‌خواندشان.** | امن    |
| ۴   | `feat(config): add the three outbox claim variables`              | پیکربندی با کران‌های صحیح. بدون مصرف‌کننده.                         | امن    |
| ۵   | `feat(outbox): claim rows with a fencing token`                   | `claimPending` → `UPDATE … RETURNING claim_token`. **تغییر رفتار.** | ⚠️     |
| ۶   | `feat(outbox): fence every mutation on the claim token`           | Ack/Fail/Release/Renew مشروط بر Token، با مقدار برگشتی              | ⚠️     |
| ۷   | `feat(outbox): renew the lease while a batch is in flight`        | Heartbeat + توقف روی ازدست‌رفتن مالکیت                              | ⚠️     |
| ۸   | `feat(outbox): schedule retries with next_attempt_at`             | Backoff نمایی سقف‌دار با ساعت پایگاه داده                           | ⚠️     |
| ۹   | `feat(observability): expose the five claim metrics`              | Metric و Alert                                                      | امن    |
| ۱۰  | `test(outbox): the deterministic fencing and lease suite`         | بیست‌وچهار آزمون بخش پایین                                          | امن    |
| ۱۱  | `docs: mark D-026 resolved and ADR-050 Accepted`                  | فقط پس از سبزشدن ۱۰                                                 | امن    |

Commit ۳ باید **پیش از** ۵ روی همه محیط‌ها مستقر شود. تنها ترتیب اجباری همین است.

## Migration

```sql
-- forward
-- قفل را محدود کن: شکست سریع بهتر از انتظار بی‌پایان پشت یک تراکنش طولانی.
SET LOCAL lock_timeout = '3s';

ALTER TABLE outbox_message ADD COLUMN claim_token      TEXT;
ALTER TABLE outbox_message ADD COLUMN claim_owner      TEXT;
ALTER TABLE outbox_message ADD COLUMN claim_expires_at TIMESTAMP(3);
ALTER TABLE outbox_message ADD COLUMN claim_count      INTEGER   NOT NULL DEFAULT 0;
ALTER TABLE outbox_message ADD COLUMN next_attempt_at  TIMESTAMP(3);

-- یک Claim فعال هر سه ستون را با هم دارد. دو تا از سه تا یعنی رکوردی که یا
-- Fence ندارد، یا انقضا ندارد، یا در Metric بی‌مالک به‌نظر می‌رسد.
ALTER TABLE outbox_message ADD CONSTRAINT ck_outbox_claim_triple
  CHECK (num_nonnulls(claim_token, claim_owner, claim_expires_at) IN (0, 3));

ALTER TABLE outbox_message ADD CONSTRAINT ck_outbox_claim_count_nonneg
  CHECK (claim_count >= 0);

ALTER TABLE outbox_message ADD CONSTRAINT ck_outbox_attempts_nonneg
  CHECK (attempts >= 0);

-- یک ردیف منتشرشده هیچ فراداده Claim ندارد — از جمله `claim_owner` — و هیچ
-- تلاش بعدی‌ای ندارد.
ALTER TABLE outbox_message ADD CONSTRAINT ck_outbox_published_is_clean
  CHECK (published_at IS NULL
         OR (claim_token IS NULL AND claim_owner IS NULL
             AND claim_expires_at IS NULL AND next_attempt_at IS NULL));

-- `next_attempt_at` فقط برای ردیف منتشرنشده‌ای معنا دارد که دست‌کم یک شکست
-- داشته. زمان‌بندی تلاش بعدی بدون تلاش قبلی، داده‌ای است که هیچ کدی نمی‌سازد.
ALTER TABLE outbox_message ADD CONSTRAINT ck_outbox_next_attempt_requires_failure
  CHECK (next_attempt_at IS NULL OR (published_at IS NULL AND attempts >= 1));

CREATE INDEX IF NOT EXISTS ix_outbox_claimable
    ON outbox_message (created_at, id)
 WHERE published_at IS NULL;

CREATE INDEX IF NOT EXISTS ix_outbox_claim_expiry
    ON outbox_message (claim_expires_at)
 WHERE published_at IS NULL AND claim_expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_outbox_next_attempt
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
ALTER TABLE outbox_message DROP CONSTRAINT IF EXISTS ck_outbox_next_attempt_requires_failure;
ALTER TABLE outbox_message DROP CONSTRAINT IF EXISTS ck_outbox_published_is_clean;
ALTER TABLE outbox_message DROP CONSTRAINT IF EXISTS ck_outbox_attempts_nonneg;
ALTER TABLE outbox_message DROP CONSTRAINT IF EXISTS ck_outbox_claim_count_nonneg;
ALTER TABLE outbox_message DROP CONSTRAINT IF EXISTS ck_outbox_claim_triple;
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
Migration که با `IF NOT EXISTS` از آن عبور می‌کند. SQL بالا عمداً
`CREATE INDEX IF NOT EXISTS` است تا این ادعا با آنچه واقعاً اجرا می‌شود یکی
باشد.

### ایمنی قفل — `lock_timeout` الزامی است

`CREATE INDEX` غیرهم‌زمان یک قفل `ACCESS EXCLUSIVE` می‌خواهد. اگر تراکنش
طولانی‌ای روی `outbox_message` باز باشد — یک رلهٔ کند، یک `pg_dump`، یک Session
فراموش‌شده — Migration **بی‌پایان** پشت آن صف می‌کشد. بدتر: درخواست قفل خودش
صف می‌سازد، پس هر `INSERT` تازه هم پشت Migration می‌ماند و نوشتن Outbox متوقف
می‌شود. یعنی یک Migration معلق می‌تواند سرویس را از کار بیندازد.

هر فایل Migration این ADR **باید** با این خط شروع شود:

```sql
SET LOCAL lock_timeout = '3s';
```

`SET LOCAL` است، پس با پایان تراکنشِ Migration خودبه‌خود برمی‌گردد و روی
Session اثر ماندگار ندارد. سه ثانیه انتخاب شد چون از هر قفل کوتاهِ عادی
بلندتر است و از پنجرهٔ صبر یک Deploy کوتاه‌تر.

**رفتار شکست:** Migration با `55P03 lock_not_available` **سریع و امن** می‌افتد
و هیچ‌چیز نیمه‌کاره نمی‌ماند — Prisma کل فایل را در یک تراکنش می‌پیچد، پس
Rollback کامل است.

**رویهٔ تلاش دوباره (در Runbook ثبت می‌شود):**

1. تراکنش مانع را پیدا کن:
   `SELECT pid, state, age(now(), xact_start) AS age, query FROM pg_stat_activity WHERE state <> 'idle' ORDER BY xact_start LIMIT 10;`
2. اگر یک رلهٔ کند یا Session فراموش‌شده است، پایانش بده یا صبر کن تا تمام شود.
3. Migration را دوباره اجرا کن. `IF NOT EXISTS` یعنی اجرای دوباره امن است.
4. اگر سه بار پشت‌سرهم افتاد، یعنی جدول همیشه تحت تراکنش طولانی است — آن‌وقت
   مسیر دستی `CONCURRENTLY` بالا انتخاب درست است، نه بالا بردن `lock_timeout`.

## Preflight — پیش از هر Migration، روی هر هشت پایگاه داده

بدون این اعداد، «جدول کوچک می‌ماند» یک فرض است نه یک واقعیت. Phase B باید این
جدول را برای **هر هشت** پایگاه داده پر کند و در PR بگذارد:

```sql
SELECT
  (SELECT count(*) FROM outbox_message)                                   AS total_rows,
  (SELECT count(*) FROM outbox_message WHERE published_at IS NULL)        AS pending_rows,
  pg_size_pretty(pg_table_size('outbox_message'))                         AS table_size,
  pg_size_pretty(pg_indexes_size('outbox_message'))                       AS index_size,
  (SELECT coalesce(extract(epoch FROM now() - min(created_at)), 0)
     FROM outbox_message WHERE published_at IS NULL)                      AS oldest_pending_seconds;
```

| پایگاه داده          | total_rows | pending_rows | table_size | index_size | oldest_pending_s |
| -------------------- | ---------- | ------------ | ---------- | ---------- | ---------------- |
| `rasta_identity`     | ⬜         | ⬜           | ⬜         | ⬜         | ⬜               |
| `rasta_organization` | ⬜         | ⬜           | ⬜         | ⬜         | ⬜               |
| `rasta_asset`        | ⬜         | ⬜           | ⬜         | ⬜         | ⬜               |
| `rasta_fleet`        | ⬜         | ⬜           | ⬜         | ⬜         | ⬜               |
| `rasta_maintenance`  | ⬜         | ⬜           | ⬜         | ⬜         | ⬜               |
| `rasta_economic`     | ⬜         | ⬜           | ⬜         | ⬜         | ⬜               |
| `rasta_marketplace`  | ⬜         | ⬜           | ⬜         | ⬜         | ⬜               |
| `rasta_document`     | ⬜         | ⬜           | ⬜         | ⬜         | ⬜               |

**آستانهٔ مسیر دستی:** اگر برای هر پایگاه داده‌ای
`total_rows > 1_000_000` **یا** `pg_table_size > 1 GB`، آن پایگاه داده از
مسیر دستی `CONCURRENTLY` می‌رود و Migration فقط از روی Index موجود عبور
می‌کند. زیر این آستانه، ساخت درون Migration مجاز است.

**تأیید Index در مسیر دستی — نام کافی نیست.** یک Index با نام درست اما ستون یا
Predicate متفاوت، بدتر از نبودنش است: Migration از رویش عبور می‌کند و
پرس‌وجو کند می‌ماند. تأیید باید روی **تعریف کامل** باشد:

```sql
SELECT indexdef FROM pg_indexes
 WHERE tablename = 'outbox_message' AND indexname = 'ix_outbox_claimable';
-- باید دقیقاً برابر باشد با:
-- CREATE INDEX ix_outbox_claimable ON public.outbox_message
--   USING btree (created_at, id) WHERE (published_at IS NULL)
```

هر سه Index به همین شکل و با مقایسهٔ متن نرمال‌شدهٔ `pg_get_indexdef` تأیید
می‌شوند — ستون‌ها، ترتیبشان، و Predicate.

## پذیرش کارایی پرس‌وجو

شرط Claim یک `OR` روی دو ستون Nullable دارد به‌علاوهٔ یک `ORDER BY` ترکیبی:

```sql
WHERE published_at IS NULL
  AND (claim_expires_at IS NULL OR claim_expires_at <= now())
  AND (next_attempt_at  IS NULL OR next_attempt_at  <= now())
ORDER BY created_at, id
```

**فرض نمی‌شود که سه Index جدا این را کارآمد پوشش می‌دهند.** `OR` روی ستون
Nullable معمولاً Index را بی‌اثر می‌کند، و به‌احتمال زیاد Planner فقط
`ix_outbox_claimable` را برای ترتیب برمی‌دارد و بقیهٔ شرط‌ها Filter می‌شوند.
اگر چنین باشد، دو Index دیگر برای Claim بی‌فایده‌اند و فقط برای رصد می‌ارزند —
که باید **اندازه‌گیری** شود، نه حدس.

Phase B باید `EXPLAIN (ANALYZE, BUFFERS)` را برای شش وضعیت اجرا و در PR
بگذارد:

| #   | وضعیت                          | چرا مهم است                                               |
| --- | ------------------------------ | --------------------------------------------------------- |
| ۱   | صف خالی                        | مسیر داغ؛ هر ۵۰۰ms اجرا می‌شود                            |
| ۲   | اکثراً Claimنشده               | حالت عادی                                                 |
| ۳   | اکثراً دارای Lease فعال        | آیا ردیف‌های Claimشده اسکن می‌شوند؟                       |
| ۴   | اکثراً در Backoff              | آیا `next_attempt_at` واقعاً فیلتر می‌کند یا اسکن می‌شود؟ |
| ۵   | اکثراً دارای Lease منقضی       | مسیر بازیابی                                              |
| ۶   | Backlog بسیار بزرگ‌تر از Batch | آیا `LIMIT` زودتر متوقف می‌شود؟                           |

**معیار پذیرش — آگاه به Planner، نه مطلق:**

نسخهٔ قبلی می‌گفت «`Seq Scan` در هر شش وضعیت مردود است». این **بیش از حد مطلق**
بود: PostgreSQL برای یک رابطهٔ تهی یا خیلی کوچک ممکن است به‌درستی `Seq Scan`
انتخاب کند، چون از پیمایش Index ارزان‌تر است. آن نقص کارایی نیست؛ رد کردنش
یعنی رد کردن رفتار درست Planner.

معیار تفکیک‌شده:

- **روی Fixture مقیاس‌دار (بزرگ)،** پرس‌وجوی Claim باید نقشه‌ای مبتنی بر Index
  بگیرد — `Index Scan` یا `Index Only Scan` یا `Bitmap Index Scan`.
  **`Seq Scan` روی جدول بزرگ مردود است.**
- **روی جدول تهی یا واقعاً کوچک،** `Seq Scan` **پذیرفته می‌شود** — اما فقط
  وقتی هر سه عدد ناچیز و **ثبت‌شده** باشند: اندازهٔ رابطه، زمان اجرای واقعی، و
  `shared read`. «ناچیز» یعنی زیر چند صفحه و زیر یک میلی‌ثانیه؛ عدد واقعی در
  PR می‌آید، نه ادعا.
- **Fixtureهای مقیاس‌دار باید وضعیت‌های ۳ (اکثراً Lease فعال) و ۴ (اکثراً در
  Backoff) را هم پوشش دهند** — نه فقط حالت عادی. این دو دقیقاً جایی‌اند که
  `OR` روی ستون Nullable می‌تواند Index را بی‌اثر کند.
- **`rows removed by filter ≤ ۱۰ × LIMIT`** برای Fixtureهای مقیاس‌دارِ واجد
  شرایط الزامی می‌ماند. اگر نقض شد، یعنی Index ترتیب را می‌دهد اما واجد شرایط
  بودن را نه، و Index ترکیبی لازم است.
- **در PR باید ثبت شود:** زمان اجرای واقعی، `buffers`، اندازهٔ رابطه، تعداد
  ردیف، و **نام Indexی که Planner انتخاب کرد** — برای هر شش وضعیت.
- **اگر روی یک Fixture مقیاس‌دار Planner `Seq Scan` انتخاب کرد، طراحی Index
  باید پیش از Rollout بازنگری شود** — نه اینکه با یادداشت رد شود.
- اگر `ix_outbox_claim_expiry` و `ix_outbox_next_attempt` در هیچ وضعیتی انتخاب
  نشدند، تصمیم دربارهٔ نگه‌داشتن یا حذفشان باید صریح گرفته شود، نه به‌ارث برده.

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

`purgePublished(retentionDays)` بدون تغییر می‌ماند. `ck_outbox_published_is_clean`
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

| #   | آزمون                                                        | چگونه قطعی می‌شود                                                                                                                                |
| --- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| ۱   | دو Replica، Batchهای مجزا                                    | دو Store مستقل، Claim پیاپی؛ اشتراک باید **۰** باشد                                                                                              |
| ۲   | **Token منقضی اما پس‌گرفته‌نشده می‌تواند Ack کند**           | `leaseSeconds = 0`؛ بدون Claim مجدد؛ Ack با Token اصلی → **۱ ردیف**                                                                              |
| ۳   | **Token منقضی و پس‌گرفته‌شده نمی‌تواند Ack کند**             | `leaseSeconds = 0`؛ B پس می‌گیرد؛ Ack توسط A → **۰ ردیف**                                                                                        |
| ۴   | مدعی کهنه نمی‌تواند `markFailed` بزند                        | همان‌طور؛ `markFailed` توسط A → **۰ ردیف**                                                                                                       |
| ۵   | مدعی کهنه نمی‌تواند Release کند                              | → **۰ ردیف**                                                                                                                                     |
| ۶   | مدعی کهنه نمی‌تواند Renew کند                                | → **۰ ردیف**                                                                                                                                     |
| ۷   | **تمدید مالکیت را در یک انتشار عمداً طولانی نگه می‌دارد**    | Publisher ساختگی که تا آزادسازی صریح برنمی‌گردد؛ Heartbeat می‌زند؛ Ack در پایان → **موفق**                                                       |
| ۸   | **ازدست‌رفتن تمدید مانع Mutation بعدی می‌شود**               | حین انتشار طولانی، B پس می‌گیرد؛ Renew صفر برمی‌گرداند؛ Ack بعدی → **۰ ردیف**                                                                    |
| ۹   | **Fallback تکی نمی‌تواند از Lease تمدیدنشده عمر بیشتری کند** | Publisher که برای هر ردیف شکست می‌دهد؛ بدون تمدید، Ack ردیف‌های بعدی → **۰ ردیف**                                                                |
| ۱۰  | ردیف مسموم → آزادسازی + Backoff                              | `markFailed` باید Token را پاک و `next_attempt_at` را در آینده بگذارد؛ Claim بعدی نباید بگیردش                                                   |
| ۱۱  | کران Batch                                                   | Backlog بزرگ‌تر از `limit` → دقیقاً `limit`                                                                                                      |
| ۱۲  | ترتیب قطعی در برابری `created_at`                            | ده ردیف با `created_at` یکسان؛ دو Claim پیاپی همان ترتیب                                                                                         |
| ۱۳  | بازیابی پس از Crash و انقضا                                  | اتصال A بسته می‌شود؛ پس از انقضا B می‌گیرد                                                                                                       |
| ۱۴  | بدون فیلتر تنانت                                             | ردیف دو سازمان؛ هر دو Claim می‌شوند                                                                                                              |
| ۱۵  | **نبودِ گم‌شدن رویداد** — بازنویسی‌شده                       | پایین                                                                                                                                            |
| ۱۶  | مصرف‌کنندهٔ ایدمپوتنت با تکرار                               | همان رویداد دوبار؛ اثر تجاری یک‌بار                                                                                                              |
| ۱۷  | **تمدید جزئی: بازماندگان همچنان Ack می‌شوند**                | صد ردیف Claim؛ ده‌تا با Token دیگر پس گرفته می‌شوند؛ تمدید نود شناسه برمی‌گرداند؛ Ack روی همان نود → **۹۰ ردیف**، و ده‌تای دیگر لمس نمی‌شوند     |
| ۱۸  | تمدید صفر ردیف برمی‌گرداند                                   | کل Batch پس گرفته می‌شود؛ Heartbeat می‌ایستد؛ `ownedUnacknowledgedIds` تهی؛ هیچ Ack و هیچ Fail                                                   |
| ۱۹  | خطای گذرای تمدید و بازیابی پیش از انقضا                      | یک‌بار خطا تزریق می‌شود؛ تلاش فوری بعدی موفق؛ مالکیت حفظ؛ Ack پایانی → **موفق**                                                                  |
| ۲۰  | خاموشی پیش از ارسال                                          | `stop()` وقتی هنوز چیزی نرفته؛ Release مشروط بر Token؛ ردیف‌ها بلافاصله Claimشدنی                                                                |
| ۲۱  | خاموشی پس از ارسال موفقِ معلوم                               | Publisher برمی‌گردد، سپس `stop()`؛ Ack مشروط بر Token اجرا می‌شود                                                                                |
| ۲۲  | **خاموشی حین ارسال با نتیجهٔ نامعلوم**                       | Publisher که هرگز برنمی‌گردد؛ `stop()` تا مهلت مالکیت را نگه می‌دارد، **Release نمی‌کند**، سپس خارج می‌شود؛ ردیف فقط با انقضای طبیعی آزاد می‌شود |
| ۲۳  | Fallback: یک ردیف Fence شده، بقیه ادامه می‌دهند              | در مسیر ردیف‌به‌ردیف، یک ردیف پس گرفته می‌شود؛ آن یکی Ack نمی‌شود، بقیهٔ مالک‌ها می‌شوند                                                         |
| ۲۴  | پاک‌سازی Timer در هر مسیر پایانی                             | پس از موفقیت، شکست، Fence کامل و خاموشی: هیچ Timer فعالی نماند                                                                                   |

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

| ریسک                                           | احتمال    | اثر                                                                                                      | کاهش                                                                                                                                                                         | Rollback                                          |
| ---------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Lease کوتاه‌تر از فاصلهٔ تمدید                 | پایین     | Fencing مکرر روی کار سالم، انتشار تکراری                                                                 | کف **۲۰ ثانیه** در اعتبارسنجی؛ `interval = Lease/4` سه تلاش پیش از انقضا می‌دهد (تحمل **۲** تمدید ازدست‌رفته)؛ مهلت هر فراخوان `min(interval/2, 30s)` با `statement_timeout` | افزایش متغیر، بدون Deploy                         |
| Heartbeat می‌میرد اما Publish ادامه دارد       | متوسط     | ازدست‌رفتن مالکیت؛ تحویل تکراری                                                                          | Fencing در SQL جلوی خرابی داده را می‌گیرد؛ `ack_fenced_total` دیده می‌شود                                                                                                    | —                                                 |
| تمدید جزئی و رها کردن مالکیت معتبر             | متوسط     | Ack نشدن ردیف‌هایی که واقعاً مال ما بودند → بازپخش غیرلازم                                               | تمدید شناسه برمی‌گرداند؛ فقط `lost` کنار گذاشته می‌شود، بازماندگان Ack می‌شوند                                                                                               | —                                                 |
| خاموشی با نتیجهٔ Kafka نامعلوم                 | متوسط     | Release زودهنگام = بازپخش قطعی                                                                           | حالت سوم پروتکل خاموشی: Release نکن، مالکیت را تا مهلت نگه دار، سپس انقضای طبیعی                                                                                             | —                                                 |
| خاموشی بی‌پایان منتظر Kafka                    | پایین     | Pod در `Terminating` گیر می‌کند                                                                          | `OUTBOX_SHUTDOWN_GRACE_SECONDS` سقف‌دار (پیش‌فرض ۳۰، بیشینه ۳۰۰)                                                                                                             | کاهش متغیر                                        |
| Index ها شرط Claim را پوشش ندهند               | **متوسط** | `Seq Scan` روی جدول بزرگ در مسیر داغ هر ۵۰۰ms                                                            | معیار پذیرش `EXPLAIN` روی Fixture مقیاس‌دار پیش از Rollout؛ `Seq Scan` روی جدول بزرگ مردود است (روی جدول تهی/کوچک مجاز، با ثبت اعداد)                                        | افزودن Index ترکیبی                               |
| Migration روی Outbox بزرگ قفل بگیرد            | پایین     | وقفهٔ کوتاه در نوشتن                                                                                     | Preflight هشت‌تایی؛ آستانهٔ یک‌میلیون ردیف یا ۱GB → مسیر دستی `CONCURRENTLY`                                                                                                 | `DROP INDEX`                                      |
| Index دستی با تعریف اشتباه                     | پایین     | Migration از رویش عبور می‌کند و پرس‌وجو کند می‌ماند                                                      | تأیید با `pg_get_indexdef` — ستون، ترتیب و Predicate، نه فقط نام                                                                                                             | بازسازی Index                                     |
| درخواست Kafka در پرواز پس از ازدست‌رفتن مالکیت | متوسط     | تحویل تکراری                                                                                             | **قابل رفع نیست** — At-Least-Once؛ A-09 مهارش می‌کند                                                                                                                         | —                                                 |
| Backoff خیلی تهاجمی                            | پایین     | ردیف مسموم دیر Retry می‌شود                                                                              | سقف `OUTBOX_CLAIM_BACKOFF_MAX_SECONDS`؛ `oldest_pending_age` دیده می‌شود                                                                                                     | کاهش متغیر                                        |
| `UPDATE` روی هر Poll + Heartbeat، بار WAL      | متوسط     | نوشتن بیشتر                                                                                              | زیرپرسش خالی → صفر ردیف؛ سنجش پیش از Rollout سراسری                                                                                                                          | Revert ۵–۷                                        |
| Index بدون `CONCURRENTLY` روی جدول بزرگ        | پایین     | قفل کوتاه `ACCESS EXCLUSIVE`                                                                             | Outbox با Purge کوچک می‌ماند؛ مسیر دستی در Runbook                                                                                                                           | `DROP INDEX`                                      |
| `CREATE INDEX` پشت یک تراکنش طولانی صف بکشد    | متوسط     | Migration نامحدود منتظر می‌ماند و Deploy را معلق نگه می‌دارد؛ صفِ قفل پشت آن هر نوشتن تازه را هم می‌بندد | `SET LOCAL lock_timeout = '3s'` در ابتدای Migration — شکست سریع و امن به‌جای انتظار بی‌پایان                                                                                 | اجرای دوبارهٔ Migration پس از پایان تراکنش طولانی |
| CHECK روی داده موجود شکست بخورد                | پایین     | Migration نمی‌نشیند                                                                                      | ستون‌ها تازه و NULL‌اند؛ `attempts >= 0` از قبل برقرار است                                                                                                                   | حذف CONSTRAINT                                    |
| Revert Migration با کد جدید فعال               | پایین     | خطای ستون ناموجود                                                                                        | **ترتیب اجباری: کد قبل از Schema برگردد**                                                                                                                                    | ابتدا کد، سپس Migration                           |
| هشت Migration، یکی جا بماند                    | متوسط     | آن سرویس روی مسیر قدیم                                                                                   | `pnpm db:migrate`؛ Checklist هشت‌تایی در PR                                                                                                                                  | همان سرویس جدا                                    |

**محدودیت Rollback:** پس از Commit ۵، ردیفی که Claim شده و Ack نشده با برگشت به
نسخهٔ قدیم **بلافاصله** دوباره Claimشدنی می‌شود — یعنی خودِ Rollback می‌تواند یک
انتشار تکراری بسازد. پذیرفتنی است (At-Least-Once از قبل فرض است) اما باید در
Runbook نوشته شود.

## Observability و Runbook

- پنج Metric بالا، با Gauge‌های `set`-محور.
- `docs/runbooks/outbox-stuck.md` دو بخش تازه می‌گیرد:
  1. **سه حالت Backlog:** «Claimشده اما منتشرنشده» در برابر «اصلاً Claim نشده»
     در برابر «در Backoff» — سه وضعیت متفاوت با سه اقدام متفاوت.
  2. **شکست Migration با `lock_timeout`:** مقدار انتخاب‌شده (**۳ ثانیه**)، معنای
     `55P03 lock_not_available`، و رویهٔ چهارمرحله‌ای تلاش دوباره که در بخش
     «ایمنی قفل» بالا آمد.

---

# Phase B — شواهد اجرا (2026-09-02)

> این بخش را Phase B پر کرد. **وضعیت ADR-050 همچنان `Proposed` است و D-026 باز
> است**؛ پذیرش پس از بازبینی محصول روی همین شواهد انجام می‌شود.

## Preflight — هر هشت پایگاه داده

اندازه‌گیری‌شده روی PostgreSQL واقعی، پیش از Migration:

| پایگاه داده          | total_rows | pending_rows | table_size | index_size | oldest_pending_s |
| -------------------- | ---------- | ------------ | ---------- | ---------- | ---------------- |
| `rasta_identity`     | ۰          | ۰            | 8192 bytes | 16 kB      | ۰                |
| `rasta_organization` | ۰          | ۰            | 8192 bytes | 16 kB      | ۰                |
| `rasta_asset`        | ۰          | ۰            | 8192 bytes | 16 kB      | ۰                |
| `rasta_fleet`        | ۰          | ۰            | 24 kB      | 32 kB      | ۰                |
| `rasta_maintenance`  | ۰          | ۰            | 24 kB      | 32 kB      | ۰                |
| `rasta_economic`     | ۴۷۲        | ۰            | 1040 kB    | 216 kB     | ۰                |
| `rasta_marketplace`  | ۲۳۷        | ۰            | 736 kB     | 192 kB     | ۰                |
| `rasta_document`     | ۱۳۵        | ۰            | 272 kB     | 1840 kB    | ۰                |

بیشینه ۴۷۲ ردیف و ۱۰۴۰ کیلوبایت — بسیار پایین‌تر از آستانهٔ یک‌میلیون ردیف یا
۱GB. پس **هر هشت** از مسیر درون‌Migration رفتند و هیچ‌کدام نیاز به مسیر دستی
`CONCURRENTLY` نداشت.

## `EXPLAIN (ANALYZE, BUFFERS)` — شش وضعیت

Fixture مقیاس‌دار روی Schema جداگانه، جدول با
`LIKE public.outbox_message INCLUDING ALL`. `LIMIT 100`. SQL دقیقاً همان چیزی
است که `claimPendingSql` اجرا می‌کند — از خود کد استخراج شد، نه بازنویسی دستی.

| #   | وضعیت              | ردیف      | جدول       | صفحه  | Plan                      | Index های انتخاب‌شده                                                    | rows removed | Sort      | Disk  | Planning | Execution    |
| --- | ------------------ | --------- | ---------- | ----- | ------------------------- | ----------------------------------------------------------------------- | ------------ | --------- | ----- | -------- | ------------ |
| ۱   | صف خالی            | ۰         | 8192 bytes | ۰     | `Seq Scan` روی رابطهٔ تهی | —                                                                       | **۰**        | —         | ندارد | 0.832 ms | **0.048 ms** |
| ۲   | اکثراً Claimنشده   | ۲۰۰٬۰۰۰   | 24 MB      | ۳۰۷۷  | `Index Scan`              | `due_fresh`, `due_lease`, `due_retry`, `next_attempt_at`, `pkey`        | **۰**        | quicksort | ندارد | 1.115 ms | **6.578 ms** |
| ۳   | اکثراً Lease فعال  | ۲۰۰٬۰۰۰   | 28 MB      | ۳۶۰۹  | `Index Scan`              | `due_fresh`, `due_retry`, `claim_expires_at`, `next_attempt_at`, `pkey` | **۰**        | quicksort | ندارد | 0.678 ms | **5.471 ms** |
| ۴   | اکثراً در Backoff  | ۲۰۰٬۰۰۰   | 26 MB      | ۳۲۶۹  | `Index Scan`              | `due_both`, `due_fresh`, `due_lease`, `claim_expires_at`, `pkey`        | **۰**        | quicksort | ندارد | 0.780 ms | **4.032 ms** |
| ۵   | اکثراً Lease منقضی | ۲۰۰٬۰۰۰   | 28 MB      | ۳۶۰۹  | `Index Scan`              | `due_fresh`, `due_retry`, `created_at_id`, `next_attempt_at`, `pkey`    | **۰**        | quicksort | ندارد | 0.971 ms | **5.405 ms** |
| ۶   | Backlog ۱ میلیونی  | ۱٬۰۰۰٬۰۰۰ | 120 MB     | ۱۵۳۸۵ | `Index Scan`              | `due_fresh`, `due_lease`, `due_retry`, `next_attempt_at`, `pkey`        | **۰**        | quicksort | ندارد | 0.834 ms | **3.991 ms** |

**معیار `rows removed by filter ≤ ۱۰ × LIMIT` در هر شش وضعیت برقرار است: صفر در
برابر سقف ۱٬۰۰۰.** هیچ `Seq Scan` روی هیچ Fixture مقیاس‌داری اجرا نشد. هیچ
Sortی به دیسک نرفت.

### چرا Predicate تک‌تکه شکست خورد — و چرا Index تنها کافی نبود

نسخهٔ اول همین Phase، شرط واحد ADR را با سه Index اجرا می‌کرد و در وضعیت‌های ۳ و
۴ **۱۹۰٬۰۰۰** ردیف را با Filter دور می‌ریخت. علت، نبودِ Index نبود:

**`now()` در PostgreSQL `stable` است، نه `immutable`.** مقدارش هنگام Planning
معلوم نیست، پس Planner برای `<= now()` نمی‌تواند به Histogram نگاه کند و
گزینش‌پذیری پیش‌فرض ۳۳٪ را می‌گذارد. این **اندازه‌گیری شد، نه حدس**: یک Index
عبارتی روی `GREATEST(COALESCE(...), COALESCE(...))` واقعاً آمار می‌گیرد —
`n_distinct = 2` در `pg_stats` — و Planner باز هم ۶۶٬۶۶۷ از ۲۰۰٬۰۰۰ را تخمین
زد. با `LIMIT 100`، خروج زودهنگام از Index ترتیب همیشه ارزان‌تر به‌نظر می‌رسد،
پس نقشه روی `(created_at, id)` راه می‌رود و Filter می‌کند.

سه جایگزین آزموده شد و نتیجهٔ هر سه ثبت است:

| جایگزین                                                          | نتیجهٔ اندازه‌گیری‌شده                                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Index عبارتی + Predicate بازنویسی‌شده به همان عبارت دقیق         | Planner انتخابش نکرد؛ تخمین ۳۳٪ ماند. وضعیت ۳: **۱۹۰٬۰۰۰** حذف‌شده، **73 ms**              |
| Index های ستونی `(claim_expires_at NULLS FIRST, created_at, id)` | تخمین **درست** شد (۹٬۷۶۰ ≈ ۵٪) و Planner باز هم Index ترتیب را برداشت. **۱۹۰٬۰۰۰** حذف‌شده |
| سه جریان (ادغام Lease و Both در یک عبارت)                        | rows removed صفر، اما وضعیت ۳ به **68 ms** رسید — عبارت دوباره تخمین را خراب کرد           |

**انتخاب: چهار جریان `UNION ALL`.** هر ردیف منتشرنشده دقیقاً در یکی می‌افتد، و
در هر کدام شرط واجد شرایط بودن یا **ایستا** است یا **بازه‌ای روی ستون پیشروی
همان Index** — هیچ‌وقت Filter دنباله‌ای:

| جریان    | کدام ردیف‌ها       | واجد شرایط وقتی             | Index                                                    |
| -------- | ------------------ | --------------------------- | -------------------------------------------------------- |
| `fresh`  | نه Lease، نه Retry | همیشه                       | `ix_outbox_due_fresh (created_at, id)`                   |
| `lease`  | فقط Lease          | `claim_expires_at <= now()` | `ix_outbox_due_lease (claim_expires_at, created_at, id)` |
| `retry`  | فقط Retry          | `next_attempt_at <= now()`  | `ix_outbox_due_retry (next_attempt_at, created_at, id)`  |
| `paired` | هر دو              | `GREATEST(هر دو) <= now()`  | `ix_outbox_due_both ((GREATEST(...)), created_at, id)`   |

**هم‌ارزی اثبات شد، نه استدلال:** پنج آزمون در
`outbox-durable-claim.int-spec.ts` نشان می‌دهند اجتماع چهار جریان دقیقاً همان
مجموعهٔ شرط اصلی است — برای هر نُه حالت (هر دو NULL، Lease زنده، Lease منقضی،
Backoff آینده، Backoff سررسیده، Lease منقضی + Backoff آینده، Lease زنده +
Backoff سررسیده، ردیف منتشرشده، و مرز دقیق برابری با `now()` پایگاه داده)، با
تفاضل متقارن تهی در هر دو جهت و بدون هم‌پوشانی میان جریان‌ها.

**چرا گرفتن `limit` از هر جریان، `limit` سراسری قدیمی‌ترین را می‌دهد:** اگر
ردیفی در مجموعهٔ سراسری بود اما در `limit` اول جریان خودش نبود، آن جریان
`limit` ردیف قدیمی‌تر و واجد شرایط دارد، پس آن ردیف اصلاً در مجموعهٔ سراسری
نبود.

### هزینهٔ Index — ثبت‌شده برای بازبینی

روی Fixture ۲۰۰٬۰۰۰ ردیفی با چگالی واقعی (۲٪ Lease زنده، ۲٪ منقضی، ۵٪ Backoff):

| Index                   | اندازه     |
| ----------------------- | ---------- |
| `ix_outbox_due_fresh`   | 7528 kB    |
| `ix_outbox_due_both`    | 408 kB     |
| `ix_outbox_due_retry`   | 112 kB     |
| `ix_outbox_due_lease`   | 8192 bytes |
| **جمع چهار Index تازه** | **≈ ۸ MB** |

مجموع Index جدول از ۲۱ MB به ۲۸ MB می‌رود (**+۳۳٪**) در برابر جدول ۲۴ MB. هر
Claim و هر تمدید `claim_expires_at` را می‌نویسد، پس این نوشتن‌ها اکنون Index
بیشتری را نگه می‌دارند — این معاوضه اینجا ثبت می‌شود تا صاحب محصول ببیندش، نه
اینکه در Commit پنهان بماند.

`ix_outbox_due_fresh` بیشترین سهم را دارد چون اکثر ردیف‌ها در جریان `fresh`اند و
عملاً هم‌پوشان `ix_outbox_claimable` است. **هر دو نگه داشته شدند:** حذف
`ix_outbox_claimable` وضعیت ۵ را (که Planner همان را برای جریان `lease`
برمی‌دارد) و `oldestPendingAgeSeconds()` را بدتر می‌کند.

### تصمیم صریح دربارهٔ سه Index اولیه

`ix_outbox_claim_expiry` و `ix_outbox_next_attempt` **در مسیر Claim جدید هم
انتخاب می‌شوند** (وضعیت‌های ۳، ۴، ۵ و ۶ بالا). مستقل از آن، هر دو مصرف‌کنندهٔ
رصدی دارند که اندازه‌گیری شد:

| پرس‌وجو                                         | Index                    | Plan                | زمان         |
| ----------------------------------------------- | ------------------------ | ------------------- | ------------ |
| `rasta_outbox_leases_active` (چگالی واقعی ۰٫۵٪) | `ix_outbox_claim_expiry` | `Bitmap Index Scan` | **0.265 ms** |
| همان، بدون Index (چگالی ۵۰٪)                    | —                        | `Parallel Seq Scan` | 30.2 ms      |
| «چند ردیف در Backoff» (Runbook)                 | `ix_outbox_next_attempt` | `Index Only Scan`   | **12.3 ms**  |

**تصمیم: هر سه می‌مانند.**

## Migration — `up → down → up`

`node scripts/verify-outbox-claim-migration.mjs --in-place` روی **هر هشت**
پایگاه داده سبز: سیزده شیء (پنج ستون، پنج CHECK، سه Index) ساخته، همه حذف، و
همه بازگردانده شدند. هر پنج CHECK علاوه بر وجود، **در برابر ردیف‌هایی که باید رد
کنند** آزموده شد.

مسیر Schema جداگانه (Replay کل زنجیره) برای شش سرویس سبز است. `asset` و
`organization` از آن مسیر رد می‌شوند چون Migration **init** خودشان ستون
`geography` PostGIS دارد و Prisma مسیر جستجوی اتصال را به همان یک Schema محدود
می‌کند؛ ربطی به ADR-050 ندارد — Migration این ADR هیچ نوع PostGIS ندارد.
