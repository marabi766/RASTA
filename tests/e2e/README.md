# `@rasta/e2e` — سناریوهای End-to-End

> اجرا روی **Stack واقعی**. هیچ Mock، هیچ Stub، هیچ Skip.

---

## چه چیزی اینجا تست می‌شود

مسیر بحرانی دامنه اقتصادی، سرتاسر — از توکن واقعی Keycloak تا رویدادی که روی
Kafka منتشر می‌شود:

| فایل                       | سناریو                                                                     |
| -------------------------- | -------------------------------------------------------------------------- |
| `01-authenticated-context` | ورود، تشخیص سازمان فعال، رد کردن عضویت جعلی                                |
| `02-critical-path`         | کیف پول → شارژ شبیه‌سازی‌شده → تعهد + Hold → Replay → تأیید → تسویه → دفتر |
| `03-authorization`         | ۴۰۴ میان‌مستأجری، دید دو طرف تراکنش، و «`AUDITOR` هیچ دسترسی ندارد»        |
| `04-financial-safety`      | خرج بیش از موجودی، Idempotency، اعتراض، عدد بزرگ‌تر از `Number`            |
| `05-correlation`           | یک `correlationId` از HTTP تا Header و Envelope رویداد روی Kafka           |

`docs/14 § 14.7` ردیف‌های ۱، ۴، ۸ و ۹ — با نیمه Marketplace حذف‌شده، نه
شبیه‌سازی‌شده: قرارداد `ORDER_*` طبق ADR-032 موکول است و نوشتن Payload سرویسی که
هنوز وجود ندارد، اختراع قرارداد دیگری است (`AGENTS.md § ۹`).

---

## چرا API، نه Browser

`apps/web` و `apps/admin` پوشه‌های خالی‌اند. یک تست Browser باید صفحه‌ای را
Drive کند که وجود ندارد؛ ساختن صفحه‌ای برای تست، یعنی تستِ Fixture خودمان.

`APIRequestContext` همان Stack واقعی را می‌زند: Gateway (Routing، Rate Limit،
اجبار `Idempotency-Key`)، `economic-service` واقعی، PostgreSQL واقعی، Kafka
واقعی و توکن واقعی Keycloak.

**آماده برای Browser:** وقتی `apps/web` ساخته شد، یک Project دوم در
`playwright.config.ts` اضافه می‌شود (نمونه‌اش همان‌جا کامنت شده) و
`pnpm exec playwright install chromium` در CI. هیچ‌چیز در `src/` فرض نمی‌کند UI
وجود ندارد.

---

## پیش‌نیاز اجرا

```bash
pnpm infra:up                 # PostgreSQL، Kafka، Keycloak، Redis
pnpm db:migrate

pnpm --filter @rasta/economic-service build && \
  pnpm --filter @rasta/economic-service start     # :3112
pnpm --filter @rasta/api-gateway build && \
  pnpm --filter @rasta/api-gateway start          # :3000 (یا PORT_API_GATEWAY)

pnpm test:e2e
```

اگر پورت‌های محلی‌ات فرق دارد:

```bash
E2E_GATEWAY_URL=http://localhost:3010 \
KAFKA_BROKERS=localhost:19092 \
pnpm test:e2e
```

`global-setup.ts` پیش از هر سناریو، هر وابستگی را **مثبت** بررسی می‌کند و با
پیام قابل‌اقدام شکست می‌خورد. هیچ‌جا Skip نمی‌کند: یک مرحله E2E سبز که چیزی
اجرا نکرده، بدتر از یک مرحله قرمز است، چون به‌عنوان شاهد خوانده می‌شود.

---

## کاربران

از `infrastructure/docker/keycloak/rasta-realm.json` — رمز هم از همان‌جا خوانده
می‌شود، نه از این پوشه.

| کاربر              | سازمان              | نقش                  | برای چه                           |
| ------------------ | ------------------- | -------------------- | --------------------------------- |
| `dehyari.admin`    | `ORG-DEH-0001`      | `ORGANIZATION_ADMIN` | پرداخت‌کننده                      |
| `dehyari.admin.b`  | `ORG-DEH-0002`      | `ORGANIZATION_ADMIN` | دریافت‌کننده، و کاوش میان‌مستأجری |
| `union.admin`      | `ORG-UNION-YAZD`    | `UNION_ADMIN`        | تراز آزمایشی                      |
| `province.auditor` | `ORG-PROVINCE-YAZD` | `AUDITOR`            | باید همه‌جا ۴۰۳ بگیرد             |

`dehyari.admin.b` در همان Realm تعریف شده، اما Keycloak یک Realm را **فقط وقتی
Import می‌کند که از قبل وجود نداشته باشد**. برای همین `global-setup` اگر نبود
می‌سازدش و اگر ناقص بود ترمیمش می‌کند — تا لازم نباشد کسی برای اجرای تست،
Keycloak محلی‌اش را نابود کند.

---

## قواعدی که این Suite نگه می‌دارد

- **بدون `--pass-with-no-tests`.** Playwright به‌صورت پیش‌فرض روی «هیچ تستی پیدا
  نشد» شکست می‌خورد و همان پیش‌فرض عمداً دست‌نخورده مانده است.
- **بدون `sleep` ثابت** (`docs/14 § 14.7`) — انتظار همیشه روی یک شرط است.
- **بدون Retry.** سناریوی مالی‌ای که در تلاش دوم سبز می‌شود، یک Race پیدا کرده
  است؛ Retry آن یافته را به نویز تبدیل می‌کند.
- **یک Worker.** ادعاهای مانده کیف پول روی دو سازمان Seed هستند؛ اثبات همروندی
  جای خودش را دارد — `wallet-concurrency.int-spec.ts` با صد برداشت موازی.
- **مانده‌ها به‌صورت Delta** بررسی می‌شوند، پس Suite روی پایگاه داده‌ای که
  اجراهای قبلی را دارد هم تکرارپذیر است.
