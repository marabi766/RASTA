# ADR-064: آشتی پایدار پرداخت

- **وضعیت:** **Proposed**
- **تاریخ:** 2026-09-29
- **تصمیم‌گیرنده:** معماری پلتفرم؛ شمارهٔ ADR و تصمیم‌های موقت از مدیر پروژه (PR #140)
- **اصلاح می‌کند:** **ADR-024** — فقط شکل `PaymentProvider.getStatus` (§ ۳ پایین). بقیهٔ ADR-024 بی‌تغییر است: یک
  Interface، `MockPaymentProvider` تنها پیاده‌سازی، `simulated` روی هر نتیجه، ردیف و رویداد، و **هیچ ادعای اتصال بانکی**.
- **مرتبط:** ADR-013 (Wallet ≠ Ledger)، ADR-021 (Outbox)، ADR-031 (تسویه بی Temporal)، ADR-034 (امانت به‌ازای
  سازمان)، ADR-036 (کلید پارتیشن)، ADR-050 (Claim بادوام)، `docs/23` D-035، Q-81، Q-82
- **طرح و شواهد:** `docs/evidence/payment-reconciler/step-0-plan.md` (همهٔ ارجاع‌های `file:line` روی `acb17db`)

---

## Context

`economic-service` در سه جا Provider را **بیرون از تراکنش پایگاه داده** صدا می‌زند — `authorize`، `capture` و
`refund` — و درست هم همین است: قفل ردیف نباید مدت شبکهٔ کس دیگری را نگه دارد. هزینه‌اش این است که میان «Provider کاری
کرد» و «ما آن را نوشتیم» شکافی هست، و هر خرابی در آن شکاف (Timeout، پاسخ گم‌شده، Crash فرایند، شکست نوشتن) نتیجه را
**نامعلوم** می‌گذارد. طرح STEP 0 ده حالت را شمرد (U1–U8، R1، R2). امروز:

- هیچ چیز `getStatus` را صدا نمی‌زند؛ تنها راه از سرگیری، تلاش دوبارهٔ مشتری با همان Idempotency-Key است، و آن هم برای
  هر حالتی جز `CAPTURED_NOT_CREDITED` **برای همیشه** رد می‌شود.
- Intentهای گیرکرده سقف Top-up کیف پول را برای همیشه رزرو می‌کنند.
- دو مسیر پول را هم به پرداخت‌کننده برمی‌گرداندند و هم در کیف پول نگه می‌داشتند: **R2** (بررسی موجودی پس از بازپرداخت
  Provider) و **U6** (بازپرداختِ بی‌پاسخ «رد» شمرده می‌شد و تلاش دوباره اعتبار می‌داد). این دو در گام B0 بسته شدند
  (PR #143).

## Decision

### ۱. نشانگر بادوام پیش از فراخوانی Provider نوشته می‌شود

هر Intent **از لحظهٔ نوشته‌شدن** برای آشتی زمان‌بندی می‌شود (`reconcile_state = 'SCHEDULED'`، `next_reconcile_at =
now + grace`) در همان تراکنشی که ساخته می‌شود، و هر گذار به وضعیت پایانی (`CAPTURED`، `FAILED`، `REFUNDED`) در
**همان تراکنش** آن را `NONE` می‌کند. پس هر Crash ردیفی باقی می‌گذارد که آشتی‌دهنده پیدا می‌کند؛ هیچ استنباطی از
«شاید گیر کرده باشد» لازم نیست. `grace` فقط آشتی‌دهنده را از درخواست‌های در جریان دور نگه می‌دارد؛ درستی به آن وابسته
نیست (§ ۴).

### ۲. بازپرداخت اپراتور وجوه را Hold می‌کند — در گام B0 (تصمیم فنی مدیر پروژه، Q-A؛ بازبینی دور ۱ #143)

بررسی موجودی پیش از Provider به‌تنهایی کافی نیست: تراکنش بررسی Commit می‌شود و قفل‌ها را آزاد می‌کند، خرجی هم‌زمان در
مدت فراخوانی Provider Commit می‌شود، و معکوس‌کردن رد می‌شود — پرداخت‌کننده پولش را گرفته و کیف پول هم ارزش را نگه داشته.
پس Hold از گام B به **گام B0** آمد:

1. **تراکنش A (درخواست):** قفل ردیف Intent ← قفل کیف پول ← **`WalletHold`** به مبلغ بازپرداخت از همان مسیر Hold موجود
   (ADR-034؛ `placeHold` خودش `INSUFFICIENT_BALANCE` را رد می‌کند و `FUNDS_HELD` در دفتر کل دیده می‌شود،
   `reference_type = PAYMENT_REFUND`) ← علامت درخواست بازپرداخت روی Intent. **خرج هم‌زمان روی Hold شکست می‌خورد، نه
   معکوس‌کردن.**
2. `provider.refund` بیرون از هر تراکنش (با کلید پایدار `…:refund`).
3. **تراکنش B (ثبت):** زیر همان قفل‌ها — بازپرداخت شد ← برگرداندن Hold به کیف پول (`refundHold`)، بررسی دوبارهٔ موجودی
   به‌عنوان دفاع، `ledger.reverse` ژورنال Top-up، `REFUNDED`. رد شد ← برگرداندن Hold و پاک‌شدن علامت.

هر نتیجه‌ای که ثبت نشود Hold را سر جایش و Intent را علامت‌دار نگه می‌دارد؛ هیچ‌چیز گم یا کورکورانه تکرار نمی‌شود:

| وضعیت                                      | علامت (B0، روی `failure_reason` در `CAPTURED`) | رویداد                                                              | بازپرداخت دوم                                  |
| ------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------- |
| پس از تراکنش A، هنوز بی‌پاسخ یا Crash      | `REFUND_REQUESTED`                             | —                                                                   | رد، بی پرسیدن از Provider                      |
| فراخوانی Provider بی‌پاسخ شکست خورد        | `REFUND_UNKNOWN`                               | `PAYMENT_REFUND_UNRECONCILED` (`PROVIDER_OUTCOME_UNKNOWN`)          | رد، بی پرسیدن از Provider                      |
| Provider بازپرداخت کرد، تراکنش B شکست خورد | `REFUNDED_NOT_REVERSED`                        | `PAYMENT_REFUND_UNRECONCILED` (`REVERSAL_FAILED`)                   | فقط تراکنش B، بی Provider                      |
| Provider رد کرد، برگرداندن Hold شکست خورد  | `REFUND_DECLINED_RELEASE_PENDING`              | `PAYMENT_REFUND_UNRECONCILED` (`PROVIDER_DECLINED_RELEASE_PENDING`) | فقط برگرداندن Hold (Idempotent)، هرگز Provider |

تلاش دوبارهٔ Top-up با همان کلید روی هر یک از این چهار علامت پاسخ «ناتمام» می‌گیرد، نه نمای `CAPTURED`. **بازپخش HTTP**
با همان کلید اما پاسخ تاریخی را برمی‌گرداند (همان کلید، همان پاسخ؛ لایهٔ Idempotency وضعیت را دوباره نمی‌خواند — تصمیم
مدیر پروژه، بازبینی دور ۲ #143)؛ وضعیت امروز را `GET /v1/payment-intents/{id}` با `status` و `failureReason` می‌گوید
(`docs/06` § ۶٫۸).

اگر Provider رد کند و برگرداندن Hold شکست بخورد، ردِ **معلوم** ثبت می‌شود، نه گم: `REFUND_DECLINED_RELEASE_PENDING` و
رویداد در تراکنش خودش، و تماس بعدی بازپرداخت (یا آشتی‌دهنده) فقط Hold را برمی‌گرداند — `refundHold` برای Holdی که دیگر
`ACTIVE` نیست کاری نمی‌کند، پس دوبار برگشت ناممکن است — و هرگز دوباره از Provider نمی‌پرسد. **آخرین پناه:** اگر حتی ثبت
این علامت شکست بخورد (یا فرایند پس از تراکنش A Crash کند)، ردیف در `REFUND_REQUESTED` با Hold می‌ماند؛ بازپرداخت دوم رد
می‌شود و آشتی‌دهنده (گام C) آن را پس از `maxAttempts`/`maxAge` بی پاسخ روشن از Provider **تشدید** می‌کند (§ ۴).

در B0 علامت‌ها روی `failure_reason` می‌نشینند تا Migration لازم نباشد؛ گام B آن‌ها را به وضعیت `REFUND_PENDING` و ستون‌های
آشتی (§ ۸) منتقل می‌کند و آشتی‌دهنده (گام C) `REFUND_REQUESTED` و `REFUND_UNKNOWN` را با `getStatus` حل می‌کند و
`REFUND_DECLINED_RELEASE_PENDING` را فقط با برگرداندن Hold.

**کیف پول `FROZEN`** (تصمیم مدیر پروژه، بازبینی دور ۲ #143): از کیف پول منجمد پولی بیرون نمی‌رود. بازپرداخت با
`422 BUSINESS_RULE_VIOLATION` رد می‌شود، پیش از هر Hold یا فراخوانی Provider و بی Hold باقی‌مانده، و Intent پس از فعال‌شدن
دوبارهٔ کیف پول بازپرداخت‌پذیر می‌ماند. معکوس‌کردنِ بدهکار پس از بازپرداخت Provider (`REFUNDED_NOT_REVERSED`) هم با مبلغ
Hold‌شده منتظر می‌ماند؛ فقط برگرداندن Hold یک ردِ Provider (`REFUND_DECLINED_RELEASE_PENDING`) که پول را به کیف پول
برمی‌گرداند مجاز است.

`MockPaymentProvider` بازپرداخت را با کلید Idempotency (و مرجع) Dedupe می‌کند و بازپرداخت دوم یک مرجع با کلید دیگر را
`ALREADY_REFUNDED` رد می‌کند، تا فراخوانی دوم در تست دیدنی باشد.

### ۳. اصلاح ADR-024: شکل `getStatus`

`getStatus(providerRef)` نمی‌تواند U1 و U2 را پاسخ دهد — تا تراکنش دوم هیچ مرجع Providerی ذخیره نشده — و وضعیت پرداخت
را با وضعیت بازپرداخت درهم می‌کند. شکل جدید:

```ts
getStatus(query: { paymentIntentId: string; providerReference?: string; idempotencyKey: string }): Promise<{
  payment: 'NOT_FOUND' | 'AUTHORIZED' | 'CAPTURED' | 'FAILED' | 'UNKNOWN';
  refund: 'NONE' | 'PENDING' | 'REFUNDED' | 'FAILED' | 'UNKNOWN';
  providerReference?: string;
  failureCode?: string; // فقط کد، از failureCodeFrom (S-09)
  simulated: boolean;
}>;
```

- جست‌وجو با مرجع ما (`paymentIntentId`) است، چنان‌که هر Provider واقعی پشتیبانی می‌کند.
- `NOT_FOUND` فقط وقتی «هرگز به Provider نرسید» خوانده می‌شود که Adapter صریحاً `authoritativeNotFound` اعلام کند؛ وگرنه
  `UNKNOWN` است.
- `MockPaymentProvider` حافظه‌ای می‌ماند: پس از Restart هیچ نمی‌داند و **صادقانه** `UNKNOWN` پاسخ می‌دهد و
  `authoritativeNotFound` اعلام نمی‌کند. Directiveهای «پاسخ گم‌شده» (`lose-*`) و «معلق» (`hang-*`) با همان مجموعهٔ بستهٔ
  امروز فقط برای رساندن تست‌ها به حالت‌های U و R افزوده می‌شوند.
- هر فراخوانی Provider زیر `ECONOMIC_PAYMENT_PROVIDER_TIMEOUT_MS` است؛ Timeout یک نتیجهٔ نامعلوم است، نه شکست.

### ۴. آشتی‌دهنده

- **Claim:** یک تراکنش کوتاه، تنها Query بی‌محدودهٔ مستأجر (`runUnscoped` با دلیل): `UPDATE … WHERE id IN (SELECT … WHERE
reconcile_state='SCHEDULED' AND next_reconcile_at <= now() AND <lease آزاد> ORDER BY next_reconcile_at LIMIT $batch
FOR UPDATE SKIP LOCKED) RETURNING id, organization_id` — شکل Claim بادوام ADR-050، Commit پیش از هر فراخوانی Provider.
- **هر ردیف در محدودهٔ مستأجر خودش:** `runWithContext({ organizationId: row.organization_id })`؛ هر Query پس از Claim از
  Tenant Guard می‌گذرد و قفل ردیف Intent سازمان را صریحاً نام می‌برد.
- **اعمال از همان مسیرهای جریان عادی** (`fail()`، `recordCaptureOrFindIt`/`completeCapture`، `ledger.reverse`)، هرکدام
  Compare-and-Set زیر قفل ردیف Intent. جدول تصمیم در طرح § 2.4. **هیچ ردیف دفتر کل ویرایش نمی‌شود.**
- **دوبار اعتبار ناممکن است، با سه سازوکار مستقل:** (۱) `SKIP LOCKED` و Lease؛ (۲) CAS در `completeCapture` (فقط
  `AUTHORIZED` Capture می‌شود)؛ (۳) `ux_transaction_source_fact` که تراکنش `WALLET_TOP_UP` دوم برای یک Intent را خودِ
  پایگاه داده رد می‌کند.
- **تلاش دیرهنگام مشتری:** `resume` همان `reconcileOne` را هم‌زمان صدا می‌زند؛ بازندهٔ مسابقه ردیف پایانی را می‌یابد و از
  آن پاسخ می‌دهد. Intent با `CAPTURED_REFUND_UNKNOWN` فقط پس از آنکه `getStatus` نگه‌داشتن Capture را تأیید کند اعتبار
  می‌گیرد.
- **Backoff و وضعیت پایانی:** `min(base·2^n, max)` به‌علاوهٔ Jitter قطعی از شناسه. پس از `maxAttempts` یا `maxAge`:
  `reconcile_state = 'ESCALATED'` و `escalated_at` در همان تراکنشِ رویداد `PAYMENT_RECONCILIATION_ESCALATED`.
  `audit-service` همهٔ `rasta.economic.v1` را جذب می‌کند، پس همین رویداد سابقهٔ حسابرسی است. رزرو سقف نگه داشته
  می‌شود (امن در شکست).

### ۵. `AUTHORIZED` بی Capture: تشدید، نه Capture (Q-81، تصمیم موقت مدیر پروژه)

وقتی Provider برای Intent گیرکرده `AUTHORIZED` پاسخ می‌دهد، آشتی‌دهنده **Capture نمی‌کند** و ردیف را تشدید می‌کند. شاخهٔ
Capture (با همان Idempotency-Key) پیاده می‌شود ولی پشت `ECONOMIC_PAYMENT_RECONCILER_CAPTURE_AUTHORIZED`، **پیش‌فرض
`false`**. حرکت پول بی درخواست زنده تصمیم مالک است. Interface هیچ `void` ندارد؛ افزودنش در صورت نیاز یک اصلاح دیگر
ADR-024 است.

### ۶. حل انسانی (Q-82، تصمیم موقت مدیر پروژه)

`POST /v1/payment-intents/:id/reconciliation`، با Idempotency-Key و دلیل، `assertNotAuditor`، و دو کنش:

- `requeue` — بازگشت به `SCHEDULED` و صفر شدن شمارش. `evidenceReference` لازم نیست.
- `resolve { outcome: FAILED | CAPTURED | REFUNDED, evidenceReference }` — `evidenceReference` **الزامی**؛ از همان
  مسیرهایی اعمال می‌شود که پاسخ Provider، با کنشگر و دلیل روی رویداد `PAYMENT_RECONCILIATION_RESOLVED`.

مجوز: فهرست نقش پیکربندی‌پذیر `ECONOMIC_PAYMENT_RECONCILIATION_RESOLVER_ROLES`، **پیش‌فرض فقط `SYSTEM_ADMIN`**. حل‌کننده
نمی‌تواند همان کسی باشد که Intent را ساخت (`created_by`). تأیید دونفره برای `resolve` کلید پیکربندی
`ECONOMIC_PAYMENT_RECONCILIATION_FOUR_EYES`، **پیش‌فرض خاموش** (امروز یک مدیر پلتفرم هست) و مستند.

### ۷. کجا اجرا می‌شود: Timer درون فرایند، نه Temporal

`economic-service` هیچ Worker تمپورالی ندارد (فقط marketplace دارد)؛ ADR-031 جریان‌های اقتصادی را بیرون از Temporal نگه
می‌دارد و `LedgerBalanceAudit` همین جایگزینی را پیش‌تر کرده است. همهٔ وضعیت آشتی در `payment_intent` است، نه در فرایند:
Crash فقط یک Claim را از دست می‌دهد و Lease آن را برمی‌گرداند. برخلاف ممیزی موجودی، این یکی **می‌نویسد**، و روی هر Replica
به دلیل سه سازوکار § ۴ امن است؛ Leader Election لازم نیست. درز آینده `reconcileOne(intentId)` است که یک Activity تمپورال
می‌تواند آن را بپوشاند.

### ۸. شِما و Index

- وضعیت تازهٔ `REFUND_PENDING`؛ ستون‌های `reconcile_state`، `next_reconcile_at`، `reconcile_attempts`،
  `reconcile_last_outcome` (فقط کد)، `reconcile_lease_until`، `escalated_at`، `refund_requested_at`؛ CHECK هم‌خوانی.
  Migration برگشت‌پذیر با `down.sql` که اگر ردیف `REFUND_PENDING` بماند با راهنما رد می‌کند.
- **Index جزئی میان‌مستأجری** `payment_intent (next_reconcile_at) WHERE reconcile_state = 'SCHEDULED'` با ورودی
  `EXEMPTIONS.economic` در `scripts/check-tenant-index-order-lib.mjs` (تصمیم مدیر پروژه). توجیه: Job سیستمی، محدود به
  ردیف‌های زنده، و **هرگز از درخواست مستأجر در دسترس نیست**. تستی ثابت می‌کند هیچ Query محدود به مستأجر از آن استفاده
  نمی‌کند.

### ۹. رویدادها

`PAYMENT_REFUND_UNRECONCILED` (B0)، `PAYMENT_REFUNDED`، `PAYMENT_REFUND_FAILED`، `PAYMENT_RECONCILIATION_ESCALATED`،
`PAYMENT_RECONCILIATION_RESOLVED` — همه در `NEVER_AUTO_REPLAY`، کلید پارتیشن `paymentIntentId` (ADR-036)، فقط کد و بی
Instrument (S-09)، و ثبت در `docs/07` و `docs/events/README.md`.

### ۱۰. پیکربندی و پایش

متغیرهای `ECONOMIC_PAYMENT_RECONCILER_*` (فعال، بازه، اندازهٔ دسته، grace، lease، backoff پایه و بیشینه، بیشینهٔ تلاش و
سن) و `ECONOMIC_PAYMENT_PROVIDER_TIMEOUT_MS`، همه با کران و پیش‌فرض در `env.ts`. متریک‌ها بی شناسه در Label؛ هشدارهای
`PaymentReconciliationEscalated` (بحرانی)، `PaymentReconciliationBacklogAging` و `PaymentReconcilerStalled` با تست
promtool.

## گام‌ها

| گام    | محتوا                                                                                                                | PR   |
| ------ | -------------------------------------------------------------------------------------------------------------------- | ---- |
| A      | طرح STEP 0 و همین ADR، Q-81، Q-82                                                                                    | #140 |
| **B0** | R2: Hold بازپرداخت و چهار علامت آن (§ ۲)؛ U6: بازپرداخت بی‌پاسخ نامعلوم است، نه رد                                   | #143 |
| B      | Port و Mock، Timeout، Migration (انتقال علامت‌های B0 به `REFUND_PENDING`)، نشانگر از لحظهٔ تولد، رویدادهای بازپرداخت | —    |
| C      | آشتی‌دهنده، پیکربندی، متریک و هشدار، تست‌های هم‌زمانی و جداسازی مستأجر                                               | —    |
| D      | Endpoint حل انسانی، OpenAPI، Runbook، به‌روزرسانی حافظهٔ پروژه و D-035                                               | —    |

## Consequences

- **مثبت:** هیچ نتیجهٔ نامعلومی بی‌صدا نمی‌ماند؛ هر Intent یا به وضعیت پایانی می‌رسد یا تشدید و اعلام می‌شود. سقف رزروشده
  آزاد می‌شود. دو مسیر دوبار-ارزش بسته‌اند.
- **منفی:** Mock پس از Restart همیشه `UNKNOWN` است، پس در Stack نمایشی تشدید مسیر عادی Intentهای گیرکرده است — پاسخ صادقانه.
  هر بازپرداخت یک جفت `FUNDS_HELD`/`FUNDS_RELEASED` در تاریخچه دارد. تلاش دوباره با همان کلید که امروز `422` می‌گیرد پس از
  گام C نتیجه‌ای پایانی می‌گیرد. `down.sql` نوع Enum را بازمی‌سازد و قفل کوتاهی می‌گیرد.
- **ممنوع می‌ماند:** ویرایش ورودی دفتر کل، `float` برای پول، ادعای اتصال بانکی، Business Logic در `packages/`.

## Alternatives Considered

- **Workflow تمپورال به‌ازای هر پرداخت** — دوام را دوباره می‌سازد که ردیف از پیش دارد، و Worker و استقرار و وابستگی تازه به
  سرویسی می‌افزاید که ADR-031 عمداً بیرون از Temporal نگه داشت.
- **اسکن به‌ازای هر مستأجر با Index که با `organization_id` شروع می‌شود** — یک Range Scan را N تا می‌کند؛ رد شد.
- **Capture خودکار Authorizeهای گیرکرده** — حرکت پول بی درخواست زنده؛ پشت پرچم، پیش‌فرض خاموش (Q-81).
- **استنباط شکست از `UNKNOWN`** — همان خطای U6 در لباسی دیگر؛ رد شد.
