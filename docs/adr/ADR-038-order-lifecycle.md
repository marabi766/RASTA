# ADR-038: چرخه‌عمر سفارش — یک ماشین حالت صریح

- **وضعیت:** Accepted
- **تاریخ:** 2026-08-29
- **اهمیت:** یکپارچگی مالی، صحت دامنه
- **مرتبط:** ADR-037 (مالکیت Aggregate)، ADR-039 (Saga)، ADR-040 (مرز اقتصادی)، ADR-043 (مهلت‌ها)

## Context

`docs/08` § ۸٫۴ چرخه سفارش را ده مرحله می‌نویسد و `docs/17` می‌گوید «تسویه فقط
پس از `ORDER_RECEIPT_CONFIRMED`». اما هیچ سندی **نام وضعیت‌ها** را نمی‌دهد — فقط
نام رویدادها را.

این تفاوت مهم است: رویداد چیزی است که اتفاق افتاده، وضعیت چیزی است که سفارش
**الان** در آن است. یک ماشین حالت که از نام رویدادها ساخته شود، وضعیت‌هایی
می‌سازد که هیچ‌کس در آن‌ها منتظر چیزی نیست.

`economic-service` همین مسئله را با `transaction/state-machine.ts` حل کرد: یک
جدول گذار داده‌ای، نه `if` تودرتو. آن الگو اینجا تکرار می‌شود، چون همان دلیل را
دارد — «آیا این گذار مجاز است» باید با خواندن یک جدول پاسخ بگیرد.

## Decision

### ۱. وضعیت‌ها

| وضعیت                           | معنی                                                  | پایانی؟ |
| ------------------------------- | ----------------------------------------------------- | ------- |
| `PENDING`                       | سفارش ثبت شد؛ هنوز هیچ پولی متعهد نشده                |         |
| `FUNDS_HELD`                    | تعهد اقتصادی ساخته و وجه بلوکه شد                     |         |
| `CONFIRMED`                     | تأمین‌کننده سفارش را پذیرفت                           |         |
| `AWAITING_RECEIPT_CONFIRMATION` | تأمین‌کننده تحویل را ثبت کرد؛ منتظر تأیید صریح خریدار |         |
| `RECEIPT_CONFIRMED`             | خریدار دریافت را تأیید کرد؛ تسویه مجاز شد             |         |
| `SETTLING`                      | فرمان تسویه به `economic-service` رفته و پاسخ نیامده  |         |
| `COMPLETED`                     | تسویه انجام شد                                        | ✅      |
| `DISPUTED`                      | اعتراض ثبت شد؛ **تسویه کاملاً متوقف**                 |         |
| `CANCELLING`                    | لغو آغاز شد؛ جبران مالی در جریان                      |         |
| `CANCELLED`                     | لغو شد و جبران کامل انجام گرفت                        | ✅      |
| `FAILED`                        | سفارش پیش از تعهد پول شکست خورد (مثلاً موجودی ناکافی) | ✅      |

### ۲. چرا `FULFILLED` یک وضعیت جدا نیست

`ORDER_FULFILLED` یک **رویداد** است و منتشر می‌شود. اما وضعیتی که سفارش پس از آن
در آن می‌نشیند، «تحویل‌شده» نیست؛ **«منتظر تأیید خریدار»** است.

اگر هر دو وضعیت باشند، گذار `FULFILLED → AWAITING_RECEIPT_CONFIRMATION` هیچ
بازیگری ندارد — نه کاربری، نه سرویسی، نه رویدادی. یعنی دقیقاً همان **گذار بی‌صدا**
که باید از آن پرهیز کرد. یک واقعیت است که از دو طرف دیده می‌شود: تأمین‌کننده
تحویل داد، پلتفرم منتظر است. وضعیت، چیزی را نام می‌برد که پلتفرم منتظرش است، چون
همان است که تعیین می‌کند بعدی چه کسی باید کاری کند.

`Fulfillment` به‌عنوان یک موجودیت فرزند ثبت می‌شود و `fulfilledAt`،
`fulfilledBy` و `trackingReference` را نگه می‌دارد — پس «کِی تحویل شد» گم نمی‌شود.

### ۳. جدول گذار

| از                              | به                              | بازیگر               | فرمان                          |
| ------------------------------- | ------------------------------- | -------------------- | ------------------------------ |
| `PENDING`                       | `FUNDS_HELD`                    | Saga (Activity)      | `economic.createObligation`    |
| `PENDING`                       | `FAILED`                        | Saga (Activity)      | Hold شکست خورد                 |
| `PENDING`                       | `CANCELLING`                    | خریدار               | `CancelOrder`                  |
| `FUNDS_HELD`                    | `CONFIRMED`                     | تأمین‌کننده          | `ConfirmOrder`                 |
| `FUNDS_HELD`                    | `CANCELLING`                    | خریدار / تأمین‌کننده | `CancelOrder`                  |
| `FUNDS_HELD`                    | `DISPUTED`                      | خریدار               | `RaiseDispute`                 |
| `CONFIRMED`                     | `AWAITING_RECEIPT_CONFIRMATION` | تأمین‌کننده          | `ConfirmFulfillment`           |
| `CONFIRMED`                     | `CANCELLING`                    | خریدار / تأمین‌کننده | `CancelOrder`                  |
| `CONFIRMED`                     | `DISPUTED`                      | خریدار               | `RaiseDispute`                 |
| `AWAITING_RECEIPT_CONFIRMATION` | `RECEIPT_CONFIRMED`             | **خریدار**           | `ConfirmReceipt`               |
| `AWAITING_RECEIPT_CONFIRMATION` | `DISPUTED`                      | خریدار               | `RaiseDispute`                 |
| `AWAITING_RECEIPT_CONFIRMATION` | `CANCELLING`                    | خریدار               | `CancelOrder`                  |
| `RECEIPT_CONFIRMED`             | `SETTLING`                      | Saga (Activity)      | `economic.authoriseSettlement` |
| `RECEIPT_CONFIRMED`             | `DISPUTED`                      | خریدار               | `RaiseDispute`                 |
| `SETTLING`                      | `COMPLETED`                     | Saga (Activity)      | `economic.settle` موفق         |
| `SETTLING`                      | `RECEIPT_CONFIRMED`             | Saga                 | تسویه شکست خورد → Retry        |
| `DISPUTED`                      | `RECEIPT_CONFIRMED`             | `UNION_ADMIN`        | `ResolveDispute(SETTLE)`       |
| `DISPUTED`                      | `CANCELLING`                    | `UNION_ADMIN`        | `ResolveDispute(REFUND)`       |
| `CANCELLING`                    | `CANCELLED`                     | Saga (Activity)      | جبران مالی موفق                |

هر گذاری که در این جدول نیست، `422 BUSINESS_RULE_VIOLATION` می‌گیرد. جدول، داده
است و در `order/state-machine.ts` زندگی می‌کند؛ تست آن، تک‌تک گذارهای مجاز و یک
نمونه از هر گذار غیرمجاز را می‌آزماید.

### ۴. سه قاعده‌ای که ماشین حالت **تنها** ضامنشان نیست

جدول بالا لازم است، کافی نیست. سه Invariant مالی، علاوه بر آن، در پایگاه داده
هم `CHECK` دارند:

1. **تسویه پیش از تأیید دریافت ممکن نیست.** تنها ورودی `SETTLING`،
   `RECEIPT_CONFIRMED` است. و `economic-service` هم مستقلاً همین را می‌گوید:
   `authorise-settlement` روی تراکنشی که `HELD` نیست، رد می‌شود.
2. **اعتراض تسویه را متوقف می‌کند.** `DISPUTED` هیچ یالی به `SETTLING` ندارد.
   خروج از آن فقط با تصمیم `UNION_ADMIN` است، و مقصدش دوباره از ابتدای مسیر
   می‌گذرد.
3. **وضعیت پایانی بازپخش نمی‌شود.** `COMPLETED`، `CANCELLED` و `FAILED` هیچ یال
   خروجی ندارند. یعنی یک فرمان تکراری روی سفارش تکمیل‌شده نمی‌تواند اثر مالی
   دوم بگذارد — همان قاعده‌ای که `ck_order_terminal_immutable` در پایگاه داده
   دوباره تضمینش می‌کند.

### ۵. تأیید دریافت فقط از سوی خریدار

`ConfirmReceipt` تنها فرمانی است که پول را آزاد می‌کند، و تنها سازمانی که
می‌تواند اجرایش کند، **مالک سفارش** است. نه تأمین‌کننده، نه اپراتور پلتفرم، نه
یک سرویس. این در `access.ts` سطح Object بررسی می‌شود، نه فقط با `@Roles`.

## Alternatives Considered

1. **وضعیت‌ها را از نام رویدادها بسازیم.** رد شد — بند ۲.
2. **`if` تودرتو در Service.** رد شد: `AGENTS.md` A-11، و همان درسی که
   `economic-service` با `state-machine.ts` گرفت.
3. **`FULFILLED` و `AWAITING_RECEIPT_CONFIRMATION` هر دو.** رد شد — گذار بدون
   بازیگر.
4. **`SETTLING` نداشتن و مستقیم `RECEIPT_CONFIRMED → COMPLETED`.** رد شد: تسویه
   یک فراخوان شبکه‌ای است و می‌تواند Timeout بخورد. بدون وضعیت میانی، یک سفارش
   که تسویه‌اش نامعلوم است شبیه سفارشی است که تسویه نشده — و Retry می‌شود.
5. **`DISPUTED` به‌عنوان یک Flag به‌جای وضعیت.** رد شد: Flag یعنی هر گذار باید
   جداگانه بررسی‌اش کند، و یکی فراموش می‌شود. وضعیت یعنی نبودِ یال، خودش قاعده
   است.

## Consequences

**مثبت**

- «چه کسی الان باید کاری کند» از خودِ نام وضعیت خوانده می‌شود.
- توقف تسویه هنگام اعتراض، یک یالِ نبوده است نه یک بررسی نوشته‌شده.
- بازپخش یک فرمان روی سفارش پایانی، ساختاراً بی‌اثر است.

**منفی، پذیرفته‌شده**

- یازده وضعیت برای یک سفارش زیاد به نظر می‌رسد. اما `CANCELLING` و `SETTLING`
  دقیقاً همان‌هایی‌اند که یک Saga در حال اجرا به آن‌ها نیاز دارد، و حذفشان یعنی
  «در حال جبران» و «جبران‌شده» یکی شوند.

## Compliance

- **A-11** — گردش‌کار چندمرحله‌ای، ماشین حالت صریح.
- **A-06** — هیچ ورودی دفتر کلی از این سرویس تغییر نمی‌کند؛ همه از راه API.
- **S-03** — `ConfirmReceipt` بررسی مالکیت سطح Object دارد.
- **S-06** — هر گذار یک ردیف `order_status_history` می‌نویسد.

## References

- `docs/08-workflow-architecture.md` § ۸٫۴
- `docs/17-mvp-scope.md` § Marketplace
- `services/economic-service/src/transaction/state-machine.ts` (الگو)
- `docs/adr/ADR-040-marketplace-economic-boundary.md`
- `docs/adr/ADR-043-order-timeout-policy.md`
