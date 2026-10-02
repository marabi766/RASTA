# ۰۶ — API Architecture

> API-First. قرارداد پیش از پیاده‌سازی نوشته می‌شود، و پیاده‌سازی در برابر قرارداد تست می‌شود.

---

## ۶٫۱ اصول

| اصل                     | معنا                                                               |
| ----------------------- | ------------------------------------------------------------------ |
| **Contract First**      | OpenAPI پیش از کد؛ Schemaها از `@rasta/contracts` می‌آیند          |
| **Uniform**             | همه سرویس‌ها یک قرارداد دارند: صفحه‌بندی، خطا، فیلتر، Header       |
| **Closed by Default**   | هر Endpoint نیازمند احراز هویت است مگر با `@Public()` صریح و مستند |
| **Explicit Versioning** | نسخه در مسیر (`/v1/...`)؛ تغییر شکننده = نسخه جدید                 |
| **Idempotent Writes**   | هر عمل غیر ایمن با اثر جانبی، `Idempotency-Key` می‌پذیرد           |
| **Traceable**           | هر پاسخ `X-Correlation-Id` و `X-Trace-Id` برمی‌گرداند              |

---

## ۶٫۲ توپولوژی

```
Client (web/admin/PWA)
   │  HTTPS + Bearer JWT
   ▼
API Gateway  :3000     ◄── تنها نقطه ورود بیرونی
   │  • اعتبارسنجی JWT با JWKS
   │  • حل activeOrganizationId از عضویت
   │  • RBAC سطح مسیر
   │  • Rate Limit (به‌ازای مستأجر و به‌ازای کاربر)
   │  • CORS · Secure Headers
   │  • تولید/انتشار Correlation ID
   │  • Cache پاسخ Idempotency
   │  • Circuit Breaker
   ▼
Domain Services  :31xx    ◄── فقط از شبکه داخلی؛ NetworkPolicy می‌بندد
   • توکن داخلی سرویس‌به‌سرویس را اعتبارسنجی می‌کنند
   • هرگز مستقیم از اینترنت در دسترس نیستند
```

**مسیر عمومی:** `https://api.rasta.example/v1/assets`
**مسیر داخلی:** `http://asset-service:3103/internal/v1/assets` (نیازمند توکن داخلی)

---

## ۶٫۳ قرارداد Header

### درخواست

| Header              | الزام            | شرح                                                                                                            |
| ------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------- |
| `Authorization`     | اجباری           | `Bearer <JWT>`                                                                                                 |
| `X-Correlation-Id`  | اختیاری          | اگر نیاید، Gateway ULID تولید می‌کند                                                                           |
| `X-Organization-Id` | شرطی             | برای کاربر چندعضویتی، انتخاب مستأجر فعال؛ **در برابر عضویت اعتبارسنجی می‌شود**                                 |
| `Idempotency-Key`   | اجباری برای بعضی | روی `POST` مالی و عملیات ایجادکننده اثر بیرونی؛ اختیاری و رعایت‌شده روی `POST /v1/maintenance-requests` (#157) |
| `If-Match`          | اختیاری          | ETag برای قفل خوش‌بینانه در `PATCH`                                                                            |
| `Accept-Language`   | اختیاری          | `fa-IR` (پیش‌فرض) یا `en`                                                                                      |

**`Idempotency-Key` روی `POST /v1/maintenance-requests`** ([#157](https://github.com/marabi766/RASTA/issues/157)): اختیاری؛
اگر بیاید، maintenance-service رعایتش می‌کند — همان کلید و همان بدنه از همان کاربر، `201` اصلی را بازپخش می‌کند و کار را
دوباره ثبت نمی‌کند (حتی اگر درخواست اول از آن پس بسته شده باشد)، بدنهٔ دیگر یا کاربر دیگر `409 IDEMPOTENCY_KEY_REUSED`، و
درخواست هم‌زمان با همان کلید تا ۵ ثانیه منتظر می‌ماند و همان `201` را می‌گیرد — اگر درخواست اول بیش از این طول بکشد،
تکراری `409 CONFLICT` با `Retry-After: 1` می‌گیرد (نه خطای فرم: پورتال آن را «در حال پردازش است، کمی بعد دوباره ببینید»
نشان می‌دهد و همان ارسال را پس از انتظار دوباره پیشنهاد می‌کند، که پاسخ درخواست اول را می‌گیرد). بررسی Claim، ثبت درخواست،
Outbox و ذخیرهٔ پاسخ **یک تراکنش‌اند** (دور ۱ بازبینی #171): ایجادی که Claim آن منقضی و دوباره گرفته شده، چیزی Commit
نمی‌کند، و شکست ذخیرهٔ پاسخ چیزی نیمه‌کاره نمی‌گذارد. کلیدها مال مستأجرند (همان کلید در دو سازمان، دو درخواست) و
`MAINTENANCE_IDEMPOTENCY_TTL_HOURS` (پیش‌فرض ۲۴) از لحظهٔ پاسخ نگه داشته می‌شوند. بی کلید، رفتار پیشین.

**CONSTRAINT.** `X-Organization-Id` **هرگز** بدون بررسی پذیرفته نمی‌شود، و این
روی هر دو مسیر صادق است:

- **توکن کاربر** — Gateway و سرویس بررسی می‌کنند کاربر عضویت فعال در آن سازمان
  دارد، وگرنه `TENANT_MISMATCH` (۴۰۳) — ADR-011.
- **توکن سرویس** — Header باید با Claim امضاشده `org_id` برابر باشد، وگرنه
  `SERVICE_TENANT_CONTEXT_INVALID` (۴۰۳) — ADR-035، § ۶٫۱۲.

این نقطه دقیقاً همان جایی است که یک اشتباه به Tenant Escape تبدیل می‌شود.

### پاسخ

| Header                              | همیشه              | شرح                                                                                                                                     |
| ----------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `X-Correlation-Id`                  | ✅                 | همان مقدار درخواست                                                                                                                      |
| `X-Trace-Id`                        | ✅                 | Trace ID استاندارد W3C                                                                                                                  |
| `X-RateLimit-Limit/Remaining/Reset` | ✅                 | وضعیت محدودیت نرخ؛ در CORS در `exposedHeaders` است تا اسکریپت مرورگر بتواند آن را بخواند                                                |
| `ETag`                              | روی GET منبع منفرد | برای `If-Match`                                                                                                                         |
| `Retry-After`                       | روی ۴۲۹، ۴۰۹ و ۵۰۳ | ثانیه، عدد صحیح. ۴۲۹ از محدودیت نرخ Gateway (§ ۶٫۹)؛ ۴۰۹ فقط برای کلید در حال پردازش (§ ۶٫۸)؛ ۵۰۳ وقتی Circuit Breaker باز است (§ ۶٫۱۲) |
| Secure Headers                      | ✅                 | `Strict-Transport-Security`، `X-Content-Type-Options: nosniff`، `X-Frame-Options: DENY`، `Content-Security-Policy`، `Referrer-Policy`   |

---

## ۶٫۴ Versioning

| نوع تغییر                    | شکننده؟ | اقدام                                                                 |
| ---------------------------- | ------- | --------------------------------------------------------------------- |
| افزودن فیلد اختیاری به پاسخ  | ❌      | همان نسخه                                                             |
| افزودن Endpoint جدید         | ❌      | همان نسخه                                                             |
| افزودن پارامتر Query اختیاری | ❌      | همان نسخه                                                             |
| افزودن مقدار جدید به Enum    | ⚠️      | همان نسخه، **اما** کلاینت باید مقدار ناشناخته را تحمل کند — مستند شود |
| حذف یا تغییر نام فیلد        | ✅      | نسخه جدید                                                             |
| اجباری کردن فیلد اختیاری     | ✅      | نسخه جدید                                                             |
| تغییر معنای فیلد موجود       | ✅      | نسخه جدید (**خطرناک‌ترین نوع**)                                       |
| تغییر کد وضعیت یا کد خطا     | ✅      | نسخه جدید                                                             |

**سیاست پشتیبانی.** نسخه `n-1` حداقل **۶ ماه** پس از انتشار `n` پشتیبانی می‌شود.
منسوخ‌سازی با Header `Deprecation` و `Sunset` (RFC 8594) اعلام می‌شود.

---

## ۶٫۵ صفحه‌بندی

**پیش‌فرض: صفحه‌بندی مبتنی بر Cursor.**

```http
GET /v1/assets?limit=25&cursor=eyJpZCI6IkFTVF8wMUpCUTh...
```

```json
{
  "items": [ ... ],
  "nextCursor": "eyJpZCI6IkFTVF8wMUpCUTla...",
  "hasMore": true
}
```

**چرا Cursor و نه Offset؟** با Offset، اگر بین دو صفحه رکوردی درج یا حذف شود، ردیف‌ها
جا می‌افتند یا تکرار می‌شوند. برای فهرست ورودی‌های دفتر کل یا سوابق حسابرسی این پذیرفتنی نیست.

**استثنا: Offset فقط جایی که تعداد کل خودش هدف است** (جدول‌های مدیریتی، داشبورد):

```http
GET /v1/orders?page=2&pageSize=50
```

```json
{ "items": [...], "page": 2, "pageSize": 50, "totalItems": 1247, "totalPages": 25 }
```

`limit` پیش‌فرض ۲۵، حداکثر ۲۰۰. مقدار بالاتر → `VALIDATION_FAILED`، نه بریدن بی‌صدا.

---

## ۶٫۶ فیلتر و مرتب‌سازی

```http
GET /v1/assets
    ?status=ACTIVE,IDLE                 # چندمقداری با کاما
    &assetType=EXCAVATOR
    &createdAt[gte]=2026-01-01T00:00:00Z
    &createdAt[lt]=2026-07-01T00:00:00Z
    &q=گریدر                             # جست‌وجوی متن آزاد
    &sortBy=createdAt&sortDir=desc
```

عملگرها: `[eq] [ne] [gt] [gte] [lt] [lte] [in] [contains]`

**CONSTRAINT.** `sortBy` فقط فیلدهای **Index‌شده** را می‌پذیرد. فهرست مجاز به‌ازای هر
Endpoint در Schema اعلام می‌شود. مرتب‌سازی آزاد روی ستون بدون Index، یک بردار DoS است.

---

## ۶٫۷ مدل خطا

**یک شکل، در همه سرویس‌ها:**

```json
{
  "code": "VALIDATION_FAILED",
  "message": "درخواست معتبر نیست.",
  "details": [{ "path": "items[0].quantity", "message": "باید بزرگ‌تر از صفر باشد", "code": "min" }],
  "correlationId": "01JBQ8Z4K7M2N5P8R1T3V6X9Y2",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "timestamp": "2026-08-26T10:15:30.123Z",
  "path": "/v1/orders"
}
```

**قاعده.** کلاینت روی `code` شاخه می‌زند، نه روی `message` (بومی‌سازی‌شده و متغیر) و
نه صرفاً روی کد وضعیت HTTP (بیش از حد درشت).

**S-09 در پاسخ خطا.** `details` فقط واقعیت‌های Schema را دارد، نه ورودی کاربر (`ZodValidationPipe`، `toErrorDetails`):
پیام `invalid_enum_value` فقط گزینه‌های مجاز را می‌گوید (بی «received»)، `unrecognized_keys` فقط تعداد کلیدهای اضافه را، و
بخشی از `path` که کلاینت انتخاب کرده (کلید `z.record` یا `.catchall()`) `*` می‌شود. پیام نوشتهٔ Schema (`refine`،
`errorMap`، پیام Regex) باید متن ثابت باشد: **نویسندهٔ Schema هرگز مقدار ورودی را در پیام سفارشی نمی‌گذارد** — نه با
`refine((v) => ({ message: … }))`، نه با `ctx.data` در `errorMap`، نه با `addIssue` در `superRefine`. پشتیبان فقط تکرار مقدارِ زیر
مسیر همان Issue را، از سه نویسه به بالا، می‌گیرد و پیام را با پیام ثابت همان کد عوض می‌کند؛ مقدار میدان دیگر یا ورودی کوتاه‌تر را
نمی‌گیرد. پاسخ هر 5xx پیام عمومی است — پیام خطای ناشناخته، `HttpException` 5xx یا `RastaError` با وضعیت ۵۰۰ به بالا (وضعیت و
`code` می‌مانند) هرگز به کلاینت نمی‌رسد، مگر با انتخاب صریح `RastaError.internalClientSafe` برای جمله‌ای ثابت و بی‌ورودی که
کلاینت برای اقدام لازم دارد (مثلاً «امن است دوباره بفرستی»)؛ این انتخاب از پرچم خوانده می‌شود، هرگز از محتوای پیام — و آن پیام
فقط در Log
سرور، پاک‌سازی‌شده و حداکثر ۲۰۰ نویسه (`safeLogText`) ثبت می‌شود. درخواستی که Nest نتواند بخواند (بدنهٔ JSON نامعتبر، کدگذاری
درصدی نادرست در مسیر) `400 VALIDATION_FAILED` با متن ثابت می‌گیرد («The request body is not valid JSON» یا «The request could
not be read»)؛ متن Parser که بایت‌های کلاینت را نقل می‌کند نه به پاسخ می‌رسد نه به Log.

**`internalContext` چه می‌تواند داشته باشد.** این زمینه هرگز به کلاینت نمی‌رسد و برای تشخیص اپراتور در Log سرور است؛ پس
**شناسه و مبلغ** مجاز است — شناسهٔ رکورد و مستأجر، Endpoint، موجودی درخواستی و موجود کیف پول (`{walletId, requested,
available}`)، گذار وضعیت — اما **هرگز**: اعتبارنامه یا کلید (توکن، گذرواژه، `Idempotency-Key` یا هر چیز مشتق از آن)، **دادهٔ
شخصی** (نام، ایمیل، تلفن، کد ملی، نشانی) یا **متن آزاد کلاینت** (دلیل، یادداشت، بدنهٔ خام). چیزی آن را پاک‌سازی نمی‌کند؛
همان‌طور که نوشته شده ثبت می‌شود و مسئولیتش با نویسنده است (توضیح `RastaError.internalContext`).

**بدنه‌ای که سرویس نمی‌خواند.** بدنهٔ بزرگ‌تر از سقف (`entity.too.large` در body-parser) `413 PAYLOAD_TOO_LARGE` و
Charset یا Content-Encoding پشتیبانی‌نشده (`charset.unsupported`، `encoding.unsupported`) `415 UNSUPPORTED_MEDIA_TYPE`
می‌گیرد، هر دو با متن ثابت؛ پیام body-parser که مقدار فرستاده‌شده را نام می‌برد به پاسخ و Log نمی‌رسد.

فهرست کامل کدها: [`packages/contracts/src/common/errors.ts`](../packages/contracts/src/common/errors.ts)

| وضعیت | کدهای نمونه                                                                                                      |
| ----- | ---------------------------------------------------------------------------------------------------------------- |
| 400   | `VALIDATION_FAILED` · `MALFORMED_REQUEST`                                                                        |
| 413   | `PAYLOAD_TOO_LARGE`                                                                                              |
| 415   | `UNSUPPORTED_MEDIA_TYPE`                                                                                         |
| 401   | `UNAUTHENTICATED` · `TOKEN_EXPIRED` · `TOKEN_INVALID`                                                            |
| 403   | `FORBIDDEN` · `INSUFFICIENT_ROLE` · **`TENANT_MISMATCH`**                                                        |
| 404   | `NOT_FOUND`                                                                                                      |
| 409   | `ALREADY_EXISTS` · `CONFLICT` · `IDEMPOTENCY_KEY_REUSED` · `INVALID_STATE_TRANSITION` · `OPTIMISTIC_LOCK_FAILED` |
| 422   | `BUSINESS_RULE_VIOLATION` · `INSUFFICIENT_BALANCE` · `LEDGER_UNBALANCED`                                         |
| 429   | `RATE_LIMIT_EXCEEDED`                                                                                            |
| 500   | `INTERNAL_ERROR`                                                                                                 |
| 503   | `UPSTREAM_UNAVAILABLE`                                                                                           |
| 504   | `UPSTREAM_TIMEOUT`                                                                                               |

**CONSTRAINT.** پیام خطا هرگز شامل Stack Trace، نام جدول، بخشی از Query، یا داده مستأجر
دیگر نیست. `404` و `403` برای منبع متعلق به مستأجر دیگر **هر دو `404` برمی‌گردانند** —
تا وجود یا نبود منبع لو نرود.

---

## ۶٫۸ Idempotency

**اجباری روی:** ایجاد سفارش · تراکنش · شارژ کیف پول · تسویه · ثبت پیشنهاد · تأیید صورت‌وضعیت
· هر عملی با اثر مالی یا اثر بیرونی برگشت‌ناپذیر.

```http
POST /v1/orders
Idempotency-Key: 01JBQ8Z4K7M2N5P8R1T3V6X9Y2
```

| حالت                          | پاسخ                                  |
| ----------------------------- | ------------------------------------- |
| کلید جدید                     | اجرا، ذخیره پاسخ، بازگشت ۲۰۱          |
| کلید تکراری + همان بدنه       | پاسخ ذخیره‌شده، **بدون اجرای دوباره** |
| کلید تکراری + بدنه متفاوت     | `409 IDEMPOTENCY_KEY_REUSED`          |
| کلید در حال پردازش            | `409 CONFLICT` + `Retry-After: 1`     |
| بدون کلید روی Endpoint اجباری | `400 VALIDATION_FAILED`               |

نگهداشت کلید: **۲۴ ساعت**. تطبیق بدنه با SHA-256 بدنه نرمال‌شده (کلیدهای مرتب، فضای خالی حذف).

**`Retry-After` دقیقاً چه زمانی فرستاده می‌شود.** فقط روی ۴۰۹ کلید در حال پردازش
(`CONFLICT`)، با مقدار `1`، در economic، marketplace و construction؛ نه روی
`IDEMPOTENCY_KEY_REUSED`، چون صبر آن را حل نمی‌کند. مدت انتظار فقط Header است و
در بدنه خطا نمی‌آید. سرویس آن را با فیلد نوع‌دار `RastaError.retryAfterSeconds`
می‌گوید و `AllExceptionsFilter` فقط از همین فیلد Header می‌سازد: عدد صحیح (رو به
بالا گرد می‌شود)، محدود به ۱ تا ۳۶۰۰ ثانیه؛ مقداری که عدد متناهی نباشد اصلاً فرستاده
نمی‌شود. هیچ چیز از `internalContext` — که فقط در Log سرور می‌ماند (§ ۶٫۷) —
هرگز Header نمی‌شود. Gateway این Header را مانند بقیهٔ Headerهای پاسخ سرویس
عبور می‌دهد و در CORS در `exposedHeaders` است تا اسکریپت مرورگر بتواند آن را بخواند.

**شکست ثبت پاسخ، کلید را آزاد نمی‌کند.** کلید فقط وقتی آزاد می‌شود که خود کار
شکست بخورد. اگر کار Commit شده باشد و ثبت پاسخ پس از آن شکست بخورد، خطا به
فراخوان می‌رسد و کلید «در حال پردازش» می‌ماند: تکرار درخواست تا انقضای کلید
`409 CONFLICT` + `Retry-After` می‌گیرد، نه اجرای دوباره (economic و marketplace؛
construction پاسخ را در همان تراکنش دامنه ثبت می‌کند). در marketplace، یک کلید
در هر سازمان **حداکثر یک سفارش** می‌سازد (`uq_order_org_idempotency_key`)، حتی
پس از انقضا یا از دست رفتن رکورد کلید؛ سفارش دوم با همان کلید `409 CONFLICT`
است، بدون `Retry-After`، چون صبر آن را حل نمی‌کند.

**شناسهٔ منبع جزء هویت درخواست است.** کلید زیر الگوی مسیر ذخیره می‌شود
(`POST /v1/orders/:id/cancel`)، پس روی مسیری که بر یک منبع مشخص عمل می‌کند،
شناسهٔ آن منبع همراه بدنه هش می‌شود. همان کلید و همان بدنه روی منبعی دیگر
`409 IDEMPOTENCY_KEY_REUSED` است، نه بازپخش.

**بازپخش هیچ اثری جز بازگرداندن پاسخ ذخیره‌شده ندارد.** در بازپخش هیچ بررسی
مجوز یا گذار وضعیتی اجرا نمی‌شود، پس هر کاری که کنترلر پس از اجرا انجام
می‌دهد — مانند Signal به Saga — فقط وقتی انجام می‌شود که فرمان در همین
درخواست واقعاً اجرا شده باشد.

**پاسخ بازپخش‌شده پاسخ تاریخی است، نه وضعیت امروز.** همان کلید همان پاسخ را
می‌گیرد، و لایهٔ Idempotency عمداً وضعیت منبع را دوباره نمی‌خواند (تصمیم مدیر
پروژه، بازبینی دور ۲ #143). پس شارژ کیف پولی که `CAPTURED` شد و بازپرداختش سپس
ناتمام ماند، با همان کلید هنوز `CAPTURED` بازپخش می‌شود. وضعیت امروز را
`GET /v1/payment-intents/{id}` می‌گوید: `status` همراه `failureReason`، که یکی
از علامت‌های بازپرداخت ناتمام ADR-064 را نشان می‌دهد — `REFUND_REQUESTED`،
`REFUND_UNKNOWN`، `REFUNDED_NOT_REVERSED` یا `REFUND_DECLINED_RELEASE_PENDING`.
فراخوانی که باید بداند پول کجاست، Intent را می‌خواند، نه بازپخش را.

**بازپرداخت از کیف پول `FROZEN`** با `422 BUSINESS_RULE_VIOLATION` رد می‌شود، پیش از هر Hold یا فراخوانی Provider؛ از کیف
پول منجمد پولی بیرون نمی‌رود و Intent پس از فعال‌شدن دوبارهٔ کیف پول بازپرداخت‌پذیر می‌ماند (تصمیم مدیر پروژه، ADR-064).

---

## ۶٫۹ Rate Limiting

| محدوده              | حد پیش‌فرض    | پنجره    |
| ------------------- | ------------- | -------- |
| به‌ازای کاربر       | ۳۰۰ درخواست   | ۱ دقیقه  |
| به‌ازای مستأجر      | ۳٬۰۰۰ درخواست | ۱ دقیقه  |
| به‌ازای IP (ناشناس) | ۶۰ درخواست    | ۱ دقیقه  |
| ورود / بازیابی رمز  | ۵ تلاش        | ۱۵ دقیقه |
| آپلود سند           | ۲۰ فایل       | ۱ ساعت   |
| جست‌وجو             | ۶۰ درخواست    | ۱ دقیقه  |

الگوریتم: **Sliding Window** روی Redis. همه حدود **پیکربندی‌پذیر**اند.

**کلید حد ناشناس (L1-03).** حد «به‌ازای IP» روی نشانی واقعی کاربر می‌نشیند، نه نشانی Ingress. Gateway
`X-Forwarded-For` را فقط از Hopهایی می‌پذیرد که در `GATEWAY_TRUSTED_PROXIES` نام برده شده‌اند (نشانی، بازهٔ CIDR یا
`loopback`/`linklocal`/`uniquelocal`)؛ «اعتماد به همه»، شمارش Hop و بازهٔ `/0` (`0.0.0.0/0`، `::/0`) پذیرفته نمی‌شوند، چون
هر سه سرآیندی را باور می‌کنند که خودِ Client نوشته. پیش‌فرض خالی است — هیچ Hopی مورد اعتماد نیست. **این فهرست فقط نشانی‌های
Proxy است، هرگز بازه‌ای که Client هم در آن باشد:** هر نشانی درون فهرست می‌تواند نشانی Client را اعلام کند، پس Clientی که
نشانی خودش در بازهٔ مورد اعتماد بیفتد، سطل حد نرخ خودش را انتخاب می‌کند.

**مسیر متعارف (L1-04).** مسیری که Segment نقطه‌ای (`.`، `..` یا شکل کدشدهٔ آن‌ها مثل `%2e%2e`) یا Backslash دارد، **پیش از
انتخاب Route** با `400 VALIDATION_FAILED` رد می‌شود. دلیل: Gateway حد نرخ، فیلتر نقش و الزام `Idempotency-Key` را از Route
مسیر خام انتخاب می‌کند، ولی `fetch` هنگام ارسال Segmentهای نقطه‌ای را حذف می‌کند؛ بدون این بررسی
`/v1/users/../audit-corrections` با قواعد `users` سنجیده و به `audit-corrections` تحویل داده می‌شد.

**خطای ۵xx بالادست (L1-06).** پاسخ ۵xx‌ای که Envelope خطای پلتفرم نیست (صفحهٔ HTML، Stack Trace، JSON دلخواه یا بدنهٔ خالی)
به Client بازتابانده نمی‌شود؛ Gateway به‌جایش `503 UPSTREAM_UNAVAILABLE` می‌دهد و فقط وضعیت، نوع محتوا و طول بدنه را Log
می‌کند، نه خودِ بدنه را (S-09). Gateway همیشه با سریال‌سازی JSON خودش پاسخ می‌دهد، پس `Content-Type` بالادست منتقل نمی‌شود.

---

## ۶٫۱۰ الگوهای Endpoint

### قرارداد یکنواخت CRUD

```
GET    /v1/{resources}              فهرست (صفحه‌بندی، فیلتر، مرتب‌سازی)
POST   /v1/{resources}              ایجاد   → 201 + Location
GET    /v1/{resources}/{id}         دریافت  → 200 + ETag
PATCH  /v1/{resources}/{id}         به‌روزرسانی جزئی (If-Match)
DELETE /v1/{resources}/{id}         حذف نرم → 204
```

### عملیات دامنه‌ای — فعل صریح، نه CRUD تحمیلی

بعضی عملیات با CRUD مدل نمی‌شوند. آن‌ها منبع فرعی با نام فعل می‌گیرند:

```
POST /v1/assets/{id}/transfer
POST /v1/assets/{id}/decommission
POST /v1/maintenance-requests/{id}/approve
POST /v1/orders/{id}/confirm-receipt
POST /v1/tenders/{id}/publish
POST /v1/tenders/{id}/award
POST /v1/statements/{id}/approvals
POST /v1/wallets/{id}/top-up
```

**چرا؟** `PATCH /assets/{id}` با `{"status":"DECOMMISSIONED"}` قواعد گذار را پنهان می‌کند و
هیچ جایی برای «دلیل اسقاط» نمی‌گذارد. فعل صریح، State Machine را در API قابل مشاهده می‌کند.

### نمونه Endpointهای اصلی

**Asset**

```
GET    /v1/assets                        فهرست با فیلتر
POST   /v1/assets                        ثبت دارایی
GET    /v1/assets/{id}                   دریافت
PATCH  /v1/assets/{id}                   به‌روزرسانی
GET    /v1/assets/{id}/dossier           پرونده الکترونیکی کامل
GET    /v1/assets/{id}/timeline          تاریخچه رویدادها
POST   /v1/assets/{id}/transfer          انتقال مالکیت
POST   /v1/assets/{id}/decommission      اسقاط
POST   /v1/assets/{id}/insurance-policies ثبت بیمه‌نامه
GET    /v1/insurance-policies/expiring   بیمه‌های در آستانه انقضا

# ادعای خسارت پایه (docs/17 § ۱۷٫۲؛ مرز ADR-046) — پیاده‌شده زیر همان دارایی،
# نه زیر /v1/insurance/claims که برای insurance-service آینده رزرو است
GET    /v1/assets/{id}/insurance-claims                    ادعاهای خسارت دارایی
GET    /v1/assets/{id}/insurance-claims/{claimId}          پرونده و تاریخچه وضعیت
POST   /v1/assets/{id}/insurance-claims                    اعلام خسارت (SUBMITTED)
POST   /v1/assets/{id}/insurance-claims/{claimId}/review   شروع بررسی (UNDER_REVIEW)
POST   /v1/assets/{id}/insurance-claims/{claimId}/decision تصمیم صریح مرجع پیکربندی‌شده (Q-59)
POST   /v1/assets/{id}/insurance-claims/{claimId}/settlement ثبت تسویه‌ای که جای دیگر انجام شده
```

**ویرایش دارایی و نسخهٔ موردانتظار (`expectedVersion`).** `PATCH /v1/assets/{id}`
بدنه‌ای می‌پذیرد که فیلد **اجباری** `expectedVersion` دارد: همان `version` که خواندن
دارایی برگردانده است (فیلد تازهٔ پاسخ، عدد صحیح JSON و ≥ ۱؛ رشته، `true`، `null` و
صفر پذیرفته نیستند). بدنه‌ای که آن را نگوید `400 VALIDATION_FAILED` می‌گیرد و چیزی
نوشته نمی‌شود: فراخوانی که نمی‌داند ویرایشش بر کدام نسخه بنا شده، نمی‌داند چه چیزی را
بازنویسی می‌کند، و بی‌آن هر مشتری مستقیمِ API می‌توانست تغییر دیگری را بی‌صدا
برگرداند. به‌روزرسانی فقط روی همان نسخه اعمال می‌شود؛ اگر دارایی از آن زمان تغییر
کرده باشد پاسخ `409 OPTIMISTIC_LOCK_FAILED` است و **هیچ چیز نوشته نمی‌شود**
(مقایسه و نوشتن در یک عبارت `UPDATE … WHERE version = ?` انجام می‌شود، نه فقط پس از
خواندن، پس از رقابت میان خواندن و نوشتن هم بازنده چیزی نمی‌نویسد). فقط فیلدهایی
نوشته و در `ASSET_UPDATED.changedFields` گزارش می‌شوند که مقدارشان با مقدار
ذخیره‌شده فرق دارد؛ ویرایشی که چیزی را تغییر نمی‌دهد چیزی نمی‌نویسد، رویدادی منتشر
نمی‌کند و دارایی را همان‌طور که هست برمی‌گرداند (نسخهٔ کهنه حتی برای چنین ویرایشی
`409` است). دارایی سازمان دیگر، با هر نسخه‌ای که فرستاده شود، `404` است نه `403`.
این تغییر برای فراخوان‌های بی‌نسخه سازگار با گذشته نیست: تنها فراخوان درون‌مخزن
(پورتال) همیشه نسخه را می‌فرستد. این سازوکار Idempotency نیست (§ ۶٫۸): ثبت دارایی
هنوز کلید را ذخیره نمی‌کند و پیگیری آن جداگانه است.

**Fleet** — پیاده‌شده (`fleet-service`، پورت ۳۱۰۴)

```
POST   /v1/drivers                       ثبت راننده
GET    /v1/drivers                       فهرست راننده‌ها
GET    /v1/drivers/me                    رکورد راننده کاربر جاری (یا null)
GET    /v1/drivers/{id}                  دریافت
PATCH  /v1/drivers/{id}                  ویرایش
POST   /v1/drivers/{id}/status           تغییر وضعیت راننده
GET    /v1/drivers/{id}/assignments      تاریخچه تخصیص راننده

POST   /v1/assignments                   تخصیص راننده به دستگاه
GET    /v1/assignments                   فهرست (assetId، driverId، active، from/to)
GET    /v1/assignments/{id}              دریافت
POST   /v1/assignments/{id}/end          پایان تخصیص
DELETE /v1/assignments/{id}              مترادف پایان تخصیص

POST   /v1/usage-records                 ثبت کارکرد
GET    /v1/usage-records                 تاریخچه کارکرد (assetId، driverId، source، from/to)
GET    /v1/usage-records/{id}            دریافت

GET    /v1/fleet/availability            دارایی‌های آزاد، با مانع‌های نام‌دار
POST   /v1/fleet/availability            اعلام در دسترس/غیرقابل‌دسترس بودن
POST   /v1/fleet/availability/{id}/revoke  ابطال اعلام
GET    /v1/fleet/utilization             نرخ بهره‌برداری
```

**انحراف از طرح اولیه — ثبت‌شده در ADR-026.** نسخه پیشین این بخش مسیرهای
`/v1/assets/{id}/usage` و `/v1/assets/{id}/assignments` را نوشته بود. `api-gateway`
پیاده‌شده مسیر را از **نخستین قطعه مسیر** حل می‌کند (ADR-009: Gateway بدون دانش
دامنه)، پس هرچه زیر `assets/` باشد به `asset-service` می‌رود. منابع ناوگان به
Prefix های خودشان منتقل شدند و `assetId` یک **فیلد بدنه** است. این علاوه بر رفع
مسیریابی، صادقانه‌تر هم هست: تخصیص و کارکرد به ناوگان تعلق دارند، نه به دارایی.

**قواعد مشترک این سرویس:**

| مورد              | رفتار                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| احراز هویت        | همه Endpoint ها بسته‌اند. هیچ `@Public` ای جز Probe های سلامت وجود ندارد.                                                    |
| مجوز سطح Endpoint | نوشتن: `ORGANIZATION_ADMIN` · `FLEET_MANAGER` · `UNION_ADMIN`. ثبت کارکرد + `OPERATOR` · `DRIVER`.                           |
| مجوز سطح Object   | `DRIVER`/`OPERATOR` فقط رکورد خودشان و دستگاهی که واقعاً در دست دارند را می‌بینند (`src/fleet/access.ts`).                   |
| منبع دیگر تنانت   | **۴۰۴**، هرگز ۴۰۳ — تا وجود رکورد در سازمان دیگر فاش نشود.                                                                   |
| صفحه‌بندی         | Cursor برای هر فهرست؛ `nextCursor` را به‌عنوان `cursor` بفرستید.                                                             |
| Idempotency       | `POST /v1/usage-records` فیلد `clientReference` می‌پذیرد؛ ارسال دوباره همان رکورد را برمی‌گرداند و رویداد دوم منتشر نمی‌کند. |
| خطاها             | قرارداد خطای پلتفرم. تعارض انحصار → `422 BUSINESS_RULE_VIOLATION` با `rule` مشخص؛ گذار نامعتبر → `409`.                      |
| کمیت‌ها           | `hours`، `kilometres`، `hourMeter`، `odometer` **رشته**‌اند (ستون `NUMERIC`؛ همان استدلال ADR-022).                          |

**OpenAPI این سرویس Schema واقعی دارد.** پلتفرم با Zod در مرز اعتبارسنجی می‌کند
و `@nestjs/swagger` از Class های Decorate شده Schema می‌سازد — پس تا پیش از فاز
ناوگان، هر Endpoint نوشتنی با یک Summary و بدون Request Body منتشر می‌شد.
`services/fleet-service/src/openapi/` این شکاف را می‌بندد: JSON Schema را از
**همان** Schema هایی تولید می‌کند که سرویس با آن‌ها اعتبارسنجی می‌کند، پس سند
نمی‌تواند از رفتار واگرا شود. سایر سرویس‌ها هنوز این شکاف را دارند.

**Maintenance**

```
POST   /v1/maintenance-requests          ثبت درخواست/خرابی
GET    /v1/maintenance-requests/{id}     دریافت
POST   /v1/maintenance-requests/{id}/assign   ارجاع به تعمیرگاه
POST   /v1/repair-orders/{id}/parts      ثبت قطعات
POST   /v1/repair-orders/{id}/complete   اتمام تعمیر
                                          expectedTotalCostMinor برای کلاینت API اختیاری است و پورتال همیشه می‌فرستد؛
                                          اگر بیاید و با مجموع فعلی نخواند (قطعه یا هزینه‌ای در این میان
                                          ثبت شده) ۴۲۲ و کل تکمیل بدون هیچ تغییری برمی‌گردد
POST   /v1/maintenance-requests/{id}/approve  تأیید کاربر (پیش‌نیاز تسویه)
                                          expectedTotalCostMinor الزامی (۴۰۰ بدون آن)؛
                                          مبلغ نمایش‌داده‌شده باید با مجموع فعلی بخواند (۴۲۲ در غیر این صورت)
GET    /v1/maintenance-schedules/due     سررسیدهای پیش رو
```

**Marketplace** — پیاده‌شده (2026-08-30). `[K]` یعنی `Idempotency-Key` اجباری.

```
GET    /v1/products                          جست‌وجو (q, category, sort)
GET    /v1/products/{id}/offers              پیشنهادهای تأمین‌کنندگان
POST   /v1/products                          تعریف کالا
GET    /v1/offers                            عرضه‌های خودِ تأمین‌کننده
POST   /v1/offers                            انتشار عرضه
PATCH  /v1/offers/{id}                       تغییر قیمت/موجودی → نسخه +۱
POST   /v1/orders                        [K] ثبت سفارش — قیمت از سرور
GET    /v1/orders                            فهرست (role=BUYER|SUPPLIER)
GET    /v1/orders/{id}                       دریافت — هر دو طرف
POST   /v1/orders/{id}/confirm           [K] پذیرش (تأمین‌کننده)
POST   /v1/orders/{id}/fulfill           [K] اعلام تحویل (تأمین‌کننده)
POST   /v1/orders/{id}/confirm-receipt   [K] تأیید دریافت (خریدار) → مجوز تسویه
POST   /v1/orders/{id}/disputes          [K] ثبت اعتراض → توقف کامل تسویه
POST   /v1/orders/{id}/disputes/resolve  [K] تصمیم اپراتور پلتفرم
POST   /v1/orders/{id}/cancel            [K] لغو → جبران مالی
POST   /v1/orders/{id}/reviews           [K] ارزیابی — فقط پس از تکمیل
```

**سه نکته که در فهرست بالا پیدا نیست:**

- **بدنه `POST /v1/orders` هیچ فیلد قیمتی ندارد و `.strict()` است.** قیمتی که
  کلاینت بفرستد `400 VALIDATION_FAILED` می‌گیرد — نادیده گرفتنش بی‌صدا بود و به
  کلاینتی که فکر می‌کند قیمت می‌گذارد نمی‌گفت که نمی‌گذارد (ADR-037 § ۵).
- **`sort` مقدار `RATING` نمی‌پذیرد.** امتیاز تأمین‌کننده نزد `supplier-service`
  است که وجود ندارد؛ پذیرفتن و مرتب کردن بر چیز دیگر، دروغ گفتن درباره نتیجه
  است (ADR-042 § ۲).
- **مسیرهای گذار وضعیت `200` برمی‌گردانند، نه `201`.** پیش‌فرض Nest برای `POST`
  اینجا دو بار نادرست بود: چیزی ساخته نمی‌شود، و وضعیت ثبت‌شده برای بازپخش
  Idempotent هم `200` است — پس Retry با کدی متفاوت از فراخوان اول پاسخ می‌گرفت.
  فقط ثبت سفارش و ثبت ارزیابی `201`اند.

**Construction**

```
POST   /v1/projects                      ثبت نیاز/پروژه
POST   /v1/projects/{id}/approvals       درخواست موافقت
POST   /v1/approvals/{id}/decision       تصمیم مرجع تأیید
POST   /v1/projects/{id}/tenders         ایجاد مناقصه/استعلام
POST   /v1/tenders/{id}/publish          انتشار
POST   /v1/tenders/{id}/bids             ثبت پیشنهاد   [Idempotency-Key]
POST   /v1/tenders/{id}/evaluate         ارزیابی چندمعیاره
POST   /v1/tenders/{id}/award            انتخاب برنده
POST   /v1/projects/{id}/progress        گزارش پیشرفت
GET    /v1/projects/{id}/fleet-analysis  تحلیل ناوگان داخلی در برابر برون‌سپاری
```

**Economic** — پیاده‌شده (2026-08-29). `[K]` یعنی `Idempotency-Key` اجباری.

```
GET    /v1/wallets/provider                        ارائه‌دهنده پرداخت و اینکه شبیه‌سازی است
GET    /v1/wallets/me                              کیف پول سازمان جاری (در نخستین استفاده باز می‌شود)
GET    /v1/wallets/{id}                            یک کیف پول
GET    /v1/wallets/{id}/holds                      Holdهای امانت
POST   /v1/wallets/{id}/top-up                     شارژ — شبیه‌سازی‌شده   [K]

POST   /v1/transactions                            ثبت تعهد (اختیاری: Hold هم‌زمان)   [K]
GET    /v1/transactions                            فهرست (Cursor؛ includeIncoming برای نمای دریافت‌کننده)
GET    /v1/transactions/{id}                       دریافت
POST   /v1/transactions/{id}/authorise-settlement  تأیید دریافت   [K]
POST   /v1/transactions/{id}/dispute               ثبت اعتراض — توقف کامل تسویه   [K]
POST   /v1/transactions/{id}/resolve-dispute       رفع اختلاف (تصمیم انسانی)   [K]
POST   /v1/transactions/{id}/refund                بازگشت وجه به پرداخت‌کننده   [K]
POST   /v1/transactions/{id}/cancel                لغو پیش از هر حرکت   [K]

POST   /v1/settlements                             تسویه   [K]
GET    /v1/settlements                             فهرست (incoming برای نمای دریافت‌کننده)
GET    /v1/settlements/{id}                        دریافت

GET    /v1/ledger/accounts                         نمودار حساب‌های سازمان
GET    /v1/ledger/accounts/{id}/entries            صورت‌حساب (Cursor)
GET    /v1/ledger/journals/{id}                    یک Journal با همه خطوطش
POST   /v1/ledger/journals/{id}/reverse            معکوس کردن Journal بی‌مالک؛ Journal دارای مالک ← ۴۲۲ با نام عملیات اصلاح (L7-07، Q-76)   (SYSTEM_ADMIN/UNION_ADMIN)
GET    /v1/ledger/trial-balance                    تراز آزمایشی   (SYSTEM_ADMIN/UNION_ADMIN)

GET    /v1/commissions                             کارمزدهای اعمال‌شده
GET    /v1/commissions/rules                       قواعد قابل اعمال
POST   /v1/commissions/rules                       تعریف نرخ   (SYSTEM_ADMIN)
PATCH  /v1/commissions/rules/{id}                  اصلاح نرخ   (SYSTEM_ADMIN)

GET    /v1/rewards/me                              امتیاز، سطح و پاداش‌های اخیر
GET    /v1/rewards/rules                           قواعد قابل اعمال
POST   /v1/rewards/rules                           تعریف قاعده   (SYSTEM_ADMIN)
PATCH  /v1/rewards/rules/{id}                      اصلاح قاعده   (SYSTEM_ADMIN)

GET    /v1/payment-intents                         فهرست پرداخت‌ها
GET    /v1/payment-intents/{id}                    یک پرداخت
POST   /v1/payment-intents/{id}/refund             بازگشت شارژ — با Reversal   [K]
```

**قابلیت‌های هدف — PLANNED، نه API موجود**

مسیرهای زیر قرارداد جهت‌گیری محصول‌اند و تا زمان پیاده‌سازی نباید در Gateway یا OpenAPI
به‌عنوان Endpoint زنده منتشر شوند:

```
# Insurance — ADR-046
POST   /v1/insurance/quote-requests               درخواست استعلام
GET    /v1/insurance/quote-requests/{id}/offers   مقایسه پیشنهادها
POST   /v1/insurance/policies/{id}/renewals       درخواست تمدید
POST   /v1/insurance/claims                       اعلام خسارت
GET    /v1/insurance/claims/{id}                  پرونده و تاریخچه وضعیت
POST   /v1/insurance/claims/{id}/decisions        تصمیم صریح مرجع مجاز

# Participation and reward — ADR-047
GET    /v1/participation/me                       امتیاز، Breakdown و نسخه قاعده
GET    /v1/participation/me/ranking               جایگاه در گروه همتای مجاز
GET    /v1/reward-benefits                        مزایای مصوب قابل انتخاب
POST   /v1/reward-benefits/{id}/redeem        [K] انتخاب یا مصرف مزیت
POST   /v1/score-appeals                      [K] اعتراض به محاسبه مشخص
GET    /v1/score-appeals/{id}                     وضعیت اعتراض

# Reverse logistics — ADR-048
POST   /v1/orders/{id}/returns                [K] درخواست مرجوعی
POST   /v1/orders/{id}/warranty-claims        [K] ادعای ضمانت
GET    /v1/returns/{id}                           چرخه تجاری و فیزیکی
POST   /v1/returns/{id}/decisions             [K] پذیرش یا رد مرجع مجاز
POST   /v1/return-shipments                   [K] ایجاد حمل برگشت
POST   /v1/returns/{id}/inspections           [K] ثبت بازرسی و تعیین تکلیف
```

همهٔ مسیرهای نوشتنی به Tenant Scope، مجوز سطح Object، Audit و در صورت اثر تکرارپذیر به
`Idempotency-Key` نیاز دارند. نمایش مسیر برنامه‌ریزی‌شده به‌عنوان API موجود ممنوع است.

**سه نکته که از فهرست بالا پیدا نیست:**

- **هیچ Endpoint ی Journal دلخواه Post نمی‌کند.** یک Journal همیشه رکورد چیزی
  است که اتفاق افتاده؛ Endpoint ای که Journal دلخواه بپذیرد یعنی جابه‌جایی
  مانده بدون هیچ واقعیت کسب‌وکاری پشتش — همان چیزی که یک دفتر کل برای غیرممکن
  کردنش وجود دارد.
- **هیچ Endpoint ی حساب نمی‌سازد.** نمودار حساب‌ها از `AccountPurpose` مشتق
  می‌شود و در نخستین استفاده ساخته می‌شود.
- **نقش `AUDITOR` هیچ‌کدام از این‌ها را نمی‌بیند** — نه در جدول مسیریابی
  Gateway، نه در `@Roles` هیچ Controller ی، و `assertNotAuditor()` هم بار سوم
  ردش می‌کند. یک قاعده به این اندازه مهم نباید به درست ماندن یک فایل وابسته باشد.

---

## ۶٫۱۱ OpenAPI

- هر سرویس در توسعه Swagger UI را روی `/docs` سرو می‌کند.
- Gateway اسناد را در `/docs` تجمیع می‌کند.
- فایل‌های تولیدشده به `docs/api/{service}.openapi.json` نوشته و **Commit** می‌شوند.
- CI بررسی می‌کند فایل Commit‌شده با کد همگام است — انحراف = شکست Build.
- Schemaها با `nestjs-zod` از همان Zod Schemaهای `@rasta/contracts` تولید می‌شوند:
  یک تعریف، هم اعتبارسنجی زمان اجرا، هم نوع TypeScript، هم مستند OpenAPI.

---

## ۶٫۱۲ ارتباط سرویس‌به‌سرویس

**همزمان (REST)** — فقط وقتی پاسخ **همین حالا** برای تصمیم لازم است:

```
POST /internal/v1/...
X-Internal-Token: <signed service token>
X-Correlation-Id: <propagated>
X-Organization-Id: <optional; must MATCH the token's signed org_id>
```

**CONSTRAINT (ADR-035).** تنانت یک فراخوان سرویسی از Claim امضاشده `org_id`
داخل توکن می‌آید، **نه از Header**. Header می‌تواند بیاید و برای Log و
همبستگی مفید است، اما فقط اجازه دارد با امضا **موافقت** کند:

| حالت                                   | نتیجه                                    |
| -------------------------------------- | ---------------------------------------- |
| `org_id` امضاشده، بدون Header          | پذیرفته — تنانت از امضا                  |
| `org_id` امضاشده + Header هم‌خوان      | پذیرفته                                  |
| `org_id` امضاشده + Header ناهم‌خوان    | **`403 SERVICE_TENANT_CONTEXT_INVALID`** |
| بدون `org_id`، روی عملیات مستأجر-محدود | **`403 SERVICE_TENANT_CONTEXT_INVALID`** |
| بدون `org_id`، روی عملیات غیرمستأجری   | پذیرفته، مشروط به `@AllowService`        |

هیچ Fallback به Header وجود ندارد. توکن `RELAY` هرگز `@AllowService` را ارضا
نمی‌کند و `org_id` روی آن نادیده گرفته می‌شود.

قواعد:

| قاعده           | مقدار                                                            |
| --------------- | ---------------------------------------------------------------- |
| Timeout         | ۳ ثانیه پیش‌فرض؛ ۱۰ ثانیه برای عملیات سنگین                      |
| Retry           | حداکثر ۲ بار، فقط روی خطای گذرا، با Exponential Backoff + Jitter |
| Circuit Breaker | باز شدن پس از ۵ خطای متوالی؛ نیمه‌باز پس از ۳۰ ثانیه             |
| Fallback        | Replica مرجع محلی، یا `UPSTREAM_UNAVAILABLE` صریح                |

**`Retry-After` روی Circuit باز.** وقتی Circuit Breaker Gateway باز است، درخواست بدون
تماس با سرویس با `503 UPSTREAM_UNAVAILABLE` رد می‌شود و `Retry-After` مدت باقی‌ماندهٔ
باز بودن Circuit را می‌گوید: ثانیهٔ صحیح، رو به بالا گرد، محدود به ۱ تا ۳۶۰۰. مقدار از
فیلد نوع‌دار `RastaError.retryAfterSeconds` می‌آید، نه از `internalContext`.

**ناهمزمان (Kafka)** — پیش‌فرض. اگر ارتباطی می‌تواند رویداد باشد، رویداد است.

**CONSTRAINT.** فراخوانی REST همزمان **هرگز** در مسیر بحرانی یک عمل مالی قرار نمی‌گیرد.
تسویه با رویداد و Saga انجام می‌شود، نه با زنجیره فراخوانی همزمان.

---

## ۶٫۱۳ Health و آمادگی

| Endpoint              | معنا                                       | استفاده              |
| --------------------- | ------------------------------------------ | -------------------- |
| `GET /health/live`    | فرایند زنده است                            | Kubernetes Liveness  |
| `GET /health/ready`   | وابستگی‌ها در دسترس‌اند (DB، Kafka، Redis) | Kubernetes Readiness |
| `GET /health/startup` | Migration اجرا شده و سرویس آماده است       | Kubernetes Startup   |
| `GET /metrics`        | متریک Prometheus                           | Prometheus           |
| `GET /version`        | نسخه، Commit SHA، زمان Build               | تشخیص                |

`/health/*` و `/metrics` عمومی‌اند اما **فقط از شبکه داخلی** در دسترس‌اند (NetworkPolicy)
و هیچ داده کسب‌وکاری فاش نمی‌کنند.
