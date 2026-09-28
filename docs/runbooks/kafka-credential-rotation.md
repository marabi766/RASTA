# Runbook: چرخش اعتبارهای Kafka

**شدت:** ⚪ عملیاتی (🔴 اگر اعتباری نشت کرده باشد)
**سیگنال محرک:** ندارد — با تصمیم اپراتور: چرخش دوره‌ای، رفتن یک عضو تیم، یا گمانِ نشت یک گذرواژه یا Keystore.
**زمینه:** RUN-006 و ADR-061 § ۳ (اصلاحیهٔ 2026-09-28). Broker هر Principal را با SASL/SCRAM-SHA-512 روی TLS احراز
می‌کند و فقط همان را اجازه می‌دهد که `infrastructure/docker/kafka/broker-acls.<profile>.json` برایش تولید کرده است
(`development` در Compose و CI؛ `deployment` بدون Principalهای توسعه و آزمون).

---

## چه چیزی چرخانده می‌شود

| اعتبار                                                         | کجا نگه داشته می‌شود                                                                                                                         | چه کسی از آن استفاده می‌کند                                              |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `KAFKA_SASL_PASSWORD_<SERVICE>`                                | `.env` (فقط توسعه — باقی‌ماندهٔ پذیرفته، مانند `DATABASE_URL_<SERVICE>`)؛ در استقرار فقط Secret همان سرویس                                   | همان سرویس، به نام `SERVICE_NAME` خودش                                   |
| `KAFKA_SASL_PASSWORD_ADMIN`                                    | `infrastructure/docker/kafka/bootstrap.env` (Git-Ignored؛ پیش‌فرض‌ها در `bootstrap.env.example`) — Compose آن را فقط به `kafka` و `kafka-init` می‌دهد | فقط Bootstrap: `create-topics.sh`، `kafka-acl.mjs`، Listener درون‌Broker |
| `KAFKA_SASL_PASSWORD_OPS_REPLAY`                               | همان فایل Bootstrap                                                                                                                          | اپراتور بازپخش ([replay-dlq](replay-dlq.md))                             |
| `KAFKA_SASL_PASSWORD_ITEST_OBSERVER`                           | همان فایل Bootstrap — فقط پروفایل `development`؛ فقط READ                                                                                   | آزمون‌ها (Integration و E2E)                                            |
| `KAFKA_SASL_PASSWORD_KAFKA_UI`، `_KAFKA_EXPORTER`              | مقدار توسعهٔ ثابت در `docker-compose.yml` — فقط پروفایل `development`                                                                        | Kafka UI، Prometheus Exporter                                            |
| CA یک‌بارمصرف و Keystore Broker                                | Volume داکر `kafka-tls` (Compose)، `$RUNNER_TEMP` (CI)؛ فقط `ca.pem` بیرون کپی می‌شود (`infrastructure/docker/kafka/.tls/`)                  | Broker؛ و هر کلاینت با `KAFKA_SSL_CA_FILE`                               |

نام متغیر از نام Principal می‌آید: پسوند `-service` حذف، `-` به `_`، و حروف بزرگ (`fleet-service` ←
`KAFKA_SASL_PASSWORD_FLEET`، `ops-replay` ← `KAFKA_SASL_PASSWORD_OPS_REPLAY`). **هرگز** مقدار واقعی Commit نمی‌شود؛
`.env.example` و `bootstrap.env.example` فقط مقادیر توسعه دارند. اعتبار admin، ops-replay و observer هرگز در محیط یک
پروسهٔ سرویس نیست (`pnpm check:kafka-credential-scope` این را نگه می‌دارد).

**CI چیزی برای چرخاندن ندارد:** هر اجرا گذرواژه‌ها و CA خودش را می‌سازد، هر Step فقط Scope خودش را از
`kafka-credentials.sh` می‌گیرد، و همه با پایان Job دور ریخته می‌شوند.

دستورهای `kafka-*.sh` زیر درون Container Broker اجرا می‌شوند؛ `/tmp/admin.properties` را `broker-entrypoint.sh`
همان‌جا می‌نویسد و از آن بیرون نمی‌رود.

---

## A. چرخش درجا (راه پیش‌فرض) — با شرط سکون همان Principal

SCRAM برای هر کاربر و هر Mechanism **فقط یک** اعتبار نگه می‌دارد. از لحظهٔ `--alter` تا لحظه‌ای که سرویس با مقدار
تازه بالا بیاید، هر اتصال تازه با گذرواژهٔ قدیم رد می‌شود؛ اگر سرویس در این فاصله روشن بماند، Reconnect، Rebalance
گروه مصرف‌کننده یا Restart یک Instance همان لحظه با خطای احراز می‌شکند. پس این مسیر **شرط دارد:**

> **شرط سکون:** پیش از گام ۲، همهٔ Instanceهای Principal چرخانده‌شده متوقف شده‌اند (برای `ops-replay` هیچ بازپخشی در
> جریان نیست؛ برای Kafka UI و Exporter همان Container). Principalهای دیگر بی‌تغییر کار می‌کنند.

در این مدت هیچ رویدادی از دست نمی‌رود، فقط به تعویق می‌افتد: رویدادهای خروجی سرویس در Outbox خودش می‌مانند (ADR-021)
و Offset گروه‌های مصرف‌کنندهٔ آن Commit‌شده‌اند، پس پس از شروع دوباره از همان‌جا ادامه می‌دهد. قطعی برابر است با
Restart خود سرویس — همان که هر استقرار به‌هرحال دارد.

```bash
# ۱. سرویس را (همهٔ Instanceها) متوقف کن و مطمئن شو هیچ عضوی از گروه‌هایش نمانده است
docker compose exec kafka /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server kafka:9094 --command-config /tmp/admin.properties \
  --describe --members --all-groups | grep fleet-service    # نباید عضو فعالی بماند

# ۲. اعتبار تازه را روی Broker بنشان (به‌عنوان admin)
docker compose exec kafka /opt/kafka/bin/kafka-configs.sh \
  --bootstrap-server kafka:9094 --command-config /tmp/admin.properties \
  --alter --entity-type users --entity-name fleet-service \
  --add-config 'SCRAM-SHA-512=[password=<تازه>]'

# ۳. مقدار تازه را در جای خودش بگذار: .env در توسعه (KAFKA_SASL_PASSWORD_FLEET=<تازه>)،
#    Secret همان سرویس در استقرار — و سرویس را راه بینداز

# ۴. تأیید: اعتبار هست، و Broker هنوز همان ACLها را دارد
docker compose exec kafka /opt/kafka/bin/kafka-configs.sh \
  --bootstrap-server kafka:9094 --command-config /tmp/admin.properties \
  --describe --entity-type users --entity-name fleet-service
pnpm kafka:acl:apply        # باید «0 added, 0 removed» بگوید
```

برای `ops-replay` و `itest-observer` مقدار تازه به `infrastructure/docker/kafka/bootstrap.env` می‌رود، نه `.env`. اگر
Container Broker بعداً بازسازی شود، اعتبار دوباره از همین فایل‌ها Format می‌شود — پس گام ۳ را جا نینداز.

این مسیر روی Broker توسعه آزموده شده است: پس از گام ۲ گذرواژهٔ قدیم با `KafkaJSSASLAuthenticationError` رد و گذرواژهٔ
تازه پذیرفته شد.

**چرا چرخش دو-اعتباری (Shadow Principal) نه؟** SCRAM دو گذرواژهٔ هم‌زمان برای یک کاربر ندارد؛ چرخش بی‌قطع یعنی یک
Principal دوم (مثلاً `fleet-service-next`) با نسخه‌ای کامل از ACLهای اولی، و شل کردن قاعدهٔ «هر سرویس دقیقاً به نام
`SERVICE_NAME` خودش وصل می‌شود» (`kafkaConnectionFor`، RUN-006 PR A) که گروه‌های مصرف‌کننده و ACLها بر آن بنا شده‌اند.
هزینهٔ آن — دو برابر شدن ACLها و هویتی که دیگر نام سرویس نیست — بیش از سودش است تا وقتی قطعی برابر یک Restart سرویس
است و هنوز هیچ استقرار چند-Instance با الزام Zero-Downtime وجود ندارد. با پیدا شدن چنین الزامی، این تصمیم باز
می‌شود.

**`admin` را درجا نچرخان.** Listener بین‌Broker با همان گذرواژه‌ای احراز می‌کند که هنگام شروع Broker در JAAS نشسته است؛
تغییر درجای آن می‌تواند اتصال بعدی خود Broker را بشکند (این حالت آزموده نشده است). برای `admin` راه B را برو.

## B. بازسازی Broker — فقط پس از تخلیهٔ کامل

Broker توسعه Log Dir پایدار ندارد و اعتبارها هنگام Format (نخستین شروع Container) از محیط افزوده می‌شوند؛ پس بازسازی
مقدار تازه را می‌نشاند — و **همهٔ داده‌های Kafka را پاک می‌کند:** رکوردهایی که منتشر شده اما هنوز مصرف نشده‌اند،
محتوای Topicهای `.retry` و `.dlq`، و Offset همهٔ گروه‌ها. Outbox این را جبران **نمی‌کند**: ردیف Outbox پس از Ack
Broker «منتشرشده» علامت می‌خورد، پس رویدادی که به Broker رسیده اما مصرف نشده، با بازسازی برای همیشه از دست می‌رود.

پس بازسازی فقط وقتی مجاز است که هر سه شرط زیر برقرار و ثبت شده باشد:

```bash
# ۱. تولیدکننده‌ها را متوقف کن (هیچ رویداد تازه‌ای منتشر نشود)، مصرف‌کننده‌ها را روشن نگه دار تا تخلیه کنند

# ۲. Lag همهٔ گروه‌ها صفر است (ستون LAG در همهٔ سطرها 0)
docker compose exec kafka /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server kafka:9094 --command-config /tmp/admin.properties \
  --describe --all-groups

# ۳. Topicهای dead-letter و retry بررسی شده‌اند — هیچ گروهی امروز .retry را نمی‌خواند (D-039)، پس Lag آن را نشان
#    نمی‌دهد: هر رکورد یا طبق replay-dlq رسیدگی شده، یا بیرون برده و آگاهانه کنار گذاشته شده
docker compose exec kafka /opt/kafka/bin/kafka-get-offsets.sh \
  --bootstrap-server kafka:9094 --command-config /tmp/admin.properties \
  --topic '.*\.(dlq|retry)$'
docker compose exec kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server kafka:9094 --consumer.config /tmp/admin.properties \
  --topic rasta.fleet.v1.dlq --from-beginning --timeout-ms 10000 \
  --property print.headers=true > fleet-dlq-export.jsonl    # برای هر .dlq یا .retry غیرخالی
```

سپس:

```bash
# ۴. مقدار تازه را بگذار: سرویس‌ها در .env، و admin / ops-replay / observer در
#    infrastructure/docker/kafka/bootstrap.env (اگر نیست، از bootstrap.env.example کپی کن)
# ۵. مصرف‌کننده‌ها را هم متوقف کن، Broker را از نو بساز؛ Topicها را kafka-init دوباره می‌سازد
docker compose up -d --force-recreate kafka kafka-init
# ۶. ACLها را دوباره اعمال کن (Broker تازه هیچ ACLی ندارد)
pnpm kafka:acl:apply
# ۷. سرویس‌ها را دوباره راه بینداز تا مقدار تازه را بخوانند
```

اگر یکی از شرط‌های ۲ یا ۳ برقرار نیست، بازسازی نکن: راه A را برای Principal مورد نظر برو، یا اول تخلیه را کامل کن.

## C. CA و Keystore Broker

`tls.sh` گواهی موجود را تا یک روز پیش از انقضا (اعتبار ۸۲۵ روز) نگه می‌دارد و پس از آن خودکار تازه می‌سازد. Kafka UI و
Exporter فقط `ca.pem` بیرون‌کپی‌شده را سوار می‌کنند، نه Volume کلید Broker. برای ساختن تازه در هر زمان (مثلاً گمان
نشت Keystore) — Broker با Keystore تازه بازسازی می‌شود، پس **شرط‌های راه B** این‌جا هم لازم‌اند:

```bash
docker compose --profile all down        # پس از تخلیه طبق B
docker volume rm rasta_kafka-tls
pnpm infra:up                            # CA تازه، ca.pem تازه در infrastructure/docker/kafka/.tls/، و ACLها
# سرویس‌ها را دوباره راه بینداز تا CA تازه را بخوانند
```

کلید خصوصی CA بلافاصله پس از امضای گواهی Broker پاک می‌شود، پس هیچ گواهی دیگری با آن CA ساخته نمی‌شود.

---

## اگر اعتبار نشت کرده است

۱. همان اعتبار را فوراً با راه A بچرخان — پیش از هر بررسی دیگری. شرط سکون این‌جا هم لازم است و قطعی آن سرویس پذیرفته
است؛ برای `admin` راه B، و اگر تخلیه ممکن نیست، از دست رفتن داده را آگاهانه و ثبت‌شده بپذیر.
۲. اگر مقدار واقعی Commit شده، پاک کردن از تاریخچه کافی نیست: آن را افشاشده بدان و بچرخان.
۳. بررسی کن Principal نشت‌کرده چه اجازه‌ای داشت: `broker-acls.<profile>.json` دقیقاً همین را می‌گوید. نوشتن فقط روی
Topicهای خودش ممکن بود؛ رویدادی که در آن بازه با نام آن سرویس منتشر شده، مشکوک است.

## تأیید

- `pnpm kafka:acl:apply` ← «0 added, 0 removed».
- `pnpm test:kafka-acl-broker` روی Brokerی که چیز دیگری از آن نمی‌خواند (رکورد نشانه روی Topicهای واقعی می‌نویسد).
- سرویس چرخانده‌شده منتشر می‌کند: `rasta_outbox_pending_age_seconds` بالا نمی‌رود ([outbox-stuck](outbox-stuck.md))،
  و Lag گروه‌هایش پس از شروع دوباره به صفر برمی‌گردد.
