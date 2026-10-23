# Runbook: نسبت‌دادن حل اعتراض‌های پیشین تراکنش (Backfill `resolved_dispute_id`، D-060)

**شدت:** ⚪ عملیاتی
**هشدار محرک:** ندارد — یک بار، پس از نخستین استقرار economic-service با Migration
`20261022120000_transaction_resolved_dispute` (#352، task 064).
**دامنه:** فقط ستون `transaction.resolved_dispute_id` روی ردیف‌هایی که نسبتشان قطعی است. هیچ مبلغ، وضعیت، رویداد یا
Journal ای نوشته نمی‌شود.

---

## چرا Migration این کار را نمی‌کند

Migration فقط Catalogue را عوض می‌کند (ستون nullable، تابع و Trigger) و هیچ ردیفی نمی‌نویسد، تا قفل جدول `transaction` به
اندازه جدول طول نکشد (Codex روی #352، یافته ۱). Trigger هر ردیف قطعی را در **نوشتن بعدی‌اش** خودش نسبت می‌دهد، ولی ردیف
`SETTLED` دیگر نوشته نمی‌شود. این Backfill بقیه را می‌نویسد.

**ردیف قطعی:** `status` در `PENDING_SETTLEMENT` یا `SETTLED`، با `disputed_at`، `dispute_resolved_at` و `dispute_id` پر و
`resolved_dispute_id` خالی. ردیف باز (`DISPUTED`) و ردیف `REFUNDED` **هرگز** نسبت داده نمی‌شوند: ردیف Refundشده ممکن است از
`DISPUTED` و کنار حل اعتراضی پیشین Refund شده باشد و چیزی روی ردیف نمی‌گوید کدام.

## تا وقتی اجرا نشده

- API برای ردیف‌هایی که Backfill به آن‌ها نرسیده `resolvedDisputeId: null` برمی‌گرداند.
- پورتال (`/transactions/[id]`) حل چنین ردیفی را به اعتراض نشان‌داده‌شده نسبت **نمی‌دهد** و از زمان‌ها هم نتیجه نمی‌گیرد:
  آن را «زمان آخرین رسیدگی» و «شرح آخرین تصمیم» نشان می‌دهد و می‌گوید سامانه ثبت نکرده این تصمیم برای کدام اعتراض است
  (Codex روی #352 دور ۲). پس دیر اجرا شدن نسبت غلطی نشان نمی‌دهد؛ فقط ردیفی که قطعی است تا اجرا «نامعلوم» دیده می‌شود.
- ردیف `PENDING_SETTLEMENT` در نوشتن بعدی‌اش (تسویه، اعتراض دوباره، Refund) را خود Trigger نسبت می‌دهد؛ `SETTLED` تا اجرای
  این Runbook بی‌شناسه می‌ماند.
- ردیف `REFUNDED` و باز پس از اجرا هم بی‌شناسه می‌مانند و همان نمایش «نامعلوم» را دارند. این عمدی است.

## پیش‌شرط

- Migration اجرا شده است (`_prisma_migrations` ردیف `20261022120000_transaction_resolved_dispute` را دارد).
- Rollout نسخه جدید لازم نیست: Trigger نوشتن پاد نسخه پیشین را هم درست نسبت می‌دهد. ولی پیش از اجرا مطمئن شو که Migration
  بازگردانده نمی‌شود؛ `down.sql` ستون را حذف می‌کند و نتیجه این اجرا از دست می‌رود.
- محیط سرویس economic با نقش زمان اجرا: `DATABASE_URL_ECONOMIC` (D-045). اعتبارنامه Migrator نباید در محیط باشد؛ دستور
  آن را رد می‌کند و با اتصال مالک (Owner) هم اجرا نمی‌شود.
- از Checkout همان نسخه مستقر، با economic ساخته‌شده: دستور `dist/transaction/resolved-dispute-backfill.cli.js` را اجرا می‌کند
  (`pnpm --filter @rasta/economic-service build`).

## اجرا

| گام | کار                                                                                    | بررسی                                                                                         |
| --- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| ۱   | **Dry Run:** `pnpm --dir services/economic-service db:backfill:resolved-dispute`       | یک خط `plan` با `unattributed` و `summary` با `status: "planned"`؛ کد خروج ۰؛ هیچ نوشتنی نیست |
| ۲   | **Apply:** `pnpm --dir services/economic-service db:backfill:resolved-dispute --apply` | یک خط `batch` برای هر دسته؛ `summary` با `status: "done"` و `unattributed: 0`؛ کد خروج ۰      |
| ۳   | دوباره Dry Run (گام ۱)                                                                 | `unattributed: 0`                                                                             |

عدد `unattributed` در گام ۱ و `attributed` در گام ۲، و زمان و نام اجراکننده را در Change Record استقرار ثبت کن.

خروجی NDJSON است و فقط شمارنده و شناسه تراکنش دارد:

```text
{"event":"plan","unattributed":400000}
{"event":"batch","batch":1,"scanned":500,"attributed":212,"lastId":"..."}
{"event":"summary","status":"done","batches":2000,"attributed":400000,"unattributed":0,"lastId":"..."}
```

هر دسته ۵۰۰ ردیف به ترتیب کلید اصلی است، در تراکنش کوتاه خودش با `lock_timeout` یک ثانیه و `statement_timeout` دو ثانیه، و
فقط قفل ردیف‌هایی را نگه می‌دارد که نسبت می‌دهد. پنجره نگه‌داری لازم نیست. اندازه دیده‌شده روی میزبان توسعه: یک میلیون
تراکنش (۴۰۰ هزار قابل نسبت) در ۵۶ ثانیه، حدود ۲۸ میلی‌ثانیه هر دسته؛ حرکت یک ردیف حداکثر همین قدر پشت دسته می‌ماند.

گزینه‌ها: `--batch-size n` (۱ تا ۵۰۰۰)، `--max-batches n` (برش کران‌دار)، `--after <id>` (ادامه از جای توقف)،
`--statement-timeout-ms n`، `--lock-timeout-ms n`.

## توقف و ادامه

اجرا هر جا متوقف شود چیزی نیمه‌کاره نمی‌ماند: هر دسته یا کامل Commit می‌شود یا هیچ. دوباره اجرا کردن امن است؛ فقط ردیف‌های
هنوز خالی نوشته می‌شوند و مقدار را همیشه Trigger از ردیف قفل‌شده می‌گیرد، پس حرکتی که میان دسته‌ها Commit شود غلط نسبت داده
نمی‌شود.

| خروجی                                                    | معنا                                                      | کار                                                             |
| -------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------- |
| `failed` با `code: "55P03"`، سپس `summary` با `"failed"` | دسته پشت قفل حرکتی بیش از `lock_timeout` ماند؛ چیزی ننوشت | همان دستور را با `--after <lastId>` از `summary` دوباره اجرا کن |
| `failed` با `code: "57014"`                              | `statement_timeout` دسته تمام شد                          | با `--after <lastId>` و `--batch-size` کوچک‌تر ادامه بده        |
| `summary` با `"incomplete"` پس از `--max-batches`        | برش تمام شد                                               | با `--after <lastId>` ادامه بده                                 |
| `summary` با `"incomplete"` در پایان اجرایی با `--after` | ردیف‌های پیش از `after` در این اجرا خوانده نشدند          | یک بار بی `--after` اجرا کن                                     |
| کد خروج ۱ بی `summary`                                   | گزینه نادرست، اعتبارنامه Migrator یا اتصال مالک           | پیام stderr را بخوان؛ چیزی نوشته نشده است                       |

## برگشت

نیازی نیست: این اجرا فقط شناسه‌ای را می‌نویسد که Trigger قطعی می‌داند، و هیچ تصمیمی به این ستون تکیه ندارد. اگر Migration
بازگردانده شود (`down.sql`)، ستون و نتیجه این اجرا با هم حذف می‌شوند؛ پس از up دوباره این Runbook را دوباره اجرا کن.

## مرجع

- [`docs/23` D-060](../23-risks-and-tradeoffs.md) — طراحی، اندازه‌گیری و پیگیری‌ها.
- `services/economic-service/src/transaction/resolved-dispute-backfill.ts` و `.cli.ts`.
- آزمون: `services/economic-service/test/transaction-resolved-dispute.int-spec.ts`.
