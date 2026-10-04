# Runbook: راه‌اندازی پایگاه داده

**شدت:** ⚪ عملیاتی
**کاربرد:** محیط جدید · بازسازی محیط توسعه · عیب‌یابی Migration

---

## معماری

۱۶ پایگاه داده منطقی، هر کدام با **نقش اختصاصی** — طبق ADR-005.

| سرویس        | پایگاه داده          | نقش                  | افزونه‌ها                     |
| ------------ | -------------------- | -------------------- | ----------------------------- |
| identity     | `rasta_identity`     | `rasta_identity`     | `pg_trgm`                     |
| organization | `rasta_organization` | `rasta_organization` | `postgis`, `pg_trgm`, `ltree` |
| asset        | `rasta_asset`        | `rasta_asset`        | `postgis`, `pg_trgm`          |
| fleet        | `rasta_fleet`        | `rasta_fleet`        | `postgis`                     |
| maintenance  | `rasta_maintenance`  | `rasta_maintenance`  | —                             |
| marketplace  | `rasta_marketplace`  | `rasta_marketplace`  | `pg_trgm`                     |
| procurement  | `rasta_procurement`  | `rasta_procurement`  | `pgcrypto`                    |
| supplier     | `rasta_supplier`     | `rasta_supplier`     | `pg_trgm`                     |
| inventory    | `rasta_inventory`    | `rasta_inventory`    | `postgis`                     |
| construction | `rasta_construction` | `rasta_construction` | `postgis`, `pgcrypto`         |
| contract     | `rasta_contract`     | `rasta_contract`     | —                             |
| economic     | `rasta_economic`     | `rasta_economic`     | —                             |
| notification | `rasta_notification` | `rasta_notification` | —                             |
| document     | `rasta_document`     | `rasta_document`     | —                             |
| audit        | `rasta_audit`        | `rasta_audit`        | —                             |
| analytics    | `rasta_analytics`    | `rasta_analytics`    | `postgis`                     |

به‌علاوه سه پایگاه داده زیرساختی: `keycloak`، `temporal`، `temporal_visibility`.

---

## راه‌اندازی اولیه

اسکریپت `infrastructure/docker/postgres/00-init-databases.sh` هنگام **نخستین** راه‌اندازی
Container اجرا می‌شود و نقش‌ها، پایگاه‌های داده و افزونه‌ها را می‌سازد.

```bash
pnpm infra:up
docker compose logs postgres | grep "PostgreSQL bootstrap complete"
```

سپس:

```bash
pnpm db:migrate     # Migration همه سرویس‌ها
pnpm db:seed        # داده نمایشی
```

---

## تأیید

```bash
# فهرست پایگاه‌های داده
docker compose exec postgres psql -U rasta -d postgres -c "\l" | grep rasta_

# فهرست نقش‌ها
docker compose exec postgres psql -U rasta -d postgres -c "\du" | grep rasta_

# تأیید PostGIS
docker compose exec postgres psql -U rasta -d rasta_asset \
  -c "SELECT PostGIS_Version();"

# تأیید جداسازی: نقش asset نباید به پایگاه داده economic دسترسی داشته باشد
docker compose exec postgres psql -U rasta_asset -d rasta_economic -c "SELECT 1;"
# انتظار: permission denied
```

آخرین دستور **باید شکست بخورد**. اگر موفق شود، جداسازی نقش‌ها کار نمی‌کند.

---

## مشکلات رایج

### اسکریپت init اجرا نشد

اسکریپت **فقط هنگام خالی بودن Volume** اجرا می‌شود.

```bash
docker compose down -v      # ⚠️ همه داده پاک می‌شود
docker compose up -d postgres
docker compose logs -f postgres
```

### Migration با `permission denied` شکست می‌خورد

نقش سرویس مالک پایگاه داده نیست.

```sql
ALTER DATABASE rasta_asset OWNER TO rasta_asset;
GRANT ALL ON SCHEMA public TO rasta_asset;
```

سپس بررسی کن چرا اسکریپت init این را انجام نداده.

### `extension postgis does not exist`

```bash
docker compose exec postgres psql -U rasta -d rasta_asset \
  -c "CREATE EXTENSION IF NOT EXISTS postgis;"
```

تصویر باید `postgis/postgis:16-3.4` باشد، نه `postgres:16`.

### Migration نیمه‌کاره مانده

```bash
pnpm --filter @rasta/asset-service exec prisma migrate status
pnpm --filter @rasta/asset-service exec prisma migrate resolve --rolled-back <migration>
```

**در Production هرگز `migrate reset` نزن.**

<a id="marketplace-order-key-index"></a>

### marketplace: شکست Migrationهای یکتایی کلید سفارش

دو Migration پشت سر هم: `20260929120000_order_idempotency_key_precheck` (بررسی
تکراری‌ها) و `20260929120100_order_idempotency_key_unique` (ساخت
`uq_order_org_idempotency_key` با `CONCURRENTLY`).

**«اصلاح کن و دوباره Deploy کن» کار نمی‌کند.** Prisma رکورد Migration شکست‌خورده
را در `_prisma_migrations` نگه می‌دارد و تا Resolve نشود، هر `migrate deploy` با
`P3009` رد می‌شود — حتی پس از رفع علت. ترتیب زیر، و فقط همین ترتیب.

همه دستورها از ریشه Repository؛ اتصال همان است که `db:migrate` برمی‌دارد
(`DATABASE_URL_MARKETPLACE_MIGRATOR` یا `DATABASE_URL_MARKETPLACE`):

```bash
PRISMA="pnpm --filter @rasta/marketplace-service exec node ../../scripts/prisma.mjs"
```

#### الف) Pre-check روی تکراری‌ها شکست خورد

نشانه: `P3018` با پیام `… pairs hold more than one order, so uq_order_org_idempotency_key cannot be built`.
چیزی ساخته نشده است.

۱. تکراری‌ها را ببین — هر سطر سفارشی است که دوبار با یک کلید ثبت شده؛ یک رخداد
کسب‌وکاری است و جدا بررسی می‌شود:

```sql
SELECT organization_id, idempotency_key, array_agg(id ORDER BY created_at, id)
  FROM "order" GROUP BY 1, 2 HAVING count(*) > 1;
```

۲. کلید همه به‌جز قدیمی‌ترین سفارش هر جفت را با شناسهٔ خودش پسوند بزن. **هیچ سفارشی
حذف نمی‌شود:**

```sql
UPDATE "order" AS o
   SET idempotency_key = o.idempotency_key || '#duplicate-' || o.id
  FROM (SELECT id, row_number() OVER (PARTITION BY organization_id, idempotency_key
                                      ORDER BY created_at, id) AS n
          FROM "order") AS ranked
 WHERE ranked.id = o.id AND ranked.n > 1;
```

۳. رکورد شکست را Resolve کن، سپس Deploy:

```bash
$PRISMA migrate resolve --rolled-back 20260929120000_order_idempotency_key_precheck
pnpm --filter @rasta/marketplace-service db:migrate
```

#### ب) ساخت `CONCURRENTLY` شکست خورد

نشانه: `P3018` روی `20260929120100_order_idempotency_key_unique`، مثلاً
`could not create unique index "uq_order_org_idempotency_key"` (تکراری‌ای که پس از
Pre-check رسید) یا لغو/Timeout. یک Index با وضعیت **INVALID** باقی می‌ماند که هیچ
چیزی را تضمین نمی‌کند و نام را اشغال کرده است.

۱. علت را رفع کن (برای تکراری: گام‌های ۱ و ۲ از «الف»).

۲. Index نامعتبر را حذف کن — تنها، بیرون از تراکنش (`CONCURRENTLY` درون تراکنش
اجرا نمی‌شود):

```bash
echo 'DROP INDEX CONCURRENTLY IF EXISTS "uq_order_org_idempotency_key";' \
  | $PRISMA db execute --schema prisma/schema.prisma --stdin
```

اگر این گام جا بیفتد، Deploy بعدی با `relation "uq_order_org_idempotency_key" already exists`
شکست می‌خورد: Migration عمداً `IF NOT EXISTS` ندارد تا Index نامعتبر به‌جای Index
واقعی پذیرفته نشود.

۳. رکورد شکست را Resolve کن، سپس Deploy:

```bash
$PRISMA migrate resolve --rolled-back 20260929120100_order_idempotency_key_unique
pnpm --filter @rasta/marketplace-service db:migrate
```

۴. تأیید: `indisvalid` باید `true` باشد.

```sql
SELECT i.indisvalid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
 WHERE c.relname = 'uq_order_org_idempotency_key';
```

هر دو ترتیب در PR #141 روی یک Schema دور‌ریختنی اجرا و تأیید شده‌اند: شکست
تحمیلی، `P3009` پیش از Resolve، `already exists` بدون Drop، و سپس Deploy موفق با
Index معتبر و بدون از دست رفتن هیچ سفارشی.

---

<a id="marketplace-idempotency-claim-token"></a>

### marketplace: توکن Claim کلید Idempotency (#147)

Migration `20260930120000_idempotency_claim_token` ستون `idempotency_key.claim_token` را
اضافه می‌کند و کد جدید `complete`/`release` را فقط با همین توکن می‌پذیرد.

**این تغییر برای Rolling Update امن نیست.** همهٔ نمونه‌های قدیمی marketplace-service را
متوقف کن (Scale به صفر)، سپس نمونه‌های جدید را بالا بیاور؛ نسخهٔ قدیم و جدید هرگز
همزمان اجرا نشوند. نمونهٔ قدیمی `complete`/`release` را بدون توکن انجام می‌دهد و
می‌تواند Claim نمونهٔ جدید را آزاد یا کامل کند.

<a id="identity-one-live-membership"></a>

### identity: یک عضویت زنده برای هر کاربر و سازمان (#219)

سه Migration پشت سر هم:

| Migration                                          | کار                                                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `20261004100000_membership_live_duplicates_guard`  | اگر از یک ساخت ناموفق Index **INVALID** مانده باشد، آن را حذف می‌کند؛ سپس اگر تکراری زنده باشد، رد می‌کند |
| `20261004100100_membership_one_live_index`         | `ux_membership_live_user_org` را با `CONCURRENTLY` و **بدون** `IF NOT EXISTS` می‌سازد                     |
| `20261004100200_drop_membership_deleted_at_unique` | کلید قدیمی `membership_user_id_organization_id_deleted_at_key` را با `CONCURRENTLY` حذف می‌کند            |

عضویت یک مجوز دسترسی است: هیچ‌کدام از این Migrationها و هیچ گامی در این بخش، عضویتی را حذف یا ادغام
نمی‌کند. تکراری فقط از مسیر لغو عضویت (که ثبت می‌کند چه کسی و چرا) برطرف می‌شود.

همه دستورها از ریشه Repository، با اتصال مالک (`DATABASE_URL_IDENTITY_MIGRATOR`):

```bash
PRISMA="pnpm --filter @rasta/identity-service exec node ../../scripts/prisma.mjs"
```

#### الف) نگهبان روی تکراری‌ها شکست خورد

نشانه: `P3018` روی `20261004100000_membership_live_duplicates_guard` با پیام
`… pair(s) hold more than one live membership; refusing to add ux_membership_live_user_org`.
چیزی ساخته نشده است.

۱. تکراری‌ها را ببین (همان پرسشی که `HINT` می‌دهد):

```sql
SELECT user_id, organization_id, array_agg(id ORDER BY created_at)
  FROM membership WHERE deleted_at IS NULL GROUP BY 1, 2 HAVING count(*) > 1;
```

۲. برای هر جفت، تصمیم بگیر کدام عضویت بماند و بقیه را از **مسیر لغو** (`POST /v1/memberships/:id/revoke`)
لغو کن — هرگز با `DELETE`.

۳. رکورد شکست را Resolve کن، سپس Deploy:

```bash
$PRISMA migrate resolve --rolled-back 20261004100000_membership_live_duplicates_guard
pnpm --filter @rasta/identity-service db:migrate
```

#### ب) ساخت `CONCURRENTLY` شکست خورد

نشانه: `P3018` روی `20261004100100_membership_one_live_index`، مثلاً
`could not create unique index "ux_membership_live_user_org"` (تکراری‌ای که میان نگهبان و ساخت رسید) یا
لغو/Timeout. Index با وضعیت **INVALID** می‌ماند: هیچ چیزی را تضمین نمی‌کند و نام را اشغال کرده است. تا
Resolve نشود، هر Deploy با `P3009` رد می‌شود.

Prisma فقط Migration شکست‌خورده را دوباره اجرا می‌کند، و `CONCURRENTLY` نمی‌تواند با دستور دیگری در یک
فایل بنشیند. پس حذف Index نامعتبر و بررسی دوبارهٔ تکراری‌ها در **نگهبان** است، و بازیابی نگهبان را هم
دوباره اجرا می‌کند:

۱. تکراری را برطرف کن (گام‌های ۱ و ۲ از «الف»).

۲. ردیف دفتر نگهبان را بردار تا Deploy بعدی دوباره اجرایش کند — `down.sql` خود نگهبان فقط همین کار را
می‌کند:

```bash
$PRISMA db execute --schema prisma/schema.prisma \
  --file prisma/migrations/20261004100000_membership_live_duplicates_guard/down.sql
```

۳. رکورد شکست ساخت را Resolve کن، سپس Deploy. نگهبان Index نامعتبر را حذف می‌کند، تکراری‌ها را دوباره
می‌شمارد، و ساخت از صفر انجام می‌شود:

```bash
$PRISMA migrate resolve --rolled-back 20261004100100_membership_one_live_index
pnpm --filter @rasta/identity-service db:migrate
```

اگر گام ۲ جا بیفتد، Deploy با `relation "ux_membership_live_user_org" already exists` شکست می‌خورد:
ساخت عمداً `IF NOT EXISTS` ندارد تا Index نامعتبر هرگز به‌جای Index واقعی پذیرفته نشود — Migration بعدی
کلید قدیمی را به اعتبار همین Index حذف می‌کند. در آن صورت دوباره Resolve کن و از گام ۲ ادامه بده.

۴. تأیید: `indisvalid` باید `true` باشد.

```sql
SELECT i.indisvalid FROM pg_index i
 WHERE i.indexrelid = to_regclass('ux_membership_live_user_org');
```

همین مسیر — شکست واقعی ساخت، `P3009`، `already exists` بدون اجرای دوبارهٔ نگهبان، و بازیابی تا Index
معتبر بدون حذف هیچ عضویتی — در `pnpm test:migration` اجرا می‌شود (`IDENTITY_DATA_ROLLBACK`،
`scripts/verify-migration-reversible-lib.mjs`).

#### ج) بازگرداندن: `down.sql` کلید قدیمی را بدون `CONCURRENTLY` می‌سازد

`20261004100200_drop_membership_deleted_at_unique/down.sql` یک تراکنش است: باید ردیف دفتر خودش را هم حذف
کند، و `CONCURRENTLY` نمی‌تواند با دستور دیگری در یک اسکریپت بنشیند (اجراکنندهٔ `down.sql` هر فایل را یک
تراکنش ضمنی اجرا می‌کند). پس ساختش قفل `SHARE` روی `membership` می‌گیرد: **خواندن ادامه دارد، نوشتن —
افزودن، لغو و تغییر نقش عضویت، و تأیید ثبت‌نام — تا پایان ساخت منتظر می‌ماند.** `lock_timeout = 5s` فقط
انتظار برای گرفتن قفل را محدود می‌کند، نه طول ساخت را.

مرز اندازه‌گیری‌شده (PostgreSQL 16، چهار هسته، `maintenance_work_mem` پیش‌فرض، همین سه ستون):
۱۰۰٬۰۰۰ ردیف حدود ۰٫۱ ثانیه، ۱٬۰۰۰٬۰۰۰ ردیف حدود ۱٫۷ ثانیه. این عدد روی سخت‌افزار تولید باید دوباره
سنجیده شود؛ تعداد ردیف را با `SELECT count(*) FROM membership;` ببین.

برای اینکه هیچ نوشتنی منتظر نماند، پیش از `down.sql` این را **تنها و بیرون از هر تراکنش** اجرا کن؛
`IF NOT EXISTS` در `down.sql` آن را ساخته‌شده می‌یابد و فقط ردیف دفتر را حذف می‌کند:

```bash
echo 'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "membership_user_id_organization_id_deleted_at_key" ON "membership" ("user_id", "organization_id", "deleted_at");' \
  | $PRISMA db execute --schema prisma/schema.prisma --stdin
```

اگر این ساخت شکست بخورد، Index نامعتبر می‌ماند. `down.sql` آن را نمی‌پذیرد و با
`… is INVALID; refusing to roll back onto it` رد می‌کند؛ آن را **تنها** حذف کن و دوباره بساز:

```bash
echo 'DROP INDEX CONCURRENTLY "membership_user_id_organization_id_deleted_at_key";' \
  | $PRISMA db execute --schema prisma/schema.prisma --stdin
```

---

## بازسازی کامل محیط توسعه

```bash
docker compose down -v
docker compose up -d
# صبر تا سالم شدن postgres
pnpm db:migrate
pnpm db:seed
```

**⚠️ فقط در توسعه.** `-v` همه Volumeها را حذف می‌کند.

---

## افزودن سرویس جدید

1. سرویس را به آرایه `SERVICES` در `00-init-databases.sh` اضافه کن
2. اگر GIS لازم دارد، به حلقه PostGIS اضافه کن
3. `DATABASE_URL_<NAME>` را به `.env.example` اضافه کن
4. برای محیط موجود، دستی بساز:

```sql
CREATE ROLE rasta_newservice LOGIN PASSWORD '<از env>';
CREATE DATABASE rasta_newservice OWNER rasta_newservice ENCODING 'UTF8';
REVOKE ALL ON DATABASE rasta_newservice FROM PUBLIC;
GRANT ALL PRIVILEGES ON DATABASE rasta_newservice TO rasta_newservice;
```

---

## نکته امنیتی

هر سرویس **فقط** با اعتبارنامه خودش به پایگاه داده خودش وصل می‌شود.
اگر سرویسی از اعتبارنامه Superuser استفاده کند، مرز ADR-005 شکسته است — این باید در
بازبینی کد گرفته شود.

---

## پورت میزبان: ۵۴۳۳ نه ۵۴۳۲

Rasta پایگاه داده خود را روی **پورت ۵۴۳۳** میزبان نگاشت می‌کند.

**چرا؟** داشتن یک PostgreSQL نصب‌شده روی خود ویندوز/لینوکس که پورت ۵۴۳۲ را گرفته
باشد، روی ماشین توسعه‌دهنده رایج است. تعارض **بی‌صدا** است: Docker همچنان بالا
می‌آید (چون فقط روی IPv6 Bind می‌شود) اما اتصال از میزبان به **سرور اشتباه**
می‌رسد. علامت آن یک خطای گمراه‌کننده است:

```
P1000: Authentication failed against database server,
the provided database credentials for `rasta_identity` are not valid.
```

اعتبارنامه درست است؛ سرور اشتباه است.

### تشخیص

```bash
# ویندوز
netstat -ano | findstr :5432
# لینوکس / مک
sudo lsof -i :5432
```

اگر فرایندی غیر از `com.docker.backend` دیده شد، همین تعارض است.

### تأیید اینکه به Container وصل شده‌اید

```bash
docker exec rasta-postgres psql -U rasta -d postgres -tAc "SHOW port"
```

### تغییر پورت

`POSTGRES_PORT` در `.env` و همه `DATABASE_URL_*`ها را هماهنگ تغییر دهید.
