# Runbook: identity-service نمی‌تواند عضویت خوانندهٔ پیشنهادها را بگوید

**شدت:** 🟠 هشدار — هیچ پیشنهادی نشان داده نشد (Fail Closed)، یا بررسیِ پس از بازگشایی انجام نشد.
**سیگنال محرک:** هشدار `RastaConstructionBidOpeningIdentityUnavailable`
(`infrastructure/docker/prometheus/rules/rasta-construction-alerts.yml`)؛
`rasta_construction_bid_opening_refusals_total{reason="identity_unavailable"}` یا
`rasta_construction_bid_opening_conflict_checks_total{outcome="unavailable"}` بزرگ‌تر از صفر.
**زمان پاسخ هدف:** ساعات کاری.

## ۱. چه رخ داده است

هر مسیر سمت کارفرمای پیشنهادها (بازگشایی و تکرار آن، فهرست و خواندن پیشنهاد، لاگ دسترسی، پیشنهاد و پس‌گرفتن) پیش از هر پاسخ از
`identity-service` می‌پرسد خواننده **اکنون** عضو کدام سازمان‌هاست (توکن ممکن است پیش از پیوستنِ او به سازمانی پیشنهاددهنده صادر شده باشد). پاسخ
نیامد، دیر آمد یا از قرارداد بیرون بود ⇒ `502/504` و هیچ‌چیز نشان داده نمی‌شود.

دو حالت:

- **`reason="identity_unavailable"`:** درخواستی رد شد؛ کاربر می‌تواند دوباره تلاش کند. بازگشایی و خواندن‌ها دست‌نخورده‌اند.
- **`outcome="unavailable"`:** بازگشایی انجام و Commit شده، اما بررسی پس از آن (عضویت پیشنهاددهنده و تأییدکننده در لحظهٔ Commit) انجام نشد و
  **تکرار نمی‌شود**.

## ۲. بررسی

1. وضعیت `identity-service` و `IDENTITY_SERVICE_URL`/`CONSTRUCTION_IDENTITY_REQUEST_TIMEOUT_MS` در `construction-service`.
2. لاگ `construction-service`: `identity-service answered <status> to the membership read` یا
   `the conflict check after an opening could not be made`.
3. توکن سرویس: `construction-service` با توکن بی‌مستأجر؛ هر توکن دیگری `403` می‌گیرد.

## ۳. رفع

- پس از برگشتن identity، کاربران دوباره تلاش می‌کنند؛ کار دیگری لازم نیست.
- برای حالت دوم: بازگشایی‌های بازهٔ قطع را بیابید (`tender.opened_at`)، و برای هر یک عضویت `opened_by` و `opening_proposed_by` را در لحظهٔ
  `opened_at` در identity بخوانید
  (`GET /v1/users/:id/organizations?at=<opened_at>`، فقط سرویس‌به‌سرویس)؛ اگر عضو پیشنهاددهنده‌ای بودند، همان مسیر
  [bid-opening-conflict](bid-opening-conflict.md).
- شمارنده با راه‌اندازی مجدد سرویس صفر می‌شود؛ پیش از آن علت قطع را ثبت کنید.
