# Runbook: آشتی ارجاع‌های مدرک دارایی پس از انتقال (Q-99)

> **چه زمانی.** **یک بار، پیش از وجود هر دادهٔ پایلوت یا تولید**، و در هر محیطی که پیش از `fix/asset-document-refs-on-transfer`
> انتقال مالکیت دارایی داشته است. هشدار ندارد؛ با دستور صریح اپراتور اجرا می‌شود. در پایگاه توسعه شمارش `۰` بود و هنوز
> هیچ استقرار تولیدی نیست؛ پس برای محیط‌های موجود هیچ کاری لازم نیست، و این Runbook پیش‌شرط ورود نخستین دادهٔ واقعی است.

## زمینه

انتقال A→B تا پیش از Q-99 ردیف‌های `asset_document_ref` (و ردیف‌های خط زمانی با `category = 'DOCUMENT'`) را به B می‌برد
(`organization_id` عوض می‌شد)، در حالی که `document-service` فایل را همچنان از آنِ A نگه می‌دارد. اکنون انتقال هیچ‌یک را عوض
نمی‌کند (تصمیم موقت (الف)). ردیف‌هایی که انتقال‌های **پیشین** جابه‌جا کرده‌اند همان‌جا مانده‌اند؛ این Runbook آن‌ها را پیدا
و برمی‌گرداند. هیچ Migration نیست.

## ۱. شمارش و فهرست (فقط‌خواندنی، روی پایگاه asset)

نقش اجرا کافی است؛ `default_transaction_read_only` را روشن کن.

```sql
SET default_transaction_read_only = on;

-- نامزدها: ارجاعی که پیش از یک انتقال ساخته شده و اکنون به همان سازمانِ مقصدِ آن انتقال تعلق دارد.
-- (ارجاعی که مالک جدید خودش پس از انتقال چسبانده، created_at دیرتر دارد و در این فهرست نیست.)
SELECT r.id AS ref_id, r.asset_id, r.document_id, r.organization_id AS current_org,
       t.id AS transfer_id, t.from_organization_id AS previous_org, t.transferred_at
  FROM asset_document_ref r
  JOIN asset_transfer t ON t.asset_id = r.asset_id
 WHERE r.created_at < t.transferred_at
   AND r.organization_id = t.to_organization_id
 ORDER BY r.asset_id, t.transferred_at, r.id;

-- ردیف‌های خط زمانیِ مدرک که همان انتقال برده است.
SELECT e.id AS entry_id, e.asset_id, e.organization_id AS current_org,
       t.id AS transfer_id, t.from_organization_id AS previous_org
  FROM asset_timeline_entry e
  JOIN asset_transfer t ON t.asset_id = e.asset_id
 WHERE e.category = 'DOCUMENT'
   AND e.occurred_at < t.transferred_at
   AND e.organization_id = t.to_organization_id
 ORDER BY e.asset_id, t.transferred_at, e.id;
```

فهرست خالی است ⇒ کار تمام است؛ نتیجه را در تیکت ثبت کن و به گام ۴ برو.

## ۲. تأیید با مالک مدرک (document-service)

خواندن مالک فقط از **خودِ `document-service`** است (A-01: asset-service جدول آن را نمی‌خواند). برای هر `document_id` فهرست
گام ۱، مالکِ ثبت‌شده را از پایگاه `document-service` (فقط‌خواندنی) بگیر:

```sql
SET default_transaction_read_only = on;
SELECT id, organization_id AS document_owner
  FROM document
 WHERE id = ANY (ARRAY['DOC_…', …]);   -- document_id های گام ۱
```

ارجاعِ **جابه‌جاشده** = `document_owner` با `current_org` آن ارجاع فرق دارد. (اگر برابر بود، مدرک را مالک جدید خودش ثبت
کرده بود و دست نمی‌خورد.) ارجاعی که مدرکش در `document-service` نیست را جداگانه ثبت کن؛ خودکار برنگردان.

## ۳. بازگرداندن (با نقش مهاجر، یک تراکنش، پس از مرور فهرست)

برای هر ارجاع تأییدشده: `organization_id` را به `document_owner` برگردان؛ برای ردیف‌های خط زمانیِ `DOCUMENT` آن دارایی
که گام ۱ نشان داد، به `previous_org` همان انتقال. تراکنش را با `BEGIN` باز کن، تعداد ردیف‌های تغییرکرده را با فهرست
گام ۲ مقایسه کن و فقط در صورت برابری `COMMIT` بزن.

```sql
BEGIN;
UPDATE asset_document_ref
   SET organization_id = :'document_owner'
 WHERE id = :'ref_id' AND organization_id = :'current_org';          -- یک ردیف
UPDATE asset_timeline_entry
   SET organization_id = :'previous_org'
 WHERE id = :'entry_id' AND organization_id = :'current_org';        -- یک ردیف
-- تعداد را بررسی کن؛ ناهمخوانی ⇒ ROLLBACK
COMMIT;
```

- هیچ ردیفی پاک نمی‌شود. اگر ارجاعی به دارایی‌ای اشاره می‌کند که اکنون مالک دیگری دارد، پس از بازگشت دیگر در پروندهٔ مالک
  جدید دیده نمی‌شود (درست همان رفتار Q-99) و مالک جدید مدرک خودش را می‌چسباند.
- دارایی‌ای که مالک جدیدش پیش‌تر با همان مدرکِ جابه‌جاشده فعال شده بود، اکنون پروندهٔ ناقص دارد؛ **فعال‌سازی را برنگردان**.
  وضعیت آن دارایی را به تیم محصول گزارش کن (تصمیم با صاحب محصول است، Q-99).

## ۴. تأیید و ثبت

گام ۱ را دوباره اجرا کن: هر دو فهرست باید خالی باشند. شمار ردیف‌های تغییرکرده، شناسهٔ تیکت و زمان را ثبت کن. هیچ
شناسهٔ مدرکی در پیام‌ها یا کانال‌های عمومی نگذار (شناسه‌ها فقط در تیکت).
