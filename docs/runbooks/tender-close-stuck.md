# Runbook: مناقصهٔ سررسیده‌ای که بسته نمی‌شود

**شدت:** 🟠 هشدار — درستی داده در خطر نیست: پیشنهاد پس از مهلت را **ساعت پایگاه‌داده** رد می‌کند، چه جاروکننده کار کند چه نه
(ADR-065 § 2). ولی مناقصه `PUBLISHED` می‌ماند، پس بازگشایی پیشنهادها، ارزیابی و ارجاع آن ممکن نیست.
**سیگنال محرک:** هشدار `RastaConstructionTenderCloseRetriesHigh` (`infrastructure/docker/prometheus/rules/rasta-construction-alerts.yml`)؛
Gauge `rasta_construction_tender_close_max_attempts` بیش از ۵؛ افزایش `rasta_construction_tender_close_total{result="failed"}`.
**زمان پاسخ هدف:** ۴ ساعت کاری.

## ۱. چه رخ داده است

`TenderCloseSweeper` هر دور، دسته‌ای از مناقصه‌های `PUBLISHED` با `bid_closing_at` گذشته را Claim می‌کند و هر کدام را در تراکنشی
جدا می‌بندد. اگر بستنِ یکی شکست بخورد، شمارندهٔ `close_attempts` یکی بالا می‌رود و `close_next_attempt_at` به اندازهٔ
`min(CONSTRUCTION_TENDER_CLOSE_BACKOFF_MAX_SECONDS, CONSTRUCTION_TENDER_CLOSE_BACKOFF_BASE_SECONDS × 2^شکست‌ها)` عقب می‌رود
(پیش‌فرض ۱۰ ثانیه تا سقف ۱۵ دقیقه). تا آن زمان Claim نمی‌شود و مناقصه‌های پشت‌سرش گرسنه نمی‌مانند.

## ۲. بررسی

1. لاگ `construction-service`: `Closing tender <id> failed: <CODE>` — کد بستهٔ خطا و شناسهٔ مناقصه را می‌دهد (هشدار هیچ‌کدام را ندارد).
2. وضعیت ردیف (با دسترسی مجاز): `status`، `close_attempts`، `close_next_attempt_at`، `version`.
3. علت‌های محتمل: `OPTIMISTIC_LOCK_FAILED` تکراری (نویسندهٔ دیگری مدام ردیف را عوض می‌کند)، خطای پایگاه‌داده، یا ردیفی که محدودیت
   (`ck_tender_*`) را نقض می‌کند.

## ۳. رفع

- علتِ زیرین را برطرف کنید؛ دور بعدیِ پس از Backoff خودش می‌بندد و `close_attempts` با خروج از `PUBLISHED` صفر می‌شود.
- اگر مالک مناقصه را لغو کرد، لغو مجاز است (Claim همان‌جا پاک می‌شود) و هشدار خودش برمی‌خیزد.
- برای تلاش فوری پس از رفع علت: `close_next_attempt_at = NULL` برای همان ردیف (با تأیید و ثبت در گزارش تغییر)؛ هرگز `status` را دستی
  به `CLOSED` تغییر ندهید — رویداد `TENDER_CLOSED` و `closed_at/closed_by` را فقط `TenderCloseService` می‌نویسد.
