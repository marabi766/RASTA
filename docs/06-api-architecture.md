# ۰۶ — API Architecture

> API-First. قرارداد پیش از پیاده‌سازی نوشته می‌شود، و پیاده‌سازی در برابر قرارداد تست می‌شود.

---

## ۶٫۱ اصول

| اصل                    | معنا                                                                            |
| ---------------------- | ------------------------------------------------------------------------------- |
| **Contract First**     | OpenAPI پیش از کد؛ Schemaها از `@rasta/contracts` می‌آیند                       |
| **Uniform**            | همه سرویس‌ها یک قرارداد دارند: صفحه‌بندی، خطا، فیلتر، Header                    |
| **Closed by Default**  | هر Endpoint نیازمند احراز هویت است مگر با `@Public()` صریح و مستند              |
| **Explicit Versioning**| نسخه در مسیر (`/v1/...`)؛ تغییر شکننده = نسخه جدید                              |
| **Idempotent Writes**  | هر عمل غیر ایمن با اثر جانبی، `Idempotency-Key` می‌پذیرد                        |
| **Traceable**          | هر پاسخ `X-Correlation-Id` و `X-Trace-Id` برمی‌گرداند                           |

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

| Header             | الزام            | شرح                                                            |
| ------------------ | ---------------- | -------------------------------------------------------------- |
| `Authorization`    | اجباری           | `Bearer <JWT>`                                                 |
| `X-Correlation-Id` | اختیاری          | اگر نیاید، Gateway ULID تولید می‌کند                           |
| `X-Organization-Id`| شرطی             | برای کاربر چندعضویتی، انتخاب مستأجر فعال؛ **در برابر عضویت اعتبارسنجی می‌شود** |
| `Idempotency-Key`  | اجباری برای بعضی | روی `POST` مالی و عملیات ایجادکننده اثر بیرونی                  |
| `If-Match`         | اختیاری          | ETag برای قفل خوش‌بینانه در `PATCH`                            |
| `Accept-Language`  | اختیاری          | `fa-IR` (پیش‌فرض) یا `en`                                      |

**CONSTRAINT.** `X-Organization-Id` **هرگز** بدون بررسی پذیرفته نمی‌شود. Gateway بررسی
می‌کند کاربر عضویت فعال در آن سازمان دارد، وگرنه `TENANT_MISMATCH` (۴۰۳).
این نقطه دقیقاً همان جایی است که یک اشتباه به Tenant Escape تبدیل می‌شود.

### پاسخ

| Header                  | همیشه | شرح                                        |
| ----------------------- | ----- | ------------------------------------------ |
| `X-Correlation-Id`      | ✅    | همان مقدار درخواست                         |
| `X-Trace-Id`            | ✅    | Trace ID استاندارد W3C                     |
| `X-RateLimit-Limit/Remaining/Reset` | ✅ | وضعیت محدودیت نرخ                  |
| `ETag`                  | روی GET منبع منفرد | برای `If-Match`                 |
| `Retry-After`           | روی ۴۲۹ و ۵۰۳ | ثانیه                              |
| Secure Headers          | ✅    | `Strict-Transport-Security`، `X-Content-Type-Options: nosniff`، `X-Frame-Options: DENY`، `Content-Security-Policy`، `Referrer-Policy` |

---

## ۶٫۴ Versioning

| نوع تغییر                                        | شکننده؟ | اقدام                          |
| ------------------------------------------------ | ------- | ------------------------------ |
| افزودن فیلد اختیاری به پاسخ                      | ❌      | همان نسخه                      |
| افزودن Endpoint جدید                             | ❌      | همان نسخه                      |
| افزودن پارامتر Query اختیاری                     | ❌      | همان نسخه                      |
| افزودن مقدار جدید به Enum                        | ⚠️      | همان نسخه، **اما** کلاینت باید مقدار ناشناخته را تحمل کند — مستند شود |
| حذف یا تغییر نام فیلد                            | ✅      | نسخه جدید                      |
| اجباری کردن فیلد اختیاری                         | ✅      | نسخه جدید                      |
| تغییر معنای فیلد موجود                           | ✅      | نسخه جدید (**خطرناک‌ترین نوع**) |
| تغییر کد وضعیت یا کد خطا                         | ✅      | نسخه جدید                      |

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
  "details": [
    { "path": "items[0].quantity", "message": "باید بزرگ‌تر از صفر باشد", "code": "min" }
  ],
  "correlationId": "01JBQ8Z4K7M2N5P8R1T3V6X9Y2",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "timestamp": "2026-08-26T10:15:30.123Z",
  "path": "/v1/orders"
}
```

**قاعده.** کلاینت روی `code` شاخه می‌زند، نه روی `message` (بومی‌سازی‌شده و متغیر) و
نه صرفاً روی کد وضعیت HTTP (بیش از حد درشت).

فهرست کامل کدها: [`packages/contracts/src/common/errors.ts`](../packages/contracts/src/common/errors.ts)

| وضعیت | کدهای نمونه                                                       |
| ----- | ----------------------------------------------------------------- |
| 400   | `VALIDATION_FAILED` · `MALFORMED_REQUEST`                         |
| 401   | `UNAUTHENTICATED` · `TOKEN_EXPIRED` · `TOKEN_INVALID`             |
| 403   | `FORBIDDEN` · `INSUFFICIENT_ROLE` · **`TENANT_MISMATCH`**         |
| 404   | `NOT_FOUND`                                                       |
| 409   | `ALREADY_EXISTS` · `CONFLICT` · `IDEMPOTENCY_KEY_REUSED` · `INVALID_STATE_TRANSITION` · `OPTIMISTIC_LOCK_FAILED` |
| 422   | `BUSINESS_RULE_VIOLATION` · `INSUFFICIENT_BALANCE` · `LEDGER_UNBALANCED` |
| 429   | `RATE_LIMIT_EXCEEDED`                                             |
| 500   | `INTERNAL_ERROR`                                                  |
| 503   | `UPSTREAM_UNAVAILABLE`                                            |
| 504   | `UPSTREAM_TIMEOUT`                                                |

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

| حالت                                       | پاسخ                                            |
| ------------------------------------------ | ----------------------------------------------- |
| کلید جدید                                  | اجرا، ذخیره پاسخ، بازگشت ۲۰۱                    |
| کلید تکراری + همان بدنه                    | پاسخ ذخیره‌شده، **بدون اجرای دوباره**           |
| کلید تکراری + بدنه متفاوت                  | `409 IDEMPOTENCY_KEY_REUSED`                    |
| کلید در حال پردازش                         | `409 CONFLICT` + `Retry-After: 1`               |
| بدون کلید روی Endpoint اجباری              | `400 VALIDATION_FAILED`                         |

نگهداشت کلید: **۲۴ ساعت**. تطبیق بدنه با SHA-256 بدنه نرمال‌شده (کلیدهای مرتب، فضای خالی حذف).

---

## ۶٫۹ Rate Limiting

| محدوده                | حد پیش‌فرض        | پنجره  |
| --------------------- | ----------------- | ------ |
| به‌ازای کاربر         | ۳۰۰ درخواست       | ۱ دقیقه |
| به‌ازای مستأجر        | ۳٬۰۰۰ درخواست     | ۱ دقیقه |
| به‌ازای IP (ناشناس)   | ۶۰ درخواست        | ۱ دقیقه |
| ورود / بازیابی رمز    | ۵ تلاش            | ۱۵ دقیقه |
| آپلود سند             | ۲۰ فایل           | ۱ ساعت |
| جست‌وجو               | ۶۰ درخواست        | ۱ دقیقه |

الگوریتم: **Sliding Window** روی Redis. همه حدود **پیکربندی‌پذیر**اند.

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
```

**Fleet**

```
GET    /v1/assets/{id}/usage             تاریخچه کارکرد
POST   /v1/assets/{id}/usage             ثبت کارکرد
POST   /v1/assets/{id}/assignments       تخصیص راننده
DELETE /v1/assignments/{id}              پایان تخصیص
GET    /v1/fleet/availability            دارایی‌های آزاد
GET    /v1/fleet/utilization             نرخ بهره‌برداری
```

**Maintenance**

```
POST   /v1/maintenance-requests          ثبت درخواست/خرابی
GET    /v1/maintenance-requests/{id}     دریافت
POST   /v1/maintenance-requests/{id}/assign   ارجاع به تعمیرگاه
POST   /v1/repair-orders/{id}/parts      ثبت قطعات
POST   /v1/repair-orders/{id}/complete   اتمام تعمیر
POST   /v1/maintenance-requests/{id}/approve  تأیید کاربر (پیش‌نیاز تسویه)
GET    /v1/maintenance-schedules/due     سررسیدهای پیش رو
```

**Marketplace**

```
GET    /v1/products                      جست‌وجوی کالا
GET    /v1/products/{id}/offers          پیشنهادهای تأمین‌کنندگان
POST   /v1/orders                        ثبت سفارش   [Idempotency-Key]
GET    /v1/orders/{id}                   دریافت
POST   /v1/orders/{id}/fulfill           اعلام تحویل (تأمین‌کننده)
POST   /v1/orders/{id}/confirm-receipt   تأیید دریافت (کاربر) → آزادسازی تسویه
POST   /v1/orders/{id}/disputes          ثبت اعتراض
POST   /v1/orders/{id}/reviews           ارزیابی
```

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

**Economic**

```
GET    /v1/wallets/me                    کیف پول سازمان جاری
POST   /v1/wallets/{id}/top-up           شارژ   [Idempotency-Key]
POST   /v1/transactions                  ایجاد تراکنش   [Idempotency-Key]
GET    /v1/transactions/{id}             دریافت
GET    /v1/transactions                  فهرست (Cursor)
GET    /v1/ledger/accounts/{id}/entries  صورت‌حساب (Cursor)
GET    /v1/ledger/trial-balance          تراز آزمایشی
GET    /v1/commissions                   کارمزدهای دریافتی
GET    /v1/rewards/me                    امتیاز و سطح
```

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
Authorization: Bearer <internal-service-token>
X-Correlation-Id: <propagated>
X-Organization-Id: <propagated>
```

قواعد:

| قاعده                       | مقدار                                                   |
| --------------------------- | ------------------------------------------------------- |
| Timeout                     | ۳ ثانیه پیش‌فرض؛ ۱۰ ثانیه برای عملیات سنگین             |
| Retry                       | حداکثر ۲ بار، فقط روی خطای گذرا، با Exponential Backoff + Jitter |
| Circuit Breaker             | باز شدن پس از ۵ خطای متوالی؛ نیمه‌باز پس از ۳۰ ثانیه    |
| Fallback                    | Replica مرجع محلی، یا `UPSTREAM_UNAVAILABLE` صریح       |

**ناهمزمان (Kafka)** — پیش‌فرض. اگر ارتباطی می‌تواند رویداد باشد، رویداد است.

**CONSTRAINT.** فراخوانی REST همزمان **هرگز** در مسیر بحرانی یک عمل مالی قرار نمی‌گیرد.
تسویه با رویداد و Saga انجام می‌شود، نه با زنجیره فراخوانی همزمان.

---

## ۶٫۱۳ Health و آمادگی

| Endpoint          | معنا                                                    | استفاده                |
| ----------------- | ------------------------------------------------------- | ---------------------- |
| `GET /health/live`| فرایند زنده است                                          | Kubernetes Liveness    |
| `GET /health/ready`| وابستگی‌ها در دسترس‌اند (DB، Kafka، Redis)              | Kubernetes Readiness   |
| `GET /health/startup`| Migration اجرا شده و سرویس آماده است                 | Kubernetes Startup     |
| `GET /metrics`    | متریک Prometheus                                        | Prometheus             |
| `GET /version`    | نسخه، Commit SHA، زمان Build                            | تشخیص                  |

`/health/*` و `/metrics` عمومی‌اند اما **فقط از شبکه داخلی** در دسترس‌اند (NetworkPolicy)
و هیچ داده کسب‌وکاری فاش نمی‌کنند.
