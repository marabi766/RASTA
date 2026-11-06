# کلید یکتای متن انسانی (FU-084)

> **محرک:** ندارد — یک بار، **پیش از** استقرار مهاجرت‌های
> `identity-service/20261104120000_canonical_login_keys` و
> `organization-service/20261104120000_canonical_external_code`.
> **شدت:** ⚪ عملیاتی.

## چه چیزی تغییر می‌کند

نمایهٔ یکتا دیگر بایت‌ها را مقایسه نمی‌کند، بلکه **کلید متعارف** را:

| سرویس        | ستون                     | صورت مجاز                                               | کلید                                     |
| ------------ | ------------------------ | ------------------------------------------------------- | ---------------------------------------- |
| identity     | `user.username`، `email` | فقط ASCII چاپ‌پذیر (`ck_user_login_printable_ascii`)    | `user_login_key` — تبدیل A–Z به a–z      |
| organization | `external_code`          | `organization_text_is_canonical` (ASCII و الفبای فارسی) | `organization_text_key` — بدون نیم‌فاصله |

مهاجرت **بسته شکست می‌خورد**: اگر مقدار ذخیره‌شده‌ای بیرون از صورت مجاز باشد یا دو مقدار یک
کلید داشته باشند، مهاجرت متوقف می‌شود و هیچ‌چیز تغییر نمی‌کند. تصمیم دربارهٔ آن ردیف‌ها با انسان است.

## پرس‌وجوی پیش از استقرار (فقط خواندنی)

identity (`rasta_identity`):

```sql
SELECT id FROM "user" WHERE username !~ '^[!-~]+$' OR email !~ '^[!-~]+$';
SELECT translate(username, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') AS k, array_agg(id)
  FROM "user" GROUP BY 1 HAVING count(*) > 1;
SELECT translate(email, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') AS k, array_agg(id)
  FROM "user" GROUP BY 1 HAVING count(*) > 1;
```

organization (`rasta_organization`) — همان عبارت‌های `organization_text_is_canonical` مهاجرت:

```sql
SELECT id FROM organization
 WHERE external_code IS NOT NULL
   AND (char_length(external_code) > 64
        OR external_code !~ U&'^[\0020-\007E\00AB\00BB\060C\061B\061F\066A\0621-\063A\0641\0642\0644-\0648\067E\0686\0698\06A9\06AF\06CC\0654\200C]+$'
        OR external_code ~ U&'^[\0020\200C]|[\0020\200C]$|[\0020\200C]{2}'
        OR external_code ~ U&'(^|[^\0647])\0654'
        OR external_code ~ U&'(^|[^\0621-\063A\0641\0642\0644-\0648\067E\0686\0698\06A9\06AF\06CC\0654])\200C|\200C($|[^\0621-\063A\0641\0642\0644-\0648\067E\0686\0698\06A9\06AF\06CC])');
SELECT replace(external_code, U&'\200C', '') AS k, array_agg(id)
  FROM organization WHERE external_code IS NOT NULL GROUP BY 1 HAVING count(*) > 1;
```

هر پنج پرس‌وجو باید **صفر ردیف** بدهند. اگر ردیفی آمد، مالک داده تصمیم می‌گیرد کدام حساب یا
کد درست است؛ اصلاح دستی پیش از استقرار و ثبت در Audit انجام می‌شود. این Runbook هیچ ردیفی را
خودکار ادغام یا حذف نمی‌کند.

## بازگشت

`down.sql` هر دو مهاجرت فقط رد کردن را متوقف می‌کند و همیشه امن است؛ organization نمایهٔ بایتی
`organization_external_code_key` را بازمی‌گرداند.
