# Runbook: شکاف شواهد حسابرسی (رکوردی که باید در `audit_event` باشد و نیست)

**شدت:** 🔴 بحرانی اگر شکاف تأیید شود · 🟠 هشدار تا وقتی مشکوک است
**هشدار محرک:** `RastaAuditIngestionFailure` (🟠 `warning`، افزایش `rasta_audit_ingestion_failures_total{reason}`) و
`RastaSecurityEventCaptureGap` (🔴 `critical`، افزایش `rasta_security_event_captures_total{outcome=~"failed|timeout"}` — مسیرش
[security-event-outbox](security-event-outbox.md)) در `infrastructure/docker/prometheus/rules/rasta-audit-alerts.yml`، فقط در
Prometheus **محلی** و **بی Alertmanager، پس بی تحویل اعلان**. پیام در `rasta.audit.v1.dlq` فقط هشدار عمومی
`RastaDeadLetterMessagePublished` (`service` = `KAFKA_CLIENT_ID` مصرف‌کنندهٔ `audit-service`) را دارد، نه هشدار اختصاصی حسابرسی. Lag پایدارِ دو گروه `audit-service.*` هشدار
`RastaAuditConsumerLag` را دارد ([audit-ingestion-lag](audit-ingestion-lag.md))، و عمق نگه‌داشتهٔ `rasta.audit.v1.dlq` فقط
Recording Rule `topic:kafka_topic_retained_records:sum` است، بی هشدار. **رکوردِ غایب خودش هیچ هشداری ندارد:** تشخیص رکورد
گمشده، Scrape محیط واقعی و داشبورد در مخزن نیستند؛ پس این Runbook همچنان با یکی از علائم پایین، یا با گزارش
انسانی («این عمل/رد در حسابرسی دیده نمی‌شود») هم شروع می‌شود.
**زمان پاسخ هدف:** ۳۰ دقیقه برای دسته‌بندی؛ ۱۵ دقیقه اگر رویداد مالی یا رد امنیتی در کار است

---

> **این Runbook فقط قابلیت‌هایی را به کار می‌گیرد که امروز در مخزن هست** — ADR-053 و
> [برنامهٔ پیاده‌سازی](../adr/ADR-053-implementation-plan.md) § ۴–۷. هر فرمانی که به نام محیط، Namespace، Credential یا ابزار
> استقرار وابسته است، **نیت فقط‌خواندنی** را نشان می‌دهد؛ اپراتور باید هدف تأییدشدهٔ خودش را جایگزین کند. شکل‌های
> `docker compose` پایین فقط برای Stack محلی همین مخزن تأیید شده‌اند.

---

## ۰. کدام Runbook؟

| آنچه می‌بینی                                                                                                                                                                 | Runbook                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| رکوردی که **ثبت شده** ولی با زنجیره‌اش نمی‌خواند: `GET /v1/audit-events/verify` پاسخ `DIVERGENT` می‌دهد                                                                      | [audit-chain-divergence](audit-chain-divergence.md)   |
| رد امنیتی identity: `rasta_security_event_outbox_closed_backlog_age_seconds` بالا، یا `rasta_security_event_captures_total{outcome=~"failed\|timeout"}` یا خطای انتشار آن صف | [security-event-outbox](security-event-outbox.md)     |
| `outbox_message` یک سرویس (از جمله فرمان اصلاح identity) منتشر نمی‌شود: `rasta_outbox_pending_age_seconds{service}` بالا                                                     | [outbox-stuck](outbox-stuck.md)                       |
| رکوردی که **باید باشد و نیست**، یا پیامی در `rasta.audit.v1.dlq`                                                                                                             | **همین Runbook** — و در صورت نیاز یکی از سه ردیف بالا |

**شکاف ≠ واگرایی.** واگرایی یعنی شواهدِ ثبت‌شده تغییر کرده یا زنجیره‌اش ناسازگار است؛ شکاف یعنی شاهدی هرگز به انبار نرسیده.
زنجیره فقط رکوردهای ثبت‌شده را پیوند می‌دهد، پس **پیامی که هرگز مصرف نشده، `verify` را خراب نمی‌کند** و `VALID` هیچ‌چیز
دربارهٔ کامل بودن نمی‌گوید. اگر در میانهٔ این Runbook `verify` واگرایی نشان داد، همان‌جا متوقف شو و به
[audit-chain-divergence](audit-chain-divergence.md) برو. **واگرایی هرگز خودبه‌خود ترمیم نمی‌شود** و نباید بشود.

---

## آنچه امروز واقعاً وجود دارد

**دو مسیر نوشتن، هر دو فقط از Kafka.** `audit-service` هیچ API نوشتنی ندارد (`POST /v1/audit-events` پاسخ `404` می‌گیرد) و
خودش فرمان اصلاح نمی‌پذیرد.

| مسیر | گروه مصرف‌کننده (ثابت)           | Topic                                                                                                                                                                               | رفتار                                                                                     |
| ---- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| A    | `audit-service.domain-projector` | ده Topic دامنه‌ای: `rasta.{identity,organization,asset,insurance,fleet,maintenance,marketplace,economic,document,supplier}.v1` (`services/audit-service/src/audit/audit.mapper.ts`) | **کل**: هر Envelope معتبر یک ردیف می‌شود                                                  |
| B    | `audit-service.trail`            | `rasta.audit.trail.v1`                                                                                                                                                              | **اعتبارسنج**: پیام ناسازگار با قرارداد `AUDIT_EVENT_RECORDED` v1 **رد** می‌شود، نه اصلاح |

- **Idempotency:** هر ردیف و نشانگر `processed_event` با کلید `(event_id, consumer_name)` در **یک تراکنش** نوشته می‌شوند؛ پیام
  ردشده یا شکست پایگاه داده **نه ردیف می‌سازد نه نشانگر**. تحویل دوباره یا بازخوانی، ردیف تکراری نمی‌سازد.
- **DLQ مشترک هر دو مسیر:** `rasta.audit.v1.dlq`. پیام بدشکل بی‌درنگ (`x-dlq-reason = VALIDATION_FAILED`، `x-dlq-attempts = 0`)
  و پیامی که Handler پس از همهٔ تلاش‌ها رد کرد (`MAX_RETRIES_EXCEEDED`) با **بایت‌های اصلی** و Headerهای
  `x-dlq-original-topic`، `x-dlq-error`، `x-dlq-first-failed-at` به آنجا می‌رود.
- **تنها Producer مسیر B امروز `identity-service` است:**
  - **ردها** — نُه محل رد (AUD-004 C1–C10) از `security_event_outbox` محلی، **تجمیع‌شده در پنجرهٔ**
    `SECURITY_EVENT_AGGREGATION_WINDOW_SECONDS` (پیش‌فرض ۶۰، بازهٔ ۱..۳۶۰۰). هر ردیف فقط **پس از بسته‌شدن پنجره‌اش** منتشر
    می‌شود؛ `eventId` همان `security_event_outbox.id` است.
  - **اصلاح** — `POST /v1/audit-corrections` از `outbox_message` **استاندارد** identity؛ `eventId` در
    `audit_correction_command.event_id` و پاسخ `202` فرمان هست. `202` یعنی «پذیرفته برای ثبت»، نه «خواندنی».
- **آنچه اصلاً ثبت نمی‌شود — این‌ها شکاف حادثه نیستند، محدودیت‌اند:** ردهای سرویس‌های دیگر (R-2)، ردهایی که Gateway پیش از
  رسیدن به سرویس می‌گیرد، ردهای Token سرویس، `401`ها، هر `403` بیرون از نُه محل، و هر تغییر وضعیتی که سرویسش رویدادی روی یکی
  از ده Topic بالا منتشر نمی‌کند (`construction` و `contract` امروز Producer ندارند؛ R-1).

---

## علائم

- یک عمل دامنه‌ای یا یک `403` از نُه محل رد رخ داده و پس از **پنجرهٔ تجمیع + تأخیر Relay + تأخیر مصرف** هنوز در جست‌وجوی
  حسابرسی دیده نمی‌شود.
- `GET /health/ready` روی `audit-service` پاسخ `503` می‌دهد و در `checks` یکی از `database`، `projector` یا `trail` برابر
  `false` است.
- Lag گروه `audit-service.domain-projector` یا `audit-service.trail` رشد می‌کند، یا `RastaAuditConsumerLag` می‌سوزد (Lag پنج
  دقیقهٔ پیوسته بالای صفر — [audit-ingestion-lag](audit-ingestion-lag.md)).
- پیام تازه در `rasta.audit.v1.dlq`.
- در Log `audit-service`: مسیر B `Rejected <EVENT> <eventId> from <topic>[<partition>]: …`؛ مسیر A
  `Cannot map <EVENT> <eventId> from <topic> …` یا `Cannot project … into the organization hierarchy …`؛ و از
  `EventConsumer` مشترک `Unparseable message on …`، `Handler failed <N>x for …` یا `Attempt <i>/<N> failed for …`.
- در Log `identity-service`: `Refusal audit capture did not complete` (رد پاسخ `403` درست گرفته ولی شاهدش ثبت نشده).

> **درباره متریک‌ها — صادقانه.** `audit-service` متریک‌های `rasta_audit_ingestion_failures_total{reason}`،
> `rasta_audit_ingestion_lag_seconds{source_topic}` و `rasta_audit_records_ingested_total{source_service,source_topic,outcome}` را
> در فرایند ثبت می‌کند و از **`GET /metrics`** همان سرویس (پورت پیش‌فرض `3115`، `@Public`، بیرون از قرارداد OpenAPI، بی هیچ
> شناسهٔ مستأجر/Actor/منبع/رویداد/Correlation در Label) صادر می‌کند. `host.docker.internal:3115` در Job `rasta-services`
> فایل **محلی** `infrastructure/docker/prometheus/prometheus.yml` هست؛ پیکربندی Scrape محیط واقعی وابسته به استقرار است و
> در مخزن نیست. Prometheus محلی روی این متریک‌ها فقط `RastaAuditIngestionFailure` را ارزیابی می‌کند (و روی متریک‌های مجاور
> `RastaSecurityEventCaptureGap`، `RastaDeadLetterMessagePublished` و دو هشدار دیگر صف ردها)؛ از سمت Broker، `kafka-exporter` Lag دو گروه `audit-service.*` را
> برای `RastaAuditConsumerLag` و عمق نگه‌داشتهٔ `rasta.audit.v1.dlq` را برای Recording Rule `topic:kafka_topic_retained_records:sum`
> فراهم می‌کند؛ **Alertmanager، داشبورد، هشدار روی عمق DLQ و تشخیص رکورد گمشده در مخزن نیست**. Seriesهای هشدار از شروع فرایند با صفر صادر می‌شوند، پس نخستین
> شکست هم هشدار می‌دهد ([README](README.md#مقداردهی-صفر-هشدارهای-شمارنده))؛ ولی رکوردی که هرگز نرسیده شکستی نمی‌شمارد، پس
> نبودن هشدار را نشانهٔ سلامت نگیر: شواهد همچنان از خواندن مستقیم
> `/metrics` (یا Prometheus محلی)، Readiness، Log، Lag کافکا، DLQ و API جست‌وجوست. همچنین
> `EventConsumer` مشترک `rasta_dlq_messages_total{service,topic,reason}` را **فقط پس از موفقیت `send` به Topic DLQ** یک
> واحد افزایش می‌دهد (`service` = `clientId` مصرف‌کننده، `topic` = Topic مبدأ، `reason` = `VALIDATION_FAILED` یا
> `MAX_RETRIES_EXCEEDED`)؛ تلاش مجدد، `send` ردشده و پیامِ Drop‌شده بی Topic DLQ شمرده نمی‌شوند. شمارنده از شروع فرایند
> است و عمق فعلی DLQ نیست — عمق نگه‌داشته را از `topic:kafka_topic_retained_records:sum{topic="rasta.audit.v1.dlq"}` یا خود Topic
> بخوان، و بدان که آن عدد «پیام حل‌نشده» نیست: هیچ وضعیت Triage برای پیام DLQ ثبت نمی‌شود و فقط Retention آن را کم می‌کند. متریک‌های
> `rasta_security_event_*` و `rasta_outbox_*` در `/metrics` خودِ `identity-service` صادر می‌شوند.

## اثر

- **هیچ تصمیم مجوزی عوض نشده.** ثبت حسابرسی هرگز پاسخ را تغییر نمی‌دهد: ردی که ثبتش شکست خورده همچنان همان `403` را گرفته است.
- اثر، **کاهش شواهد** است: جست‌وجو، پاسخ به بازبین امنیتی و `AGENTS.md` S-06 برای بازهٔ شکاف ناقص‌اند.
- اگر پیام گمشده رویداد مالی باشد، شکاف حسابرسی **جدا** از اثر مالی آن رویداد است؛ اثر مالی را با
  [ledger-imbalance](ledger-imbalance.md) یا [replay-dlq](replay-dlq.md) بسنج، نه با این Runbook.

---

## ⚠️ قواعد رسیدگی — پیش از هر فرمان

1. **فقط شناسه، هرگز مقدار.** در پروندهٔ حادثه، Ticket، Chat و خط فرمان فقط `eventId`، `correlationId`، `organizationId`، نام
   Topic/Partition/Offset، بازهٔ زمانی و `reason` بسته‌شدهٔ متریک/Header بنویس. **هرگز** Payload، `changes`، `reason` آزاد یک
   رکورد، IP، User-Agent، Token، Cookie یا بدنهٔ پیام DLQ را کپی نکن. خروجی API را با `jq` به شناسه‌ها محدود کن.
2. **Token را در متغیر محیط نگه دار،** با `set -x` یا `echo` چاپش نکن، و در URL نگذار. پارامترهای Query جست‌وجو فقط شناسه‌اند.
3. **مستأجر را از رکورد یا از رویداد بردار، نه از حدس.** `UNION_ADMIN` فقط زیردرختی را می‌بیند که Projection محلی اثبات کند؛
   برای بررسی میان‌مستأجری فقط `SYSTEM_ADMIN`. نبودن نتیجه برای یک `UNION_ADMIN` ممکن است **مرز مجوز** باشد، نه شکاف — پیش از
   اعلام شکاف با `SYSTEM_ADMIN` تکرار کن.
4. **هیچ نوشتنی در `audit_event`، `processed_event`، `audit_chain_head`، `security_event_outbox`، `outbox_message` یا
   `audit_correction_command`.** همهٔ Queryهای پایین `SELECT`اند و باید با نقشی **فقط‌خواندنی** اجرا شوند. درج دستی در
   `audit_event` جعل شواهد است و زنجیره را هم می‌شکند.
5. **هرگز Offset گروه‌های `audit-service.*` را بدون تصمیم ثبت‌شده جابه‌جا نکن** و هرگز پیام DLQ را **ویرایش‌شده** بازنشر نکن.

---

## تشخیص فوری

### ۱. بازهٔ مشکوک را دقیق کن

برای رکورد مورد انتظار این‌ها را از منبعش بردار (Log سرویس مبدأ با `correlationId`، پاسخ `202` فرمان اصلاح، یا ردیف Outbox
Producer — گام ۵): `eventId`، `correlationId`، `organizationId` (یا «پلتفرمی»)، `occurredAt`، مسیر (A یا B) و Topic.

**پیش از اعلام شکاف، تأخیر مجاز را کم کن:** برای رد، دست‌کم تا پایان پنجرهٔ تجمیع؛ برای اصلاح، تا انتشار `outbox_message`؛
برای هر دو، تا مصرف. رد در همان پنجره با ردهای یکسان (مستأجر، Actor، فعل، Resource، کد خطا) **یک** رکورد با `occurrenceCount`
است، نه چند رکورد — شمارش کمتر از انتظار را با `occurrenceCount` بسنج، نه با تعداد ردیف.

### ۲. آیا واقعاً در انبار نیست؟ — API جست‌وجو (فقط‌خواندنی)

پنجرهٔ `from..to` اجباری است و سقف `AUDIT_MAX_QUERY_WINDOW_DAYS` دارد (پیش‌فرض ۹۰ روز). فیلترهای موجود: `organizationId`،
`actorId`، `actorType`، `action`، `resourceType` (+ `resourceId`)، `correlationId`، `outcome`. **فیلتری روی `eventId` وجود
ندارد**؛ با `correlationId` یا Resource جست‌وجو کن و `sourceEventId` را در نتیجه تطبیق بده.

```bash
# $GATEWAY_URL و $SYSTEM_ADMIN_TOKEN را از محیط تأییدشدهٔ خودت بگذار. خروجی فقط شناسه‌ها.
curl -sS -G "$GATEWAY_URL/v1/audit-events" \
  -H "Authorization: Bearer $SYSTEM_ADMIN_TOKEN" \
  --data-urlencode "organizationId=$ORG_ID" \
  --data-urlencode "correlationId=$CORRELATION_ID" \
  --data-urlencode "from=$FROM" --data-urlencode "to=$TO" \
  | jq '{hasMore, items: [.items[] | {id, sourceEventId, sourceTopic, occurredAt, recordedAt, outcome, occurrenceCount, correctionOf, correctedBy}]}'
```

- برای `SYSTEM_ADMIN`، **نیامدن** `organizationId` یعنی همهٔ مستأجرها **و** رکوردهای پلتفرمی؛ آمدنش یعنی دقیقاً همان مستأجر.
- `hasMore: true` یعنی صفحهٔ بعد را با `cursor` بخوان پیش از نتیجه‌گیری.
- اصلاحی که در انبار هست، روی رکورد هدف در `correctedBy` دیده می‌شود.

### ۳. Readiness و Log `audit-service`

```bash
# نیت: پاسخ Readiness داخلی audit-service (پورت پیش‌فرض 3115؛ فقط در شبکهٔ داخلی).
curl -sS "$AUDIT_SERVICE_INTERNAL_URL/health/ready" | jq '{status, checks}'
```

| `checks` نادرست | معنا                                                                            | گام بعد                                                                   |
| --------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `database`      | نقش زمان اجرا دیگر `INSERT`/`SELECT` لازم را ندارد یا پایگاه داده در دسترس نیست | [database-bootstrap](database-bootstrap.md)؛ هیچ شاهدی تا رفع ثبت نمی‌شود |
| `projector`     | مسیر A متوقف است                                                                | Log شروع/Subscription؛ Topic غایب شروع را **عمداً** شکست می‌دهد           |
| `trail`         | مسیر B متوقف است                                                                | همان؛ `rasta.audit.trail.v1` باید وجود داشته باشد                         |

Kafka در دسترس نبودن **عمداً** Readiness را شکست نمی‌دهد؛ `ok` یعنی مصرف‌کننده‌ها روشن‌اند، نه اینکه عقب نیستند.

در Log، خط `Rejected …` فقط نام رویداد، `eventId` (اگر شکل شناسه داشته باشد)، Topic/Partition، دلیل Schema و **نام کلیدهای**
Payload را دارد — نه مقدار. دلیل‌ها با برچسب‌های بستهٔ `rasta_audit_ingestion_failures_total{reason}` یکی‌اند:

| `reason`                            | معنا                                                                       | مالک رفع              |
| ----------------------------------- | -------------------------------------------------------------------------- | --------------------- |
| `trail_invalid_envelope`            | Envelope مسیر B Parse نشد                                                  | Producer              |
| `trail_unsupported_event`           | روی Topic مسیر B، رویدادی جز `AUDIT_EVENT_RECORDED` v1                     | Producer              |
| `trail_invalid_payload`             | Payload با قرارداد v1 یا عرض ستون نمی‌خواند                                | Producer              |
| `trail_tenant_mismatch`             | `payload.organizationId` ≠ `envelope.tenantId` — **سیگنال جداسازی مستأجر** | Producer + مالک امنیت |
| `trail_unredacted_sensitive_change` | میدان `SENSITIVE_KEYS` با مقدار خام — **سیگنال نشت**                       | Producer + مالک امنیت |
| `unmappable_envelope`               | Envelope مسیر A نگاشت نشد                                                  | Producer دامنه        |
| `unmappable_organization_event`     | رویداد سازمان برای Projection سلسله‌مراتب نخواند                           | organization-service  |
| `database_error`                    | پایگاه داده رد کرد یا در دسترس نبود (فقط کلاس و کد Prisma در Log)          | عملیات پایگاه داده    |

### ۴. Kafka — Lag و DLQ (فقط‌خواندنی)

Prometheus محلی (Profile `observability`؛ داده از `kafka-exporter`، هر ۳۰ ثانیه):

```promql
kafka_consumergroup_lag{consumergroup=~"audit-service\\.(domain-projector|trail)"}      # هر Partition؛ -1 = بی Commit
kafka_consumergroup_members{consumergroup=~"audit-service\\.(domain-projector|trail)"}  # 0 = هیچ Consumer متصل نیست
topic:kafka_topic_retained_records:sum{topic="rasta.audit.v1.dlq"}                     # رکورد نگه‌داشته، نه حل‌نشده
```

Stack محلی همین مخزن، مستقیم از Broker:

```bash
docker compose exec kafka /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:9094 --describe --group audit-service.trail
docker compose exec kafka /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:9094 --describe --group audit-service.domain-projector

# عمق DLQ مشترک
docker compose exec kafka /opt/kafka/bin/kafka-get-offsets.sh \
  --bootstrap-server localhost:9094 --topic rasta.audit.v1.dlq

# فقط Headerها — بدنه را در پرونده کپی نکن
docker compose exec kafka /opt/kafka/bin/kafka-console-consumer.sh \
  --bootstrap-server localhost:9094 --topic rasta.audit.v1.dlq \
  --from-beginning --max-messages 20 --timeout-ms 10000 \
  --property print.headers=true --property print.value=false
```

محیط واقعی: **نیت** همان سه پرسش است — Lag هر Partition هر دو گروه، عمق `rasta.audit.v1.dlq`، و Headerهای پیام‌های آن —
با Bootstrap، احراز هویت و ابزار تأییدشدهٔ آن محیط. `kafka-console-consumer` را با گروه موقت اجرا کن، **هرگز** با
`--group audit-service.*`، وگرنه Offset مصرف‌کنندهٔ واقعی را جابه‌جا می‌کنی.

Lag ثابت و غیرصفر در حالی که Readiness `ok` است ⇒ Handler روی یک پیام در Retry است یا مصرف کند است (Log `Attempt i/N`). Lag
صفر و رکورد غایب ⇒ پیام یا هرگز به Topic نرسیده (گام ۵) یا ردشده و در DLQ است.

### ۵. سمت Producer — آیا اصلاً منتشر شد؟

**رد identity** (پایگاه دادهٔ `rasta_identity`، نقش فقط‌خواندنی):

```sql
SELECT id, window_ends_at, occurrence_count, published_at, attempts, next_attempt_at
  FROM security_event_outbox
 WHERE correlation_id = :'correlation_id'
    OR id = :'event_id';
```

- ردیفی نیست و `rasta_security_event_captures_total{outcome=~"failed|timeout"}` در همان بازه افزایش یافته ⇒ **شکاف واقعی و
  بازیابی‌ناپذیر**؛ به [security-event-outbox](security-event-outbox.md) گام ۴/۵ برو و بازه را ثبت کن.
- `published_at IS NULL` ⇒ هنوز منتشر نشده؛ [security-event-outbox](security-event-outbox.md). `last_error` را فقط به‌صورت
  کلاس خطا در پرونده بنویس.
- `published_at` پر است ⇒ به Kafka رسیده؛ برگرد به گام ۳ و ۴ (رد در Consumer یا Lag).

**اصلاح identity:**

```sql
SELECT c.event_id, c.created_at, o.published_at, o.attempts, o.next_attempt_at
  FROM audit_correction_command c
  LEFT JOIN outbox_message o ON o.id = c.event_id
 WHERE c.event_id = :'event_id';
```

`published_at IS NULL` ⇒ [outbox-stuck](outbox-stuck.md) برای `identity-service`. اصلاحی که پاسخ `202` گرفته ولی ردیفی در
`audit_correction_command` ندارد وجود ندارد: فرمان و ردیف Outbox در یک تراکنش‌اند. اگر `o.id` تهی است، ردیف Outbox دیگر نیست
— `purgePublished` در `outbox.store.ts` تعریف شده ولی امروز هیچ‌جا فراخوانی نمی‌شود، پس این حالت را **توضیح‌نداده** بدان و تشدید کن.

**مسیر A:** همان پرسش را روی `outbox_message` سرویس مبدأ (`sourceService` مورد انتظار) با [outbox-stuck](outbox-stuck.md) بپرس.

### ۶. سمت `audit-service` — آیا مصرف و ثبت شد؟ (پایگاه دادهٔ `rasta_audit`، Schema `audit`، نقش فقط‌خواندنی)

```sql
SET search_path TO audit;

-- نشانگر Idempotency: consumer_name یکی از audit-service.trail یا audit-service.domain-projector
SELECT event_id, consumer_name FROM processed_event WHERE event_id = :'event_id';

-- ردیف؛ occurred_at را محدود کن تا فقط پارتیشن‌های لازم خوانده شوند
SELECT id, source_topic, source_service, occurred_at, recorded_at, occurrence_count, correction_of
  FROM audit_event
 WHERE source_event_id = :'event_id'
   AND occurred_at BETWEEN :'from' AND :'to';
```

| `processed_event` | `audit_event` | معنا                                                                                                                         |
| :---------------: | :-----------: | ---------------------------------------------------------------------------------------------------------------------------- |
|        هست        |      هست      | ثبت شده؛ اگر API نشانش نمی‌دهد، مسئلهٔ **مجوز یا فیلتر** است (قاعدهٔ ۳)، نه شکاف                                             |
|       نیست        |     نیست      | هرگز ثبت نشده — گام ۴ (Lag/DLQ) و ۵ (Producer)                                                                               |
|        هست        |     نیست      | **نباید رخ دهد** (یک تراکنش). شواهد را حفظ کن و مانند واگرایی تشدید کن — [audit-chain-divergence](audit-chain-divergence.md) |
|       نیست        |      هست      | **نباید رخ دهد.** همان                                                                                                       |

---

## اقدام

### گام ۱ — مهار

- **علت را در Producer یا Consumer رفع کن، نه در داده.** بازنشر پیش از رفع، همان پیام را دوباره به DLQ می‌فرستد.
- Consumer گیرکرده روی یک پیام: رفع کد/پایگاه داده/Topic، سپس اجازه بده Retry و DLQ کارشان را بکنند. Offset را دستی رد نکن.
- Producerی که `trail_tenant_mismatch` یا `trail_unredacted_sensitive_change` می‌سازد: **حادثهٔ امنیتی** است؛ مالک امنیت را
  همین حالا خبر کن. پیام‌های DLQ آن ممکن است مقدار حساس داشته باشند — دسترسی به DLQ را محدود نگه دار و بدنه را جایی کپی نکن.

### گام ۲ — تشدید

به مالک سرویس Producer و مالک امنیت، با: مسیر، Topic/Partition/Offset، `eventId`ها، `correlationId`ها، مستأجرهای متأثر
(فقط شناسه)، بازهٔ زمانی، `reason`ها، و اینکه شکاف **بازیابی‌پذیر** است یا نه (جدول گام ۳). اگر رویداد مالی است، مسئول
عملیات مالی را هم.

### گام ۳ — مرزهای بازیابی

| وضعیت                                            | بازیابی‌پذیر؟                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ردیف Producer منتشرنشده (`published_at IS NULL`) | ✅ پس از رفع، Relay خودش منتشر می‌کند                                                                                                                                                                                                                                                                                            |
| Consumer عقب یا متوقف، پیام هنوز در Topic        | ✅ پس از رفع، مصرف از Offset ثبت‌شده ادامه می‌یابد؛ ثبت Idempotent است                                                                                                                                                                                                                                                           |
| پیام در `rasta.audit.v1.dlq`                     | ⚠️ فقط با بازنشر **دستی، تک‌پیام، بایت‌های دست‌نخورده** — گام ۴                                                                                                                                                                                                                                                                  |
| `captures_total{failed\|timeout}` — رد ثبت‌نشده  | ❌ نه. بازه را ثبت کن                                                                                                                                                                                                                                                                                                            |
| پیام از Kafka منقضی شده و هرگز ثبت نشده          | ❌ نه از Kafka. **Kafka پشتیبان نیست:** Topicهای دامنه‌ای ۷ روز (`infrastructure/docker/kafka/create-topics.sh`)، و در Script محلی `rasta.audit.trail.v1` و `*.dlq` سی روز. نگهداشت محیط واقعی در مخزن ثابت نیست — با `kafka-configs.sh --describe` تأیید کن. تنها رکورد بادوام، پایگاه دادهٔ `rasta_audit` و پشتیبان‌های آن است |

**بازخوانی Idempotent امن است** — برای خودِ `audit-service`: همان `eventId` روی همان مسیر دقیقاً یک ردیف می‌ماند. ولی:

- **پشتیبان را با بازخوانی عوض نکن.** ردیفی که در پایگاه داده بوده و از دست رفته، از Restore برمی‌گردد، نه از Kafka — و Restore
  با [restore-database](restore-database.md) (هنوز نوشته نشده) و تأیید زنجیرهٔ ماه‌های متأثر همراه است.
- **هیچ ترمیمی از راه نوشتن مستقیم نیست.** نه `INSERT` در `audit_event`، نه ویرایش Outbox (Trigger
  `tg_security_event_outbox_guard` ستون‌های شواهد را هر طور رد می‌کند)، نه صفر کردن `published_at`.
- **اصلاح (`POST /v1/audit-corrections`) شکاف را پر نمی‌کند.** فقط روی رکوردی که **هست** یک رکورد جبرانی می‌گذارد؛ رکوردِ
  نرسیده هدفی برای اصلاح ندارد (`404`).

### گام ۴ — پیام DLQ

1. Header `x-dlq-original-topic` را بخوان. **پیامی از مسیر A روی یک Topic دامنه‌ای است و بازنشرش به همهٔ مصرف‌کننده‌های آن
   Topic می‌رسد، نه فقط به حسابرسی.** Idempotency آن‌ها را از تکرار حفظ می‌کند، ولی تصمیم با مالک آن Topic است.
2. **رویداد مالی** (`ORDER_RECEIPT_CONFIRMED`، `PAYMENT_*`، `COMMISSION_APPLIED`، `SETTLEMENT_COMPLETED`، `STATEMENT_APPROVED`،
   `JOURNAL_POSTED` — [replay-dlq](replay-dlq.md)) **هرگز خودکار یا دسته‌ای بازنشر نمی‌شود:** بررسی انسانی اثر مالی، تأیید
   مسئول عملیات مالی، تک‌پیام، و بلافاصله بررسی توازن دفتر کل.
3. **Script بازپخشی که [replay-dlq](replay-dlq.md) نام می‌برد (`dist/scripts/replay-dlq.js`) در این مخزن وجود ندارد** (ریسک R-6).
   هر بازنشر دستی است، با ابزار استاندارد Kafka و Credential تأییدشدهٔ محیط: یک پیام، **بایت‌های Value و کلید اصلی بدون
   تغییر**، به همان `x-dlq-original-topic`، پس از رفع علت، با ثبت Offset مبدأ و مقصد در پرونده. پیامی که ویرایش شود دیگر شاهد
   Producer نیست — **هرگز**.
4. پیام مسیر B که به‌خاطر قرارداد رد شده، با همان بایت‌ها **دوباره رد می‌شود**؛ Consumer عمداً سهل‌گیرتر نمی‌شود. رفع در Producer
   است، و ردیف Outbox آن پیام پیش‌تر منتشرشده علامت خورده — ابزاری برای انتشار دوباره‌اش نیست. شکاف را ثبت کن و تشدید کن.
5. پیامی که نباید بازنشر شود: تصمیم و دلیل را در پرونده بنویس؛ **بی‌صدا رهایش نکن**.

---

## تأیید رفع

- [ ] برای هر `eventId` مورد انتظار، یا ردیف `audit_event` و نشانگر `processed_event` هر دو هستند (گام ۶)، یا شکاف با بازه،
      علت و «بازیابی‌پذیر نیست» ثبت شده است
- [ ] جست‌وجوی API با `SYSTEM_ADMIN` همان رکوردها را برمی‌گرداند (گام ۲)؛ برای رد، `occurrenceCount` با ردیف `security_event_outbox` یکی است
- [ ] `GET /health/ready` روی `audit-service` پاسخ `200` و هر سه `checks` برابر `true`
- [ ] Lag هر دو گروه `audit-service.*` به صفر یا روند نزولی برگشته و عمق `rasta.audit.v1.dlq` دیگر رشد نمی‌کند
- [ ] در سمت identity: `rasta_security_event_outbox_closed_backlog_age_seconds` زیر ۶۰، `captures_total{failed|timeout}` دیگر افزایش نمی‌یابد، `rasta_outbox_pending_age_seconds{service="identity-service"}` عادی
- [ ] `GET /v1/audit-events/verify` برای ماه‌ها و مستأجرهای متأثر `DIVERGENT` نمی‌دهد (`VALID`، یا `UNVERIFIABLE_LEGACY` فقط برای بازهٔ پیش از AUD-003) — اگر می‌دهد، [audit-chain-divergence](audit-chain-divergence.md)
- [ ] هیچ نوشتن دستی در هیچ جدول شواهد یا Outbox انجام نشده، و پرونده فقط شناسه دارد
- [ ] علت ریشه‌ای در Backlog

## پیشگیری

- Route `/metrics` در `audit-service` و هدف Scrape محلی آن (`host.docker.internal:3115`) **اکنون وجود دارند**؛ پیکربندی Scrape
  محیط واقعی هنوز وابسته به استقرار و بیرون از مخزن است.
- قواعد `RastaAuditIngestionFailure`، `RastaSecurityEventCaptureGap`، `RastaDeadLetterMessagePublished` و `RastaAuditConsumerLag`
  **اکنون** در Prometheus محلی هستند و عمق نگه‌داشتهٔ `rasta.audit.v1.dlq` ثبت می‌شود؛ نبودن سیگنال Lag هم با
  `RastaKafkaExporterUnavailable` و `RastaAuditConsumerGroupMetricsMissing` صریح است ([audit-ingestion-lag](audit-ingestion-lag.md)).
  هنوز نیست: Alertmanager و تحویل اعلان، Scrape محیط واقعی، و هشدار روی `rasta_audit_ingestion_lag_seconds`.
- Script بازپخش DLQ (R-6) یا حذف ارجاع به آن از [replay-dlq](replay-dlq.md).
- نگهداشت Topic مسیر B و DLQ در محیط واقعی را صریح و مستند کن؛ Script محلی فقط سی روز دارد.
- ثبت ردها در سرویس‌های دیگر (R-2)، ردهای Gateway و ردهای Token سرویس — تا آن وقت نبودن آن‌ها «شکاف حادثه» نیست و نباید
  چنین گزارش شود.

---

## ارجاع‌ها

- [ADR-053](../adr/ADR-053-audit-service-append-only-evidence.md) § ۱ (دو مسیر)، § ۴ (ردها)، § ۷ (اصلاح)، § ۸ (Idempotency و
  نگهداشت)، § ۱۳ (رصدپذیری)
- [برنامهٔ پیاده‌سازی ADR-053](../adr/ADR-053-implementation-plan.md) § ۴، § ۵ و نگاشت شواهد § ۷
- [`docs/events/README.md` § Audit](../events/README.md)
- کد: `services/audit-service/src/consumers/`، `services/audit-service/src/health/health.controller.ts`،
  `services/audit-service/src/observability/metrics.ts`، `services/identity-service/src/security-events/`،
  `services/identity-service/src/audit-correction/`، `packages/nest-common/src/consumer/event-consumer.ts`
