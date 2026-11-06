# Runbook: تصمیم دربارهٔ تراکنشی که روی Hold دیگران ایستاده است (FU-138)

**شدت:** 🟠 هشدار — پولی گم نشده، ولی تا تصمیم گرفته نشود این تراکنش تسویه نمی‌شود و سفارشش در `FUNDS_HELD` ثبت نمی‌شود.
**سیگنال محرک:** WARNING ـِ Migration ‏`20261105120000_settlement_creation_proof` («stand on a decision read from a hold not their own»)؛
Saga سفارش با `OBLIGATION_NOT_HELD`، وضعیت `HELD` و `funds UNPROVEN`؛ تسویهٔ ردشده با `409 INVALID_STATE_TRANSITION` و متن
«until an operator has decided its hold record»؛ Saga با `SETTLEMENT_EXHAUSTED` روی چنین تراکنشی.
**دامنه:** ردیف‌های `transaction_hold_reconciliation` با هر نتیجه‌ای جز `RESTORED_TO_PENDING_SETTLEMENT` که هنوز تصمیمی ندارند.
**ابزار:** `decide_transaction_hold(id, decision, reason)` فقط با نقش migrator؛ نقش runtime سرویس نه EXECUTE دارد و نه می‌تواند ردیف تصمیم بنویسد.

---

## چرا

نسخه‌های پیشین هر Holdی را که نام تراکنش را می‌برد Hold همان تراکنش می‌شمردند. پس تراکنشی می‌تواند جایی ایستاده باشد که Hold سازمانی
دیگر آن را نشانده است. Migration یادشده این ردیف‌ها را فهرست کرد و تا این Runbook کسی آن فهرست را نمی‌خواند. اکنون
(Migration ‏`20261106120000_transaction_hold_decision`) هر ردیفِ تصمیم‌نگرفته:

- برای API اثبات Hold نیست: `heldProven` برابر `false` است و Saga سفارش آن را نمی‌پذیرد و `ORDER_FUNDS_HELD` منتشر نمی‌کند.
- هیچ مجوز تسویه‌ای ندارد، حتی با `settlement_authorised_at` پر: نه سرویس تسویه می‌کند و نه پایگاه داده آزادسازی Hold یا رفتن به `SETTLED` را می‌پذیرد.
- **بازپرداخت باز می‌ماند:** بازپرداخت فقط Hold خود پرداخت‌کننده را به خودش برمی‌گرداند، پس معمولاً بی‌تصمیم هم راه خروج هست. تعهد صورت‌وضعیت (`STATEMENT`) بازپرداخت نمی‌پذیرد.

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

ردیف `HELD` بی Hold خود که در این فهرست نیست تصمیم نمی‌پذیرد: `heldProven` برابر `false` است و راهش بازپرداخت از راه سرویس است.

## ۲. تصمیم

| وضعیت و نتیجه                                                                                     | چه چیزی را بررسی کن             | تصمیم                                                               | اثر                                                                                                                    |
| ------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `HELD`، بی Hold فعال خود                                                                          | پولی در Escrow نیست             | `VOIDED`                                                            | به `PENDING_SETTLEMENT` می‌رود، بی Journal و بی جابه‌جایی پول                                                          |
| `HELD_UNPROVEN` یا `RETURNED_TO_HELD_UNPROVEN` که با مجوز یا اعتراض از `HELD` رفته و هنوز باز است | همان بررسی بالا                 | `CONFIRMED` فقط با Hold فعال خود با همان مبلغ و ارز؛ وگرنه `VOIDED` | وضعیت عوض نمی‌شود؛ تسویه دوباره باز می‌شود                                                                             |
| `HELD`، Hold فعال خود با همان مبلغ و ارز                                                          | منشأ آن Hold را اثبات کن        | `CONFIRMED`                                                         | `heldProven` برابر `true` می‌شود                                                                                       |
| `HELD`، Hold فعال خود با مبلغ دیگر                                                                | —                               | هر دو رد می‌شوند                                                    | بازپرداخت از راه سرویس، سپس `CONFIRMED` برای بستن پرونده. با ارز دیگر، بازپرداخت هم رد می‌شود: به مالک محصول ارجاع بده |
| `AUTHORISED_UNRECORDED_UNPROVEN`                                                                  | مجوز قدیمی واقعاً داده شده بود؟ | `CONFIRMED` یا `VOIDED`                                             | `CONFIRMED`: مجوز ثبت‌شده دوباره می‌شمارد. `VOIDED`: برای همیشه نمی‌شمارد و با Hold فعال خود، بازپرداخت راه خروج است   |
| `DISPUTE_RESOLVED_UNPROVEN`                                                                       | تصمیم پیشین درست بود؟           | `CONFIRMED` یا `VOIDED`                                             | گذشته را برنمی‌گرداند؛ ولی تسویهٔ ردیف باز را دوباره باز می‌کند                                                        |

**هشدار:** پس از ثبت هر تصمیم، ردیف مانند هر ردیف دیگری رفتار می‌کند، همان‌طور که ردیف `RESTORED_TO_PENDING_SETTLEMENT`: بی Hold خود، تسویه از موجودی قابل‌مصرف پرداخت‌کننده برداشت می‌کند (ADR-032). پس ردیفی را که نباید تسویه شود **پیش از** تصمیم بازپرداخت کن، نه پس از آن: میان این دو، Saga یا شخصی می‌تواند تسویه کند.

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

- **ترتیب:** economic-service پیش از marketplace-service (ADR-040). marketplace تازه روی economic قدیمی فیلد `heldProven` را نمی‌بیند و هر `HELD` را اثبات‌نشده می‌خواند، پس Saga سفارش‌های تازه با `OBLIGATION_NOT_HELD` می‌ایستد.
- **بازگشت:** به ترتیب marketplace-service، سپس economic-service، سپس `down.sql`. economic قدیمی زیر marketplace تازه هر Hold واقعی را هم اثبات‌نشده می‌خواند. تا وقتی تصمیمی ثبت شده باشد `down.sql` رد می‌کند، چون تنها سابقهٔ آن تصمیم است.
