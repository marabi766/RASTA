# Runbookها

> **قاعده.** هر هشدار باید Runbook داشته باشد. هشدار بدون دستورالعمل پاسخ، نویز است و
> به‌مرور نادیده گرفته می‌شود.

## فهرست

| Runbook                                             | هشدار محرک                                                                                                                                                                    | شدت        | وضعیت     |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------- |
| [ledger-imbalance](ledger-imbalance.md)             | Journal نامتوازن · انحراف کیف پول و دفتر کل                                                                                                                                   | 🔴 بحرانی  | ✅ آماده  |
| [outbox-stuck](outbox-stuck.md)                     | `rasta_outbox_pending_age_seconds > 60`                                                                                                                                       | 🟠 هشدار   | ✅ آماده  |
| [replay-dlq](replay-dlq.md)                         | `RastaDeadLetterMessagePublished` — افزایش `rasta_dlq_messages_total`                                                                                                         | 🟠 هشدار   | ✅ آماده  |
| [audit-chain-divergence](audit-chain-divergence.md) | `RastaAuditChainDivergence` — افزایش `rasta_audit_chain_verification_failures_total`                                                                                          | 🔴 بحرانی  | ✅ آماده  |
| [database-bootstrap](database-bootstrap.md)         | راه‌اندازی محیط جدید                                                                                                                                                          | ⚪ عملیاتی | ✅ آماده  |
| [malware-scanner-down](malware-scanner-down.md)     | `rasta_document_scanner_up == 0` · امضای کهنه                                                                                                                                 | 🟠 هشدار   | ✅ آماده  |
| [outbox-b2-backfill](outbox-b2-backfill.md)         | ندارد — با دستور صریح اپراتور                                                                                                                                                 | ⚪ عملیاتی | ✅ آماده  |
| [security-event-outbox](security-event-outbox.md)   | `RastaSecurityEventCaptureGap` · `RastaSecurityEventClosedBacklogStale` (`closed_backlog_age_seconds > 60`) · `RastaSecurityEventPublishFailure`                              | 🔴/🟠      | ✅ آماده  |
| [audit-gap-detected](audit-gap-detected.md)         | `RastaAuditIngestionFailure` · `RastaSecurityEventCaptureGap`؛ پیام در `rasta.audit.v1.dlq` فقط هشدار عمومی `RastaDeadLetterMessagePublished` را دارد؛ رکورد غایب هشدار ندارد | 🔴 بحرانی  | ✅ آماده  |
| [failed-settlement](failed-settlement.md)           | Workflow شکست‌خورده در `rasta-settlement`                                                                                                                                     | 🔴 بحرانی  | 📅 روز ۲۷ |
| [restore-database](restore-database.md)             | از دست رفتن داده                                                                                                                                                              | 🔴 بحرانی  | 📅 روز ۲۷ |
| [disaster-recovery](disaster-recovery.md)           | از دست رفتن منطقه                                                                                                                                                             | 🔴 بحرانی  | 📅 روز ۲۷ |
| [secret-leak](secret-leak.md)                       | اسکن Secret یافته پیدا کرد                                                                                                                                                    | 🔴 بحرانی  | 📅 روز ۲۳ |
| [rollback-deployment](rollback-deployment.md)       | شکست Smoke Test پس از استقرار                                                                                                                                                 | 🟠 هشدار   | 📅 روز ۲۸ |

**📅 = برنامه‌ریزی‌شده، هنوز نوشته نشده.** این وضعیت صادقانه ثبت شده تا کسی روی
Runbook ناموجود حساب نکند. تاریخ‌ها از [`../20-day-30-plan.md`](../20-day-30-plan.md).

## قواعد هشدار موجود در مخزن

نام‌های `Rasta…` بالا شش هشدار
[`infrastructure/docker/prometheus/rules/rasta-audit-alerts.yml`](../../infrastructure/docker/prometheus/rules/rasta-audit-alerts.yml)
هستند — **تنها قواعد هشدار مخزن**. باقی ستون «هشدار محرک» شرط مستند است، نه قاعدهٔ نوشته‌شده. رفتار این شش قاعده با
`promtool test rules` روی `infrastructure/docker/prometheus/tests/rasta-audit-alerts.test.yml` در Job `prometheus-rules` CI
اثبات می‌شود ([`../14-testing-strategy.md`](../14-testing-strategy.md) § ۱۴٫۱۱).

- **فقط محلی.** Prometheus سرویس `prometheus` در `docker-compose.yml` (Profile `observability`) آن‌ها را ارزیابی می‌کند و در
  `http://localhost:9090/alerts` دیده می‌شوند. **مخزن Alertmanager ندارد، پس هیچ اعلانی به هیچ‌کس تحویل نمی‌شود.** Scrape و
  مسیریابی اعلانِ محیط واقعی وابسته به استقرار است و در مخزن نیست. داشبورد، هشدار Lag کافکا یا عمق Topic DLQ، ابزار بازپخش
  DLQ و تشخیص رکورد حسابرسیِ غایب هم نیستند.
- **Label.** هر هشدار شمارنده با `sum by` فقط Labelهای کراندار خود متریک را نگه می‌دارد؛ هیچ Label یا Annotation شناسهٔ
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
