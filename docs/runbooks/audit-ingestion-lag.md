# Runbook: Lag مصرف‌کنندهٔ حسابرسی

**شدت:** 🟠 هشدار — 🔴 بحرانی اگر Lag به نگهداشت Topic نزدیک شود
**هشدار محرک:** `RastaAuditConsumerLag` (🟠 `warning`) در
[`infrastructure/docker/prometheus/rules/rasta-audit-alerts.yml`](../../infrastructure/docker/prometheus/rules/rasta-audit-alerts.yml)
**زمان پاسخ هدف:** ۳۰ دقیقه

```promql
sum by (consumergroup, topic) (
  clamp_min(kafka_consumergroup_lag{consumergroup=~"audit-service\\.(domain-projector|trail)"}, 0)
) > 0
```

با `for: 5m`؛ Labelهای هشدار فقط `consumergroup` و `topic`اند (به‌علاوهٔ `severity`).

---

> **این Runbook فقط آنچه امروز در مخزن هست را توصیف می‌کند.**
>
> - **منبع داده.** سرویس `kafka-exporter` در `docker-compose.yml` (`danielqsj/kafka-exporter:v1.9.0`، Profile
>   `observability`/`all`) از `kafka:9094` می‌خواند و Job `kafka-exporter` در `prometheus.yml` آن را از شبکهٔ Compose هر ۳۰
>   ثانیه (Timeout ۲۵ ثانیه) Scrape می‌کند؛ Exporter Port میزبان ندارد. `kafka_consumergroup_lag{consumergroup,partition,topic}`
>   = جدیدترین Offset Partition منهای **Offset Commit‌شدهٔ** گروه. برای Partitionی که گروه هرگز Commit نکرده، Exporter **`-1`**
>   می‌دهد؛ قاعده آن را پیش از جمع صفر می‌کند، چون «نامعلوم» است نه «جلوتر».
> - **فقط دو گروه ثابت.** `audit-service.domain-projector` (مسیر A، ده Topic دامنه در `DOMAIN_TOPICS`) و `audit-service.trail`
>   (مسیر B، `rasta.audit.trail.v1`). هر دو در `services/audit-service/src/app.module.ts` ثابت‌اند و هر دو به
>   `rasta.audit.v1.dlq` Dead-letter می‌کنند. گروه‌های دیگر (از جمله گروه‌های آزمون `audit-itest-*`) عمداً دیده نمی‌شوند.
> - **`for: 5m`.** Lag جمع‌شدهٔ هر `(consumergroup, topic)` باید در **همهٔ** ارزیابی‌های پنج دقیقه بالای صفر باشد. مصرف عادی که
>   به صفر برسد، `for` را از نو آغاز می‌کند؛ پس این هشدار یعنی گروه در پنج دقیقه حتی یک‌بار هم به انتهای آن Topic نرسیده است.
> - **فقط محلی.** این قاعده را فقط Prometheus محلی Compose ارزیابی می‌کند و در `http://localhost:9090/alerts` دیده می‌شود.
>   **مخزن Alertmanager ندارد، پس هیچ اعلانی به هیچ‌کس تحویل نمی‌شود.** Scrape و مسیریابی اعلان محیط واقعی وابسته به استقرار
>   است و در مخزن نیست.
> - **آنچه این هشدار نمی‌بیند.** (۱) اگر Exporter یا Scrape آن از کار بیفتد، Seriesها کهنه می‌شوند و هشدار ساکت است — هشداری
>   روی `up{job="kafka-exporter"}` نیست. (۲) Partition با `-1`. (۳) تأخیر زمانی درون خود سرویس:
>   `rasta_audit_ingestion_lag_seconds{source_topic}` در `/metrics` صادر می‌شود ولی قاعدهٔ هشدار ندارد. (۴) رکوردی که هرگز به
>   Topic نرسیده — [audit-gap-detected](audit-gap-detected.md).

---

## علائم

- `RastaAuditConsumerLag` در `/alerts` Prometheus محلی `firing` است.
- جست‌وجوی حسابرسی عمل‌ها یا ردهای تازه را دیر یا اصلاً نشان نمی‌دهد.
- `GET /health/ready` روی `audit-service` پاسخ `503` با `projector` یا `trail` برابر `false` می‌دهد، یا سرویس اصلاً اجرا نمی‌شود.

## اثر

- ردیف‌های `audit_event` برای رکوردهای پشت Offset Commit‌شده **ممکن است هنوز نوشته نشده باشند**. Lag Offset است، نه تعداد
  ردیف غایب: پیامی که پردازش شده ولی Offsetش هنوز Commit نشده هم شمرده می‌شود.
- **مجوزدهی و منطق کسب‌وکار اثر نمی‌گیرند** — افت حسابرسی فقط Lag است
  ([ADR-053](../adr/ADR-053-audit-service-append-only-evidence.md)).
- **خطر واقعی نگهداشت است.** Topicهای دامنه هفت روز نگه داشته می‌شوند و `rasta.audit.trail.v1` در Stack محلی سی روز
  (`infrastructure/docker/kafka/create-topics.sh`). رکوردی که پیش از مصرف از Topic حذف شود **برای همیشه** از حسابرسی غایب است؛
  آن‌وقت این دیگر Lag نیست، شکاف است → [audit-gap-detected](audit-gap-detected.md).

---

## تشخیص (همه فقط‌خواندنی)

### ۱. Prometheus محلی — کدام گروه، کدام Topic، چند عضو

```promql
# Lag هر Partition (‎-1 = گروه هرگز Commit نکرده)
kafka_consumergroup_lag{consumergroup=~"audit-service\\.(domain-projector|trail)"}

# عضو زندهٔ گروه — 0 یعنی هیچ Consumerی متصل نیست
kafka_consumergroup_members{consumergroup=~"audit-service\\.(domain-projector|trail)"}

# آیا خود داده تازه است؟
up{job="kafka-exporter"}

# روند: رشد، ثابت یا نزول در ۳۰ دقیقه
delta(kafka_consumergroup_lag_sum{consumergroup=~"audit-service\\.(domain-projector|trail)"}[30m])
```

### ۲. Kafka — نمای Broker

```bash
docker compose exec kafka /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:9094 --describe --group audit-service.domain-projector
docker compose exec kafka /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:9094 --describe --group audit-service.trail
docker compose exec kafka /opt/kafka/bin/kafka-consumer-groups.sh \
  --bootstrap-server localhost:9094 --describe --group audit-service.trail --members
```

در Git Bash روی ویندوز `MSYS_NO_PATHCONV=1` لازم است. محیط واقعی: **نیت** همان پرسش‌هاست، با Bootstrap، احراز هویت و ابزار
تأییدشدهٔ آن محیط.

### ۳. خود `audit-service`

- `GET /health/ready` — `database`، `projector` و `trail`.
- Log: `Attempt <i>/<N> failed for …`، `Handler failed <N>x for …`، `Unparseable message on …`، و خطاهای پایگاه داده.
- `GET /metrics`: `rasta_audit_ingestion_failures_total{reason}` (هشدار `RastaAuditIngestionFailure`) و
  `rasta_audit_ingestion_lag_seconds{source_topic}`.

### ۴. DLQ — عمق نگه‌داشته، نه کار حل‌نشده

```promql
topic:kafka_topic_retained_records:sum{topic="rasta.audit.v1.dlq"}
```

= جمعِ `clamp_min(kafka_topic_partition_current_offset - kafka_topic_partition_oldest_offset, 0)` روی Partitionهای
`rasta.audit.v1.dlq`. **این تعداد رکوردی است که Kafka هنوز نگه می‌دارد، نه تعداد پیام حل‌نشده.** مخزن هیچ وضعیت Triage، تأیید
یا بازپخش برای پیام DLQ ثبت نمی‌کند و عدد فقط وقتی کم می‌شود که Retention (سی روز برای این Topic) Segment قدیمی را پاک کند؛
پس بزرگ بودنش به‌تنها نشانهٔ مشکل نیست و روی آن هشداری نیست. نشانهٔ تازه **افزایش** آن یا
`RastaDeadLetterMessagePublished` است → [replay-dlq](replay-dlq.md).

### ۵. دسته‌بندی

| `members` | روند Lag               | Readiness                | معنای محتمل                                                                     |
| :-------: | ---------------------- | ------------------------ | ------------------------------------------------------------------------------- |
|    `0`    | ثابت یا رو به رشد      | سرویس اجرا نمی‌شود/`503` | `audit-service` خاموش است یا Consumer به Kafka وصل نشده                         |
|   `> 0`   | ثابت، روی یک Partition | `ok`                     | Handler روی یک پیام در Retry است (Log `Attempt i/N`)؛ پس از N بار به DLQ می‌رود |
|   `> 0`   | ثابت، همهٔ Topicها     | `database: false`        | پایگاه داده در دسترس نیست و هر نوشتن Retry می‌شود                               |
|   `> 0`   | رو به نزول             | `ok`                     | در حال رسیدن — تا صفر پیگیری کن؛ اگر Lag صفر نشود `for` پابرجا می‌ماند          |
|   `> 0`   | رو به رشد              | `ok`                     | گذردهی کمتر از نرخ تولید                                                        |

---

## اقدام

1. **علت را رفع کن، نه Offset را.** سرویس را برگردان، دسترسی پایگاه داده را درست کن، یا پیامی را که در Retry گیر کرده از روی
   Log پیدا کن. هر نوشتن روی `(eventId, consumerName)` Idempotent است، پس ادامهٔ مصرف از همان Offset امن است.
2. **⛔ هرگز Offset گروه‌های `audit-service.*` را جابه‌جا نکن** (`--reset-offsets`، `--to-latest`، `--shift-by`، حذف گروه).
   پرش به جلو شواهد را بی‌صدا و برای همیشه از حسابرسی حذف می‌کند؛ این همان شکافی است که این هشدار برای جلوگیری از آن است.
3. **⛔ هرگز Consumer تشخیصی را با `--group audit-service.*` اجرا نکن**؛ Offset مصرف‌کنندهٔ واقعی را جابه‌جا می‌کند. برای خواندن
   Header از گروه موقت استفاده کن ([audit-gap-detected](audit-gap-detected.md) § ۴).
4. **⛔ Topic `rasta.audit.v1.dlq` یا Topic مبدأ را برای «صفر کردن» عددی حذف یا کوتاه نکن.**
5. اگر قدیمی‌ترین رکورد عقب‌مانده به مرز نگهداشت Topic نزدیک است، این را حادثهٔ 🔴 بدان، مالک Kafka را درگیر کن و پیش از هر
   تصمیمی بازهٔ در معرض خطر را ثبت کن. اگر رکوردی پیش از مصرف حذف شد → [audit-gap-detected](audit-gap-detected.md).
6. پیامی که پس از رفع علت به DLQ رفت → [replay-dlq](replay-dlq.md). Script بازپخش DLQ هنوز در مخزن نیست.

---

## تأیید رفع

- [ ] `RastaAuditConsumerLag` برای همان `consumergroup`/`topic` دیگر در `/alerts` نیست
- [ ] `kafka_consumergroup_lag` هر Partition دو گروه صفر است یا پیوسته رو به نزول
- [ ] `kafka_consumergroup_members` هر دو گروه بزرگ‌تر از صفر و `GET /health/ready` پاسخ `200`
- [ ] `RastaAuditIngestionFailure` و `RastaDeadLetterMessagePublished` در همان بازه نسوخته‌اند، یا هر کدام Runbook خود را طی کرده
- [ ] هیچ Offset، گروه یا Topicی دستی تغییر نکرده

## پیشگیری

- هشدار روی `up{job="kafka-exporter"} == 0` تا نبودن داده با «بی‌Lag» اشتباه نشود — هنوز نیست.
- قاعدهٔ هشدار روی `rasta_audit_ingestion_lag_seconds` (ADR-053 § ۱۳: p95 > ۶۰ ثانیه) — هنوز نیست.
- Scrape و مسیریابی اعلان محیط واقعی و Alertmanager — وابسته به استقرار و بیرون از مخزن.
- وضعیت Triage برای پیام DLQ، تا بتوان «پیام حل‌نشده» را واقعاً شمرد — امروز وجود ندارد.
