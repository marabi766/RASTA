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

نقش اجرا کافی است؛ `default_transaction_read_only` را روشن کن. نامزد = هر ارجاعی که **پس از ساخته‌شدنش** دارایی دست‌کم
یک بار منتقل شده است (انتقال قدیمی همهٔ ردیف‌های آن دارایی را به مقصد می‌برد، پس بعد از A→B→C همه نزد C هستند و بعد از
A→B→A همه نزد A). این که کدام واقعاً جابه‌جا شده، **فقط** مالکِ مدرک در `document-service` تعیین می‌کند (گام ۲)؛ نه مبدأ یک
انتقال مشخص. هر ارجاع با ردیف خط زمانیِ خودش جفت است: `asset_timeline_entry.source_event_id = asset_document_ref.id`
(همان دارایی، `category = 'DOCUMENT'`).

```sql candidates
SET default_transaction_read_only = on;

SELECT r.id AS ref_id, r.asset_id, r.document_id, r.organization_id AS current_org,
       e.id AS entry_id, e.organization_id AS entry_org
  FROM asset_document_ref r
  LEFT JOIN asset_timeline_entry e
         ON e.asset_id = r.asset_id AND e.source_event_id = r.id AND e.category = 'DOCUMENT'
 WHERE EXISTS (SELECT 1 FROM asset_transfer t
                WHERE t.asset_id = r.asset_id AND r.created_at < t.transferred_at)
 ORDER BY r.asset_id, r.created_at, r.id;
```

فهرست خالی است ⇒ کار تمام است؛ نتیجه را در تیکت ثبت کن و به گام ۴ برو. ردیف‌های خط زمانیِ `DOCUMENT` که ارجاعی ندارند را با
پرسش زیر بیاب و جداگانه ثبت کن؛ خودکار برنگردان:

```sql orphans
SELECT e.id AS entry_id, e.asset_id, e.organization_id
  FROM asset_timeline_entry e
 WHERE e.category = 'DOCUMENT'
   AND NOT EXISTS (SELECT 1 FROM asset_document_ref r
                    WHERE r.id = e.source_event_id AND r.asset_id = e.asset_id);
```

## ۲. تأیید با مالک مدرک (document-service)

خواندن مالک فقط از **خودِ `document-service`** است (A-01: asset-service جدول آن را نمی‌خواند). برای هر `document_id` فهرست
گام ۱، مالکِ ثبت‌شده را از پایگاه `document-service` (فقط‌خواندنی) بگیر:

```sql
SET default_transaction_read_only = on;
SELECT id, organization_id AS document_owner
  FROM document
 WHERE id = ANY (ARRAY['DOC_…', …]);   -- document_id های گام ۱
```

ارجاعِ **جابه‌جاشده** = `document_owner` با `current_org` آن ارجاع فرق دارد. اگر برابر بود، دست نمی‌خورد: یا مالک جدید خودش
مدرک را ثبت کرده بود، یا رفت‌وبرگشتِ A→B→A است و ردیف مشروعاً نزد A است. ارجاعی که مدرکش در `document-service` نیست را
جداگانه ثبت کن؛ خودکار برنگردان.

## ۳. بازگرداندن (با نقش مهاجر، یک تراکنش، پس از مرور فهرست)

**ارجاع و ردیف خط زمانیِ جفتش هر دو** به همان `document_owner` برمی‌گردند (نه به مالک پیشینِ یک انتقال؛ در A→B→C این دو
را از هم جدا می‌کرد). مالک‌های تأییدشدهٔ گام ۲ را در جدول موقتِ همین تراکنش بگذار (فقط ارجاع‌های تأییدشده):

```sql load
CREATE TEMP TABLE verified_owner (
  ref_id text PRIMARY KEY,
  document_owner text NOT NULL
) ON COMMIT DROP;
```

```sql
-- مقدارها را از خروجی گام ۲ بساز؛ هر ارجاعِ تأییدشده یک سطر (برابر با مالک فعلی هم می‌تواند بیاید: بی‌اثر است).
INSERT INTO verified_owner (ref_id, document_owner) VALUES ('ADR_…', 'ORG_…'), …;
```

```sql repair
WITH fixed_refs AS (
  UPDATE asset_document_ref r
     SET organization_id = v.document_owner
    FROM verified_owner v
   WHERE r.id = v.ref_id AND r.organization_id <> v.document_owner
  RETURNING r.id
), fixed_entries AS (
  UPDATE asset_timeline_entry e
     SET organization_id = v.document_owner
    FROM verified_owner v
    JOIN asset_document_ref r2 ON r2.id = v.ref_id
   WHERE e.asset_id = r2.asset_id AND e.source_event_id = v.ref_id
     AND e.category = 'DOCUMENT' AND e.organization_id <> v.document_owner
  RETURNING e.id
)
SELECT (SELECT count(*) FROM fixed_refs)::int AS refs_fixed,
       (SELECT count(*) FROM fixed_entries)::int AS entries_fixed;
```

دو شمارش را با شمار ارجاع‌های جابه‌جاشدهٔ گام ۲ مقایسه کن (هر ارجاع جابه‌جاشده یک ارجاع و یک ردیف خط زمانی)؛ فقط در
صورت برابری `COMMIT` بزن، وگرنه `ROLLBACK`. پیش از `COMMIT` همین تراکنش دو بررسی گام ۴ را هم اجرا کن.

- هیچ ردیفی پاک نمی‌شود. اگر ارجاعی به دارایی‌ای اشاره می‌کند که اکنون مالک دیگری دارد، پس از بازگشت دیگر در پروندهٔ مالک
  جدید دیده نمی‌شود (درست همان رفتار Q-99) و مالک جدید مدرک خودش را می‌چسباند.
- دارایی‌ای که مالک جدیدش پیش‌تر با همان مدرکِ جابه‌جاشده فعال شده بود، اکنون پروندهٔ ناقص دارد؛ **فعال‌سازی را برنگردان**.
  وضعیت آن دارایی را به تیم محصول گزارش کن (تصمیم با صاحب محصول است، Q-99). (از #234 دور ۲ ثبتِ «برای کدام سازمان فعال
  شده» روی خود دارایی است، پس بازگشت به سرویسِ دارایی‌ای که مالک فعلی فعالش کرده، پروندهٔ مدرک نمی‌خواهد.)

## ۴. تأیید و ثبت

دو بررسی، هر دو باید **خالی** باشند. گام ۱ دیگر معیار نیست: رفت‌وبرگشتِ مشروعِ A→B→A ردیف‌هایی دارد که هنوز در فهرست
نامزدها می‌آیند ولی درست‌اند. (الف) هر ردیف خط زمانیِ مدرک نزد همان سازمانِ ارجاعِ جفتش است؛ (ب) هر ارجاعِ تأییدشده نزد
مالک مدرک است:

```sql verify-pairs
SELECT e.id AS entry_id, e.organization_id AS entry_org, r.organization_id AS ref_org
  FROM asset_timeline_entry e
  JOIN asset_document_ref r ON r.id = e.source_event_id AND r.asset_id = e.asset_id
 WHERE e.category = 'DOCUMENT' AND e.organization_id <> r.organization_id;
```

```sql verify-owners
SELECT r.id AS ref_id, r.organization_id AS current_org, v.document_owner
  FROM asset_document_ref r
  JOIN verified_owner v ON v.ref_id = r.id
 WHERE r.organization_id <> v.document_owner;
```

پس از `COMMIT` گام ۲ را برای همهٔ ارجاع‌های گام ۱ دوباره بگیر و مطمئن شو `current_org` هر یک برابر `document_owner` است. شمار
ردیف‌های تغییرکرده، شناسهٔ تیکت و زمان را ثبت کن. هیچ شناسهٔ مدرکی در پیام‌ها یا کانال‌های عمومی نگذار (شناسه‌ها فقط در تیکت).

## ۵. اثبات روش

روش، پیش از هر استفاده، با تست یکپارچه روی تاریخچه‌های A→B→C و A→B→A اجرا می‌شود
(`services/asset-service/test/document-ref-reconciliation-runbook.int-spec.ts`): بلوک‌های SQLِ همین سند را از همین فایل
بیرون می‌کشد و اجرا می‌کند، پس آنچه مستند است همان است که آزموده شده.
