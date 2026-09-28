# Runbook: چرخش اعتبارهای Kafka

**شدت:** ⚪ عملیاتی (🔴 اگر اعتباری نشت کرده باشد)
**سیگنال محرک:** ندارد — با تصمیم اپراتور: چرخش دوره‌ای، رفتن یک عضو تیم، یا گمانِ نشت یک گذرواژه یا Keystore.
**زمینه:** RUN-006 و ADR-061 § ۳ (اصلاحیهٔ 2026-09-28). Broker هر Principal را با SASL/SCRAM-SHA-512 روی TLS احراز
می‌کند و فقط همان را اجازه می‌دهد که `infrastructure/docker/kafka/broker-acls.json` برایش تولید کرده است.

---

## چه چیزی چرخانده می‌شود

| اعتبار                                                               | کجا نگه داشته می‌شود                                                                  | چه کسی از آن استفاده می‌کند                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `KAFKA_SASL_PASSWORD_<SERVICE>`                                      | `.env` (توسعه)، Secret استقرار؛ در CI برای هر اجرا تازه و Mask‌شده (`ci-up.sh`)       | همان سرویس، به نام `SERVICE_NAME` خودش                                   |
| `KAFKA_SASL_PASSWORD_ADMIN`                                          | همان‌جا                                                                               | فقط Bootstrap: `create-topics.sh`، `kafka-acl.mjs`، Listener درون‌Broker |
| `KAFKA_SASL_PASSWORD_OPS_REPLAY`                                     | همان‌جا                                                                               | اپراتور بازپخش ([replay-dlq](replay-dlq.md))                             |
| `KAFKA_SASL_PASSWORD_ITEST_OBSERVER`، `_KAFKA_UI`، `_KAFKA_EXPORTER` | فقط توسعه و CI — در هیچ مجموعهٔ ACL استقرار نیستند                                    | آزمون‌ها، Kafka UI، Prometheus Exporter                                  |
| CA یک‌بارمصرف و Keystore Broker                                      | Volume داکر `kafka-tls` (Compose)، `$RUNNER_TEMP` (CI)؛ فقط `ca.pem` بیرون کپی می‌شود | Broker؛ و هر کلاینت با `KAFKA_SSL_CA_FILE`                               |

نام متغیر از نام Principal می‌آید: پسوند `-service` حذف، `-` به `_`، و حروف بزرگ (`fleet-service` ←
`KAFKA_SASL_PASSWORD_FLEET`، `ops-replay` ← `KAFKA_SASL_PASSWORD_OPS_REPLAY`). **هرگز** مقدار واقعی Commit نمی‌شود؛
`.env.example` فقط مقادیر توسعه دارد.

**CI چیزی برای چرخاندن ندارد:** هر اجرا گذرواژه‌ها و CA خودش را می‌سازد و با پایان Job دور می‌ریزد.

---

## A. توسعه (Compose) — ساده‌ترین راه: بازسازی Broker

Broker توسعه Log Dir پایدار ندارد، و اعتبارها هنگام Format (نخستین شروع Container) از محیط افزوده می‌شوند. پس مقدار تازه
در `.env` با بازسازی Container اثر می‌کند:

```bash
# ۱. مقدار تازه را در .env بگذار (سرویس و Broker هر دو از همین فایل می‌خوانند)
#    KAFKA_SASL_PASSWORD_FLEET=<تازه>

# ۲. Broker را از نو بساز؛ Topicها را kafka-init دوباره می‌سازد
docker compose up -d --force-recreate kafka kafka-init

# ۳. ACLها را دوباره اعمال کن (Broker تازه هیچ ACLی ندارد)
pnpm kafka:acl:apply

# ۴. سرویس را دوباره راه بینداز تا مقدار تازه را بخواند
```

داده‌های Kafka توسعه با این کار از دست می‌روند و این عمدی است (Outbox مانع از دست رفتن رویداد می‌شود، ADR-021).

## B. بی بازسازی — چرخش درجا (الگوی هر Broker پایدار)

SCRAM برای هر کاربر **یک** اعتبار نگه می‌دارد؛ جایگزینی آن اتصال‌های باز را قطع نمی‌کند، اما هر اتصال تازه با گذرواژهٔ
قدیم رد می‌شود. پس ترتیب مهم است و پنجرهٔ میان دو گام را کوتاه نگه دار:

```bash
# ۱. اعتبار تازه را روی Broker بنشان (به‌عنوان admin)
docker compose exec kafka /opt/kafka/bin/kafka-configs.sh \
  --bootstrap-server kafka:9094 --command-config /tmp/admin.properties \
  --alter --entity-type users --entity-name fleet-service \
  --add-config 'SCRAM-SHA-512=[password=<تازه>]'

# ۲. بلافاصله سرویس را با مقدار تازه دوباره راه بینداز
#    (kafkajs تا آن لحظه روی اتصال‌های باز کار می‌کند و اتصال تازه را Retry می‌کند)

# ۳. تأیید: اعتبار هست، و Broker هنوز همان ACLها را دارد
docker compose exec kafka /opt/kafka/bin/kafka-configs.sh \
  --bootstrap-server kafka:9094 --command-config /tmp/admin.properties \
  --describe --entity-type users --entity-name fleet-service
pnpm kafka:acl:apply        # باید «0 added, 0 removed» بگوید
```

این مسیر روی Broker توسعه آزموده شده است: پس از گام ۱ گذرواژهٔ قدیم با `KafkaJSSASLAuthenticationError` رد و گذرواژهٔ
تازه پذیرفته شد. اگر Container Broker بعداً بازسازی شود، اعتبار دوباره از `.env` Format می‌شود — پس `.env` را هم
به‌روز کن.

**`admin` را درجا نچرخان.** Listener بین‌Broker با همان گذرواژه‌ای احراز می‌کند که هنگام شروع Broker در JAAS نشسته است؛
تغییر درجای آن می‌تواند اتصال بعدی خود Broker را بشکند (این حالت آزموده نشده است). برای `admin` راه A را برو.

## C. CA و Keystore Broker

`tls.sh` گواهی موجود را تا یک روز پیش از انقضا (اعتبار ۸۲۵ روز) نگه می‌دارد و پس از آن خودکار تازه می‌سازد. برای
ساختن تازه در هر زمان (مثلاً گمان نشت Keystore):

```bash
docker compose --profile all down        # هر Containerی که Volume را سوار کرده (Kafka UI و Exporter هم)
docker volume rm rasta_kafka-tls
pnpm infra:up                            # CA تازه، ca.pem تازه در infrastructure/docker/kafka/.tls/، و ACLها
# سرویس‌ها را دوباره راه بینداز تا CA تازه را بخوانند
```

کلید خصوصی CA بلافاصله پس از امضای گواهی Broker پاک می‌شود، پس هیچ گواهی دیگری با آن CA ساخته نمی‌شود.

---

## اگر اعتبار نشت کرده است

۱. همان اعتبار را فوراً با راه B (یا A در توسعه) بچرخان — پیش از هر بررسی دیگری.
۲. اگر مقدار واقعی Commit شده، پاک کردن از تاریخچه کافی نیست: آن را افشاشده بدان و بچرخان.
۳. بررسی کن Principal نشت‌کرده چه اجازه‌ای داشت: `broker-acls.json` دقیقاً همین را می‌گوید. نوشتن فقط روی Topicهای
خودش ممکن بود؛ رویدادی که در آن بازه با نام آن سرویس منتشر شده، مشکوک است.

## تأیید

- `pnpm kafka:acl:apply` ← «0 added, 0 removed».
- `pnpm test:kafka-acl-broker` روی Brokerی که چیز دیگری از آن نمی‌خواند (رکورد نشانه روی Topicهای واقعی می‌نویسد).
- سرویس چرخانده‌شده منتشر می‌کند: `rasta_outbox_pending_age_seconds` بالا نمی‌رود ([outbox-stuck](outbox-stuck.md)).
