# ۱۳ — Observability

> سه ستون Log، Metric و Trace با OpenTelemetry. یک درخواست باید از مرورگر تا ورودی دفتر کل
> **با یک شناسه** قابل ردیابی باشد.

---

## ۱۳٫۱ زمینه انتشاریافته (Propagated Context)

این مهم‌ترین تصمیم این سند است: **پنج شناسه** از نخستین لحظه در همه سرویس‌ها جریان دارند.

| شناسه           | مبدأ                              | جریان                                            |
| --------------- | --------------------------------- | ------------------------------------------------ |
| `correlationId` | Gateway (یا Header کلاینت)        | HTTP → Service → Kafka Envelope → Workflow → Log |
| `traceId`       | OpenTelemetry (W3C `traceparent`) | همه‌جا؛ خودکار                                   |
| `spanId`        | OpenTelemetry                     | به‌ازای هر عملیات                                |
| `tenantId`      | JWT (`org_id`)، اعتبارسنجی‌شده    | Context → Query → Log → Envelope رویداد          |
| `userId`        | JWT (`sub`)                       | Context → Log → Audit → Envelope رویداد          |
| `serviceName`   | پیکربندی سرویس                    | همه Logها و Spanها                               |

**پیاده‌سازی.** `AsyncLocalStorage` این Context را در طول عمر یک درخواست نگه می‌دارد بدون
آنکه لازم باشد از هر تابع به تابع بعدی پاس داده شود.

```
Middleware (Gateway) → RequestContext ایجاد می‌شود
  → Interceptor آن را به Header داخلی می‌گذارد
  → سرویس مقصد آن را بازسازی می‌کند
  → Outbox آن را در Envelope رویداد می‌نویسد
  → Consumer آن را از Envelope بازسازی می‌کند
  → Workflow آن را در Memo نگه می‌دارد
```

**نتیجه عملی.** یک کاربر می‌گوید «سفارشم ثبت نشد» و شماره `correlationId` را می‌دهد.
با همان یک شناسه: درخواست HTTP، Query پایگاه داده، رویداد Kafka، اجرای Workflow و ورودی
دفتر کل — همه پیدا می‌شوند.

---

## ۱۳٫۲ Logging

**قالب: JSON ساخت‌یافته** (pino). هرگز رشته آزاد.

```jsonc
{
  "level": "info",
  "time": "2026-08-26T10:15:30.123Z",
  "service": "marketplace-service",
  "version": "0.3.1",
  "env": "production",
  "correlationId": "01JBQ8Z4K7M2N5P8R1T3V6X9Y2",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "spanId": "00f067aa0ba902b7",
  "tenantId": "ORG_01JBQ8...",
  "userId": "USR_01JBQ8...",
  "msg": "Order created",
  "orderId": "ORD_01JBQ8...",
  "itemCount": 3,
  "amountMinor": "10000000",
  "durationMs": 42,
}
```

### سطوح

| سطح     | استفاده                                       | نمونه                              |
| ------- | --------------------------------------------- | ---------------------------------- |
| `error` | شکستی که نیازمند دخالت است                    | Journal نامتوازن، Relay گیرکرده    |
| `warn`  | وضعیت غیرعادی که سیستم از آن بازیابی کرد      | Retry موفق، Circuit Breaker باز شد |
| `info`  | رویداد کسب‌وکاری مهم                          | سفارش ثبت شد، مناقصه منتشر شد      |
| `debug` | جزئیات توسعه — **فقط در محیط غیر Production** | مقدار متغیر، مسیر تصمیم            |

### CONSTRAINT — چه چیزی هرگز Log نمی‌شود

```
🚫 رمز عبور، توکن، کلید API، Secret — حتی بخشی از آن
🚫 کد ملی، شماره تماس، مدارک هویتی
🚫 محتوای پیشنهاد مناقصه پیش از مهلت
🚫 بدنه کامل درخواست/پاسخ حاوی داده شخصی
🚫 Stack Trace در پاسخ به کاربر (فقط در Log سرور)
```

Redaction خودکار در `@rasta/logging`: فهرست کلیدهای حساس (`password`, `token`, `secret`,
`authorization`, `nationalId`, `cardNumber`, …) پیش از سریال‌سازی جایگزین `[REDACTED]` می‌شوند.

**MVP → PRODUCTION.** MVP: خروجی به stdout، تجمیع با `docker compose logs`.
Production: OTel Collector → Loki یا سامانه معادل، با نگهداشت ۳۰ روز (۱۳ ماه برای
Logهای مالی).

---

## ۱۳٫۳ Metrics

### متریک‌های استاندارد (هر سرویس)

| متریک                                   | نوع       | برچسب‌ها                             |
| --------------------------------------- | --------- | ------------------------------------ |
| `http_server_duration_seconds`          | Histogram | method, route, status, service       |
| `http_server_requests_total`            | Counter   | method, route, status, service       |
| `http_server_active_requests`           | Gauge     | service                              |
| `db_query_duration_seconds`             | Histogram | service, operation, model            |
| `db_pool_connections`                   | Gauge     | service, state (idle/active/waiting) |
| `kafka_producer_messages_total`         | Counter   | topic, service                       |
| `kafka_consumer_lag`                    | Gauge     | topic, group, partition              |
| `kafka_consumer_processing_duration`    | Histogram | topic, group, event_name             |
| `rasta_outbox_pending_total`            | Gauge     | service                              |
| `rasta_outbox_pending_age_seconds`      | Gauge     | service                              |
| `rasta_dlq_messages_total`              | Counter   | topic, reason                        |
| `rasta_event_validation_failures_total` | Counter   | topic, event_name                    |
| `temporal_workflow_completed_total`     | Counter   | workflow_type, task_queue            |
| `temporal_activity_retries_total`       | Counter   | activity_type                        |

### متریک‌های کسب‌وکاری

| متریک                                 | چرا اهمیت دارد                                                 |
| ------------------------------------- | -------------------------------------------------------------- |
| `rasta_orders_created_total`          | حجم Marketplace                                                |
| `rasta_order_cycle_duration_seconds`  | «گزارش زمان چرخه سفارش» سند محصول                              |
| `rasta_maintenance_requests_total`    | برچسب `type=PREVENTIVE\|CORRECTIVE` → **نسبت اجتناب از هزینه** |
| `rasta_maintenance_response_seconds`  | «گزارش زمان پاسخ‌دهی» سند محصول                                |
| `rasta_transactions_total`            | برچسب `status`                                                 |
| `rasta_commission_amount_minor_total` | **درآمد پلتفرم** — مستقیماً منطق اقتصادی سوم                   |
| `rasta_wallet_balance_minor`          | مجموع موجودی (تجمیعی، بدون تفکیک سازمان)                       |
| `rasta_rewards_granted_total`         | سلامت موتور انگیزشی                                            |
| `rasta_tenders_published_total`       | فعالیت رستا عمران                                              |
| `rasta_bids_per_tender`               | Histogram — سلامت رقابت                                        |
| `rasta_data_completeness_ratio`       | **معیار موفقیت Gamification طبق سند محصول**                    |

**CONSTRAINT.** متریک کسب‌وکاری هرگز برچسب با Cardinality بالا نمی‌گیرد (`userId`,
`orderId`, `assetId`). این Prometheus را منفجر می‌کند. تفکیک سازمانی فقط در
`analytics-service` و روی پایگاه داده انجام می‌شود، نه در متریک.

---

## ۱۳٫۴ Tracing

**نمونه‌برداری:**

| محیط        | نرخ                                       |
| ----------- | ----------------------------------------- |
| Development | ۱۰۰٪                                      |
| Staging     | ۱۰۰٪                                      |
| Production  | ۱۰٪ + **۱۰۰٪ خطاها** + **۱۰۰٪ مسیر مالی** |

**CONSTRAINT.** هر Span در `economic-service` و هر گذار وضعیت مناقصه **همیشه** نمونه‌برداری
می‌شود. نمونه‌برداری تصادفی روی مسیری که ممکن است بعداً موضوع حسابرسی شود، اشتباه است.

**Spanهای کلیدی:** درخواست HTTP · Query پایگاه داده · تولید و مصرف Kafka · اجرای Workflow
و Activity · فراخوانی سرویس داخلی · عملیات Redis · فراخوانی Provider پرداخت.

**Trace نمونه — سفارش کامل:**

```
POST /v1/orders                                    [gateway]        45ms
├─ verify JWT (JWKS cache hit)                     [gateway]         1ms
├─ resolve tenant                                  [gateway]         2ms
└─ POST /internal/v1/orders                        [marketplace]    38ms
   ├─ validate offer & price                       [marketplace]     4ms
   ├─ BEGIN TRANSACTION                            [marketplace]
   │  ├─ INSERT order                              [marketplace]     6ms
   │  ├─ INSERT order_line ×3                      [marketplace]     4ms
   │  └─ INSERT outbox_message                     [marketplace]     2ms
   ├─ COMMIT                                       [marketplace]     3ms
   └─ start OrderSagaWorkflow                      [temporal]        8ms
      ...  (ناهمزمان، همان traceId)
      └─ economic.placeHold                        [economic]       22ms
         ├─ SELECT wallet FOR UPDATE               [economic]        5ms
         ├─ INSERT wallet_hold                     [economic]        3ms
         ├─ INSERT journal + ledger_entry ×2       [economic]        7ms
         └─ INSERT outbox_message                  [economic]        2ms
```

---

## ۱۳٫۵ SLI و SLO

| سرویس          | SLI               | SLO                  |
| -------------- | ----------------- | -------------------- |
| api-gateway    | دسترس‌پذیری       | ۹۹٫۹٪ ماهانه         |
| api-gateway    | تأخیر p95         | < ۳۰۰ms              |
| api-gateway    | تأخیر p99         | < ۱٬۰۰۰ms            |
| هر سرویس دامنه | نرخ خطا (5xx)     | < ۰٫۱٪               |
| `economic`     | **دسترس‌پذیری**   | **۹۹٫۹۵٪**           |
| `economic`     | **موفقیت تراکنش** | **> ۹۹٫۹٪**          |
| `economic`     | **توازن دفتر کل** | **۱۰۰٪ — بدون تحمل** |
| Kafka          | تأخیر Consumer    | < ۳۰ ثانیه p99       |
| Outbox         | سن پیام منتشرنشده | < ۶۰ ثانیه p99       |
| Search         | تأخیر Index       | < ۵ ثانیه p95        |

**Error Budget.** SLO دسترس‌پذیری ۹۹٫۹٪ یعنی ~۴۳ دقیقه قطعی مجاز در ماه.
مصرف بیش از ۵۰٪ بودجه در نیمه ماه → توقف انتشار Feature جدید تا پایان دوره.

---

## ۱۳٫۶ هشدارها

### بحرانی — بیدارباش فوری

| هشدار                         | شرط                              | چرا بحرانی            |
| ----------------------------- | -------------------------------- | --------------------- |
| **Journal نامتوازن**          | حسابرسی روزانه انحراف یافت       | یکپارچگی مالی نقض شده |
| **انحراف کیف پول و دفتر کل**  | `ledgerBalance ≠ Σ(entries)`     | یکپارچگی مالی نقض شده |
| **تلاش UPDATE روی دفتر کل**   | Trigger شلیک شد                  | تلاش برای دستکاری     |
| افت `economic-service`        | Readiness ناموفق > ۲ دقیقه       | پرداخت متوقف          |
| افت `api-gateway`             | همه Replicaها ناسالم             | قطع کامل              |
| افت پایگاه داده               | اتصال ناموفق                     | همه‌چیز متوقف         |
| **Workflow شکست‌خورده تسویه** | هر مورد در صف `rasta-settlement` | پول در وضعیت نامعلوم  |

### هشدار — بررسی در ساعات کاری

| هشدار                  | شرط                              |
| ---------------------- | -------------------------------- |
| تأخیر Consumer         | > ۱۰٬۰۰۰ پیام یا > ۵ دقیقه       |
| Relay Outbox گیرکرده   | سن > ۶۰ ثانیه                    |
| **پیام DLQ**           | **هر پیام جدید**                 |
| نرخ خطای بالا          | 5xx > ۱٪ در ۵ دقیقه              |
| تأخیر بالا             | p95 > ۲× SLO در ۱۰ دقیقه         |
| Pool اتصال اشباع       | > ۸۰٪ برای ۵ دقیقه               |
| فضای دیسک              | > ۸۰٪                            |
| Circuit Breaker باز    | هر مورد                          |
| شکست اعتبارسنجی رویداد | > ۰ — نقض قرارداد                |
| ناهنجاری پاداش         | > ۳ انحراف معیار از میانگین      |
| افزایش ۴۰۳             | > ۱۰ برابر خط مبنا — احتمال حمله |

**CONSTRAINT.** هر هشدار باید **Runbook** داشته باشد. هشدار بدون دستورالعمل پاسخ،
نویز است و به‌مرور نادیده گرفته می‌شود. → [`runbooks/`](runbooks/)

---

## ۱۳٫۷ داشبوردهای Grafana

| داشبورد              | مخاطب           | محتوا                                                       |
| -------------------- | --------------- | ----------------------------------------------------------- |
| Platform Overview    | مهندسی          | نرخ درخواست، خطا، تأخیر، دسترس‌پذیری همه سرویس‌ها           |
| Service Detail       | مهندسی          | به‌ازای هر سرویس: RED + منابع + Pool پایگاه داده            |
| Event Pipeline       | مهندسی          | تأخیر Consumer، سن Outbox، عمق DLQ، نرخ Throughput          |
| Workflow Health      | مهندسی          | اجراهای Temporal، شکست، Retry، تأخیر صف                     |
| **Financial Health** | مهندسی + عملیات | حجم تراکنش، نرخ موفقیت، **وضعیت توازن دفتر کل**، تسویه معلق |
| Business Metrics     | مدیریت پلتفرم   | سفارش، مناقصه، نگهداری، کاربر فعال، کامل بودن داده          |
| Security             | امنیت           | نرخ ۴۰۱/۴۰۳، برخورد Rate Limit، ورود ناموفق، ناهنجاری       |

---

## ۱۳٫۸ Health Check

| Endpoint          | بررسی                                | مصرف‌کننده      |
| ----------------- | ------------------------------------ | --------------- |
| `/health/live`    | فرایند پاسخ می‌دهد                   | Liveness Probe  |
| `/health/ready`   | پایگاه داده + Kafka + Redis در دسترس | Readiness Probe |
| `/health/startup` | Migration اجرا شده، Consumerها متصل  | Startup Probe   |
| `/metrics`        | متریک Prometheus                     | Prometheus      |
| `/version`        | نسخه، Commit SHA، زمان Build         | تشخیص           |

**قاعده.** `ready` باید وابستگی‌های **ضروری** را بررسی کند، نه همه را. اگر `asset-service`
به OpenSearch دسترسی ندارد، همچنان می‌تواند CRUD انجام دهد — پس OpenSearch در `ready`
نیست. بررسی بیش از حد در `ready` باعث آبشار قطعی می‌شود.
