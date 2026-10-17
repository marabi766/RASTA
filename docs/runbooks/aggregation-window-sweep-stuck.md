# Runbook: پنجرهٔ تجمیعی که پس از پایانش بسته نمی‌شود

**شدت:** 🟠 هشدار — درستی داده در خطر نیست: نیازی که در `closes_at` یا پس از آن برسد به آن پنجره **نمی‌پیوندد** و خودش پنجره را پایان
می‌دهد (ساعت پایگاه‌داده پس از قفل ردیف؛ ADR-070 § ۲)، چه جاروکننده کار کند چه نه. ولی پنجره‌ای که پس از پایانش نیازی نمی‌گیرد `OPEN`
می‌ماند: `READY` نمی‌شود (پس صدور RFQ از آن ممکن نیست) و درخواست‌کنندگانش از `REFERRED`/`LAPSED` شدن آگاه نمی‌شوند.
**سیگنال محرک:** هشدارهای `RastaProcurementWindowSweepRetriesHigh` و `RastaProcurementWindowSweepOverdue`
(`infrastructure/docker/prometheus/rules/rasta-procurement-alerts.yml`)؛ Gauge `rasta_procurement_window_sweep_max_attempts` بیش از ۵ یا
`rasta_procurement_window_sweep_oldest_due_age_seconds` بیش از ۹۰۰؛ افزایش `rasta_procurement_window_sweep_total{result="failed"}`.
**زمان پاسخ هدف:** ۴ ساعت کاری.

## ۱. چه رخ داده است

`AggregationWindowSweeper` هر `PROCUREMENT_WINDOW_SWEEP_INTERVAL_MS` دسته‌ای (`_BATCH_SIZE`) از پنجره‌های `OPEN` با `closes_at` گذشته، و
پنجره‌های پایان‌یافته‌ای که نیازهایشان هنوز دنبالشان نرفته‌اند (`demands_to_follow > 0`)، را با اجاره و نشانهٔ حصار Claim می‌کند و هر کدام
را در تراکنش‌های کوتاه خودش، در مستأجر خودش، پایان می‌دهد — همان تابع گذار و همان رویدادی که نیاز دیررس می‌سازد. پنجرهٔ `REFERRED` یا
`LAPSED` با بیش از `PROCUREMENT_WINDOW_FOLLOW_BATCH_SIZE` نیاز زنده، نیازهایش را در دسته‌های همین اندازه، هر دسته در یک تراکنش، جابه‌جا
می‌کند. اگر گامی شکست بخورد `sweep_attempts` یکی بالا می‌رود و `sweep_next_attempt_at` به اندازهٔ
`min(PROCUREMENT_WINDOW_SWEEP_BACKOFF_MAX_SECONDS, PROCUREMENT_WINDOW_SWEEP_BACKOFF_BASE_SECONDS × 2^شکست‌ها)` عقب می‌رود (پیش‌فرض ۱۰ ثانیه
تا سقف ۱۵ دقیقه)؛ تا آن زمان Claim نمی‌شود و پنجره‌های پشت‌سرش گرسنه نمی‌مانند.

`RastaProcurementWindowSweepOverdue` یعنی کهنه‌ترین پنجرهٔ سررسیده بیش از ۱۵ دقیقه پایان نیافته: یا هیچ نمونهٔ `procurement-service`
جاروکننده را اجرا نمی‌کند، یا همهٔ تلاش‌ها شکست می‌خورند.

## ۲. بررسی

1. لاگ `procurement-service`: `Sweeping aggregation window <id> failed: <CODE>` و خلاصهٔ هر دور (`Aggregation window sweep: claimed …`) —
   کد بستهٔ خطا و شناسهٔ پنجره را می‌دهد (هشدار هیچ‌کدام را ندارد). نبود خلاصه‌ها یعنی جاروکننده اجرا نمی‌شود.
2. وضعیت ردیف (با دسترسی مجاز): `status`، `closes_at`، `demands_to_follow`، `sweep_attempts`، `sweep_next_attempt_at`، `sweep_fence`،
   `version`.
3. علت‌های محتمل: `OPTIMISTIC_LOCK_FAILED` تکراری، خطای پایگاه‌داده یا Outbox، قفلی که تراکنشی طولانی روی ردیف پنجره نگه داشته، یا ردیفی
   که محدودیت (`ck_demand_aggregation_*`) را نقض می‌کند.

## ۳. رفع

- علت زیرین را برطرف کنید؛ دور بعدی پس از Backoff خودش پایان می‌دهد و `sweep_attempts` با موفقیت صفر می‌شود.
- اگر جاروکننده اجرا نمی‌شود: سرویس را با پیکربندی درست بالا بیاورید؛ پنجره‌های عقب‌افتاده در دور نخست، هر کدام با همان رویداد یکتا، پایان
  می‌یابند (`EXTEND` به‌اندازهٔ همهٔ طول‌های گذشته در یک گذار جلو می‌رود؛ Q-119 یادداشت (ج)).
- برای تلاش فوری پس از رفع علت: `sweep_next_attempt_at = NULL` برای همان ردیف (با تأیید و ثبت در گزارش تغییر). هرگز `status`،
  `closed_at` یا `demands_to_follow` را دستی تغییر ندهید — گذار و رویدادش (`DEMAND_AGGREGATED`، `AGGREGATION_WINDOW_EXTENDED`،
  `AGGREGATION_REFERRED`، `AGGREGATION_LAPSED`) را فقط `WindowEnd` در یک تراکنش می‌نویسد.
