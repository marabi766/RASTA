# ADR-033: پولی‌سازی پاداش — امتیاز همیشه، اعتبار فقط وقتی نرخ تبدیل پیکربندی شده باشد

- **وضعیت:** Accepted
- **تاریخ:** 2026-08-28
- **اهمیت:** یکپارچگی مالی، CONSTRAINT حکمرانی، صداقت داده
- **مرتبط:** ADR-013 (Wallet/Ledger)، ADR-022 (نمایش پول)، ADR-023 (حکمرانی پیکربندی‌پذیر)، ADR-032 (مرز مصرف)

## Context

سه جمله در سه سند، وقتی کنار هم گذاشته می‌شوند، یک تناقض ظاهری می‌سازند:

۱. `docs/10` § ۱۰٫۸: منبع تأمین پاداش «از سهم تعریف‌شده اتحادیه از کارمزد دریافتی» است،
«بنابراین هر `REWARD_GRANTED` یک Journal با بدهکار `EXP-PLATFORM-REWARD` می‌زند — پاداش
یک هزینه واقعی ثبت‌شده است، نه یک عدد نمایشی.»

۲. `docs/10` § ۱۰٫۸ در همان بخش، `reward_rule` را با ستون `points` تعریف می‌کند — امتیاز،
نه ریال. و `RewardLevel` را بر مبنای **امتیاز انباشته** می‌سازد.

۳. `docs/24` Q-09 🟠 هنوز **باز** است: «چه درصدی از کارمزد دریافتی به پاداش کاربران
اختصاص می‌یابد؟» تصمیم موقتش می‌گوید «نرخ تبدیل امتیاز به اعتبار یک پارامتر پیکربندی است».

اگر هر `REWARD_GRANTED` باید Journal بزند، و مبلغ آن Journal از نرخ تبدیلی می‌آید که
هنوز تصمیم‌گیری نشده، آنگاه یکی از این سه اتفاق باید بیفتد:

- **یک نرخ پیش‌فرض اختراع می‌شود.** نقض مستقیم ADR-023 و Q-09.
- **Journal با مبلغ صفر Post می‌شود.** یک Journal بدون ورودی، یا با ورودی صفر — که
  `CHECK (amount_minor > 0)` در `docs/05` § ۵٫۴ آن را رد می‌کند، و به‌درستی.
- **اعطای پاداش تا تعیین نرخ متوقف می‌شود.** یعنی کل موتور پاداش، سطوح و ضدتقلب هم با
  خودش متوقف می‌شود، برای پرسشی که به آن‌ها ربطی ندارد.

هیچ‌کدام قابل قبول نیست.

### مسئله دوم — Cashback

`docs/24` Q-07 🟡 و `docs/10` § ۱۰٫۸ هر دو `RewardType.CASHBACK` را «پس از بررسی
مقرراتی» مشروط کرده‌اند، پشت Feature Flag با پیش‌فرض خاموش.

## Decision

**امتیاز و اعتبار دو چیزند، و `reward_rule` تعیین می‌کند کدام‌یک — یا هر دو — رخ می‌دهد.**

### ۱. هر `RewardRule` امتیاز می‌دهد؛ ارزش ریالی اختیاری و پیکربندی‌شده است

```
reward_rule
  points                      اجباری، عدد صحیح — همیشه اعطا می‌شود
  creditPerPointMinor         اختیاری، bigint، بدون پیش‌فرض
                              ریالِ اعتبار به‌ازای هر امتیاز
```

`creditPerPointMinor` **هیچ مقدار پیش‌فرضی ندارد و در هیچ Seed تجاری‌ای پر نمی‌شود.**
این همان الگوی `commission_rule` است و به همان دلیل: نرخش تصمیم کارگروه راهبری است، نه
تصمیم فنی (ADR-023).

### ۲. دو نوع نتیجه، و هر دو صادق‌اند

| حالت قاعده                     | امتیاز | Journal                                                     | `REWARD_GRANTED`                                        |
| ------------------------------ | ------ | ----------------------------------------------------------- | ------------------------------------------------------- |
| `creditPerPointMinor` نال      | اعطا   | **هیچ**                                                     | منتشر، با `creditAmountMinor: "0"` و `monetised: false` |
| `creditPerPointMinor` مقداردار | اعطا   | بدهکار `EXP-PLATFORM-REWARD` / بستانکار `LIAB-<ORG>-WALLET` | منتشر، با مبلغ واقعی و `monetised: true`                |

پاداش امتیازی، یک «عدد نمایشی» نیست که `docs/10` از آن پرهیز می‌دهد: در جدول `reward`
ثبت می‌شود، در سطح کاربر انباشته می‌شود، سقف دوره‌ای دارد، و در Audit دیده می‌شود. آنچه
ندارد، **ادعای ارزش ریالی** است — و نداشتن آن ادعا، دقیقاً همان صداقتی است که Q-09 تا
پاسخ‌گرفتن می‌خواهد.

### ۳. وقتی نرخ تعیین شد، هیچ کدی تغییر نمی‌کند

پاسخ Q-09 یک `UPDATE reward_rule SET credit_per_point_minor = ...` است. قواعد نسخه‌دار
در زمان‌اند (`validFrom`/`validTo`)، پس پاداش‌های گذشته با شرایط زمان خودشان می‌مانند و
بازمحاسبه‌شدنی‌اند.

> **اصلاح (2026-09-24).** «یک `UPDATE`» با خودِ جملهٔ بعدی ناسازگار بود: پاداش
> هنگام پردازش رویداد محاسبه می‌شود، پس ویرایش درجای `creditPerPointMinor` به
> رخدادهایی که هنوز اعطا نشده بودند برمی‌گشت و «شرایط زمان خودشان» را عوض می‌کرد.
> شرایط یک قاعدهٔ موجود (`points`، `creditPerPointMinor`، `periodCap`) دیگر
> ویرایش‌پذیر نیستند؛ پاسخ Q-09 این است: قاعدهٔ فقط‌امتیازی با `validTo` بسته و
> قاعدهٔ تازه با `creditPerPointMinor` از همان لحظه ساخته می‌شود. ادعای اصلی این
> بخش — **هیچ کدی تغییر نمی‌کند** — همچنان برقرار است؛ هر دو گام از API اند و هر
> دو رکورد Audit (`REWARD_RULE_CHANGED`) می‌گذارند.

### ۴. پاداش پولی‌شده هرگز از هوا نمی‌آید

Journal پاداش بدهکار `EXP-PLATFORM-REWARD` می‌زند — یک حساب هزینه. یعنی هر ریال اعتبار
اعطاشده، در تراز آزمایشی به‌عنوان **هزینه پلتفرم** دیده می‌شود، دقیقاً همان‌طور که
`docs/10` § ۱۰٫۴ مثال سوم نوشته. پاداش، درآمد کارمزد را مصرف می‌کند و این در دفتر کل
قابل دیدن است.

### ۵. سقف دوره‌ای، حتی زیر رویدادهای موازی

`periodCap` با یک شمارش زیر قفلِ همان تراکنشِ اعطا اجرا می‌شود، نه با یک بررسی
پیش از آن. دو `USAGE_RECORDED` هم‌زمان نمی‌توانند هر دو آخرین جای سقف را بردارند.

### ۶. `CASHBACK` پشت Feature Flag خاموش می‌ماند

`ECONOMIC_REWARD_CASHBACK_ENABLED` پیش‌فرض `false`. با آن خاموش، ساختن یا فعال کردن یک
`RewardRule` از نوع `CASHBACK` با `BUSINESS_RULE_VIOLATION` رد می‌شود — نه بی‌صدا نادیده
گرفته می‌شود.

## Alternatives Considered

| گزینه                                                    | مزیت                    | عیب                                                                                       | چرا رد شد                                                       |
| -------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| یک نرخ تبدیل پیش‌فرض سراسری (مثلاً ۱ امتیاز = ۱۰۰۰ ریال) | همه‌چیز Journal می‌زند  | **اختراع یک نرخ تجاری** — نقض ADR-023 و Q-09                                              | همان کاری که سند محصول صریحاً منع کرده                          |
| Journal با مبلغ صفر برای پاداش امتیازی                   | «هر پاداش Journal دارد» | `CHECK (amount_minor > 0)` را می‌شکند؛ و یک Journal صفر، حسابرسی را شلوغ می‌کند بدون معنا | یک ورودی دفتر کل باید چیزی را بگوید                             |
| توقف موتور پاداش تا پاسخ Q-09                            | ساده‌ترین               | سطوح، ضدتقلب و رفتارهای امتیازآور هم متوقف می‌شوند                                        | Q-09 درباره نرخ است، نه درباره وجود پاداش                       |
| امتیاز فقط، بدون هیچ مسیر پولی                           | ساده                    | `docs/10` § ۱۰٫۸ صریحاً پاداش را «هزینه واقعی ثبت‌شده» می‌خواهد                           | مسیر پولی باید از امروز درست و تست‌شده باشد، حتی اگر خاموش باشد |
| نرخ تبدیل به‌عنوان یک Env سراسری                         | ساده‌تر از ستون         | بدون Audit، بدون نسخه‌گذاری در زمان، تغییرش نیازمند استقرار — ADR-023 صریحاً ردش کرده     | تغییر قواعد حکمرانی باید ردیابی شود                             |

## Consequences

**مثبت**

- Q-09 بدون حدس باز می‌ماند، و موتور پاداش کار می‌کند.
- مسیر پولی از روز اول پیاده و تست شده است؛ فعال‌شدنش یک `UPDATE` است.
- تراز آزمایشی، هزینه پاداش را مثل هر هزینه دیگری نشان می‌دهد.
- `monetised` روی رویداد، مصرف‌کننده را از حدس زدن معاف می‌کند.

**منفی**

- **دو مسیر به‌جای یک مسیر** در `RewardService` — و هر دو باید تست شوند.
- `docs/10` § ۱۰٫۸ می‌گوید «هر `REWARD_GRANTED` یک Journal می‌زند»؛ امروز فقط پاداش
  پولی‌شده Journal می‌زند. انحراف در همان سند علامت خورده.
- تا پیکربندی نشدن نرخ، کاربر امتیاز می‌بیند و اعتبار نمی‌بیند. برای کاربر ممکن است
  گیج‌کننده باشد؛ برای حسابرس، صادقانه است.
- `reward_level` امروز مزایایی ندارد (Q-13 باز است) — سطح محاسبه می‌شود و
  `REWARD_LEVEL_CHANGED` منتشر می‌شود، اما هیچ مزیتی به آن گره نخورده.

## Compliance

- `reward/rule-engine.spec.ts` هر دو مسیر را می‌آزماید، شامل حالت نرخ نال.
- `reward-cap.int-spec.ts` سقف دوره‌ای را زیر **بیست محرک هم‌زمان** می‌آزماید، و ثابت
  می‌کند پاداش پولی‌شده Journal متوازن می‌زند و پاداش امتیازی **هیچ** Journal نمی‌زند.
- Seed هیچ `creditPerPointMinor` ای نمی‌گذارد؛ داده نمونه برچسب صریح «نمونه — نیازمند
  تصویب» دارد.
- `grep -rn "creditPerPointMinor" services/economic-service/prisma/seed.ts` باید خالی
  باشد.

## Correctness amendment (D-080, task 1201)

Rule applicability uses the owner's confirmed fact time and immutable status
transitions written with rule creation/PATCH, independently of outbox retention.
A delayed fact from an ACTIVE interval remains eligible after deactivation or
closing; saved evaluations resume their recorded rule IDs. Initially INACTIVE
rules, activation and reactivation each retain their own intervals. Usage still
uses fleet's server arrival `recordedAt`, as ADR-073 § 3 (11) requires pending
Q-153; this amendment does not use the reported usage period.

The migration records the best available historical evidence: ACTIVE from the
earlier of `validFrom` and `createdAt`, and, for a currently INACTIVE rule,
INACTIVE from its last `updatedAt`. Purged transitions and the original status
cannot be reconstructed. New initially INACTIVE rules record INACTIVE directly.
A future `validFrom` still gates applicability; it does not schedule a later
status activation that could undo an intervening deactivation.

Reward periods use UTC (AGENTS.md § 3). Weekly keys use the ISO Thursday's year.
Weekly caps count occurrence times under the subject balance lock. Old keys stay
unchanged. Existing owner-confirmed evaluation timestamps supply legacy
occurrence evidence; `grantedAt` is never a substitute. An unknown occurrence
counts conservatively in every week its legacy key could denote, including the
two different weeks formerly conflated as `2018-W01`. Already exceeded caps admit
no new grant. Each grant remains financially atomic; evaluation records and the
separate processed marker retain the existing partial-success/replay design.

Only the reward's `(rule_id, source_reference)` uniqueness conflict can mean
"duplicate", and only after checking tenant, subject, trigger and source identity.
A wallet uniqueness race escapes as a retryable failure, preserving redelivery.

Numeric fact types exposed by `RewardTriggerConsumer.confirmedFact`:

| Field                                                                                               | Type                              | Comparison                            |
| --------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------------------- |
| `totalCostMinor`                                                                                    | Integer minor-unit string         | Bigint                                |
| `downtimeMinutes`                                                                                   | Nullable safe integer             | Bigint                                |
| `hours`, `kilometres`, `hourMeter`, `odometer`                                                      | Nullable exact decimal strings    | Bigint coefficient with decimal scale |
| `usageRecordId`, `requestId`, `assetId`, `organizationId`, `driverId`, `assignmentId`, `scheduleId` | Identifier strings, some nullable | Literal equality/presence             |
| `periodStart`, `periodEnd`, `completedAt`                                                           | Timestamp strings                 | Literal equality/presence             |
| `source`, `type`, `currency`                                                                        | Closed textual values             | Literal equality/presence             |

| Operator                 | Operand type                                                       | Behaviour                                                     |
| ------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------- |
| `gt`, `gte`, `lt`, `lte` | Plain decimal strings (safe integer JSON numbers in legacy rules)  | Exact numeric ordering; integer facts require integer grammar |
| `eq`, `neq`              | Numeric fact, or legacy safe integer JSON number operand           | Exact numeric equality; `7.50` equals `7.5`                   |
| `eq`, `neq`              | Textual fact and string/boolean operand                            | Existing string equality                                      |
| Numeric comparisons      | Malformed, unsafe, fractional JSON number, null or missing operand | False, including `neq`                                        |
| `eq`, `neq`              | Null or missing actual/expected                                    | False                                                         |
| `present`, `absent`      | Any field                                                          | Existing non-null / null-or-missing check                     |
| `all`, `any`             | Nested predicates                                                  | Existing every/some semantics                                 |

Exact decimal strings permit a sign, whole and/or fractional digits, no exponent,
hex or whitespace, with at most 256 characters. New numeric operands must use strings. All JSON number operands are refused at
creation: even a fractional token can round to a safe integer during JSON parsing
(`9007199254740991.1`), so its original precision cannot be proven by the DTO.
Legacy safe integer operands still compare exactly. This is the conservative
fail-closed choice for F5, without adding a raw JSON parsing subsystem. Numeric equality on typed facts is canonicalized before
idempotency hashing; textual equality keeps its literal spelling.

Regression evidence: `correctness.spec.ts`, `reward-correctness.int-spec.ts`,
`reward-status-migration.int-spec.ts`, and the numeric/textual retry cases in
`reward-rule-canonical.int-spec.ts`. Rule responses retain their explicit API
mapping and exclude the internal history relation. Versionless PATCH and
unpaginated rule listing remain follow-ups from #480.

Rollout requires draining old reward consumers and rule writers before migration
and switching to the new code: old binaries do not enforce occurrence-based caps
or append status history. Schema rollback refuses while any status history exists, preserving applicability
evidence, like the other append-only configuration histories. Against an empty
history it removes the additions and migration record; existing grants, journals
and stored keys remain. A code rollback can leave this additive schema intact;
it must keep old reward consumers/rule writers drained.
