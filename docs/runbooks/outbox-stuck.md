# Runbook: Outbox Relay گیر کرده

**شدت:** 🟠 هشدار
**هشدار محرک:** `rasta_outbox_pending_age_seconds > 60`
**زمان پاسخ هدف:** ۳۰ دقیقه

---

## علائم

- سن قدیمی‌ترین پیام منتشرنشده در `outbox_message` از ۶۰ ثانیه گذشته
- `rasta_outbox_pending_total` مدام رشد می‌کند
- مصرف‌کننده‌های Downstream رویداد نمی‌گیرند (اعلان نمی‌رسد، کارمزد محاسبه نمی‌شود)

## اثر

**هیچ داده‌ای گم نشده** — این مهم‌ترین نکته است. رویدادها در پایگاه داده امن‌اند و پس از
رفع مشکل منتشر می‌شوند. اما فرآیندهای Downstream **متوقف‌اند**: تسویه انجام نمی‌شود،
اعلان نمی‌رود، Read Model کهنه می‌ماند.

---

## تشخیص

### ۱. کدام سرویس و چقدر عقب است؟

```sql
SELECT COUNT(*) AS pending,
       MIN(created_at) AS oldest,
       EXTRACT(EPOCH FROM now() - MIN(created_at)) AS age_seconds,
       MAX(attempts) AS max_attempts
FROM outbox_message
WHERE published_at IS NULL;
```

### ۲. آیا خطای تکراری وجود دارد؟

```sql
SELECT topic, event_name, attempts, last_error, COUNT(*)
FROM outbox_message
WHERE published_at IS NULL AND last_error IS NOT NULL
GROUP BY topic, event_name, attempts, last_error
ORDER BY COUNT(*) DESC
LIMIT 20;
```

### ۳. آیا Kafka سالم است؟

```bash
docker compose exec kafka kafka-topics.sh --bootstrap-server localhost:9094 --list
docker compose exec kafka kafka-topics.sh --bootstrap-server localhost:9094 \
  --describe --topic rasta.marketplace.v1
```

### ۴. آیا Relay اصلاً زنده است؟

```bash
docker compose logs --tail=200 marketplace-service | grep -i outbox
# در Kubernetes:
kubectl logs -l app=marketplace-service -n rasta-prod --tail=200 | grep -i outbox
```

---

## اقدام

### علت A — Kafka در دسترس نیست

```
۱. وضعیت Broker را بررسی کن
۲. Kafka را برگردان
۳. Relay خودکار از سر می‌گیرد — هیچ اقدام دستی لازم نیست
۴. کاهش صف را پایش کن
```

### علت B — Topic وجود ندارد

`auto.create.topics.enable=false` است، پس تولید روی Topic ناشناخته شکست می‌خورد.
این معمولاً یعنی یک رویداد جدید بدون افزودن Topic مستقر شده.

```bash
docker compose exec kafka bash /create-topics.sh
# یا در Production، Topic خاص را بساز
```

سپس بررسی کن چرا Topic در `create-topics.sh` نبوده — این یک نقص فرآیندی است.

### علت C — Payload نامعتبر

اگر یک پیام خاص مدام شکست می‌خورد و بقیه را متوقف کرده:

```sql
SELECT id, event_name, topic, attempts, last_error, payload
FROM outbox_message
WHERE published_at IS NULL AND attempts > 5
ORDER BY created_at LIMIT 10;
```

**اگر رویداد مالی نیست** و Payload واقعاً نامعتبر است:

```sql
-- به‌عنوان شکست‌خورده علامت بزن تا صف باز شود؛ داده حفظ می‌شود
UPDATE outbox_message
SET published_at = now(), last_error = 'MANUALLY SKIPPED — incident <شماره>'
WHERE id = $1;
```

**اگر رویداد مالی است:** ⛔ **هرگز Skip نکن.** به
[`ledger-imbalance.md`](ledger-imbalance.md) مراجعه کن و علت ریشه‌ای را رفع کن.

### علت D — Relay متوقف شده

```bash
kubectl rollout restart deployment/<service> -n rasta-prod
# محلی:
pnpm --filter @rasta/<service> dev
```

### علت E — حجم بالا، Relay عقب مانده

اگر خطایی نیست و فقط سرعت کم است:

```
۱. OUTBOX_BATCH_SIZE را افزایش بده (پیش‌فرض ۱۰۰)
۲. OUTBOX_POLL_INTERVAL_MS را کاهش بده (پیش‌فرض ۵۰۰)
۳. Replica سرویس را افزایش بده — اما بدان که تا پیاده‌سازی ADR-050،
   `FOR UPDATE SKIP LOCKED` چند Instance را ایمن **نمی‌کند**: قفلش با پایان
   همان جمله تمام می‌شود و دو رله می‌توانند یک ردیف را منتشر کنند (D-026).
   بیشتر کردن Replica یعنی بیشتر شدن انتشار تکراری، نه فقط بیشتر شدن سرعت.
```

---

## تأیید رفع

```sql
SELECT COUNT(*) AS pending,
       EXTRACT(EPOCH FROM now() - MIN(created_at)) AS age_seconds
FROM outbox_message WHERE published_at IS NULL;
-- age_seconds باید زیر ۶۰ برگردد و pending رو به کاهش باشد
```

متریک `rasta_outbox_pending_age_seconds` باید به حالت عادی برگردد.

---

## پیشگیری

- `create-topics.sh` باید بخشی از Checklist افزودن رویداد جدید باشد
- اعتبارسنجی Schema **پیش از** درج در Outbox، نه هنگام انتشار
- هشدار روی `attempts > 5` برای تشخیص زودتر
- پایش `rasta_outbox_pending_total` در داشبورد Event Pipeline
