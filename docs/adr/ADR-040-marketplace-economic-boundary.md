# ADR-040: مرز میان marketplace و economic — فرمان می‌رود، رویداد می‌آید

- **وضعیت:** Accepted
- **تاریخ:** 2026-08-29
- **اهمیت:** یکپارچگی مالی، مرز سرویس — تکمیل‌کننده ADR-032
- **مرتبط:** ADR-020 (Zero Trust)، ADR-021 (Outbox)، ADR-031، ADR-032، ADR-035 (تنانت امضاشده)، ADR-036 (کلید پارتیشن)، ADR-039 (Saga)

## Context

ADR-032 نیمه اقتصادی این مرز را از پیش تصمیم گرفت و یک تعهد ثبت‌شده باقی گذاشت:

> کل چرخه Hold ← تسویه ← کارمزد ← پاداش کامل پیاده و کامل تست شده است، از راه
> Endpoint هایی که مصرف‌کننده سرویسی دارند. وقتی `marketplace-service` ساخته شود،
> مصرف‌کننده رویدادش — اگر لازم باشد — یک لایه نازک روی همین متدهاست، و قراردادش
> را **مالکش** تعریف می‌کند.

این ADR آن نیمه دوم است. و آنچه از پیش آماده است، تصادفی نیست:
`transaction.controller.ts` امروز `@AllowService('marketplace-service', …)` را
روی هفت مسیر دارد — نوشته‌شده پیش از آنکه این سرویس وجود داشته باشد، برای همین
لحظه.

## Decision

### ۱. پول با **فرمان** حرکت می‌کند، نه با رویداد

هر اثر مالی یک فراخوان HTTP همگام به `economic-service` است، از داخل یک Activity
از `OrderSagaWorkflow`:

| گام Saga          | فراخوان                                           | نتیجه                      |
| ----------------- | ------------------------------------------------- | -------------------------- |
| ایجاد تعهد + Hold | `POST /v1/transactions` با `holdFunds=true`       | `TransactionView` (`HELD`) |
| مجوز تسویه        | `POST /v1/transactions/{id}/authorise-settlement` | `PENDING_SETTLEMENT`       |
| تسویه             | `POST /v1/settlements`                            | `SETTLED` + کارمزد         |
| اعتراض            | `POST /v1/transactions/{id}/dispute`              | `DISPUTED`                 |
| بازگشت وجه        | `POST /v1/transactions/{id}/refund`               | `REFUNDED`                 |
| لغو پیش از Hold   | `POST /v1/transactions/{id}/cancel`               | `CANCELLED`                |

**رویدادهای `ORDER_*` هیچ پولی حرکت نمی‌دهند.** `docs/04` § ۴٫۱۴ آن‌ها را در
فهرست مصرف `economic` آورده، و `economic-service` هیچ‌کدام را مصرف نمی‌کند
(ADR-032). این ADR آن وضع را عوض نمی‌کند و **عمداً**: اگر هم فرمان بزنیم و هم
رویداد، دو مسیر برای یک اثر مالی داریم و روزی هر دو اجرا می‌شوند.

رویدادهای `ORDER_*` **واقعیت دامنه‌ای** اعلام می‌کنند — برای `analytics`،
`notification` و `supplier` که هنوز نیستند. مصرف‌کننده اقتصادی‌شان، اگر روزی لازم
شود، تصمیم آن سرویس است.

### ۲. یک تراکنش اقتصادی به‌ازای هر سفارش

`order.economicTransactionId` یک ستون **UNIQUE** است. یعنی «یک تعهد مالی به‌ازای
هر سفارش» یک Constraint پایگاه داده است، نه یک قاعده کد. یک Saga که دو بار
`createObligation` را اجرا کند، بار دوم از پایگاه داده خطا می‌گیرد — و در عمل
هرگز به آنجا نمی‌رسد، چون `Idempotency-Key` قطعی همان تراکنش اول را برمی‌گرداند.

نگاشت به `economic`:

| فیلد سفارش                     | فیلد تراکنش                            |
| ------------------------------ | -------------------------------------- |
| `order.organizationId`         | `organizationId` (پرداخت‌کننده)        |
| `order.supplierOrganizationId` | `counterpartyOrganizationId`           |
| `order.totalAmountMinor`       | `grossAmountMinor`                     |
| —                              | `transactionType: 'MARKETPLACE_ORDER'` |
| `order.id`                     | `sourceReference`                      |
| —                              | `sourceType: 'ORDER'`                  |

`sourceType: 'ORDER'` یک رشته است که `economic` هیچ معنایی برایش قائل نیست؛ فقط
ثبتش می‌کند. پس این نگاشت **قرارداد `ORDER_*` اختراع نمی‌کند** — چیزی که ADR-032
ممنوع کرده بود — بلکه از API موجود استفاده می‌کند.

### ۳. توکن SERVICE با `org_id` امضاشده

هر فراخوان با `X-Internal-Token` می‌رود که `marketplace-service` امضایش می‌کند:

```ts
internalTokens.issue('marketplace-service', 'economic-service', 'SERVICE', order.organizationId);
```

مطابق ADR-035: تنانت **درون امضا** است. `X-Organization-Id` فرستاده نمی‌شود —
نه چون ممنوع است (اگر با Claim بخواند پذیرفته می‌شود)، بلکه چون فرستادنش هیچ
اقتداری اضافه نمی‌کند و فقط یک راه برای ناهم‌خوان شدن می‌سازد.

توکن به **سازمان خریدارِ همان سفارش** بسته است. یعنی یک توکن نشت‌کرده دقیقاً به
اندازه یک سازمان روی یک سرویس برای TTL اش می‌ارزد.

فراخوان‌ها از Gateway رد نمی‌شوند: Gateway توکن `RELAY` می‌سازد و هرگز `SERVICE`،
دقیقاً تا مؤلفه‌ای که به بیرون باز است نتواند هویت سرویس جعل کند (D-007).

### ۴. Idempotency و جبران

کلیدها قطعی و مشتق از `orderId`اند (ADR-039 § ۶). خاصیتی که این می‌خرد:

- **Retry دوباره Hold نمی‌زند** — `economic` پاسخ اول را برمی‌گرداند.
- **بازپخش Workflow اثر دوم ندارد** — همان کلید، همان پاسخ.
- **جبران هم Idempotent است** — `refund` با کلید `order:<id>:refund` دو بار
  اجرا شود، یک بازگشت وجه دارد.

جبران **تنها** تا پیش از تأیید دریافت خودکار است. پس از آن، `docs/08` § ۸٫۴
صریح است و ADR-039 § ۵ اجرایش می‌کند: پنج Retry، سپس توقف و هشدار انسانی.

### ۵. اعتراض، مرز واقعی توقف

`RaiseDispute` دو کار در دو سرویس می‌کند و هر دو لازم‌اند:

1. سفارش به `DISPUTED` می‌رود — که هیچ یالی به `SETTLING` ندارد (ADR-038).
2. `POST /v1/transactions/{id}/dispute` تراکنش را `DISPUTED` می‌کند — و
   `economic-service` مستقلاً تسویه‌اش را رد می‌کند.

دو لایه، چون هرکدام بدون دیگری کافی نیست: اگر فقط `marketplace` بداند، یک فرمان
مستقیم به `economic` می‌تواند تسویه کند؛ اگر فقط `economic` بداند، سفارش نمی‌داند
چرا گیر کرده.

### ۶. آنچه `marketplace` هرگز نمی‌کند

- به `rasta_economic` وصل نمی‌شود.
- Journal، کارمزد، پاداش یا مانده کیف پول محاسبه نمی‌کند.
- نرخ کارمزد را نمی‌داند و نمی‌خواند — `netAmountMinor` را از پاسخ تسویه
  می‌گیرد. `AGENTS.md` § ۸ نرخ Hard-Code را ممنوع کرده؛ اینجا اصلاً نرخی وجود
  ندارد که Hard-Code شود.
- موجودی کیف پول را پیش از سفارش بررسی نمی‌کند. `POST /v1/transactions` با
  `holdFunds=true` خودش رد می‌کند و همان خطا به کاربر برمی‌گردد. بررسی جداگانه
  یعنی یک TOCTOU: بین بررسی و Hold، پول می‌تواند خرج شود.

## Alternatives Considered

1. **مصرف‌کننده `ORDER_*` در `economic`.** رد شد — بند ۱، و ADR-032 که همین را
   موکول کرده بود تا مالک رویداد تصمیم بگیرد. مالک، حالا، همین تصمیم را گرفت.
2. **بررسی موجودی پیش از ساخت سفارش.** رد شد — بند ۶، TOCTOU.
3. **`marketplace` کارمزد را محاسبه و نمایش دهد.** رد شد: نرخ نزد `economic`
   است و کپی‌اش یعنی دو مرجع برای یک عدد.
4. **کلید Idempotency تصادفی به‌ازای هر تلاش.** رد شد: هر Retry یک اثر مالی
   تازه می‌ساخت.
5. **فراخوانی `economic` از راه Gateway.** رد شد: Gateway `SERVICE` نمی‌سازد.
6. **جبران خودکار پس از شکست تسویه.** رد شد — `docs/08` § ۸٫۴ صریحاً ممنوعش
   کرده.

## Consequences

**مثبت**

- یک مسیر برای هر اثر مالی. بدون مسیر دوم.
- «یک تعهد به‌ازای هر سفارش» یک Constraint است.
- توکن به یک سازمان و یک سرویس بسته است.

**منفی، پذیرفته‌شده**

- `marketplace` به در دسترس بودن `economic` وابسته است. Temporal همین را قابل
  تحمل می‌کند: Activity در دسترس نبودن را Retry می‌کند و سفارش در `PENDING`
  می‌ماند تا برگردد.
- کارمزد پیش از تسویه برای خریدار نامعلوم است. عمدی: نرخ در **زمان تراکنش**
  اعمال می‌شود و نمایش زودهنگامش یک عدد است که ممکن است درست از آب درنیاید.

## Compliance

- **A-01 / A-02** — فقط REST؛ هیچ خواندن پایگاه داده میان‌سرویسی.
- **A-08** — هر تغییر وضعیت سفارش از Outbox منتشر می‌شود.
- **A-09** — هر Activity مالی Idempotent.
- **S-08** — Zero Trust؛ توکن SERVICE امضاشده به‌ازای هر تنانت.
- **ADR-035** — تنانت از Claim امضاشده، نه Header.
- **AGENTS.md § ۸** — هیچ نرخ کارمزدی در این سرویس وجود ندارد.

## References

- `docs/adr/ADR-032-economic-consumption-boundary.md`
- `docs/adr/ADR-035-signed-internal-tenant-context.md`
- `services/economic-service/src/transaction/transaction.controller.ts`
- `docs/08-workflow-architecture.md` § ۸٫۴
- `docs/10-economic-architecture.md` § ۱۰٫۵
