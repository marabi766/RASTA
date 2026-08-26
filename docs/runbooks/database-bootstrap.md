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
