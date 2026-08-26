# Runbook: بررسی و بازپخش DLQ

**شدت:** 🟠 هشدار
**هشدار محرک:** `rasta_dlq_messages_total` افزایش یافت (**هر پیام جدید**)
**زمان پاسخ هدف:** ۲ ساعت (۱۵ دقیقه اگر رویداد مالی است)

---

## علائم

پیامی وارد `rasta.<domain>.v1.dlq` شده است.

## اثر

یک رویداد پردازش نشده. اثر بستگی به رویداد دارد:

| رویداد                    | اثر                                           |
| ------------------------- | --------------------------------------------- |
| `ORDER_RECEIPT_CONFIRMED` | **تسویه انجام نشد — پول کاربر Hold مانده** 🔴 |
| `STATEMENT_APPROVED`      | **پرداخت پیمانکار انجام نشد** 🔴              |
| `MAINTENANCE_DUE`         | اعلان سررسید نرفت 🟠                          |
| `ASSET_UPDATED`           | Read Model کهنه ماند 🟡                       |

**DLQ صندوق فراموشی نیست.** هر پیام باید بررسی و تعیین تکلیف شود.

---

## تشخیص

### ۱. چه چیزی در DLQ است؟

```bash
docker compose exec kafka kafka-console-consumer.sh \
  --bootstrap-server localhost:9094 \
  --topic rasta.marketplace.v1.dlq \
  --from-beginning --max-messages 20 \
  --property print.headers=true
```

Headerهای کلیدی:

| Header                  | معنا                  |
| ----------------------- | --------------------- |
| `x-dlq-reason`          | دلیل دسته‌بندی‌شده    |
| `x-dlq-original-topic`  | Topic مبدأ            |
| `x-dlq-attempts`        | تعداد تلاش پیش از DLQ |
| `x-dlq-error`           | متن خطا               |
| `x-dlq-first-failed-at` | نخستین شکست           |

### ۲. عمق DLQ به تفکیک دلیل

```bash
docker compose exec kafka kafka-run-class.sh kafka.tools.GetOffsetShell \
  --bootstrap-server localhost:9094 --topic rasta.marketplace.v1.dlq
```

### ۳. آیا رویداد مالی است؟

```
🔴 رویدادهای مالی — نیازمند بررسی انسانی، هرگز بازپخش خودکار:
   ORDER_RECEIPT_CONFIRMED · PAYMENT_* · COMMISSION_APPLIED
   SETTLEMENT_COMPLETED · STATEMENT_APPROVED · JOURNAL_POSTED
```

---

## اقدام

### گام ۱ — دسته‌بندی علت

| `x-dlq-reason`               | معنا                            | اقدام                                            |
| ---------------------------- | ------------------------------- | ------------------------------------------------ |
| `VALIDATION_FAILED`          | Payload با Schema نمی‌خواند     | باگ Producer — رفع کن، سپس بازپخش                |
| `SCHEMA_VERSION_UNSUPPORTED` | Consumer نسخه را نمی‌شناسد      | Consumer را به‌روز کن، سپس بازپخش                |
| `BUSINESS_RULE_VIOLATION`    | رویداد در وضعیت فعلی معتبر نیست | **بررسی دستی** — ممکن است بازپخش نباید انجام شود |
| `UPSTREAM_UNAVAILABLE`       | وابستگی در دسترس نبود           | وابستگی را برگردان، سپس بازپخش                   |
| `MAX_RETRIES_EXCEEDED`       | خطای گذرا که ادامه یافت         | علت را بررسی کن، سپس بازپخش                      |

### گام ۲ — رفع علت ریشه‌ای

**پیش از بازپخش، علت را رفع کن.** بازپخش بدون رفع، پیام را دوباره به DLQ می‌فرستد.

### گام ۳ — بازپخش

**رویداد غیرمالی:**

```bash
pnpm --filter @rasta/<service> exec node dist/scripts/replay-dlq.js \
  --topic rasta.marketplace.v1.dlq \
  --target rasta.marketplace.v1 \
  --max 100 \
  --dry-run          # ← اول همیشه با dry-run

# پس از بررسی خروجی:
pnpm --filter @rasta/<service> exec node dist/scripts/replay-dlq.js \
  --topic rasta.marketplace.v1.dlq \
  --target rasta.marketplace.v1 \
  --max 100
```

بازپخش امن است چون مصرف‌کننده‌ها Idempotent‌اند (`processed_event`).

**رویداد مالی:** ⛔

```
۱. اثر مالی را دستی بررسی کن:
   - آیا Hold هنوز فعال است؟
   - آیا Journal ناقصی Post شده؟
   - وضعیت واقعی سفارش یا صورت‌وضعیت چیست؟
۲. تأیید بگیر (مسئول عملیات مالی)
۳. تک‌پیام بازپخش کن، نه دسته‌ای
۴. بلافاصله توازن دفتر کل را بررسی کن
```

### گام ۴ — پیامی که نباید بازپخش شود

اگر رویداد واقعاً نامعتبر است (مثلاً یک باگ Producer که هرگز نباید آن رویداد را می‌ساخت):

```
۱. تصمیم و دلیل را مستند کن
۲. Offset را Commit کن بدون پردازش
۳. یک مورد در Backlog برای رفع باگ Producer ثبت کن
```

**هرگز** بی‌سر و صدا رها نکن.

---

## تأیید رفع

```bash
# DLQ نباید رشد کند
docker compose exec kafka kafka-run-class.sh kafka.tools.GetOffsetShell \
  --bootstrap-server localhost:9094 --topic rasta.marketplace.v1.dlq
```

- متریک `rasta_dlq_messages_total` ثابت مانده
- اثر کسب‌وکاری رویداد بازپخش‌شده در پایگاه داده دیده می‌شود
- اگر مالی بود: توازن دفتر کل بررسی شده

---

## پیشگیری

- اعتبارسنجی Schema **پیش از** درج در Outbox
- تست قرارداد برای هر رویداد و هر مصرف‌کننده در CI
- تغییر شکننده Schema فقط با فرآیند سه‌استقراری
- هشدار روی نخستین پیام DLQ — نه روی آستانه
