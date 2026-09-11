# Runbook: صف ردهای حسابرسی (`security_event_outbox`) گیر کرده یا ثبت ناموفق است

**شدت:** 🟠 هشدار
**متریک محرک:** `rasta_security_event_outbox_pending_age_seconds > 60` · افزایش
`rasta_security_event_captures_total{outcome=~"failed|timeout"}` ·
افزایش `rasta_security_event_publish_failures_total`
**زمان پاسخ هدف:** ۳۰ دقیقه

> **وضعیت (2026-09-11، AUD-004 Phase C1):** این صف فقط در `identity-service` وجود دارد و فقط **یک** رد را ثبت
> می‌کند: `POST /v1/users/me/active-organization` که `IdentityService.switchActiveOrganization()` با
> `403 TENANT_MISMATCH` رد می‌کند. متریک‌ها تعریف و در `/metrics` صادر می‌شوند؛ **قاعدهٔ هشدار Prometheus برای آن‌ها
> هنوز در مخزن نوشته نشده** — آستانه‌های بالا پیشنهاد این Runbook‌اند، نه هشدار فعال.

---

## علائم

- سن قدیمی‌ترین ردیف منتشرنشده در `security_event_outbox` از ۶۰ ثانیه گذشته
- `rasta_security_event_outbox_pending_total` مدام رشد می‌کند
- ردهای `REFUSED` مسیر B در `audit_event` دیده نمی‌شوند
- `rasta_security_event_captures_total` با `outcome="failed"` یا `outcome="timeout"` بالا می‌رود

## اثر

**هیچ رد امنیتی سهل‌گیرانه نشده.** فراخوان همیشه همان `403` را گرفته است؛ ثبت حسابرسی هرگز تصمیم مجوز را عوض
نمی‌کند (ADR-053 § ۴، `AGENTS.md` A-12). دو حالت را جدا کن:

| حالت                                   | معنا                                                                                  | قابل بازیابی؟                         |
| -------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------- |
| صف رشد می‌کند (`pending_age` بالا)     | ردیف‌ها امن در پایگاه دادهٔ identity هستند و پس از رفع مشکل Kafka/Relay منتشر می‌شوند | ✅ بله — هیچ شاهدی گم نشده            |
| `captures_total{failed\|timeout}` بالا | آن ردها **هیچ ردیفی** نساختند؛ پاسخ `403` درست بود ولی شاهدش ثبت نشد                  | ❌ نه — یک **شکاف حسابرسی** واقعی است |

---

## تشخیص فوری

### ۱. صف چقدر عقب است؟ (پایگاه دادهٔ `rasta_identity`)

```sql
SELECT count(*)                                   AS pending,
       min(created_at)                            AS oldest,
       EXTRACT(EPOCH FROM now() - min(created_at)) AS age_seconds,
       max(attempts)                              AS max_attempts
  FROM security_event_outbox
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

### ۴. Kafka و Topic

- `GET /health/ready` روی identity-service: `checks.kafka` باید `true` باشد. Kafka از Readiness بیرون است (ADR-021)،
  پس سرویس سالم دیده می‌شود حتی وقتی صف منتشر نمی‌شود.
- Topic `rasta.audit.trail.v1` باید وجود داشته باشد — Producer `allowAutoTopicCreation: false` است.

---

## اقدام

1. **Kafka در دسترس نیست یا Topic وجود ندارد:** Kafka را برگردان / Topic را با `create-topics.sh` بساز. Relay خودکار
   ادامه می‌دهد؛ Backoff سقف `OUTBOX_CLAIM_BACKOFF_MAX_SECONDS` دارد.
2. **`AuditTrailContractError`:** Producer را اصلاح و Deploy کن. ردیف‌ها در صف می‌مانند و پس از Deploy در تلاش بعدی
   منتشر می‌شوند. **ردیف را دستی ویرایش یا حذف نکن** — شواهد است.
3. **Lease گیرکرده پس از Crash:** کاری لازم نیست؛ پس از `OUTBOX_CLAIM_LEASE_SECONDS` هر Relay دیگری آن را پس
   می‌گیرد (ADR-050). `rasta_security_event_lease_reclaimed_total` بالا می‌رود.
4. **`captures_total{timeout}` بالا:** پایگاه دادهٔ identity کند یا قفل‌شده است. `pg_stat_activity` را برای قفل روی
   `security_event_outbox` بررسی کن. افزایش `SECURITY_EVENT_CAPTURE_TIMEOUT_MS` (سقف ۵۰۰۰) شکاف را کم می‌کند ولی هر
   `403` را تا همان مقدار کندتر می‌کند — تصمیم آگاهانه، نه پیش‌فرض.
5. **`captures_total{failed}` بالا:** Log خطای `Refusal audit capture did not complete` را با `errorClass` و `errorCode`
   بخوان (هیچ مقدار ردیفی ندارد). ردهای ثبت‌نشده **بازیابی نمی‌شوند**؛ بازهٔ زمانی شکاف را در گزارش حادثه ثبت کن.

## تأیید رفع

- `rasta_security_event_outbox_pending_age_seconds` به زیر ۶۰ برمی‌گردد و `pending_total` کم می‌شود.
- یک ردیف تازه در `audit_event` با `source_topic = 'rasta.audit.trail.v1'` و `source_service = 'identity-service'`
  ظاهر می‌شود.

## پیشگیری

- قاعدهٔ هشدار Prometheus برای این متریک‌ها بنویس (هنوز نیست).
- تجمیع پنجره‌ای ردها (ADR-053 § ۴) هنوز پیاده نشده؛ تا آن زمان هر رد یک ردیف است و یک حملهٔ کاوشی حجم صف را
  به‌همان نسبت بالا می‌برد.
- Purge ردیف‌های منتشرشده هنوز وجود ندارد؛ رشد جدول را پایش کن.
