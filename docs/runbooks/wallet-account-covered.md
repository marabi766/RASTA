# Runbook: حساب کیف پول یا Escrow که زیر صفر جمع می‌شود، و نگهبانی که فقط زیر READ COMMITTED قفل می‌گیرد (FU-228، FU-268)

**شدت:** 🔴 بحرانی وقتی Deploy رد شد (حسابی از پیش زیر صفر است: دفتر کل به صاحبش کمتر از هیچ بدهکار است)؛ 🟠 هشدار برای ردهای زمان اجرا (چیزی نوشته نشده است).
**سیگنال محرک:**

- Deploy ‏`20261108120000_wallet_account_covered_at_commit` با «N WALLET or ESCROW account(s) already sum below zero; refusing to guard a ledger that is already overdrawn, and changing nothing» شکست می‌خورد؛
- همان Deploy با `statement timeout` ‏(`57014`) روی دفتر کلی بزرگ شکست می‌خورد؛
- نوشتنی با `restrict_violation` ‏(`23001`) و متن «A guard that locks and then reads runs only under READ COMMITTED» رد می‌شود؛
- نوشتن دستی با «At commit, a wallet or escrow account never sums below zero» رد می‌شود (از راه سرویس: `422 INSUFFICIENT_BALANCE`).

**دامنه:** economic-service، همهٔ حساب‌های با `purpose` برابر `WALLET` یا `ESCROW`؛ بخش ۲ inventory-service را هم دربر می‌گیرد (حصار Return Dispatch).

---

## ناوردا

- **هنگام Commit، هیچ حساب `WALLET` یا `ESCROW` زیر صفر جمع نمی‌شود:** Σ(CREDIT − DEBIT) همهٔ Legهای حساب ≥ ۰. نگهبان آن
  `trg_ledger_entry_wallet_covered` است (Constraint Trigger، ‏`INITIALLY DEFERRED`، روی هر Leg ‏`DEBIT`). Projection ‏`wallet`
  و `ck_wallet_balances` فقط وقتی چیزی را می‌سنجند که بازنویسی شوند؛ این نگهبان خود دفتر کل را می‌پرسد، هر که بنویسد.
- **نگهبانی که قفل می‌گیرد و سپس می‌خواند فقط زیر READ COMMITTED کار می‌کند:** فقط READ COMMITTED برای هر دستور Snapshot تازه
  می‌گیرد و پس از انتظار، Commit نویسندهٔ دیگر را می‌بیند. REPEATABLE READ و SERIALIZABLE از Snapshot پیش از انتظار می‌خوانند و قفل
  چیزی را حفظ نمی‌کند. پس هر قفل Advisory از راه `read_committed_xact_lock` (یا شکل Shared و دوکلیدی آن) گرفته می‌شود که کلید تهی
  و هر سطح دیگر را رد می‌کند؛ Verifier ‏Migration هر تابعی را که خودش قفل Advisory بگیرد رد می‌کند (`advisoryLockGateScript`).
- **ترتیب قفل:** هر بررسی هنگام Commit همهٔ حساب‌هایی را که تراکنش Debit کرده، به ترتیب شناسه، پیش از جمع زدن قفل می‌کند؛ دو تراکنش
  با ترتیب نوشتن وارونه Deadlock نمی‌سازند. **یک بار برای هر حساب:** فقط آخرین Leg ‏Debit هر حساب در همان تراکنش جمع می‌زند
  (`wallet_account_debited_later`، از ستون‌های سیستمی `xmin` و `cmin`؛ هیچ تنظیم نشست جمعی را حذف نمی‌کند).

همهٔ آن‌ها با یک متن رد می‌شوند: «A guard that locks and then reads runs only under READ COMMITTED» (`23001`)؛ CONTEXT خطا نام
نگهبان را می‌گوید.

| نگهبان                                                         | Migration                                     |
| -------------------------------------------------------------- | --------------------------------------------- |
| `trg_ledger_entry_wallet_covered`                              | economic ‏`20261108120000`، ‏`20261109120000` |
| `trg_wallet_hold_funded_at_commit`                             | economic ‏`20261107120000`، ‏`20261109120000` |
| `trg_journal_hold_funding_final`                               | economic ‏`20261107120000`، ‏`20261109120000` |
| `trg_wallet_hold_reference_bound`                              | economic ‏`20261109120000`                    |
| `trg_transaction_id_unclaimed`                                 | economic ‏`20261109120000`                    |
| `trg_commission_rule_effective_dated` (هر نوشتن قاعدهٔ کارمزد) | economic ‏`20261109120000`                    |
| `commission_pricing_scope_lock`                                | economic ‏`20261109120000`                    |
| `tg_return_dispatch_withdrawal_guard`                          | inventory ‏`20261109120000`                   |
| `tg_return_shipment_dispatch_fence`                            | inventory ‏`20261109120000`                   |

**قاعده‌های کارمزد (#1016 r1 F1).** هر نوشتن قاعده (INSERT، COPY، شاخهٔ INSERT در ON CONFLICT، UPDATE و DELETE) در
`trg_commission_rule_effective_dated` با لحظه‌ای سنجیده می‌شود که پایگاه داده پس از گرفتن قفل دامنه در
`commission_rule_scope_decision` ثبت کرده است؛ هیچ نشستی آن را تعیین نمی‌کند و تنظیم `rasta.commission_rule_scope_<key>` دیگر
خوانده نمی‌شود. رد می‌شوند: قاعده‌ای که پیش از آن لحظه شروع شود («never in the past»)، حذف قاعده‌ای که شروع شده («never
deleted»)، تغییر وضعیت قاعدهٔ در حال اجرا، تغییر یا حذف یک تصمیم («never changed or removed») و TRUNCATE. همه `23001` هستند و
تراکنش برگشته است. قاعدهٔ نادرست را با `valid_to` پایان بده و قاعدهٔ تازه بساز.

---

## ۱. Deploy رد شد: حساب‌هایی که از پیش زیر صفر جمع می‌شوند

Migration چیزی نمی‌سازد و چیزی را اصلاح نمی‌کند: کدام Leg نادرست است تصمیم انسان است.

1. **فهرست**، با نقش migrator:

   ```bash
   cat <<'SQL' | node scripts/psql-prisma-url.mjs DATABASE_URL_ECONOMIC_MIGRATOR -X -v ON_ERROR_STOP=1 -f -
   SELECT e.account_id, a.purpose, a.organization_id,
          SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount_minor ELSE -e.amount_minor END) AS balance
     FROM ledger_entry e JOIN ledger_account a ON a.id = e.account_id
    WHERE a.purpose IN ('WALLET', 'ESCROW')
    GROUP BY e.account_id, a.purpose, a.organization_id
   HAVING SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount_minor ELSE -e.amount_minor END) < 0
    ORDER BY e.account_id;
   SQL
   ```

2. **اصلاح هر حساب با Journal**، هرگز با `UPDATE` یا `DELETE` (‏`trg_ledger_entry_immutable` هر دو را رد می‌کند؛ ADR-013).
   Journal نادرست را با Reversal برگردان، یا Journal اصلاحی متوازنی بنویس که کسری را از حساب درستِ طرف مقابل بپردازد. پیش از
   ادامه، همان فهرست بالا باید خالی باشد.
3. **علامت شکست را بردار و دوباره Deploy کن.** Prisma اجرای شکست‌خورده را در `_prisma_migrations` نگه می‌دارد:

   ```bash
   pnpm --dir services/economic-service exec node ../../scripts/prisma.mjs migrate resolve --rolled-back 20261108120000_wallet_account_covered_at_commit
   pnpm --dir services/economic-service db:migrate
   ```

4. **دفتر کل بزرگ (`statement timeout`):** پیش‌فرض بررسی پنج ثانیه است و شکست امن است (چیزی تغییر نکرده). همان گام ۳ با Timeout همان
   یک اجرا: `RASTA_MIGRATION_STATEMENT_TIMEOUT=15min pnpm --dir services/economic-service db:migrate` (docs/23، بخش Timeout ‏Migration).

## ۲. «… only under READ COMMITTED»

هیچ چیز نوشته نشده است: تراکنش برگشته است. نویسنده تراکنشش را زیر REPEATABLE READ یا SERIALIZABLE باز کرده، یا پیش‌فرض نقش یا
پایگاه داده تغییر کرده است.

1. سطح پیش‌فرض را ببین:

   ```bash
   cat <<'SQL' | node scripts/psql-prisma-url.mjs DATABASE_URL_ECONOMIC_MIGRATOR -X -v ON_ERROR_STOP=1 -f -
   SELECT r.rolname, d.datname, s.setconfig
     FROM pg_db_role_setting s
     LEFT JOIN pg_roles r ON r.oid = s.setrole
     LEFT JOIN pg_database d ON d.oid = s.setdatabase
    WHERE array_to_string(s.setconfig, ',') LIKE '%default_transaction_isolation%';
   SQL
   ```

2. اگر ردیفی هست، آن تنظیم را با `ALTER ROLE … RESET default_transaction_isolation` یا `ALTER DATABASE … RESET …` بردار. اگر نیست،
   کد یا اسکریپتی که نوشته سطح را صریح خواسته است: همان نوشتن را زیر READ COMMITTED تکرار کن. تکرار زیر همان سطح همیشه رد می‌شود.
   هیچ نوشتن سرویس زیر سطح دیگری اجرا نمی‌شود؛ تراکنش‌های REPEATABLE READ سرویس فقط می‌خوانند.

## ۳. Deadlock هنگام Commit ‏(`40P01`)

میان Debitهای کیف پول دیگر نباید رخ دهد: همه به ترتیب شناسه قفل می‌گیرند. اگر متن خطا `assert_wallet_account_covered` را نام
می‌برد، یا نشستی `rasta.wallet_covered_accounts` را بازنویسی کرده، یا پس از `SET CONSTRAINTS … IMMEDIATE` حسابی تازه Debit شده
است. تراکنش برگشته است و تکرارش امن است. این یادداشت فقط ترتیب قفل را تعیین می‌کند و هیچ بررسی‌ای را حذف نمی‌کند.

## بازگشت

`down.sql` ‏Migration ‏`20261109120000_guards_read_committed` (در هر دو سرویس) بدنه‌های پیشین را بایت به بایت برمی‌گرداند.
economic-service خودش دروازه را صدا می‌زند (`lockReadCommitted`)، پس **اول نسخهٔ سرویس را برگردان**، بعد
`down.sql` را اجرا کن؛ وگرنه نوشتن قاعده‌های پاداش، مشارکت و شناسایی تا بازگشت سرویس رد می‌شوند (بسته
شکست می‌خورد). پس از آن، نگهبان‌های فهرست‌شده دوباره بی‌دروازه قفل می‌گیرند و Verifier ‏Migration آن وضعیت را رد می‌کند.
