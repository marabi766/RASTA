# Runbook: بارگذاری (Bootstrap) وضعیت صلاحیت پیمانکار در construction-service

**شدت:** 🟠 هشدار — تا پایان بارگذاری هیچ پیمانکاری نمی‌تواند پیشنهاد دهد (Fail Closed)
**سیگنال محرک:** پیشنهاد با `STANDING_NOT_LOADED` رد می‌شود؛ یا لاگ `The contractor standing could not be loaded yet` تکرار می‌شود؛ یا
پس از `down.sql` و اعمال دوبارهٔ مهاجرت `20260930190000_contractor_standing`.
**زمان پاسخ هدف:** ۴ ساعت

---

## چرا لازم است

گروه مصرف‌کنندهٔ `construction-service.supplier-standing` رویدادهای `rasta.supplier.v1` را از **انتهای** Topic می‌خواند و Topic فقط
هفت روز نگه می‌دارد. پیمانکاری که پارسال تأیید شده یا ماه پیش تعلیق شده در لاگ نیست. بازپخش، `fromBeginning` یا اعمال دوبارهٔ مهاجرت
آن را برنمی‌گرداند. منبع حقیقت `supplier-service` است؛ پس `construction-service` هنگام راه‌اندازی از
`GET /v1/suppliers/standing-snapshot` (ADR-061 § ۴) وضعیت را می‌خواند و در دو جدول `contractor_standing` و `contractor_suspension`
می‌نویسد. تا نشانگر `standing_bootstrap.completed_at` ثبت نشود، هر پرسش صلاحیت `STANDING_NOT_LOADED` جواب می‌گیرد.

**این مدل مشورتی است.** تصمیم پیشنهاد (صلاحیت پیمانکار) از آن گرفته نمی‌شود: `StandingAuthority` هنگام ثبت وضعیت همان پیمانکار را از
`supplier-service` می‌پرسد (`GET /v1/suppliers/standing-snapshot/{organizationId}`)، چون مدل پس از قطعی بلندتر از هفت روز یا با تعلیقِ هنوز
منتقل‌نشده می‌تواند «واجد شرایط» بگوید. اگر `supplier-service` در دسترس نباشد، پیشنهاد `503/504` می‌گیرد (Fail Closed) — این به نشانگر وابسته نیست.

## تشخیص

1. نشانگر:
   `SELECT id, started_at, cursor, suppliers_loaded, source_snapshot_at, completed_at FROM standing_bootstrap;`
   - بی ردیف: بارگذاری هنوز شروع نشده (سرویس بالا نیامده یا `supplier-service` در دسترس نیست).
   - ردیف با `completed_at` تهی: در میانه است یا شکست می‌خورد. `cursor` آخرین شناسهٔ تأمین‌کنندهٔ اعمال‌شده است؛ تلاش بعدی از همان‌جا ادامه می‌دهد.
   - `completed_at` پر: بارگذاری انجام شده؛ مشکل جای دیگر است.
2. لاگ `construction-service` را برای `could not be loaded yet (<کد>)` ببین: `UPSTREAM_UNAVAILABLE` / `UPSTREAM_TIMEOUT` یعنی
   `supplier-service` پاسخ نمی‌دهد، پاسخ غیر ۲۰۰ می‌دهد یا بدنه‌اش با قرارداد نمی‌خواند (فیلد اضافه، لحظهٔ نامعتبر، بزرگ‌تر از کران).
   `The snapshot contradicts the recorded standing` یعنی یک شناسهٔ دورهٔ تعلیق به دو سازمان نسبت داده شده — داده خراب است؛ صفحه به‌طور کامل
   برگشت می‌خورد و بارگذاری کامل نمی‌شود تا انسان تصمیم بگیرد.
3. `SUPPLIER_SERVICE_URL` و `INTERNAL_TOKEN_SECRET` را در هر دو سرویس بسنج. توکن باید برای `supplier-service` و **بی مستأجر** صادر شود.

## بازیابی

- معمولاً کاری لازم نیست: بارگذاری خودکار هر `CONSTRUCTION_STANDING_BOOTSTRAP_RETRY_MS` (پیش‌فرض ۱۵ ثانیه) دوباره تلاش می‌کند و از `cursor` ادامه می‌دهد.
- چند نمونه هم‌زمان بی‌خطرند: هر صفحه زیر قفل مشورتی و فقط اگر نشانگر هنوز همان‌جا باشد اعمال می‌شود.
- رویدادهای زنده در طول بارگذاری هم‌گرا می‌شوند: نوشتن‌ها جابه‌جاپذیر و تکرارپذیرند (بیشینهٔ زمان تأیید؛ هر نیمهٔ دورهٔ تعلیق حداکثر یک بار)،
  پس ترتیب «Snapshot ← رویداد» و «رویداد ← Snapshot» یک نتیجه می‌دهند.

## بازسازی (پس از `down.sql` و اعمال دوباره، یا خرابی خوانش‌مدل)

1. مهاجرت را برگردان و دوباره اعمال کن (`down.sql` سه جدول و نگهبان نشانگر را برمی‌دارد؛ نشانگر کامل را هیچ کس به‌جز مالک جدول
   نمی‌تواند حذف کند، عمداً).
2. سرویس را راه‌اندازی (یا Restart) کن. نشانگر نیست، پس بارگذاری از ابتدا اجرا می‌شود؛ مصرف‌کنندهٔ رویداد پیش از آن بالا می‌آید.
3. تا `completed_at` ثبت نشده، پیشنهاد جدید با `STANDING_NOT_LOADED` رد می‌شود — این رفتار درست است، نه خطا. پیشنهادهای ثبت‌شده دست‌نخورده می‌مانند.
4. بسنج: `SELECT count(*) FROM contractor_standing;` و `... FROM contractor_suspension WHERE reinstated_at IS NULL;` با `suppliers_loaded` در نشانگر و با
   تعداد تأمین‌کنندگان تأییدشده برای `CONTRACTING` در `supplier-service` سازگار باشد.

**چه چیزی را بازسازی نمی‌کند:** رویدادهایی که پس از خواندن Snapshot و پیش از بالا آمدن مصرف‌کننده منتشر شوند. به همین دلیل مصرف‌کننده **پیش از**
بارگذاری شروع می‌شود (`AppModule.onModuleInit`)؛ ترتیب را برنگردان.
