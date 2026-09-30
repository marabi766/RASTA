# Runbook: بازپرداخت گیرکرده — Hold بازپرداخت فعال، نتیجه نامعلوم

**شدت:** 🟠 هشدار — پول **نگه داشته** شده است، نه گم؛ هیچ اعتبار دوباره‌ای ممکن نیست. ولی تا حل نشود، پرداخت‌کننده ممکن است
پولش را پس گرفته باشد و کیف پول هنوز آن را Hold‌شده نشان دهد، یا برعکس.
**سیگنال محرک:** رویداد `PAYMENT_REFUND_UNRECONCILED` در `rasta.economic.v1` (و ردیف متناظر در `audit-service`)؛ Log سطح Error
از `PaymentService` («the provider refund failed without an answer» یا «a refund outcome … could not be recorded»)؛ افزایش
`rasta_economic_payment_intents_total{outcome="REFUND_UNKNOWN"|"REFUNDED_NOT_REVERSED"|"REFUND_DECLINED_RELEASE_PENDING"}`؛ یا اپراتوری که
بازپرداخت دومش با `422 BUSINESS_RULE_VIOLATION` و `outcome` یکی از علامت‌های زیر رد شد؛ و از گام B2 رویداد
`PAYMENT_RECONCILIATION_ESCALATED` و هشدارهای زیر.
**هشدار خودکار (گام B2):** `RastaPaymentReconciliationEscalated` (**بحرانی**)، `RastaPaymentReconciliationBacklogAging` و
`RastaPaymentReconcilerStalled` در `infrastructure/docker/prometheus/rules/rasta-economic-alerts.yml` (§ ۰). بیشتر این حالت‌ها را
**آشتی‌دهنده خودش حل می‌کند**؛ این Runbook برای وقتی است که آن را به انسان سپرده (تشدید) یا خودش از کار افتاده است.
**زمان پاسخ هدف:** ۴ ساعت کاری.

> **پرداخت در MVP شبیه‌سازی‌شده است** (`MockPaymentProvider`، ADR-024). هیچ بانک و پول واقعی‌ای در کار نیست؛ این Runbook برای
> وقتی نوشته شده که Provider واقعی جایش بنشیند، و همین امروز روی دادهٔ شبیه‌سازی‌شده هم درست است.

---

## ۰. اول: آشتی‌دهنده چه کرده است (ADR-064 گام B2)

`PaymentReconciliationSweeper` درون economic-service هر `ECONOMIC_PAYMENT_RECONCILER_INTERVAL_SECONDS` (پیش‌فرض ۶۰ ثانیه):

1. **صف را ترمیم می‌کند** (هر دو جهت): برای علامتی بی تسک باز، تسک باز می‌کند؛ تسک بازی را که Intent آن بی تسک حل شده، بی هیچ
   حرکت پولی `DONE` می‌کند. این برای وقتی است که نسخهٔ B0 هم‌زمان در حال اجرا بوده است.
2. **تسک‌های سررسیده را برمی‌دارد** (`SKIP LOCKED`، Lease و Fence؛ روی هر Replica امن).
3. برای علامت نامعلوم **از Provider می‌پرسد** (`getRefundStatus` همان مرجع و همان کلید)، و زیر قفل Intent و کیف پول با همان
   مسیرهای کد حل می‌کند: بازپرداخت‌شده → معکوس (هرگز از کیف پول غیرفعال)؛ ردشده یا «هرگز نرسیده» با تأیید Provider → برگرداندن
   Hold. پاسخی که پاسخ نیست (`UNKNOWN`، Timeout، «پیدا نشد» بی تأیید) **هیچ چیز را جابه‌جا نمی‌کند** و با Backoff دوباره می‌پرسد.
4. پس از `…_MAX_ATTEMPTS` یا `…_MAX_AGE_HOURS`، یا در وضعیتی که نباید حدس بزند (`HOLD_WITHOUT_MARKER`)، تسک را `ESCALATED` می‌کند
   و `PAYMENT_RECONCILIATION_ESCALATED` می‌فرستد. **Hold می‌ماند.**

| هشدار                                    | یعنی                                                  | چه کنی                                                                                                                                                                                       |
| ---------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RastaPaymentReconciliationEscalated`    | دست‌کم یک تسک `ESCALATED` است                         | § ۱ با `task_status = 'ESCALATED'`؛ `last_outcome` می‌گوید چرا. علامت معلوم → § ۳؛ نامعلوم → § ۴. `HOLD_WITHOUT_MARKER` یک ناسازگاری است → [ledger-imbalance](ledger-imbalance.md)، دست نزن. |
| `RastaPaymentReconciliationBacklogAging` | تسک سررسیده بیش از یک ساعت منتظر مانده                | Log `PaymentReconciler` را ببین (`APPLY_FAILED`، `PROVIDER_UNREACHABLE`)؛ پایگاه داده و Provider را بررسی کن.                                                                                |
| `RastaPaymentReconcilerStalled`          | نمونه‌ای با آشتی‌دهندهٔ روشن پنج بازه است Sweep نکرده | Log سطح Error «Payment reconciliation sweep failed» را ببین؛ اتصال پایگاه داده؛ در صورت لزوم نمونه را Restart کن. تسک‌ها در صف می‌مانند.                                                     |

تسک `ESCALATED` را آشتی‌دهنده دیگر برنمی‌دارد. با **Mock** پس از Restart، Provider هیچ تلاش پیشینی را نمی‌شناسد و پاسخ `UNKNOWN` می‌دهد؛
در Stack نمایشی تشدید مسیر عادی چنین تسک‌هایی است — پاسخ صادقانه.

## علامت‌ها و معنای هر کدام

بازپرداخت اپراتور (`POST /v1/payment-intents/{id}/refund`) سه گام دارد: (۱) Hold مبلغ و علامت `REFUND_REQUESTED`، (۲) پرسیدن از
Provider بیرون از تراکنش، (۳) برگرداندن Hold و معکوس‌کردن Top-up، یا فقط برگرداندن Hold اگر Provider رد کرد. هر نتیجه‌ای که ثبت
نشود Hold را نگه می‌دارد و روی `payment_intent.failure_reason` (Intent در `CAPTURED`) علامت می‌گذارد:

| `failure_reason`                  | یعنی                                                                | Provider چه کرده؟             | راه امروز                            |
| --------------------------------- | ------------------------------------------------------------------- | ----------------------------- | ------------------------------------ |
| `REFUNDED_NOT_REVERSED`           | Provider بازپرداخت کرد، معکوس‌کردن در دفتر کل ثبت نشد               | **بازپرداخت کرد** (معلوم)     | § ۳-الف — خودکار با API، بی Provider |
| `REFUND_DECLINED_RELEASE_PENDING` | Provider **رد کرد**، برگرداندن Hold ثبت نشد                         | **رد کرد** (معلوم)            | § ۳-ب — خودکار با API، بی Provider   |
| `REFUND_UNKNOWN`                  | فراخوانی Provider **بی‌پاسخ** شکست خورد (Timeout، پاسخ گم‌شده)      | **نامعلوم**                   | § ۴ — پاسخ Provider لازم است         |
| `REFUND_REQUESTED`                | پس از گام ۱ چیزی ثبت نشد: Crash فرایند، یا شکست ثبت هر نتیجهٔ دیگری | **نامعلوم** — شاید پرسیده نشد | § ۴ — پاسخ Provider لازم است         |

دو علامت دیگر روی Intent در `AUTHORIZED` (نه بازپرداخت اپراتور، بلکه Capture‌ای که اعتبار نگرفت) هم هست: `CAPTURED_NOT_CREDITED`
(Provider بازپرداختِ جبرانی را **رد کرد**؛ تلاش دوبارهٔ Top-up با همان کلید اعتبار را ثبت می‌کند) و `CAPTURED_REFUND_UNKNOWN`
(نامعلوم؛ **هیچ** تلاش دوباره‌ای اعتبار نمی‌دهد). دومی هم مثل § ۴ پاسخ Provider می‌خواهد و تا گام B راه API ندارد.

---

## ۱. یافتن Intentهای گیرکرده

فقط خواندن، روی `rasta_economic` با نقش همان سرویس. `organization_id` را در هر گزارش نگه دار — هر اقدام بعدی در محدودهٔ همان
مستأجر است.

```sql
SELECT pi.id                 AS payment_intent_id,
       pi.organization_id,
       pi.wallet_id,
       pi.status,
       pi.failure_reason,
       pi.amount_minor,
       pi.currency,
       pi.provider,
       pi.provider_reference,
       pi.captured_at,
       h.id                  AS hold_id,
       h.status              AS hold_status,
       h.placed_at           AS hold_placed_at,
       now() - h.placed_at   AS hold_age,
       t.id                  AS task_id,
       t.status              AS task_status,
       t.last_outcome        AS task_last_outcome,
       t.next_attempt_at     AS task_due_at
  FROM payment_intent pi
  LEFT JOIN wallet_hold h
         ON h.wallet_id = pi.wallet_id
        AND h.reference = pi.id
        AND h.reference_type = 'PAYMENT_REFUND'
        AND h.status = 'ACTIVE'
  LEFT JOIN payment_reconciliation_task t
         ON t.organization_id = pi.organization_id
        AND t.payment_intent_id = pi.id
        AND t.status <> 'DONE'
 WHERE (pi.status = 'CAPTURED' AND pi.failure_reason IN
          ('REFUND_REQUESTED', 'REFUND_UNKNOWN', 'REFUNDED_NOT_REVERSED', 'REFUND_DECLINED_RELEASE_PENDING'))
    OR (pi.status = 'AUTHORIZED' AND pi.failure_reason IN ('CAPTURED_NOT_CREDITED', 'CAPTURED_REFUND_UNKNOWN'))
 ORDER BY h.placed_at NULLS LAST, pi.created_at;
```

- `REFUND_REQUESTED` با `hold_age` کمتر از چند دقیقه ممکن است **هنوز در جریان** باشد (Provider در حال پاسخ). فقط ردیف‌هایی را
  گیرکرده بشمار که `hold_age` از ۱۵ دقیقه گذشته است.
- هر ردیف `CAPTURED` با یکی از چهار علامت بالا **باید** یک Hold فعال `PAYMENT_REFUND` داشته باشد. ردیفی که ندارد یک ناسازگاری است
  — دست نزن و به [ledger-imbalance](ledger-imbalance.md) برو.
- هر ردیف با یکی از چهار علامت بالا، یا با `CAPTURED_REFUND_UNKNOWN`، **باید** یک تسک باز (`task_id`) داشته باشد: تسک در همان
  تراکنشی نوشته می‌شود که Hold یا علامت را می‌نویسد (ADR-064 § ۸، گام B1). `CAPTURED_NOT_CREDITED` تسک ندارد و نباید داشته
  باشد (تلاش دوبارهٔ Top-up حلش می‌کند). علامتی بی تسک باز یک ناسازگاری است — دست نزن و گزارش کن.
- رویدادهای مربوط: `PAYMENT_REFUND_UNRECONCILED` با همان `paymentIntentId` (در Outbox یا `audit-service`) دلیل (`reason`) را
  می‌گوید: `PROVIDER_OUTCOME_UNKNOWN`، `PROVIDER_DECLINED_RELEASE_PENDING`، `REVERSAL_FAILED` یا `INSUFFICIENT_BALANCE`.
  `REFUND_REQUESTED` عمداً رویداد ندارد — یعنی ثبت خود نتیجه هم شکست خورد.

## ۲. کیف پول منجمد

اگر کیف پول `FROZEN` باشد، هیچ بازپرداختی (حتی § ۳-الف) اجرا نمی‌شود: از کیف پول منجمد پولی بیرون نمی‌رود. Hold سر جایش
می‌ماند و این درست است. پس از فعال‌شدن دوبارهٔ کیف پول ادامه بده. فقط § ۳-ب (برگرداندن Hold به کیف پول) روی کیف پول منجمد هم
مجاز است.

## ۳. نتیجهٔ Provider معلوم است — خودِ سرویس حلش می‌کند

هر دو حالت با **همان API بازپرداخت** و **همان مسیر کد** حل می‌شوند: قفل Intent و سپس کیف پول، و هرگز فراخوانی دوبارهٔ Provider.

```http
POST /v1/payment-intents/{payment_intent_id}/refund
Authorization: Bearer <SYSTEM_ADMIN یا UNION_ADMIN در سازمان همان Intent>
Idempotency-Key: <کلید تازه>
Content-Type: application/json

{ "reason": "Runbook payment-refund-stuck: <شمارهٔ تیکت>" }
```

- **الف. `REFUNDED_NOT_REVERSED`** → پاسخ `200` با `reversalJournalId`: Hold برگشت، Top-up معکوس شد، Intent `REFUNDED`.
- **ب. `REFUND_DECLINED_RELEASE_PENDING`** → پاسخ `422` با `outcome: REFUND_DECLINED`: Hold به کیف پول برگشت و علامت پاک شد. Intent
  دوباره یک Top-up عادی `CAPTURED` است؛ اگر هنوز بازپرداخت لازم است، یک درخواست تازه بفرست.

اگر همین پاسخ دوباره شکست خورد (مثلاً `INTERNAL_ERROR`)، دوباره امتحان نکن؛ ردیف و Log را برای مالک economic-service ثبت کن.

از گام B2 آشتی‌دهنده همین دو حالت را در Sweep بعدی خودش حل می‌کند (بی پرسیدن از Provider). فراخوانی دستی بالا فقط برای تسکی لازم
است که `ESCALATED` شده یا آشتی‌دهنده خاموش است؛ هر دو مسیر زیر قفل Intent‌اند و فقط یکی اثر می‌گذارد.

## ۴. نتیجهٔ Provider نامعلوم است — `REFUND_UNKNOWN`، `REFUND_REQUESTED` (و `CAPTURED_REFUND_UNKNOWN`)

API این‌ها را **عمداً رد می‌کند**: بدون دانستن کار Provider، هر حرکتی یا پول را دوبار برمی‌گرداند یا پرداخت‌کننده را بی‌پول
می‌گذارد. پاسخ را باید **از خود Provider** گرفت.

### ۴-۱. از Provider بپرس

- مرجع: `provider_reference` از پرس‌وجوی § ۱؛ کلید Idempotency بازپرداخت در Provider `<idempotency_key Intent>:refund` است
  (برای `CAPTURED_REFUND_UNKNOWN`: `<idempotency_key>:uncredited`).
- از Provider وضعیت **همان مرجع و همان کلید** را بپرس و پاسخ نوشته‌شدهٔ آن را (شناسهٔ تراکنش Provider، زمان، وضعیت) به‌عنوان شاهد
  نگه دار. بدون شاهد نوشته‌شده جلو نرو.
- **با `MockPaymentProvider`:** حافظهٔ Mock درون فرایند است و پس از Restart هیچ نمی‌داند (`getStatus` پاسخ `UNKNOWN` می‌دهد).
  آن پاسخ **شاهد نیست** — نه شاهد بازپرداخت، نه شاهد رد. روی دادهٔ شبیه‌سازی‌شده، Intent را در همین وضعیت (با Hold) بگذار تا گام B.

### ۴-۲. با شاهد چه کنی (تا گام B)

تا گام B هیچ Endpoint حل انسانی وجود ندارد. **تنها** تغییری که این Runbook اجازه می‌دهد، تبدیل علامتِ نامعلوم به علامتِ
معلوم متناظر است، تا خود سرویس با مسیر عادی § ۳ حلش کند — هیچ ردیف دفتر کل، Journal، Hold یا موجودی دستی تغییر نمی‌کند:

| شاهد Provider                     | علامت را به این تبدیل کن              | سپس         |
| --------------------------------- | ------------------------------------- | ----------- |
| بازپرداخت انجام شده است           | `REFUNDED_NOT_REVERSED`               | § ۳-الف     |
| بازپرداخت انجام نشده / رد شده است | `REFUND_DECLINED_RELEASE_PENDING`     | § ۳-ب       |
| Provider هم نمی‌داند              | **هیچ تغییری** — Hold بماند، تشدید کن | منتظر گام B |

```sql
-- فقط با شاهد نوشته‌شدهٔ Provider، فقط یک ردیف، فقط از یکی از دو علامت نامعلوم.
-- مجوز (Q-82، تصمیم موقت): SYSTEM_ADMIN؛ نه کسی که Intent را ساخت (created_by).
UPDATE payment_intent
   SET failure_reason = '<REFUNDED_NOT_REVERSED | REFUND_DECLINED_RELEASE_PENDING>'
 WHERE id = '<payment_intent_id>'
   AND organization_id = '<organization_id>'
   AND status = 'CAPTURED'
   AND failure_reason IN ('REFUND_REQUESTED', 'REFUND_UNKNOWN');
-- باید دقیقاً یک ردیف تغییر کند؛ اگر صفر بود، کس دیگری حلش کرده — توقف.
```

تسک باز Intent را دست نزن: فراخوانی § ۳ آن را در همان تراکنشی می‌بندد که نتیجه را ثبت می‌کند (`resolution` = `REFUNDED` یا
`REFUND_DECLINED`).

این UPDATE خودش رویداد Audit نمی‌سازد. در تیکت ثبت کن: شناسهٔ Intent و سازمان، علامت قبلی و جدید، شاهد Provider (پیوست)، نام
اجراکننده و زمان. پاسخ § ۳ رویدادهای عادی (`FUNDS_RELEASED`، `JOURNAL_POSTED`، …) را منتشر می‌کند و آن‌ها به `audit-service`
می‌رسند.

`CAPTURED_REFUND_UNKNOWN` (Intent در `AUTHORIZED`) با این جدول حل نمی‌شود — مسیر API ندارد. شاهد را بگیر، ثبت کن و تا گام B
نگه دار.

---

## ⛔ هرگز

- **هرگز فرض نکن که نبودِ علامت یا پاسخ یعنی «رد شد».** `UNKNOWN`، Timeout، پاسخ خالی و «پیدا نشد» از Mock پس از Restart هیچ‌کدام
  شاهد رد نیستند. «رد شد» فقط وقتی است که Provider صریحاً رد را گزارش کند.
- هرگز ردیف `ledger_entry`، `journal`، `wallet_hold` یا ستون‌های موجودی `wallet` را دستی تغییر نده یا حذف نکن (AGENTS.md A-06؛
  Triggerهای تغییرناپذیری جلویش را می‌گیرند و درست هم هست). Hold فقط با مسیر کد برمی‌گردد.
- هرگز `payment_intent.status` را دستی به `REFUNDED`، `FAILED` یا وضعیت دیگری تغییر نده.
- هرگز بازپرداخت را **با کلید Idempotency تازه** مستقیم از Provider نخواه — این همان پرداخت دوباره است.
- هرگز Intent را بی شاهد Provider از `REFUND_REQUESTED`/`REFUND_UNKNOWN` بیرون نیاور، حتی اگر کاربر اصرار کند.
- هرگز Hold را برای «آزاد کردن پول کاربر» دستی آزاد نکن؛ Hold همان چیزی است که جلوی دوبار برگشتن پول را می‌گیرد.
- هرگز ردیف `payment_reconciliation_task` را دستی ویرایش یا حذف نکن. تسک با نتیجه بسته می‌شود؛ بستن دستی‌اش Intentی را که هنوز
  Hold دارد از چشم آشتی‌دهنده (B2) پنهان می‌کند. `down.sql` مهاجرتش هم تا وقتی تسکی باز است رد می‌کند.

## بعد از حل

- پرس‌وجوی § ۱ را دوباره اجرا کن؛ ردیف باید رفته باشد (یا `CAPTURED` بی علامت، یا `REFUNDED`)، و تسکش `DONE` با `resolution`
  و `resolved_by`.
- موجودی کیف پول با دفتر کل می‌خواند؟ `LedgerBalanceAudit` را ببین ([ledger-imbalance](ledger-imbalance.md)).
- تیکت را با شاهد و نتیجه ببند.

## وقتی گام B کامل شود

ADR-064 گام B سه بخش دارد. **B1** (صف تسک) و **B2** (آشتی‌دهنده، § ۰) آمده‌اند. **B3** Endpoint حل انسانی را می‌آورد
(`SYSTEM_ADMIN`، شاهد الزامی، **تأیید دونفره**، Q-82). آن زمان § ۴-۲ (UPDATE دستی علامت) حذف می‌شود و این Runbook به آن Endpoint
اشاره می‌کند.
