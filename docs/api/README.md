# قراردادهای API

> معماری و قواعد در [`../06-api-architecture.md`](../06-api-architecture.md).

## فایل‌های OpenAPI

هر سرویس مشخصات OpenAPI خودش را تولید می‌کند و فایل تولیدشده **در Repository Commit
می‌شود**. CI بررسی می‌کند فایل Commit‌شده با کد همگام است — **انحراف = شکست Build**.

```
docs/api/
├── api-gateway.openapi.json      (تجمیع همه)
├── identity-service.openapi.json
├── organization-service.openapi.json
├── asset-service.openapi.json
└── ...
```

**چرا Commit می‌شوند؟** تا تغییر شکننده در Diff یک PR دیده شود، نه پس از استقرار در Production.

## تولید

```bash
pnpm --filter @rasta/asset-service openapi:generate     # یک سرویس
pnpm openapi:generate                                    # همه
pnpm openapi:check                                       # بررسی همگامی (در CI)
```

## مرور تعاملی

| محیط             | آدرس                           |
| ---------------- | ------------------------------ |
| Gateway (تجمیعی) | http://localhost:3000/docs     |
| هر سرویس         | `http://localhost:<port>/docs` |

Swagger UI **فقط در محیط‌های غیر Production** فعال است.

## منبع Schema

همه Schemaها از Zod در `@rasta/contracts` می‌آیند و با `nestjs-zod` به OpenAPI تبدیل
می‌شوند. **یک تعریف، چهار مصرف:**

```
Zod Schema ──┬──► اعتبارسنجی زمان اجرا (Backend)
             ├──► نوع TypeScript (Backend + Frontend)
             ├──► مستند OpenAPI
             └──► اعتبارسنجی فرم (Frontend)
```

اگر فرم Frontend و API واگرا شوند، Build می‌شکند.

## قواعد تغییر

| تغییر                       | شکننده؟ | اقدام                                             |
| --------------------------- | ------- | ------------------------------------------------- |
| افزودن فیلد اختیاری به پاسخ | ❌      | همان نسخه                                         |
| افزودن Endpoint             | ❌      | همان نسخه                                         |
| افزودن مقدار Enum           | ⚠️      | همان نسخه؛ کلاینت باید مقدار ناشناخته را تحمل کند |
| حذف یا تغییر نام فیلد       | ✅      | نسخه جدید                                         |
| اجباری کردن فیلد اختیاری    | ✅      | نسخه جدید                                         |
| **تغییر معنای فیلد**        | ✅      | نسخه جدید — **خطرناک‌ترین نوع**                   |

نسخه `n-1` حداقل **۶ ماه** پس از انتشار `n` پشتیبانی می‌شود.
منسوخ‌سازی با Header `Deprecation` و `Sunset` (RFC 8594).

## قرارداد مشترک همه سرویس‌ها

| مورد                       | مرجع                                                           |
| -------------------------- | -------------------------------------------------------------- |
| Header درخواست و پاسخ      | [`../06-api-architecture.md § ۶٫۳`](../06-api-architecture.md) |
| صفحه‌بندی (Cursor پیش‌فرض) | § ۶٫۵                                                          |
| فیلتر و مرتب‌سازی          | § ۶٫۶                                                          |
| مدل خطا و کدها             | § ۶٫۷ · `packages/contracts/src/common/errors.ts`              |
| Idempotency                | § ۶٫۸                                                          |
| Rate Limiting              | § ۶٫۹                                                          |
