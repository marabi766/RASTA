# Runbookها

> **قاعده.** هر هشدار باید Runbook داشته باشد. هشدار بدون دستورالعمل پاسخ، نویز است و
> به‌مرور نادیده گرفته می‌شود.

## فهرست

| Runbook                                             | هشدار محرک                                                                                                                                                                                                                                                                                                                                                                                                                     | شدت        | وضعیت     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- | --------- |
| [ledger-imbalance](ledger-imbalance.md)             | Journal نامتوازن · انحراف کیف پول و دفتر کل                                                                                                                                                                                                                                                                                                                                                                                    | 🔴 بحرانی  | ✅ آماده  |
| [outbox-stuck](outbox-stuck.md)                     | `rasta_outbox_pending_age_seconds > 60`                                                                                                                                                                                                                                                                                                                                                                                        | 🟠 هشدار   | ✅ آماده  |
| [replay-dlq](replay-dlq.md)                         | `RastaDeadLetterMessagePublished` — افزایش `rasta_dlq_messages_total`                                                                                                                                                                                                                                                                                                                                                          | 🟠 هشدار   | ✅ آماده  |
| [audit-chain-divergence](audit-chain-divergence.md) | `RastaAuditChainDivergence` — افزایش `rasta_audit_chain_verification_failures_total`                                                                                                                                                                                                                                                                                                                                           | 🔴 بحرانی  | ✅ آماده  |
| [database-bootstrap](database-bootstrap.md)         | راه‌اندازی محیط جدید                                                                                                                                                                                                                                                                                                                                                                                                           | ⚪ عملیاتی | ✅ آماده  |
| [malware-scanner-down](malware-scanner-down.md)     | `rasta_document_scanner_up == 0` · امضای کهنه                                                                                                                                                                                                                                                                                                                                                                                  | 🟠 هشدار   | ✅ آماده  |
| [outbox-b2-backfill](outbox-b2-backfill.md)         | ندارد — با دستور صریح اپراتور                                                                                                                                                                                                                                                                                                                                                                                                  | ⚪ عملیاتی | ✅ آماده  |
| [security-event-outbox](security-event-outbox.md)   | `RastaSecurityEventCaptureGap` · `RastaSecurityEventClosedBacklogStale` (`closed_backlog_age_seconds > 60`) · `RastaSecurityEventPublishFailure`                                                                                                                                                                                                                                                                               | 🔴/🟠      | ✅ آماده  |
| [audit-gap-detected](audit-gap-detected.md)         | `RastaAuditIngestionFailure` · `RastaSecurityEventCaptureGap` · `RastaAuditProducerSilent` (تولیدکنندهٔ پیکربندی‌شده در `AUDIT_EXPECTED_ACTIVE_PRODUCERS` ۶ ساعت و ۳۰ دقیقه بی ردیف) · `RastaAuditServiceMetricsUnavailable` (Job اختصاصی `audit-service` دو دقیقه Scrape نمی‌شود یا نیست)؛ پیام در `rasta.audit.v1.dlq` فقط هشدار عمومی `RastaDeadLetterMessagePublished` را دارد؛ رکورد غایب هشدار ندارد                     | 🔴 بحرانی  | ✅ آماده  |
| [audit-ingestion-lag](audit-ingestion-lag.md)       | `RastaAuditConsumerLag` — Lag مثبت پنج دقیقهٔ پیوسته در `audit-service.domain-projector` یا `audit-service.trail` · `RastaKafkaExporterUnavailable` (Exporter دو دقیقه در دسترس نیست) · `RastaAuditConsumerGroupMetricsMissing` (Exporter سالم، گروه پنج دقیقه بی Series) · `RastaAuditIngestionLagHigh` (p95 تأخیر ردیف نوشته‌شده پنج دقیقه > ۶۰ ثانیه)؛ عمق نگه‌داشتهٔ `rasta.audit.v1.dlq` فقط Recording Rule است، بی هشدار | 🟠 هشدار   | ✅ آماده  |
| [failed-settlement](failed-settlement.md)           | Workflow شکست‌خورده در `rasta-settlement`                                                                                                                                                                                                                                                                                                                                                                                      | 🔴 بحرانی  | 📅 روز ۲۷ |
| [restore-database](restore-database.md)             | از دست رفتن داده                                                                                                                                                                                                                                                                                                                                                                                                               | 🔴 بحرانی  | 📅 روز ۲۷ |
| [disaster-recovery](disaster-recovery.md)           | از دست رفتن منطقه                                                                                                                                                                                                                                                                                                                                                                                                              | 🔴 بحرانی  | 📅 روز ۲۷ |
| [secret-leak](secret-leak.md)                       | اسکن Secret یافته پیدا کرد                                                                                                                                                                                                                                                                                                                                                                                                     | 🔴 بحرانی  | 📅 روز ۲۳ |
| [rollback-deployment](rollback-deployment.md)       | شکست Smoke Test پس از استقرار                                                                                                                                                                                                                                                                                                                                                                                                  | 🟠 هشدار   | 📅 روز ۲۸ |

**📅 = برنامه‌ریزی‌شده، هنوز نوشته نشده.** این وضعیت صادقانه ثبت شده تا کسی روی
Runbook ناموجود حساب نکند. تاریخ‌ها از [`../20-day-30-plan.md`](../20-day-30-plan.md).

## قواعد هشدار موجود در مخزن

نام‌های `Rasta…` بالا دوازده هشدار
[`infrastructure/docker/prometheus/rules/rasta-audit-alerts.yml`](../../infrastructure/docker/prometheus/rules/rasta-audit-alerts.yml)
هستند — **تنها قواعد هشدار مخزن** — و همان فایل یک Recording Rule هم دارد (`topic:kafka_topic_retained_records:sum`). باقی ستون
«هشدار محرک» شرط مستند است، نه قاعدهٔ نوشته‌شده. رفتار این سیزده قاعده با
`promtool test rules` روی `infrastructure/docker/prometheus/tests/rasta-audit-alerts.test.yml` در Job `prometheus-rules` CI
اثبات می‌شود ([`../14-testing-strategy.md`](../14-testing-strategy.md) § ۱۴٫۱۱).

- **فقط محلی.** Prometheus سرویس `prometheus` در `docker-compose.yml` (Profile `observability`) آن‌ها را ارزیابی می‌کند و در
  `http://localhost:9090/alerts` دیده می‌شوند. **مخزن Alertmanager ندارد، پس هیچ اعلانی به هیچ‌کس تحویل نمی‌شود.** Scrape و
  مسیریابی اعلانِ محیط واقعی وابسته به استقرار است و در مخزن نیست. داشبورد، ابزار بازپخش DLQ و تشخیص رکورد حسابرسیِ غایب هم
  نیستند.
- **Kafka از سمت Broker.** `kafka-exporter` (`danielqsj/kafka-exporter:v1.9.0`، Profile `observability`/`all`، بی Port میزبان)
  را Job `kafka-exporter` هر ۳۰ ثانیه از شبکهٔ Compose می‌خواند. `RastaAuditConsumerLag` فقط دو گروه ثابت `audit-service.*` را با
  `for: 5m` می‌پاید ([audit-ingestion-lag](audit-ingestion-lag.md)). `topic:kafka_topic_retained_records:sum{topic="rasta.audit.v1.dlq"}`
  رکوردهای **نگه‌داشته** در آن Topic است، نه پیام حل‌نشده — مخزن وضعیت Triage برای پیام DLQ ندارد و فقط Retention آن را کم
  می‌کند — پس عمداً هشداری روی آن نیست؛ `RastaDeadLetterMessagePublished` هر نوشتن تازه را اعلام می‌کند. Lag گروه‌های دیگر و
  عمق Topicهای DLQ دیگر قاعده ندارند.
- **از دست رفتن متریک‌های `audit-service` صریح است.** Target `host.docker.internal:3115` اکنون فقط در Job اختصاصی
  `audit-service` است (نه `rasta-services`). `RastaAuditServiceMetricsUnavailable` (`for: 2m`) = `min by (job) (up{job="audit-service"}) == 0 or absent(up{job="audit-service"})`؛
  `min by (job)` یعنی شکست Scrape **هر** Replica کافی است و چند Replica یک هشدار با فقط `job`/`severity` می‌دهند. تا وقتی
  می‌سوزد، سکوت هشدارهای شکست، تأخیر، واگرایی و سکوت تولیدکننده هیچ معنایی ندارد ([audit-gap-detected](audit-gap-detected.md) § ۸).
- **از دست رفتن سیگنال Kafka صریح است.** `RastaKafkaExporterUnavailable` (`for: 2m`) وقتی
  `min by (job) (up{job="kafka-exporter"}) == 0 or absent(up{job="kafka-exporter"})` است، یعنی Exporter Scrape نمی‌شود یا Target
  اصلاً وجود ندارد. `RastaAuditConsumerGroupMetricsMissing` (`for: 5m`) فقط **وقتی Exporter سالم است** (`min(up{job="kafka-exporter"}) == 1`)
  برای هر گروه ثابتی که هیچ Series `kafka_consumergroup_lag` ندارد (با `absent` روی نام **دقیق** گروه) می‌سوزد — یعنی Broker
  هیچ Offset Commit‌شده‌ای برای آن گروه گزارش نمی‌کند، مثلاً روی Broker تازه پیش از اجرای `audit-service`. این دو هم‌زمان
  نمی‌سوزند. هیچ‌کدام مجوز Reset/Shift/حذف Offset نیست ([audit-ingestion-lag](audit-ingestion-lag.md) § ۵).
- **تأخیر شواهد نوشته‌شده، از سمت سرویس.** `RastaAuditIngestionLagHigh` (`for: 5m`) =
  `histogram_quantile(0.95, sum by (le, source_topic) (rate(rasta_audit_ingestion_lag_seconds_bucket[5m]))) > 60` — ADR-053 § ۱۳.
  `rasta_audit_ingestion_lag_seconds` یک Histogram با مرزهای `1, 5, 15, 30, 60, 120, 300, 900, 3600` و `+Inf` است که هر دو
  مصرف‌کنندهٔ `audit-service` فقط برای ردیف **نوشته‌شده** (`WRITTEN`) Observe می‌کنند؛ Bucketها پیش از Quantile روی همهٔ Instanceها
  جمع می‌شوند. این فاصلهٔ `occurredAt` تا نوشتن است، نه Offset Lag: مصرف‌کنندهٔ متوقف چیزی Observe نمی‌کند و این هشدار ساکت
  می‌ماند، و آن حالت را سه هشدار Kafka بالا می‌بینند.
- **سکوت تولیدکنندهٔ مورد انتظار — Opt-in.** `RastaAuditProducerSilent` (`for: 30m`) =
  `(max by (source_service) (rasta_audit_expected_active_producer == 1) and on (source_service) max by (source_service) (rasta_audit_expected_active_producer offset 6h == 1)) unless on (source_service) (sum by (source_service) (increase(rasta_audit_records_ingested_total[6h])) > 0)`.
  Gate را `audit-service` فقط برای سرویس‌های `AUDIT_EXPECTED_ACTIVE_PRODUCERS` صادر می‌کند و پیش‌فرض خالی است، پس بی پیکربندی صریح
  هیچ‌چیز پاییده نمی‌شود (Q-54). آستانهٔ مؤثر ۶ ساعت و ۳۰ دقیقه بی ردیف است و نخستین Firing ممکن ۶ ساعت و ۳۰ دقیقه پس از نخستین
  Scrapeی است که Gate را دید. فقط نبودِ ردیف از تولیدکنندهٔ اعلام‌شده را ثابت می‌کند، نه اینکه هر عملیات رویدادی منتشر کرده است
  ([audit-gap-detected](audit-gap-detected.md)). `source_service` از توپولوژی بسته مشتق است (۹ سرویس + `unknown`)، نه از
  `envelope.producer`.
- **Label.** هر هشدار شمارنده با `sum by` فقط Labelهای کراندار خود متریک را نگه می‌دارد (هشدار Lag فقط `consumergroup, topic`،
  هشدار Exporter فقط `job`، هشدار گروه غایب فقط `consumergroup`، هشدار p95 فقط `source_topic`، هشدار سکوت فقط `source_service`، هشدار متریک audit-service فقط `job` و Recording Rule فقط `topic`)؛ هیچ Label یا Annotation شناسهٔ
  مستأجر، Actor، منبع، رویداد، Correlation، Partition، Offset یا متن خطا ندارد.

### مقداردهی صفر هشدارهای شمارنده

هشدارهای شمارنده `increase(…[5m]) > 0` بی `for` هستند. `prom-client` یک Series برچسب‌دار را فقط وقتی مقدار دارد صادر
می‌کند، و Seriesی که با ۱ متولد شود نمونهٔ پیشینی برای `increase` ندارد. پس **هر ترکیب Label کرانداری که هشداری را می‌راند،
پیش از نخستین رخداد واقعی با مقدار صفر صادر می‌شود** و نخستین افزایش واقعی دیده می‌شود و هشدار می‌دهد:

- `audit-service` هنگام بار شدن ماژول متریک (`initializeAuditAlertSeries`): هر مقدار `INGESTION_FAILURE_REASONS` برای
  `rasta_audit_ingestion_failures_total{reason}` و ۶ × ۲ ترکیب `DIVERGENCE_REASON_VALUES` × `organization|platform` برای
  `rasta_audit_chain_verification_failures_total{reason,scope}`.
- `identity-service` هنگام بار شدن ماژول متریک (`initializeSecurityEventAlertSeries`): فقط `outcome="failed"` و
  `"timeout"` از `rasta_security_event_captures_total` (`recorded`/`skipped` هشداری نمی‌رانند) و هر دو `reason` از
  `rasta_security_event_publish_failures_total`.
- `EventConsumer` مشترک هنگام ساخته شدن و **فقط اگر `deadLetterTopic` دارد**: `clientId` × هر Topic مبدأ مشترک‌شده × هر پنج
  `DlqReason` برای `rasta_dlq_messages_total`؛ بی اتصال به Kafka، و هرگز با Topic DLQ به‌عنوان `topic`.
- `audit-service` هنگام بار شدن ماژول متریک (`initializeIngestionLagSeries`): Histogram
  `rasta_audit_ingestion_lag_seconds` برای هر ۱۱ `source_topic` (ده `DOMAIN_TOPICS` و `AUDIT_TRAIL_TOPIC`، مشتق از همان ثابت‌ها)
  با `zero()` — همهٔ `_bucket`، `_sum` و `_count` صفر، **بی هیچ مشاهدهٔ ساختگی** که p95 را پایین بکشد. برخلاف `inc(labels, 0)`،
  `zero()` Series موجود را جایگزین می‌کند؛ پس فقط یک‌بار و پیش از هر مشاهده اجرا می‌شود.
- `audit-service` در `AppModule.onModuleInit`، **پس از** اعتبارسنجی پیکربندی و پیش از شروع Consumerها
  (`initializeExpectedProducerSeries`): فقط برای سرویس‌های `AUDIT_EXPECTED_ACTIVE_PRODUCERS`، Gate
  `rasta_audit_expected_active_producer{source_service} 1` و هر Tuple `rasta_audit_records_ingested_total{source_service,source_topic,outcome}`
  آن سرویس (Topicهای مالکش و در صورت تولیدکنندهٔ Trail بودن `rasta.audit.trail.v1`، × سه Outcome) با `inc(labels, 0)`. با مجموعهٔ
  خالی هیچ‌کدام صادر نمی‌شود.

مقداردهی با `inc(labels, 0)` است: صفر اضافه می‌کند، پس شمارش واقعیِ موجود را هرگز پاک نمی‌کند، و محل افزایش‌های واقعی
(پس از خودِ عمل) عوض نشده است. آزمون‌های واحد Exposition واقعی `/metrics` را می‌خوانند و `promtool` گذار صفر → ۱ را اثبات
می‌کند. مقدار صفر یعنی «از شروع این فرایند رخدادی شمرده نشده»، نه «سالم»؛ و شمارنده با Restart فرایند از صفر آغاز می‌شود. **مرز باقی:** صفر فقط وقتی کار می‌کند که دست‌کم یک Scrape آن را پیش از رخداد ببیند؛ رخدادی که میان شروع فرایند و نخستین Scrape (بازهٔ ۱۵ ثانیه‌ای محلی) رخ دهد، همچنان نمونهٔ اولِ Series را ۱ می‌کند و هشدار نمی‌دهد.

## قالب

```markdown
# Runbook: <عنوان>

**شدت:** 🔴 بحرانی | 🟠 هشدار | ⚪ عملیاتی
**هشدار محرک:** <نام متریک یا شرط>
**زمان پاسخ هدف:** <دقیقه>

## علائم

چه چیزی دیده می‌شود

## اثر

چه چیزی برای کاربر خراب است

## تشخیص فوری

دستورهای قابل کپی برای فهمیدن وضعیت

## اقدام

گام‌به‌گام، با دستور دقیق

## تأیید رفع

چطور مطمئن شویم حل شده

## پیشگیری

چه چیزی باید عوض شود تا تکرار نشود
```

## اصول پاسخ به حادثه

1. **اول وسعت را بفهم، بعد اقدام کن.** یک اقدام عجولانه می‌تواند وضعیت را بدتر کند.
2. **در مسائل مالی، توقف بهتر از حدس است.** اگر یکپارچگی دفتر کل مشکوک است،
   پرداخت را متوقف کن و بررسی کن — هرگز «احتمالاً درست است» را نپذیر.
3. **هرگز داده مالی را دستی اصلاح نکن.** اصلاح فقط با Reversal Entry از راه API.
4. **همه‌چیز را ثبت کن.** `correlationId`، زمان، اقدام، نتیجه.
5. **پس از رفع، علت ریشه‌ای را بنویس** و به Backlog اضافه کن.
