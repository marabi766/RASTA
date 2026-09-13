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
| `rasta_outbox_ack_fenced_total`         | Counter   | service                              |
| `rasta_outbox_lease_reclaimed_total`    | Counter   | service                              |
| `rasta_outbox_claim_attempts_total`     | Counter   | service                              |
| `rasta_outbox_leases_active`            | Gauge     | service                              |
| `rasta_dlq_messages_total`              | Counter   | service, topic (مبدأ), reason        |
| `rasta_event_validation_failures_total` | Counter   | topic, event_name                    |
| `temporal_workflow_completed_total`     | Counter   | workflow_type, task_queue            |
| `temporal_activity_retries_total`       | Counter   | activity_type                        |

#### متریک‌های Claim بادوام Outbox (ADR-050)

| متریک                                | دقیقاً چه چیزی را می‌شمارد                                                             |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| `rasta_outbox_ack_fenced_total`      | ردیف‌هایی که یک Mutation به‌دلیل عدم تطابق `claim_token` لمس نکرد — **رویداد Fencing** |
| `rasta_outbox_lease_reclaimed_total` | ردیف‌هایی که با Lease منقضی دوباره Claim شدند                                          |
| `rasta_outbox_claim_attempts_total`  | تعداد ردیف‌های Claimشده                                                                |
| `rasta_outbox_leases_active`         | ردیف‌های دارای Lease زنده                                                              |

**تحویل تکراری در سمت Producer قابل مشاهده نیست.** رله نمی‌داند یک `sendBatch`
که Timeout خورد به Broker رسید یا نه، پس هیچ متریکی اینجا «تکرار» را گزارش
نمی‌کند. `ack_fenced_total` یک **نشانگر کران‌پایین** است: هر مقدار غیرصفر یعنی یک
انتشار تکراری _ممکن_ است رخ داده باشد. متن هشدار باید همین را بگوید:

> «Fencing در Outbox رخ داد: N ردیف پس از ازدست‌رفتن مالکیت Ack نشدند. ممکن است
> تحویل تکراری رخ داده باشد؛ در سمت Producer قابل تأیید نیست.»

**هر دو Gauge با `SELECT count(*)` نمونه‌برداری می‌شوند، نه با `inc`/`dec`.**
الگوی قبلی — `onBatchPublished: (count) => outboxPendingTotal.dec(...)` — پس از
هر Restart و هر مسیر خطای ازدست‌رفته Drift می‌کرد، و **رو به پایین**: یعنی یک
رلهٔ متوقف را بی‌کار نشان می‌داد، دقیقاً همان عددی که نباید اشتباه باشد.

### متریک‌های کسب‌وکاری

| متریک                                            | چرا اهمیت دارد                                                                                                   |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `rasta_orders_created_total`                     | حجم Marketplace                                                                                                  |
| `rasta_order_cycle_duration_seconds`             | «گزارش زمان چرخه سفارش» سند محصول                                                                                |
| `rasta_maintenance_requests_created_total`       | برچسب `type=PREVENTIVE\|CORRECTIVE` → **نسبت اجتناب از هزینه** — پیاده‌شده                                       |
| `rasta_maintenance_requests_awaiting_approval`   | صف تأییدنشده — تسویه پشت آن متوقف است؛ بی‌صدا رشد می‌کند — پیاده‌شده                                             |
| `rasta_maintenance_due_announcements_total`      | برچسب `basis` و `state` — ناوگانی که بیشتر `OVERDUE` می‌گیرد تا `DUE_SOON`، مهلت هشدارش کوتاه است — پیاده‌شده    |
| `rasta_maintenance_downtime_hours`               | Histogram — میانگین توقف ناوگان از توزیعش بسیار کم‌فایده‌تر است — پیاده‌شده                                      |
| `rasta_maintenance_usage_readings_applied_total` | باید نزدیک شمارنده کارکرد fleet بماند؛ فاصله پایدار یعنی رویدادهای سررسید گم می‌شوند — پیاده‌شده                 |
| `rasta_maintenance_response_seconds`             | «گزارش زمان پاسخ‌دهی» سند محصول — **هنوز نه**                                                                    |
| `rasta_transactions_total`                       | برچسب `status`                                                                                                   |
| `rasta_commission_amount_minor_total`            | **درآمد پلتفرم** — مستقیماً منطق اقتصادی سوم                                                                     |
| `rasta_wallet_balance_minor`                     | مجموع موجودی (تجمیعی، بدون تفکیک سازمان)                                                                         |
| `rasta_rewards_granted_total`                    | سلامت موتور انگیزشی                                                                                              |
| `rasta_tenders_published_total`                  | فعالیت رستا عمران                                                                                                |
| `rasta_bids_per_tender`                          | Histogram — سلامت رقابت                                                                                          |
| `rasta_data_completeness_ratio`                  | **معیار موفقیت Gamification طبق سند محصول**                                                                      |
| `rasta_document_scan_verdicts_total`             | برچسب `verdict` — رشد `INFECTED` یک حادثه است، نه یک روند — پیاده‌شده (ADR-049)                                  |
| `rasta_document_scan_failures_total`             | برچسب `reason` — هر دلیل به یک آدم متفاوت می‌رسد؛ یک شمارنده بی‌فایده بود — پیاده‌شده                            |
| `rasta_document_scan_duration_seconds`           | Histogram با برچسب `verdict` — توزیع `CLEAN` و `FAILED` دوقله‌ای است و میانگین هر دو را پنهان می‌کند — پیاده‌شده |
| `rasta_document_scan_pending_oldest_age_seconds` | **عددی که باید رویش هشدار گذاشت** — عمق صف حادثه را از شلوغی سالم جدا نمی‌کند؛ این می‌کند — پیاده‌شده            |
| `rasta_document_scan_signature_age_seconds`      | freshclam بی‌صدا شکست می‌خورد: اسکن کار می‌کند و `OK` می‌دهد، و تنها نشانه بالا رفتن این عدد است — پیاده‌شده     |
| `rasta_document_scanner_up`                      | `1` وقتی اسکنر به آخرین Health Check پاسخ داد — پیاده‌شده                                                        |

**CONSTRAINT.** متریک کسب‌وکاری هرگز برچسب با Cardinality بالا نمی‌گیرد (`userId`,
`orderId`, `assetId`). این Prometheus را منفجر می‌کند. تفکیک سازمانی فقط در
`analytics-service` و روی پایگاه داده انجام می‌شود، نه در متریک.

این قاعده در متریک‌های اسکن **بیش از هر جای دیگر** می‌گزد: متریکی که با نام فایل برچسب
بخورد، _نام هر قرارداد آلودهٔ پلتفرم_ را به هرکسی که به `/metrics` می‌رسد منتشر می‌کند —
نشتی‌ای که به یک بایت محتوا هم نیاز ندارد. برچسب‌های مجاز آنجا سه تاست: یک Enum ثابت
Verdict، یک Enum ثابت دلیل شکست، و نام سرویس.

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

### وضعیت اجرا — قواعد موجود در مخزن (2026-09-13)

دو جدول بالا **هدف** است. تنها قواعد نوشته‌شده، دوازده هشدار و یک Recording Rule زنجیرهٔ شواهد حسابرسی در
[`../infrastructure/docker/prometheus/rules/rasta-audit-alerts.yml`](../infrastructure/docker/prometheus/rules/rasta-audit-alerts.yml)
هستند که `prometheus.yml` با `rule_files` بارشان می‌کند:

| هشدار                                   | شدت        | شرط                                                                                                                                                                                                                                                                                                     | Runbook                                                      |
| --------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `RastaDeadLetterMessagePublished`       | `warning`  | `sum by (service, topic, reason) (increase(rasta_dlq_messages_total[5m])) > 0`                                                                                                                                                                                                                          | [replay-dlq](runbooks/replay-dlq.md)                         |
| `RastaAuditIngestionFailure`            | `warning`  | `sum by (reason) (increase(rasta_audit_ingestion_failures_total[5m])) > 0`                                                                                                                                                                                                                              | [audit-gap-detected](runbooks/audit-gap-detected.md)         |
| `RastaAuditIngestionLagHigh`            | `warning`  | `histogram_quantile(0.95, sum by (le, source_topic) (rate(rasta_audit_ingestion_lag_seconds_bucket[5m]))) > 60` با `for: 5m`                                                                                                                                                                            | [audit-ingestion-lag](runbooks/audit-ingestion-lag.md)       |
| `RastaAuditProducerSilent`              | `warning`  | `(max by (source_service) (rasta_audit_expected_active_producer == 1) and on (source_service) max by (source_service) (rasta_audit_expected_active_producer offset 6h == 1)) unless on (source_service) (sum by (source_service) (increase(rasta_audit_records_ingested_total[6h])) > 0)` با `for: 30m` | [audit-gap-detected](runbooks/audit-gap-detected.md)         |
| `RastaAuditServiceMetricsUnavailable`   | `warning`  | `min by (job) (up{job="audit-service"}) == 0 or absent(up{job="audit-service"})` با `for: 2m`                                                                                                                                                                                                           | [audit-gap-detected](runbooks/audit-gap-detected.md)         |
| `RastaAuditChainDivergence`             | `critical` | `sum by (reason, scope) (increase(rasta_audit_chain_verification_failures_total[5m])) > 0`                                                                                                                                                                                                              | [audit-chain-divergence](runbooks/audit-chain-divergence.md) |
| `RastaSecurityEventCaptureGap`          | `critical` | `sum by (outcome) (increase(rasta_security_event_captures_total{outcome=~"failed\|timeout"}[5m])) > 0`                                                                                                                                                                                                  | [security-event-outbox](runbooks/security-event-outbox.md)   |
| `RastaSecurityEventClosedBacklogStale`  | `warning`  | `rasta_security_event_outbox_closed_backlog_age_seconds > 60`                                                                                                                                                                                                                                           | [security-event-outbox](runbooks/security-event-outbox.md)   |
| `RastaSecurityEventPublishFailure`      | `warning`  | `sum by (reason) (increase(rasta_security_event_publish_failures_total[5m])) > 0`                                                                                                                                                                                                                       | [security-event-outbox](runbooks/security-event-outbox.md)   |
| `RastaAuditConsumerLag`                 | `warning`  | `sum by (consumergroup, topic) (clamp_min(kafka_consumergroup_lag{consumergroup=~"audit-service\\.(domain-projector\|trail)"}, 0)) > 0` با `for: 5m`                                                                                                                                                    | [audit-ingestion-lag](runbooks/audit-ingestion-lag.md)       |
| `RastaKafkaExporterUnavailable`         | `warning`  | `min by (job) (up{job="kafka-exporter"}) == 0 or absent(up{job="kafka-exporter"})` با `for: 2m`                                                                                                                                                                                                         | [audit-ingestion-lag](runbooks/audit-ingestion-lag.md)       |
| `RastaAuditConsumerGroupMetricsMissing` | `warning`  | `(absent(kafka_consumergroup_lag{consumergroup="audit-service.domain-projector"}) or absent(kafka_consumergroup_lag{consumergroup="audit-service.trail"})) and on () (min(up{job="kafka-exporter"}) == 1)` با `for: 5m`                                                                                 | [audit-ingestion-lag](runbooks/audit-ingestion-lag.md)       |

هشدارهای شمارنده `for` ندارند، چون قرارداد هر متریک می‌گوید هر افزایش اقدام‌پذیر است؛ استثنا `RastaAuditProducerSilent` است که بر
**نبودِ** افزایش هشدار می‌دهد. رفتار هر دوازده هشدار و Recording Rule با
`promtool test rules` در CI اثبات می‌شود ([`14-testing-strategy.md`](14-testing-strategy.md) § ۱۴٫۱۱). **مرز:** این قواعد را فقط
Prometheus **محلی** Compose ارزیابی می‌کند؛ مخزن **Alertmanager ندارد**، پس هیچ اعلانی تحویل نمی‌شود؛ Scrape محیط واقعی و داشبورد
در مخزن نیستند.

**تأخیر شواهد از سمت سرویس — Histogram.** `rasta_audit_ingestion_lag_seconds{source_topic}` همان‌گونه که ADR-053 § ۱۳ می‌خواهد
یک **Histogram** است و در `/metrics` به شکل `rasta_audit_ingestion_lag_seconds_bucket{source_topic,le}`، `_sum{source_topic}` و
`_count{source_topic}` صادر می‌شود:

- **مقدار:** `max(0, now - occurredAt)` به ثانیه، یک‌بار برای هر ردیف که `DomainProjectorConsumer` (مسیر A) یا
  `AuditTrailConsumer` (مسیر B) با نتیجهٔ `WRITTEN` نوشت. ساعت جلوتر Producer به صفر Clamp می‌شود؛ `DUPLICATE`، Envelope
  ردشده و شکست پایگاه داده هیچ مشاهده‌ای ندارند.
- **Bucketها** (`AUDIT_INGESTION_LAG_BUCKETS`): `1, 5, 15, 30, 60, 120, 300, 900, 3600` و `+Inf` خودکار. `60` مرز دقیق است، چون
  `histogram_quantile` درون Bucket درون‌یابی می‌کند و آستانه نباید حدس باشد؛ زیر آن «زنده» از «یکی دو Retry عقب» جدا می‌شود و بالای
  آن ۲، ۵، ۱۵ و ۶۰ دقیقه نشان می‌دهد مصرف‌کنندهٔ کند تا کجا عقب افتاده است.
- **Cardinality:** فقط `source_topic` با ۱۱ مقدار (ده `DOMAIN_TOPICS` و `rasta.audit.trail.v1`)، که هنگام بار شدن ماژول با
  `zero()` صادر می‌شوند — بی مشاهدهٔ ساختگی: ۱۱ × (۹ مرز + `+Inf`) + ۱۱ `_sum` + ۱۱ `_count` = ۱۳۲ Series.
- **هشدار** `RastaAuditIngestionLagHigh`: p95 به‌ازای `source_topic` از جمع Bucketهای همهٔ Instanceها در پنجرهٔ `rate` پنج‌دقیقه‌ای،
  بالای ۶۰ ثانیه، با `for: 5m`؛ Labelها فقط `source_topic` و `severity`. بی مشاهده، Quantile برابر `NaN` است و نمی‌سوزد.
- **تفاوت با Lag کافکا:** این فاصلهٔ زمانی شواهدِ **نوشته‌شده** است؛ `kafka_consumergroup_lag` تعداد رکوردِ **هنوز مصرف‌نشده**.
  مصرف‌کننده‌ای که متوقف است هیچ مشاهده‌ای ندارد، پس این هشدار ساکت است و `RastaAuditConsumerLag` و دو هشدار از دست رفتن
  سیگنال آن را می‌بینند. p95 بالا با Lag کافکای صفر یعنی رویدادها دیر به Kafka رسیده‌اند (Outbox/Relay تولیدکننده).

**ساکت شدن تولیدکنندهٔ مورد انتظار — Opt-in.** ADR-053 § ۱۳ از `rasta_audit_records_ingested_total` می‌خواهد «ساکت شدن یک
سرویس» را نشان دهد. هیچ سندی نمی‌گوید کدام سرویس باید پیوسته رویداد حسابرسی بفرستد یا چه سکوتی مشروع است
([`24-open-questions.md`](24-open-questions.md) Q-54)، پس این هشدار فقط برای تولیدکننده‌ای کار می‌کند که صریحاً پیکربندی شده است:

- **برچسب `source_service` کراندار است.** پیش از این تغییر، Label مستقیماً `envelope.producer` بود — رشته‌ای که تولیدکننده می‌نویسد
  و فقط طولش (۱۲۸) محدود است — پس هر رشتهٔ تازه یک Series تازه می‌ساخت و ادعای «کراندار» درست نبود. اکنون
  `services/audit-service/src/audit/audit-producer-topology.ts` تنها منبع توپولوژی است: ده Topic مسیر A با مالک دقیق
  (`rasta.identity.v1`→`identity-service`، `rasta.organization.v1`→`organization-service`، `rasta.asset.v1` و
  `rasta.insurance.v1`→`asset-service`، `rasta.fleet.v1`→`fleet-service`، `rasta.maintenance.v1`→`maintenance-service`،
  `rasta.marketplace.v1`→`marketplace-service`، `rasta.economic.v1`→`economic-service`، `rasta.document.v1`→`document-service`،
  `rasta.supplier.v1`→`supplier-service`) و تولیدکنندگان مسیر B (امروز فقط `identity-service`). `DOMAIN_TOPICS`، مجموعهٔ مجاز
  پیکربندی و Seriesهای صفر از همین فهرست مشتق می‌شوند. مسیر A نام مالک را فقط وقتی `producer` با مالکِ **Topic تحویل** یکی باشد
  برچسب می‌زند؛ مسیر B فقط برای تولیدکنندهٔ شناخته‌شدهٔ Trail؛ هر چیز دیگر (نام دلخواه، بلند، نام معتبر روی Topic دیگر) زیر
  `unknown`. `source_service` حداکثر ۱۰ مقدار دارد (۹ سرویس + `unknown`)، `source_topic` ۱۱ و `outcome` سه. **ردیف ذخیره‌شده
  تغییری نمی‌کند:** `source_service` در `audit_event` همان ادعای تولیدکننده (با همان حد ۱۲۸) است؛ این سخت‌سازی Label است، نه
  سانسور شواهد.
- **پیکربندی:** `AUDIT_EXPECTED_ACTIVE_PRODUCERS` (CSV، در `.env.example`). پیش‌فرض **خالی** است، یعنی هیچ هشداری فعال نیست.
  ورودی‌ها Trim و Deduplicate می‌شوند؛ نام ناشناخته (از جمله `unknown` و حروف بزرگ دیگر) و عنصر خالی (`a,,b`، ویرگول انتهایی)
  راه‌اندازی را متوقف می‌کنند و پیام خطا فقط شمارهٔ عنصر و مجموعهٔ مجاز را می‌گوید، نه متن ردشده. نتیجه آرایهٔ Frozen است.
- **Exposition:** پس از اعتبارسنجی پیکربندی و پیش از شروع هر دو Consumer، `AppModule.onModuleInit` تابع
  `initializeExpectedProducerSeries` را صدا می‌زند: `rasta_audit_expected_active_producer{source_service} 1` فقط برای سرویس‌های
  پیکربندی‌شده (Gauge پیش از آن Reset می‌شود تا دقیقاً همان مجموعه را بگوید)، و هر Tuple
  `rasta_audit_records_ingested_total{source_service,source_topic,outcome}` همان سرویس‌ها با `inc(labels, 0)` — هرگز رویداد
  ساختگی مثبت؛ تکرار آن شمارش واقعی را پاک نمی‌کند. با مجموعهٔ خالی هیچ‌کدام صادر نمی‌شود؛ با هر ۹ سرویس، ۹ Series اطلاعات و
  ۳۳ Tuple شمارنده (۱۱ Topic × ۳ Outcome). به `rasta_audit_records_ingested_total` هیچ Label تازه‌ای اضافه نشد.
- **هشدار** `RastaAuditProducerSilent` (`warning`، گروه `rasta-audit-evidence`، Labelها فقط `source_service` و `severity`):
  Gate فعلی **و** Gate شش ساعت پیش (`offset 6h`، درون Lookback پنج‌دقیقه‌ای) باید `1` باشند، و `unless` هر افزایش مثبت
  در `[6h]` جمع‌شده به‌ازای `source_service` روی همهٔ Topicها، Outcomeها و Instanceها. با `for: 30m` آستانهٔ مؤثر **۶ ساعت و ۳۰
  دقیقه بی هیچ ردیف** است. پنجره در قاعدهٔ checked-in ثابت است (Prometheus آن را از Runtime نمی‌خواند)؛ فقط مجموعهٔ مورد انتظار
  Runtime-configurable است. انتخاب عملیاتی محلی است، نه حقوقی یا کسب‌وکاری.
- **زمان‌بندی و Startup:** نخستین ارزیابی Pending ممکن ۶ ساعت پس از نخستین Scrapeی است که تولیدکننده را مورد انتظار دید و
  Firing ۳۰ دقیقه بعد، پس نخستین Scrape یا تولیدکنندهٔ تازه پیکربندی‌شده روی Rangeی که هنوز پنجره را نمی‌پوشاند نمی‌سوزد. پس از
  یک ردیف، شرط تا خروج آخرین نمونهٔ پیش از آن از پنجره (حدود ۶ ساعت) نادرست است و Pending را از نو آغاز می‌کند. `increase`
  Reset شمارنده در Restart را افزایش نمی‌شمارد (۷→۰ ساکت می‌ماند)، ولی ردیفی که پیش از نخستین Scrape پس از Restart نوشته شد
  (۷→۱) شمرده می‌شود. تولیدکنندهٔ پیکربندی‌شده بی هیچ Series شمارنده هم ساکت است و می‌سوزد. Instanceهای متعدد یک هشدار می‌دهند
  و اجتماع مجموعه‌های پیکربندی‌شدهٔ آن‌ها Gate است. اگر audit-service Scrape نشود Gate غایب است و این هشدار **ساکت** می‌ماند؛
  آن حالت را `RastaAuditServiceMetricsUnavailable` (پایین) اعلام می‌کند.
- **مرز:** این هشدار فقط نبودِ ردیف از تولیدکننده‌ای را ثابت می‌کند که صریحاً «ترافیک‌دار» اعلام شده؛ **نمی‌تواند** ثابت کند هر
  عملیات تغییر وضعیت رویدادی منتشر کرده است. Heartbeat تولیدکننده، تطبیق Gap حسابرسی، Alertmanager و داشبورد وجود ندارند.

**Lag و عمق DLQ از سمت Broker.** سرویس `kafka-exporter` در `docker-compose.yml` (`danielqsj/kafka-exporter:v1.9.0`، Profile
`observability`/`all`، متصل به `kafka:9094`، **بی Port میزبان**) را Job `kafka-exporter` در `prometheus.yml` از شبکهٔ Compose با
`scrape_interval: 30s` و `scrape_timeout: 25s` می‌خواند (پاسخ Exporter روی Broker محلی با صدها گروه آزمونی ۲ تا ۹ ثانیه طول کشید).
متریک‌ها و Labelهای واقعیِ خوانده‌شده از `/metrics` همین نسخه:

| متریک Exporter                         | Label                             | معنا                                                                             |
| -------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------- |
| `kafka_consumergroup_lag`              | `consumergroup, partition, topic` | جدیدترین Offset منهای Offset Commit‌شدهٔ گروه؛ **`-1`** برای Partition بی Commit |
| `kafka_consumergroup_lag_sum`          | `consumergroup, topic`            | جمع Lag همان Topic (ردیف‌های `-1` را کنار می‌گذارد)                              |
| `kafka_consumergroup_current_offset`   | `consumergroup, partition, topic` | Offset Commit‌شدهٔ گروه                                                          |
| `kafka_consumergroup_members`          | `consumergroup`                   | تعداد عضو زندهٔ گروه (`0` = هیچ مصرف‌کننده‌ای متصل نیست)                         |
| `kafka_topic_partition_current_offset` | `partition, topic`                | جدیدترین Offset Partition                                                        |
| `kafka_topic_partition_oldest_offset`  | `partition, topic`                | قدیمی‌ترین Offset نگه‌داشته‌شدهٔ Partition                                       |

- `RastaAuditConsumerLag` فقط دو گروه ثابت `audit-service.domain-projector` و `audit-service.trail` را می‌بیند، `-1` را پیش از
  جمع به صفر می‌برد (نامعلوم است، نه جلوتر)، به‌ازای `consumergroup, topic` جمع می‌زند و فقط وقتی Lag در **همهٔ** ارزیابی‌های
  ۵ دقیقه مثبت بماند می‌سوزد؛ عقب‌ماندگی گذرا که به صفر برگردد `for` را از نو آغاز می‌کند.
- Recording Rule `topic:kafka_topic_retained_records:sum` =
  `sum by (topic) (clamp_min(kafka_topic_partition_current_offset{topic="rasta.audit.v1.dlq"} - kafka_topic_partition_oldest_offset{topic="rasta.audit.v1.dlq"}, 0))`
  تعداد رکوردی است که Kafka هنوز در `rasta.audit.v1.dlq` **نگه می‌دارد**؛ فقط Label `topic` دارد. **این عدد «پیام حل‌نشده» نیست:**
  مخزن هیچ وضعیت Triage یا تأیید برای پیام DLQ ندارد و عدد فقط با حذف Segmentهای قدیمی به‌دست Retention (۳۰ روز برای این Topic)
  کم می‌شود. پس عمداً هشداری روی آن نیست؛ `RastaDeadLetterMessagePublished` برای هر نوشتن تازه در DLQ هشدار می‌دهد.
- **از دست رفتن متریک‌های خود `audit-service`.** همهٔ هشدارهای `rasta_audit_*` (شکست، تأخیر، واگرایی زنجیره، سکوت
  تولیدکننده) فقط روی نمونه‌های Scrape همین فرایند کار می‌کنند و بی آن‌ها بی‌صدا غیرفعال می‌شوند. پس `host.docker.internal:3115`
  از Job مشترک `rasta-services` (که پورت‌های ۳۰۰۰، ۳۱۰۱ و ۳۱۰۲ در آن مانده‌اند) به Job اختصاصی **`audit-service`** با همان
  `metrics_path: /metrics` و `environment: local` منتقل شد و فقط همان‌جا آمده است. نام Job هویت عملیاتی سرویس است: در Job مشترک
  تنها چیزی که audit-service را جدا می‌کرد نشانی `instance` بود که به استقرار بسته است. هشدار
  `RastaAuditServiceMetricsUnavailable` (`warning`، `for: 2m`، Label فقط `job` و `severity`) =
  `min by (job) (up{job="audit-service"}) == 0 or absent(up{job="audit-service"})`:
  - `up == 0`: Prometheus Target پیکربندی‌شده را دارد ولی Scrape شکست می‌خورد (فرایند خاموش، `/metrics` خطا، شبکه).
  - `absent`: هیچ Series `up{job="audit-service"}` نیست — Job در `prometheus.yml` نیست، بار نشده، یا Target برداشته شده (پس از
    نشانگر Staleness). همان تک Label `job` را می‌دهد.
  - **Replica:** `min by (job)` است، نه `max`: شکست Scrape **هر** Instance پیکربندی‌شده کافی است، چون شمارنده‌ها محلی فرایندند و
    بی آن Instance تاریخچهٔ جمع ناقص است، حتی اگر Instance دیگر سالم باشد. چند Instance همیشه **یک** هشدار می‌دهند.
  - **زمان‌بندی:** نخستین ارزیابی `up == 0` یا `absent` Pending است و درست ۲ دقیقه بعد Firing؛ یک Scrape موفق میانی تایمر را
    از نو آغاز می‌کند و قطع دوباره باز ۲ دقیقه می‌خواهد.
  - **مرز:** فقط از دست رفتن تله‌متری audit-service را ثابت می‌کند؛ نمی‌گوید هر عملیات تغییر وضعیت رویداد حسابرسی منتشر
    کرده است، و نبودنش نشانهٔ سلامت ingestion نیست.
- **از دست رفتن سیگنال.** `RastaAuditConsumerLag` فقط روی Seriesهای موجود کار می‌کند، پس نبودن ورودی دو هشدار جدا و مکمل دارد:
  - `RastaKafkaExporterUnavailable` (`for: 2m`، Label فقط `job`): Target `kafka-exporter` Scrape نمی‌شود (`up == 0`) یا اصلاً
    Series `up` ندارد (`absent`)؛ `min by (job)` Label `instance` را حذف می‌کند. در این حالت Lag و عمق DLQ نامعلوم‌اند.
  - `RastaAuditConsumerGroupMetricsMissing` (`for: 5m`، Label فقط `consumergroup`): Exporter سالم است ولی برای یکی از دو گروه
    ثابت هیچ Series `kafka_consumergroup_lag` نیست. Exporter برای گروه فقط Topicهایی را که دست‌کم یک Offset Commit‌شده دارند
    گزارش می‌کند، پس این یعنی Broker هیچ Offset Commit‌شده‌ای برای آن گروه ندارد — مثلاً Broker تازه پیش از اجرای
    `audit-service`. هر گروه با `absent` روی نام **دقیق** جدا سنجیده می‌شود تا Label `consumergroup` در نتیجه بماند؛ `-1`، صفر
    و مثبت «موجود»اند. با `and on () (min(up{job="kafka-exporter"}) == 1)` هنگام خرابی Exporter خاموش است تا یک خرابی دو
    تشخیص نگیرد. اقدام: اجرای/بررسی Consumer واقعی، **هرگز** Reset، Shift یا حذف Offset.
- **مرز:** Topicی که گروه موجود هیچ Offset در آن ندارد گزارش و هشدار نمی‌شود. Partitionی که گروه هرگز Commit نکرده (`-1`) Lag
  قابل اندازه‌گیری ندارد. هر ترکیب Label کراندارِ هشدارهای شمارنده پیش از نخستین رخداد با صفر صادر می‌شود (ماژول
  متریک `audit-service` و `identity-service` هنگام بار شدن، و هر `EventConsumer` دارای Topic DLQ هنگام ساخته شدن)، پس نخستین
  افزایش واقعی هم هشدار می‌دهد ([`runbooks/README.md`](runbooks/README.md#مقداردهی-صفر-هشدارهای-شمارنده)). باقی ردیف‌های دو
  جدول بالا هنوز قاعده ندارند.

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
