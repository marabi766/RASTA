# Runbook: تصمیم دربارهٔ تراکنشی که روی Hold دیگران ایستاده است (FU-138)

**شدت:** 🟠 هشدار — پولی گم نشده، ولی این تراکنش بی تصمیم و بی Hold خودش تسویه نمی‌شود و سفارشش در `FUNDS_HELD` ثبت نمی‌شود.
**سیگنال محرک:** WARNING ـِ Migration ‏`20261105120000_settlement_creation_proof` («stand on a decision read from a hold not their own»)؛
Saga سفارش با `OBLIGATION_NOT_HELD`، وضعیت `HELD` و `funds UNPROVEN`؛ تسویهٔ ردشده با `409 INVALID_STATE_TRANSITION` و متن
«settles only from a funded hold»؛ بازپرداخت ردشده با متن «nothing moves until an operator has looked»؛ WARNING ـِ Migration ‏`20261106130000_transaction_funded_hold` و ‏`20261107120000_hold_funded_at_commit`؛ Saga با `SETTLEMENT_EXHAUSTED` روی چنین تراکنشی.
**دامنه:** برای تصمیم: ردیف‌های `transaction_hold_reconciliation` با هر نتیجه‌ای جز `RESTORED_TO_PENDING_SETTLEMENT` که هنوز تصمیمی ندارند. برای بخش «Hold تأمین‌نشده» و «پرداخت‌نشدنی»: هر تراکنشی.
**ابزار:** `decide_transaction_hold(id, decision, reason)` فقط با نقش migrator؛ نقش runtime سرویس نه EXECUTE دارد و نه می‌تواند ردیف تصمیم بنویسد.

---

## چرا

نسخه‌های پیشین هر Holdی را که نام تراکنش را می‌برد Hold همان تراکنش می‌شمردند. پس تراکنشی می‌تواند جایی ایستاده باشد که Hold سازمانی
دیگر آن را نشانده است. Migration یادشده این ردیف‌ها را فهرست کرد و تا این Runbook کسی آن فهرست را نمی‌خواند. اکنون
(Migration ‏`20261106120000_transaction_hold_decision`) هر ردیفِ تصمیم‌نگرفته:

- برای API اثبات Hold نیست: `heldProven` برابر `false` است و Saga سفارش آن را نمی‌پذیرد و `ORDER_FUNDS_HELD` منتشر نمی‌کند.
- هیچ مجوز تسویه‌ای ندارد، حتی با `settlement_authorised_at` پر: نه سرویس تسویه می‌کند و نه پایگاه داده آزادسازی Hold یا رفتن به `SETTLED` را می‌پذیرد.
- **بازپرداخت باز می‌ماند:** بازپرداخت فقط Hold خود پرداخت‌کننده را به خودش برمی‌گرداند و بی Hold هیچ پولی جابه‌جا نمی‌کند، پس بی‌تصمیم هم راه خروج هست. تعهد صورت‌وضعیت (`STATEMENT`) بازپرداخت نمی‌پذیرد.

**تصمیم فقط دربارهٔ مدرک است و هرگز مجوز پرداخت نیست (D-123، D-130).** هر ردیفی که زمانی ادعای Escrow کرده، فقط از Hold فعال و تأمین‌شدهٔ خودش با همان مبلغ و ارز تسویه می‌شود و اگر در فهرست است پس از تصمیم (`transaction_settlement_barred`). ادعای Escrow یعنی یکی از این سه: در فهرست بودن با هر نتیجه‌ای، از جمله `RESTORED_TO_PENDING_SETTLEMENT`؛ داشتن Hold خود با هر وضعیتی؛ یا اینکه زمانی `HELD` بوده است (`held_at`). `CONFIRMED`، `VOIDED` یا `authorise-settlement` هیچ برداشتی از موجودی قابل‌مصرف ممکن نمی‌کند؛ همین برای ردیفی که از پیش `PENDING_SETTLEMENT` است و اعتراضی که بی Hold خود رسیدگی شود (به `HELD` برمی‌گردد) هم برقرار است. فقط تعهدی که هرگز ادعای Escrow نکرده است از موجودی قابل‌مصرف پرداخت می‌شود (ADR-032).

**Hold تأمین‌شده (`wallet_hold_funded`)** یعنی Hold به ارز کیف پول خودش باشد و `placed_journal_id` به Journal واقعی ‌`FUNDS_HELD` همان تعهد روی دفتر همان سازمان اشاره کند (برای Hold تراکنش، همان تراکنش؛ برای Hold بازپرداخت، شارژ همان Payment Intent با همان مبلغ و ارز)، آن Journal برنگشته باشد و خالص حرکتش به حساب `ESCROW` همان سازمان و همان ارز دقیقاً برابر مبلغ Hold باشد. هر Journal برای همیشه فقط پشتوانهٔ یک Hold است. مبلغ، ارز و Journal یک Hold هرگز تغییر نمی‌کند و Hold حل‌شده هرگز دوباره `ACTIVE` نمی‌شود: تلاش دوباره یعنی Hold تازه با Journal تازه.

## ۱. فهرست

با نقش migrator و `psql -v transaction_id=TXN_...` (بدون این متغیر `:'transaction_id'` اجرا نمی‌شود):

```sql
SELECT c.transaction_id, c.outcome, t.status, t.organization_id, t.counterparty_organization_id,
       t.gross_amount_minor, t.currency, t.source_type, t.source_reference, t.dispute_id
  FROM transaction_hold_reconciliation c
  JOIN "transaction" t ON t.id = c.transaction_id
 WHERE transaction_hold_decision_unresolved(c.transaction_id)
 ORDER BY c.found_at, c.transaction_id;
```

برای هر ردیف، همهٔ Holdهایی که نامش را می‌برند (ستون `own` یعنی Hold خود پرداخت‌کننده):

```sql
SELECT h.id, h.organization_id, h.wallet_id, h.status, h.amount_minor, h.currency, h.reference_type,
       h.id IN (SELECT o.id FROM transaction_holds(t.id, t.organization_id) o) AS own
  FROM wallet_hold h
  JOIN "transaction" t ON t.id = h.reference
 WHERE t.id = :'transaction_id';
```

سوابق را هم ببین: `SELECT * FROM settlement_authority_reconciliation WHERE transaction_id = :'transaction_id';`، و اگر `source_type = 'ORDER'` است، سفارش `source_reference` را در marketplace-service.

ردیف `HELD` بی Hold خود که در این فهرست نیست تصمیم نمی‌پذیرد: `heldProven` برابر `false` است، پس از `authorise-settlement` هم تسویه نمی‌شود و راهش بازپرداخت از راه سرویس است. ردیفی که در این فهرست نیست و Hold فعال تأمین‌نشده دارد نه تصمیم می‌پذیرد، نه تسویه و نه بازپرداخت: به مالک محصول ارجاع بده.

Holdهای فعال تأمین‌نشده، با هر هدفی:

```sql
SELECT id, organization_id, reference, reference_type, amount_minor, currency, placed_journal_id
  FROM wallet_hold
 WHERE status = 'ACTIVE' AND NOT wallet_hold_funded(id);
```

## ۲. تصمیم

| وضعیت و نتیجه                                                                                     | چه چیزی را بررسی کن             | تصمیم                                                               | اثر                                                                                                                    |
| ------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `HELD`، بی Hold فعال خود                                                                          | پولی در Escrow نیست             | `VOIDED`                                                            | در `HELD` می‌ماند و تسویه نمی‌شود، بی Journal و بی جابه‌جایی پول؛ راه‌های بعدی در پایین                                |
| `HELD_UNPROVEN` یا `RETURNED_TO_HELD_UNPROVEN` که با مجوز یا اعتراض از `HELD` رفته و هنوز باز است | همان بررسی بالا                 | `CONFIRMED` فقط با Hold فعال خود با همان مبلغ و ارز؛ وگرنه `VOIDED` | وضعیت عوض نمی‌شود؛ تسویه فقط با آن Hold باز می‌شود                                                                     |
| `HELD`، Hold فعال و تأمین‌شدهٔ خود با همان مبلغ و ارز                                             | منشأ آن Hold را اثبات کن        | `CONFIRMED`                                                         | `heldProven` برابر `true` می‌شود                                                                                       |
| `HELD`، Hold فعال و تأمین‌شدهٔ خود با مبلغ دیگر                                                   | —                               | هر دو رد می‌شوند                                                    | بازپرداخت از راه سرویس، سپس `CONFIRMED` برای بستن پرونده. با ارز دیگر، بازپرداخت هم رد می‌شود: به مالک محصول ارجاع بده |
| `HELD`، در این فهرست، Hold فعال تأمین‌نشدهٔ خود                                                   | پولی در Escrow نیست             | `VOIDED`                                                            | تسویه و بازپرداخت هر دو رد می‌شوند و هیچ مسیری آن Hold را نمی‌بندد: به مالک محصول ارجاع بده                            |
| `AUTHORISED_UNRECORDED_UNPROVEN`                                                                  | مجوز قدیمی واقعاً داده شده بود؟ | `CONFIRMED` یا `VOIDED`                                             | `CONFIRMED`: مجوز ثبت‌شده با Hold فعال خود دوباره می‌شمارد. `VOIDED`: برای همیشه نمی‌شمارد و بازپرداخت راه خروج است    |
| `DISPUTE_RESOLVED_UNPROVEN`                                                                       | تصمیم پیشین درست بود؟           | `CONFIRMED` یا `VOIDED`                                             | گذشته را برنمی‌گرداند؛ ردیف باز فقط با Hold فعال خود تسویه می‌شود                                                      |

**راه‌های پس از تصمیم، فقط این دو:**

1. **Hold تازه:** Hold فعال خود پرداخت‌کننده با همان مبلغ و ارز. آن‌گاه `heldProven` برابر `true` است و ردیف با مجوز عادی (`authorise-settlement`) مانند هر ردیف دیگری تسویه می‌شود. ردیف `PENDING_SETTLEMENT` بی مجوز این لبه را ندارد: از راه اعتراض و رسیدگی به `HELD` برمی‌گردد. **هیچ مسیر سرویسی Hold روی تراکنش موجود نمی‌گذارد:** سرویس Hold را فقط هنگام ساخت تراکنش می‌گذارد، پس برای پرداخت معمولاً تراکنش تازه‌ای از مسیر عادی لازم است. نوشتن دستی Hold تصمیم مالک محصول است و **Hold بی Journal تأمین‌نشده است:** هیچ چیز را اثبات نمی‌کند، تسویه و بازپرداخت نمی‌شود و هیچ پولی جابه‌جا نمی‌کند.
2. **بازپرداخت از راه سرویس (`refund`):** ردیف بی Hold را بی جابه‌جایی پول به `REFUNDED` می‌برد. لبهٔ `CANCEL` فقط از `CREATED` است. ردیفی که Hold فعال تأمین‌نشده دارد بازپرداخت نمی‌شود.

**تعهد `STATEMENT` هیچ‌کدام از این دو راه را ندارد.** تعهد صورت‌وضعیتی که در فهرست است و Hold تأمین‌شده ندارد، با هر تصمیمی و با نتیجهٔ `RESTORED_TO_PENDING_SETTLEMENT`، مسدود می‌ماند: تسویه با `409 INVALID_STATE_TRANSITION` و متن «until the product owner decides» رد می‌شود و بازپرداخت با «not refunded or cancelled». هیچ پولی جابه‌جا نمی‌شود. راه پیش‌رو پرسش بازِ مالک محصول است (D-130): به مالک ارجاع بده.

```sql
SELECT decide_transaction_hold(:'transaction_id', 'VOIDED', 'TICKET-123: شخص تصمیم‌گیرنده و دلیل');
```

- خروجی وضعیت پس از تصمیم است. دلیل ۱۰ تا ۵۰۰ نویسه است.
- `decided_by` نام نقش پایگاه داده است، نه شخص: **شمارهٔ Ticket و نام تصمیم‌گیرنده را در دلیل بنویس.**
- هر ردیف یک تصمیم دارد و تصمیم هرگز عوض نمی‌شود؛ تصمیم دوم رد می‌شود. پس پیش از اجرا مطمئن شو.
- هرگز `INSERT`، `UPDATE` یا `DELETE` دستی نزن و Trigger را خاموش نکن.

## ۳. پس از تصمیم

```sql
SELECT d.*, t.status, transaction_held_proven(t.id) AS held_proven
  FROM transaction_hold_decision d JOIN "transaction" t ON t.id = d.transaction_id
 WHERE d.transaction_id = :'transaction_id';
```

Saga متوقف‌شده خودکار از سر گرفته نمی‌شود و Workflow با همان `workflowId` دوباره آغاز نمی‌شود (`docs/24`، D-053). سفارش را به مالک محصول ارجاع بده، و سفارشی که پیش از این نسخه `FUNDS_HELD` شده و با `SETTLEMENT_EXHAUSTED` ایستاده را نیز.

## ۴. Holdهای دیگران

Hold سازمانی دیگر که نام این تراکنش را می‌برد با این تصمیم جابه‌جا نمی‌شود و هیچ تسویه یا بازپرداختی آن را برنمی‌دارد. آن را جداگانه به مالک محصول ارجاع بده.

## ۵. استقرار و بازگشت

- **ترتیب:** economic-service پیش از marketplace-service (ADR-040). اگر رعایت نشود سفارشی از دست نمی‌رود: marketplace تازه تا `GET /v1/transactions/capabilities` بله نگوید هیچ Saga تازه‌ای آغاز نمی‌کند (`rasta_marketplace_saga_start_deliveries_total` با `economic_not_ready`، و صف شروع Saga بالا می‌رود)، و Sagaی در جریان که `HELD` بی فیلد `heldProven` می‌بیند با `ECONOMIC_HELD_PROOF_UNAVAILABLE` منتظر می‌ماند. هر دو پس از ارتقای economic خودکار ادامه می‌دهند، و سفارش `CANCELLING` بی Saga هم تا آن زمان منتظر می‌ماند. هشدار صف شروع Saga (`rasta-marketplace-alerts`) همین حالت را هم نشان می‌دهد. `heldProven: false` پاسخ است و همچنان Saga را متوقف می‌کند.
- **بازگشت:** به ترتیب marketplace-service، سپس economic-service، سپس `down.sql`. تا وقتی تصمیمی ثبت شده باشد `down.sql` رد می‌کند، چون تنها سابقهٔ آن تصمیم است.
- **بازگشت ‏`20261106130000_transaction_funded_hold`:** تا وقتی ردیفی `held_at` دارد و Hold خودش را ندارد، `down.sql` رد می‌کند و چیزی را تغییر نمی‌دهد (FU-182): پس از اجرای دوبارهٔ Migration چنین ردیفی مانند تعهدی خوانده می‌شود که هرگز ادعای Escrow نکرده است و از موجودی قابل‌مصرف پرداخت می‌شود. به‌جای بازگشت، رو به جلو اصلاح کن.
