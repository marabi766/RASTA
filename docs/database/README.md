# پایگاه داده

> معماری کامل در [`../05-data-architecture.md`](../05-data-architecture.md).
> راه‌اندازی و عیب‌یابی در [`../runbooks/database-bootstrap.md`](../runbooks/database-bootstrap.md).

## اصل حاکم

**مالکیت پایگاه داده به‌ازای هر سرویس (ADR-005).** هیچ جدول مشترکی، هیچ Join
میان‌سرویسی، هیچ دسترسی متقابل.

## Schemaها

هر سرویس Schema خودش را در `services/<name>/prisma/schema.prisma` دارد.
**هیچ Schema مشترکی وجود ندارد** — یک Schema مشترک، همان Shared Database است با ظاهر دیگر.

## ستون‌های استاندارد

هر جدول کسب‌وکاری این ستون‌ها را دارد:

```sql
id                TEXT PRIMARY KEY,           -- <PREFIX>_<ULID>
organization_id   TEXT NOT NULL,              -- مرز مستأجر
created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
created_by        TEXT NOT NULL,
updated_by        TEXT NOT NULL,
version           INTEGER NOT NULL DEFAULT 1, -- قفل خوش‌بینانه
deleted_at        TIMESTAMPTZ                 -- حذف نرم
```

**قاعده Index:** نخستین ستون هر Index مرکب `organization_id` است — چون هر Query با
Scope مستأجر شروع می‌شود.

## جداول الگویی (در هر سرویس)

| جدول | نقش |
| --- | --- |
| `outbox_message` | انتشار اتمیک رویداد (ADR-021) |
| `processed_event` | Idempotency مصرف‌کننده |
| `idempotency_key` | Idempotency Endpointهای تغییردهنده |
| `<entity>_ref` | Replica فقط‌خواندنی داده مرجع از رویداد |

## Migration

```bash
pnpm db:migrate                                                    # همه سرویس‌ها
pnpm --filter @rasta/asset-service db:migrate                      # یک سرویس
pnpm --filter @rasta/asset-service exec prisma migrate dev --name add_fuel_type
pnpm --filter @rasta/asset-service exec prisma migrate deploy      # در CI/CD
pnpm --filter @rasta/asset-service exec prisma studio              # مرور داده
```

### قواعد Migration

| قاعده | دلیل |
| --- | --- |
| **همیشه سازگار به عقب** در یک استقرار | Rolling Deploy: نسخه قدیم و جدید هم‌زمان زنده‌اند |
| تغییر شکننده = **Expand/Contract** در سه استقرار | افزودن ستون → نوشتن دوگانه → مهاجرت → حذف قدیم |
| هرگز `DROP COLUMN` در همان استقرار حذف استفاده | Rollback باید ممکن بماند |
| هر Migration `Down` دارد یا صریحاً بازگشت‌ناپذیر مستند شده | بازیابی از استقرار خراب |
| Migration داده به‌صورت Script جداگانه و Idempotent | Migration سنگین نباید استقرار را قفل کند |
| **هیچ Business Logic در Migration** | Migration در آینده روی داده‌ای اجرا می‌شود که قواعدش عوض شده |

## پارتیشن‌بندی

فقط برای جداولی که بی‌کران رشد می‌کنند:

| جدول | کلید | بازه | نگهداشت داغ |
| --- | --- | --- | --- |
| `ledger_entry` | `posted_at` | ماهانه | ۱۳ ماه |
| `audit_event` | `occurred_at` | ماهانه | ۱۳ ماه |
| `usage_record` | `recorded_at` | ماهانه | ۲۵ ماه |
| `asset_timeline` | `occurred_at` | ماهانه | ۲۵ ماه |

**CONSTRAINT.** پارتیشن دفتر کل و حسابرسی **هرگز DROP نمی‌شود** — فقط به Storage سرد
منتقل می‌شود.

## تضمین‌های سطح پایگاه داده

فراتر از قرارداد کد، این‌ها در خود PostgreSQL تحمیل می‌شوند:

```sql
-- تغییرناپذیری دفتر کل — Trigger قابل دور زدن نیست
CREATE TRIGGER trg_ledger_entry_immutable
  BEFORE UPDATE OR DELETE ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();

-- مبلغ همیشه مثبت؛ جهت در ستون direction
CHECK (amount_minor > 0)

-- یک تخصیص فعال به‌ازای هر راننده
CREATE UNIQUE INDEX ON assignment (driver_id) WHERE ended_at IS NULL;

-- منع درخواست تعمیر تکراری (کنترل سند محصول)
CREATE UNIQUE INDEX ON maintenance_request (asset_id, type)
  WHERE status IN ('OPEN','IN_PROGRESS');

-- منع تراکنش تکراری
CREATE UNIQUE INDEX ON transaction (idempotency_key, organization_id);
```

## PostGIS

SRID همیشه **4326 (WGS 84)**. نوع **`GEOGRAPHY`** نه `GEOMETRY` — فاصله بر حسب متر،
بدون نیاز به Reprojection. Index همیشه `GIST`.

## ERD

نمودار به‌ازای هر سرویس با Prisma تولید می‌شود:

```bash
pnpm --filter @rasta/asset-service exec prisma generate
```
