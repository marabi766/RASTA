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
