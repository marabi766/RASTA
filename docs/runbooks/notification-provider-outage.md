# Runbook: تحویل اعلان ایمیلی شکست خورد

**شدت:** 🟠 هشدار
**هشدار محرک:** `RastaNotificationDeliveryDead` در
[`infrastructure/docker/prometheus/rules/rasta-notification-alerts.yml`](../../infrastructure/docker/prometheus/rules/rasta-notification-alerts.yml)
**زمان پاسخ هدف:** ۳۰ دقیقه

```promql
# RastaNotificationDeliveryDead — بدون `for`؛ Label: error_class
sum by (error_class) (increase(rasta_notification_mail_dead_total[5m])) > 0
```

---

## این هشدار دقیقاً چه می‌گوید

**یک پیام برای همیشه رها شد.** هر شکست دیگری در این سرویس دوباره تلاش می‌شود؛ نردبان تلاش شش پله دارد — بی‌درنگ، یک ثانیه،
پنج ثانیه، سی ثانیه، دو دقیقه، ده دقیقه — و `DEAD` یعنی هر شش پله مصرف شد. کسی که حق داشت باخبر شود، نشد، و هیچ‌چیز دیگر
تلاش نمی‌کند.

**این هشدار عمداً نمی‌گوید چه کسی و کدام اعلان.** نه نشانی، نه شناسهٔ کاربر، نه متن پیام: یک Label ساخته‌شده از این‌ها،
Cardinality بی‌کران می‌سازد و دادهٔ شخصی را به هر Scrape می‌رساند (`docs/13` § ۱۳٫۳). آن اطلاعات در ردیف
`notification_delivery` است، جایی که مجوزدهی دارد.

**نیمهٔ درون‌برنامه‌ای هنوز سر جایش است.** یک تحویل ایمیلی مرده به‌معنای اعلان ازدست‌رفته نیست: همان Intent یک ردیف
`IN_APP` هم ساخته و آن ردیف تحویل شده. آنچه از دست رفته، رساندن پیام به کسی است که به سامانه سر نمی‌زند.

---

## اول این را ببین

```sql
-- کلاس شکست، در بازهٔ اخیر. بدون نشانی و بدون متن.
SELECT "last_error_class", count(*)
  FROM "notification_delivery"
 WHERE "channel" = 'EMAIL' AND "status" = 'DEAD'
   AND "updated_at" > now() - interval '1 hour'
 GROUP BY 1 ORDER BY 2 DESC;
```

| `error_class`           | معنا                | معمولاً یعنی                                                 |
| ----------------------- | ------------------- | ------------------------------------------------------------ |
| `CONNECTION_FAILED`     | Socket باز نشد      | سرور ایمیل بالا نیست، یا شبکه/Firewall جلویش را گرفته        |
| `TIMEOUT`               | باز شد و جواب نداد  | سرور کند است یا زیر فشار                                     |
| `AUTHENTICATION_FAILED` | ۵۳۵/۵۳۰             | Credential عوض شده یا منقضی شده                              |
| `RATE_LIMITED`          | ۴۲۱/۴۵۰/۴۵۱/۴۵۲     | نرخ خروجی از سقف ارائه‌دهنده گذشته                           |
| `RECIPIENT_REJECTED`    | ۵۵۰/۵۵۱/۵۵۳         | نشانه وجود ندارد — دادهٔ identity کهنه است، نه خرابی سرویس   |
| `RENDER_FAILED`         | قالب پر نشد         | یک متغیر الزامی در `context_data` نبود — اشکال قاعده یا قالب |
| `TEMPLATE_MISSING`      | نسخهٔ قالب پیدا نشد | `(templateKey, version)` روی این محیط Seed نشده              |

`RECIPIENT_REJECTED` و `RENDER_FAILED` **دائمی‌اند**: همان نخستین تلاش تمامشان می‌کند و نردبان مصرف نمی‌شود. اگر این دو
را می‌بینی، مشکل از سرور ایمیل نیست.

---

## اگر سرور ایمیل مشکل دارد

۱. سلامت کانال را از خود سرویس بپرس — Probe آمادگی گزارشش می‌دهد و **هرگز** آمادگی را قرمز نمی‌کند:

```bash
curl -s http://localhost:3113/health/ready | jq .mailChannel
```

۲. در محیط توسعه، سرور آزمایشی ممکن است بالا نباشد. Mailpit پشت Profile ابزارهاست و با `pnpm infra:up` بالا نمی‌آید:

```bash
docker compose --profile tools up -d mailpit
```

۳. صف را ببین. عمق صف به‌تنهایی خرابی نیست؛ **کهنگی** صف هست:

```sql
SELECT count(*) AS "queued",
       min("next_attempt_at") AS "oldest_due"
  FROM "notification_delivery"
 WHERE "channel" = 'EMAIL' AND "status" IN ('QUEUED', 'SENDING');
```

---

## آنچه نباید بکنی

- **ردیف `DEAD` را دستی به `QUEUED` برنگردان.** جدول `delivery_attempt` فقط‌الحاقی است و `ck_delivery_dead_exhausted`
  می‌گوید `DEAD` یعنی تلاش‌ها واقعاً مصرف شده‌اند. بازگرداندن دستی، سابقه را با واقعیت ناسازگار می‌کند. اگر پیام باید دوباره
  برود، رویداد منبع را دوباره منتشر کن؛ Deduplication معنایی تصمیم می‌گیرد که همان پنجره است یا پنجرهٔ تازه.
- **`NOTIFICATION_MAIL_ADAPTER` را عوض نکن تا «موقتاً کار کند».** تنها مقدار پذیرفته `smtp` است و هر مقدار دیگر Boot را رد
  می‌کند؛ این عمدی است (`Q-37`).
- **فرستنده را به یک دامنهٔ واقعی تغییر نده.** پیش‌فرض یک نشانی `.invalid` است که هرگز Resolve نمی‌شود، و نیمهٔ تدارکاتی
  `Q-37` — انتخاب ارائه‌دهنده و هویت فرستنده — هنوز پاسخ نگرفته است.

---

## وقتی رفع شد

صف خودش تخلیه می‌شود: ردیف‌های `QUEUED` با `next_attempt_at` گذشته در نخستین Tick بعدی برداشته می‌شوند. ردیف‌های `DEAD`
برنمی‌گردند — همین است که «مرده» یعنی.

هیچ اقدام دستی دیگری لازم نیست، و اگر شمارندهٔ `rasta_notification_mail_dead_total` دیگر بالا نرود، هشدار پس از پنج دقیقه
خودش خاموش می‌شود.
