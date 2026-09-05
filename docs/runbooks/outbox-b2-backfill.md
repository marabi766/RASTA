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

| قفل                     | رفتار                                                                 |
| ----------------------- | --------------------------------------------------------------------- |
| هدف صریح                | بدون `--service <name>` یا `--all` اجرا نمی‌شود؛ پیش‌فرضی وجود ندارد  |
| نوشتن صریح              | بدون `--apply` فقط Plan است؛ `--dry-run` و `--apply` با هم رد می‌شوند |
| محیط                    | `NODE_ENV=production` رد می‌شود؛ هر `NODE_ENV` ناشناخته هم رد می‌شود  |
| اتصال                   | فقط `DATABASE_URL_<SERVICE>`؛ **هرگز** بازگشت به `DATABASE_URL` مشترک |
| سرویس ناشناخته          | رد می‌شود (فقط هشت سرویس دارای Schema B1)                             |
| اندازهٔ دسته            | عدد صحیح مثبت و حداکثر **۵٬۰۰۰** (سقف ADR-051 § B2)                   |
| Schema B1               | هر ستون/جدول/Index باید با **تعریف** دقیق موجود باشد، نه فقط با نام   |
| ردیف تازه حین اجرا      | تشخیص داده و کل دسته Rollback می‌شود (§ «شرط سکون» پایین)             |
| شکست `VACUUM (ANALYZE)` | خطای عملیاتی گزارش می‌شود و اجرا می‌ایستد — ادامهٔ خاموش وجود ندارد   |

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

برای صف بزرگ، برشِ مرزدار بگیر و بین برش‌ها وضعیت را ببین:

```bash
node --env-file=.env scripts/outbox-b2-backfill.mjs --service economic --apply --max-batches 10
```

گزینه‌ها: `--batch-size <n>` (۱ تا ۵۰۰۰، پیش‌فرض ۵۰۰۰) ·
`--max-batches <n>` · `--vacuum-every <n>` (پیش‌فرض ۱).

### پیشرفت مورد انتظار

```json
{ "type": "batch", "service": "document", "batch": 1, "selected": 216, "updated": 216,
  "streams": 41, "remaining": 0, "elapsedMs": 48 }
{ "type": "vacuum", "service": "document", "batch": 1, "ok": true }
{ "type": "counters", "service": "document", "streams": 41, "written": 41 }
{ "type": "heads", "service": "document", "changed": 41, "heads": 41 }
{ "type": "verify", "service": "document", "remaining": 0, "sequenced": 216, "heads": 41,
  "streams": 41, "counter_rows": 41, "counter_next_mismatch": 0,
  "counter_published_mismatch": 0, "head_mismatch": 0 }
{ "type": "done", "service": "document", "mode": "apply", "batches": 1,
  "truncated": false, "converged": true }
```

**همگرایی یعنی این سه با هم:** `converged: true` · `remaining: 0` · و هر سه
شمارندهٔ `*_mismatch` برابر صفر.

---

## ۳. قطع شدن و از سرگیری

اجرا در هر لحظه قابل قطع است. تخصیص هر دسته در تراکنش خودش Commit شده و
`stream_seq` هیچ‌گاه دوباره شماره‌گذاری نمی‌شود؛ اجرای بعدی از همان‌جا ادامه
می‌دهد. اجرای دومِ کامل **No-Op** است: صفر دسته، صفر شمارنده، صفر سرصف.

اجرای قطع‌شده (`truncated: true`) عمداً شمارنده و سرصف را **نمی‌نویسد** — هر دو
در B2 بی‌اثرند، پس حالت میانی بی‌خطر است. برای رساندن آن به حالت نهایی، دستور را
بدون `--max-batches` دوباره اجرا کن.

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
```

آزمون‌های PostgreSQL هر کدام Schema یک‌بارمصرف خودشان را می‌سازند و در پایان
حذف می‌کنند؛ هیچ‌کدام به `public` دست نمی‌زند. عمداً در `pnpm verify` نیستند،
چون به زیرساخت زنده نیاز دارند.

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
