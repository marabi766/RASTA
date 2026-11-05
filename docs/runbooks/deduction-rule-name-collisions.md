# Runbook: برخورد نام ردیف کسر پیش از Migration `20261104210000` (FU-083)

**شدت:** ⚪ عملیاتی · **هشدار محرک:** ندارد — پیش از استقرار این Migration اجرا می‌شود.

نام‌هایی که فقط در بزرگی و کوچکی حروف، فاصله یا نیم‌فاصله فرق دارند یک نام‌اند. اگر دو ردیف در حال اجرا یا دو پیشنهاد CREATE در انتظار، در یک سازمان، چنین نامی داشته باشند، Migration بدون هیچ تغییری متوقف می‌شود. این پرس‌وجو را با `psql` روی پایگاه `rasta_contract` اجرا کن؛ هر سطر خروجی یک برخورد است و باید پیش از استقرار، با تصمیم یک نفر، از راه ردیف بازنشسته یا پیشنهاد پس‌گرفته‌شده برطرف شود:

```sql
SELECT organization_id, held, translate(name, U&'ABCDEFGHIJKLMNOPQRSTUVWXYZ\0020\200C', 'abcdefghijklmnopqrstuvwxyz') AS name_key, array_agg(id ORDER BY id) AS ids, array_agg(name ORDER BY id) AS names FROM (SELECT organization_id, id, name, 'in force' AS held FROM deduction_rule WHERE retired_at IS NULL UNION ALL SELECT organization_id, id, name, 'pending' FROM deduction_rule_change WHERE status = 'PENDING_APPROVAL' AND kind = 'CREATE') AS named GROUP BY 1, 2, 3 HAVING count(*) > 1;
```

اگر این پرس‌وجو روی `rasta_contract` با `relation "deduction_rule_change" does not exist` رد شد، Migration جدول‌های ردیف کسر (`20261104100000`) هنوز اجرا نشده و نامی برای برخورد نیست: Deploy را ادامه بده.

تا وقتی مسیری برای نوشتن در این جدول‌ها باز نشده، برطرف‌کردن برخورد یعنی SQL دستی با همان شرط‌های دونفره‌ی جدول‌ها؛ آن را با مالک داده تصمیم بگیر.

اگر Migration پیش از این کار اجرا و متوقف شده باشد، هیچ ردیف، تابع یا Indexی تغییر نکرده، اما Prisma با `P3009` هر Deploy بعدی را رد می‌کند. پیش از Resolve ثابت کن که تلاش ناموفق برگشته است: خروجی `SELECT pg_get_functiondef('deduction_rule_name_key(text)'::regprocedure);` باید هنوز `replace` را نشان دهد، نه `translate`. پس از برطرف‌کردن برخوردها، به‌عنوان مالک Migration و با Credential از env (`.env.migrator`، نه خط فرمان):

```bash
pnpm --dir services/contract-service exec node --env-file-if-exists=../../.env --env-file-if-exists=../../.env.migrator ../../scripts/prisma.mjs migrate resolve --rolled-back 20261104210000_deduction_rule_name_fold
pnpm --dir services/contract-service db:migrate
```
