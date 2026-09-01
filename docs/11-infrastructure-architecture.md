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

**Connection Pooling.** هر سرویس Pool خودش را دارد (Prisma، حداکثر ۱۰ اتصال در MVP).
Production: **PgBouncer** در حالت Transaction Pooling جلوی Cluster — ۱۷ سرویس × چند Replica
به‌سرعت `max_connections` را می‌بلعد.

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

**MVP → PRODUCTION.** MVP: PLAINTEXT در شبکه داخلی. Production: **SASL/SCRAM + TLS**
با ACL به‌ازای سرویس — هر سرویس فقط روی Topicهای خودش می‌نویسد. این کنترل تهدید
Event Spoofing (P1 در Threat Model) است.

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
| Kafka          | تک‌گره KRaft، PLAINTEXT                 | ۳ گره، RF=3، **SASL/SCRAM + TLS + ACL**             |
| Keycloak       | `start-dev`، تک‌گره                     | حالت Production، TLS، چند Replica، MFA اجباری       |
| Temporal       | `auto-setup`، تک‌گره                    | Cluster، Namespace جدا                              |
| Object Storage | MinIO تک‌گره                            | S3 مدیریت‌شده یا MinIO توزیع‌شده، Versioning        |
| Search         | `pg_trgm` (P0) → OpenSearch تک‌گره (P1) | Cluster ۳ گره                                       |
| Secrets        | `.env`                                  | External Secrets Operator                           |
| TLS داخلی      | ندارد                                   | **mTLS** (Service Mesh یا SPIFFE)                   |
| Backup         | `pg_dump` روزانه                        | PITR با WAL، تست Restore ماهانه                     |
