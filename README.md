# رستا — Rasta Platform

> پلتفرم هوشمند مدیریت ناوگان، زنجیره تأمین، خدمات و عملیات عمرانی
> **Smart platform for fleet, supply chain, services and civil-works management**

[![CI](https://github.com/marabi766/RASTA/actions/workflows/ci.yml/badge.svg)](https://github.com/marabi766/RASTA/actions/workflows/ci.yml)
[![Node](https://img.shields.io/badge/node-%3E%3D22-green)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)](tsconfig.base.json)

---

## ۱. رستا چیست؟

رستا یک **پلتفرم اقتصادی چندمستأجری** است که چهار عملکرد را در یک زیرساخت واحد ادغام می‌کند:

| عملکرد                      | شرح                                                                |
| --------------------------- | ------------------------------------------------------------------ |
| **مدیریت ناوگان**           | پرونده الکترونیکی دارایی، کارکرد، نگهداری پیشگیرانه، تعمیرات، بیمه |
| **بازار و زنجیره تأمین**    | Marketplace تخصصی کالا و خدمات، تجمیع تقاضا، ارزیابی تأمین‌کننده   |
| **مناقصات و عملیات عمرانی** | «رستا عمران»: از ثبت نیاز تا مناقصه، قرارداد، صورت‌وضعیت و تسویه   |
| **موتور اقتصادی**           | کیف پول، دفتر کل دوطرفه، کارمزد، پاداش و Gamification              |

مدل ارتباطی پلتفرم **مستقیم** است: `اتحادیه ↔ پلتفرم ↔ کاربر نهایی` — بدون لایه واسطه اجباری.

مسیر مقیاس طراحی‌شده: **۳۲۸ دهیاری استان یزد → شهرداری‌ها → مقیاس ملی → Marketplace عمومی**،
بدون نیاز به بازطراحی بنیادین Core Platform.

> منبع کامل الزامات محصول: `01-طرح-جامع-پلتفرم-رستا.docx`
> مرجع تصمیم‌های فنی: [`docs/`](docs/) (۲۴ سند مهندسی) و [`docs/adr/`](docs/adr/)

---

## ۲. راه‌اندازی سریع (Quick Start)

### پیش‌نیازها

| ابزار          | حداقل نسخه | بررسی                    |
| -------------- | ---------- | ------------------------ |
| Node.js        | 22 LTS     | `node -v`                |
| pnpm           | 10         | `pnpm -v`                |
| Docker Engine  | 24         | `docker --version`       |
| Docker Compose | v2         | `docker compose version` |
| Git            | 2.40       | `git --version`          |

حداقل منابع توصیه‌شده برای اجرای کامل Stack محلی: **۸ گیگابایت RAM آزاد** و **۲۰ گیگابایت** فضای دیسک.

### گام‌به‌گام

```bash
# 1) کلون و نصب وابستگی‌ها
git clone <repo-url> rasta && cd rasta
pnpm install

# 2) پیکربندی محیط (هیچ Secret واقعی در Repository نیست)
cp .env.example .env

# 3) بالا آوردن زیرساخت (PostgreSQL/PostGIS, Redis, Kafka, Keycloak, MinIO, Temporal)
pnpm infra:up

# 4) اجرای Migration و داده اولیه
pnpm db:migrate
pnpm db:seed

# 5) اجرای تمام سرویس‌ها و Frontend
pnpm dev
```

پس از بالا آمدن:

| سرویس             | آدرس                       | اطلاعات ورود                                     |
| ----------------- | -------------------------- | ------------------------------------------------ |
| Web App           | http://localhost:3200      | `dehyari.admin` / `RastaDev!2026`                |
| Admin Console     | http://localhost:3201      | `union.admin` / `RastaDev!2026`                  |
| API Gateway       | http://localhost:3000      | —                                                |
| OpenAPI (Swagger) | http://localhost:3000/docs | —                                                |
| Keycloak          | http://localhost:8080      | `admin` / `admin_dev_password`                   |
| MinIO Console     | http://localhost:9001      | `rasta_minio_admin` / `rasta_minio_dev_password` |
| Kafka UI          | http://localhost:8081      | `--profile tools`                                |
| Temporal UI       | http://localhost:8088      | `--profile tools`                                |
| Grafana           | http://localhost:3001      | `--profile observability`                        |

> **همه اعتبارنامه‌های بالا صرفاً محلی و یک‌بارمصرف‌اند.** هیچ‌کدام در محیط واقعی استفاده نمی‌شوند —
> رجوع کنید به [`docs/09-security-architecture.md`](docs/09-security-architecture.md).

### پروفایل‌های اختیاری زیرساخت

```bash
docker compose --profile tools up -d          # Kafka UI، Temporal UI، Mailpit
docker compose --profile search up -d         # OpenSearch
docker compose --profile observability up -d  # OTel Collector، Prometheus، Grafana
docker compose --profile all up -d            # همه
```

---

## ۳. دستورهای روزمره

```bash
pnpm dev                 # اجرای همه سرویس‌ها در حالت watch
pnpm build               # Build کل Monorepo (Turborepo، cache-aware)
pnpm typecheck           # بررسی نوع در همه Workspaceها
pnpm lint                # ESLint
pnpm format              # Prettier (نوشتن)
pnpm test                # همه تست‌ها
pnpm test:unit           # فقط Unit
pnpm test:integration    # Integration (نیازمند infra:up)
pnpm test:e2e            # Playwright E2E
pnpm verify              # format:check + lint + typecheck + test + build  ← دروازه کیفیت
pnpm infra:up            # بالا آوردن زیرساخت
pnpm infra:reset         # پاک‌سازی کامل حجم‌ها و راه‌اندازی مجدد
pnpm db:migrate          # Migration همه سرویس‌ها
pnpm db:seed             # داده نمایشی
```

اجرای یک Workspace خاص:

```bash
pnpm --filter @rasta/identity-service dev
pnpm --filter @rasta/web build
turbo run test --filter=@rasta/economic-service
```

---

## ۴. نقشه Repository

```
rasta/
├── apps/
│   ├── web/                  # Next.js — پورتال کاربر نهایی (RTL، Persian-first)
│   └── admin/                # Next.js — کنسول اپراتور پلتفرم (اتحادیه)
├── services/                 # ۱۶ Microservice + API Gateway (NestJS)
├── packages/                 # بسته‌های مشترک — بدون Business Logic
│   ├── contracts/            # Event Envelope، Catalogue، Value Objectها، Error Model
│   ├── config/               # بارگذاری و اعتبارسنجی env
│   ├── logging/              # Logger ساخت‌یافته + Correlation
│   ├── observability/        # راه‌اندازی OpenTelemetry
│   ├── nest-common/          # Guard/Filter/Interceptor/Tenant Context مشترک
│   └── testing/              # ابزارهای تست
├── infrastructure/
│   ├── docker/               # پیکربندی زیرساخت محلی
│   └── k8s/                  # Helm Chart و Manifestها
├── tests/e2e/                # سناریوهای End-to-End (Playwright)
└── docs/                     # ۲۴ سند مهندسی + ADRها + Runbookها
```

جزئیات کامل: [`docs/15-repository-architecture.md`](docs/15-repository-architecture.md)

---

## ۵. معماری در یک نگاه

```
                        ┌──────────────┐   ┌──────────────┐
                        │   web (PWA)  │   │    admin     │
                        └──────┬───────┘   └──────┬───────┘
                               │  OIDC / JWT      │
                        ┌──────▼──────────────────▼───────┐
                        │        API Gateway              │
                        │  Auth · RBAC · RateLimit · CORS │
                        │  CorrelationId · Idempotency    │
                        └──────┬──────────────────────────┘
                               │ REST (internal, mTLS-ready)
   ┌───────────┬───────────┬───┴───────┬───────────┬───────────┬───────────┐
   ▼           ▼           ▼           ▼           ▼           ▼           ▼
identity  organization   asset       fleet    maintenance  marketplace  economic …
   │           │           │           │           │           │           │
   └───────────┴───────────┴─────┬─────┴───────────┴───────────┴───────────┘
                                 │  Kafka (domain events, Outbox-published)
                    ┌────────────┴────────────┐
                    ▼                         ▼
              notification               audit / analytics
```

- **یک پایگاه داده منطقی به‌ازای هر سرویس** — هیچ جدول مشترکی وجود ندارد.
- **Temporal** گردش‌کارهای بلندمدت (مناقصه، تسویه، Saga سفارش) را اجرا می‌کند.
- **دفتر کل دوطرفه و تغییرناپذیر** مرجع حقیقت مالی است؛ کیف پول صرفاً نمای عملیاتی آن است.

سند کامل: [`docs/01-executive-architecture.md`](docs/01-executive-architecture.md)

---

## ۶. مستندات

| موضوع                    | مسیر                                                                   |
| ------------------------ | ---------------------------------------------------------------------- |
| فهرست ۲۴ سند مهندسی      | [`docs/README.md`](docs/README.md)                                     |
| تصمیم‌های معماری (ADR)   | [`docs/adr/`](docs/adr/)                                               |
| قرارداد API              | [`docs/api/`](docs/api/) · Swagger UI روی `/docs` هر سرویس             |
| کاتالوگ رویدادها         | [`docs/events/`](docs/events/)                                         |
| امنیت و Threat Model     | [`docs/09-security-architecture.md`](docs/09-security-architecture.md) |
| Runbookهای عملیاتی       | [`docs/runbooks/`](docs/runbooks/)                                     |
| قواعد کار عامل‌های توسعه | [`AGENTS.md`](AGENTS.md) · [`CLAUDE.md`](CLAUDE.md)                    |

---

## ۷. مشارکت در توسعه

پیش از هر Commit، دروازه کیفیت باید سبز باشد:

```bash
pnpm verify
```

قواعد الزامی — تفصیل در [`AGENTS.md`](AGENTS.md):

- **TypeScript strict**؛ `any` فقط با توجیه مکتوب.
- **بدون دسترسی مستقیم به پایگاه داده سرویس دیگر.** ارتباط فقط از راه REST یا Event.
- **بدون Business Logic مشترک** میان سرویس‌ها در `packages/`.
- هر Feature نیازمند **Tenant Isolation Test** است.
- هیچ Secret واقعی در Repository — فقط `.env.example`.
- هر تصمیم معماری مهم → یک **ADR**.

---

## ۸. وضعیت فعلی و محدوده

این کدبیس یک **MVP مهندسی‌شده** است، نه یک سامانه گواهی‌شده برای بهره‌برداری ملی.

> **برای وضعیت دقیق و به‌روز — کدام قابلیت واقعاً پیاده‌شده، کدام تست‌شده، کدام
> زنده تأیید شده، و کدام Known Issue باز است — به [`PROJECT_MEMORY.md`](PROJECT_MEMORY.md)
> مراجعه کنید.** خلاصه زیر برای آشنایی سریع است، نه مرجع دقیق.

**آنچه واقعی است:** معماری Microservices، پایگاه داده و Migration، APIها، Event Bus
(Outbox + Consumer)، احراز هویت، ۲۲۰ تست واحد، و **یک Pipeline کامل CI که روی
GitHub Actions سبز است** — Lint، Type Check، Test، Build، Gitleaks، Dependency
Audit، Semgrep، Migration، و Build+Trivy Scan دو Image.

**دفتر کل دوطرفه هنوز ساخته نشده** (`economic-service` در فهرست سرویس‌های آینده
است). مرحله Integration در CI سبز است اما هنوز **تهی** — هیچ فایل `*.int-spec.ts`
وجود ندارد. وضعیت دقیق هر قابلیت در `PROJECT_MEMORY.md`.

**سرویس‌های پیاده‌سازی‌شده تا این لحظه** — بقیه در `docs/17-mvp-scope.md` زمان‌بندی شده‌اند:

| سرویس                  | پورت | وضعیت                                                       |
| ---------------------- | ---- | ----------------------------------------------------------- |
| `api-gateway`          | 3000 | مسیریابی، Rate Limiting، Circuit Breaker                    |
| `identity-service`     | 3101 | کاربر، عضویت، نقش، یکپارچگی با Keycloak                     |
| `organization-service` | 3102 | سلسله‌مراتب `ltree`، سیاست‌های ارثی، مکان (PostGIS)         |
| `asset-service`        | 3103 | دارایی، پرونده الکترونیکی، بیمه و معاینه فنی، انتقال مالکیت |

**آنچه شبیه‌سازی‌شده است:** ارائه‌دهنده پرداخت. در MVP از `MockPaymentProvider` استفاده می‌شود.
**هیچ اتصال بانکی واقعی وجود ندارد و هیچ ادعایی در این باره نمی‌شود.** اجرای واقعی نگهداری وجوه،
انتقال وجه و اتصال به درگاه پرداخت، مشروط به بررسی و تأیید الزامات بانکی، پرداختی، مالیاتی و
مقرراتی است — مطابق تصریح سند محصول.

پرسش‌های باز نیازمند تصمیم انسانی (نرخ کارمزد، مرجع موافقت، الزامات حقوقی کیف پول و …) در
[`docs/24-open-questions.md`](docs/24-open-questions.md) ثبت شده‌اند و **با حدس پر نشده‌اند**.

---

## ۹. مجوز

UNLICENSED — تمام حقوق محفوظ است.
