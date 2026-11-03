# Runbook: Backfill توالی Outbox (ADR-051 فاز B2)

**شدت:** ⚪ عملیاتی
**هشدار محرک:** ندارد — این Runbook با **دستور صریح اپراتور** اجرا می‌شود، نه با هشدار.
**دامنه:** فقط ابزار B2. Runbook «جریان مسدود» و هشدارهایش متعلق به **B6** است و هنوز
وجود ندارد.

---

## این ابزار چه‌کاری می‌کند — و چه‌کاری نمی‌کند

B1 در ۲۰۲۶-۰۹-۰۵ سه چیز افزود و هر سه را **بی‌اثر** گذاشت:
`outbox_message.stream_seq`، `outbox_message.is_stream_head` و جدول
`outbox_stream_sequence`. B2 نخستین فازی است که **داده** را تغییر می‌دهد:

| کار                                                                                 | انجام می‌شود؟ |
| ----------------------------------------------------------------------------------- | ------------- |
| پر کردن `stream_seq` برای ردیف‌های **منتشرنشدهٔ** بدون توالی                        | ✅            |
| علامت زدن `is_stream_head` روی پایین‌ترین توالی منتشرنشدهٔ هر جریان                 | ✅            |
| ساختن ردیف `outbox_stream_sequence` هر جریان از وضعیت واقعی همان جریان              | ✅            |
| تغییر ردیف‌های **منتشرشده**                                                         | ❌ هرگز       |
| تغییر `claimPending`، `markPublished`، Relay، Publisher، Envelope، Header، Consumer | ❌ هرگز       |
| ایجاد هر تضمین ترتیبی در زمان اجرا                                                  | ❌ **هرگز**   |

> **پس از B2 هیچ چیز `stream_seq` یا `is_stream_head` را نمی‌خواند.** تخصیص در
> B3 می‌آید، Claim سرصف در B4، تشخیص شکاف در B5. تحویل همچنان At-Least-Once
> است، A-09 الزامی می‌ماند و **D-027 باز است**.

**این یک Migration نیست و نباید بشود.** هیچ Migration پریزما این DML را ندارد،
هیچ مسیر راه‌اندازی برنامه، `pnpm verify`، CI یا Hook استقراری آن را صدا نمی‌زند.
تنها راه اجرایش، همین دستور دستی است.

---

## قفل‌های ایمنی

ابزار پیش از هر نوشتنی این‌ها را الزام می‌کند و در صورت نقض **با دلیل صریح
امتناع می‌کند** — هرگز حدس نمی‌زند:

| قفل                | رفتار                                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------- |
| هدف صریح           | بدون `--service <name>` یا `--all` اجرا نمی‌شود؛ پیش‌فرضی وجود ندارد                          |
| نوشتن صریح         | بدون `--apply` فقط Plan است؛ `--dry-run` و `--apply` با هم رد می‌شوند                         |
| محیط               | `NODE_ENV=production` رد می‌شود؛ هر `NODE_ENV` ناشناخته هم رد می‌شود                          |
| اتصال              | فقط `DATABASE_URL_<SERVICE>`؛ **هرگز** بازگشت به `DATABASE_URL` مشترک                         |
| سرویس ناشناخته     | رد می‌شود (فقط هشت سرویس دارای Schema B1)                                                     |
| اندازهٔ دسته       | عدد صحیح مثبت و حداکثر **۵٬۰۰۰** (سقف ADR-051 § B2)                                           |
| Schema B1          | هر ستون/جدول/Index باید با **تعریف** دقیق موجود باشد، نه فقط با نام                           |
| ردیف تازه حین اجرا | تشخیص داده و کل دسته Rollback می‌شود (§ «شرط سکون» پایین)                                     |
| `VACUUM` (D-045)   | Backfill هرگز Vacuum نمی‌زند و ادعایش را نمی‌کند: `vacuum: required` (§ «Vacuum پس از Apply») |

خروجی **NDJSON** روی stdout است: فقط شمارش‌ها. هیچ Payload، Credential یا رشتهٔ
اتصالی چاپ نمی‌شود؛ پیام خطا نام متغیر محیطی را می‌گوید، نه مقدارش.

---

## پیش‌نیاز — شرط سکون

`created_at` پیش از COMMIT از ساعت JavaScript گرفته می‌شود (ADR-051 § R4). پس
ردیفی که **حین** Backfill نوشته شود می‌تواند `created_at` کوچک‌تر از ردیفی داشته
باشد که همین حالا شماره گرفته است؛ افزودنش به انتها یعنی نقض ترتیب
`(created_at, id)`.

B2 ادعا نمی‌کند در برابر تولیدکنندهٔ زنده امن است. **دقیقاً همان حالت را تشخیص
می‌دهد و امتناع می‌کند**، بدون آنکه چیزی از آن دسته بنویسد. پس:

- بهترین حالت: تولیدکنندهٔ آن سرویس را **ساکن** کن (Scale to zero یا توقف
  نوشتن دامنه) و سپس اجرا کن؛
- اگر ساکن‌سازی ممکن نیست، اجرا کن و بپذیر که ممکن است با پیام
  `sort before an already-sequenced row` بایستد. در آن حالت هر چه Commit شده
  معتبر است؛ ساکن کن و دوباره اجرا کن.

Relay نیازی به توقف ندارد: دسته ردیف‌هایش را `FOR UPDATE` می‌گیرد و Claim
ADR-050 با `SKIP LOCKED` از رویشان رد می‌شود.

### Purge زمان‌بندی‌شده (D-052): B2 را پیش از روشن شدن Purge اجرا کن

B2 شمارهٔ هر Stream را از بیشینهٔ `stream_seq` می‌گیرد که **هنوز در جدول است**،
نه از `outbox_stream_sequence`. Purge ردیف‌های منتشرشده را پاک می‌کند، از جمله
ردیف‌های شماره‌دار، و شمارنده را دست نمی‌زند. فرض کن Purge همهٔ ردیف‌های
شماره‌دار یک Stream را پاک کرده و ردیف بی‌شمارهٔ منتشرنشده‌ای از آن مانده است.
B2 بی‌محافظ آن ردیف را دوباره از ۱ شماره می‌زد، و Consumer شماره‌ای را می‌دید که
قبلاً گرفته بود.

**ترتیب درست:** روی هر سرویس، B2 را **پیش از** آنکه Purge آن سرویس روشن شود
(پیش‌فرض روشن است) تا همگرایی اجرا کن. Purge فقط ردیف‌هایی را پاک می‌کند که بیش از
`OUTBOX_PURGE_RETENTION_HOURS` (پیش‌فرض ۱۶۸ ساعت) از انتشارشان گذشته باشد. پس اگر
B2 هنوز اجرا نشده، `OUTBOX_PURGE_ENABLED=false` بگذار، B2 را تا گام ۴ ببر و بعد
Purge را دوباره روشن کن.

**اگر Purge زودتر اجرا شده باشد، B2 امتناع می‌کند.** شرطش این است: `next_seq`
یک Stream از بالاترین `stream_seq` باقی‌ماندهٔ آن به‌اضافهٔ ۱ جلوتر باشد (یا هیچ
ردیف شماره‌داری نمانده باشد). نتیجه:

- رویداد `plan` تعداد این Streamها را در `streams_history_purged` می‌گوید؛
- همان سرویس `refused` می‌گیرد با `next_seq ahead of their highest surviving
stream_seq` و کد خروج ۱. **هیچ چیز نوشته نمی‌شود**، Dry-Run هم همین‌طور؛
- اگر Purge **حین** اجرا برسد، Guard همان Batch را رد می‌کند (`purge ran during
the backfill`). آن Batch هیچ چیزی نمی‌نویسد و Batchهای پیشین Commit مانده‌اند.
- اجرای **بریده** (`--max-batches`) هم پوشش داده شده است: هر Batch `next_seq`
  جریان‌هایش را در همان تراکنشی می‌نویسد که شماره می‌دهد (Watermark)، پس اگر میان دو
  برش ردیف‌های شماره‌دار منتشر و Purge شوند، اجرای بعدی همین امتناع را می‌گیرد. اجرای
  بریده‌ای که پیش از این تغییر (#247 r3) رخ داده شمارنده ننوشته و این تشخیص برایش ممکن
  نیست؛ ترتیب درست بالا برای آن همچنان لازم است.

B2 شماره را از شمارنده هم ادامه نمی‌دهد. ردیف لنگر و `(created_at, id)` آن با
Purge رفته‌اند، پس Guard ترتیب دیگر نمی‌تواند ثابت کند ردیف‌های باقی‌مانده پس از
شماره‌هایی که قبلاً داده شده‌اند می‌آیند. B2 چیزی را که نمی‌تواند بسنجد شماره
نمی‌زند.

پس از امتناع:

1. Purge آن سرویس را خاموش کن (`OUTBOX_PURGE_ENABLED=false`) تا وضعیت بدتر نشود.
2. **ردیف شمارنده را پاک یا کم نکن** و `stream_seq` را دستی ننویس. شمارنده
   حافظهٔ Stream است. پایین آوردنش یعنی B3 شماره‌ای را دوباره بدهد که Consumer
   قبلاً گرفته است.
3. این ابزار فقط در توسعه، آزمون و CI اجرا می‌شود (§ «قفل‌های ایمنی»). روی
   پایگاه دادهٔ دورریختنی، آن را از نو بساز (`pnpm infra:reset` یا Schema آزمون)
   و B2 را پیش از Purge اجرا کن.
4. اگر داده نگه‌داشتنی است، کار را متوقف کن و به مالک سرویس و ADR-051 ارجاع بده.
   ادامهٔ شماره‌گذاری یک Stream پاک‌شده رویهٔ بازبینی‌شدهٔ جداگانه می‌خواهد که
   هنوز وجود ندارد.

**تأیید بخشی از موفقیت است.** Applyی که تا آخر رفته و `verify` آن
`counter_next_mismatch`، `counter_published_mismatch` یا `head_mismatch` غیرصفر
دارد، `refused` و کد خروج ۱ می‌گیرد، نه `done`. توالی‌های تخصیص‌یافته Commit
مانده‌اند. Relayی که درست میان نهایی‌سازی و تأیید منتشر کند می‌تواند یک بار این را
بسازد. دوباره اجرا کن. اگر ماند، متوقف شو و بررسی کن.

---

## ۱. Preflight

```bash
docker compose ps postgres
node --env-file=.env scripts/outbox-b2-backfill.mjs --all
```

اجرای بدون `--apply` فقط `SELECT` می‌زند. برای هر سرویس یک رویداد `plan`
می‌آید:

```json
{
  "type": "plan",
  "service": "document",
  "pending_unsequenced": 216,
  "streams_pending": 41,
  "already_sequenced": 0,
  "published_untouched": 1804,
  "heads": 0,
  "counter_rows": 0,
  "mode": "dry-run",
  "batchSize": 5000,
  "batchesRequired": 1
}
```

اگر `pending_unsequenced` صفر باشد، آن سرویس کاری ندارد.
اگر رویداد `refused` بیاید، **متن `reason` را بخوان و رفع کن** — تا وقتی
Schema B1 مستقر نباشد، اجرا شروع نمی‌شود.

---

## ۲. اجرای واقعی

یک سرویس در هر بار، از کم‌ریسک‌ترین شروع کن (همان ترتیب § ۴ طرح اجرا:
`document` → `fleet` → `maintenance` → `marketplace` → `economic`):

```bash
node --env-file=.env scripts/outbox-b2-backfill.mjs --service document --apply
```

برای صف بزرگ، برشِ مرزدار بگیر و بین برش‌ها وضعیت را ببین. **توجه: برشی که کار
ناتمام بگذارد عمداً با کد خروج ۱ تمام می‌شود** (§ «کد خروج» پایین):

```bash
node --env-file=.env scripts/outbox-b2-backfill.mjs --service economic --apply --max-batches 10
```

گزینه‌ها: `--batch-size <n>` (۱ تا ۵۰۰۰، پیش‌فرض ۵۰۰۰) · `--max-batches <n>`.
`--vacuum-every` حذف شده و با نام رد می‌شود (§ «Vacuum پس از Apply»).

### پیشرفت مورد انتظار

```json
{ "type": "batch", "service": "document", "batch": 1, "selected": 216, "updated": 216,
  "streams": 41, "remaining": 0, "elapsedMs": 48 }
{ "type": "counters", "service": "document", "streams": 41, "written": 41 }
{ "type": "heads", "service": "document", "changed": 41, "heads": 41 }
{ "type": "vacuum", "service": "document", "status": "required", "table": "outbox_message",
  "reason": "the runtime role cannot VACUUM a table it does not own, so this run did not; …" }
{ "type": "verify", "service": "document", "remaining": 0, "sequenced": 216, "heads": 41,
  "streams": 41, "counter_rows": 41, "counter_next_mismatch": 0,
  "counter_published_mismatch": 0, "head_mismatch": 0 }
{ "type": "done", "service": "document", "mode": "apply", "mutated": true,
  "vacuum": "required", "batches": 1, "truncated": false, "converged": true }
```

**همگرایی یعنی این سه با هم:** `converged: true` · `remaining: 0` · و هر سه
شمارندهٔ `*_mismatch` برابر صفر.

#### `mode` و `mutated` یکی نیستند

این تفکیک برای شواهد عملیاتی مهم است:

- **`mode: "apply"`** یعنی نوشتن **مجاز شد** — یعنی `--apply` داده شده بود.
- **`mutated`** یعنی پایگاه داده **واقعاً عوض شد**. فقط وقتی `true` است که همین
  اجرا دست‌کم یکی از این سه را انجام داده باشد: یک توالی تخصیص داده
  (`batch.updated > 0`)، یک ردیف شمارنده نوشته یا به‌روز کرده
  (`counters.written > 0`)، یا یک سرصف را عوض کرده (`heads.changed > 0`).

پس یک Apply همگرا روی سرویسی که کاری برای انجام ندارد،
`mode: "apply", mutated: false` می‌دهد — و این پاسخ درست است، نه یک خطا:

```json
{ "type": "counters", "service": "identity", "streams": 0, "written": 0 }
{ "type": "heads", "service": "identity", "changed": 0, "heads": 0 }
{ "type": "done", "service": "identity", "mode": "apply", "mutated": false,
  "batches": 0, "truncated": false, "converged": true }
```

توجه: اجرایی که هیچ توالی تازه‌ای تخصیص نمی‌دهد هم می‌تواند `mutated: true`
باشد — وقتی مرحلهٔ نهایی‌سازی، شمارنده یا سرصفی را که از اجرای قطع‌شدهٔ قبلی یا
از انتشار سرصف قبلی عقب مانده بود اصلاح می‌کند.

### دو مسیر اجرا، و رویدادهای هرکدام

اجرا دقیقاً یکی از دو مسیر را می‌رود، و این دو **خروجی متفاوتی** دارند.

#### مسیر ۱ — امتناع Preflight سراسری

اعتبارسنجی هدف، گزینه‌ها یا محیط **پیش از شروع پیمایش سرویس‌ها** شکست می‌خورد:
بدون هدف، سرویس ناشناخته یا تکراری، `--dry-run` همراه `--apply`، عدد نامعتبر یا
خارج از بازه، گزینهٔ ناشناخته، `NODE_ENV=production`، یا `NODE_ENV` ناشناخته.

| ویژگی     | مقدار                                                                   |
| --------- | ----------------------------------------------------------------------- |
| رویدادها  | **دقیقاً یک** `refused` و هیچ چیز دیگر                                  |
| دامنه     | **بدون `service`** — هنوز هیچ برنامهٔ معتبری برای هیچ سرویسی وجود ندارد |
| `summary` | **چاپ نمی‌شود** — چیزی برای جمع‌بستن نیست                               |
| کد خروج   | ۱                                                                       |

```json
{ "type": "refused", "reason": "No target selected. Pass --service <name> (repeatable) or --all. …" }
```

#### مسیر ۲ — اجرای سرویسِ اعتبارسنجی‌شده

گزینه‌ها و محیط سالم‌اند، پس **هر سرویس انتخاب‌شده به‌ترتیب امتحان می‌شود** و
آخرین خط، `summary` تجمیعی است. به‌ازای هر سرویس:

| رویداد               | چه وقت                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `plan`               | شمارش‌هایی که اجرا رویشان کار می‌کند؛ نخستین رویداد هر سرویس                                 |
| `batch`              | یکی به‌ازای هر دستهٔ Apply                                                                   |
| `counters` و `heads` | فقط وقتی اجرا همگرا شد                                                                       |
| `vacuum`             | `status: "required"` با نام جدول، یک بار، پس از Applyی که چیزی نوشت (§ «Vacuum پس از Apply») |
| `verify`             | شمارش‌های پس از اجرا، خوانده‌شده از پایگاه داده                                              |
| `done`               | برای هر تلاشی که تا آخر رفت — Dry-Run یا Apply — با `converged` و `mutated`                  |

و سپس **دقیقاً یک نتیجهٔ سطح CLI** برای همان سرویس:

| نتیجه        | رویداد                        | شمارندهٔ `summary` | معنا                                                                                                                                                                          |
| ------------ | ----------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| همگرا شد     | ندارد (فقط همان `done`)       | `ok`               | `done.converged: true`                                                                                                                                                        |
| ناتمام       | `incomplete` **پس از** `done` | `incomplete`       | بودجهٔ `--max-batches` تمام شد یا ردیف بدون توالی مانده                                                                                                                       |
| امتناع سرویس | `refused` **به‌جای** `done`   | `refused`          | `DATABASE_URL_<SERVICE>` تنظیم نشده، نقش اجرا نیست (D-045)، نقض پیش‌شرط B1، Guard ترتیب، تاریخچهٔ پاک‌شده با Purge یا `*_mismatch` پس از نهایی‌سازی (§ «Purge زمان‌بندی‌شده») |

`incomplete` **خطا نیست** و عمداً از `refused` جداست: چیزی خراب نشده، اجرا
مرزدار بوده. مثل هر رویداد دیگری فقط شمارش دارد — بدون Payload، URL یا Stack.

**امتناع سرویس، مال همان سرویس است و نه کل اجرا.** هر سرویس مرز خطای خودش را
دارد، از جمله مرحلهٔ پیدا کردن اتصال. اگر `DATABASE_URL_<SERVICE>` سرویس نخست
تنظیم نشده باشد، همان سرویس یک `refused` می‌گیرد (که **نام متغیر** را می‌گوید،
نه مقدارش) و سرویس‌های بعدیِ انتخاب‌شده **همچنان اجرا می‌شوند**؛ `summary` هم
چاپ می‌شود:

```json
{ "type": "refused", "service": "economic",
  "reason": "DATABASE_URL_ECONOMIC is not set. …" }
{ "type": "summary", "mode": "apply", "services": 2, "ok": 1, "incomplete": 0, "refused": 1 }
```

```json
{ "type": "done", "service": "document", "truncated": true, "converged": false, … }
{ "type": "incomplete", "service": "document", "batches": 1, "remaining": 14,
  "truncated": true, "reason": "… re-run this service without --max-batches to converge." }
{ "type": "summary", "mode": "apply", "services": 1, "ok": 0, "incomplete": 1, "refused": 0 }
```

### کد خروج

در مسیر ۲، **کد خروج ۰ فقط وقتی است که `incomplete` و `refused` هر دو صفر
باشند**: Dry-Run همگراست مگر امتناع کند، و Apply وقتی همگراست که
`truncated: false`، `remaining: 0` **و** هر سه `*_mismatch` صفر باشند. پس `--apply --max-batches N` که کار
باقی بگذارد **عمداً غیرصفر** برمی‌گردد و اسکریپت اپراتور نمی‌تواند Backfill
نیمه‌تمام را تمام‌شده بخواند. همهٔ سرویس‌های انتخاب‌شده در هر حال امتحان
می‌شوند؛ ایستادن یکی، بعدی را رد نمی‌کند. مسیر ۱ همیشه ۱ برمی‌گرداند.

| اجرا                                                  | `summary` | کد خروج |
| ----------------------------------------------------- | --------- | ------- |
| `--service document`                                  | بله       | ۰       |
| `--service document --apply` (همگرا)                  | بله       | ۰       |
| `--service document --apply --max-batches 1` (ناتمام) | بله       | **۱**   |
| امتناع یک سرویس (مسیر ۲)                              | بله       | **۱**   |
| امتناع Preflight سراسری (مسیر ۱)                      | **خیر**   | **۱**   |

---

## Vacuum پس از Apply (D-045)

هر Update یک Tuple تازه می‌سازد (ADR-051 § R7: حدود دو برابر رشد جدول) و آمار
`stream_seq` از «همه NULL» به توزیع واقعی می‌رود؛ پس پس از هر Applyی که چیزی نوشت،
`VACUUM (ANALYZE)` روی `outbox_message` **لازم** است. Backfill آن را **نمی‌زند**: با
نقش اجرای سرویس وصل است که مالک هیچ جدولی نیست، و PostgreSQL ۱۶ Vacuum چنین نقشی را
با یک WARNING **رد می‌شود و موفقیت گزارش می‌کند** (Codex روی #180). پس Backfill فقط
می‌گوید چه بدهکار است — `{"type":"vacuum","status":"required","table":"outbox_message"}`
و `done.vacuum: "required"` — و هرگز Vacuumی را که نکرده گزارش نمی‌کند.

بدهی را دستور نگه‌داری جداگانه می‌پردازد، با اعتبار مهاجر سرویس از **محیط**
(`DATABASE_URL_<SERVICE>_MIGRATOR` در `.env.migrator`؛ هرگز آرگومان، هرگز فرایند Backfill):

```bash
node --env-file=.env.migrator scripts/outbox-b2-vacuum.mjs --service document
```

پیش از Vacuum بررسی می‌کند نقش وصل‌شده مالک جدول باشد (وگرنه `refused`، بی هیچ کاری)؛
پس از آن `vacuum_count` و `analyze_count` جدول در `pg_stat_user_tables` را دوباره
می‌خواند و فقط اگر **هر دو** بالا رفته باشند `status: "verified"` می‌دهد — با شمارش پیش و
پس — وگرنه `refused` و کد خروج ۱. این دو شمارنده فقط اجرای دستی را می‌شمارند، پس
Autovacuum هم‌زمان جای آن را نمی‌گیرد.

```json
{ "type": "vacuum", "service": "document", "status": "verified", "role": "rasta_document_migrator",
  "table": "public.outbox_message", "vacuumCount": { "before": 0, "after": 1 },
  "analyzeCount": { "before": 0, "after": 1 } }
{ "type": "summary", "services": 1, "verified": 1, "refused": 0 }
```

برای صف بزرگ، Apply را با `--max-batches` برش بزن و **میان برش‌ها** همین دستور را اجرا
کن؛ این جای Vacuum میانی‌ای است که ADR-051 § R7 تجویز می‌کند. `--vacuum-every` حذف شده
و با پیامی که به این بخش اشاره می‌کند رد می‌شود.

---

## ۳. قطع شدن و از سرگیری

اجرا در هر لحظه قابل قطع است. تخصیص هر دسته در تراکنش خودش Commit شده و
`stream_seq` هیچ‌گاه دوباره شماره‌گذاری نمی‌شود؛ اجرای بعدی از همان‌جا ادامه
می‌دهد. اجرای دومِ کامل **No-Op** است: صفر دسته، صفر شمارنده، صفر سرصف.

اجرای قطع‌شده (`truncated: true`) `published_seq` و سرصف را عمداً **نمی‌نویسد** —
پیش از B4 هیچ‌کدام خوانده نمی‌شوند، پس حالت میانی بی‌خطر است. ولی `next_seq` هر جریانی
که دسته‌ای شماره گرفته **در همان تراکنش دسته** نوشته شده است (Watermark، D-052): هیچ
شماره‌ای بی آن Commit نمی‌شود، و Purge ردیف شمارنده را پاک نمی‌کند. پس اگر میان دو برش
رله ردیف‌های شماره‌دار را منتشر کند و Purge آن‌ها را پاک کند، اجرای از سرگرفته آن جریان را
**رد می‌کند** (§ «Purge زمان‌بندی‌شده») و همان شماره‌ها را دوباره نمی‌دهد. همان اجرا رویداد
`incomplete` می‌دهد و با کد ۱ برمی‌گردد. برای رساندن آن به حالت نهایی، دستور را بدون
`--max-batches` دوباره اجرا کن؛ آن اجرا با کد ۰ و `converged: true` تمام می‌شود.

> **`verify` یک اجرای ناتمام، `*_mismatch` غیرصفر نشان می‌دهد و این خرابی
> نیست.** `published_seq` و سرصف هنوز نوشته نشده‌اند، پس تا اجرای همگرا با وضعیت
> ردیف‌ها نمی‌خوانند. پس از نهایی‌سازی، `*_mismatch` غیرصفر دیگر کنار
> `converged: true` دیده نمی‌شود: اجرا `refused` می‌گیرد و کد خروج ۱.

---

## ۴. Query های تأیید

روی پایگاه دادهٔ همان سرویس (نه دیگری):

```sql
-- ۱) هیچ ردیف منتشرنشدهٔ بدون توالی نمانده باشد
SELECT count(*) FROM outbox_message WHERE published_at IS NULL AND stream_seq IS NULL;

-- ۲) هر جریان دقیقاً یک سرصف داشته باشد (و جریان کاملاً منتشرشده، هیچ)
SELECT topic, partition_key, count(*) FILTER (WHERE is_stream_head) AS heads
  FROM outbox_message WHERE stream_seq IS NOT NULL
 GROUP BY topic, partition_key HAVING count(*) FILTER (WHERE is_stream_head) > 1;

-- ۳) سرصفِ علامت‌خورده = سرصفی که D-4 حساب می‌کند
SELECT count(*) FROM outbox_message m
  JOIN outbox_stream_sequence s
    ON s.topic = m.topic AND s.partition_key = m.partition_key
 WHERE m.is_stream_head IS DISTINCT FROM
       (m.stream_seq = s.published_seq + 1 AND m.published_at IS NULL);

-- ۴) next_seq همان جایی باشد که B3 باید از آن ادامه دهد
SELECT count(*) FROM (
  SELECT topic, partition_key, max(stream_seq) + 1 AS want
    FROM outbox_message WHERE stream_seq IS NOT NULL GROUP BY topic, partition_key
) p JOIN outbox_stream_sequence s USING (topic, partition_key)
 WHERE s.next_seq <> p.want;
```

هر چهار Query باید **صفر** برگردانند. Query ۳ و ۴ همان چیزی را می‌سنجند که
رویداد `verify` گزارش می‌کند؛ اینجا هستند تا مستقل از خروجی ابزار قابل بررسی
باشند.

---

## ۵. مرز Rollback — این را دقیق بخوان

**`down.sql` های B1، تغییر دادهٔ B2 را بازنمی‌گردانند.** اجرای
`20260905090100_outbox_stream_seq_columns/down.sql` ستون‌ها را **حذف** می‌کند و
با آن‌ها همهٔ توالی‌های Backfill شده را دور می‌ریزد؛ این «بازگشت» نیست، پاک کردن
است، و پس از آن B2 باید از صفر اجرا شود.

Rollback امن B2 این است: **داده را بی‌اثر رها کن.** ستون‌ها و ردیف‌های شمارنده
افزایشی‌اند و هیچ مسیر اجرایی آن‌ها را نمی‌خواند، پس ماندنشان هزینه‌ای ندارد.
برگرداندن فازهای برنامه‌ای (B3، B4، B5) مطابق § ۴ طرح اجرا انجام می‌شود و به B2
دست نمی‌زند.

برگرداندن خودِ داده — صفر کردن `stream_seq`، پاک کردن سرصف‌ها و خالی کردن جدول
شمارنده — **رویه‌ای جداگانه و بازبینی‌شده لازم دارد** که هنوز طراحی نشده. تا آن
زمان، در این Runbook چنین دستوری وجود ندارد و نباید اختراع شود.

---

## ۶. آزمون‌ها

```bash
pnpm test:outbox-b2        # قفل‌های ایمنی و شکل SQL — بدون پایگاه داده
pnpm test:outbox-b2-pg     # صحت، روی PostgreSQL واقعی (نیازمند pnpm infra:up)
pnpm test:outbox-b2-vacuum-pg   # D-045: Backfill «required» می‌گوید و Vacuum نمی‌زند؛ دستور نگه‌داری با شمارنده‌ها اثبات می‌کند
```

`test:outbox-b2-vacuum-pg` در CI در کار «Migration verifiers and database guards» (`migration-guards`) اجرا می‌شود؛ از #198 جدا از کار Integration، و از task 082 یکی از کارهایی است که Check الزامی «Migration reversibility and database guards» تجمیعشان می‌کند.

آزمون‌های PostgreSQL هر کدام Schema یک‌بارمصرف خودشان را می‌سازند و در پایان
حذف می‌کنند؛ هیچ‌کدام به `public` دست نمی‌زند. عمداً در `pnpm verify` نیستند،
چون به زیرساخت زنده نیاز دارند.

چند مورد از آن‌ها **خودِ CLI را به‌عنوان فرآیند اجرا می‌کنند** و کد خروج واقعی
را می‌سنجند — Dry-Run صفر، برش مرزدار یک، و اجرای همگرای بعدی دوباره صفر. کد
خروج در هیچ آزمونی شبیه‌سازی نمی‌شود.

---

## ۷. آنچه این Runbook پوشش نمی‌دهد

- **جریان مسدود بر اثر رویداد مسموم** و هشدارهایش — متعلق به **B6**؛ پیش از
  روشن کردن Flag های B4 نوشته می‌شود، نه حالا.
- **بازگردانی داده B2** — رویهٔ بازبینی‌شدهٔ جداگانه (§ ۵).
- **Backfill روی پایگاه دادهٔ تولیدی** — این ابزار عمداً `NODE_ENV=production`
  را رد می‌کند.

---

## مرجع

- [ADR-051 — ترتیب معنایی هر جریان در Outbox](../adr/ADR-051-outbox-semantic-ordering.md)
- [ADR-051 — طرح اجرا](../adr/ADR-051-implementation-plan.md) § B2
- [outbox-stuck](outbox-stuck.md) — Runbook صف Outbox، مستقل از این ابزار
