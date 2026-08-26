# ۰۵ — Data Architecture

> مالکیت داده، Schema، Index، پارتیشن، نگهداشت و مهاجرت. قاعده حاکم: **Database Ownership per
> Service**. هیچ جدول مشترکی وجود ندارد، هیچ Join میان‌سرویسی وجود ندارد.

---

## ۵٫۱ مالکیت داده

هر سرویس یک پایگاه داده منطقی با نقش اختصاصی خودش دارد:

| سرویس           | پایگاه داده           | نقش پایگاه داده        | افزونه‌ها               |
| --------------- | --------------------- | ---------------------- | ----------------------- |
| identity        | `rasta_identity`      | `rasta_identity`       | `pg_trgm`               |
| organization    | `rasta_organization`  | `rasta_organization`   | `postgis`, `pg_trgm`, `ltree` |
| asset           | `rasta_asset`         | `rasta_asset`          | `postgis`, `pg_trgm`    |
| fleet           | `rasta_fleet`         | `rasta_fleet`          | `postgis`               |
| maintenance     | `rasta_maintenance`   | `rasta_maintenance`    | —                       |
| marketplace     | `rasta_marketplace`   | `rasta_marketplace`    | `pg_trgm`               |
| procurement     | `rasta_procurement`   | `rasta_procurement`    | `pgcrypto`              |
| supplier        | `rasta_supplier`      | `rasta_supplier`       | `pg_trgm`               |
| inventory       | `rasta_inventory`     | `rasta_inventory`      | `postgis`               |
| construction    | `rasta_construction`  | `rasta_construction`   | `postgis`, `pgcrypto`   |
| contract        | `rasta_contract`      | `rasta_contract`       | —                       |
| economic        | `rasta_economic`      | `rasta_economic`       | —                       |
| notification    | `rasta_notification`  | `rasta_notification`   | —                       |
| document        | `rasta_document`      | `rasta_document`       | —                       |
| audit           | `rasta_audit`         | `rasta_audit`          | —                       |
| analytics       | `rasta_analytics`     | `rasta_analytics`      | `postgis`               |

**MVP → PRODUCTION.**
MVP: ۱۶ پایگاه داده روی یک Cluster PostgreSQL؛ هر کدام با نقش و اعتبارنامه اختصاصی و
`REVOKE ALL ... FROM PUBLIC`. جداسازی منطقی از روز اول **کامل** است.
Production: تفکیک به چند Cluster بر مبنای پروفایل بار — `economic` و `audit` (نوشتن‌سنگین،
حساس) روی Cluster اختصاصی. چون هیچ کدی به Cross-Database Join وابسته نیست، این تغییر
Connection String است، نه بازطراحی.

اسکریپت راه‌اندازی: [`infrastructure/docker/postgres/00-init-databases.sh`](../infrastructure/docker/postgres/00-init-databases.sh)

---

## ۵٫۲ ستون‌های استاندارد

هر جدول کسب‌وکاری این ستون‌ها را دارد — بدون استثنا:

```sql
id                TEXT PRIMARY KEY,           -- <PREFIX>_<ULID>
organization_id   TEXT NOT NULL,              -- مرز مستأجر (جز جداول سراسری)
created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
created_by        TEXT NOT NULL,              -- USR_<ULID> یا 'SYSTEM'
updated_by        TEXT NOT NULL,
version           INTEGER NOT NULL DEFAULT 1, -- قفل خوش‌بینانه
deleted_at        TIMESTAMPTZ                 -- حذف نرم؛ NULL = فعال
```

**قواعد:**

| قاعده                                                                                       | چرا                                                                    |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `organization_id` روی **هر** جدول مستأجرمحور، حتی جداول فرزند                                 | Join برای Scope کردن، یک نشتی منتظر وقوع است. ستون تکراری ارزان است.    |
| نخستین ستون هر Index مرکب `organization_id` است                                              | هر Query با Scope شروع می‌شود؛ Index باید همان الگو را داشته باشد.      |
| `version` برای قفل خوش‌بینانه در Aggregateهای رقابتی                                          | جلوگیری از Lost Update بدون قفل بدبینانه                                |
| حذف نرم پیش‌فرض؛ حذف سخت فقط با Runbook                                                       | سوابق مالی و حسابرسی نباید ناپدید شوند                                  |
| `deleted_at` در هر Unique Index جزئی لحاظ می‌شود                                             | تا رکورد حذف‌شده مانع ثبت مجدد نشود                                     |

**استثناها (بدون `organization_id`):** `organization` (خودش مستأجر است)، `user` (هویت
فرامستأجری است؛ Scope از راه `membership` می‌آید)، `role`، `permission`، `commission_rule`
و `reward_rule` (سراسری، با امکان Override سازمانی)، `audit_event` (دارد اما فقط برای فیلتر).

---

## ۵٫۳ الگوهای کلیدی Schema

### الگوی Outbox (در هر سرویس منتشرکننده رویداد)

```sql
CREATE TABLE outbox_message (
  id              TEXT PRIMARY KEY,
  aggregate_type  TEXT NOT NULL,
  aggregate_id    TEXT NOT NULL,
  event_name      TEXT NOT NULL,
  event_version   INTEGER NOT NULL DEFAULT 1,
  topic           TEXT NOT NULL,
  partition_key   TEXT NOT NULL,          -- معمولاً aggregate_id → تضمین ترتیب
  payload         JSONB NOT NULL,
  headers         JSONB NOT NULL,
  organization_id TEXT,
  correlation_id  TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at    TIMESTAMPTZ,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT
);

-- Relay فقط منتشرنشده‌ها را می‌خواند؛ Index جزئی کوچک و داغ می‌ماند.
CREATE INDEX idx_outbox_pending ON outbox_message (created_at)
  WHERE published_at IS NULL;
```

### الگوی Idempotency (در هر سرویس با Endpoint تغییردهنده)

```sql
CREATE TABLE idempotency_key (
  key             TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  endpoint        TEXT NOT NULL,
  request_hash    TEXT NOT NULL,   -- SHA-256 بدنه نرمال‌شده
  response_status INTEGER,
  response_body   JSONB,
  state           TEXT NOT NULL,   -- IN_PROGRESS | COMPLETED
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (organization_id, endpoint, key)
);
CREATE INDEX idx_idem_expiry ON idempotency_key (expires_at);
```

**رفتار:** کلید تکراری با همان `request_hash` → پاسخ ذخیره‌شده. کلید تکراری با Hash متفاوت →
`IDEMPOTENCY_KEY_REUSED` (۴۰۹). حالت `IN_PROGRESS` هم‌زمان → ۴۰۹ با `Retry-After`.

### الگوی Inbox (در هر Consumer رویداد)

```sql
CREATE TABLE processed_event (
  event_id      TEXT PRIMARY KEY,   -- از Envelope
  consumer_name TEXT NOT NULL,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, consumer_name)
);
```

Consumer پیش از پردازش درج می‌کند؛ نقض کلید یکتا = رویداد تکراری = رد بی‌صدا.
این تضمین Idempotency را از «امیدواری» به «Invariant پایگاه داده» تبدیل می‌کند.

### الگوی Replica مرجع (فقط‌خواندنی، از رویداد)

```sql
CREATE TABLE organization_ref (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL,
  status       TEXT NOT NULL,
  synced_at    TIMESTAMPTZ NOT NULL,
  source_event TEXT NOT NULL
);
```

**CONSTRAINT.** این جدول **هرگز** مبنای تصمیم مجوزدهی نیست. مجوزدهی از JWT و `identity` می‌آید.

---

## ۵٫۴ مدل داده دفتر کل (بحرانی‌ترین بخش)

```sql
CREATE TABLE ledger_account (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  account_type    TEXT NOT NULL,     -- ASSET|LIABILITY|EQUITY|REVENUE|EXPENSE
  account_code    TEXT NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'IRR',
  status          TEXT NOT NULL DEFAULT 'ACTIVE',
  UNIQUE (organization_id, account_code, currency)
);

CREATE TABLE journal (
  id              TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  transaction_id  TEXT,
  journal_type    TEXT NOT NULL,
  description     TEXT NOT NULL,
  posted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  reverses_id     TEXT REFERENCES journal(id),   -- برای Reversal
  correlation_id  TEXT NOT NULL
);

CREATE TABLE ledger_entry (
  id              TEXT PRIMARY KEY,
  journal_id      TEXT NOT NULL REFERENCES journal(id),
  account_id      TEXT NOT NULL REFERENCES ledger_account(id),
  organization_id TEXT NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_minor    BIGINT NOT NULL CHECK (amount_minor > 0),
  currency        TEXT NOT NULL,
  posted_at       TIMESTAMPTZ NOT NULL DEFAULT now()
) PARTITION BY RANGE (posted_at);
```

### تضمین تغییرناپذیری در سطح پایگاه داده

```sql
CREATE OR REPLACE FUNCTION reject_ledger_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'ledger_entry is append-only. Correct with a reversal journal, never UPDATE/DELETE.';
END; $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ledger_entry_immutable
  BEFORE UPDATE OR DELETE ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
```

**چرا در پایگاه داده و نه فقط در کد؟** چون یک اسکریپت اصلاحی، یک ORM بدقلق یا یک توسعه‌دهنده
عجول می‌تواند لایه Domain را دور بزند. Trigger نمی‌تواند دور زده شود.

### تضمین توازن

```sql
-- در پایان تراکنش Post، این باید همیشه صفر برگرداند:
SELECT journal_id
FROM ledger_entry
GROUP BY journal_id, currency
HAVING SUM(CASE WHEN direction='DEBIT' THEN amount_minor ELSE -amount_minor END) <> 0;
```

این پرس‌وجو هم در تست یکپارچگی مالی و هم در Health Check دوره‌ای اجرا می‌شود.

---

## ۵٫۵ راهبرد Index

قاعده: **هر Index باید یک Query واقعی را توجیه کند.** Index بدون Query، هزینه نوشتن است.

| جدول                 | Index                                                                    | Query پشتیبان                         |
| -------------------- | ------------------------------------------------------------------------ | ------------------------------------- |
| `asset`              | `(organization_id, status, asset_type)`                                  | فهرست دارایی داشبورد ناوگان           |
| `asset`              | `GIN (search_vector)` — `pg_trgm`                                        | جست‌وجوی متنی دارایی                  |
| `asset_location`     | `GIST (location)`                                                        | «دارایی‌های نزدیک این پروژه»          |
| `usage_record`       | `(organization_id, asset_id, recorded_at DESC)`                          | تاریخچه کارکرد دستگاه                 |
| `assignment`         | `UNIQUE (driver_id) WHERE ended_at IS NULL`                              | **Invariant:** یک تخصیص فعال به راننده |
| `maintenance_request`| `UNIQUE (asset_id, type) WHERE status IN ('OPEN','IN_PROGRESS')`          | **کنترل سند: منع درخواست تکراری**     |
| `maintenance_request`| `(organization_id, status, due_date)`                                    | سررسیدهای پیش رو                      |
| `order`              | `(organization_id, status, created_at DESC)`                             | فهرست سفارش‌ها                        |
| `order`              | `(supplier_organization_id, status, created_at DESC)`                    | نمای تأمین‌کننده                      |
| `bid`                | `UNIQUE (tender_id, contractor_id)`                                      | یک پیشنهاد به‌ازای هر پیمانکار        |
| `bid`                | `(tender_id, submitted_at)`                                              | ترتیب دریافت — الزام حسابرسی          |
| `ledger_entry`       | `(account_id, posted_at DESC)`                                           | صورت‌حساب                             |
| `ledger_entry`       | `(journal_id)`                                                           | بررسی توازن                           |
| `wallet`             | `UNIQUE (organization_id, currency)`                                     | یک کیف پول به‌ازای هر ارز             |
| `transaction`        | `UNIQUE (idempotency_key, organization_id)`                              | **Invariant:** منع تراکنش تکراری      |
| `audit_event`        | `(organization_id, occurred_at DESC)` + `(actor_id, occurred_at DESC)`   | جست‌وجوی حسابرسی                      |
| `outbox_message`     | `(created_at) WHERE published_at IS NULL`                                | Relay                                 |
| `organization`       | `GIST (path)` — `ltree`                                                  | زیردرخت سلسله‌مراتب                   |

---

## ۵٫۶ راهبرد پارتیشن‌بندی

پارتیشن فقط برای جداولی که **بی‌کران رشد می‌کنند**:

| جدول                | کلید پارتیشن  | بازه   | نگهداشت داغ        |
| ------------------- | ------------- | ------ | ------------------ |
| `ledger_entry`      | `posted_at`   | ماهانه | ۱۳ ماه، سپس آرشیو  |
| `audit_event`       | `occurred_at` | ماهانه | ۱۳ ماه، سپس آرشیو  |
| `usage_record`      | `recorded_at` | ماهانه | ۲۵ ماه             |
| `asset_timeline`    | `occurred_at` | ماهانه | ۲۵ ماه             |
| `tracking_event`    | `occurred_at` | ماهانه | ۷ ماه              |
| `outbox_message`    | —             | —      | پاکسازی پس از ۷ روز از انتشار |

**MVP → PRODUCTION.** MVP: پارتیشن‌ها با یک Migration برای ۱۸ ماه پیش‌ساخته می‌شوند.
Production: `pg_partman` برای ایجاد و بایگانی خودکار.

**CONSTRAINT.** پارتیشن دفتر کل و حسابرسی **هرگز DROP نمی‌شود** — فقط به Storage سرد
منتقل می‌شود. سیاست نگهداشت نهایی **OPEN QUESTION** است (پیش‌فرض موقت ۷ سال).

---

## ۵٫۷ داده جغرافیایی (PostGIS)

| موجودیت                  | ستون                          | کاربرد                                        |
| ------------------------ | ----------------------------- | --------------------------------------------- |
| `organization_location`  | `GEOGRAPHY(Point, 4326)`      | مکان سازمان؛ داشبورد نقشه‌ای استانداری        |
| `asset_location`         | `GEOGRAPHY(Point, 4326)`      | آخرین موقعیت دارایی                           |
| `project`                | `GEOGRAPHY(Polygon, 4326)`    | محدوده عملیات پروژه                           |
| `warehouse`              | `GEOGRAPHY(Point, 4326)`      | یافتن نزدیک‌ترین انبار                        |
| `shipment_leg`           | `GEOGRAPHY(LineString, 4326)` | مسیر حمل                                      |

**SRID همیشه 4326 (WGS 84).** نوع `GEOGRAPHY` نه `GEOMETRY` — فاصله بر حسب متر و بدون
نیاز به Reprojection. Index همیشه `GIST`.

پرس‌وجوی کلیدی محصول («کدام ماشین‌آلات نزدیک این پروژه آزادند»):

```sql
SELECT a.id, ST_Distance(al.location, p.area::geography) AS distance_m
FROM asset_location al
JOIN asset a ON a.id = al.asset_id
WHERE a.organization_id = $1
  AND a.status = 'ACTIVE'
  AND ST_DWithin(al.location, $2::geography, $3)
ORDER BY distance_m;
```

---

## ۵٫۸ راهبرد Migration

| قاعده                                                                                       | دلیل                                                             |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| هر سرویس Migrationهای مستقل خودش را دارد (`prisma/migrations/`)                              | مالکیت داده                                                      |
| Migration **همیشه سازگار به عقب** در یک استقرار                                              | Rolling Deploy: نسخه قدیم و جدید هم‌زمان زنده‌اند                |
| تغییر شکننده = **الگوی Expand/Contract** در سه استقرار                                       | افزودن ستون → نوشتن دوگانه → مهاجرت داده → حذف ستون قدیم         |
| هرگز `DROP COLUMN` در همان استقراری که استفاده‌اش حذف شده                                    | Rollback باید ممکن بماند                                         |
| هر Migration باید **Down** داشته باشد یا صریحاً به‌عنوان بازگشت‌ناپذیر مستند شود              | بازیابی از استقرار خراب                                          |
| Migration داده (نه Schema) به‌صورت Script جداگانه و Idempotent                                | Migration سنگین نباید استقرار را قفل کند                         |
| Migration هرگز Business Logic ندارد                                                          | Migration در آینده روی داده‌ای اجرا می‌شود که قواعدش عوض شده      |

```bash
pnpm --filter @rasta/asset-service exec prisma migrate dev --name add_asset_decommission_reason
pnpm --filter @rasta/asset-service exec prisma migrate deploy   # در CI/CD
```

---

## ۵٫۹ Cache (Redis)

| داده                         | کلید                                  | TTL     | ابطال                    |
| ---------------------------- | ------------------------------------- | ------- | ------------------------ |
| مجوزهای مؤثر کاربر           | `perm:{userId}:{orgId}`               | ۶۰ ثانیه | رویداد `ROLE_*`          |
| فراداده سازمان               | `org:{orgId}`                         | ۵ دقیقه | رویداد `ORGANIZATION_*`  |
| JWKS                         | `jwks:{issuer}`                       | ۱ ساعت  | خطای اعتبارسنجی          |
| سبد خرید                     | `cart:{orgId}:{userId}`               | ۷ روز   | ثبت سفارش                |
| شمارنده Rate Limit           | `rl:{scope}:{key}`                    | پنجره   | خودکار                   |
| قفل توزیع‌شده                | `lock:{resource}`                     | ۳۰ ثانیه | آزادسازی صریح            |
| پاسخ Idempotency (لایه Gateway)| `idem:{orgId}:{key}`                | ۲۴ ساعت | خودکار                   |

**هرگز Cache نمی‌شود — CONSTRAINT:**

```
🚫 موجودی کیف پول            — همیشه از پایگاه داده با قفل ردیف
🚫 ورودی دفتر کل و مانده      — مرجع حقیقت مالی
🚫 نتیجه بررسی مجوز سطح Object — فقط مجوزهای عمومی نقش Cache می‌شوند
🚫 محتوای پیشنهاد مناقصه پیش از مهلت
🚫 هر داده‌ای بدون پیشوند مستأجر در کلید
```

**قاعده کلید مستأجر.** هر کلید Cache حاوی داده مستأجر **باید** `{orgId}` داشته باشد.
یک تست اختصاصی این را در CI بررسی می‌کند.

---

## ۵٫۱۰ Backup و نگهداشت

| مورد                | MVP                                | Production                                       |
| ------------------- | ---------------------------------- | ------------------------------------------------ |
| Backup کامل         | روزانه، `pg_dump`، محلی            | روزانه به Object Storage، رمزنگاری‌شده           |
| Point-in-Time       | ندارد                              | WAL Archiving، **RPO ≤ ۵ دقیقه**                 |
| RTO هدف             | ساعت‌ها (محیط توسعه)               | ≤ ۱ ساعت (`economic`)، ≤ ۴ ساعت (بقیه)           |
| تست Restore         | دستی                               | **ماهانه و خودکار** — Backup تست‌نشده Backup نیست |
| نگهداشت Backup      | ۷ روز                              | ۳۰ روز روزانه + ۱۲ ماه ماهانه                    |

تفصیل و Runbook: [`12-deployment-architecture.md`](12-deployment-architecture.md) و [`runbooks/`](runbooks/)

---

## ۵٫۱۱ حریم خصوصی و طبقه‌بندی داده

| طبقه            | نمونه                                          | کنترل                                                       |
| --------------- | ---------------------------------------------- | ----------------------------------------------------------- |
| **عمومی**       | فهرست کالا، مناقصه منتشرشده                    | بدون محدودیت                                                |
| **داخلی**       | مشخصات دارایی، سوابق تعمیر                     | محدود به مستأجر                                             |
| **محرمانه**     | قیمت پیشنهادی، صورت‌وضعیت، موجودی کیف پول       | محدود به طرفین؛ در Log ظاهر نمی‌شود                         |
| **حساس شخصی**   | کد ملی، شماره تماس، مدارک هویتی                | رمزنگاری در حالت سکون (`pgcrypto`)؛ دسترسی با Audit          |
| **بحرانی**      | پیشنهاد مناقصه پیش از مهلت                     | رمزنگاری؛ **غیرقابل مشاهده حتی برای اپراتور پلتفرم**        |

**CONSTRAINT.** داده حساس شخصی هرگز در Log، URL، پیام خطا یا Payload رویداد ظاهر نمی‌شود.
رویدادها **شناسه** حمل می‌کنند، نه داده شخصی. Consumer در صورت نیاز از API می‌گیرد.

**OPEN QUESTION.** الزامات محلی‌سازی داده و سیاست نگهداشت — نیازمند تصمیم حقوقی.
