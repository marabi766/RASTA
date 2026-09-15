# Runbook: Lag مصرف‌کنندهٔ حسابرسی

**شدت:** 🟠 هشدار — 🔴 بحرانی اگر Lag به نگهداشت Topic نزدیک شود
**هشدار محرک:** `RastaAuditConsumerLag`، `RastaKafkaExporterUnavailable`، `RastaAuditConsumerGroupMetricsMissing` و
`RastaAuditIngestionLagHigh` (هر چهار 🟠 `warning`) در
[`infrastructure/docker/prometheus/rules/rasta-audit-alerts.yml`](../../infrastructure/docker/prometheus/rules/rasta-audit-alerts.yml)
**زمان پاسخ هدف:** ۳۰ دقیقه

```promql
# RastaAuditConsumerLag — for: 5m؛ Labelها: consumergroup, topic
sum by (consumergroup, topic) (
  clamp_min(kafka_consumergroup_lag{consumergroup=~"audit-service\\.(domain-projector|trail)"}, 0)
) > 0

# RastaKafkaExporterUnavailable — for: 2m؛ Label: job
min by (job) (up{job="kafka-exporter"}) == 0 or absent(up{job="kafka-exporter"})

# RastaAuditConsumerGroupMetricsMissing — for: 5m؛ Label: consumergroup
(
    absent(kafka_consumergroup_lag{consumergroup="audit-service.domain-projector"})
  or
    absent(kafka_consumergroup_lag{consumergroup="audit-service.trail"})
)
and on () (min(up{job="kafka-exporter"}) == 1)

# RastaAuditIngestionLagHigh — for: 5m؛ Label: source_topic
histogram_quantile(0.95, sum by (le, source_topic) (rate(rasta_audit_ingestion_lag_seconds_bucket[5m]))) > 60
```

هر چهار به‌علاوهٔ `severity`. `RastaKafkaExporterUnavailable` و `RastaAuditConsumerGroupMetricsMissing` برای این‌اند که **سکوت
`RastaAuditConsumerLag` با «بی‌Lag» اشتباه نشود:** آن هشدار فقط روی Seriesهای موجود کار می‌کند و وقتی ورودی‌اش نیست ساکت است.
این دو هرگز هم‌زمان نمی‌سوزند.

**دو نوع Lag، دو سؤال.** سه هشدار اول از سمت **Broker**اند: چند رکورد پشت Offset Commit‌شدهٔ گروه مانده است.
`RastaAuditIngestionLagHigh` از سمت **خود `audit-service`** است: ردیف‌هایی که **واقعاً نوشته شدند** چند ثانیه پس از `occurredAt`
رویداد نوشته شدند. اولی مصرفِ متوقف را می‌بیند؛ دومی تحویلِ دیرِ شواهدی را که هنوز می‌رسد. مصرف‌کننده‌ای که هیچ ردیفی نمی‌نویسد
هیچ مشاهده‌ای ندارد و دومی را ساکت می‌گذارد — آن‌جا اولی‌ها می‌سوزند.

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
> - **از دست رفتن سیگنال — دو حالت جدا.**
>   - **Exporter در دسترس نیست** → `RastaKafkaExporterUnavailable` پس از `for: 2m`: `up{job="kafka-exporter"}` صفر است (Container
>     خاموش یا Scrape ناموفق) **یا اصلاً Series ندارد** (Job از `prometheus.yml` حذف یا بار نشده) — شاخهٔ `absent(...)` حالت دوم
>     را می‌گیرد که `== 0` به‌تنها نمی‌بیند. `min by (job)` Label `instance` را کنار می‌گذارد. در این حالت هیچ Series کافکایی
>     تازه نیست و Lag و عمق DLQ **نامعلوم**اند. Scrape ناموفق یا Restart کوتاه‌تر از دو دقیقه هشدار نمی‌دهد.
>   - **Exporter سالم است ولی گروهی گزارش نمی‌شود** → `RastaAuditConsumerGroupMetricsMissing` پس از `for: 5m`، یک هشدار برای هر
>     گروه غایب با Label `consumergroup`. Exporter برای یک گروه فقط Topicهایی را گزارش می‌کند که گروه در آن دست‌کم یک Offset
>     Commit‌شده دارد (`--offset.show-all` گروه متوقفِ دارای Offset را هم نگه می‌دارد)؛ پس نبودن **هیچ** Series
>     `kafka_consumergroup_lag` برای گروه یعنی Broker هیچ Offset Commit‌شده‌ای برای آن گروه گزارش نمی‌کند. مقدار موجود `-1`، صفر
>     یا مثبت «موجود» است. هر گروه با تطابق **دقیق** نامش سنجیده می‌شود؛ گروه‌های آزمون `audit-itest-*` جای آن را نمی‌گیرند. وقتی
>     Exporter خودش در دسترس نیست این هشدار عمداً خاموش است تا یک خرابی دو تشخیص نگیرد. ناپدید شدن گذرای کمتر از پنج دقیقه
>     هشدار نمی‌دهد و بازگشت Series پنج دقیقه را از نو آغاز می‌کند.
> - **تأخیر زمانی درون سرویس — `RastaAuditIngestionLagHigh`.** `rasta_audit_ingestion_lag_seconds{source_topic}` یک
>   **Histogram** است (ADR-053 § ۱۳) و در `/metrics` به شکل `_bucket{source_topic,le}`، `_sum{source_topic}` و
>   `_count{source_topic}` صادر می‌شود. هر دو مصرف‌کننده (مسیر A و B) پس از هر نتیجهٔ `WRITTEN` یک بار
>   `max(0, now - occurredAt)` را به ثانیه Observe می‌کنند — ساعت جلوتر Producer به صفر Clamp می‌شود — و برای `DUPLICATE`،
>   Envelope ردشده یا شکست پایگاه داده **هیچ** مشاهده‌ای ثبت نمی‌شود. مرزهای Bucket (`AUDIT_INGESTION_LAG_BUCKETS`):
>   `1, 5, 15, 30, 60, 120, 300, 900, 3600` و `+Inf`؛ `60` مرز دقیق است تا آستانهٔ هشدار درون‌یابی نشود. هر ۱۱ مقدار
>   `source_topic` (ده `DOMAIN_TOPICS` و `rasta.audit.trail.v1`) هنگام بار شدن ماژول با `zero()` — نه با مشاهدهٔ ساختگی صفر —
>   صادر می‌شوند: ۱۱ × ۱۰ Bucket + ۱۱ `_sum` + ۱۱ `_count` = ۱۳۲ Series. هشدار p95 را از جمع Bucketها روی همهٔ Instanceها
>   (`sum by (le, source_topic)`) در پنجرهٔ `rate` پنج‌دقیقه‌ای می‌سازد و پس از `for: 5m` می‌سوزد؛ Labelهایش فقط `source_topic`
>   و `severity`. بی مشاهده، p95 برابر `NaN` است و هرگز بالای ۶۰ نیست.
> - **آنچه این هشدارها نمی‌بینند.** (۱) گروه موجودی که فقط در برخی Topicها Offset دارد: Topic بی Commit گزارش نمی‌شود و هشدار
>   ندارد. (۲) Partition با `-1`. (۳) تأخیر رکوردی که هنوز نوشته نشده: Histogram فقط ردیف نوشته‌شده را می‌شمارد. (۴) رکوردی که
>   هرگز به Topic نرسیده — [audit-gap-detected](audit-gap-detected.md).

---

## علائم

- `RastaAuditConsumerLag` در `/alerts` Prometheus محلی `firing` است.
- `RastaKafkaExporterUnavailable` یا `RastaAuditConsumerGroupMetricsMissing` `firing` است: Lag آن گروه‌ها **نامعلوم** است، نه صفر
  (§ ۵ تشخیص).
- `RastaAuditIngestionLagHigh` برای یک `source_topic` `firing` است: ردیف‌ها نوشته می‌شوند، ولی p95 تأخیرشان پنج دقیقه بالای ۶۰
  ثانیه مانده است (§ ۳).
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

# آیا خود داده تازه است؟ (0 یا بی Series → RastaKafkaExporterUnavailable)
up{job="kafka-exporter"}

# کدام گروه اصلاً Series ندارد؟ (نتیجهٔ تهی = گروه گزارش می‌شود)
absent(kafka_consumergroup_lag{consumergroup="audit-service.domain-projector"})
absent(kafka_consumergroup_lag{consumergroup="audit-service.trail"})

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
- `GET /metrics`: `rasta_audit_ingestion_failures_total{reason}` (هشدار `RastaAuditIngestionFailure`) و Histogram
  `rasta_audit_ingestion_lag_seconds_bucket|_sum|_count{source_topic}` (هشدار `RastaAuditIngestionLagHigh`).

```promql
# p95 هر Topic، همان عبارت هشدار بی آستانه
histogram_quantile(0.95, sum by (le, source_topic) (rate(rasta_audit_ingestion_lag_seconds_bucket[5m])))

# ردیف نوشته‌شده در ثانیه، و میانگین تأخیر، برای هر Topic
sum by (source_topic) (rate(rasta_audit_ingestion_lag_seconds_count[5m]))
sum by (source_topic) (rate(rasta_audit_ingestion_lag_seconds_sum[5m]))
  / sum by (source_topic) (rate(rasta_audit_ingestion_lag_seconds_count[5m]))
```

وقتی `RastaAuditIngestionLagHigh` می‌سوزد: اگر Lag Broker همان Topic هم بالاست، گروه در حال رسیدن به عقب‌ماندگی است و p95
بالا نتیجهٔ آن است (§ ۱ و ۲). اگر Lag Broker صفر است، رویدادها دیر **به Kafka رسیده‌اند** — Outbox یا Relay تولیدکننده عقب است،
یا ساعت Producer عقب است — و این Runbook سمت مصرف را درست نمی‌کند؛ مالک سرویس تولیدکننده را درگیر کن. بازپخش عمدی رکوردهای
قدیمی هم p95 را بالا می‌برد؛ تکراری‌ها شمرده نمی‌شوند، ولی رکوردی که نخستین بار دیر نوشته شود شمرده می‌شود.

### ۴. DLQ — عمق نگه‌داشته، نه کار حل‌نشده

```promql
topic:kafka_topic_retained_records:sum{topic="rasta.audit.v1.dlq"}
```

= جمعِ `clamp_min(kafka_topic_partition_current_offset - kafka_topic_partition_oldest_offset, 0)` روی Partitionهای
`rasta.audit.v1.dlq`. **این تعداد رکوردی است که Kafka هنوز نگه می‌دارد، نه تعداد پیام حل‌نشده.** مخزن هیچ وضعیت Triage، تأیید
یا بازپخش برای پیام DLQ ثبت نمی‌کند و عدد فقط وقتی کم می‌شود که Retention (سی روز برای این Topic) Segment قدیمی را پاک کند؛
پس بزرگ بودنش به‌تنها نشانهٔ مشکل نیست و روی آن هشداری نیست. نشانهٔ تازه **افزایش** آن یا
`RastaDeadLetterMessagePublished` است → [replay-dlq](replay-dlq.md).

### ۵. سیگنال از دست رفته

**`RastaKafkaExporterUnavailable`:**

- `docker compose ps kafka-exporter` و `docker compose logs --tail=100 kafka-exporter` — Container اجرا می‌شود؟ به `kafka:9094`
  وصل می‌شود؟
- خطای Scrape Job `kafka-exporter` در `http://localhost:9090/targets` (DNS، Connection refused، `context deadline exceeded`).
- اگر `up{job="kafka-exporter"}` اصلاً Series ندارد، Job در `prometheus.yml` بار نشده یا حذف شده است.
- تا رفع این هشدار، **سکوت `RastaAuditConsumerLag` و عدد عمق DLQ را نشانهٔ سلامت نگیر**؛ نمای Broker (§ ۲) را مستقیم بخوان.

**`RastaAuditConsumerGroupMetricsMissing`:** Broker برای گروه نام‌برده Offset Commit‌شده‌ای گزارش نمی‌کند. حالت محتمل در
Stack محلی **Broker یا Volume تازهٔ Kafka** است که `audit-service` هنوز روی آن اجرا نشده یا Consumer آن هنوز چیزی Commit نکرده؛
حالت دیگر، گروهی است که مدت‌ها بی عضو مانده و Broker Offsetهایش را طبق نگهداشت Offset خودش پاک کرده است.

- `kafka-consumer-groups.sh --describe --group <consumergroup>` (§ ۲) — گروه وجود دارد؟ عضو دارد؟ Offset دارد؟
- `audit-service` واقعی را اجرا یا بررسی کن: `GET /health/ready` (`projector`/`trail`) و Log اتصال Consumer. پس از نخستین Commit
  Series باز می‌گردد و هشدار رفع می‌شود.
- **⛔ برای ساختن Series، Offset گروه را Reset یا Shift نکن، گروه را حذف نکن و Consumer تشخیصی با همان `--group` اجرا نکن**
  (اقدام ۲ و ۳). اگر Offsetهای گروهی که پیش‌تر مصرف می‌کرد از دست رفته‌اند، نقطهٔ ادامهٔ مصرف تابع پیکربندی Consumer است؛ پیش از
  هر تصمیم آن را ثبت کن و احتمال شکاف را با [audit-gap-detected](audit-gap-detected.md) بسنج.

### ۶. دسته‌بندی

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
- [ ] `RastaKafkaExporterUnavailable` و `RastaAuditConsumerGroupMetricsMissing` در `/alerts` نیستند (`up{job="kafka-exporter"}`
      برابر `1` و هر دو `absent(...)` بالا تهی)
- [ ] `RastaAuditIngestionLagHigh` برای همان `source_topic` در `/alerts` نیست و p95 بالا دست‌کم پنج دقیقه ≤ ۶۰ ثانیه است
- [ ] `kafka_consumergroup_lag` هر Partition دو گروه صفر است یا پیوسته رو به نزول
- [ ] `kafka_consumergroup_members` هر دو گروه بزرگ‌تر از صفر و `GET /health/ready` پاسخ `200`
- [ ] `RastaAuditIngestionFailure` و `RastaDeadLetterMessagePublished` در همان بازه نسوخته‌اند، یا هر کدام Runbook خود را طی کرده
- [ ] هیچ Offset، گروه یا Topicی دستی تغییر نکرده

## پیشگیری

- نبودن داده دیگر با «بی‌Lag» یکی نیست: `RastaKafkaExporterUnavailable` و `RastaAuditConsumerGroupMetricsMissing` — فقط محلی و بی
  تحویل اعلان.
- تأخیر شواهد نوشته‌شده اکنون هشدار دارد: `RastaAuditIngestionLagHigh` (ADR-053 § ۱۳: p95 > ۶۰ ثانیه) — فقط محلی و بی تحویل اعلان.
- Scrape و مسیریابی اعلان محیط واقعی و Alertmanager — وابسته به استقرار و بیرون از مخزن.
- وضعیت Triage برای پیام DLQ، تا بتوان «پیام حل‌نشده» را واقعاً شمرد — امروز وجود ندارد.
