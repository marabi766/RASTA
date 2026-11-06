# Runbook: سفارش «دریافت تأییدشده» بی تأیید خریدار، و اختلاف باز بی مرحلهٔ مبدأ (D-083)

**شدت:** ⚪ عملیاتی
**هشدار محرک:** ندارد — یک بار پس از استقرار Migration `20261103130000_order_dispute_origin` در marketplace-service، و هر بار
که سفارشی در `RECEIPT_CONFIRMED` گیر کرده گزارش شود یا اپراتور با `DISPUTE_ORIGIN_UNKNOWN` یا
`DISPUTE_RECEIPT_EVIDENCE_MISSING` روبه‌رو شود.
**دامنه:** پایگاه دادهٔ marketplace-service؛ فقط خواندن.

---

## چرا

پیش از D-083، تصمیم `SETTLE` اپراتور هر سفارش در اختلاف را به `RECEIPT_CONFIRMED` می‌برد — حتی اختلافی که خریدار پیش از تأیید
دریافت (در `FUNDS_HELD`، `CONFIRMED` یا `AWAITING_RECEIPT_CONFIRMATION`) ثبت کرده بود. چنین سفارشی دریافتی را ادعا می‌کند که
کسی تأیید نکرده (`receipt_confirmed_at`/`receipt_confirmed_by` خالی)، Saga ـش تسویه را مجاز می‌کند و `markSettling` با
`ck_order_settled_after_receipt` رد می‌شود: وجه مجاز به تسویه، سفارش گیرکرده (ممیزی marketplace، یافتهٔ F1).

از این Migration به بعد:

- `SETTLE` سفارش را به همان مرحله‌ای برمی‌گرداند که اختلاف در آن ثبت شد؛ فقط اختلافِ پس از تأیید دریافت به `RECEIPT_CONFIRMED`
  برمی‌گردد. آن مرحله را پایگاه داده هنگام ثبت اختلاف روی ردیف آن می‌نویسد (`order_dispute.raised_from_status`).
- برای اختلاف‌های باز پیش از Migration، مرحلهٔ مبدأ فقط وقتی پر شد که تاریخچهٔ سفارش آن را بی‌تردید می‌گفت؛ بقیه خالی ماندند و
  `SETTLE` برایشان با `DISPUTE_ORIGIN_UNKNOWN` رد می‌شود (`REFUND` همچنان ممکن است).
- `ck_order_receipt_confirmed_has_evidence` (`NOT VALID`) هر نوشتن تازهٔ `RECEIPT_CONFIRMED` بی تأیید خریدار را رد می‌کند،
  ولی ردیف‌های موجود را نه بررسی می‌کند و نه اصلاح.

**هیچ اصلاح خودکاری وجود ندارد.** ردیف خراب را با SQL «درست» نکن: هر وضعیتی که دستی بنویسی ادعایی است دربارهٔ وجه که کسی
آن را تأیید نکرده است.

## گام ۱ — شناسایی (فقط خواندن)

از ریشهٔ مخزن، با نقش Migrator ـِ marketplace (همان که `db:migrate` به کار می‌برد) و تراکنش فقط‌خواندنی:

```bash
PGOPTIONS='-c default_transaction_read_only=on' \
  node scripts/psql-prisma-url.mjs DATABASE_URL_MARKETPLACE_MIGRATOR -X -v ON_ERROR_STOP=1 \
  -f services/marketplace-service/prisma/checks/dispute-settle-evidence.sql
```

خروجی فقط شناسه است (بی مبلغ، دلیل یا متن طرفین). ستون `finding`:

| `finding`                           | معنا                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| `RECEIPT_CONFIRMED_WITHOUT_RECEIPT` | سفارش در `RECEIPT_CONFIRMED` بی تأیید دریافت ثبت‌شده — همان که `SETTLE` قدیمی می‌نوشت |
| `OPEN_DISPUTE_ORIGIN_UNKNOWN`       | اختلاف باز پیش از Migration که مرحلهٔ مبدأش معلوم نیست؛ `SETTLE` برایش رد می‌شود      |

هیچ ردیفی: کاری نیست. شمار و زمان اجرا را در Change Record استقرار ثبت کن.

## گام ۲ — اگر ردیفی یافت شد

- **`RECEIPT_CONFIRMED_WITHOUT_RECEIPT`.** شناسه‌ها را با وضعیت تراکنش economic-service ـِ هر سفارش
  (`economic_transaction_id`، از `GET /v1/transactions/:id`) برای PM بفرست. تسویه نکن و وضعیت را دستی عوض نکن. تنها خروج
  موجود همان مسیر عادی است: اختلاف تازه روی سفارش (از `RECEIPT_CONFIRMED` مجاز است) و تصمیم اپراتور؛ `SETTLE` آن با
  `DISPUTE_RECEIPT_EVIDENCE_MISSING` رد می‌شود چون دریافتی برای بازگشت به آن ثبت نشده، و `REFUND` وجه را برمی‌گرداند. انتخاب
  میان این و هر راه دیگر تصمیم PM است.
- **`OPEN_DISPUTE_ORIGIN_UNKNOWN`.** اپراتور می‌تواند `REFUND` کند. اگر به نظر او حق با فروشنده است، شناسه را برای PM بفرست؛
  مرحلهٔ مبدأ را با SQL ننویس — Trigger ـِ `trg_order_dispute_origin` هر تغییر آن را برمی‌گرداند، و حدس زدنش همان خطایی است که
  این Runbook برای آن نوشته شده.
