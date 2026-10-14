# ۱۱ — Infrastructure Architecture

> اجزای زیرساختی، دلیل انتخاب، پیکربندی و مسیر MVP → Production.

---

## ۱۱٫۱ نمای اجزا

| جزء            | فناوری                       | نسخه     | نقش                                        |
| -------------- | ---------------------------- | -------- | ------------------------------------------ |
| پایگاه داده    | PostgreSQL + PostGIS         | 16 / 3.4 | ذخیره‌سازی تراکنشی + GIS                   |
| Cache / قفل    | Redis                        | 7.4      | Cache، قفل توزیع‌شده، Rate Limit، سبد خرید |
| Event Bus      | Apache Kafka (KRaft)         | 3.9      | ستون فقرات رویداد                          |
| Identity       | Keycloak                     | 26       | OIDC/OAuth2، MFA، Federation               |
| Workflow       | Temporal                     | 1.26     | گردش‌کار بلندمدت و Saga                    |
| Object Storage | S3-compatible (MinIO در dev) | —        | اسناد، تصاویر، فایل قرارداد                |
| Search         | OpenSearch                   | 2.18     | جست‌وجوی چندوجهی                           |
| Telemetry      | OpenTelemetry Collector      | 0.116    | جمع‌آوری Log/Metric/Trace                  |
| Metrics        | Prometheus                   | 3.1      | ذخیره و پرس‌وجوی متریک                     |
| Dashboards     | Grafana                      | 11.5     | نمایش                                      |
| Mail (dev)     | Mailpit                      | 1.22     | تست ایمیل محلی                             |

پیکربندی محلی: [`docker-compose.yml`](../docker-compose.yml)

---

## ۱۱٫۲ PostgreSQL + PostGIS

**چرا PostgreSQL.** دفتر کل به تراکنش ACID واقعی، `SELECT ... FOR UPDATE` و Trigger برای
تضمین تغییرناپذیری نیاز دارد. هیچ پایگاه داده NoSQL این سه را با هم نمی‌دهد.
PostGIS در همان موتور، نیاز GIS را بدون یک سیستم جداگانه پوشش می‌دهد.

**پیکربندی کلیدی (Production):**

```
max_connections            = 200        # هر سرویس Pool محدود دارد
shared_buffers             = 25% RAM
effective_cache_size       = 75% RAM
work_mem                   = 16MB
maintenance_work_mem       = 512MB
wal_level                  = replica    # برای Replication و PITR
max_wal_size               = 4GB
checkpoint_completion_target = 0.9
random_page_cost           = 1.1        # SSD
default_statistics_target  = 200
log_min_duration_statement = 500ms      # Query کند را ثبت کن
```

**Connection Pooling.** هر سرویس Pool خودش را دارد (Prisma).
Production: **PgBouncer** در حالت Transaction Pooling جلوی Cluster — ۱۷ سرویس × چند Replica
به‌سرعت `max_connections` را می‌بلعد.

**اندازهٔ Pool از پیکربندی.** دو متغیر برای همهٔ سرویس‌های دارای پایگاه داده (`databaseEnvSchema` در `@rasta/config`):

| متغیر                           | پارامتر Prisma     | بازه    | تنظیم‌نشده (پیش‌فرض)                    |
| ------------------------------- | ------------------ | ------- | --------------------------------------- |
| `DATABASE_POOL_SIZE`            | `connection_limit` | ۱..۱۰۰  | پیش‌فرض Prisma: `num_physical_cpus*2+1` |
| `DATABASE_POOL_TIMEOUT_SECONDS` | `pool_timeout`     | ۱..۶۰ ث | پیش‌فرض Prisma: ۱۰ ثانیه                |

`loadEnv` هر دو را در `DATABASE_URL` سرویس می‌نویسد، پس هر Clientی که سرویس روی آن URL باز می‌کند — Pool زمان اجرا،
بررسی Role در Startup، CLI — همان Pool را دارد. تنظیم‌نشده چیزی نوشته نمی‌شود و رفتار همان پیش از این متغیرهاست؛ این
تغییر خودش هیچ عددی را عوض نمی‌کند و اندازهٔ Production هنوز تصمیم استقرار است (`docs/14` § ۱۴٫۳). بدون آن، اندازهٔ Pool
تابع تعداد هستهٔ Nodeی است که Pod رویش افتاده، و مسیرهایی که به Pool محدود تکیه دارند — 409ِ نبودِ اتصال آزاد،
انتظار Lock در تراکنش — از Nodeی به Node دیگر فرق می‌کنند. زمان انتظار به **ثانیهٔ درست** است چون Prisma همین واحد را
می‌خواند؛ `0` (در Prisma یعنی انتظار بی‌پایان) رد می‌شود. **Fail-closed:** مقدار غیرعددی، اعشاری، خارج از بازه یا خالی، و
URLی که همان پارامتر را با مقدار دیگری دارد، سرویس را در Startup متوقف می‌کند — پیام خطا نام متغیر و پارامتر را دارد و هرگز
خود URL (که گذرواژهٔ Role را دارد) را (S-09). URLِ Migratorها (D-045) از این مسیر نمی‌گذرد: `scripts/prisma.mjs` آنها را
می‌خواند، نه `loadEnv`. هر Replica حداکثر `DATABASE_POOL_SIZE` اتصال باز می‌کند؛ مجموع همهٔ Replicaهای همهٔ سرویس‌ها
باید زیر `max_connections` (یا Pool سمت PgBouncer) بماند. `pnpm test:db-pool-config` (Job `integration` در CI) این را روی
PostgreSQL واقعی می‌سنجد: پیش‌فرض دست‌نخورده، سقف اتصال، `P2024` پس از انتظار، و اینکه هر سرویس Clientهایش را فقط روی
همین URL باز می‌کند.

**سقف زمان هر Statement (اختیاری).** `DATABASE_STATEMENT_TIMEOUT_MS` (همان `databaseEnvSchema`؛ ۱۰۰۰..۳۶۰۰۰۰۰
میلی‌ثانیه) **Opt-in** است (#268 r4): تنظیم‌نشده، برنامه هیچ `statement_timeout`ی اعمال نمی‌کند و نشست همان مقدار خود
پایگاه داده را دارد — رفتار پیش از این متغیر. تنظیم‌شده، `loadEnv` آن را به‌صورت `-c statement_timeout=<ms>` در `options`
همان `DATABASE_URL` می‌نویسد (پیش از گزینهٔ UTC؛ `withStatementTimeout`)، پس هر Statement زمان اجرا — از جمله انتظار
برای Lock ردیف، جدول یا Advisory Lock — پس از این مدت با `57014` لغو می‌شود. `0` (در PostgreSQL یعنی بی‌سقف) و مقدار
غیرعددی یا خارج از بازه رد می‌شوند. **Fail-closed:** مقدار تنظیم‌شده باید از **بزرگ‌ترین بودجهٔ عملیاتی** که آن سرویس
اعلام می‌کند بیشتر باشد (برابر هم رد می‌شود: دو Timeout با هم مسابقه می‌دهند)؛ وگرنه سرویس در Startup متوقف می‌شود و پیام،
هر بودجه‌ای را که قطع می‌شد با منشأش و کفِ لازم نام می‌برد. هر سرویس دارای پایگاه داده بودجه‌هایش را در
`src/config/operation-budgets.ts` اعلام می‌کند و به `loadEnv` می‌دهد (`operationBudgets`)؛ سرویسی که اعلام نکند هیچ
مقداری را نمی‌پذیرد. بودجه یعنی Timeout هر تراکنش (صریح، یا ۵ ثانیهٔ پیش‌فرض Prisma)، Claim کلید Idempotency (۵ ثانیه
انتظار Lock در تراکنشی ۲ ثانیه بلندتر)، بودجهٔ رقابت economic، Timeout باز کردن مناقصه، تراکنش‌های Keycloak در identity،
تمدید Lease و دستهٔ Purge صندوق خروجی — حتی آنهایی که خودشان `SET LOCAL statement_timeout` می‌گویند، چون دیگران پشت
Lockهایشان منتظر می‌مانند. ثابت‌ها همان‌جا تعریف می‌شوند و کد از همان‌جا می‌خواندشان، پس فهرست از کد عقب نمی‌ماند. کف
هر سرویس با پیش‌فرض‌ها (مقدار باید از آن بیشتر باشد؛ بودجه‌های پیکربندی‌شده کف را با خود جابه‌جا می‌کنند):

| سرویس                                         | بزرگ‌ترین بودجه (ms) | منشأ                                                               |
| --------------------------------------------- | -------------------- | ------------------------------------------------------------------ |
| economic                                      | ۱۲۰۰۰۰               | صفحهٔ ممیزی موجودی (`AUDIT_TX_TIMEOUT_MS`)؛ بودجهٔ رقابت ۶۰۰۰۰     |
| identity                                      | ۶۵۰۰۰                | Projection به Keycloak، ترمیم یتیم، تأیید ثبت‌نام                  |
| asset، maintenance                            | ۳۰۰۰۰                | تراکنش Refresh در Replay                                           |
| inventory                                     | ۳۰۰۰۰                | تراکنش فرمان: ۴ × `INVENTORY_LOCK_TIMEOUT_MS` + ۱۰ ثانیه           |
| construction                                  | ۳۰۰۰۰                | `CONSTRUCTION_TENDER_OPEN_TIMEOUT_MS`                              |
| notification، audit                           | ۳۰۰۰۰                | تراکنش Ingest (و در notification، Dispatch)                        |
| fleet                                         | ۱۴۲۰۰                | `FLEET_ASSET_SYNC_TRANSACTION_TIMEOUT_MS`                          |
| contract                                      | ۱۳۰۰۰                | تراکنش امضا: `CONTRACT_ORGANIZATION_REQUEST_TIMEOUT_MS` + ۱۰ ثانیه |
| marketplace، document، organization، supplier | ۱۲۵۰۰                | تمدید Lease صندوق خروجی (`OUTBOX_CLAIM_LEASE_SECONDS`)             |

URLی که خودش در `options` یک `statement_timeout` دارد رد می‌شود: با متغیر تنظیم‌نشده چون از بررسی بودجه فرار می‌کرد، با
مقدار دیگر چون یک عدد در دو جاست. در identity، تراکنش‌های Projection، ترمیم حساب یتیم و تأیید ثبت‌نام همچنان `SET LOCAL
statement_timeout` برابر Timeout خودشان (۶۵ ثانیه) می‌گویند: پشت PgBouncer سقف نشست از Role می‌آید و `loadEnv` آن را
نمی‌بیند. Migratorها (D-045) آن را نمی‌خوانند؛ Migrationها سقف خودشان را دارند (D-048). `pnpm test:db-pool-config` اثرش
را روی PostgreSQL واقعی می‌سنجد (تنظیم‌نشده: همان مقدار خود پایگاه داده).

**پشت PgBouncer** همان حکم `TimeZone` در بند بعد برقرار است: `options` دور انداخته می‌شود (`ignore_startup_parameters`)،
پس آنجا `DATABASE_STATEMENT_TIMEOUT_MS` را تنظیم‌نشده بگذارید و سقف را **سمت پایگاه داده** روی Role زمان اجرا بگذارید —
نه برای Migrator: `ALTER ROLE rasta_<svc> IN DATABASE rasta_<svc> SET statement_timeout = '<ms>ms'`. Provisioning این را
گامی اختیاری دارد: `POSTGRES_STATEMENT_TIMEOUT_MS_<SVC>` (مثلاً `POSTGRES_STATEMENT_TIMEOUT_MS_FLEET`؛ همان بازه) که
Bootstrap، `pnpm db:privilege-split <svc>` و `pnpm db:rotate-role-passwords` اعمال می‌کنند
(`infrastructure/docker/postgres/lib/session-statement-timeout.bash`، `pnpm test:session-statement-timeout`)؛ تنظیم‌نشده
هیچ کاری نمی‌کند و تنظیم موجود را دست نمی‌زند. هیچ بررسی‌ای این مقدار را با بودجه‌ها نمی‌سنجد: آن را از کف همان سرویس در
جدول بالا بیشتر بگذارید.

**منطقهٔ زمانی نشست پشت Pooler (L7-37، [D-048](23-risks-and-tradeoffs.md)).** هر نشست پایگاه داده باید در UTC باشد،
و **تضمین آن سمت پایگاه داده است، نه سمت Client**: برای پایگاه دادهٔ هر سرویس، Role زمان اجرا و Migrator آن،

```sql
ALTER DATABASE rasta_<svc> SET TimeZone = 'UTC';
ALTER ROLE <role> SET TimeZone = 'UTC';
ALTER ROLE <role> IN DATABASE rasta_<svc> SET TimeZone = 'UTC';   -- بر هر Override قدیمیِ همان پایگاه داده غلبه می‌کند
```

سرور این پیش‌فرض‌ها را هنگام ساختن هر Backend اعمال می‌کند، بر `timezone` فایل `postgresql.conf` مقدم‌اند، و به هیچ چیزِ
آمده از Client وابسته نیستند؛ پس Backendی که PgBouncer میان Clientها دست‌به‌دست می‌کند هم در UTC آغاز می‌شود.
`infrastructure/docker/postgres/lib/session-timezone.bash` همین را در Bootstrap (`00-init-databases.sh`)، در Split هر سرویس
(`service-privilege-split.bash`) و برای Volume موجود در `pnpm db:rotate-role-passwords` اعمال می‌کند — Idempotent و با SQL روی
stdin (D-047) — و `pnpm check:db-runtime-privileges` در CI هر پایگاه داده و هر دو Role را می‌سنجد. Provisioning هر خوشهٔ
Production همین دستورها را اجرا می‌کند.

لایهٔ دوم Client است: سرویس‌ها، `scripts/prisma.mjs`، Seedها و اسکریپت‌ها و آزمون‌هایی که مستقیم وصل می‌شوند، `options=-c
TimeZone=UTC` را هنگام Startup می‌فرستند (`withUtcSession`). PgBouncer پارامتر Startupی را که نمی‌شناسد رد می‌کند و اتصال
باز نمی‌شود؛ پس تا وقتی این Option در URL هست، پیکربندی PgBouncer باید `options` را در `ignore_startup_parameters` داشته
باشد (کنار هر پارامتر دیگری که Clientها می‌فرستند). PgBouncer پارامتر فهرست‌شده را **دور می‌اندازد** و به سرور نمی‌رساند —
یعنی پشت Pooler فقط تنظیم سمت پایگاه داده اثر دارد، و برای همین تنظیمِ سمت پایگاه داده تضمین است و Option فقط لایهٔ دوم.
`SET TimeZone` در نشست جایگزین هیچ‌کدام نیست: در Transaction Pooling روی Backend مشترک می‌ماند و به Client بعدی می‌رسد.

**Replication (Production).** یک Primary + حداقل یک Standby همزمان. خواندن‌های سنگین
گزارشی به Standby می‌روند. `economic` و `audit` روی Cluster اختصاصی.

---

## ۱۱٫۳ Redis

| کاربرد               | ساختار داده           | نکته                                           |
| -------------------- | --------------------- | ---------------------------------------------- |
| Cache                | String با TTL         | همیشه با پیشوند مستأجر                         |
| Rate Limit           | Sorted Set            | Sliding Window                                 |
| قفل توزیع‌شده        | String با `SET NX PX` | Redlock برای عملیات چندکیف‌پولی                |
| سبد خرید             | Hash                  | TTL ۷ روز                                      |
| Cache Idempotency    | String با TTL         | لایه Gateway؛ منبع اصلی همچنان پایگاه داده است |
| صف اعلان (کوتاه‌عمر) | List                  | فقط بافر تحویل، نه منبع حقیقت                  |

**`maxmemory-policy = noeviction`.** Redis اینجا Cache صرف نیست — قفل و Rate Limit در آن
است. حذف خودکار یک قفل زیر فشار حافظه، یک باگ همزمانی تولید می‌کند.

**CONSTRAINT — چه چیزی هرگز در Redis نمی‌رود:**

```
🚫 موجودی کیف پول
🚫 ورودی یا مانده دفتر کل
🚫 محتوای پیشنهاد مناقصه پیش از مهلت
🚫 هر داده مستأجر بدون {orgId} در کلید
```

**MVP → PRODUCTION.** MVP: تک‌گره. Production: Redis Sentinel یا Cluster با AOF فعال.

---

## ۱۱٫۴ Kafka

**KRaft** (بدون ZooKeeper) — یک جزء کمتر برای نگهداری.

| تنظیم                            | dev   | Production |
| -------------------------------- | ----- | ---------- |
| گره                              | ۱     | ۳          |
| `replication.factor`             | ۱     | ۳          |
| `min.insync.replicas`            | ۱     | ۲          |
| پارتیشن به‌ازای Topic دامنه      | ۳     | ۱۲         |
| `auto.create.topics.enable`      | false | false      |
| `unclean.leader.election.enable` | false | false      |

**`unclean.leader.election.enable=false` غیرقابل مذاکره است.** انتخاب یک Replica عقب‌مانده
به‌عنوان Leader یعنی از دست رفتن رویداد — در جریان مالی غیرقابل قبول.

**تنظیمات Producer:** `acks=all` · `enable.idempotence=true` · `compression.type=lz4` ·
`retries=MAX`.

**تنظیمات Consumer:** `enable.auto.commit=false` (Commit دستی پس از پردازش موفق) ·
`isolation.level=read_committed` · `max.poll.records=100`.

**MVP → PRODUCTION.** از 2026-09-28 (RUN-006، ADR-061 § ۳ اصلاحیه) Broker توسعه و CI هم **SASL/SCRAM + TLS** با
ACL به‌ازای سرویس دارند — هر سرویس فقط روی Topicهای خودش می‌نویسد و فقط اشتراکش را می‌خواند؛ CA آن‌ها یک‌بارمصرف است.
Production همین قواعد را با CA واقعی و Secretهای مدیریت‌شده می‌خواهد. این کنترل تهدید Event Spoofing (P1 در Threat
Model) است.

---

## ۱۱٫۵ Keycloak

Realm واحد `rasta` با:

- سه Client: `rasta-web` (عمومی، PKCE) · `rasta-backend` (محرمانه، Service Account) ·
  `rasta-api` (Bearer-Only، مقصد `aud`)
- یازده نقش Realm (نگاشت در [`02-product-context.md`](02-product-context.md))
- Client Scope اختصاصی `rasta-tenant` که `org_id` و `org_ids` را به توکن تزریق می‌کند
- سیاست رمز عبور و Brute-Force فعال
- TOTP پیکربندی‌شده (MFA-ready)

پیکربندی: [`infrastructure/docker/keycloak/rasta-realm.json`](../infrastructure/docker/keycloak/rasta-realm.json)

**این Realm فقط برای توسعه و CI است (L1-05).** Grant رمز عبور را روی `rasta-web` و `rasta-backend` روشن می‌کند و کاربرانی —
از جمله یک `SYSTEM_ADMIN` — با رمز دائمیِ Commitشده در همین مخزن می‌سازد. دو دروازه آن را محصور نگه می‌دارند:

1. `"enabled"` این Realm Placeholder ‏`${RASTA_DEV_REALM_GATE}` است. Keycloak با Placeholder بولیِ حل‌نشده **بالا نمی‌آید**
   ("only true or false recognized")، پس Mount کردن مستقیم فایل در پوشهٔ Import — در حالت Dev یا Production — Import نمی‌کند.
2. تنها چیزی که آن را `true` می‌کند [`dev-realm-gate.sh`](../infrastructure/docker/keycloak/dev-realm-gate.sh) است، و فقط
   وقتی فرمان `start-dev` (حالت توسعهٔ خودِ Keycloak) باشد **و** `RASTA_KEYCLOAK_DEV_REALM=allow` صریحاً تنظیم شده باشد؛ در
   غیر این صورت با کد ۶۴ پیش از اجرای Keycloak خارج می‌شود.

`docker-compose.yml` و هر دو Job مرورگری CI Keycloak را از راه همین Gate بالا می‌آورند، و
`pnpm check:keycloak-dev-realm` (در `pnpm verify` و CI) هر Launcherی را که بی Gate Realm را Import کند، یا Placeholder و
بررسی‌های Gate را حذف کند، رد می‌کند. Production هرگز این فایل را بار نمی‌کند؛ Realm Production جداگانه و بیرون از مخزن
تعریف می‌شود.

**باقی‌ماندهٔ شناخته‌شده (پذیرفته، نه رفع‌شده).** این دو دروازه جلوی بارشدن **تصادفی یا پیش‌فرض** Realm را می‌گیرند، نه
دور زدن **عمدی** را: اپراتوری که آگاهانه `RASTA_DEV_REALM_GATE=true kc.sh import --file …` اجرا کند، Realm را وارد می‌کند.
این بیرون از دامنهٔ دروازه است — هر فایلی که اعتبارنامه دارد، قابل Import است. رفع واقعی، **برداشتن اعتبارنامه‌های Seed از
خودِ Realm قابل Import** است (مثلاً ساختن کاربران نمایشی با رمز یک‌بارمصرفِ تولیدشده هنگام بالا آمدن محیط توسعه)؛ این به‌عنوان
کار پیگیری ثبت شده، نه بخشی از L1-05.

**مرز مسئولیت.** Keycloak مالک **احراز هویت** است. `identity-service` مالک **عضویت سازمانی
و نقش‌های دامنه‌ای** است و صفات `active_organization_id` / `organization_ids` را از راه
Admin API با Keycloak همگام می‌کند تا در توکن بنشینند.

**MVP → PRODUCTION.** MVP: `start-dev`. Production: حالت Production با TLS، پایگاه داده
اختصاصی، چند Replica، و ارزیابی Federation برای اتصال آتی به هویت ملی (**OPEN QUESTION**).

---

## ۱۱٫۶ Temporal

| مورد        | MVP                    | Production                                 |
| ----------- | ---------------------- | ------------------------------------------ |
| استقرار     | تک‌گره `auto-setup`    | Cluster چندگره                             |
| پایگاه داده | PostgreSQL مشترک       | PostgreSQL اختصاصی                         |
| Namespace   | `default`              | `rasta-prod` · `rasta-staging` (جدا)       |
| نگهداشت     | ۷ روز                  | ۳۰ روز (۹۰ روز برای صف `rasta-settlement`) |
| Worker      | داخل فرایند سرویس مالک | Deployment جدا با HPA مستقل                |

چهار Task Queue برای Bulkhead: `rasta-tender` · `rasta-order` · `rasta-settlement` ·
`rasta-scheduled`. تفصیل: [`08-workflow-architecture.md`](08-workflow-architecture.md)

---

## ۱۱٫۷ Object Storage

**CONSTRAINT.** فایل **هرگز** در پایگاه داده ذخیره نمی‌شود. `document-service` فقط فراداده
و کنترل دسترسی را نگه می‌دارد.

| Bucket            | محتوا                                     | چرخه عمر                       |
| ----------------- | ----------------------------------------- | ------------------------------ |
| `rasta-documents` | قرارداد، بیمه، مناقصه، صورت‌وضعیت، فاکتور | نگهداشت طولانی (OPEN QUESTION) |
| `rasta-images`    | تصاویر دارایی، گزارش خرابی، پیشرفت پروژه  | ۵ سال                          |
| `rasta-exports`   | خروجی گزارش تولیدشده                      | ۷ روز، سپس حذف خودکار          |
| `rasta-backups`   | Backup پایگاه داده (Production)           | ۳۰ روز + ۱۲ ماه ماهانه         |

**الگوی آپلود (بدون عبور فایل از سرویس):**

```
۱. کلاینت: POST /documents/upload-url  → سرویس URL امضاشده PUT می‌دهد (۵ دقیقه)
۲. کلاینت: PUT مستقیم به Object Storage
۳. کلاینت: POST /documents  → ثبت فراداده، تأیید وجود شیء
۴. سرویس: انتشار DOCUMENT_UPLOADED (scanState = PENDING) → اسکن بدافزار ناهمزمان
۵. Worker: Stream شیء → clamd (Sidecar، Unix Socket) → DOCUMENT_SCANNED
۶. دانلود تنها پس از یک CLEAN معتبر (ADR-049)
```

**چرا؟** فایل بزرگ از حافظه و پهنای باند سرویس عبور نمی‌کند، و Timeout آپلود مسئله سرویس نیست.

**کنترل‌های امنیتی:** بررسی Magic Number (نه پسوند) · محدودیت اندازه به‌ازای نوع ·
کلید شیء از ULID سرور (نه نام کاربر — دفاع Path Traversal) · Bucket خصوصی، همه دسترسی‌ها
از راه URL امضاشده کوتاه‌عمر · رمزنگاری در حالت سکون.

---

## ۱۱٫۸ Search (OpenSearch)

**فاز:** P1. در P0 جست‌وجو با `pg_trgm` در PostgreSQL انجام می‌شود — برای چند هزار دارایی
کافی است و یک وابستگی کمتر در Demo.

| Index             | منبع                     | کاربرد                                  |
| ----------------- | ------------------------ | --------------------------------------- |
| `rasta-assets`    | رویدادهای `asset`        | جست‌وجوی ماشین‌آلات با فیلتر و Facet    |
| `rasta-products`  | رویدادهای `marketplace`  | جست‌وجوی کالا و خدمت                    |
| `rasta-suppliers` | رویدادهای `supplier`     | جست‌وجوی تأمین‌کننده/پیمانکار با امتیاز |
| `rasta-tenders`   | رویدادهای `construction` | مناقصه‌های باز                          |
| `rasta-contracts` | رویدادهای `contract`     | جست‌وجوی قرارداد                        |

**قواعد:**

- Index از **رویداد** ساخته می‌شود، نه از خواندن مستقیم پایگاه داده سرویس دیگر.
- هر سند `organizationId` دارد و **هر Query یک فیلتر اجباری مستأجر می‌گیرد**.
- OpenSearch **هرگز مرجع حقیقت نیست** — همیشه قابل بازسازی کامل از Kafka.
- تحلیلگر فارسی برای نرمال‌سازی «ی/ي»، «ک/ك» و نیم‌فاصله.

---

## ۱۱٫۹ منابع

| سرویس             | CPU (req/lim) | Memory (req/lim) | Replica (Prod) |
| ----------------- | ------------- | ---------------- | -------------- |
| api-gateway       | 200m / 1000m  | 256Mi / 512Mi    | ۳              |
| سرویس دامنه معمول | 100m / 500m   | 256Mi / 512Mi    | ۲              |
| economic-service  | 300m / 1500m  | 512Mi / 1Gi      | ۳              |
| analytics-service | 200m / 1000m  | 512Mi / 1Gi      | ۲              |
| Temporal Worker   | 200m / 1000m  | 512Mi / 1Gi      | ۲              |
| web / admin       | 200m / 1000m  | 512Mi / 1Gi      | ۲              |

**حداقل برای توسعه محلی:** ۸ گیگابایت RAM آزاد، ۲۰ گیگابایت دیسک، ۴ هسته.
پروفایل `all` در Docker Compose حدود ۶ گیگابایت مصرف می‌کند — به همین دلیل OpenSearch و
پشته مشاهده‌پذیری پشت پروفایل‌اند و در حالت پیش‌فرض بالا نمی‌آیند.

---

## ۱۱٫۱۰ شبکه

```
اینترنت
   │
   ▼  TLS 1.3
Ingress (nginx / Traefik) + WAF
   │
   ▼  فقط این مسیر از بیرون باز است
api-gateway  (تنها سرویس با Ingress)
   │
   ▼  شبکه داخلی Cluster
Domain Services  ── NetworkPolicy: فقط از api-gateway و از یکدیگر
   │
   ▼
Data Layer  ── NetworkPolicy: فقط از سرویس مالک همان پایگاه داده
```

**CONSTRAINT — NetworkPolicy (Production).**

- هیچ سرویس دامنه‌ای Ingress عمومی ندارد.
- `rasta_economic` فقط از Pod با Label `app=economic-service` قابل دسترسی است.
- `/metrics` و `/health/*` فقط از Namespace پایش.
- Egress پیش‌فرض بسته؛ فهرست سفید صریح.

---

## ۱۱٫۱۱ ماتریس MVP → Production

| جزء            | MVP                                     | Production                                          |
| -------------- | --------------------------------------- | --------------------------------------------------- |
| PostgreSQL     | تک‌گره، ۱۶ DB منطقی                     | Primary + Standby، PgBouncer، Cluster جدا برای مالی |
| Redis          | تک‌گره                                  | Sentinel/Cluster با AOF                             |
| Kafka          | تک‌گره KRaft، SASL_SSL + ACL (RUN-006)  | ۳ گره، RF=3، **SASL/SCRAM + TLS + ACL**             |
| Keycloak       | `start-dev`، تک‌گره                     | حالت Production، TLS، چند Replica، MFA اجباری       |
| Temporal       | `auto-setup`، تک‌گره                    | Cluster، Namespace جدا                              |
| Object Storage | MinIO تک‌گره                            | S3 مدیریت‌شده یا MinIO توزیع‌شده، Versioning        |
| Search         | `pg_trgm` (P0) → OpenSearch تک‌گره (P1) | Cluster ۳ گره                                       |
| Secrets        | `.env`                                  | External Secrets Operator                           |
| TLS داخلی      | ندارد                                   | **mTLS** (Service Mesh یا SPIFFE)                   |
| Backup         | `pg_dump` روزانه                        | PITR با WAL، تست Restore ماهانه                     |
