# Runbook: چرخش اعتبارهای Kafka

**شدت:** ⚪ عملیاتی (🔴 اگر اعتباری نشت کرده باشد)
**سیگنال محرک:** ندارد — با تصمیم اپراتور: چرخش دوره‌ای، رفتن یک عضو تیم، یا گمانِ نشت یک گذرواژه یا Keystore.
**زمینه:** RUN-006 و ADR-061 § ۳ (اصلاحیهٔ 2026-09-28). Broker هر Principal را با SASL/SCRAM-SHA-512 روی TLS احراز
می‌کند و فقط همان را اجازه می‌دهد که `infrastructure/docker/kafka/broker-acls.<profile>.json` برایش تولید کرده است
(`development` در Compose و CI؛ `deployment` بدون Principalهای توسعه و آزمون).

**هیچ چرخشی Broker را بازسازی نمی‌کند و هیچ چرخشی داده از دست نمی‌دهد.** Log، اعتبارهای SCRAM و Offset همهٔ گروه‌ها در
Volume `kafka-data` می‌مانند و با بازسازی Container از بین نمی‌روند؛ گذرواژه درجا عوض می‌شود. پاک کردن داده (بخش D)
هرگز راه چرخش نیست.

---

## چه چیزی چرخانده می‌شود

| اعتبار                                            | کجا نگه داشته می‌شود                                                                                                                                  | چه کسی از آن استفاده می‌کند                                              |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `KAFKA_SASL_PASSWORD_<SERVICE>`                   | `.env` (فقط توسعه — باقی‌ماندهٔ پذیرفته، مانند `DATABASE_URL_<SERVICE>`)؛ در استقرار فقط Secret همان سرویس                                            | همان سرویس، به نام `SERVICE_NAME` خودش                                   |
| `KAFKA_SASL_PASSWORD_ADMIN`                       | `infrastructure/docker/kafka/bootstrap.env` (Git-Ignored؛ پیش‌فرض‌ها در `bootstrap.env.example`) — Compose آن را فقط به `kafka` و `kafka-init` می‌دهد | فقط Bootstrap: `create-topics.sh`، `kafka-acl.mjs`، Listener درون‌Broker |
| `KAFKA_SASL_PASSWORD_OPS_REPLAY`                  | همان فایل Bootstrap                                                                                                                                   | اپراتور بازپخش ([replay-dlq](replay-dlq.md))                             |
| `KAFKA_SASL_PASSWORD_ITEST_OBSERVER`              | همان فایل Bootstrap — فقط پروفایل `development`؛ فقط READ                                                                                             | آزمون‌ها (Integration و E2E)                                             |
| `KAFKA_SASL_PASSWORD_KAFKA_UI`، `_KAFKA_EXPORTER` | مقدار توسعهٔ ثابت در `docker-compose.yml` — فقط پروفایل `development`                                                                                 | Kafka UI، Prometheus Exporter                                            |
| CA یک‌بارمصرف و Keystore Broker                   | Volume داکر `kafka-tls` (Compose)، `$RUNNER_TEMP` (CI)؛ فقط `ca.pem` بیرون کپی می‌شود (`infrastructure/docker/kafka/.tls/`)                           | Broker؛ و هر کلاینت با `KAFKA_SSL_CA_FILE`                               |

نام متغیر از نام Principal می‌آید: پسوند `-service` حذف، `-` به `_`، و حروف بزرگ (`fleet-service` ←
`KAFKA_SASL_PASSWORD_FLEET`، `ops-replay` ← `KAFKA_SASL_PASSWORD_OPS_REPLAY`). **هرگز** مقدار واقعی Commit نمی‌شود؛
`.env.example` و `bootstrap.env.example` فقط مقادیر توسعه دارند. اعتبار admin، ops-replay و observer هرگز در محیط یک
پروسهٔ سرویس نیست؛ `pnpm infra:up` اگر `.env` هر اعتبار Kafkaی جز گذرواژهٔ خود سرویس‌ها داشته باشد (admin، ops-replay،
observer، Kafka UI، Exporter) اجرا نمی‌شود و `pnpm check:kafka-credential-scope`
همین را نگه می‌دارد.

**CI چیزی برای چرخاندن ندارد:** هر اجرا گذرواژه‌ها و CA خودش را می‌سازد و با پایان Job دور می‌ریزد.

**استقرار:** همین دستورهای `kafka-configs.sh` روی Broker استقرار، با اعتبار admin از Secret Store همان محیط — نه از هیچ
فایل این Repository. اعمال ACL در استقرار همیشه صریح است و هرگز `bootstrap.env.example` را نمی‌خواند:

```bash
node scripts/kafka-acl.mjs apply --profile deployment   # KAFKA_BROKERS، KAFKA_SASL_PASSWORD_ADMIN و CA از Secret Store
```

در توسعه دستور `pnpm kafka:acl:apply:dev` است (پروفایل `development`، فایل‌های Bootstrap توسعه). دستوری بی پروفایل وجود
ندارد.

دستورهای `kafka-*.sh` زیر درون Container Broker اجرا می‌شوند؛ `/tmp/admin.properties` را `broker-entrypoint.sh` همان‌جا
از گذرواژهٔ admin هنگام شروع Container می‌نویسد و از آن بیرون نمی‌رود.

---

## A. گذرواژهٔ یک Principal — درجا، با شرط سکون همان Principal

SCRAM برای هر کاربر و هر Mechanism **فقط یک** اعتبار نگه می‌دارد. از لحظهٔ `--alter` تا لحظه‌ای که سرویس با مقدار
تازه بالا بیاید، هر اتصال تازه با گذرواژهٔ قدیم رد می‌شود؛ اگر سرویس در این فاصله روشن بماند، Reconnect، Rebalance
گروه مصرف‌کننده یا Restart یک Instance همان لحظه با خطای احراز می‌شکند. پس این مسیر **شرط دارد:**

> **شرط سکون:** پیش از گام ۲، همهٔ Instanceهای Principal چرخانده‌شده متوقف شده‌اند (برای `ops-replay` هیچ بازپخشی در
> جریان نیست؛ برای Kafka UI و Exporter همان Container). Principalهای دیگر بی‌تغییر کار می‌کنند.

در این مدت هیچ رویدادی از دست نمی‌رود، فقط به تعویق می‌افتد: رویدادهای خروجی سرویس در Outbox خودش می‌مانند (ADR-021)
و Offset گروه‌های مصرف‌کنندهٔ آن در Broker Commit‌شده‌اند، پس پس از شروع دوباره از همان‌جا ادامه می‌دهد. قطعی برابر است
با Restart خود سرویس — همان که هر استقرار به‌هرحال دارد.

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

# ۳. مقدار تازه را در جای خودش بگذار — .env در توسعه (KAFKA_SASL_PASSWORD_FLEET=<تازه>)، Secret همان سرویس در
#    استقرار؛ برای ops-replay و itest-observer فایل infrastructure/docker/kafka/bootstrap.env — و سرویس را راه بینداز

# ۴. تأیید: اعتبار هست، و Broker هنوز همان ACLها را دارد
docker compose exec kafka /opt/kafka/bin/kafka-configs.sh \
  --bootstrap-server kafka:9094 --command-config /tmp/admin.properties \
  --describe --entity-type users --entity-name fleet-service
pnpm kafka:acl:apply:dev    # باید «0 added, 0 removed» بگوید
```

گام ۳ را جا نینداز: Broker اعتبار را از محیط فقط هنگام Format یک Volume خالی می‌خواند، و `kafka-init` فقط به Principalی
اعتبار می‌دهد که **هیچ** اعتباری ندارد (Principal تازه‌ای که پس از Format به قراردادها افزوده شده) — اعتبار موجود را
هرگز بازنویسی نمی‌کند. پس `.env` یا `bootstrap.env`ِ کهنه تا Format بعدی بی‌اثر است، اما همان Format را خراب می‌کند.

این مسیر روی Broker توسعه آزموده شده است: پس از گام ۲ گذرواژهٔ قدیم با `KafkaJSSASLAuthenticationError` رد و گذرواژهٔ
تازه پذیرفته شد.

**چرا چرخش دو-اعتباری (Shadow Principal) نه؟** SCRAM دو گذرواژهٔ هم‌زمان برای یک کاربر ندارد؛ چرخش بی‌قطع یعنی یک
Principal دوم (مثلاً `fleet-service-next`) با نسخه‌ای کامل از ACLهای اولی، و شل کردن قاعدهٔ «هر سرویس دقیقاً به نام
`SERVICE_NAME` خودش وصل می‌شود» (`kafkaConnectionFor`، RUN-006 PR A) که گروه‌های مصرف‌کننده و ACLها بر آن بنا شده‌اند.
هزینهٔ آن — دو برابر شدن ACLها و هویتی که دیگر نام سرویس نیست — بیش از سودش است تا وقتی قطعی برابر یک Restart سرویس
است و هنوز هیچ استقرار چند-Instance با الزام Zero-Downtime وجود ندارد. با پیدا شدن چنین الزامی، این تصمیم باز
می‌شود.

## B. گذرواژهٔ `admin` — درجا، سپس بازسازی Container با داده

`admin` همان کاربری است که Listener بین‌Broker با آن احراز می‌کند؛ گذرواژه‌اش هنگام شروع Container در JAAS و
`/tmp/admin.properties` می‌نشیند. پس پس از `--alter` خود Container هم باید با مقدار تازه از نو ساخته شود — داده در
`kafka-data` می‌ماند.

> **شرط سکون:** هیچ Bootstrapی در جریان نیست (`kafka-init`، `pnpm infra:up`، `pnpm kafka:acl:apply:dev`). سرویس‌ها با
> اعتبار خودشان وصل‌اند و فقط چند ثانیهٔ شروع دوبارهٔ Broker را Retry می‌کنند.

```bash
# ۱. گذرواژهٔ تازه را روی Broker بنشان (با گذرواژهٔ فعلی admin)
docker compose exec kafka /opt/kafka/bin/kafka-configs.sh \
  --bootstrap-server kafka:9094 --command-config /tmp/admin.properties \
  --alter --entity-type users --entity-name admin \
  --add-config 'SCRAM-SHA-512=[password=<تازه>]'

# ۲. مقدار تازه را در infrastructure/docker/kafka/bootstrap.env بگذار (اگر نیست، از bootstrap.env.example کپی کن)
#    KAFKA_SASL_PASSWORD_ADMIN=<تازه>

# ۳. فقط Container Broker را از نو بساز — Volume داده دست نمی‌خورد
docker compose up -d --force-recreate --no-deps kafka

# ۴. تأیید: با گذرواژهٔ تازه، ACLها همان‌اند
pnpm kafka:acl:apply:dev    # «0 added, 0 removed»
```

این مسیر روی Broker توسعه آزموده شده است: Broker میان گام ۱ و ۳ بالا ماند، پس از گام ۳ سالم (`healthy`) شد، گذرواژهٔ
قدیم admin با `KafkaJSSASLAuthenticationError` رد شد، ACLها بی‌تغییر ماندند و Offset Commitشدهٔ یک گروه حفظ شد.

## C. CA و Keystore Broker — با داده

`tls.sh` گواهی موجود را تا یک روز پیش از انقضا (اعتبار ۸۲۵ روز) نگه می‌دارد و پس از آن خودکار تازه می‌سازد. Kafka UI و
Exporter فقط `ca.pem` بیرون‌کپی‌شده را سوار می‌کنند، نه Volume کلید Broker. برای ساختن تازه در هر زمان (مثلاً گمان
نشت Keystore) فقط Volume `kafka-tls` پاک می‌شود، نه `kafka-data`:

```bash
# Containerهایی که Volume کلید را سوار کرده‌اند (توقف و حذف Container، نه Volume داده)
docker compose rm -sf kafka-ui kafka-exporter kafka kafka-init kafka-tls
docker volume rm rasta_kafka-tls
docker compose up -d kafka-tls kafka kafka-init   # CA تازه، ca.pem تازه در infrastructure/docker/kafka/.tls/
pnpm kafka:acl:apply:dev                          # «0 added, 0 removed»
# سرویس‌ها، و Kafka UI / Exporter با Profile خودشان، را دوباره راه بینداز تا CA تازه را بخوانند
```

آزموده روی Broker توسعه: CA عوض شد، Broker دوباره Format نشد، Offset Commitشده و ACLها ماندند.

کلید خصوصی CA بلافاصله پس از امضای گواهی Broker پاک می‌شود، پس هیچ گواهی دیگری با آن CA ساخته نمی‌شود.

## D. پاک کردن داده‌های Broker — راه چرخش نیست

پاک کردن `kafka-data` (یا `pnpm infra:reset`، که **همهٔ** Volumeها را پاک می‌کند) هر رکوردی را که Broker پذیرفته اما
هنوز مصرف نشده، محتوای `.retry` و `.dlq`، و Offset همهٔ گروه‌ها را از بین می‌برد. Outbox این را جبران **نمی‌کند**: ردیف
Outbox پس از Ack Broker «منتشرشده» علامت می‌خورد. و چون Consumer و Relay هر سرویس در یک پروسه‌اند، سرویسی که هنوز روشن
است پس از هر تصویر «Lag صفر» می‌تواند رویداد مشتقِ تازه‌ای منتشر کند — پس تصویر فقط پس از توقف اعتبار دارد.

فقط اگر پاک کردن ناگزیر است (Volume خراب، نه چرخش)، و فقط به این ترتیب:

```bash
# ۱. همهٔ سرویس‌ها را متوقف کن — نه فقط تولیدکننده‌ها. از این‌جا هیچ پروسه‌ای منتشر یا مصرف نمی‌کند.

# ۲. پس از توقف: برای هر گروه، Offset Commitشده برابر Log-End است (در هر سطر CURRENT-OFFSET = LOG-END-OFFSET و LAG 0؛
#    سطری با CURRENT-OFFSET «-» روی Partitionی که رکورد دارد یعنی چیزی مصرف نشده)
docker compose exec kafka /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server kafka:9094 --command-config /tmp/admin.properties \
  --describe --all-groups

# ۳. پس از توقف: در **هر** جدول Outbox هر سرویس، در پایگاه داده و Schema همان سرویس، هیچ ردیف منتشرنشده‌ای نیست.
#    فهرست از Schemaهای Prisma خوانده می‌شود — `outbox_message` هر سرویس و جدول‌های دیگر مانند `security_event_outbox`
#    در identity-service — و هر سطرش پرسشی است که باید 0 بدهد:
node scripts/kafka-outbox-tables.mjs
#    identity-service	SELECT count(*) FROM security_event_outbox WHERE published_at IS NULL;   ← و بقیه
#    ردیف‌های security_event_outbox تا پایان پنجرهٔ تجمیع خود (window_ends_at) منتشر نمی‌شوند: اگر ردیفی ماند، سرویس را
#    پس از آن زمان دوباره راه بینداز تا منتشر کند.

# ۴. Topicهای dead-letter و retry — هیچ گروهی امروز .retry را نمی‌خواند (D-039)، پس گام ۲ آن را نشان نمی‌دهد:
#    هر رکورد یا طبق replay-dlq رسیدگی شده، یا بیرون برده و آگاهانه کنار گذاشته شده
docker compose exec kafka /opt/kafka/bin/kafka-get-offsets.sh \
  --bootstrap-server kafka:9094 --command-config /tmp/admin.properties \
  --topic '.*\.(dlq|retry)$'
docker compose exec kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server kafka:9094 --consumer.config /tmp/admin.properties \
  --topic rasta.fleet.v1.dlq --from-beginning --timeout-ms 10000 \
  --property print.headers=true > fleet-dlq-export.jsonl    # برای هر .dlq یا .retry غیرخالی
```

اگر گام ۲ یا ۳ برقرار نیست: سرویس‌ها را دوباره راه بینداز، بگذار تخلیه کنند، دوباره متوقف کن و **از گام ۲ از نو**
بسنج. فقط وقتی هر سه پس از توقف برقرارند:

```bash
docker compose rm -sf kafka kafka-init
docker volume rm rasta_kafka-data
docker compose up -d kafka kafka-init    # Format تازه با اعتبارهای .env و bootstrap.env؛ Topicها دوباره
pnpm kafka:acl:apply:dev
```

---

## اگر اعتبار نشت کرده است

۱. همان اعتبار را فوراً بچرخان — سرویس‌ها و ابزارها با راه A، `admin` با راه B — پیش از هر بررسی دیگری. شرط سکون این‌جا
هم لازم است و قطعی همان Principal پذیرفته است. داده پاک نمی‌شود.
۲. اگر مقدار واقعی Commit شده، پاک کردن از تاریخچه کافی نیست: آن را افشاشده بدان و بچرخان.
۳. بررسی کن Principal نشت‌کرده چه اجازه‌ای داشت: `broker-acls.<profile>.json` دقیقاً همین را می‌گوید. نوشتن فقط روی
Topicهای خودش ممکن بود؛ رویدادی که در آن بازه با نام آن سرویس منتشر شده، مشکوک است.

## تأیید

- توسعه: `pnpm kafka:acl:apply:dev` ← «0 added, 0 removed». استقرار: `node scripts/kafka-acl.mjs apply --profile
deployment` با محیط Secret Store.
- `pnpm test:kafka-acl-broker` روی Brokerی که چیز دیگری از آن نمی‌خواند (رکورد نشانه روی Topicهای واقعی می‌نویسد).
- سرویس چرخانده‌شده منتشر می‌کند: `rasta_outbox_pending_age_seconds` بالا نمی‌رود ([outbox-stuck](outbox-stuck.md))،
  و Lag گروه‌هایش پس از شروع دوباره به صفر برمی‌گردد.
