# Runbook: Outbox Relay گیر کرده

**شدت:** 🟠 هشدار
**هشدار محرک:** `rasta_outbox_pending_age_seconds > 60`
**زمان پاسخ هدف:** ۳۰ دقیقه

---

## علائم

- سن قدیمی‌ترین پیام منتشرنشده در `outbox_message` از ۶۰ ثانیه گذشته
- `rasta_outbox_pending_total` مدام رشد می‌کند
- مصرف‌کننده‌های Downstream رویداد نمی‌گیرند (اعلان نمی‌رسد، کارمزد محاسبه نمی‌شود)

## اثر

**هیچ داده‌ای گم نشده** — این مهم‌ترین نکته است. رویدادها در پایگاه داده امن‌اند و پس از
رفع مشکل منتشر می‌شوند. اما فرآیندهای Downstream **متوقف‌اند**: تسویه انجام نمی‌شود،
اعلان نمی‌رود، Read Model کهنه می‌ماند.

---

## تشخیص

### ۱. کدام سرویس و چقدر عقب است؟

```sql
SELECT COUNT(*) AS pending,
       MIN(created_at) AS oldest,
       EXTRACT(EPOCH FROM now() - MIN(created_at)) AS age_seconds,
       MAX(attempts) AS max_attempts
FROM outbox_message
WHERE published_at IS NULL;
```

### ۲. آیا خطای تکراری وجود دارد؟

```sql
SELECT topic, event_name, attempts, last_error, COUNT(*)
FROM outbox_message
WHERE published_at IS NULL AND last_error IS NOT NULL
GROUP BY topic, event_name, attempts, last_error
ORDER BY COUNT(*) DESC
LIMIT 20;
```

### ۳. آیا Kafka سالم است؟

```bash
docker compose exec kafka kafka-topics.sh --bootstrap-server localhost:9094 --list
docker compose exec kafka kafka-topics.sh --bootstrap-server localhost:9094 \
  --describe --topic rasta.marketplace.v1
```

### ۴. آیا Relay اصلاً زنده است؟

```bash
docker compose logs --tail=200 marketplace-service | grep -i outbox
# در Kubernetes:
kubectl logs -l app=marketplace-service -n rasta-prod --tail=200 | grep -i outbox
```

---

## اقدام

### علت A — Kafka در دسترس نیست

```
۱. وضعیت Broker را بررسی کن
۲. Kafka را برگردان
۳. Relay خودکار از سر می‌گیرد — هیچ اقدام دستی لازم نیست
۴. کاهش صف را پایش کن
```

### علت B — Topic وجود ندارد

`auto.create.topics.enable=false` است، پس تولید روی Topic ناشناخته شکست می‌خورد.
این معمولاً یعنی یک رویداد جدید بدون افزودن Topic مستقر شده.

```bash
docker compose exec kafka bash /create-topics.sh
# یا در Production، Topic خاص را بساز
```

سپس بررسی کن چرا Topic در `create-topics.sh` نبوده — این یک نقص فرآیندی است.

### علت C — Payload نامعتبر

اگر یک پیام خاص مدام شکست می‌خورد و بقیه را متوقف کرده:

```sql
SELECT id, event_name, topic, attempts, last_error, payload
FROM outbox_message
WHERE published_at IS NULL AND attempts > 5
ORDER BY created_at LIMIT 10;
```

**اگر رویداد مالی نیست** و Payload واقعاً نامعتبر است:

```sql
-- به‌عنوان شکست‌خورده علامت بزن تا صف باز شود؛ داده حفظ می‌شود
UPDATE outbox_message
SET published_at = now(), last_error = 'MANUALLY SKIPPED — incident <شماره>'
WHERE id = $1;
```

**اگر رویداد مالی است:** ⛔ **هرگز Skip نکن.** به
[`ledger-imbalance.md`](ledger-imbalance.md) مراجعه کن و علت ریشه‌ای را رفع کن.

### علت D — Relay متوقف شده

```bash
kubectl rollout restart deployment/<service> -n rasta-prod
# محلی:
pnpm --filter @rasta/<service> dev
```

### علت E — حجم بالا، Relay عقب مانده

اگر خطایی نیست و فقط سرعت کم است:

```
۱. OUTBOX_BATCH_SIZE را افزایش بده (پیش‌فرض ۱۰۰)
۲. OUTBOX_POLL_INTERVAL_MS را کاهش بده (پیش‌فرض ۵۰۰)
۳. Replica سرویس را افزایش بده — با Claim بادوام (ADR-050) دو رله دیگر یک ردیف
   را هم‌زمان Claim نمی‌کنند: مالکیت با `claim_token` مهر می‌شود و هر Mutation
   مشروط بر آن است. آنچه این **حل نمی‌کند** تحویل تکراری هنگام Crash میان
   Publish و Ack است (G3، ذاتیِ At-Least-Once) — پس مصرف‌کنندهٔ ایدمپوتنت
   (A-09) همچنان الزامی است.
```

---

## تأیید رفع

```sql
SELECT COUNT(*) AS pending,
       EXTRACT(EPOCH FROM now() - MIN(created_at)) AS age_seconds
FROM outbox_message WHERE published_at IS NULL;
-- age_seconds باید زیر ۶۰ برگردد و pending رو به کاهش باشد
```

متریک `rasta_outbox_pending_age_seconds` باید به حالت عادی برگردد.

---

## پیشگیری

- `create-topics.sh` باید بخشی از Checklist افزودن رویداد جدید باشد
- اعتبارسنجی Schema **پیش از** درج در Outbox، نه هنگام انتشار
- هشدار روی `attempts > 5` برای تشخیص زودتر
- پایش `rasta_outbox_pending_total` در داشبورد Event Pipeline

---

## Backlog پس از ADR-050 — سه حالت، سه اقدام

با Claim بادوام، «Backlog» دیگر یک وضعیت نیست. این سه را از هم جدا کن، وگرنه
اقدام اشتباه انتخاب می‌شود:

```sql
SELECT
  count(*) FILTER (WHERE claim_token IS NULL AND next_attempt_at IS NULL)      AS never_claimed,
  count(*) FILTER (WHERE claim_expires_at > now())                             AS live_lease,
  count(*) FILTER (WHERE claim_expires_at <= now())                            AS expired_lease,
  count(*) FILTER (WHERE next_attempt_at > now())                              AS in_backoff
FROM outbox_message WHERE published_at IS NULL;
```

| وضعیت           | معنا                                     | اقدام                                                                               |
| --------------- | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| `never_claimed` | رله اصلاً نمی‌رسد                        | رله زنده است؟ `OUTBOX_POLL_INTERVAL_MS` و `OUTBOX_BATCH_SIZE` را ببین               |
| `live_lease`    | یک Worker همین الان دارد منتشرشان می‌کند | صبر کن. اگر ماند، Kafka کند است — Log رله و `kafka_producer_messages_total` را ببین |
| `expired_lease` | مدعی مرد؛ ردیف واجد شرایط Claim مجدد است | خودبه‌خود برمی‌گردد. اگر برنگشت یعنی هیچ رله‌ای زنده نیست                           |
| `in_backoff`    | شکست خورده و منتظر تلاش بعدی است         | `last_error` را بخوان. این ردیف مسموم است، نه گیرکرده                               |

`rasta_outbox_leases_active` همین `live_lease` است، از سمت متریک.

### `ack_fenced_total` غیرصفر شد

یعنی این Worker مالکیت ردیف‌هایی را از دست داد و آن‌ها را Ack نکرد. **این ثابت
نمی‌کند تحویل تکراری رخ داده** — رله نمی‌تواند بداند یک `sendBatch` که نتیجه‌اش
نامعلوم ماند به Broker رسید یا نه. ممکن است رخ داده باشد. مصرف‌کنندهٔ ایدمپوتنت
(A-09) همان چیزی است که اثر تجاری‌اش را مهار می‌کند.

اگر پیوسته غیرصفر است، یکی از این‌هاست: Lease کوتاه‌تر از انتشار واقعی، یا
پایگاه داده‌ای که تمدید را دیر جواب می‌دهد. `OUTBOX_CLAIM_LEASE_SECONDS` را بالا
ببر (بدون Deploy) و Log `Outbox lease renewal failed twice` را بگرد.

---

## شکست Migration با `lock_timeout` (55P03)

هر Migration این ADR با `SET LOCAL lock_timeout = '3s'` شروع می‌شود. اگر
`CREATE INDEX` پشت یک تراکنش طولانی صف بکشد، Migration با
`55P03 lock_not_available` **سریع و امن** می‌افتد. Prisma کل فایل را در یک
تراکنش می‌پیچد، پس Rollback کامل است و هیچ‌چیز نیمه‌کاره نمی‌ماند.

۱. تراکنش مانع را پیدا کن:

```sql
SELECT pid, state, age(now(), xact_start) AS age, query
  FROM pg_stat_activity
 WHERE state <> 'idle'
 ORDER BY xact_start
 LIMIT 10;
```

۲. اگر یک رلهٔ کند یا Session فراموش‌شده است، پایانش بده یا صبر کن.
۳. Migration را دوباره اجرا کن — `IF NOT EXISTS` یعنی اجرای دوباره امن است.
۴. اگر **سه بار پشت‌سرهم** افتاد، جدول همیشه تحت تراکنش طولانی است: آن‌وقت مسیر
دستی `CREATE INDEX CONCURRENTLY` (خارج از Prisma، پیش از Deploy) انتخاب درست
است.

**`lock_timeout` را بالا نبر تا Deploy رد شود.** انتظار بی‌پایان روی این جدول
یعنی صفِ قفل پشت Migration هر `INSERT` تازه را هم می‌بندد — یعنی نوشتن Outbox
کاملاً متوقف می‌شود. مهلت کوتاه، همان چیزی است که این را غیرممکن می‌کند.

### تأیید Index دستی — نام کافی نیست

Index ی با نام درست و Predicate اشتباه بدتر از نبودنش است: Migration با
`IF NOT EXISTS` از رویش رد می‌شود و پرس‌وجو بی‌صدا کند می‌ماند.

```sql
SELECT indexdef FROM pg_indexes
 WHERE tablename = 'outbox_message' AND indexname = 'ix_outbox_claimable';
-- باید دقیقاً این باشد:
-- CREATE INDEX ix_outbox_claimable ON public.outbox_message
--   USING btree (created_at, id) WHERE (published_at IS NULL)
```

## Rollback پس از ADR-050

`down.sql` این Migration ستون‌ها را حذف می‌کند، پس **کد باید پیش از Schema
برگردد**. یک رلهٔ جدید روی Schema بدون این ستون‌ها روی هر Claim می‌افتد.

و یک نکته که باید پیش از Rollback دانسته شود، نه بعدش: ردیفی که Claim شده و
هنوز Ack نشده، با حذف Fence **بلافاصله** دوباره Claimشدنی می‌شود — یعنی خودِ
Rollback می‌تواند یک انتشار تکراری بسازد. At-Least-Once این را از قبل مجاز
می‌داند (G3)، اما غافلگیری نباشد.
