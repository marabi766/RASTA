# ADR-036: کلید پارتیشن رویدادهای اقتصادی — ترتیب به‌ازای تراکنش

- **وضعیت:** Accepted
- **تاریخ:** 2026-08-29
- **اهمیت:** ترتیب رویداد مالی — پیش‌نیاز هر Saga روی `rasta.economic.v1`
- **حل‌کننده:** `docs/24-open-questions.md` § Q-26
- **مرتبط:** ADR-006 (Kafka)، ADR-021 (Outbox)، ADR-031 (هماهنگی تسویه)،
  ADR-032 (مرز مصرف اقتصادی)، ADR-034 (مالکیت حساب امانی)

## Context

`LedgerService.enqueue` کلید پارتیشن را از `aggregateId` می‌گیرد، مگر جایی که
فراخوان‌کننده صریحاً `partitionKey` بدهد. نتیجه امروز — اندازه‌گیری‌شده روی Kafka
واقعی در `tests/e2e/specs/economic/05-correlation.e2e-spec.ts`، نه استنتاج‌شده:

| رویداد                 | کلید پیش از این ADR |
| ---------------------- | ------------------- |
| `FUNDS_HELD`           | `holdId`            |
| `FUNDS_RELEASED`       | `holdId`            |
| `JOURNAL_POSTED`       | `journalId`         |
| `PAYMENT_COMPLETED`    | `paymentIntentId`   |
| `SETTLEMENT_COMPLETED` | `transactionId`     |
| `COMMISSION_APPLIED`   | `transactionId`     |

یعنی رویدادهای **یک تراکنش** روی تا چهار پارتیشن پخش می‌شوند. Kafka ترتیب را فقط
**درون یک پارتیشن** تضمین می‌کند، پس مصرف‌کننده‌ای که تراکنش را بازسازی می‌کند
می‌تواند `SETTLEMENT_COMPLETED` را پیش از `FUNDS_HELD` ببیند — پول را آزادشده
ببیند پیش از آنکه بداند اصلاً بلوکه شده بود.

کامنت `outbox/kafka.publisher.ts` تضمین قوی‌تری توصیف می‌کرد از آنچه کد می‌داد:
می‌گفت `maxInFlightRequests=1` ترتیب `FUNDS_HELD` و `SETTLEMENT_COMPLETED` را
«برای یک تراکنش» نگه می‌دارد، در حالی که این فقط درون یک پارتیشن درست است. آن
کامنت هنگام ثبت Q-26 اصلاح شد؛ این ADR خودِ رفتار را اصلاح می‌کند.

Q-26 باز ماند چون انتخاب کلید پارتیشن، بیان نیاز **مصرف‌کننده** است و تنها
مصرف‌کننده واقعی این Topic — `marketplace-service` — هنوز وجود ندارد. همان
استدلالی که ADR-032 با آن قراردادهای `ORDER_*` را موکول کرد. صاحب محصول در
۲۰۲۶-۰۸-۲۹ آن نیاز را اعلام کرد، پس دیگر حدس زدن نیست.

## Decision

### ۱. دو مفهوم که یکی نیستند

این ADR دو چیز را که تا امروز در یک فیلد جمع می‌شدند از هم جدا می‌کند:

| مفهوم                  | فیلد                             | پرسشی که پاسخ می‌دهد                       |
| ---------------------- | -------------------------------- | ------------------------------------------ |
| **هویت Aggregate**     | `aggregateType` + `aggregateId`  | این رویداد **درباره چیست**؟                |
| **کلید ترتیب پارتیشن** | `partitionKey` → کلید پیام Kafka | این رویداد باید **با چه چیزی مرتب بماند**؟ |

`FUNDS_HELD` **درباره** یک `WalletHold` است. آن هویت در Envelope می‌ماند و تغییر
نمی‌کند، چون یک Audit یا یک Read Model که رویداد را به موجودیت مالکش برمی‌گرداند
دقیقاً به همان نیاز دارد. اما آنچه این رویداد باید با آن **مرتب** بماند،
`WalletHold` نیست؛ تراکنشی است که Hold برای آن گذاشته شده.

پیش از این ADR این دو یک فیلد بودند و هر جدایی به‌صورت یک `partitionKey:` دستی در
Call Site نوشته می‌شد. مسئله آن رویکرد این نیست که زشت است؛ این است که **سکوت
خودش یک تصمیم است**: هر رویداد تازه‌ای که کسی اضافه کند بی‌سروصدا کلید Aggregate
می‌گیرد، حتی وقتی به یک تراکنش تعلق دارد.

### ۲. قاعده

هر رویداد اقتصادی دقیقاً یک **Partition Scope** دارد:

| Scope            | کلید                          | معنی                                                 |
| ---------------- | ----------------------------- | ---------------------------------------------------- |
| `TRANSACTION`    | `transactionId`               | رویداد به چرخه‌عمر یک تراکنش تعلق دارد               |
| `WALLET`         | `walletId`                    | رویداد فقط به چرخه‌عمر یک کیف پول تعلق دارد          |
| `JOURNAL`        | `journalId`                   | رویداد فقط به چرخه‌عمر یک سند دفتر کل تعلق دارد      |
| `PAYMENT_INTENT` | `paymentIntentId`             | رویداد پیش از آنکه تراکنشی وجود داشته باشد رخ می‌دهد |
| `REWARD`         | `rewardId`                    | رویداد فقط به یک اعطای پاداش تعلق دارد               |
| `REWARD_SUBJECT` | `${organizationId}:${userId}` | رویداد به موجودی پاداش یک شخص تعلق دارد              |

و یک قاعده که بر همه مقدم است:

> **برای رویدادی که Transaction-Scoped نیست، `transactionId` اختراع نمی‌شود.**

اگر تراکنشی در کار نیست، Scope دیگری انتخاب می‌شود — نه یک شناسه ساختگی و نه
شناسه‌ای که «نزدیک‌ترین» به نظر می‌رسد.

### ۳. طبقه‌بندی هر یازده رویداد

| رویداد                 | `aggregateType` / `aggregateId`     | Scope            | کلید Kafka                    | تغییر؟ |
| ---------------------- | ----------------------------------- | ---------------- | ----------------------------- | ------ |
| `WALLET_OPENED`        | `Wallet` / `walletId`               | `WALLET`         | `walletId`                    | —      |
| `FUNDS_HELD`           | `WalletHold` / `holdId`             | `TRANSACTION`    | `transactionId`               | ✅     |
| `FUNDS_RELEASED`       | `WalletHold` / `holdId`             | `TRANSACTION`    | `transactionId`               | ✅     |
| `PAYMENT_AUTHORIZED`   | `PaymentIntent` / `paymentIntentId` | `PAYMENT_INTENT` | `paymentIntentId`             | —      |
| `PAYMENT_COMPLETED`    | `PaymentIntent` / `paymentIntentId` | `TRANSACTION`    | `transactionId`               | ✅     |
| `PAYMENT_FAILED`       | `PaymentIntent` / `paymentIntentId` | `PAYMENT_INTENT` | `paymentIntentId`             | —      |
| `COMMISSION_APPLIED`   | `Commission` / `commissionId`       | `TRANSACTION`    | `transactionId`               | —      |
| `REWARD_GRANTED`       | `Reward` / `rewardId`               | `REWARD`         | `rewardId`                    | —      |
| `REWARD_LEVEL_CHANGED` | `RewardBalance` / `org:user`        | `REWARD_SUBJECT` | `${organizationId}:${userId}` | —      |
| `SETTLEMENT_COMPLETED` | `Settlement` / `settlementId`       | `TRANSACTION`    | `transactionId`               | —      |
| `JOURNAL_POSTED`       | `Journal` / `journalId`             | شرطی — پایین‌تر  | `transactionId ?? journalId`  | ✅     |

چهار رویداد کلیدشان عوض می‌شود. `aggregateType` و `aggregateId` هیچ‌کدام تغییر
نمی‌کنند — همان نکته بند ۱.

#### چرا `PAYMENT_AUTHORIZED` و `PAYMENT_FAILED` تراکنشی نیستند

بررسی‌شده روی رابطه‌ای که خود این سرویس مالک آن است، نه حدس‌زده:
`PaymentIntent.transactionId` در `prisma/schema.prisma` از نوع `String?` است و
کامنت خودِ ستون می‌گوید «تراکنش دفتر کلی که این پرداخت تأمینش می‌کند، **پس از
Capture**». در `payment.service.ts` ردیف `transaction` فقط داخل `capture()` ساخته
می‌شود.

پس در لحظه انتشار `PAYMENT_AUTHORIZED` هیچ تراکنشی وجود **ندارد**؛ و
`PAYMENT_FAILED` هرگز تراکنشی نخواهد داشت، چون پولی نرسیده و هیچ سند دفتر کلی
Post نمی‌شود — `fail()` عمداً هیچ حرکت دفتر کلی ندارد. Payload هیچ‌کدام
`transactionId` ندارد و قرار هم نیست پیدا کند. هر دو کلید Aggregate خودشان،
`paymentIntentId`، را نگه می‌دارند.

این همان بندی است که قاعده «اختراع نکن» را واقعی می‌کند: ساده‌ترین راه برای
«یکدست کردن» این جدول، دادن یک `transactionId` به این دو رویداد بود — یعنی نوشتن
یک دروغ در یک Payload مالی.

#### چرا `JOURNAL_POSTED` شرطی است

`Journal.transactionId` در Schema **Nullable** است و Payload هم آن را
`z.string().nullable()` اعلام می‌کند. هر دو حالت واقعی‌اند و هر دو امروز رخ
می‌دهند:

- سند یک Hold، یک Settlement یا یک Top-Up **تراکنش دارد** → `TRANSACTION` /
  `transactionId`. نتیجه‌اش این است که یک Audit که `JOURNAL_POSTED` می‌خواند و یک
  Saga که `FUNDS_HELD` می‌خواند، یک تراکنش را با ترتیب یکسان می‌بینند.
- سند یک `REWARD_GRANT` **تراکنش ندارد**: `reward.service.ts` هنگام
  `wallets.credit` هیچ `transactionId` نمی‌دهد، چون پاداش از هیچ تراکنش تجاری
  زاده نشده → `JOURNAL` / `journalId`.

این یک Fallback نیست. Fallback یعنی «نمی‌دانم، پس این یکی را بردار». اینجا هر دو
شاخه در Contract اعلام شده‌اند، هر دو تست دارند، و انتخاب از روی یک فیلدِ صریحاً
Nullable انجام می‌شود.

### ۴. یک Policy، نه رشته‌های پراکنده

قاعده در **یک فایل** زندگی می‌کند — `services/economic-service/src/events/routing.ts` —
و به‌صورت یک Mapped Type روی اتحاد نام رویدادها نوشته شده:

```ts
export const PARTITION_KEY_POLICY: { [N in EconomicEventName]: PartitionRule<N> } = { … };
```

سه خاصیتی که این شکل می‌خرد:

1. **افزودن رویداد بدون تصمیم، Compile نمی‌شود.** یک نام تازه در `ECONOMIC_EVENTS`
   بلافاصله `PARTITION_KEY_POLICY` را ناقص می‌کند و `pnpm typecheck` شکست
   می‌خورد. این خواسته صریح صاحب محصول است و همان چیزی که `Record<string, string>`
   پیشین نمی‌داد: کلید گمشده در آن، `undefined` در زمان اجرا بود.
2. **هر Rule، Payload تایپ‌شده خودش را می‌گیرد**، پس نوشتن `p.transactionId` روی
   رویدادی که چنین فیلدی ندارد Compile نمی‌شود.
3. **پارامتر `partitionKey` از `enqueue` حذف شد.** دیگر هیچ Call Site ای نمی‌تواند
   Policy را دور بزند؛ `commission` و `settlement` که آن را دستی می‌گذاشتند حالا
   از همان Policy می‌گیرند.

کلید تهی `Error` می‌دهد، نه یک پیام بی‌کلید: پیام بدون کلید را Kafka به‌صورت
Round-Robin پخش می‌کند، که دقیقاً همان از‌دست‌رفتن ترتیبی است که این ADR برای
جلوگیری از آن نوشته شده — و بی‌صدا اتفاق می‌افتد.

## ضمانت‌ها و نبودِ ضمانت‌ها

**ضمانت می‌شود**

- همه رویدادهای چرخه‌عمر یک تراکنش — `FUNDS_HELD`، `FUNDS_RELEASED`،
  `PAYMENT_COMPLETED`، `COMMISSION_APPLIED`، `SETTLEMENT_COMPLETED` و
  `JOURNAL_POSTED`ِ همان تراکنش — روی **یک پارتیشن** می‌نشینند و به ترتیبی که
  Outbox نوشته مصرف می‌شوند.
- `maxInFlightRequests=1` روی Producer یعنی این ترتیب در Retry هم به‌هم نمی‌خورد.

**ضمانت نمی‌شود، و عمداً**

- **ترتیب سراسری.** هرگز لازم نبوده و ADR-006 هم آن را رد کرده است.
- **ترتیب میان دو تراکنش**، حتی روی یک کیف پول. موجودی کیف پول از دفتر کل و زیر
  قفل ردیف بازمحاسبه می‌شود (`recomputeFromLedger`)، نه از ترتیب مصرف رویداد؛ پس
  مصرف‌کننده‌ای که به این ترتیب تکیه کند به چیزی تکیه کرده که هرگز مرجع نبوده.
- **ترتیب میان `PAYMENT_AUTHORIZED` و `PAYMENT_COMPLETED`ِ یک Intent.** این
  هزینه واقعی تصمیم است و پنهانش نمی‌کنیم: در لحظه Authorize هیچ `transactionId`
  وجود ندارد، پس **هیچ** کلیدی نمی‌تواند هر دو را بپوشاند مگر آنکه
  `PAYMENT_COMPLETED` از تراکنشش جدا شود. مصرف‌کننده‌ای که چرخه یک Intent را دنبال
  می‌کند باید بر `paymentIntentId` در Payload تکیه کند، نه بر ترتیب پارتیشن.
- **ترتیب میان کیف پول و تراکنش.** `WALLET_OPENED` روی `walletId` می‌ماند؛ یک کیف
  پول همیشه پیش از هر Hold ی روی آن باز شده، و آن یک ترتیب علّی است نه پارتیشنی.

## Retry و DLQ

- **Retry انتشار.** `OutboxRelay` هرگز ردیف را بازنویسی نمی‌کند: در شکست فقط
  `attempts` را زیاد و `last_error` را می‌نویسد و `published_at` را `NULL`
  می‌گذارد. `partition_key` یک ستون Persist‌شده است، پس تلاش دوم **همان** کلید را
  می‌فرستد. با تست اثبات شده، نه استنتاج‌شده.
- **DLQ.** `economic-service` امروز **تولیدکننده** است و هیچ‌جا روی
  `rasta.economic.v1.retry` یا `.dlq` نمی‌نویسد. DLQ نگرانی سمت مصرف‌کننده است و
  این Topic هنوز مصرف‌کننده‌ای ندارد (ADR-032).
- **Replay.** هر یازده رویداد اقتصادی در `NEVER_AUTO_REPLAY` هستند، پس هر بازپخشی
  دستی است (`docs/runbooks/replay-dlq.md`). قاعده الزام‌آور: بازپخش باید با **همان
  کلید اصلی** انجام شود. چون Policy تابعی محض از Payload است، همان Payload همیشه
  همان کلید را می‌دهد — بازپخش نمی‌تواند ترتیب را جابه‌جا کند مگر آنکه کسی عمداً
  Payload را دست‌کاری کند.

## سازگاری با مصرف‌کننده‌ها

هیچ Consumer ای برای `rasta.economic.v1` وجود ندارد (ADR-032؛ `marketplace`،
`supplier` و `notification` هنوز ساخته نشده‌اند). پس این تغییر:

- **هیچ Payload ای را عوض نمی‌کند.** هیچ فیلدی افزوده، حذف یا بازنام‌گذاری نشد، پس
  `eventVersion` طبق `docs/07` § ۷٫۸ ثابت می‌ماند. هیچ‌کدام از رویدادهای
  Transaction-Scoped به افزودن فیلد نیاز نداشت — همه‌شان `transactionId` را از
  پیش حمل می‌کردند.
- **هیچ Migration ای ندارد.** ستون `partition_key` از پیش وجود دارد؛ فقط مقداری
  که در آن نوشته می‌شود عوض می‌شود، و تنها برای ردیف‌های جدید.
- **ردیف‌های منتشرنشده قدیمی** با کلید قدیمی‌شان منتشر می‌شوند. این عمدی است:
  بازنویسی ردیف Outbox یعنی تغییر یک رویداد از پیش ثبت‌شده. با نبودِ مصرف‌کننده،
  اثرش صفر است.

بهترین لحظه برای این تغییر دقیقاً همین حالا است: پس از آنکه یازده رویداد واقعی
شده‌اند و پیش از آنکه اولین مصرف‌کننده نوشته شود.

## Alternatives Considered

1. **همه‌چیز روی `walletId`.** `docs/07` § ۷٫۷ کیف پول را «بحرانی» می‌نامد. رد
   شد: این کار رویدادهای دو تراکنش بی‌ربط روی یک کیف پول را در هم می‌بافد و
   همچنان `SETTLEMENT_COMPLETED` را — که دو سازمان دارد — بی‌خانه می‌گذارد. نیت
   آن بند «Hold و Release یک پول نباید نامرتب برسند» است، و آن دو همیشه یک
   تراکنش‌اند؛ پس تصمیم این ADR همان نیت را بهتر برآورده می‌کند.
2. **همه‌چیز روی `transactionId`، با ساختن یکی در صورت نبود.** رد شد — نقض مستقیم
   دستور صاحب محصول، و نوشتن یک شناسه ساختگی در یک Payload مالی.
3. **کلید مرکب `${transactionId}:${walletId}`.** رد شد: Hash روی کل رشته گرفته
   می‌شود، پس هیچ‌کدام از دو ترتیب واقعاً تضمین نمی‌شود.
4. **نگه‌داشتن `partitionKey` اختیاری در `enqueue` کنار Policy.** رد شد: تا وقتی
   راه دور زدن باز باشد، Policy توصیه است نه قاعده — و Q-26 دقیقاً از همان راه
   دور زدن زاده شد.
5. **بردن Policy به `packages/contracts`.** رد شد: AGENTS.md A-03. این منطق
   دامنه‌ای `economic-service` است، نه Type مشترک.
6. **صبر تا ساخته‌شدن `marketplace-service`.** همان تصمیم موقت Q-26 بود. رد شد
   چون نیاز مصرف‌کننده حالا اعلام شده، و عوض کردن کلید **پس از** وجود مصرف‌کننده
   یعنی یک مهاجرت هماهنگ به‌جای یک تغییر یک‌طرفه.
7. **افزایش تعداد پارتیشن یا `maxInFlightRequests`.** رد شد: هیچ‌کدام مسئله را حل
   نمی‌کند. مسئله ضعیف بودن ترتیب درون پارتیشن نیست؛ این است که رویدادها در
   پارتیشن‌های اشتباه‌اند.

## Consequences

**مثبت**

- یک مصرف‌کننده می‌تواند چرخه‌عمر مالی یک تراکنش را با ترتیب تضمین‌شده بازسازی
  کند — پیش‌نیازی که `docs/08` § ۸٫۶ برای `OrderSagaWorkflow` فرض کرده بود.
- افزودن رویداد بدون تصمیم درباره ترتیب دیگر ممکن نیست؛ Compiler جلویش را
  می‌گیرد.
- هویت Aggregate و ترتیب پارتیشن دیگر در یک فیلد قاطی نیستند.

**منفی، و پذیرفته‌شده**

- ترتیب دو فاز یک `PaymentIntent` دیگر روی یک پارتیشن نیست. بالا مستند شد.
- بار پارتیشن‌ها اندکی نامتوازن‌تر می‌شود: تراکنش‌های پرحجم روی یک پارتیشن جمع
  می‌شوند. با سه پارتیشن و حجم امروز، این یک ملاحظه است نه یک مسئله.
- `fleet-service` و `maintenance-service` هنوز `partitionKey` را در Call Site
  می‌نویسند (`assetId`، استثنای مستند `docs/events/README.md`). دامنه این ADR
  رویدادهای اقتصادی است؛ یکدست کردن آن دو Taskی جداست و در `PROJECT_MEMORY` ثبت
  شد.

## Compliance

- **A-08** — انتشار همچنان فقط از راه Outbox.
- **A-03** — Policy در سرویس است، نه در `packages/`.
- **A-06** — هیچ ورودی دفتر کلی لمس نشد.
- **S-09** — کلید پارتیشن یک شناسه داخلی است و هیچ داده حساسی حمل نمی‌کند.
- **ADR-006** — قاعده «ترتیب فقط به‌ازای پارتیشن» دست‌نخورده است؛ این ADR فقط
  می‌گوید پارتیشن باید بر چه اساسی انتخاب شود.
- **ADR-022** — هیچ تغییری در نمایش پول.

## References

- `docs/07-event-architecture.md` § ۷٫۷ (با همین ADR به‌روز شد)
- `docs/10-economic-architecture.md` § ۱۰٫۱۲
- `docs/events/README.md` § Economic
- `services/economic-service/src/events/routing.ts`
- `services/economic-service/src/events/routing.spec.ts`
- `services/economic-service/test/outbox.int-spec.ts`
- `tests/e2e/specs/economic/05-correlation.e2e-spec.ts`
- `docs/24-open-questions.md` § Q-26
