# CLAUDE.md

> راهنمای کار Claude Code روی Repository رستا.
> **قواعد الزام‌آور در [`AGENTS.md`](AGENTS.md) هستند** — این فایل، نقشه عملیاتی و
> مرجع سریع دستورهاست. هر دو را پیش از کار بخوان.

---

## Project Overview

**رستا** — پلتفرم چندمستأجری مدیریت ناوگان، زنجیره تأمین، خدمات و عملیات عمرانی.
Monorepo مبتنی بر TypeScript با ۱۶ Microservice (NestJS)، دو Frontend (Next.js) و
زیرساخت رویدادمحور (Kafka + Temporal).

| منبع                    | مسیر                                      |
| ----------------------- | ----------------------------------------- |
| الزامات محصول («چه؟»)   | `01-طرح-جامع-پلتفرم-رستا.docx`            |
| تصمیم‌های فنی («چگونه؟»)| `docs/01..24-*.md`                        |
| تصمیم‌های ثبت‌شده       | `docs/adr/ADR-*.md`                       |
| قواعد الزام‌آور         | `AGENTS.md`                               |
| پرسش‌های باز            | `docs/24-open-questions.md`               |

---

## Architecture Principles

1. **Asset-Centric** — دارایی (ماشین‌آلات) موجودیت مرکزی است، نه صرفاً کاربر.
   `Organization → User/Role → Asset → Driver → Usage → Maintenance → Insurance → Orders → Projects → Transactions`
2. **Organization-Agnostic** — `OrganizationType` قابل توسعه است
   (`DEHYARI | MUNICIPALITY | UNION | COMPANY | GOVERNMENT | PRIVATE | NATIONAL_ORGANIZATION`)
   و سلسله‌مراتب Configurable. هیچ‌جا «دهیاری» فرض ساختاری نیست.
3. **Multi-Tenant by Default** — هر Query دارای Tenant Scope. جداسازی در API، Application،
   Database، Authorization، Cache و Event.
4. **API-First** — OpenAPI پیش از پیاده‌سازی.
5. **Event-Driven** — رویدادهای دامنه از راه Kafka، منتشرشده با Transactional Outbox.
6. **Database Ownership per Service** — بدون جدول مشترک، بدون Join میان‌سرویسی.
7. **Security by Design** — بسته به‌صورت پیش‌فرض؛ هیچ استثنایی «برای Demo».
8. **Financial Integrity** — دفتر کل دوطرفه و تغییرناپذیر؛ `Wallet ≠ Ledger`.
9. **Configurable Governance** — مراجع موافقت، نرخ کارمزد و قواعد ارزیابی از پیکربندی
   می‌آیند، نه از کد. پلتفرم مرجع حقوقی جدید نمی‌سازد.

---

## Commands

### راه‌اندازی

```bash
pnpm install                  # نصب وابستگی‌ها
cp .env.example .env          # پیکربندی محلی
pnpm infra:up                 # PostgreSQL, Redis, Kafka, Keycloak, MinIO, Temporal
pnpm db:migrate && pnpm db:seed
pnpm dev                      # همه سرویس‌ها + Frontend
```

### توسعه

```bash
pnpm dev                                     # همه
pnpm --filter @rasta/identity-service dev    # یک سرویس
pnpm --filter @rasta/web dev                 # Frontend
turbo run build --filter=@rasta/asset-service...   # سرویس + وابستگی‌هایش
```

### زیرساخت

```bash
pnpm infra:up          # بالا آوردن
pnpm infra:down        # خاموش کردن
pnpm infra:reset       # ⚠️ حذف حجم‌ها و راه‌اندازی از صفر
pnpm infra:logs        # دنبال کردن Log
docker compose --profile tools up -d           # Kafka UI, Temporal UI, Mailpit
docker compose --profile observability up -d   # OTel, Prometheus, Grafana
```

### پایگاه داده

```bash
pnpm db:migrate                                          # همه سرویس‌ها
pnpm --filter @rasta/asset-service db:migrate            # یک سرویس
pnpm --filter @rasta/asset-service exec prisma migrate dev --name add_asset_status
pnpm --filter @rasta/asset-service exec prisma studio    # مرور داده
```

---

## Testing Commands

```bash
pnpm test                       # همه تست‌ها
pnpm test:unit                  # فقط Unit (بدون نیاز به زیرساخت)
pnpm test:integration           # نیازمند `pnpm infra:up`
pnpm test:e2e                   # Playwright (نیازمند اجرای کامل Stack)
pnpm --filter @rasta/economic-service test
pnpm --filter @rasta/economic-service test -- --testNamePattern="tenant isolation"
pnpm --filter @rasta/economic-service test -- --coverage
```

**دروازه کیفیت — پیش از هر Commit:**

```bash
pnpm verify     # format:check → lint → typecheck → test → build
```

---

## Coding Standards

```
TypeScript strict          — بدون استثنا
any                        — فقط با // JUSTIFIED-ANY: <دلیل>
@ts-ignore                 — ممنوع؛ به‌جای آن @ts-expect-error با توضیح
console.log                — ممنوع؛ Logger ساخت‌یافته از @rasta/logging
Business logic             — در Domain Service، نه در Controller
DTO Validation             — در مرز ورودی، Schema-based
Money                      — bigint در واحد فرعی؛ در JSON رشته؛ نرخ بر حسب Basis Point
Time                       — UTC در پایگاه داده؛ تبدیل تقویمی فقط در UI
Errors                     — ErrorCode پلتفرم از @rasta/contracts
Dependency Injection       — برای هر وابستگی بیرونی
```

**ممنوع:** import میان‌سرویسی، جدول مشترک، Business Logic در `packages/`،
Query بدون Tenant Scope، تغییر ورودی Post‌شده دفتر کل، `float` برای پول،
Hard-Code کردن نرخ کارمزد یا مرجع موافقت.

---

## Service Map

| سرویس                  | پورت | مالکیت داده                                        | فاز |
| ---------------------- | ---- | -------------------------------------------------- | --- |
| `api-gateway`          | 3000 | — (بدون پایگاه داده)                               | P0  |
| `identity-service`     | 3101 | User، Credential، Session، Membership، Role         | P0  |
| `organization-service` | 3102 | Organization، Hierarchy، Policy، Location           | P0  |
| `asset-service`        | 3103 | Asset، AssetDocument، InsurancePolicy، Inspection   | P0  |
| `fleet-service`        | 3104 | Driver، Assignment، UsageRecord، Availability       | P0  |
| `maintenance-service`  | 3105 | Schedule، MaintenanceRequest، RepairOrder، Part     | P0  |
| `marketplace-service`  | 3106 | Catalog، Product، Offer، Cart، Order، Review        | P0  |
| `procurement-service`  | 3107 | DemandRequest، Aggregation، RFQ، Quotation، PO      | P1  |
| `supplier-service`     | 3108 | Supplier، Contractor، Qualification، Rating         | P1  |
| `inventory-service`    | 3109 | Warehouse، Stock، Movement، Shipment                | P1  |
| `construction-service` | 3110 | Project، Need، Approval، Tender، Bid، Progress      | P0  |
| `contract-service`     | 3111 | Contract، Amendment، Statement، Milestone           | P0  |
| `economic-service`     | 3112 | Wallet، Ledger، Transaction، Commission، Reward     | P0  |
| `notification-service` | 3113 | Notification، Template، Delivery، Preference        | P0  |
| `document-service`     | 3114 | Document، Version، AccessGrant (فراداده؛ فایل در S3)| P0  |
| `audit-service`        | 3115 | AuditEvent (فقط الحاقی)                            | P0  |
| `analytics-service`    | 3116 | ReadModel، KPI Snapshot                            | P1  |

Frontend: `apps/web` (3200) — پورتال کاربر · `apps/admin` (3201) — کنسول اپراتور.

**قاعده:** یک سرویس هرگز پایگاه داده سرویس دیگر را نمی‌خواند. فقط REST یا Event.

---

## Security Rules

```
✅ هر Endpoint پیش‌فرض بسته؛ باز بودن صریح و مستند
✅ مجوزدهی سطح Object (نه فقط سطح Endpoint) — BOLA
✅ JWT با JWKS؛ بررسی aud، iss، exp
✅ هر Query دارای organizationId
✅ هر تغییر وضعیت → رکورد Audit
✅ ارتباط سرویس‌به‌سرویس احراز هویت‌شده (Zero Trust)
✅ Secret فقط از محیط؛ در Repository فقط .env.example

❌ Secret واقعی در کد، Log یا Commit
❌ داده حساس در URL یا پیام خطا
❌ دور زدن Auth «فقط برای Demo»
❌ عبارت «Military Grade Security» یا «100% Secure»
```

هر Feature که داده مستأجر را لمس می‌کند، **Tenant Isolation Test** لازم دارد.

---

## Git Rules

```
main → همیشه سبز
شاخه: feat/<scope>-<desc> | fix/… | chore/… | docs/…
Commit: Conventional Commits، اتمیک، خوانا، قابل برگشت
هرگز: --no-verify، push --force روی main، Commit عظیم مبهم
پیش از تغییر مخرب: اول Commit وضعیت فعلی
```

---

## Definition of Done

Code · Type Check · Lint · Unit Tests · Integration Tests · Tenant Isolation Test ·
Build · Migration (قابل بازگشت) · API Contract · Event Contract · Error Handling ·
Logging · Telemetry · Documentation · Security Review · Commit اتمیک

برای `economic`، `identity` و `construction`: **E2E نیز باید سبز باشد.**

فهرست کامل با Checkbox: [`AGENTS.md § 7`](AGENTS.md).

---

## نکات ویژه این Repository

- **RTL و فارسی** — `apps/web` و `apps/admin` فارسی‌محور و راست‌به‌چپ‌اند.
  از Logical Property‌های CSS استفاده کن (`margin-inline-start`، نه `margin-left`).
- **اعداد فارسی** — فقط در لایه ارائه تبدیل می‌شوند؛ داده و API همیشه لاتین.
- **تقویم** — ذخیره‌سازی میلادی/UTC؛ نمایش هجری شمسی در UI.
- **پرداخت** — `MockPaymentProvider` در MVP. هرگز ادعای اتصال بانکی نکن.
- **حکمرانی** — مرجع موافقت و نرخ کارمزد از پیکربندی می‌آیند. Hard-Code ممنوع.
- **ابهام** — در `docs/24-open-questions.md` ثبت کن، تصمیم موقت بگیر، Configurable نگه دار،
  و **هرگز واقعیت کسب‌وکاری اختراع نکن.**
