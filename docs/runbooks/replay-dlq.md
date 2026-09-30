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
هم نگه داشته می‌شود** ([D-040](../23-risks-and-tradeoffs.md)، رفع‌شده): `deadLetter()` کلید اصلی (`message.key`، کلید
پارتیشن ناشر) را بر پیام DLQ می‌گذارد؛ پیام بی‌کلید تنها وقتی بی‌کلید می‌ماند که اصلی‌اش بی‌کلید بوده. ابزار بازپخش همان
کلید را بر پیام `.retry` می‌گذارد و لازم نیست آن را از بدنه بازسازی کند. رکوردهای DLQ **پیش از** این تغییر بی‌کلیدند.

اگر پیام از `.retry` به DLQ برود، `x-dlq-original-topic` همان `<topic>.retry` است (Topicی که Broker تحویل داد)؛ Topic
مالک `<topic>` است، پس ابزار برای بازپخش دوباره باید پسوند `.retry` را نگیرد و یکی بیفزاید.

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
(همان گروه‌ها) — جز `NEVER_AUTO_REPLAY_TOPICS` (`rasta.economic.v1`) که هرگز بازپخشش نمی‌کند، پس نه آن را می‌خواند و نه
روی `.retry` آن می‌نویسد (هیچ Principalی نمی‌نویسد). نه روی Topic اصلی می‌نویسد، نه روی DLQ؛ Topic اصلی فقط مال ناشر است، پس پیام بازپخش‌شده هرگز به نام ناشر روی
Topic او نمی‌نشیند. گذرواژه: `KAFKA_SASL_PASSWORD_OPS_REPLAY` — در توسعه از `infrastructure/docker/kafka/bootstrap.env`
(پیش‌فرض‌ها در `bootstrap.env.example`)، **هرگز** از `.env` مشترکی که هر سرویس می‌خواند (`pnpm infra:up` و
`pnpm check:kafka-credential-scope` آن را در `.env` رد می‌کنند)؛ در استقرار از Secret Store اپراتور. چرخش:
[kafka-credential-rotation](kafka-credential-rotation.md).

**مسیر:** `rasta.<domain>.v1.dlq` ← (خواندن با `ops-replay`) ← بررسی ← `<Topic مبدأ>.retry` (نوشتن با `ops-replay`). Broker
هر مسیر دیگری را رد می‌کند؛ `scripts/kafka-acl.broker.test.mjs` همین را در CI نشان می‌دهد.

> **D-039 (بخش ۱ رفع‌شده):** `EventConsumer` هر Topic اعلام‌شده را همراه `.retry` آن Subscribe می‌کند، پس نوشتن مجاز
> `ops-replay` روی `.retry` به مصرف‌کنندهٔ مالک می‌رسد و همان بررسی‌ها را می‌گذراند: Schema پاکت، بررسی ناشر (§ ۲) با
> ناشران Topic **اصلی**، Tenant و `processed_event`؛ خطا به همان DLQ می‌رود. ناشر جعلی روی `.retry` با
> `PRODUCER_NOT_ALLOWED` به DLQ می‌رود و رویداد پردازش‌شده قبلی تکراری است (بی‌اثر). ابزار بازپخش (بخش ۲) در ادامه است.
> `audit-service` و `notification-service` بازپخش را با همان Topic اصلی ثبت می‌کنند (`originalDelivery` در
> `@rasta/nest-common`). هیچ دور زدنی با اعتبار یک سرویس مجاز نیست.
>
> **بازپخش ترتیب را حفظ نمی‌کند — پس رویداد حالت‌ساز در `.retry` بار خود را اعمال نمی‌کند، از مالک تازه می‌شود.** `<topic>` و
> `<topic>.retry` دو جریان جدا هستند و رویداد بازپخش‌شده می‌تواند پس از رویدادهای جدیدتر برسد. پس Consumerی که _حالت_ نگه می‌دارد،
> روی تحویل `.retry` بار را اعمال **نمی‌کند** و وضعیت فعلی را از سرویس مالک می‌خواند (REST داخلی احرازشده، ADR-061 § ۴؛ Tenant از
> توکن امضاشده): Replica دارایی در fleet و maintenance از `GET /v1/internal/assets/:id/snapshot` در asset-service (مالک فعلی
> تصویر کامل می‌گیرد؛ مالک _پیشین_ فقط `transferred: true` و مالک فعلی؛ دیگران همان ۴۰۴ دارایی ناموجود)، پرچم `inMaintenance` در
> fleet از `…/maintenance-state` در maintenance، و وضعیت دارایی در asset-service (رویدادهای `ASSET_ASSIGNED`،
> `ASSIGNMENT_ENDED`، `MAINTENANCE_STARTED`، `MAINTENANCE_COMPLETED`) از `…/assignment-state` در fleet و `…/maintenance-state`،
> فقط از راه جدول انتقال مجاز. تغییر مالک در تصویر همان مسیر `ASSET_TRANSFERRED` را می‌رود (پایان تخصیص‌ها، رها کردن Fence)، و Fence
> سازمانی که دیگر مالک نیست همیشه حذف می‌شود. **بسته‌شده در شکست:** پاسخ احرازشده‌ای نیامد ⇐ خطا ⇐ تلاش دوباره ⇐ DLQ؛ بار کهنه هرگز
> اعمال نمی‌شود. تحویل روی Topic اصلی همان رفتار پیشین را دارد. Consumerهای افزودنی (audit، supplier، usage) و رویدادهای ایمنی fleet
> (بازرسی/بیمه) تغییری ندارند؛ economic و identity حالت را از مالک/پایگاه می‌خوانند. ورودی پرونده/Timeline دارایی همچنان ثبت می‌شود.
>
> **خواندن و نوشتن زیر یک قفل.** تازه‌سازی داخل همان تراکنشی انجام می‌شود که Consumer برای هر تحویل دارایی می‌گیرد (fleet:
> `lockAssetRef`؛ maintenance: `lockAssetRef` و سپس قفل کار انحصاری؛ asset-service: قفل انحصاری ردیف دارایی) و **پس از** گرفتن آن
> از مالک می‌پرسد (هر پرسش ≤ ۳ ثانیه، تراکنش ≤ ۳۰ ثانیه). پس رویداد جدیدتر Topic اصلی که همان لحظه برسد صبر می‌کند و بعد از
> تازه‌سازی اعمال می‌شود؛ تازه‌سازی هرگز نسخهٔ قدیمی‌تری را روی آن نمی‌نویسد. بازپخش کار نادر اپراتور است و این انتظار پذیرفته است.
> **Tenant:** مالک همیشه با Tenant _خود رویداد_ پرسیده می‌شود (نه مالک Replica). ۴۰۴ ⇐ `SOURCE_UNCONFIRMED` پیش از هر اثر (شامل
> بخش «رفع خرابی بازرسی» در `MAINTENANCE_COMPLETED`)؛ پاسخ «مالک پیشین» فقط تغییر مالک را دنبال می‌کند و هیچ اثر ایمنی برای
> Tenantی که دیگر مالک نیست ندارد. **Fence:** فقط وقتی حذف می‌شود که مالک فعلی (از تصویر زیر قفل) با سازمانِ گذارندهٔ Fence فرق
> کند **و** asset-service انتقالی ثبت‌شده از همان سازمان را تأیید کند؛ Fence مالک فعلی، یا انتقالی که ثبت نشده، هرگز حذف نمی‌شود.
>
> **باقی‌ماندهٔ خودتصحیح‌شونده.** رویداد _اصلی_ که از تصویر مالک قدیمی‌تر است ولی هنوز در راه (پیش از تراکنش) است، پس از تازه‌سازی
> بار قدیمی‌ترش را اعمال می‌کند و رویداد بعدیِ همان جریان (که به ترتیب می‌رسد) وضعیت را برمی‌گرداند — Replica لحظه‌ای عقب‌تر از منبع
> است، دقیقاً مثل هر تأخیر عادی Consumer. موردی که خودتصحیح نباشد پیدا نشد: Fence را مسیر اصلی فقط با `ASSET_TRANSFERRED` و برای
> سازمان مبدأ همان انتقال حذف می‌کند و Fence مالک فعلی را هیچ مسیری نمی‌گیرد؛ مالک را فقط رویداد بعدی درست می‌کند.

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
  مال اوست؛ هرگز Topic اصلی. پیامی که **از** `.retry` دوباره DLQ شده (`x-dlq-original-topic` = `<topic>.retry`) با حذف **دقیقاً
  یک** پسوند `.retry` به همان `<topic>.retry` برمی‌گردد (`.retry.retry` رد می‌شود).
- **بدنه بایت‌به‌بایت**، با **فقط** Headerهای پلتفرم (`EVENT_HEADERS`) و مهر `x-replay-id: <reportId>/<operator>` — هیچ Header
  `x-dlq-*`. Header پلتفرمی که با بدنه نخواند رد می‌شود، اصلاح نمی‌شود (`HEADER_BODY_MISMATCH:<name>`) — هم در مقدار و هم در
  **حضور**: Header بی فیلد متناظر در بدنه (مثلاً `x-tenant-id` بی `tenantId`)، یا فیلد بدنه بی Header، هم ناهمخوانی است؛ Relay
  هر Header را دقیقاً وقتی می‌نویسد که فیلدش هست — جز `x-producer`: پیام DLQ آن را عمداً با نام مصرف‌کننده‌ای
  که DLQ کرد می‌نویسد، پس ابزار آن را نه مقایسه و نه کپی می‌کند و از `producer` پاکت بازمی‌سازد، همان‌طور که Relay گذاشته بود.
- **کلید پیام:** همیشه کلیدی که پیام DLQ از اصل نگه داشته (D-040، #145)، هرگز کلید استنتاج‌شده. رویداد دارای `streamKey`:
  کلید نگه‌داشته باید همان باشد (`KEY_MISMATCH`)، و اگر پیام DLQ **بی کلید** است `KEY_UNVERIFIABLE` رد می‌شود — پیش از #145
  DLQ شده، یا اصلاً بی کلید منتشر شده (پس روی پارتیشن دیگری است)، و بی خواندن رکورد اصلی این دو از هم جدا نمی‌شوند. پیام بی
  `streamKey` و **بی کلید** — رویداد بی Sequence که پیش از #145 DLQ شده — `UNSEQUENCED_NO_KEY` رد می‌شود؛ هیچ حدسی از
  `aggregateId`.
- **رد می‌شوند:** `NEVER_AUTO_REPLAY` (همهٔ رویدادهای economic و `ORDER_RECEIPT_CONFIRMED`، `STATEMENT_APPROVED`)، و هر پیامی
  از Topic مبدأ `NEVER_AUTO_REPLAY_TOPICS` (`rasta.economic.v1` یا `.retry` آن) **هر نامی داشته باشد** — بی هیچ Override؛ و
  دلیل‌هایی که بازپخش عوضشان نمی‌کند: `PRODUCER_NOT_ALLOWED`، `SOURCE_UNCONFIRMED`، `BACKFILL_REQUIRED`.
- **کهنگی (ADR-051 § R6):** Dry-run Topic مبدأ را از پس از Offset اصلی می‌خواند؛ اگر رویداد تازه‌تری با همان کلید جریان هست
  `stale: true`، و اگر نمی‌تواند ببیند (مبدأ `.retry` — `ops-replay` آن را نمی‌خواند و Offset آن با Topic اصلی مقایسه‌پذیر
  نیست —، بی موقعیت، خواندن ناقص، یا **Retention از Offset اصلی گذشته**: Low Watermark پارتیشن بعد از `Offset اصلی + ۱` است؛
  Streamها ۷ روز و DLQها ۳۰ روز نگه داشته می‌شوند، پس رویداد تازه‌تر ممکن است پاک شده باشد و «ندیدم» یعنی «نمی‌دانم»، نه «کهنه
  نیست») `UNKNOWN`. `--execute` چنین رکوردی را رد می‌کند مگر
  `--allow-stale <eventId>` آن را **نام ببرد**. Idempotency مصرف‌کننده (`processed_event`) فقط تکرار را بی‌اثر می‌کند، نه کهنه را.
- **همه یا هیچ:** اجرا فقط وقتی می‌نویسد که **همهٔ** رکوردهای انتخاب قابل‌بازپخش باشند و تعدادشان دقیقاً `--expect-count` باشد؛
  انتخابی که ردشده دارد تنگ‌تر می‌شود، نیمه‌بازپخش نمی‌شود. سپس یکی‌یکی (`acks=-1`، Producer Idempotent)، به ترتیب DLQ، و
  در نخستین شکست توقف.
- **بازپخش به همهٔ مشترکان می‌رسد:** `<topic>.retry` را هر مصرف‌کنندهٔ آن Topic می‌خواند (D-039، #145)، نه فقط آن که DLQ کرد؛
  برای بقیه تکراری است و `processed_event` آن را بی‌اثر می‌کند. رویداد حالت‌ساز بار خود را اعمال نمی‌کند و از مالک تازه می‌شود
  (بالا).
- **حداقل یک‌بار، عمداً (تصمیم مدیر پروژه، بازبینی دور ۱ #144):** ابزار دفتر «بازپخش‌شده» ندارد؛ اجرای دوبارهٔ همان انتخاب
  دوباره منتشر می‌کند. ایمنی از قرارداد مصرف‌کننده است: Handler شناسهٔ `envelope.eventId` را در همان تراکنش اثر در
  `processed_event` ثبت می‌کند (`EventConsumer`)، پس نسخهٔ دوم بی‌اثر است. **Ack مبهم** — `send` خطا داد یا فرایند میان ارسال و
  گزارش مرد، و معلوم نیست رکورد روی `.retry` نشست — را این‌طور بازیاب: گزارش (`--report`) را ببین؛ رکوردهای بی `replayOffset`
  را با همان انتخاب دوباره اجرا کن (Dry-run، سپس `--execute`). اجرای دوباره **به همین دلیل** امن است، نه چون ابزار تکرار را
  می‌شناسد. تشخیص «قبلاً بازپخش شده» جای Topic ممیزی `rasta.ops.replay.v1` است (پایین).
- **ممیزی:** هر رکورد بازپخش‌شده `x-replay-id` دارد و گزارش نگه داشته می‌شود. رکورد ممیزی پلتفرم برای هر بازپخش (Topic
  `rasta.ops.replay.v1`، ناشر فقط `ops-replay`، مصرف‌کننده audit-service: یک `REPLAY_EXECUTED` برای هر رویداد، پس از نشستن
  روی `.retry`، با شناسهٔ اجرا/گزارش) کار بعدی است — و همان‌جا ابزار می‌تواند پیش از ارسال ببیند رویدادی قبلاً بازپخش شده است.

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
