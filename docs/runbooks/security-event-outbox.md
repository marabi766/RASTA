# Runbook: صف ردهای حسابرسی (`security_event_outbox`) گیر کرده یا ثبت ناموفق است

**شدت:** 🟠 هشدار
**متریک محرک:** `rasta_security_event_outbox_closed_backlog_age_seconds > 60` · افزایش
`rasta_security_event_captures_total{outcome=~"failed|timeout"}` ·
افزایش `rasta_security_event_publish_failures_total`
**زمان پاسخ هدف:** ۳۰ دقیقه

> **وضعیت (2026-09-11، AUD-004 Phase C2):** ردها اکنون **پنجره‌ای تجمیع** می‌شوند. ردهای یکسان — همان مستأجر، Actor، فعل،
> Resource و کد خطا — در یک پنجرهٔ UTC به طول `SECURITY_EVENT_AGGREGATION_WINDOW_SECONDS` (پیش‌فرض ۶۰) یک ردیف با
> `occurrence_count` می‌شوند، و Relay هر ردیف را فقط **پس از بسته‌شدن پنجره‌اش** (با ساعت پایگاه داده) Claim و منتشر
> می‌کند. پس یک ردیف منتشرنشده به‌اندازهٔ طول پنجره «در انتظار» است و این **عادی** است؛ هشدار باید روی سن پشتهٔ پنجره‌های
> **بسته** باشد، نه `pending_age`.
>
> **پیشین (Phase C1):** این صف فقط در `identity-service` وجود دارد و فقط **یک** رد را ثبت می‌کند:
> `POST /v1/users/me/active-organization` که `IdentityService.switchActiveOrganization()` با `403 TENANT_MISMATCH` رد
> می‌کند. متریک‌ها تعریف و در `/metrics` صادر می‌شوند؛ **قاعدهٔ هشدار Prometheus برای آن‌ها هنوز در مخزن نوشته نشده** —
> آستانه‌های بالا پیشنهاد این Runbook‌اند، نه هشدار فعال.

---

## علائم

- `rasta_security_event_outbox_closed_backlog_age_seconds` از ۶۰ ثانیه گذشته: پنجره‌ای بسته شده و منتشر نشده است
- `rasta_security_event_outbox_closed_backlog_total` مدام رشد می‌کند
- ردهای `REFUSED` مسیر B در `audit_event` دیده نمی‌شوند (به یاد داشته باش: هر رد دست‌کم تا پایان پنجره‌اش دیر می‌رسد)
- `rasta_security_event_captures_total` با `outcome="failed"` یا `outcome="timeout"` بالا می‌رود

`rasta_security_event_outbox_pending_age_seconds` و `…_pending_total` پنجره‌های باز را هم می‌شمارند؛ نزدیک به طول پنجره
بودنشان نشانهٔ خرابی نیست. `rasta_security_event_outbox_open_windows` تعداد ردیف‌هایی است که هنوز می‌شمارند.

## اثر

**هیچ رد امنیتی سهل‌گیرانه نشده.** فراخوان همیشه همان `403` را گرفته است؛ ثبت حسابرسی هرگز تصمیم مجوز را عوض
نمی‌کند (ADR-053 § ۴، `AGENTS.md` A-12). دو حالت را جدا کن:

| حالت                                           | معنا                                                                                  | قابل بازیابی؟                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------- |
| پشتهٔ پنجره‌های بسته رشد می‌کند (`closed_age`) | ردیف‌ها امن در پایگاه دادهٔ identity هستند و پس از رفع مشکل Kafka/Relay منتشر می‌شوند | ✅ بله — هیچ شاهدی گم نشده            |
| `captures_total{failed\|timeout}` بالا         | آن ردها **در هیچ ردیفی شمرده نشدند**؛ پاسخ `403` درست بود ولی شمارش شاهدش کم است      | ❌ نه — یک **شکاف حسابرسی** واقعی است |

---

## تشخیص فوری

### ۱. صف چقدر عقب است؟ (پایگاه دادهٔ `rasta_identity`)

```sql
SELECT count(*) FILTER (WHERE window_ends_at >  now_utc)             AS open_windows,
       count(*) FILTER (WHERE window_ends_at <= now_utc)             AS closed_backlog,
       EXTRACT(EPOCH FROM now_utc - min(window_ends_at)
                 FILTER (WHERE window_ends_at <= now_utc))           AS closed_age_seconds,
       sum(occurrence_count)                                         AS refusals_waiting,
       max(attempts)                                                 AS max_attempts
  FROM security_event_outbox,
       LATERAL (SELECT (statement_timestamp() AT TIME ZONE 'UTC')::timestamp(3) AS now_utc) c
 WHERE published_at IS NULL;
```

### ۲. خطای تکراری انتشار؟

```sql
SELECT attempts, last_error, count(*)
  FROM security_event_outbox
 WHERE published_at IS NULL AND attempts > 0
 GROUP BY attempts, last_error
 ORDER BY count(*) DESC
 LIMIT 20;
```

`last_error` فقط نام کلاس خطا و پیامِ Kafka یا یک عبارت ثابت دارد — هرگز مقدار ردیف. اگر با
`AuditTrailContractError` شروع شود، ردیف پیش از انتشار با Contract ناسازگار تشخیص داده شده (نقص Producer)، نه خرابی
Kafka؛ `rasta_security_event_publish_failures_total{reason="contract_violation"}` همین را می‌شمارد.

### ۳. Claim زنده یا گیرکرده؟

```sql
SELECT count(*) FILTER (WHERE claim_expires_at > now())  AS live_leases,
       count(*) FILTER (WHERE claim_expires_at <= now()) AS expired_leases,
       count(*) FILTER (WHERE next_attempt_at > now())   AS waiting_retry
  FROM security_event_outbox
 WHERE published_at IS NULL;
```

### ۴. تجمیع کار می‌کند؟

`rasta_security_event_aggregations_total{result}`: نسبت `incremented` به `created` نسبت تجمیع است. هر
`ceiling_reached` یعنی یک ردیف به سقف `2147483647` رسیده و رد بعدی همان پنجره ردیف جانشین ساخته — شمارش گم نشده.

### ۵. Kafka و Topic

- `GET /health/ready` روی identity-service: `checks.kafka` باید `true` باشد. Kafka از Readiness بیرون است (ADR-021)،
  پس سرویس سالم دیده می‌شود حتی وقتی صف منتشر نمی‌شود.
- Topic `rasta.audit.trail.v1` باید وجود داشته باشد — Producer `allowAutoTopicCreation: false` است.

---

## اقدام

1. **Kafka در دسترس نیست یا Topic وجود ندارد:** Kafka را برگردان / Topic را با `create-topics.sh` بساز. Relay خودکار
   ادامه می‌دهد؛ Backoff سقف `OUTBOX_CLAIM_BACKOFF_MAX_SECONDS` دارد.
2. **`AuditTrailContractError`:** Producer را اصلاح و Deploy کن. ردیف‌ها در صف می‌مانند و پس از Deploy در تلاش بعدی
   منتشر می‌شوند. **ردیف را دستی ویرایش یا حذف نکن** — شواهد است؛ Trigger `tg_security_event_outbox_guard` ویرایش ستون‌های
   شواهد، پنجره و شمارشِ ردیف Claim‌شده را هر طور رد می‌کند.
3. **Lease گیرکرده پس از Crash:** کاری لازم نیست؛ پس از `OUTBOX_CLAIM_LEASE_SECONDS` هر Relay دیگری آن را پس
   می‌گیرد (ADR-050). `rasta_security_event_lease_reclaimed_total` بالا می‌رود.
4. **`captures_total{timeout}` بالا:** پایگاه دادهٔ identity کند یا قفل‌شده است. `pg_stat_activity` را برای قفل روی
   `security_event_outbox` بررسی کن. **در یک کاوش شدید این مورد انتظار است:** همهٔ ردهای یک Actor در یک پنجره روی **یک
   ردیف** قفل می‌گیرند و گذردهی آن ردیف با تأخیر Commit (WAL flush) پایگاه داده محدود است — روی Volume توسعهٔ Docker Desktop
   حدود ۲۳ تا ۲۹ ثبت در ثانیه اندازه‌گیری شد. ثبت‌هایی که بیش از `SECURITY_EVENT_CAPTURE_TIMEOUT_MS` در صف قفل بمانند
   شمرده نمی‌شوند. افزایش آن مقدار (سقف ۵۰۰۰) شکاف را کم می‌کند ولی هر `403` را تا همان مقدار کندتر می‌کند — تصمیم آگاهانه،
   نه پیش‌فرض. `synchronous_commit` برای این جدول عمداً پایین نیامده است.
5. **`captures_total{failed}` بالا:** Log خطای `Refusal audit capture did not complete` را با `errorClass` و `errorCode`
   بخوان (هیچ مقدار ردیفی ندارد). ردهای ثبت‌نشده **بازیابی نمی‌شوند**؛ بازهٔ زمانی شکاف را در گزارش حادثه ثبت کن.
6. **پنجره نامناسب است:** `SECURITY_EVENT_AGGREGATION_WINDOW_SECONDS` را (بازهٔ ۱..۳۶۰۰) تغییر بده و سرویس را دوباره
   راه بینداز. در زمان استقرار ممکن است ردیف‌هایی با دو طول پنجرهٔ متفاوت کنار هم باشند — هیچ شمارشی گم یا ادغام نمی‌شود.

## تأیید رفع

- `rasta_security_event_outbox_closed_backlog_age_seconds` به زیر ۶۰ برمی‌گردد و `closed_backlog_total` کم می‌شود.
- یک ردیف تازه در `audit_event` با `source_topic = 'rasta.audit.trail.v1'` و `source_service = 'identity-service'`
  ظاهر می‌شود؛ `occurrence_count` آن برابر همان ردیف `security_event_outbox` است.

## بازگشت Migration تجمیع

`20260911130000_security_event_outbox_aggregation/down.sql` پیش از اجرا تخلیه می‌خواهد: تا
`SELECT count(*) FROM security_event_outbox WHERE published_at IS NULL AND occurrence_count > 1` صفر نشده، کد Phase C1
ردیف تجمیع‌شده را با شمارش ۱ منتشر می‌کرد. اول کد را برگردان، سپس Migration را.

## پیشگیری

- قاعدهٔ هشدار Prometheus برای این متریک‌ها بنویس (هنوز نیست) — روی `closed_backlog_age_seconds`، نه `pending_age_seconds`.
- Purge ردیف‌های منتشرشده هنوز وجود ندارد؛ رشد جدول را پایش کن (تجمیع رشد را به یک ردیف در هر پنجره به‌ازای هر Actor
  کاوشگر محدود کرده، نه یک ردیف به‌ازای هر رد).
