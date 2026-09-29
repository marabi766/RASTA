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

| Header                     | معنا                       |
| -------------------------- | -------------------------- |
| `x-dlq-reason`             | دلیل دسته‌بندی‌شده         |
| `x-dlq-original-topic`     | Topic مبدأ                 |
| `x-dlq-attempts`           | تعداد تلاش پیش از DLQ      |
| `x-dlq-error`              | متن خطا                    |
| `x-dlq-first-failed-at`    | نخستین شکست                |
| `x-dlq-original-partition` | پارتیشن پیام در Topic مبدأ |
| `x-dlq-original-offset`    | Offset پیام در Topic مبدأ  |

`x-dlq-error` همیشه «دسته‌بندی ثابت (کد `DlqReason`): پیام» است — مثلاً `Handler failed 3x (MAX_RETRIES_EXCEEDED): …` یا
`Unparseable message (VALIDATION_FAILED): the body is not valid JSON (N bytes)` — و محتوای بدنه را تکرار نمی‌کند؛ پیام Handler
پاک‌سازی‌شده و حداکثر ۲۰۰ نویسه است. از Headerهای پیام اصلی فقط Headerهای پلتفرم (`EVENT_HEADERS`، از جمله
`x-correlation-id` و `traceparent`) در پیام DLQ می‌مانند؛ Header دیگری (مثلاً `authorization`) منتقل نمی‌شود (S-09).
`x-producer` در پیام DLQ نام مصرف‌کننده‌ای است که آن را نوشت، نه ناشر اصلی؛ ناشر اصلی در `producer` بدنه است.

**آنچه ابزار بازپخش (گام ۳) لازم دارد و نگه داشته می‌شود:** بدنهٔ بایت‌به‌بایت دست‌نخورده، Headerهای
پلتفرم (`EVENT_HEADERS`)، و `x-dlq-original-topic`، `x-dlq-original-partition` و `x-dlq-original-offset`. **کلید پیام Kafka
نگه داشته نمی‌شود** ([D-040](../23-risks-and-tradeoffs.md)): پیام DLQ بی‌کلید نوشته می‌شود، و کلید اصلی (کلید پارتیشن
ناشر) همیشه از بدنه بازسازی‌پذیر نیست — پیش‌فرضش `aggregateId` است، اما ناشری که کلید صریح می‌دهد آن را فقط در `streamKey`
بدنه (وقتی Sequence دارد) یا ردیف Outbox خودش نگه می‌دارد.

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
سرویس‌های دیگر را **می‌خواند**، زیر گروه‌های `ops-replay.`؛ و برای بررسی کهنگی، Topicهای مبدأ مشترک را فقط **می‌خواند**
(همان گروه‌ها). نه روی Topic اصلی می‌نویسد، نه روی DLQ؛ Topic اصلی فقط مال ناشر است، پس پیام بازپخش‌شده هرگز به نام ناشر روی
Topic او نمی‌نشیند. گذرواژه: `KAFKA_SASL_PASSWORD_OPS_REPLAY` — در توسعه از `infrastructure/docker/kafka/bootstrap.env`
(پیش‌فرض‌ها در `bootstrap.env.example`)، **هرگز** از `.env` مشترکی که هر سرویس می‌خواند (`pnpm infra:up` و
`pnpm check:kafka-credential-scope` آن را در `.env` رد می‌کنند)؛ در استقرار از Secret Store اپراتور. چرخش:
[kafka-credential-rotation](kafka-credential-rotation.md).

**مسیر:** `rasta.<domain>.v1.dlq` ← (خواندن با `ops-replay`) ← بررسی ← `<Topic مبدأ>.retry` (نوشتن با `ops-replay`). Broker
هر مسیر دیگری را رد می‌کند؛ `scripts/kafka-acl.broker.test.mjs` همین را در CI نشان می‌دهد.

> ⚠️ **D-039:** هیچ Consumerی امروز `.retry` را Subscribe نمی‌کند (مجوزش را دارد، اشتراکش را نه). تا رفع آن در
> `packages/nest-common` (`EventConsumer` هر Topic را همراه `.retry`اش بخواند، با همان بررسی ناشر § ۲)، رکوردی که ابزار
> می‌نویسد به هیچ مصرف‌کننده‌ای **نمی‌رسد**. تا آن زمان راه عملی برای رویداد غیرمالی همان است که بود: علت را رفع کن و اثر را در
> سرویس مالک از **مسیر عادی خودش** (API یا فرمانی که بار اول اثر را ساخت) دوباره بساز — نه با نوشتن دستی روی Topic ناشر، که همان
> جعلی است که ADR-061 § ۲ می‌بندد.

**ابزار:** `scripts/replay-dlq.mjs` (قواعد: `scripts/replay-dlq-lib.mjs`). همیشه **اول Dry-run** — پیش‌فرض همین است و چیزی
نمی‌نویسد:

```bash
# توسعه: گذرواژهٔ ops-replay از فایل Bootstrap؛ استقرار: KAFKA_BROKERS، گذرواژه و CA از Secret Store، نه از این Repository
node --env-file=infrastructure/docker/kafka/bootstrap.env.example \
  --env-file-if-exists=infrastructure/docker/kafka/bootstrap.env \
  scripts/replay-dlq.mjs --dlq rasta.maintenance.v1.dlq --event-id EVT_… [--event-id …] \
  [--report replay.jsonl]

# یا بازه‌ای از Offsetهای یک پارتیشن DLQ
node … scripts/replay-dlq.mjs --dlq rasta.maintenance.v1.dlq --partition 0 --from-offset 120 --to-offset 124
```

انتخاب همیشه **صریح و محدود** است: یا `--event-id`، یا یک بازهٔ Offset؛ پیش‌فرض حداکثر ۱۰ و سقف `--max 100` — هرگز «کل DLQ».
گزارش (خروجی و `--report`) برای هر رکورد یک خط JSON است: شناسه‌ها، نام رویداد، دلیل، Offsetها، مقصد، کلید جریان، کهنگی و حکم —
**هرگز** Payload.

**اجرا** فقط وقتی Dry-run رضایت‌بخش بود، و با همان انتخاب:

```bash
REPLAY_OPERATOR=<نام اپراتور، بی Secret> node … scripts/replay-dlq.mjs --dlq … --event-id EVT_… \
  --execute --expect-count <تعدادی که Dry-run انتخاب کرد>
```

**قواعد ابزار** — هر کدام در گزارش با نام رد می‌شود:

- **مقصد همیشه `<Topic مبدأ>.retry`** از `x-dlq-original-topic`، و Topic مبدأ باید از اشتراک‌های همان مصرف‌کننده‌ای باشد که DLQ
  مال اوست؛ هرگز Topic اصلی.
- **بدنه بایت‌به‌بایت**، با **فقط** Headerهای پلتفرم (`EVENT_HEADERS`) که پیام DLQ داشت و مهر
  `x-replay-id: <reportId>/<operator>` — هیچ Header `x-dlq-*`. Header پلتفرمی که با بدنه نخواند رد می‌شود، اصلاح نمی‌شود.
- **کلید پیام = `streamKey` پاکت.** رویداد بی Sequence (`UNSEQUENCED`) رد می‌شود تا D-040 (نگه‌داشتن کلید در DLQ) برسد —
  هیچ حدسی از `aggregateId`.
- **رد می‌شوند:** `NEVER_AUTO_REPLAY` (همهٔ رویدادهای economic و `ORDER_RECEIPT_CONFIRMED`، `STATEMENT_APPROVED`) — بی هیچ
  Override؛ و دلیل‌هایی که بازپخش عوضشان نمی‌کند: `PRODUCER_NOT_ALLOWED`، `SOURCE_UNCONFIRMED`، `BACKFILL_REQUIRED`.
- **کهنگی (ADR-051 § R6):** Dry-run Topic مبدأ را از پس از Offset اصلی می‌خواند؛ اگر رویداد تازه‌تری با همان کلید جریان هست
  `stale: true`، و اگر نمی‌تواند ببیند (مبدأ `.retry`، یا بی موقعیت) `UNKNOWN`. `--execute` چنین رکوردی را رد می‌کند مگر
  `--allow-stale <eventId>` آن را **نام ببرد**. Idempotency مصرف‌کننده (`processed_event`) فقط تکرار را بی‌اثر می‌کند، نه کهنه را.
- **همه یا هیچ:** اجرا فقط وقتی می‌نویسد که **همهٔ** رکوردهای انتخاب قابل‌بازپخش باشند و تعدادشان دقیقاً `--expect-count` باشد؛
  انتخابی که ردشده دارد تنگ‌تر می‌شود، نیمه‌بازپخش نمی‌شود. سپس یکی‌یکی (`acks=-1`، Producer Idempotent)، به ترتیب DLQ، و
  در نخستین شکست توقف.
- **بازپخش به همهٔ مشترکان می‌رسد:** `<topic>.retry` را (پس از D-039) هر مصرف‌کنندهٔ آن Topic می‌خواند، نه فقط آن که DLQ
  کرد؛ برای بقیه تکراری است و `processed_event` آن را بی‌اثر می‌کند.
- **ممیزی:** هر رکورد بازپخش‌شده `x-replay-id` دارد و گزارش نگه داشته می‌شود. رکورد ممیزی پلتفرم برای هر بازپخش (Topic
  `rasta.ops.replay.v1`، ناشر فقط `ops-replay`، مصرف‌کننده audit-service) کار بعدی است.

**رویداد مالی:** ⛔ ابزار این رویدادها را **همیشه** رد می‌کند (`NEVER_AUTO_REPLAY`). اثرشان فقط دستی و از مسیر عادی سرویس
مالک:

```
۱. اثر مالی را دستی بررسی کن:
   - آیا Hold هنوز فعال است؟
   - آیا Journal ناقصی Post شده؟
   - وضعیت واقعی سفارش یا صورت‌وضعیت چیست؟
۲. تأیید بگیر (مسئول عملیات مالی)
۳. اثر را تک‌به‌تک از مسیر عادی سرویس مالک بساز، نه دسته‌ای — هرگز با بازپخش
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
