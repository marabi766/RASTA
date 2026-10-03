# Runbook: مناقصه‌ای به پیمانکاری رسیده که در بازهٔ انتخاب معلق یا بی‌صلاحیت بوده است

**شدت:** 🔴 بحرانی (`RastaConstructionAwardStandingConflictDetected`) — **احتمال انتخاب پیمانکار نامعتبر**؛ ⚠️ هشدار (`RastaConstructionAwardStandingCheckOverdue`) — بررسی پس از انتخاب بیش از `CONSTRUCTION_AWARD_CHECK_ALERT_AGE_SECONDS` در انتظار مانده است.
بررسی محافظه‌کارانه است و تضاد قطعی نیست؛ مثبت کاذب فقط یک هشدار است.
**سیگنال محرک:** `infrastructure/docker/prometheus/rules/rasta-construction-alerts.yml`؛ شمارندهٔ
`rasta_construction_award_standing_checks_total{outcome="conflict"}` بزرگ‌تر از صفر (بحرانی)، یا Gauge `rasta_construction_award_standing_check_overdue` بزرگ‌تر از صفر (هشدار).
**زمان پاسخ هدف:** همان روز کاری، و پیش از امضای قرارداد.

## ۱. چه رخ داده است

`award` شایستگی برنده را از `supplier-service` می‌پرسد (Q-85، ADR-067 § ۳) **پیش از** قفل مناقصه. قفل میان‌سرویسی نیست؛ تعلیقی که میان آن پاسخ و Commit انتخاب
بنشیند متوقف نمی‌شود (باقیماندهٔ مستند). پس از هر Commit، `construction-service` دوباره می‌پرسد و بازه‌ی **`windowStart` (لحظهٔ خواندن شایستگی پیش از انتخاب) تا `checkedAt` (ساعت
supplier-service هنگام پاسخ، پس از Commit)** را می‌سنجد:

- تعلیقی که در بازه آغاز شده (حتی اگر پایان یافته باشد)، تعلیق هنوز بازِ پیمانکار، یا
- برداشته‌شدن صلاحیت `CONTRACTING`.

**بررسی ماندگار است:** ردیفی در `tender_award_standing_check` است که در همان تراکنشِ انتخاب نوشته می‌شود (پایگاه داده انتخاب بی آن را Commit نمی‌کند) و جاروکنندهٔ `AwardStandingCheckSweeper` با Lease و Fence آن را انجام می‌دهد؛ پاسخ `award` منتظر آن نیست و خرابی/ری‌استارت آن را گم نمی‌کند. نتیجه (`outcome` = `CLEAR` یا `CONFLICT`) و رویداد در یک تراکنش نوشته می‌شود، پس رویداد نه دوبار می‌آید و نه گم می‌شود (فقط اگر سرویس درست پس از Commit و پیش از افزایش شمارنده بمیرد، صفحهٔ هشدار گم می‌شود، نه رویداد).

**انتخاب پس گرفته نشد:** مناقصه `AWARDED` است. تصمیم با انسان است. `TENDER_AWARD_STANDING_CONFLICT_DETECTED` (Outbox و `rasta.construction.v1`) فقط شناسه دارد.

## ۲. بررسی

1. رویداد را بخوانید: `tenderId`، `winningBidId`، `winnerOrganizationId`، `awardedBy`، `awardedAt`، `windowStart`، `checkedAt`، `suspensionIds` (حداکثر ۲۰) و `suspensionCount`، `qualificationRemoved`.
2. در supplier-service پروندهٔ تعلیق‌ها (`suspensionIds`) را ببینید: لحظهٔ آغاز (`suspendedAt`) نسبت به `awardedAt`. تعلیقی که **پس از** `awardedAt` آغاز شده مثبت کاذب است (پس از انتخاب رخ داده؛ برای قرارداد
   جداگانه تصمیم بگیرید)؛ تعلیقی که **پیش از** انتخاب آغاز شده و در پاسخ پیش‌بررسی نبود نشانهٔ خطای دیگری است (تأخیر Outbox یا Snapshot در supplier-service) — به آن تیم گزارش دهید.
3. ردیف بررسی: `SELECT * FROM tender_award_standing_check WHERE tender_id = …` — `status`، `outcome`، `attempts`، `next_attempt_at`، `window_start`. در لاگ `construction-service` هر شکست «Standing check after the award of tender <id> (winning bid <id>)» با کد بستهٔ خطا (`UPSTREAM_UNAVAILABLE`، `UPSTREAM_TIMEOUT`، `INTERNAL`، …) است؛ مبلغ و نام نمی‌آید.
4. `GET /v1/tenders/{id}/award` (مالک) مبلغ، رتبه و `standingAsOf` را می‌دهد؛ `bid_access_log` نشان می‌دهد چه کسی چه خوانده است.

## ۳. رفع

- انتخاب را خودکار پس نگیرید و پیشنهاد دیگری را خودکار برنده نکنید. مالک مناقصه و مسئول انطباق تصمیم می‌گیرند: ادامه با ثبت دلیل، یا جلوگیری از ساخت قرارداد (CON-003 از `TENDER_AWARDED` پیش‌نویس می‌سازد؛ پیش از امضا این پیش‌نویس را متوقف کنید).
- برای `Overdue`: ردیف‌های `PENDING` را بیابید (`created_at` قدیمی؛ `attempts` بالا یعنی supplier-service پاسخ نمی‌دهد و کد خطا در لاگ است؛ `attempts` صفر و `lease_until` تهی یعنی جاروکننده اجرا نمی‌شود). علت را رفع کنید؛ جاروکننده خودش ادامه می‌دهد. اگر باید دستی تصمیم بگیرید، شایستگی برنده را در supplier-service ببینید (مرحلهٔ ۲).
- شمارنده با راه‌اندازی مجدد سرویس صفر می‌شود و هشدار برمی‌خیزد؛ این دلیل بر رفع نیست — پیش از آن علت را ثبت کنید.
