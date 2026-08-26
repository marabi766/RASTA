# ۱۵ — Repository Architecture

> Monorepo با pnpm workspaces + Turborepo. مرزهای وابستگی توسط ابزار **تحمیل** می‌شوند،
> نه با توافق شفاهی.

---

## ۱۵٫۱ چرا Monorepo

| نیاز                                                  | چرا Monorepo پاسخ می‌دهد                                    |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| قرارداد رویداد و API باید بین سرویس‌ها همگام بماند     | یک نسخه از `@rasta/contracts` برای همه؛ تغییر شکننده فوری دیده می‌شود |
| تغییر عرضی (افزودن یک Header به همه سرویس‌ها)         | یک PR به‌جای ۱۷ PR هماهنگ‌شده                                |
| تیم کوچک                                              | سربار مدیریت ۱۷ Repository توجیه ندارد                       |
| Refactor فرامرزی                                      | ابزار همه مصرف‌کنندگان را می‌بیند                            |

**معاوضه پذیرفته‌شده.** Monorepo وسوسه «فقط این یک تابع را از آنجا Import کن» را می‌سازد.
پاسخ ما ابزاری است، نه اخلاقی: قاعده ESLint، Import میان‌سرویسی را **خطا** می‌کند.
→ ADR-018

---

## ۱۵٫۲ ساختار

```
rasta/
│
├── apps/                          ← اپلیکیشن‌های کاربر
│   ├── web/                       Next.js — پورتال کاربر نهایی (PWA، RTL)
│   └── admin/                     Next.js — کنسول اپراتور پلتفرم
│
├── services/                      ← Microserviceها (NestJS)
│   ├── api-gateway/
│   ├── identity-service/
│   ├── organization-service/
│   ├── asset-service/
│   ├── fleet-service/
│   ├── maintenance-service/
│   ├── marketplace-service/
│   ├── procurement-service/
│   ├── supplier-service/
│   ├── inventory-service/
│   ├── construction-service/
│   ├── contract-service/
│   ├── economic-service/
│   ├── notification-service/
│   ├── document-service/
│   ├── audit-service/
│   └── analytics-service/
│
├── packages/                      ← بسته‌های مشترک — بدون Business Logic
│   ├── contracts/                 Envelope رویداد، کاتالوگ، Value Object، Error Model
│   ├── config/                    بارگذاری و اعتبارسنجی env
│   ├── logging/                   Logger ساخت‌یافته + Redaction + Correlation
│   ├── observability/             راه‌اندازی OpenTelemetry
│   ├── nest-common/               Guard، Filter، Interceptor، Tenant Context، Outbox، Kafka
│   └── testing/                   Factory، Testcontainers، Matcherها
│
├── infrastructure/
│   ├── docker/                    پیکربندی زیرساخت محلی
│   │   ├── postgres/              اسکریپت راه‌اندازی پایگاه داده و نقش‌ها
│   │   ├── kafka/                 ساخت Topicها
│   │   ├── keycloak/              Realm Import
│   │   ├── otel/ prometheus/ grafana/
│   └── k8s/
│       ├── charts/rasta/          Helm Chart
│       └── base/                  Manifestهای خام
│
├── tests/
│   └── e2e/                       سناریوهای Playwright
│
├── docs/                          ۲۴ سند مهندسی + ADR + Runbook
│
├── scripts/                       اسکریپت‌های توسعه
│
├── AGENTS.md                      قانون دائمی Repository
├── CLAUDE.md                      راهنمای عملیاتی
├── README.md
├── docker-compose.yml
├── turbo.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── eslint.config.mjs
└── package.json
```

---

## ۱۵٫۳ ساختار داخلی هر سرویس

```
services/asset-service/
├── src/
│   ├── main.ts                    Bootstrap، OTel، Graceful Shutdown
│   ├── app.module.ts
│   │
│   ├── asset/                     ماژول دامنه
│   │   ├── asset.controller.ts        فقط HTTP ↔ DTO
│   │   ├── asset.service.ts           منطق دامنه و Invariantها
│   │   ├── asset.repository.ts        دسترسی داده، Scope مستأجر اجباری
│   │   ├── asset.module.ts
│   │   ├── dto/                       Zod Schema + نوع
│   │   ├── domain/                    Entity، Value Object، State Machine
│   │   ├── events/                    سازنده رویداد منتشرشده
│   │   └── __tests__/
│   │
│   ├── insurance/                 ماژول با مرز داخلی جدا
│   ├── timeline/                  Read Model از رویدادها
│   │
│   ├── consumers/                 مصرف‌کننده‌های Kafka
│   ├── health/
│   └── config/                    Schema پیکربندی سرویس
│
├── prisma/
│   ├── schema.prisma              **فقط مدل‌های این سرویس**
│   ├── migrations/
│   └── seed.ts
│
├── test/                          Fixture و راه‌اندازی تست
├── Dockerfile
├── jest.config.js
├── eslint.config.mjs
├── tsconfig.json
└── package.json
```

**تفکیک مسئولیت درون سرویس:**

| لایه         | مسئولیت                                       | چه چیزی آنجا نیست                    |
| ------------ | --------------------------------------------- | ------------------------------------- |
| Controller   | HTTP، اعتبارسنجی DTO، کد وضعیت                | **هیچ منطق کسب‌وکاری**                |
| Service      | قواعد دامنه، Invariantها، هماهنگی             | SQL خام، جزئیات HTTP                  |
| Repository   | دسترسی داده، **Scope مستأجر اجباری**          | تصمیم کسب‌وکاری                       |
| Domain       | Entity، Value Object، State Machine           | I/O                                   |
| Consumer     | مصرف رویداد، Idempotency                      | منطق پیچیده (به Service واگذار می‌شود) |

---

## ۱۵٫۴ بسته‌های مشترک — قاعده سخت

### چه چیزی مجاز است

| بسته                 | محتوای مجاز                                                        |
| -------------------- | ------------------------------------------------------------------ |
| `@rasta/contracts`   | Envelope رویداد · نام و Schema رویداد · Value Object (Money، ID) · Error Code · Schema صفحه‌بندی |
| `@rasta/config`      | بارگذاری env · اعتبارسنجی Schema · پیکربندی مشترک زیرساخت          |
| `@rasta/logging`     | ساخت Logger · Redaction · انتشار Correlation                        |
| `@rasta/observability`| راه‌اندازی OTel SDK · Helper ساخت Span                             |
| `@rasta/nest-common` | Guard (JWT، Role، Tenant) · Filter (خطا) · Interceptor (Correlation، Logging) · `RequestContext` · Repository پایه با Scope · Outbox Relay · Wrapper تولید/مصرف Kafka · ماژول Health |
| `@rasta/testing`     | Factory · Helper Testcontainers · Matcher سفارشی · Builder توکن تست |

### چه چیزی ممنوع است

```
🚫 قواعد کسب‌وکاری («چطور کارمزد محاسبه می‌شود»، «چه زمانی سرویس سررسید است»)
🚫 موجودیت یا Aggregate دامنه
🚫 Repository یا Schema پایگاه داده متعلق به یک سرویس
🚫 هر چیزی که فقط یک مصرف‌کننده دارد  → داخل همان سرویس باشد
🚫 وابستگی به سرویس‌ها  (بسته‌ها هرگز به سرویس‌ها Import نمی‌کنند)
```

**آزمون تصمیم.** پیش از افزودن چیزی به `packages/`، این سه سؤال:

1. آیا **دو یا بیشتر** سرویس واقعاً همین را نیاز دارند؟ (نه «شاید بعداً»)
2. آیا این یک **قرارداد** است یا یک **تصمیم کسب‌وکاری**؟ قرارداد بله، تصمیم نه.
3. آیا تغییر آن، همه مصرف‌کنندگان را همزمان به استقرار مجبور می‌کند؟ اگر بله، فکر دوباره.

اگر پاسخ‌ها روشن نیست، **تکرار کد در دو سرویس بهتر از یک وابستگی مشترک اشتباه است.**
تکرار ارزان است؛ جفت‌شدگی نادرست گران.

### چرا این‌قدر سخت‌گیرانه

اگر منطق محاسبه کارمزد در `packages/` بنشیند، آنگاه `marketplace` و `economic` به یک
پیاده‌سازی مشترک قفل می‌شوند. تغییر آن یعنی استقرار همزمان هر دو — یعنی همان جفت‌شدگی که
Microservices قرار بود از بین ببرد، فقط این بار پنهان در `node_modules`.

---

## ۱۵٫۵ گراف وابستگی

```
apps/web ─────────────┐
apps/admin ───────────┤
                      ├──► @rasta/contracts   (فقط Type و Schema)
services/* ───────────┤
                      ├──► @rasta/config
                      ├──► @rasta/logging
                      ├──► @rasta/observability
                      ├──► @rasta/nest-common  (فقط سرویس‌ها)
                      └──► @rasta/testing      (فقط devDependency)

@rasta/nest-common ──► @rasta/contracts، @rasta/logging، @rasta/config
@rasta/logging     ──► @rasta/config
@rasta/contracts   ──► (بدون وابستگی داخلی — برگ گراف)
```

**قواعد تحمیل‌شده:**

```
✅ سرویس → بسته
✅ بسته → بسته (بدون دور)
🚫 سرویس → سرویس        ← خطای ESLint
🚫 بسته → سرویس         ← خطای ESLint
🚫 اپ → سرویس           ← خطای ESLint
🚫 هر دور وابستگی
```

پیاده‌سازی در [`eslint.config.mjs`](../eslint.config.mjs):

```js
'no-restricted-imports': ['error', {
  patterns: [{
    group: ['**/services/*/src/**'],
    message: 'Cross-service imports are forbidden. Use REST or Kafka events.',
  }],
}]
```

---

## ۱۵٫۶ Turborepo

```jsonc
{
  "tasks": {
    "build":     { "dependsOn": ["^build"], "outputs": ["dist/**", ".next/**"] },
    "typecheck": { "dependsOn": ["^build", "db:generate"] },
    "test":      { "dependsOn": ["^build", "db:generate"], "outputs": ["coverage/**"] },
    "dev":       { "cache": false, "persistent": true }
  }
}
```

`^build` یعنی «اول وابستگی‌ها را Build کن». Turborepo گراف را می‌فهمد و:

- فقط بسته‌های تغییرکرده و وابستگان آن‌ها را دوباره Build می‌کند
- کارهای مستقل را موازی اجرا می‌کند
- خروجی را Cache می‌کند (محلی و در CI)

```bash
turbo run build --filter=@rasta/asset-service...   # سرویس + وابستگی‌هایش
turbo run test --filter=...[origin/main]           # فقط آنچه تغییر کرده
```

---

## ۱۵٫۷ قراردادهای نام‌گذاری

| مورد               | قرارداد                    | مثال                          |
| ------------------ | -------------------------- | ----------------------------- |
| بسته Workspace     | `@rasta/<name>`            | `@rasta/asset-service`        |
| پوشه سرویس         | `<domain>-service`         | `asset-service`               |
| فایل               | `kebab-case.<role>.ts`     | `asset.repository.ts`         |
| فایل تست           | `<name>.spec.ts`           | `asset.service.spec.ts`       |
| تست E2E            | `<name>.e2e-spec.ts`       | `order-flow.e2e-spec.ts`      |
| ماژول Nest         | `<name>.module.ts`         | `insurance.module.ts`         |
| Migration          | Timestamp + شرح            | `20260826_add_asset_status`   |

---

## ۱۵٫۸ افزودن سرویس جدید — Checklist

```bash
mkdir -p services/<name>-service/{src,prisma,test}
```

- [ ] `package.json` با نام `@rasta/<name>-service` و Scriptهای استاندارد
- [ ] `tsconfig.json` که `../../tsconfig.base.json` را Extend می‌کند
- [ ] `eslint.config.mjs` که Config ریشه را Re-export می‌کند
- [ ] `jest.config.js`
- [ ] `Dockerfile` (کپی از الگو)
- [ ] `prisma/schema.prisma` با **فقط** مدل‌های این سرویس
- [ ] پایگاه داده و نقش در `infrastructure/docker/postgres/00-init-databases.sh`
- [ ] Topic در `infrastructure/docker/kafka/create-topics.sh`
- [ ] `DATABASE_URL_<NAME>` و `PORT_<NAME>` در `.env.example`
- [ ] سرویس در `docs/04-service-decomposition.md`
- [ ] رویدادها در `docs/events/catalog.md`
- [ ] ورودی در جدول Service Map در `CLAUDE.md`
- [ ] ماژول Health، ماژول Outbox، مصرف‌کننده Kafka
- [ ] **تست Tenant Isolation** پیش از نخستین Endpoint
- [ ] Helm: افزودن به فهرست `values.yaml`

---

## ۱۵٫۹ فایل‌های ریشه

| فایل                 | نقش                                                       |
| -------------------- | --------------------------------------------------------- |
| `AGENTS.md`          | **قانون دائمی** — قواعد الزام‌آور معماری، امنیت، Git، DoD |
| `CLAUDE.md`          | راهنمای عملیاتی — دستورها، نقشه سرویس‌ها، مرجع سریع        |
| `README.md`          | راه‌اندازی، معماری در یک نگاه، وضعیت پروژه                |
| `docker-compose.yml` | زیرساخت محلی با پروفایل                                    |
| `turbo.json`         | گراف وظایف و Cache                                         |
| `tsconfig.base.json` | پیکربندی سخت‌گیرانه TypeScript برای همه                    |
| `eslint.config.mjs`  | قواعد Lint، شامل **تحمیل مرز وابستگی**                     |
| `.env.example`       | **تنها فایل محیطی در Repository** — فقط مقادیر یک‌بارمصرف  |
| `.prettierrc.json`   | قالب‌بندی                                                  |
| `.swcrc`             | ترجمه سریع برای Jest                                       |
