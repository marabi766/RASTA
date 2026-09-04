# ADR-051: ترتیب معنایی هر جریان در Outbox

- **وضعیت:** Accepted
- **تاریخ:** 2026-09-04 (پیشنهاد) · **پذیرش معماری: 2026-09-04**
- **اهمیت:** ترتیب معنایی رویدادهای یک جریان تضمین نشده — D-027
- **مربوط به:** D-027 (**باز می‌ماند**)
- **پیش‌نیاز:** [ADR-021](ADR-021-outbox-pattern.md) ·
  [ADR-036](ADR-036-economic-event-partition-keys.md) ·
  [ADR-050](ADR-050-outbox-durable-claim.md)
- **آنچه پذیرفته شد:** بررسی Phase A و **تصمیم معماری** این سند.
- **آنچه پذیرفته نشد:** **Phase B شروع نشده است** و نیازمند دستور اجرای
  جداگانهٔ صاحب محصول است. **هیچ کدی پیاده نشده.**

> **پذیرش، اثبات نیست.** آنچه در 2026-09-04 پذیرفته شد، _طراحی_ است — بر پایهٔ
> شواهد Phase A که پایین آمده. این سند ادعا **نمی‌کند** پروتکل در Production کار
> می‌کند؛ چنین ادعایی فقط پس از اجرای Phase B و گذشتن از همهٔ دروازه‌های پذیرش
> آن (آزمون، کارایی، برگشت‌پذیری Migration، Runbook، CI) و یک **ثبت پذیرش
> جداگانهٔ صاحب محصول** معنا دارد.

---

## خلاصهٔ اجرایی

D-027 تا امروز این‌طور ثبت شده بود: «دو رویداد یک Aggregate در یک میلی‌ثانیه
می‌توانند وارونه به Partition برسند.» بازتولیدهای این سند نشان می‌دهند آن جمله
**درست ولی کوچک‌ترین بخش مسئله** است. برخورد میلی‌ثانیه‌ای یکی از **شش** مسیر
مستقل وارونگی است، و چهار مسیر دیگر با هیچ شکلی از «شمارهٔ افزایشی» — نه ULID
یکنواخت، نه `BIGSERIAL`، نه `aggregateVersion` — بسته نمی‌شوند.

مهم‌ترین یافته این است:

> **`created_at` ترتیب Commit را نشان نمی‌دهد.** در `buildOutboxRow` مقدارش
> **پیش از** Commit در JavaScript گرفته می‌شود، پس دو تراکنش هم‌زمان روی یک
> جریان می‌توانند به ترتیب معکوسِ `created_at` قابل‌مشاهده شوند. اندازه‌گیری شد:
> Relay رویداد دیرتر را اول Claim و منتشر کرد (§ R4).

و مهم‌ترین یافتهٔ مهندسی این است:

> شکل بدیهیِ «مسدودسازی سرصف» — یعنی `JOIN` به جدول توالی و شرط
> `stream_seq = published_seq + 1` — **از سقف کارایی خودِ ADR-050 رد می‌شود**:
> در حالت متخاصم ۱۹۸٬۰۰۰ ردیف پیمود، ۵۹۹٬۴۸۷ Buffer خواند، **۱۰۹۱ میلی‌ثانیه**
> طول کشید و **صفر ردیف** برگرداند (§ R9). همان الگوی شکستی که D-026 دور دوم را
> ساخت، در جای تازه.
>
> با **پرچم سرصف ماده‌شده** (`is_stream_head`) همان پرسش روی Index جزئی پاسخ
> داده می‌شود: **۱ Buffer، ۰٫۰۱۲ میلی‌ثانیه**، Index Only Scan با
> `Heap Fetches: 0` (§ R10). تفاوت ~۹۰٬۰۰۰ برابر.

**تصمیم پذیرفته‌شده:** توالی هر جریان که **درون تراکنش دامنه و زیر قفل ردیفِ همان
جریان** تخصیص می‌یابد، به‌علاوهٔ **پرچم سرصف ماده‌شده** برای جریان‌هایی که
ترتیب اکید لازم دارند، به‌علاوهٔ **تشخیص شکاف سمت مصرف‌کننده** برای بقیه. دو
کلاس جریان، با سیاست Compile-Time؛ بدون Override اختیاری در محل فراخوانی.

**آنچه این ADR ادعا نمی‌کند:** تحویل همچنان **At-Least-Once** است، نه
Exactly-Once. A-09 (ایدمپوتنسی مصرف‌کننده) الزامی می‌ماند و این طرح آن را
جایگزین نمی‌کند.

---

## Context — وضعیت امروز، با شواهد فایل/خط

هرچه در این بخش می‌آید از کد `main` در `45d51cf` خوانده شده، نه از اسناد.

### C-1 — `buildOutboxRow` از `ulid()` معمولی استفاده می‌کند

`packages/nest-common/src/outbox/outbox.ts:1` — `import { ulid } from 'ulid'`
و خط `71` — `const eventId = ulid()`. `monotonicFactory` هیچ‌جای مخزن استفاده
نشده است.

خط `72`: `const occurredAt = input.occurredAt ?? new Date()` و خط `112`:
`createdAt: occurredAt`. **پس `created_at` ساعتِ JavaScript در لحظهٔ ساخت ردیف
است، نه لحظهٔ Commit و نه ساعت پایگاه داده.** این تمام تفاوت § R4 است.

خط `107`: `partitionKey: input.partitionKey ?? input.aggregateId`.

### C-2 — دقت میلی‌ثانیه، بدون هیچ ستون توالی

هر هشت Migration اولیه `"created_at" TIMESTAMP(3)` می‌سازند — دقت میلی‌ثانیه.
جست‌وجوی `sequence|bigserial|stream_seq|aggregate_version` در هر هشت
`schema.prisma` **هیچ ستون توالی یا نسخهٔ ماندگاری روی `OutboxMessage`**
برنمی‌گرداند. تنها ستون‌های ترتیب‌ساز `created_at` و `id` هستند.

### C-3 — شرط واجد شرایط بودن، Lease و Backoff را کنار می‌گذارد

`packages/nest-common/src/outbox/outbox-sql.ts:205-298`. چهار جریان
`fresh | lease | retry | paired`، و در پایان (خط `254-255`):

```sql
AND (o.claim_expires_at IS NULL OR o.claim_expires_at <= now())
AND (o.next_attempt_at  IS NULL OR o.next_attempt_at  <= now())
```

یعنی ردیفی که Lease زنده دارد یا در Backoff آینده است **واجد شرایط نیست** —
ولی ردیف بعدیِ **همان جریان** هست. این دقیقاً § R2 و § R5 است.

مرتب‌سازی `created_at, id` است (خط `247`, `256`, و مرتب‌سازی مجدد در JS در خط
`295`). خودِ سند این ماژول در خط `199-203` می‌گوید این «ترتیب انتخاب قطعی»
می‌خرد و **نه** ترتیب معنایی، و D-027 را باز اعلام می‌کند. آن جمله درست است.

### C-4 — تنظیمات Producer، به‌ازای نمونه است نه قفل بین‌Replica

`services/*/src/outbox/kafka.publisher.ts:57-61` — `idempotent: true`,
`maxInFlightRequests: 1`, `allowAutoTopicCreation: false`. این تنظیم روی
**یک نمونهٔ Producer** اثر دارد. دو Pod، دو Producer، دو `producerId` مستقل.
هیچ‌چیز میان آن‌ها ترتیب برقرار نمی‌کند. § R3 اندازه‌اش می‌گیرد.

### C-5 — چند Relay می‌توانند ردیف‌های مجزا با یک کلید را هم‌زمان منتشر کنند

`claimPendingSql` با `FOR UPDATE SKIP LOCKED` عمداً به دو Claimant ردیف‌های
**مجزا** می‌دهد. اگر آن دو ردیف یک `topic + partition_key` داشته باشند، دو
فرآیند مستقل هم‌زمان روی یک Partition می‌نویسند. ترتیب نتیجه، ترتیب رسیدن
درخواست‌ها به Broker است — نه ترتیب دامنه. § R3.

### C-6 — `aggregateVersion` فقط در سه محل تولید می‌شود

شمارش شد، فرض نشد. تنها سه محل تولیدی:

| فایل                                                                     | خط    |
| ------------------------------------------------------------------------ | ----- |
| `services/asset-service/src/asset/asset.service.ts`                      | `344` |
| `services/identity-service/src/identity/identity.service.ts`             | `232` |
| `services/organization-service/src/organization/organization.service.ts` | `291` |

هر سه `row.version` / `user.version` را می‌دهند. در Schema این ستون‌ها
`version Int @default(1)` هستند و با `version: { increment: 1 }` بالا می‌روند —
**افزایش کور، نه Compare-and-Set**. زیر `READ COMMITTED` این افزایش قفل ردیف
می‌گیرد، پس مقدارها برای همان ردیف Aggregate با ترتیب Commit می‌خوانند. این
خاصیت واقعی است و در § Alternatives به کار می‌آید.

در Envelope (`packages/contracts/src/events/envelope.ts:43`) این فیلد
`optional` است. پنج سرویس دیگر آن را هرگز نمی‌فرستند.

### C-7 — «هر Aggregate» و «هر جریان مرتب» یکی نیستند

ADR-036 این تفکیک را عمدی ساخت و کد اجرایش می‌کند:

| سرویس         | سیاست                                                                   | نمونهٔ واگرایی                                                        |
| ------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `economic`    | `src/events/routing.ts` — `AGGREGATE_OF` جدا از `PARTITION_KEY_POLICY`  | `FUNDS_HELD` دربارهٔ `WalletHold` است، با `transactionId` مرتب می‌شود |
| `marketplace` | `src/events/routing.ts`                                                 | `REVIEW_SUBMITTED` دربارهٔ `Review` است، با `orderId` مرتب می‌شود     |
| `document`    | `src/events/routing.ts` — هر دو در این دامنه یکی‌اند، و دلیلش نوشته شده | همه با `documentId`                                                   |
| `fleet`       | `partitionKey: <assetId>` در محل فراخوانی                               | `ASSIGNMENT_ENDED` دربارهٔ `Assignment` است، با `assetId` مرتب می‌شود |
| `maintenance` | `partitionKey: <assetId>` در محل فراخوانی                               | `MAINTENANCE_CREATED` دربارهٔ `MaintenanceRequest`، با `assetId`      |
| سه سرویس دیگر | بدون `partitionKey` صریح ⇒ پیش‌فرض `aggregateId`                        | —                                                                     |

**پیامد طراحی:** واحد ترتیب **`topic + partitionKey`** است، نه Aggregate. هر
مکانیزمی که به Aggregate گره بخورد — از جمله `aggregateVersion` — برای
`fleet`/`maintenance`/`economic` **واحد اشتباهی** را می‌شمارد.

### C-8 — سیاهه کامل رویدادهای منتشرشده

| سرویس        | Topic                   | رویدادها (تعداد)                                                                                                                                                                                                        | مبدأ کلید پارتیشن                                 | محل سیاست               | `aggregateVersion`  | Aggregate ≠ کلید؟                                                   |
| ------------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------- | ------------------- | ------------------------------------------------------------------- |
| identity     | `rasta.identity.v1`     | `USER_ACTIVATED`, `USER_UPDATED`, `MEMBERSHIP_CREATED` ×۲, `MEMBERSHIP_REVOKED`, `ROLE_ASSIGNED`, `ROLE_REVOKED`, `REGISTRATION_SUBMITTED`, `REGISTRATION_REJECTED` (۹)                                                 | پیش‌فرض `aggregateId`                             | —                       | فقط `USER_UPDATED`  | خیر                                                                 |
| organization | `rasta.organization.v1` | `ORGANIZATION_CREATED`, `_UPDATED`, `_MOVED`, `_STATUS_CHANGED`, `_POLICY_CHANGED`, `_LOCATION_CHANGED` (۶)                                                                                                             | پیش‌فرض `aggregateId`                             | —                       | فقط `_UPDATED`      | خیر                                                                 |
| asset        | `rasta.asset.v1`        | `ASSET_CREATED`, `_UPDATED`, `_ACTIVATED`, `_DECOMMISSIONED`, `_TRANSFERRED`, `_LOCATION_RECORDED`, `_DOCUMENT_ATTACHED`, `_STATUS_CHANGED` (۸)                                                                         | پیش‌فرض `aggregateId` = `assetId`                 | —                       | فقط `ASSET_UPDATED` | خیر                                                                 |
| asset        | `rasta.insurance.v1`    | `INSURANCE_RECORDED`, `INSURANCE_EXPIRING`, `INSURANCE_EXPIRED`, `INSPECTION_RECORDED`, `INSPECTION_FAILED`, `INSPECTION_EXPIRING` (۶)                                                                                  | پیش‌فرض `aggregateId` = `policyId`/`inspectionId` | —                       | خیر                 | **بله** — دربارهٔ دارایی‌اند ولی با شناسهٔ بیمه/معاینه مرتب می‌شوند |
| fleet        | `rasta.fleet.v1`        | `ASSET_ASSIGNED`, `ASSIGNMENT_ENDED` ×۲, `AVAILABILITY_CHANGED` ×۲, `DRIVER_REGISTERED`, `DRIVER_STATUS_CHANGED`, `USAGE_RECORDED` (۸)                                                                                  | صریح `assetId` (به‌جز رویدادهای راننده)           | محل فراخوانی            | خیر                 | **بله**                                                             |
| maintenance  | `rasta.maintenance.v1`  | `MAINTENANCE_DUE`, `_CREATED`, `_APPROVED`, `_CANCELLED`, `_STARTED`, `_COMPLETED`, `WORKSHOP_ASSIGNED`, `REPAIR_COMPLETED`, `BREAKDOWN_REPORTED` (۹)                                                                   | صریح `assetId`                                    | محل فراخوانی            | خیر                 | **بله**                                                             |
| economic     | `rasta.economic.v1`     | `WALLET_OPENED` ×۲, `FUNDS_HELD`, `FUNDS_RELEASED` ×۲, `PAYMENT_AUTHORIZED`, `_COMPLETED`, `_FAILED`, `COMMISSION_APPLIED`, `REWARD_GRANTED`, `REWARD_LEVEL_CHANGED`, `SETTLEMENT_COMPLETED`, `JOURNAL_POSTED` (۱۱ نام) | `PARTITION_KEY_POLICY` روی Payload معتبرشده       | `src/events/routing.ts` | خیر                 | **بله** — پنج رویداد با `transactionId`                             |
| marketplace  | `rasta.marketplace.v1`  | `OFFER_PUBLISHED` ×۲, `ORDER_CREATED`, `_CONFIRMED`, `_FULFILLED`, `_RECEIPT_CONFIRMED`, `_DISPUTED`, `_COMPLETED`, `_CANCELLED`, `REVIEW_SUBMITTED` (۹ نام)                                                            | `PARTITION_KEY_POLICY` روی Payload                | `src/events/routing.ts` | خیر                 | **بله** — `REVIEW_SUBMITTED`                                        |
| document     | `rasta.document.v1`     | `DOCUMENT_UPLOADED`, `DOCUMENT_SCANNED`, `DOCUMENT_DELETED`, `VIRUS_DETECTED` (۴)                                                                                                                                       | `resolvePartitionKey` ⇒ `documentId`              | `src/events/routing.ts` | خیر                 | خیر                                                                 |

**مصرف‌کنندگان امروز موجود** (شش عدد، همه با `EventConsumer`):

| مصرف‌کننده                                        | Group                                   | وابسته به ترتیب؟                       |
| ------------------------------------------------- | --------------------------------------- | -------------------------------------- |
| `asset-service/consumers/timeline`                | `asset-service.timeline`                | **بله** — پروندهٔ زمانی دستگاه         |
| `fleet-service/consumers/asset-sync`              | —                                       | بله (وضعیت دستگاه)                     |
| `maintenance-service/consumers/asset-sync`        | —                                       | بله (وضعیت دستگاه)                     |
| `maintenance-service/consumers/usage`             | —                                       | بله (کنتور کارکرد؛ D-012 هم همین‌جاست) |
| `economic-service/consumers/settlement-authority` | `economic-service.settlement-authority` | **بله — مالی**                         |
| `economic-service/consumers/reward-trigger`       | `economic-service.reward-trigger`       | بله                                    |

### C-9 — ادعاهای تاریخیِ کهنه، تفکیک‌شده از وضعیت امروز

`services/economic-service/src/outbox/kafka.publisher.ts:30-34` می‌گوید
«`marketplace-service` هنوز وجود ندارد» و Q-26 را باز معرفی می‌کند.
**امروز هر دو نادرست‌اند:** `marketplace-service` پیاده و مستقر است، و Q-26
در `docs/24-open-questions.md:501` **بسته** ثبت شده (با ADR-036).

این ADR آن جمله را **تاریخ** می‌داند و حذفش نمی‌کند؛ صرفاً ثبت می‌کند که
وضعیت امروز نیست. تصحیح آن Comment، تغییر کد است و به Phase B تعلق دارد.

---

## تفکیک مفاهیم — نُه خاصیت، نه یک «ترتیب»

بدون این تفکیک، بحث D-027 دور خودش می‌چرخد. وضعیت امروز، ستون سوم است.

| #   | خاصیت                                               | تعریف دقیق                                | امروز                                                 |
| --- | --------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------- |
| ۱   | **ترتیب انتخاب پایگاه داده**                        | Claim قطعی و تکرارپذیر رتبه‌بندی می‌کند   | ✅ برقرار — `ORDER BY created_at, id` (G6 در ADR-050) |
| ۲   | **ترتیب درج (Enqueue)**                             | ترتیبی که `INSERT` ها اجرا شدند           | ✅ درون یک تراکنش برقرار                              |
| ۳   | **ترتیب Commit**                                    | ترتیبی که ردیف‌ها **قابل‌مشاهده** شدند    | ❌ با ۱ و ۲ می‌تواند فرق کند (§ R4)                   |
| ۴   | **ترتیب معنایی/نسخه‌ای دامنه**                      | ترتیبی که کسب‌وکار می‌گوید رخ داد         | ❌ هیچ‌جا ماندگار نشده (C-2)                          |
| ۵   | **ترتیب رسیدن به Kafka، یک Producer، یک Partition** | ترتیب Append در Log                       | ✅ با `maxInFlightRequests: 1` (C-4)                  |
| ۶   | **ترتیب رسیدن به Kafka، چند Producer/Relay**        | همان، وقتی دو فرآیند یک کلید را می‌نویسند | ❌ **۸ از ۲۰** وارونه (§ R3)                          |
| ۷   | **ترتیب اعمال در مصرف‌کننده**                       | ترتیبی که اثر تجاری اعمال می‌شود          | ❌ تابع ۶ است                                         |
| ۸   | **تشخیص شکاف/تکرار/وارونگی**                        | آیا مصرف‌کننده اصلاً می‌فهمد؟             | ❌ فقط تکرار (`processed_event`)، نه شکاف             |
| ۹   | **رفتار زیر Lease/Backoff/Poison/DLQ/Replay**       | ترتیب وقتی ردیف قبلی معلق است             | ❌ ردیف بعدی سبقت می‌گیرد (§ R2, R5, R6)              |

**آنچه محصول واقعاً لازم دارد** — از اسناد موجود، نه اختراع:

- `docs/07 § ۷٫۷` و `ADR-036`: چرخهٔ مالی یک **تراکنش** و چرخه‌عمر یک **سفارش**
  باید مرتب بمانند. این یعنی خاصیت‌های ۳، ۴، ۶، ۷ روی آن دو جریان.
- `docs/events/README:446` و `ADR-049`: تاریخچهٔ یک **سند** باید مرتب بماند
  (`UPLOADED` پیش از `SCANNED`/`DELETED`).
- `docs/07 § ۷٫۷` صریح می‌گوید **ترتیب سراسری لازم نیست**.
- `docs/07:222`: موجودی کیف پول از دفتر کل بازمحاسبه می‌شود، **نه** از ترتیب
  مصرف. پس Wallet به ترتیب اکید نیاز ندارد.

**آنچه اسناد نمی‌گفتند** (تاریخچه): برای جریان‌های `fleet`/`maintenance` (کلید
`assetId`) هیچ سندی نمی‌گفت ترتیب **اکید** لازم است یا تشخیص شکاف کافی. این با
فرض پر نشد و به‌عنوان **Q-36** ثبت شد.

**پاسخ صاحب محصول (2026-09-04) — Q-36 بسته شد.** هر دو جریان **STRICT** هستند:
`rasta.fleet.v1 + assetId` و `rasta.maintenance.v1 + assetId`. دلیل ثبت‌شده:
رویداد بی‌ترتیب روی یک دستگاه می‌تواند Projection عملیاتی ناامن بسازد — در
دسترس بودن، تخصیص، خروج/بازگشت تعمیر، نگهداری کارکردمحور، و چرخه‌عمر سفارش
تعمیر. **مرز، همان `topic + partitionKey` می‌ماند**؛ این تصمیم هیچ ترتیبی میان
آن دو Topic نمی‌سازد (§ تضمین‌های داده‌نشده).

---

## بازتولیدها — روش و نتیجهٔ اندازه‌گیری‌شده

همه روی PostgreSQL و Kafka واقعیِ `pnpm infra:up` اجرا شدند. Schema ایزوله
`d027_exp` در پایگاه `rasta_document`، با `search_path = d027_exp` **بدون
`public`** تا هیچ نام غیرمقیدی نتواند به جدول واقعی برسد. Topic و Consumer
Group یکتا با Timestamp. همه پس از اجرا پاک شدند.

### R1 — وارونگی درون یک میلی‌ثانیه

**روش.** ۱۰۰۰ آزمون؛ در هر آزمون ۱۲ ULID با **یک** Timestamp ثابت — همان
چیزی که `buildOutboxRow` وقتی چند رویداد در یک تراکنش و یک میلی‌ثانیه ساخته
می‌شوند تولید می‌کند. شمارش جفت‌های وارون میان ترتیب ساخت و ترتیب واژه‌نگاشتی.

| مکانیزم              | آزمون با ≥۱ وارونگی | جفت وارون        | نرخ        |
| -------------------- | ------------------- | ---------------- | ---------- |
| `ulid()` (امروز)     | **۱۰۰۰ از ۱۰۰۰**    | ۳۲٬۵۵۱ از ۶۶٬۰۰۰ | **۴۹٫۳۲٪** |
| `monotonicFactory()` | **۰ از ۱۰۰۰**       | ۰                | ۰٪         |

۴۹٫۳۲٪ یعنی درون یک میلی‌ثانیه ترتیب عملاً **پرتاب سکه** است.

### R2 — سبقت Retry

**روش.** یک جریان (`t.order.v1` + `ORDER-1`). `E1 = ORDER_CREATED` قدیمی‌تر با
`attempts = 1` و `next_attempt_at = now() + 60s`؛ `E2 = ORDER_CONFIRMED` ده
میلی‌ثانیه جدیدتر و تازه. اجرای `claimPendingSql` عیناً از کد، با `limit = 100`.

**نتیجه.** Claim فقط **`E2-ORDER_CONFIRMED`** را برگرداند. `E1` بی‌Claim و در
Backoff ماند.

> مصرف‌کننده `ORDER_CONFIRMED` را برای سفارشی می‌بیند که هنوز `ORDER_CREATED`
> اش نرسیده. کلید Partition این را حل نمی‌کند: **هر دو روی یک Partition‌اند**؛
> ترتیب Append همان ترتیب انتشار است، و ترتیب انتشار وارونه بود.

### R3 — رقابت دو Relay، با Kafka واقعی

**روش.** Topic یکتا `d027.race.1788507511787` با **یک** Partition؛ Group تازهٔ
`d027.race.group.1788507511787` با `fromBeginning: true`. ۲۰ آزمون. در هر آزمون
دو ردیف با یک `partition_key`، `E1` قدیمی‌تر. دو `PrismaClient` مستقل هم‌زمان
`claimPending(limit = 1)` می‌زنند؛ `SKIP LOCKED` ردیف‌های مجزا می‌دهد. Relay A
پیش از انتشار ۴۰۰ میلی‌ثانیه تأخیر می‌کند. هر دو Producer با تنظیمات تولیدی
(`idempotent: true`, `maxInFlightRequests: 1`).

**نتیجه.** ۴۰ پیام خوانده شد. **۸ وارونگی از ۲۰ آزمون (۴۰٪).**

الگو تصادفی نیست:

| Relay A (تأخیردار) رویداد قدیمی‌تر را داشت؟ | تعداد | وارونه شد    |
| ------------------------------------------- | ----- | ------------ |
| بله                                         | ۸     | **۸ (۱۰۰٪)** |
| خیر                                         | ۱۲    | ۰ (۰٪)       |

> **هر بار** که Relayِ دارندهٔ رویداد قدیمی‌تر کندتر بود، Broker رویداد جدیدتر
> را اول ثبت کرد. این «ممکن است» نیست؛ **قطعی است**، شرط به‌ازای اینکه کدام
> Relay کند شود. تضمین ترتیب Kafka نقض نشد — دقیقاً رعایت شد و همچنان وارونگی
> معنایی داد، چون ترتیب Append را دو فرآیند مستقل تعیین کردند.

### R4 — واگرایی ترتیب Commit — مهم‌ترین بازتولید

**روش.** `E_EARLY` با `created_at = T` و `E_LATE` با `created_at = T + 10ms`،
یک جریان. Session A تراکنش را باز می‌کند، `E_EARLY` را `INSERT` می‌کند و
**Commit نمی‌کند**. Session B `E_LATE` را درج و بلافاصله Commit می‌کند. Relay
Poll می‌زند؛ سپس A Commit می‌کند و Relay دوباره Poll می‌زند.

**نتیجه.**

| مقایسه                 | ترتیب                       |
| ---------------------- | --------------------------- |
| ترتیب `created_at`     | `E_EARLY` → `E_LATE`        |
| Poll اول Claim کرد     | `[E_LATE]`                  |
| Poll دوم Claim کرد     | `[E_EARLY]`                 |
| **ترتیب واقعی انتشار** | **`E_LATE` → `E_EARLY`** ❌ |

> `created_at` «درست» بود و کمکی نکرد. هر مکانیزمی که شماره را **پیش از
> Commit** تخصیص دهد — ULID یکنواخت، `nextval()` روی `BIGSERIAL`،
> `aggregateVersion` سمت تولیدکننده — دقیقاً همین‌جا می‌شکند، چون Relay
> نمی‌تواند «هنوز Commit نشده» را از «هرگز نخواهد آمد» تشخیص دهد.
>
> این تنها بازتولیدی است که یک **دسته کامل از گزینه‌ها** را حذف می‌کند.

**آیا قفل‌های موجود جلویش را می‌گیرند؟** به دامنه بستگی دارد، و همین دو کلاس را
می‌سازد:

| دامنه                             | قفلی که امروز گرفته می‌شود                                                      | آیا مرز جریان را می‌پوشاند؟                                                          |
| --------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `economic` — جریان تراکنش         | `transaction.repository.ts:85` — `SELECT ... FROM "transaction" ... FOR UPDATE` | ✅ **بله** — قفل دقیقاً روی همان `transactionId` که کلید Partition است               |
| `economic` — کیف پول              | `wallet.repository.ts:64` — `FOR UPDATE`                                        | ✅ بله                                                                               |
| `asset`/`identity`/`organization` | `version: { increment: 1 }` ⇒ قفل ردیف Aggregate                                | ✅ بله (کلید = `aggregateId`)                                                        |
| `maintenance`                     | `maintenance.repository.ts:291` — `FOR UPDATE` روی **`repair_order`**           | ❌ **خیر** — جریان `assetId` است؛ دو RepairOrder یک دستگاه روی هیچ سریالایز نمی‌شوند |
| `fleet`                           | قفل صریحی روی `asset` یافت نشد                                                  | ❌ **خیر**                                                                           |
| `marketplace`                     | `version Int` روی `Order`                                                       | ✅ برای رویدادهای سفارش                                                              |
| `document`                        | `version Int` روی `Document`؛ اسکن ناهم‌زمان است                                | ⚠️ `DOCUMENT_SCANNED` از Worker جدا می‌آید                                           |

### R5 — مسیر Crash و بازپس‌گیری

**روش.** `E1` قدیمی‌تر زیر Lease **زنده** ۶۰ ثانیه‌ای Relayی که Crash کرده
(نتیجهٔ انتشارش نامعلوم، هرگز Ack نمی‌کند). `E2` جدیدتر، همان جریان، تازه.

**نتیجه.** `claimPending` فقط **`[E2]`** را برگرداند. `E1` تا **۵۹ ثانیه**
پشت Lease ماند.

> پروتکل Shutdown در ADR-050 عمداً ردیف `IN_FLIGHT` را رها می‌کند تا Lease
> طبیعی منقضی شود — تصمیم درستی برای جلوگیری از تکرار. اما هزینه‌اش این است که
> ردیف بعدیِ همان جریان تا یک بازهٔ Lease کامل **جلو می‌افتد**. یعنی
> `leaseSeconds` امروز مستقیماً «حداکثر پنجرهٔ وارونگی» است.

### R6 — بازپخش دستی DLQ

بازتولید کد و قرارداد، نه اجرا:

- `DLQ_HEADERS` (`packages/contracts/src/events/envelope.ts:112-118`) فقط
  `reason`, `originalTopic`, `attempts`, `error`, `firstFailedAt` دارد —
  **بدون کلید Partition، بدون Offset، بدون شمارهٔ توالی.**
- `ProcessedEvent` در هر هشت Schema فقط `@@id([eventId, consumerName])` و
  `processedAt` است. یعنی صرفاً **حذف تکرار**؛ هیچ ستونی که «کهنه بودن» را
  بفهمد وجود ندارد.
- `docs/runbooks/replay-dlq.md` می‌گوید «بازپخش امن است چون مصرف‌کننده‌ها
  Idempotent‌اند». **این استدلال برای ترتیب معتبر نیست:** یک
  `ORDER_CREATED` بازپخش‌شده پس از `ORDER_COMPLETED` برای مصرف‌کننده **تکراری
  نیست** — رویدادی است که هرگز ندیده. `processed_event` جلویش را نمی‌گیرد.
- **یافتهٔ جانبی:** ابزاری که Runbook دستور اجرایش را می‌دهد
  (`dist/scripts/replay-dlq.js`) **در مخزن وجود ندارد**؛ جست‌وجوی
  `*replay*`/`*dlq*` بیرون از `node_modules` و `dist` فقط خود Runbook را
  برمی‌گرداند. اصلاح Runbook خارج از دامنهٔ این Task است و اینجا فقط گزارش
  می‌شود.

**نتیجه:** برای ~۹۰٪ خانواده‌های رویداد، بازپخش یک رویداد کهنه **قابل تشخیص
نیست**.

### R7/R8 — هزینهٔ اندازه‌گیری‌شدهٔ ستون توالی

Fixture ۲۰۰٬۰۰۰ ردیفی روی ۲۰٬۰۰۰ جریان (هم‌شکل با Fixture ADR-050).

| اندازه                                      | بایت       | تغییر                    |
| ------------------------------------------- | ---------- | ------------------------ |
| جدول، پایه (بدون توالی)                     | ۳۱٬۸۵۸٬۶۸۸ | —                        |
| جدول، با `stream_seq` (پس از `VACUUM FULL`) | ۳۳٬۷۰۱٬۸۸۸ | **+۱٬۸۴۳٬۲۰۰ (+۵٫۸٪)**   |
| Index ها، پایه                              | ۳۳٬۷۰۱٬۸۸۸ | —                        |
| Index ها، با دو Index توالی                 | ۵۳٬۶۴۱٬۲۱۶ | **+۱۹٬۹۳۹٬۳۲۸ (+۵۹٫۲٪)** |
| `ux_outbox_stream_seq`                      | ۹٬۹۶۱٬۴۷۲  | —                        |
| `ix_outbox_stream_head`                     | ۹٬۹۶۱٬۴۷۲  | —                        |
| `outbox_stream_sequence` (۲۰٬۰۰۰ جریان)     | ۲٬۵۰۶٬۷۵۲  | —                        |

**هشدار Migration اندازه‌گیری‌شده:** Backfill با یک `UPDATE` درجا، جدول را
موقتاً به **۶۵٬۵۵۲٬۳۸۴ بایت (~۲ برابر)** رساند. طرح اجرا باید Backfill دسته‌ای
با `VACUUM` میانی تجویز کند، نه یک `UPDATE` واحد.

### R9 — چرا شکل بدیهی مسدودسازی سرصف رد می‌شود

**Fixture متخاصم.** ۲٬۰۰۰ جریان × ۱۰۰ رویداد = ۲۰۰٬۰۰۰ ردیف؛ **سرصف هر جریان
در Backoff پنج‌دقیقه‌ای**. پس هیچ ردیفی در جریان `fresh` قابل Claim نیست.

پرسش سرصف به‌شکل `JOIN` با `stream_seq = published_seq + 1`:

```
Limit (actual rows=0)
  Nested Loop (actual rows=0)
    Index Scan using ix_outbox_due_fresh  (actual rows=198000)
    Memoize  Hits: 0  Misses: 198000  Evictions: 110619  Memory: 8193kB
      Index Scan using outbox_stream_sequence_pkey (loops=198000)
        Filter: ((published_seq + 1) = o.stream_seq)
        Rows Removed by Filter: 1
Buffers: shared hit=599487
Execution Time: 1091.254 ms
```

**۱۹۸٬۰۰۰ ردیف پیموده، ۵۹۹٬۴۸۷ Buffer، ۱۰۹۱ میلی‌ثانیه، صفر ردیف نتیجه.**
سقف ADR-050 برای «ردیف حذف‌شده با Filter» **`۱۰ × LIMIT`** است؛ این ~۱۹۸ برابر
ردش می‌کند. نوشتن `JOIN` از سمت جدول توالی هم چیزی عوض نکرد (۱۱۱۱ میلی‌ثانیه،
نقشهٔ یکسان) — Planner ترتیب نوشتاری را نادیده می‌گیرد.

**چرا:** `published_seq + 1` مقداری است که فقط در زمان اجرا و از جدول دیگری
معلوم می‌شود، پس روی `outbox_message` قابل Index شدن نیست. عیناً همان درسی که
ADR-050 دربارهٔ `now()` گرفت: **تخمین را باید از تصمیم بیرون برد، نه Index تازه
اضافه کرد.**

### R10 — شکل درست: پرچم سرصف ماده‌شده

`is_stream_head BOOLEAN NOT NULL DEFAULT false` نگهداری‌شده هنگام پیشروی جریان،
و چهار Index جزئی ADR-050 که با `AND is_stream_head` باریک شده‌اند. **همان
Fixture متخاصم:**

```
Limit (actual rows=0)
  Index Only Scan using ix_outbox_head_fresh  (actual rows=0)
    Heap Fetches: 0
Buffers: shared hit=1
Execution Time: 0.012 ms
```

| معیار (Fixture متخاصم یکسان) | `JOIN` (R9) | پرچم ماده‌شده (R10) | نسبت         |
| ---------------------------- | ----------- | ------------------- | ------------ |
| زمان اجرا                    | ۱۰۹۱٫۲۵۴ ms | **۰٫۰۱۲ ms**        | **~۹۰٬۰۰۰×** |
| Buffer                       | ۵۹۹٬۴۸۷     | **۱**               | ~۶۰۰٬۰۰۰×    |
| ردیف پیموده                  | ۱۹۸٬۰۰۰     | **۰**               | —            |

هزینهٔ Index چهار Index سرصف روی همین Fixture: ۸۱۹۲ + ۸۱۹۲ + ۸۱۹۲ + ۱۵۵٬۶۴۸ =
**۱۸۰٬۲۲۴ بایت (۱۷۶ KB)**. دلیلش ساختاری است و مهم:

> **Index های سرصف با تعداد _جریان_ بزرگ می‌شوند، نه با تعداد _ردیف_.**
> ۲٬۰۰۰ جریان ⇒ حداکثر ۲٬۰۰۰ ورودی، هرچند صف ۲۰۰٬۰۰۰ ردیف باشد.

**صداقت در گزارش:** در این Fixture مسیر `retry` سرصف، Index خودش
(`ix_outbox_head_retry`) را انتخاب **نکرد** و از `ix_outbox_next_attempt` با
Filter استفاده کرد (۲ Buffer، ۰٫۰۲۶ ms) — چون بازهٔ «سررسیدشده» خالی بود و
Planner زودتر خارج شد. آن مسیر با Fixtureی که سرصف‌های **سررسیدشده** دارد باید
جداگانه سنجیده شود؛ در ماتریس آزمون Phase B ثبت شده است.

---

## ماتریس تضمین — قبل و بعد

| #   | خاصیت                                     | امروز          | با تصمیم پذیرفته‌شده (پس از اجرای Phase B)                                                |
| --- | ----------------------------------------- | -------------- | ----------------------------------------------------------------------------------------- |
| ۱   | ترتیب انتخاب پایگاه داده                  | ✅             | ✅ بدون تغییر                                                                             |
| ۲   | ترتیب درج                                 | ✅             | ✅ بدون تغییر                                                                             |
| ۳   | ترتیب Commit                              | ❌             | ✅ **کلاس STRICT** — قفل ردیف جریان تا Commit نگه داشته می‌شود                            |
| ۴   | ترتیب معنایی دامنه                        | ❌             | ✅ کلاس STRICT · ⚠️ کلاس DETECT: ماندگار ولی بدون اجبار                                   |
| ۵   | رسیدن به Kafka، یک Producer               | ✅             | ✅ بدون تغییر                                                                             |
| ۶   | رسیدن به Kafka، چند Relay                 | ❌             | ✅ کلاس STRICT — سرصف یکتاست، پس دو Relay یک جریان را هم‌زمان منتشر نمی‌کنند              |
| ۷   | ترتیب اعمال در مصرف‌کننده                 | ❌             | ✅ کلاس STRICT · ⚠️ کلاس DETECT: مصرف‌کننده خودش بازچینی/رد می‌کند                        |
| ۸   | تشخیص شکاف/تکرار/وارونگی                  | ❌ (فقط تکرار) | ✅ **هر دو کلاس** — `streamSeq` در Envelope                                               |
| ۹   | رفتار زیر Lease/Backoff/Poison/DLQ/Replay | ❌             | ✅ کلاس STRICT مسدود می‌کند · هر دو کلاس تشخیص می‌دهند · Poison با Timeout مرزدار + هشدار |

**تضمین‌های داده‌نشده، صریح:**

- ❌ Exactly-Once. تحویل **At-Least-Once** می‌ماند؛ A-09 الزامی می‌ماند.
- ❌ ترتیب سراسری. `docs/07 § ۷٫۷` هم لازمش نمی‌داند.
- ❌ ترتیب میان جریان‌های مختلف — از جمله میان `transactionId` و `walletId`.
- ❌ **ترتیب میان `rasta.fleet.v1` و `rasta.maintenance.v1`، حتی با `assetId`
  یکسان.** Q-36 هر دو را STRICT کرد، ولی هرکدام **جریان خودش** است: دو Topic
  جدا، دو پایگاه دادهٔ مستقل، دو جدول شمارندهٔ مستقل. هیچ قفل، شمارنده یا تراکنش
  مشترکی میانشان وجود ندارد و ساختنش نقض A-01 است. اگر مصرف‌کننده‌ای ترتیب علّی
  میان این دو Topic لازم داشت، تصمیم جداگانه و صریح خودش را می‌خواهد.
- ❌ ترتیب برای ردیف‌های قدیمیِ بدون توالی تا پایان Backfill.
- ❌ ترتیب پس از بازپخش دستی DLQ که اپراتور عمداً «رد کردن شکاف» را انتخاب کند.

---

## تعریف «جریان مرتب»

> **جریان مرتب = `topic + partitionKey`.**

نه Aggregate، و دلیلش C-7 است: در `fleet`، `maintenance` و بخش تراکنشی
`economic`، رویدادهای **چند Aggregate متفاوت** عمداً روی یک کلید می‌نشینند.
مکانیزمی که به Aggregate گره بخورد، دقیقاً همان جریان‌هایی را نمی‌پوشاند که
ADR-036 برای مرتب‌ماندن ساخت.

`topic` در کلید هست چون `asset-service` دو Topic منتشر می‌کند و یک
`partitionKey` مشترک در دو Topic دو جریان مستقل است.

---

## Decision (پذیرفته‌شده — 2026-09-04)

### D-1 — دو کلاس جریان، با سیاست Compile-Time

| کلاس       | تضمین                                                | مکانیزم                                                |
| ---------- | ---------------------------------------------------- | ------------------------------------------------------ |
| **STRICT** | هیچ رویدادی از رویداد قبلیِ همان جریان سبقت نمی‌گیرد | توالی + پرچم سرصف ماده‌شده + مسدودسازی سرصف            |
| **DETECT** | ترتیب اجبار نمی‌شود؛ **هر** وارونگی/شکاف دیده می‌شود | توالی + `streamSeq` در Envelope + تشخیص سمت مصرف‌کننده |

تخصیص کلاس در همان `routing.ts`ی می‌نشیند که ADR-036 ساخت، به‌صورت Mapped Type
روی اتحاد نام رویدادها — پس افزودن رویداد بدون تصمیم دربارهٔ کلاس **Compile
نمی‌شود**. هیچ Override اختیاری در محل فراخوانی؛ همان نقص‌کلاسی که ADR-036 حذف
کرد.

تخصیص کلاس‌ها — با شواهد، نه سلیقه (پذیرفته‌شده در 2026-09-04):

| جریان                                                         | کلاس   | چرا                                                                                                                                                                |
| ------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `economic` scope `TRANSACTION` (۵ رویداد)                     | STRICT | مالی؛ `FOR UPDATE` روی `transaction` از قبل مرز را می‌پوشاند                                                                                                       |
| `marketplace` scope `ORDER` (۸ رویداد)                        | STRICT | ADR-036 صریح؛ Saga سفارش                                                                                                                                           |
| `document` (۴ رویداد)                                         | STRICT | ADR-049؛ `SCANNED` پس از `UPLOADED` معنا دارد                                                                                                                      |
| `economic` — `WALLET`, `JOURNAL`, `PAYMENT_INTENT`, `REWARD*` | DETECT | `docs/07:222` — موجودی از دفتر کل بازمحاسبه می‌شود                                                                                                                 |
| `identity`, `organization`, `asset`, `insurance`              | DETECT | چرخه‌عمر ساده؛ مصرف‌کننده وضعیت‌محور                                                                                                                               |
| `rasta.fleet.v1` و `rasta.maintenance.v1` (کلید `assetId`)    | STRICT | **Q-36 (2026-09-04)** — Projection عملیاتی دستگاه؛ و چون R4 نشان داد قفل دامنه‌ای روی این مرز وجود **ندارد**، سریالایز کردن کار قفل ردیف شمارنده است، نه قفل موجود |

### D-2 — تخصیص توالی: جدول شمارنده، نه `BIGSERIAL`

در پایگاه دادهٔ **هر سرویس، جدا** (A-01؛ هیچ جدول توالی مشترکی):

```sql
CREATE TABLE outbox_stream_sequence (
  topic         TEXT   NOT NULL,
  partition_key TEXT   NOT NULL,
  next_seq      BIGINT NOT NULL DEFAULT 1,
  published_seq BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (topic, partition_key)
);
```

تخصیص، **درون همان تراکنش دامنه**:

```sql
INSERT INTO outbox_stream_sequence AS s (topic, partition_key, next_seq)
VALUES ($1, $2, 2)
ON CONFLICT (topic, partition_key)
DO UPDATE SET next_seq = s.next_seq + 1
RETURNING next_seq - 1 AS allocated;
```

سه خاصیتی که این شکل می‌دهد و `BIGSERIAL` نمی‌دهد:

1. **بدون شکاف روی Rollback.** `nextval()` تراکنشی نیست؛ Rollback شماره را
   می‌سوزاند و شکاف دائمی می‌سازد که از «گم‌شده» قابل تفکیک نیست. این یک ردیف
   جدول است؛ Rollback شمارنده را هم برمی‌گرداند.
2. **ترتیب تخصیص = ترتیب Commit.** قفل ردیف تا Commit نگه داشته می‌شود، پس
   تراکنش دوم روی همان جریان تا Commit اولی بلوکه است. **این تنها چیزی است که
   § R4 را می‌بندد** و هیچ‌کدام از گزینه‌های «شمارهٔ افزایشی» ندارندش.
3. **مرز درست.** `(topic, partition_key)` است، نه Aggregate (C-7).

هزینهٔ صریح: تراکنش‌های هم‌زمان روی یک جریان **سریالایز** می‌شوند. برای جریان‌های
STRICT این خودِ خواسته است. برای کلید داغ — و `assetId` یک دستگاه پرکار دقیقاً
همین است — هزینهٔ توان عملیاتی واقعی است، هنگام بستن Q-36 صریحاً پذیرفته شد، و
Fixture سنجشش در طرح اجرا ثبت است.

### D-3 — Schema روی `outbox_message`

```sql
ALTER TABLE outbox_message ADD COLUMN stream_seq     BIGINT;
ALTER TABLE outbox_message ADD COLUMN is_stream_head BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX ux_outbox_stream_seq
    ON outbox_message (topic, partition_key, stream_seq)
 WHERE stream_seq IS NOT NULL;
```

`stream_seq` عمداً Nullable می‌ماند تا ردیف‌های پیش از Backfill معتبر باشند، و
Index یکتا `WHERE stream_seq IS NOT NULL` است تا آن‌ها را نشمارد.

چهار Index سرصف = چهار Index ADR-050 با `AND is_stream_head` (R10).

### D-4 — الگوریتم انتشار

**تخصیص** (درون تراکنش دامنه، بدون I/O شبکه):
`allocated ← ON CONFLICT DO UPDATE` · `is_stream_head ← (allocated = published_seq + 1)` · درج ردیف Outbox.

**Claim.** همان پرسش چهارجریانی ADR-050، با `AND is_stream_head` روی جریان‌های
STRICT. برای DETECT بدون تغییر.

**Ack.** درون همان تراکنشِ `markPublished`:
`published_seq ← stream_seq` و سپس ردیف `stream_seq = published_seq + 1` همان
جریان `is_stream_head ← true`. یک `UPDATE` نقطه‌ای روی Index یکتا.

**Poison.** ردیف STRICT که به سقف تلاش برسد، جریانش را می‌بندد. سه چیز لازم
است و در طرح اجرا آمده: هشدار روی «سن سرصف مسدود»، متریک «جریان‌های مسدود»، و
دستور اپراتوری صریح برای «رد کردن با ثبت شکاف» که هرگز خودکار نیست.

> این ADR **عمداً** مسدودسازی سرصف را بدون این سه ادعا نمی‌کند. یک رویداد
> مسموم می‌تواند یک سفارش یا یک تراکنش را برای همیشه متوقف کند، و آن هزینه باید
> دیده و مدیریت شود.

### D-5 — قرارداد Envelope

`streamSeq: z.number().int().positive().optional()` و
`streamKey: z.string().optional()` به Envelope، به‌همراه Header
`x-stream-seq`. **`eventVersion` تغییر نمی‌کند** — فیلد اختیاری تازه، شکستن
سازگاری نیست و مصرف‌کنندهٔ قدیمی نادیده‌اش می‌گیرد.

مصرف‌کننده `last_seq` را per `(streamKey, consumerName)` نگه می‌دارد:
`seq = last + 1` بپذیر · `≤ last` تکراری/کهنه، رد کن (این همان چیزی است که
R6 امروز ندارد) · `> last + 1` شکاف؛ تا Timeout مرزدار نگه دار، سپس هشدار.

**حریم خصوصی.** `streamKey` همان `partitionKey` امروز است و هیچ داده‌ای اضافه
نمی‌کند. `streamSeq` عدد است. هیچ‌کدام PII حمل نمی‌کنند.

---

## Alternatives — جدول تصمیم

| #   | گزینه                                  | R1 (میلی‌ثانیه) | R4 (Commit)   | R2/R5 (سبقت) | R3 (چند Relay) | R6 (بازپخش) | حکم                                                                                                 |
| --- | -------------------------------------- | --------------- | ------------- | ------------ | -------------- | ----------- | --------------------------------------------------------------------------------------------------- |
| ۱   | پذیرش محدودیت + مصرف‌کنندهٔ وضعیت‌محور | ❌              | ❌            | ❌           | ❌             | ❌          | برای مالی/سفارش ناکافی؛ **بخشی پذیرفته** برای کلاس DETECT                                           |
| ۲   | `monotonicFactory` ULID                | ✅ (۰ وارونگی)  | ❌            | ❌           | ❌             | ❌          | فقط ۱ از ۶ مسیر. یکنواختی **درون‌فرآیندی** است؛ دو Pod دو دنباله                                    |
| ۳   | `BIGSERIAL` سراسری                     | ✅              | ❌            | ❌           | ❌             | ⚠️ تشخیص    | `nextval` تراکنشی نیست ⇒ شکاف Rollback جدانشدنی از گم‌شدگی                                          |
| ۴   | `aggregateVersion` تولیدکننده          | ✅              | ⚠️ فقط با قفل | ❌           | ❌             | ⚠️ تشخیص    | **واحد اشتباه** (C-7)؛ امروز فقط ۳ محل (C-6)                                                        |
| ۵   | توالی هر `topic+partitionKey`          | ✅              | ✅ **(D-2)**  | ⚠️ تشخیص     | ⚠️ تشخیص       | ✅ تشخیص    | لازم است، تنهایی کافی نیست — عدد سبقت را متوقف نمی‌کند                                              |
| ۶   | مسدودسازی سرصف                         | ✅              | ✅            | ✅           | ✅             | ✅          | **لازم برای STRICT.** شکل بدیهی‌اش رد می‌شود (R9)؛ با پرچم ماده‌شده می‌شود (R10)                    |
| ۷   | یک Relay مالک هر Partition             | ✅              | ✅            | ✅           | ✅             | ✅          | نیازمند انتخاب رهبر/هماهنگی؛ نقطهٔ شکست تازه و بازتوزیع پیچیده — بزرگ‌تر از لازم                    |
| ۸   | بازچینی ماندگار سمت مصرف‌کننده         | ⚠️              | ⚠️            | ⚠️           | ⚠️             | ⚠️          | هزینه را به **هر** مصرف‌کننده منتقل می‌کند؛ Buffer بی‌کران و Timeout؛ برای DETECT خوب، برای مالی نه |
| ۹   | Saga/ماشین وضعیت تحمل‌کنندهٔ بی‌ترتیبی | ⚠️              | ⚠️            | ⚠️           | ⚠️             | ⚠️          | برای برخی جریان‌ها درست است؛ برای جریان دارایی با Q-36 رد شد و کلاس DETECT جای آن را می‌گیرد        |

**چرا ۵ + ۶ و نه فقط ۵:** خواستهٔ صریح این بررسی بود که «عدد به‌تنهایی جلوی
سبقت را نمی‌گیرد و تشخیص، پیشگیری نیست». R2 و R5 دقیقاً همین را نشان دادند: با
هر شماره‌ای، ردیف بعدی همچنان واجد شرایط است.

**چرا ۶ فقط برای STRICT:** R9/R10 هزینهٔ فنی را حل می‌کنند، اما هزینهٔ رفتاری —
یک رویداد مسموم که کل جریان را می‌خواباند — با Index حل نمی‌شود. اعمالش روی هر
جریان، سبقت را با توقف عوض می‌کند.

**چرا ۷ رد شد:** ۶ همان تضمین را **بدون** انتخاب رهبر می‌دهد، چون سرصف در
پایگاه داده یکتاست: دو Relay نمی‌توانند هم‌زمان سرصف یک جریان را Claim کنند.

---

## Consequences

**به دست می‌آید:** بستن هر شش مسیر وارونگی برای جریان‌های STRICT؛ تشخیص شکاف و
رد رویداد کهنه برای **همه**؛ مرزی که با ADR-036 هم‌راستاست؛ سازگاری کامل با
Token Fencing و Lease های ADR-050 (این طرح شرط `is_stream_head` را **اضافه**
می‌کند و هیچ شرطی را برنمی‌دارد).

**هزینه، اندازه‌گیری‌شده:**

| هزینه                                   | مقدار                                        | منبع |
| --------------------------------------- | -------------------------------------------- | ---- |
| اندازهٔ جدول                            | +۱٬۸۴۳٬۲۰۰ بایت (+۵٫۸٪)                      | R7   |
| Index یکتای توالی + سرصف جریان          | +۱۹٬۹۳۹٬۳۲۸ بایت (+۵۹٫۲٪) روی ۲۰٬۰۰۰ جریان   | R7   |
| چهار Index سرصف                         | ۱۸۰٬۲۲۴ بایت — **تابع تعداد جریان، نه ردیف** | R10  |
| جدول `outbox_stream_sequence`           | ۲٬۵۰۶٬۷۵۲ بایت برای ۲۰٬۰۰۰ جریان             | R7   |
| اوج موقت Backfill                       | ~۲ برابر جدول ⇒ Backfill دسته‌ای الزامی      | R7   |
| نوشتن اضافه در هر Ack                   | یک `UPDATE` نقطه‌ای روی Index یکتا           | D-4  |
| سریالایز شدن تراکنش‌های یک جریان        | ذاتی D-2؛ برای کلید داغ واقعی است            | D-2  |
| توقف جریان بر اثر رویداد مسموم (STRICT) | نیازمند هشدار + متریک + دستور اپراتوری       | D-4  |

**تقویت قفل `۴ × limit` ADR-050 دست‌نخورده می‌ماند** و این طرح آن را بدتر
نمی‌کند: `is_stream_head` هر جریان را **باریک‌تر** می‌کند.

**برگشت‌پذیری.** هر سه گام برگشت‌پذیرند: ستون‌ها Nullable/Defaultدارند، Index ها
`DROP` می‌شوند، جدول توالی `DROP` می‌شود، و Relay قدیمی روی Schema تازه بدون
تغییر کار می‌کند — همان ترتیب Expand/Migrate/Contract که ADR-050 استفاده کرد.

---

## آنچه حل نمی‌شود و باز می‌ماند

- **D-027 باز می‌ماند.** پذیرش این ADR طراحی را تصویب می‌کند، نه رفتار را. تا
  وقتی Phase B پیاده و تأیید نشده، **هیچ تضمین تازه‌ای برقرار نیست** و امروز هر
  شش مسیر وارونگی § R1–R6 همچنان باز است.

  **شرط بسته شدن D-027 — هر سه، با هم:** (۱) اجرای Phase B؛ (۲) سبز شدن همهٔ
  دروازه‌های پذیرش [طرح اجرا](ADR-051-implementation-plan.md) § ۸ — آزمون‌های
  قطعی روی PostgreSQL و Kafka واقعی، آستانه‌های کارایی، برگشت‌پذیری Migration
  روی هر هشت پایگاه داده، آزمون جداسازی مستأجر، Runbook «جریان مسدود»، و CI
  کامل `main`؛ (۳) یک **ثبت پذیرش جداگانهٔ صاحب محصول** روی همان شواهد. هیچ‌کدام
  جای دیگری را نمی‌گیرد.

- **Q-36 بسته شد** (2026-09-04): جریان‌های `fleet` و `maintenance` کلاس STRICT
  گرفتند.
- **ADR-051 پذیرفته شد** (2026-09-04) — معماری تصویب شد. اکنون تنها چیزی که
  Phase B را نگه داشته، **دستور اجرای صریح صاحب محصول** است، نه یک تصمیم باز.
- تحویل **At-Least-Once** می‌ماند؛ A-09 الزامی می‌ماند.
- فقدان ابزار بازپخش DLQ (§ R6) و Comment کهنهٔ `kafka.publisher.ts` (§ C-9)
  گزارش شده‌اند و خارج از دامنهٔ این Task‌اند.
