# ۰۷ — Event Architecture

> Kafka به‌عنوان ستون فقرات رویداد. هر رویداد **Versioned**، **Idempotent** و **Documented**.

---

## ۷٫۱ چرا Kafka

| نیاز پلتفرم                             | چرا Kafka و نه RabbitMQ/NATS                                   |
| --------------------------------------- | -------------------------------------------------------------- |
| ترتیب رویدادهای یک دارایی/سفارش/کیف پول | ترتیب تضمین‌شده **به‌ازای پارتیشن**؛ کلید = شناسه Aggregate    |
| بازپخش تاریخی برای ساخت Read Model جدید | Log ماندگار؛ Consumer جدید از Offset صفر می‌خواند              |
| چند مصرف‌کننده مستقل از یک جریان        | Consumer Group؛ `audit`, `analytics`, `notification` مستقل‌اند |
| حسابرسی‌پذیری جریان مالی                | Log تغییرناپذیر، قابل استناد                                   |
| رشد به مقیاس ملی                        | مقیاس افقی با افزودن پارتیشن                                   |

معاوضه: Kafka برای بار فاز ۱ **بیش از حد** است. این آگاهانه پذیرفته شده — دلیل در
[`23-risks-and-tradeoffs.md`](23-risks-and-tradeoffs.md) و ADR-006.

---

## ۷٫۲ نام‌گذاری Topic

```
rasta.<domain>.v<major>          جریان اصلی
rasta.<domain>.v<major>.retry    تلاش مجدد با تأخیر
rasta.<domain>.v<major>.dlq      نامه‌های مرده
rasta.audit.trail.v1             جریان حسابرسی (همه سرویس‌ها می‌نویسند)
```

`<major>` نسخه **Envelope** است، نه نسخه Payload. نسخه هر رویداد در `eventVersion` داخل
Envelope می‌آید تا یک Topic بتواند در طول یک Rollout جریان چندنسخه‌ای حمل کند.

| Topic                     | پارتیشن (dev/prod) | نگهداشت                    |
| ------------------------- | ------------------ | -------------------------- |
| `rasta.<domain>.v1`       | ۳ / ۱۲             | ۷ روز                      |
| `rasta.<domain>.v1.retry` | ۳ / ۱۲             | ۷ روز                      |
| `rasta.<domain>.v1.dlq`   | ۱ / ۳              | ۳۰ روز                     |
| `rasta.audit.trail.v1`    | ۳ / ۱۲             | **بی‌نهایت در Production** |

**CONSTRAINT.** `auto.create.topics.enable=false`. تولید روی Topic ناشناخته یک نقض قرارداد
است و باید بلند شکست بخورد، نه اینکه بی‌صدا Topic با تنظیمات پیش‌فرض بسازد.

ساخت Topicها: [`infrastructure/docker/kafka/create-topics.sh`](../infrastructure/docker/kafka/create-topics.sh)

---

## ۷٫۳ Envelope رویداد

**هر** پیام Kafka این شکل را دارد:

```jsonc
{
  "eventId": "01JBQ8Z4K7M2N5P8R1T3V6X9Y2", // ULID — کلید Idempotency مصرف‌کننده
  "eventName": "ORDER_COMPLETED",
  "eventVersion": 1,
  "occurredAt": "2026-08-26T10:15:30.123Z", // زمان وقوع در دامنه، نه زمان انتشار
  "producer": "marketplace-service",
  "producerVersion": "0.3.1",

  "aggregateType": "Order",
  "aggregateId": "ORD_01JBQ8Z4K7M2N5P8R1T3V6X9Y2",
  "aggregateVersion": 7, // تشخیص رویداد از دست رفته یا نامرتب

  "tenantId": "ORG_01JBQ8...", // ⚠️ مصرف‌کننده باید اعمالش کند
  "correlationId": "01JBQ8Z4K7M2N5P8R1T3V6X9Y2",
  "causationId": "01JBQ8Z4K7M2N5P8R1T3V6X9Y1", // رویداد یا فرمان مسبب
  "traceparent": "00-4bf92f3577b34da6...-01", // W3C Trace Context

  "actor": { "type": "USER", "id": "USR_01JBQ8..." },

  "payload": {}, // مطابق Schema این رویداد و این نسخه
}
```

### قواعد Payload

| قاعده                                           | چرا                                                                 |
| ----------------------------------------------- | ------------------------------------------------------------------- |
| **شناسه حمل کن، نه داده شخصی**                  | رویداد ماندگار است؛ داده شخصی در Log ماندگار یک بدهی حریم خصوصی است |
| **پول همیشه `{amountMinor: string, currency}`** | همان قرارداد API                                                    |
| **زمان همیشه ISO-8601 با UTC**                  | بدون ابهام منطقه زمانی                                              |
| **بدون فیلد اختیاری بی‌معنا**                   | `undefined` در برابر `null` منبع باگ Consumer است                   |
| **Payload خودبسنده برای هدف اصلی رویداد**       | Consumer نباید برای کار عادی‌اش REST بزند                           |

---

## ۷٫۴ Transactional Outbox

**CONSTRAINT.** هیچ رویدادی مستقیماً از یک Service Method منتشر نمی‌شود.

```
┌─ تراکنش پایگاه داده (اتمیک) ────────────────┐
│  1. UPDATE order SET status='COMPLETED'      │
│  2. INSERT INTO outbox_message (...)         │
└──────────────────┬───────────────────────────┘
                   │ COMMIT
                   ▼
        ┌──────────────────────┐
        │  Outbox Relay        │  هر ۵۰۰ میلی‌ثانیه Poll
        │  FOR UPDATE SKIP LOCKED │  (چند Instance ایمن)
        └──────────┬───────────┘
                   │ produce (acks=all, idempotent producer)
                   ▼
              Kafka Topic
                   │
                   ▼
        UPDATE outbox_message SET published_at = now()
```

**تضمین: At-Least-Once.** ممکن است یک رویداد دو بار منتشر شود (اگر Crash بین Produce و
به‌روزرسانی `published_at` رخ دهد). این پذیرفته شده، چون **همه مصرف‌کننده‌ها Idempotent‌اند**.
تضمین Exactly-Once در سیستم توزیع‌شده گران و شکننده است؛ At-Least-Once + Idempotency
همان نتیجه را ارزان‌تر می‌دهد.

تنظیمات Producer:

```
acks=all
enable.idempotence=true
max.in.flight.requests.per.connection=5
retries=Integer.MAX_VALUE
compression.type=lz4
```

---

## ۷٫۵ Idempotency مصرف‌کننده

```
پیام می‌رسد
   │
   ▼
INSERT INTO processed_event (event_id, consumer_name)
   │
   ├─ نقض کلید یکتا ──► رویداد تکراری ──► Commit Offset، پایان
   │
   ▼ موفق
پردازش در همان تراکنش
   │
   ▼
COMMIT ──► Commit Offset
```

**قاعده.** درج `processed_event` و اثر کسب‌وکاری در **یک تراکنش** انجام می‌شوند.
اگر پردازش شکست بخورد، درج هم Rollback می‌شود و پیام دوباره پردازش‌پذیر می‌ماند.

نگهداشت `processed_event`: ۳۰ روز (بیش از حداکثر نگهداشت Topic).

---

## ۷٫۶ Retry و DLQ

```
   Topic اصلی
       │ شکست
       ▼
  آیا خطا گذراست؟ ──── نه ────► DLQ مستقیم
       │ بله                    (خطای اعتبارسنجی، Schema نامعتبر،
       ▼                          نقض قاعده کسب‌وکار)
  attempt < 5؟ ──── نه ────► DLQ
       │ بله
       ▼
  Topic retry با تأخیر: 1s → 5s → 30s → 2m → 10m
```

| نوع خطا                             | رفتار                               |
| ----------------------------------- | ----------------------------------- |
| قطع شبکه، Timeout، افت موقت وابستگی | Retry با Backoff                    |
| Deadlock پایگاه داده                | Retry فوری (حداکثر ۳)               |
| Payload نامعتبر یا Schema ناسازگار  | **DLQ مستقیم** — Retry کمکی نمی‌کند |
| نقض قاعده کسب‌وکار                  | **DLQ مستقیم** + هشدار              |
| رویداد ناشناخته                     | Log + Skip (سازگاری رو به جلو)      |

**قواعد DLQ:**

- هر پیام DLQ Headerهای `x-dlq-reason`، `x-dlq-original-topic`، `x-dlq-attempts`،
  `x-dlq-error` و `x-dlq-first-failed-at` را حمل می‌کند.
- ورود پیام به DLQ **هشدار تولید می‌کند** — DLQ صندوق فراموشی نیست.
- بازپخش دستی از راه Runbook: [`runbooks/replay-dlq.md`](runbooks/replay-dlq.md)
- **CONSTRAINT.** پیام DLQ حاوی رویداد مالی هرگز خودکار بازپخش نمی‌شود؛ نیازمند بررسی انسانی.

---

## ۷٫۷ ترتیب و پارتیشن‌بندی

**دو مفهوم، نه یکی.** `aggregateType`/`aggregateId` می‌گویند رویداد **درباره
چیست**؛ `partitionKey` می‌گوید رویداد باید **با چه چیزی مرتب بماند**. این دو
معمولاً یکی‌اند و گاهی عمداً نیستند (ADR-036).

| دامنه                    | کلید پارتیشن            | تضمین                                                      |
| ------------------------ | ----------------------- | ---------------------------------------------------------- |
| Asset                    | `assetId`               | همه رویدادهای یک دارایی مرتب                               |
| Fleet · Maintenance      | `assetId`               | استثنای مستند — مصرف‌کننده درباره یک دستگاه استدلال می‌کند |
| **Economic — تراکنشی**   | **`transactionId`**     | **کل چرخه مالی یک تراکنش مرتب** (ADR-036)                  |
| Economic — کیف‌پول‌محض   | `walletId`              | `WALLET_OPENED`                                            |
| Economic — Journal محض   | `journalId`             | سندی که به تراکنشی تعلق ندارد                              |
| Economic — پرداخت پیش‌تر | `paymentIntentId`       | پیش از آنکه تراکنشی وجود داشته باشد                        |
| Economic — پاداش         | `rewardId` · `org:user` | چرخه یک پاداش · موجودی یک شخص                              |
| **Marketplace — سفارش**  | **`orderId`**           | **کل چرخه‌عمر یک سفارش مرتب** (ADR-036 روی این دامنه)      |
| Marketplace — عرضه       | `offerId`               | تغییر قیمت یک عرضه به ترتیب اعمال می‌شود                   |
| Tender                   | `tenderId`              | چرخه مناقصه مرتب                                           |
| Contract                 | `contractId`            | چرخه صورت‌وضعیت مرتب                                       |
| Organization             | `organizationId`        | تغییرات سازمان مرتب                                        |

**قاعده.** کلید پارتیشن **پیش‌فرض** `aggregateId` است و انحراف از آن باید صریح و
مستند باشد — امروز چهار انحراف داریم: `assetId` در `fleet` و `maintenance`،
`transactionId` در رویدادهای تراکنشی `economic`، و `orderId` در رویدادهای
چرخه‌عمر سفارش `marketplace` (که `REVIEW_SUBMITTED` را هم شامل می‌شود، با آنکه
Aggregate اش `Review` است).

ترتیب سراسری تضمین نمی‌شود و لازم هم نیست. اگر یک Consumer به ترتیب میان دو
Aggregate نیاز دارد، یا آن دو در واقع **یک** چرخه‌عمرند و باید یک کلید بگیرند
(کاری که ADR-036 برای تراکنش کرد)، یا طراحی‌اش اشتباه است و باید از
`aggregateVersion` یا یک Saga استفاده کند.

> ردیف «Wallet — بحرانی: Hold/Release/Settle نباید نامرتب پردازش شوند» پیش‌تر
> `walletId` می‌گفت. آن نیت با `transactionId` **بهتر** برآورده می‌شود: یک Hold و
> Release آن همیشه به یک تراکنش تعلق دارند، در حالی که `walletId` رویدادهای دو
> تراکنش بی‌ربط را هم در یک صف می‌بافت. موجودی کیف پول از دفتر کل و زیر قفل ردیف
> بازمحاسبه می‌شود، نه از ترتیب مصرف رویداد.

---

## ۷٫۸ نسخه‌گذاری Schema

| تغییر                 | شکننده؟ | اقدام                                          |
| --------------------- | ------- | ---------------------------------------------- |
| افزودن فیلد اختیاری   | ❌      | همان `eventVersion`                            |
| افزودن مقدار Enum     | ⚠️      | همان نسخه؛ Consumer باید ناشناخته را تحمل کند  |
| حذف یا تغییر نام فیلد | ✅      | `eventVersion` جدید؛ هر دو نسخه منتشر شوند     |
| تغییر نوع فیلد        | ✅      | `eventVersion` جدید                            |
| تغییر معنای فیلد      | ✅      | **رویداد جدید با نام جدید** — نه فقط نسخه جدید |

**فرآیند تغییر شکننده (سه استقرار):**

```
۱. Producer هر دو نسخه v1 و v2 را منتشر می‌کند
۲. همه Consumerها به v2 مهاجرت می‌کنند (پایش با متریک)
۳. Producer انتشار v1 را متوقف می‌کند
```

اعتبارسنجی: هر رویداد در **زمان انتشار** و در **زمان مصرف** با Zod Schema اعتبارسنجی می‌شود.
Payload نامعتبر هرگز به Kafka نمی‌رسد و هرگز بی‌صدا پردازش نمی‌شود.

---

## ۷٫۹ کاتالوگ رویدادها

> فهرست کامل با Schema، Producer، Consumer، ترتیب، Retry و DLQ:
> [`events/catalog.md`](events/catalog.md)

### Identity · Organization

| رویداد                           | Producer     | مصرف‌کنندگان اصلی                           |
| -------------------------------- | ------------ | ------------------------------------------- |
| `USER_REGISTERED`                | identity     | notification · audit · analytics            |
| `USER_ACTIVATED`                 | identity     | notification · economic (باز کردن کیف پول)  |
| `USER_DEACTIVATED`               | identity     | همه (ابطال Session)                         |
| `MEMBERSHIP_CREATED`             | identity     | audit · analytics                           |
| `ROLE_ASSIGNED` / `ROLE_REVOKED` | identity     | audit · gateway (ابطال Cache مجوز)          |
| `ORGANIZATION_CREATED`           | organization | **همه** (Replica مرجع) · economic (کیف پول) |
| `ORGANIZATION_UPDATED`           | organization | همه (Replica مرجع)                          |
| `ORGANIZATION_DEACTIVATED`       | organization | identity (ابطال عضویت) · همه                |

### Asset · Fleet · Maintenance · Insurance

| رویداد                                | Producer    | مصرف‌کنندگان اصلی                                                   |
| ------------------------------------- | ----------- | ------------------------------------------------------------------- |
| `ASSET_CREATED`                       | asset       | fleet · analytics · audit · search                                  |
| `ASSET_ACTIVATED`                     | asset       | fleet · analytics                                                   |
| `ASSET_UPDATED`                       | asset       | fleet · search · analytics                                          |
| `ASSET_TRANSFERRED`                   | asset       | fleet · analytics · audit                                           |
| `ASSET_STATUS_CHANGED`                | asset       | fleet · construction · analytics                                    |
| `ASSET_DECOMMISSIONED`                | asset       | fleet · maintenance · analytics                                     |
| `USAGE_RECORDED`                      | fleet       | **maintenance (محرک سرویس)** · asset · economic (پاداش) · analytics |
| `ASSET_ASSIGNED` / `ASSIGNMENT_ENDED` | fleet       | asset · analytics                                                   |
| `AVAILABILITY_CHANGED`                | fleet       | construction · analytics                                            |
| `MAINTENANCE_DUE`                     | maintenance | **notification** · fleet · analytics                                |
| `BREAKDOWN_REPORTED`                  | maintenance | notification · asset · analytics                                    |
| `MAINTENANCE_CREATED`                 | maintenance | asset · analytics                                                   |
| `WORKSHOP_ASSIGNED`                   | maintenance | notification · supplier                                             |
| `REPAIR_COMPLETED`                    | maintenance | asset · supplier (امتیاز) · analytics                               |
| `MAINTENANCE_COMPLETED`               | maintenance | asset · economic (پاداش) · analytics                                |
| `MAINTENANCE_APPROVED`                | maintenance | **economic (مجوز تسویه)** · analytics                               |
| `INSURANCE_RECORDED`                  | asset       | notification · analytics                                            |
| `INSURANCE_EXPIRING`                  | asset       | **notification** · analytics                                        |
| `INSPECTION_EXPIRING`                 | asset       | notification                                                        |

### Marketplace · Procurement · Supplier · Inventory

| رویداد                              | Producer    | مصرف‌کنندگان اصلی                                             |
| ----------------------------------- | ----------- | ------------------------------------------------------------- |
| `OFFER_PUBLISHED`                   | marketplace | search · analytics                                            |
| `ORDER_CREATED`                     | marketplace | inventory (رزرو) · notification · analytics                   |
| `ORDER_CONFIRMED`                   | marketplace | notification · analytics                                      |
| `ORDER_FULFILLED`                   | marketplace | notification · inventory                                      |
| `ORDER_RECEIPT_CONFIRMED`           | marketplace | notification · analytics                                      |
| `ORDER_COMPLETED`                   | marketplace | supplier (امتیاز) · asset · analytics                         |
| `ORDER_CANCELLED`                   | marketplace | inventory (آزادسازی) · notification                           |
| `ORDER_DISPUTED`                    | marketplace | notification · supplier · analytics                           |
| `REVIEW_SUBMITTED`                  | marketplace | supplier (امتیاز) · analytics                                 |
| `DEMAND_SUBMITTED`                  | procurement | analytics                                                     |
| `DEMAND_AGGREGATED`                 | procurement | notification · analytics                                      |
| `RFQ_ISSUED`                        | procurement | **notification (دعوت تأمین‌کننده)**                           |
| `QUOTATION_SUBMITTED`               | procurement | analytics                                                     |
| `PURCHASE_ORDER_ISSUED`             | procurement | inventory · economic · notification                           |
| `GOODS_RECEIVED`                    | procurement | inventory · economic                                          |
| `SUPPLIER_QUALIFIED`                | supplier    | marketplace · procurement · construction                      |
| `SUPPLIER_SUSPENDED`                | supplier    | marketplace (پنهان‌سازی پیشنهاد) · procurement · construction |
| `PERFORMANCE_SCORE_UPDATED`         | supplier    | marketplace (رتبه‌بندی) · search                              |
| `STOCK_RESERVED` / `STOCK_RELEASED` | inventory   | marketplace (Saga سفارش)                                      |
| `LOW_STOCK_DETECTED`                | inventory   | notification · procurement                                    |
| `SHIPMENT_DELIVERED`                | inventory   | marketplace · notification                                    |

**مرز مالی واقعی بازارگاه.** Hold، تأیید تسویه، Refund و Settlement با فرمان
سرویس‌به‌سرویس احراز‌شده از Activityهای Temporal انجام می‌شوند؛ economic رویدادهای
`ORDER_*` را برای حرکت پول مصرف نمی‌کند (ADR-040). ردیف‌های inventory، supplier،
notification و analytics تا ساخته‌شدن Consumer مربوط، مقصد معماری‌اند نه ادعای اجرا.

### Construction · Contract

| رویداد                                   | Producer     | مصرف‌کنندگان اصلی                                       |
| ---------------------------------------- | ------------ | ------------------------------------------------------- |
| `PROJECT_CREATED`                        | construction | analytics · audit                                       |
| `APPROVAL_REQUESTED`                     | construction | **notification (مرجع تأیید)** · audit                   |
| `APPROVAL_GRANTED` / `APPROVAL_REJECTED` | construction | notification · audit · analytics                        |
| `TENDER_CREATED`                         | construction | audit                                                   |
| `TENDER_PUBLISHED`                       | construction | **notification (پیمانکاران)** · search · analytics      |
| `BID_SUBMITTED`                          | construction | notification · **audit (مهر زمانی)**                    |
| `BIDS_EVALUATED`                         | construction | audit · analytics                                       |
| `TENDER_AWARDED`                         | construction | **contract (ایجاد پیش‌نویس)** · notification · supplier |
| `PROJECT_STARTED`                        | construction | fleet · analytics                                       |
| `PROJECT_PROGRESS_UPDATED`               | construction | contract · notification · analytics                     |
| `PROJECT_COMPLETED`                      | construction | contract · supplier (امتیاز) · analytics                |
| `CONTRACT_CREATED`                       | contract     | construction · notification                             |
| `CONTRACT_SIGNED`                        | contract     | construction · economic · notification                  |
| `CONTRACT_AMENDED`                       | contract     | audit · analytics                                       |
| `STATEMENT_SUBMITTED`                    | contract     | notification · analytics                                |
| `STATEMENT_APPROVED`                     | contract     | **economic (پرداخت)** · analytics                       |
| `STATEMENT_REJECTED`                     | contract     | notification                                            |
| `CONTRACT_COMPLETED`                     | contract     | supplier (امتیاز) · analytics                           |

### Insurance · Participation · Reverse Logistics — PLANNED

این رویدادها مقصد Contract هستند و تا ساخته‌شدن سرویس مالک، Topic یا Handler خالی برایشان
ایجاد نمی‌شود. Schema واقعی را همیشه Producer تعریف می‌کند.

| رویداد                                                          | Producer هدف | Consumerهای هدف                                  |
| --------------------------------------------------------------- | ------------ | ------------------------------------------------ |
| `INSURANCE_QUOTE_REQUESTED`                                     | insurance    | notification · analytics                         |
| `INSURANCE_OFFER_RECEIVED`                                      | insurance    | notification                                     |
| `INSURANCE_POLICY_ISSUED` / `INSURANCE_POLICY_RENEWED`          | insurance    | asset · economic · notification · analytics      |
| `INSURANCE_CLAIM_OPENED` / `INSURANCE_CLAIM_DECIDED`            | insurance    | asset · economic · notification · analytics      |
| `PARTICIPATION_SCORE_UPDATED`                                   | reward       | notification · analytics                         |
| `REWARD_BENEFIT_REDEEMED`                                       | reward       | economic · notification · analytics              |
| `SCORE_APPEAL_OPENED` / `SCORE_APPEAL_DECIDED`                  | reward       | notification · audit                             |
| `RETURN_REQUESTED` / `RETURN_AUTHORIZED`                        | marketplace  | inventory · supplier · notification              |
| `RETURN_RECEIVED` / `RETURN_INSPECTED` / `RETURN_DISPOSITIONED` | inventory    | marketplace · supplier · economic · analytics    |
| `WARRANTY_CLAIM_OPENED` / `WARRANTY_CLAIM_DECIDED`              | marketplace  | supplier · maintenance · economic · notification |

### Economic

| رویداد                 | Producer | مصرف‌کنندگان اصلی                                   |
| ---------------------- | -------- | --------------------------------------------------- |
| `WALLET_OPENED`        | economic | notification                                        |
| `FUNDS_HELD`           | economic | marketplace (پیشبرد Saga) · analytics               |
| `FUNDS_RELEASED`       | economic | marketplace · analytics                             |
| `PAYMENT_AUTHORIZED`   | economic | marketplace · contract                              |
| `PAYMENT_COMPLETED`    | economic | marketplace · maintenance · contract · notification |
| `PAYMENT_FAILED`       | economic | marketplace (جبران) · notification                  |
| `COMMISSION_APPLIED`   | economic | analytics (**درآمد پلتفرم**) · audit                |
| `REWARD_GRANTED`       | economic | notification · analytics                            |
| `REWARD_LEVEL_CHANGED` | economic | notification                                        |
| `SETTLEMENT_COMPLETED` | economic | marketplace · supplier · notification               |
| `JOURNAL_POSTED`       | economic | audit · analytics                                   |

> **وضعیت (2026-08-29).** `economic` تولیدکننده واقعی است: هر یازده رویداد بالا
> پیاده، تست قرارداد شده و روی `rasta.economic.v1` زنده مشاهده شده‌اند. مصرف
> واقعی این سرویس محدودتر از فهرست `docs/04` است و دلیلش در **ADR-032** است.

---

## ۷٫۱۰ الگوهای مصرف

| الگو                   | مثال                            | نکته                                             |
| ---------------------- | ------------------------------- | ------------------------------------------------ |
| **ساخت Read Model**    | `asset` تاریخچه دارایی می‌سازد  | Idempotent؛ باید از Offset صفر قابل بازسازی باشد |
| **همگام‌سازی Replica** | `organization_ref` در هر سرویس  | فقط Upsert؛ هرگز مبنای مجوزدهی                   |
| **محرک فرآیند**        | `ORDER_CREATED` → Hold وجه      | باید Idempotent باشد — پول در میان است           |
| **اعلان**              | `MAINTENANCE_DUE` → پیامک/ایمیل | شکست تحویل نباید Consumer را متوقف کند           |
| **حسابرسی**            | همه رویدادها → `audit_event`    | فقط الحاقی، بدون منطق                            |
| **پیشبرد Saga**        | `PAYMENT_FAILED` → لغو سفارش    | Temporal حالت را نگه می‌دارد، نه Consumer        |

**Consumer Group** به‌ازای هر (سرویس، هدف):
`asset-service.timeline` · `economic-service.order-saga` · `notification-service.dispatcher`
— گروه‌های جدا یعنی یک Consumer کند، بقیه را عقب نمی‌اندازد.

---

## ۷٫۱۱ پایش

| متریک                              | هشدار                       |
| ---------------------------------- | --------------------------- |
| `kafka_consumer_lag`               | > ۱۰٬۰۰۰ پیام یا > ۵ دقیقه  |
| `rasta_outbox_pending_age_seconds` | > ۶۰ ثانیه (Relay گیر کرده) |
| `rasta_dlq_messages_total`         | **هر پیام جدید** → هشدار    |
| `rasta_event_processing_duration`  | p99 > ۵ ثانیه               |
| `rasta_event_validation_failures`  | > ۰ → هشدار (نقض قرارداد)   |
| `rasta_duplicate_events_total`     | پایش (سلامت At-Least-Once)  |
