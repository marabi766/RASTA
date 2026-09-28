# Runbook: بررسی و بازپخش DLQ

**شدت:** 🟠 هشدار
**سیگنال محرک:** `rasta_dlq_messages_total{service,topic,reason}` افزایش یافت (**هر پیام جدید**)، یا Topic DLQ رشد کرد.
`EventConsumer` مشترک این شمارنده را فقط پس از انتشار موفق به Topic DLQ یک واحد افزایش می‌دهد (`topic` = Topic مبدأ).
**هشدار:** `RastaDeadLetterMessagePublished` (🟠 `warning`) در
[`infrastructure/docker/prometheus/rules/rasta-audit-alerts.yml`](../../infrastructure/docker/prometheus/rules/rasta-audit-alerts.yml)
با `sum by (service, topic, reason) (increase(rasta_dlq_messages_total[5m])) > 0` و بی `for`؛ Labelهای هشدار همان
`service`، `topic` (Topic **مبدأ**) و `reason`اند. این قاعده را **فقط Prometheus محلی** Compose ارزیابی می‌کند و در `/alerts`
آن دیده می‌شود؛ **مخزن Alertmanager ندارد، پس هیچ اعلانی به کسی تحویل نمی‌شود**، و Scrape محیط واقعی وابسته به استقرار است.
شمارنده از شروع فرایند است و عمق فعلی DLQ نیست. هر مصرف‌کنندهٔ دارای Topic DLQ همهٔ ترکیب‌های Topic مبدأ × `reason` را از
ساخته شدن با صفر صادر می‌کند، پس نخستین پیام DLQ هم هشدار می‌دهد ([README](README.md#مقداردهی-صفر-هشدارهای-شمارنده)).
**عمق نگه‌داشته ≠ پیام حل‌نشده.** فقط برای `rasta.audit.v1.dlq` Prometheus محلی Recording Rule
`topic:kafka_topic_retained_records:sum` را از `kafka-exporter` (`danielqsj/kafka-exporter:v1.9.0`) ثبت می‌کند:
`sum by (topic) (clamp_min(kafka_topic_partition_current_offset{topic="rasta.audit.v1.dlq"} - kafka_topic_partition_oldest_offset{topic="rasta.audit.v1.dlq"}, 0))`.
این تعداد رکوردی است که Kafka هنوز در آن Topic نگه می‌دارد؛ مخزن هیچ وضعیت Triage، تأیید یا بازپخش برای پیام DLQ ثبت
نمی‌کند، پس بازپخش یا تعیین تکلیف این عدد را کم **نمی‌کند** و فقط Retention (سی روز) آن را کم می‌کند. عمداً هشداری روی آن
نیست — هشداری که فقط با Retention یا حذف Topic برطرف شود نویز است — و نشانهٔ اقدام‌پذیر همان
`RastaDeadLetterMessagePublished` برای هر نوشتن تازه است. Topicهای DLQ دیگر عمق ثبت‌شده ندارند؛ آن‌ها را مستقیم با گام ۲ ببین.
**زمان پاسخ هدف:** ۲ ساعت (۱۵ دقیقه اگر رویداد مالی است)

---

## علائم

پیامی وارد `rasta.<domain>.v1.dlq` شده است.

## اثر

یک رویداد پردازش نشده. اثر بستگی به رویداد دارد:

| رویداد                    | اثر                                           |
| ------------------------- | --------------------------------------------- |
| `ORDER_RECEIPT_CONFIRMED` | **تسویه انجام نشد — پول کاربر Hold مانده** 🔴 |
| `STATEMENT_APPROVED`      | **پرداخت پیمانکار انجام نشد** 🔴              |
| `MAINTENANCE_DUE`         | اعلان سررسید نرفت 🟠                          |
| `ASSET_UPDATED`           | Read Model کهنه ماند 🟡                       |

**DLQ صندوق فراموشی نیست.** هر پیام باید بررسی و تعیین تکلیف شود.

---

## تشخیص

### ۱. چه چیزی در DLQ است؟

```bash
docker compose exec kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server kafka:9094 --consumer.config /tmp/admin.properties \
  --topic rasta.marketplace.v1.dlq \
  --from-beginning --max-messages 20 \
  --property print.headers=true
```

Broker توسعه احراز می‌کند (ADR-061 § ۳، اصلاحیهٔ 2026-09-28): ابزارهای خط فرمان درون Container با
`/tmp/admin.properties` وصل می‌شوند که `broker-entrypoint.sh` از `KAFKA_SASL_PASSWORD_ADMIN` می‌سازد. `admin` فقط برای
تشخیص محلی است؛ در محیط واقعی خواندن DLQ با Principal `ops-replay` است (گام ۳).

Headerهای کلیدی:

| Header                  | معنا                  |
| ----------------------- | --------------------- |
| `x-dlq-reason`          | دلیل دسته‌بندی‌شده    |
| `x-dlq-original-topic`  | Topic مبدأ            |
| `x-dlq-attempts`        | تعداد تلاش پیش از DLQ |
| `x-dlq-error`           | متن خطا               |
| `x-dlq-first-failed-at` | نخستین شکست           |

### ۲. عمق DLQ به تفکیک دلیل

برای `rasta.audit.v1.dlq` در Prometheus محلی: `topic:kafka_topic_retained_records:sum{topic="rasta.audit.v1.dlq"}` و روند آن
(`delta(topic:kafka_topic_retained_records:sum[1h])` مثبت یعنی نوشتن تازه). برای هر Topic دیگر، یا در نبود Prometheus:

```bash
docker compose exec kafka /opt/kafka/bin/kafka-get-offsets.sh \
  --bootstrap-server kafka:9094 --command-config /tmp/admin.properties \
  --topic rasta.marketplace.v1.dlq
```

### ۳. آیا رویداد مالی است؟

```
🔴 رویدادهای مالی — نیازمند بررسی انسانی، هرگز بازپخش خودکار:
   ORDER_RECEIPT_CONFIRMED · PAYMENT_* · COMMISSION_APPLIED
   SETTLEMENT_COMPLETED · STATEMENT_APPROVED · JOURNAL_POSTED
```

---

## اقدام

### گام ۱ — دسته‌بندی علت

| `x-dlq-reason`               | معنا                                                  | اقدام                                                                    |
| ---------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------ |
| `VALIDATION_FAILED`          | Payload با Schema نمی‌خواند                           | باگ Producer — رفع کن، سپس بازپخش                                        |
| `SCHEMA_VERSION_UNSUPPORTED` | Consumer نسخه را نمی‌شناسد                            | Consumer را به‌روز کن، سپس بازپخش                                        |
| `BUSINESS_RULE_VIOLATION`    | رویداد در وضعیت فعلی معتبر نیست                       | **بررسی دستی** — ممکن است بازپخش نباید انجام شود                         |
| `UPSTREAM_UNAVAILABLE`       | وابستگی در دسترس نبود                                 | وابستگی را برگردان، سپس بازپخش                                           |
| `MAX_RETRIES_EXCEEDED`       | خطای گذرا که ادامه یافت                               | علت را بررسی کن، سپس بازپخش                                              |
| `SOURCE_UNCONFIRMED`         | سرویس مالک، ادعای رویداد را تأیید نکرد (ADR-061 § ۴)  | **بررسی امنیتی** — جعل یا باگ ناشر؛ بی رفع در منبع بازپخش نکن            |
| `BACKFILL_REQUIRED`          | پاداشِ رویدادی پیش از Cutover ارزیابی (ADR-061 § ۴.۲) | **بازپخش نکن** — فقط Backfill مجاز و ثبت‌شده؛ بازپخش همان پاسخ را می‌دهد |
| `PRODUCER_NOT_ALLOWED`       | ناشر روی این Topic مجاز نیست (ADR-061 § ۲)            | **بررسی امنیتی؛ بازپخش نکن** — ناشر مجاز؟ `TOPIC_PRODUCERS` را اصلاح کن  |

### گام ۲ — رفع علت ریشه‌ای

**پیش از بازپخش، علت را رفع کن.** بازپخش بدون رفع، پیام را دوباره به DLQ می‌فرستد.

### گام ۳ — بازپخش

**چه کسی.** فقط Principal `ops-replay` (RUN-006، ADR-061 § ۳): تنها Principalی که Topicهای `.retry` را **می‌نویسد** و DLQ
سرویس‌های دیگر را **می‌خواند**، زیر گروه‌های `ops-replay.`. نه روی Topic اصلی می‌نویسد، نه روی DLQ؛ Topic اصلی فقط مال
ناشر است، پس پیام بازپخش‌شده هرگز به نام ناشر روی Topic او نمی‌نشیند. مصرف‌کننده `.retry` هر Topic مشترکش را با همان
اعلام `TOPIC_CONSUMERS` می‌خواند و بررسی ناشر (ADR-061 § ۲) همان‌جا دوباره اجرا می‌شود. گذرواژه:
`KAFKA_SASL_PASSWORD_OPS_REPLAY` (در توسعه از `.env`؛ چرخش: [kafka-credential-rotation](kafka-credential-rotation.md)).

**مسیر:** `rasta.<domain>.v1.dlq` ← (خواندن با `ops-replay`) ← بررسی ← `rasta.<domain>.v1.retry` (نوشتن با
`ops-replay`). Broker هر مسیر دیگری را رد می‌کند؛ `scripts/kafka-acl.broker.test.mjs` همین را در CI نشان می‌دهد.

> ⚠️ **شکاف باز (D-039).** مخزن هنوز **ابزار بازپخش ندارد** (`replay-dlq.js` که نسخه‌های پیشین این Runbook نام می‌بردند
> هرگز ساخته نشد) و **هیچ Consumerی امروز `.retry` را Subscribe نمی‌کند**؛ مجوزش را دارد، اشتراکش را نه. تا رفع D-039،
> بازپخش یعنی: پیام را با `ops-replay` از DLQ بخوان، علت را رفع کن، و اثرش را در سرویس مالک از مسیر عادی خودش (نه با
> نوشتن دستی روی Topic ناشر) دوباره بساز. هیچ دور زدنی با اعتبار یک سرویس مجاز نیست: نوشتن به نام ناشر همان جعلی است که
> ADR-061 می‌بندد.

وقتی ابزار ساخته شد، دو قاعده‌اش همین‌اند: اول همیشه `--dry-run`، و هدف همیشه `<topic>.retry`، نه `<topic>`.
بازپخش امن است چون مصرف‌کننده‌ها Idempotent‌اند (`processed_event`).

**رویداد مالی:** ⛔

```
۱. اثر مالی را دستی بررسی کن:
   - آیا Hold هنوز فعال است؟
   - آیا Journal ناقصی Post شده؟
   - وضعیت واقعی سفارش یا صورت‌وضعیت چیست؟
۲. تأیید بگیر (مسئول عملیات مالی)
۳. تک‌پیام بازپخش کن، نه دسته‌ای
۴. بلافاصله توازن دفتر کل را بررسی کن
```

### گام ۴ — پیامی که نباید بازپخش شود

اگر رویداد واقعاً نامعتبر است (مثلاً یک باگ Producer که هرگز نباید آن رویداد را می‌ساخت):

```
۱. تصمیم و دلیل را مستند کن
۲. Offset را Commit کن بدون پردازش
۳. یک مورد در Backlog برای رفع باگ Producer ثبت کن
```

**هرگز** بی‌سر و صدا رها نکن.

---

## تأیید رفع

```bash
# DLQ نباید رشد کند
docker compose exec kafka /opt/kafka/bin/kafka-get-offsets.sh \
  --bootstrap-server kafka:9094 --command-config /tmp/admin.properties \
  --topic rasta.marketplace.v1.dlq
```

- متریک `rasta_dlq_messages_total` برای همان `service`/`topic` پس از بازپخش دوباره افزایش نیافته (شمارنده با راه‌اندازی دوبارهٔ فرایند صفر می‌شود؛ معیار اصلی همان Offset بالاست)
- برای `rasta.audit.v1.dlq`: `topic:kafka_topic_retained_records:sum` دیگر **افزایش** نمی‌یابد — انتظار نداشته باش پس از بازپخش کم شود؛ رکوردهای بازپخش‌شده تا Retention در Topic می‌مانند
- اثر کسب‌وکاری رویداد بازپخش‌شده در پایگاه داده دیده می‌شود
- اگر مالی بود: توازن دفتر کل بررسی شده

---

## پیشگیری

- اعتبارسنجی Schema **پیش از** درج در Outbox
- تست قرارداد برای هر رویداد و هر مصرف‌کننده در CI
- تغییر شکننده Schema فقط با فرآیند سه‌استقراری
- هشدار روی نخستین پیام DLQ — نه روی آستانه
