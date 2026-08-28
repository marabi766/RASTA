# RASTA — Project Memory

> **این فایل حافظه مهندسی رستا است.** نوشته‌شده تا یک Developer یا AI Agent جدید،
> بدون تکیه بر Context مکالمه قبلی، بفهمد رستا الان دقیقاً کجاست.
>
> **قاعده این فایل:** واقعیت کد/Git/Runtime بر ادعای سند اولویت دارد. هرجا وضعیتی
> Verify نشده، همین‌طور علامت خورده — نه «کامل».
>
> **آخرین Audit کامل:** 2026-08-27 — با اجرای واقعی `pnpm verify`، بالا آوردن ۴
> سرویس از حالت تمیز، تست زنده Auth/Tenant Isolation/Event Flow، و بررسی مستقیم
> GitHub Actions.
>
> **آخرین به‌روزرسانی:** 2026-08-29 — **فاز `economic-service` بسته شد:
> READY_FOR_NEXT_PHASE.** هفتمین سرویس، و حساس‌ترین دامنه پلتفرم:
>
> | سطح             | شاهد                                                                                              |
> | --------------- | ------------------------------------------------------------------------------------------------- |
> | IMPLEMENTED     | Wallet · Hold · Ledger · Journal · Transaction · PaymentIntent · Commission · Reward · Settlement |
> | TESTED          | **۲۳۹** تست واحد در economic؛ **۶۵۴** در کل Monorepo                                              |
> | INTEGRATION     | **۱۰۰** تست روی PostgreSQL و Kafka **واقعی** — ۹ Suite (مجموع پلتفرم: ۱۷۳)                        |
> | LIVE VERIFIED   | **۲۶ سناریو** از راه Gateway با توکن واقعی Keycloak (بخش ۲۱-ج)                                    |
> | **CI VERIFIED** | **Run `33219920446`، Commit `a36a2cf` روی `main`، هر ۹ Job سبز**                                  |
>
> پنج ADR تازه (۰۳۰ تا ۰۳۴) و چهار بدهی ثبت‌شده (D-013 تا D-016).
>
> **این فاز یک تناقض در خودِ سند معماری پیدا کرد.** `docs/10` § ۱۰٫۳ می‌گوید
> `available = ledger − pending`، و § ۱۰٫۴ یک Journal برای Hold می‌نویسد که حساب
> کیف پول را بدهکار می‌کند. هر دو با هم یعنی مبلغ **دو بار** شمرده می‌شود و
> مانده در دسترس برای کیف پولی سالم منفی می‌شود. حل شد با امانت به‌ازای هر
> سازمان (ADR-034)، و رابطه اکنون یک `CHECK` در پایگاه داده است، نه یک قاعده کد.
>
> **و سه نقص را تست‌ها گرفتند، نه بازبینی:** یک تراکنش تودرتوی Prisma که روی
> دو Connection اجرا می‌شد و Deadlock می‌ساخت؛ یک نمای «دریافت‌کننده» که Filter
> نگهبان مستأجر را با Filter دریافت‌کننده AND می‌کرد و همیشه خالی برمی‌گشت؛ و
> گزارش شکست ناخوانا برای هر ادعای `bigint`.
>
> **نکته‌ای که این فاز اثبات کرد:** وقتی یک Invariant را می‌توان به یک محدودیت
> پایگاه داده تبدیل کرد، باید کرد. `ck_wallet_balances` — نه بررسی Application —
> است که خرج بیش از موجودی را غیرممکن می‌کند؛ بررسی کد فقط پیام خطای خوانا
> می‌سازد.
>
> ---
>
> **پیشین — 2026-08-28:** فاز `maintenance-service` بسته شد. ششمین سرویس، با هر
> پنج سطح تأیید:
>
> | سطح             | شاهد                                                                        |
> | --------------- | --------------------------------------------------------------------------- |
> | IMPLEMENTED     | Schedule · Request · RepairOrder · PartUsage · LaborEntry · MaintenanceCost |
> | TESTED          | ۱۰۲ تست واحد در maintenance؛ **۴۱۵** در کل Monorepo                         |
> | INTEGRATION     | ۴۱ تست روی PostgreSQL و Kafka **واقعی** — بدون Mock (مجموع پلتفرم: ۷۳)      |
> | LIVE VERIFIED   | **۳۵ سناریو** از راه Gateway با توکن واقعی Keycloak (بخش ۲۱-ب)              |
> | **CI VERIFIED** | **Run `33172549841`، Commit `24bef76`، هر ۸ Job سبز (۱۲م ۴۴ث)**             |
>
> سه ADR تازه (۰۲۷، ۰۲۸، ۰۲۹)، دو Open Question تازه (Q-24، Q-25) و دو بدهی ثبت‌شده
> (D-011، D-012).
>
> **دو مسیر مرده پلتفرم زنده شدند.** `fleet-service` از روز نخست
> `USAGE_RECORDED` منتشر می‌کرد **بدون هیچ مصرف‌کننده‌ای**، و
> `MAINTENANCE_STARTED`/`MAINTENANCE_COMPLETED` را مصرف می‌کرد **بدون هیچ
> تولیدکننده‌ای**؛ جدول Projection در `asset-service` هم از قبل ردیف‌های نگهداری
> داشت. هر سه، امروز زنده تأیید شدند (بخش ۲۱-ب).
>
> **نکته‌ای که این فاز اثبات کرد و باید نگه داشته شود:** یک تست همروندی واقعی، یک
> Lost Update را می‌گیرد که هیچ تست تک‌نخی نمی‌تواند. ده ثبت هزینه هم‌زمان روی یک
> دستور تعمیر، پیاده‌سازی «مجموع را افزایش بده» را قابل‌اعتماد می‌شکند و
> پیاده‌سازی «از خطوط بازمحاسبه کن» را نه.

---

## ۱. Project Mission

**رستا** پلتفرمی چندمستأجری برای مدیریت ناوگان، زنجیره تأمین، خدمات و عملیات
عمرانی ۳۲۸ دهیاری استان یزد است. اصول بنیادین (`AGENTS.md`):

- **Asset-Centric** — دارایی، نه کاربر، موجودیت مرکزی است.
- **Organization-Agnostic** — هیچ‌جا «دهیاری» فرض ساختاری نیست؛ `OrganizationType` باز است.
- **Multi-Tenant by Default** — جداسازی در API، DB، Cache، Event.
- **Event-Driven با Transactional Outbox** — بدون Publish مستقیم به Kafka.
- **Database Ownership per Service** — بدون جدول مشترک، بدون Join میان‌سرویسی.
- **Financial Integrity** — دفتر کل دوطرفه (هنوز پیاده نشده — economic-service).
- **Configurable Governance** — نرخ کارمزد و مرجع موافقت از پیکربندی، نه Hard-Code.

نقشه کامل: [`AGENTS.md`](AGENTS.md) (قواعد الزام‌آور) و [`CLAUDE.md`](CLAUDE.md)
(راهنمای عملیاتی).

---

## ۲. Current Development Phase

**فاز:** پیاده‌سازی MVP، پس از تکمیل ۲۴ سند معماری و ۲۴ ADR.

**ترتیب واقعی ساخت تا امروز** (از Git History، نه از برنامه‌ریزی اولیه):

```
1. Monorepo foundation (pnpm + Turborepo + TS strict)
2. packages/contracts, config, logging
3. packages/nest-common (context, auth, tenancy, outbox)
4. Infrastructure (docker-compose: Postgres/Redis/Kafka/Keycloak/MinIO/Temporal)
5. identity-service  ← کامل
6. organization-service  ← کامل
7. CI pipeline + Dockerfiles  ← نوشته شد؛ از 2026-08-27 روی GitHub سبز (بخش ۱۹)
8. api-gateway  ← کامل
9. asset-service  ← کامل (آخرین سرویس ساخته‌شده)
10. packages/nest-common: EventConsumer  ← کامل (زیرساخت مصرف رویداد)
11. سخت‌سازی پیش از fleet: D-005 (CI سبز شد) + D-007 (ثبت‌نام گمنام)
12. fleet-service  ← کامل: کد، تست، و تأیید زنده End-to-End
13. maintenance-service  ← کامل: نخستین سرویسی که هر دو سرِ مسیر رویدادش از قبل منتظر بود
14. economic-service  ← کامل: حساس‌ترین دامنه؛ نخستین سرویسی که یک تناقض در سند
    معماری پیدا کرد و آن را با ADR حل کرد، نه با حدس
```

**گام بعدی طبق مستندسازی این Repository:** `marketplace-service` (بخش ۲۹) —
و این بار **بدون ابهام**: تصمیم انسانیِ «marketplace اول یا economic اول؟» که
حافظه پیشین می‌خواست، با ساختن economic پاسخ گرفت. سفارش اکنون طرف مقابلش را
دارد.

---

## ۳. Current Verified State

این فایل پنج سطح را از هم جدا نگه می‌دارد و هرگز یکی را به‌جای دیگری
نمی‌نویسد:

| سطح               | معنا                                                    |
| ----------------- | ------------------------------------------------------- |
| **IMPLEMENTED**   | کد وجود دارد                                            |
| **TESTED**        | تست خودکار روی آن هست و سبز است                         |
| **LIVE VERIFIED** | در برابر Stack واقعی اجرا و پاسخش مشاهده شد — بدون Mock |
| **CI VERIFIED**   | روی Runner واقعی GitHub Actions اجرا شد و سبز بود       |
| **NOT VERIFIED**  | شواهد غیرمستقیم داریم اما تأیید مثبت نداریم             |
| **PLANNED**       | تصمیم گرفته شده، کد نوشته نشده                          |

| Feature                                                      |                     Implemented                      | Automated Tests  | Live Verified (2026-08-27)                                                                                         |
| ------------------------------------------------------------ | :--------------------------------------------------: | :--------------: | ------------------------------------------------------------------------------------------------------------------ |
| Tenant Isolation (API)                                       |                          ✅                          |        ✅        | ✅ (403 TENANT_MISMATCH زنده گرفته شد)                                                                             |
| Tenant Isolation (Database)                                  |                          ✅                          |        —         | ✅ (`permission denied for database` زنده گرفته شد)                                                                |
| Cross-tenant read → 404                                      |                          ✅                          |        ✅        | ✅                                                                                                                 |
| RBAC (Roles Guard)                                           |                          ✅                          |        ✅        | ✅ (Auditor → 403 روی POST)                                                                                        |
| JWT verification (Keycloak/JWKS)                             |                          ✅                          |        ✅        | ✅ (۴ کاربر Seed، توکن واقعی گرفته شد)                                                                             |
| Transactional Outbox → Kafka                                 |                          ✅                          |        ✅        | ✅ (Asset ساخته شد → Outbox → Kafka، Correlation تطبیق)                                                            |
| Event Consumer / Dossier Projector                           |                          ✅                          |   ✅ (18 تست)    | ✅ (رویداد ساختگی maintenance → یک خط Timeline، Replay دوباره = بدون تکرار)                                        |
| API Gateway routing + circuit breaker                        |                          ✅                          |   ✅ (21 تست)    | ✅ (مسیر به سرویس نساخته‌شده fleet → 503 تمیز)                                                                     |
| Redis Rate Limiting (منطق)                                   |                          ✅                          |    ✅ (واحد)     | ⚠️ **مسدود شده توسط تداخل Port میزبان — بخش ۲۲.۳ D-006**                                                           |
| Anonymous public endpoint (self-registration) از راه Gateway |                          ✅                          |   ✅ (17 تست)    | ✅ **`201` زنده گرفته شد — D-007 رفع شد**                                                                          |
| CI/CD روی GitHub Actions                                     |                          ✅                          |        —         | ✅ **CI VERIFIED** — Run `33219920446`، Commit `a36a2cf`، هر **۹** Job سبز (فاز اقتصادی)                           |
| Docker Build (identity, organization)                        |                          ✅                          |        —         | ✅ **CI VERIFIED** — Build + Trivy Scan هر دو Image روی Runner سبز                                                 |
| Docker Build (asset, fleet, maintenance)                     |                 ✅ Dockerfile دارند                  |        —         | ✅ **CI VERIFIED** — Build + Trivy روی Runner برای هر سه؛ maintenance محلی هم اجرا شد (uid=100)                    |
| Docker Build (economic)                                      |                  ✅ Dockerfile دارد                  |        —         | ✅ **CI VERIFIED** — Build + Trivy روی Runner سبز؛ محلی هم: `uid=100(rasta)`، `npm` حذف‌شده، Trivy ۰ CRITICAL/HIGH |
| Docker Build (api-gateway)                                   |                 ❌ Dockerfile ندارد                  |        —         | ❌ باز (بخش ۲۲)                                                                                                    |
| **fleet-service — Driver/Assignment/Usage/Availability**     |                          ✅                          |   ✅ (۸۸ تست)    | ✅ زنده + **CI VERIFIED**                                                                                          |
| **Assignment Exclusivity (Partial Unique Index)**            |                          ✅                          | ✅ (Integration) | ✅ زنده: راننده مشغول → `422 DRIVER_ALREADY_ASSIGNED`                                                              |
| **Fleet → Kafka → Asset Projector**                          |                          ✅                          |   ✅ (۳۲ تست)    | ✅ **زنده** — Timeline پر شد، وضعیت `IDLE→ASSIGNED→ACTIVE`                                                         |
| **Idempotency (ثبت آفلاین + Replay مصرف‌کننده)**             |                          ✅                          |        ✅        | ✅ زنده: ارسال دوباره = همان رکورد؛ Replay کافکا = بدون اثر دوم                                                    |
| **correlationId در کل زنجیره**                               |                          ✅                          |        ✅        | ✅ زنده: HTTP → Outbox → Header کافکا → Timeline، یکسان                                                            |
| **maintenance — Schedule/Request/RepairOrder/Cost**          |                          ✅                          |   ✅ (۱۰۲ تست)   | ✅ زنده + **CI VERIFIED**                                                                                          |
| **سررسید مشتق‌شده (نه Flag ذخیره‌شده)**                      |                          ✅                          |   ✅ (۱۴ تست)    | ✅ زنده: گریدر `OVERDUE on HOURS`، کنتور ۴۳۸۶٫۵۰ در برابر سررسید ۴۳۷۰٫۵۰                                           |
| **منع درخواست تکراری (Partial Unique Index)**                |                          ✅                          | ✅ (Integration) | ✅ زنده: درخواست دوم → `422 DUPLICATE_OPEN_REQUEST`                                                                |
| **اتمیک بودن هزینه زیر همروندی**                             |                          ✅                          | ✅ (Integration) | ✅ ده ثبت هم‌زمان → مجموع دقیقاً برابر `SUM` پایگاه داده                                                           |
| **تأیید پیش از تسویه (کنترل سند محصول)**                     |                          ✅                          |        ✅        | ✅ زنده: تأیید زودهنگام `409`، مبلغ کهنه `422`، تأیید دوباره `409`                                                 |
| **Fleet USAGE_RECORDED → Maintenance (مسیر مرده پیشین)**     |                          ✅                          |   ✅ (۴۱ تست)    | ✅ **زنده** — کنتور ۴۳۸۰٫۵۰ → ۴۳۸۶٫۵۰، سپس `MAINTENANCE_DUE`                                                       |
| **Maintenance → Kafka → Asset Timeline + Fleet Replica**     |                          ✅                          |        ✅        | ✅ **زنده** — ۳ خط Timeline، `IN_MAINTENANCE` → `ACTIVE`، `inMaintenance` روشن و خاموش                             |
| **economic — Wallet/Hold/Ledger/Journal/Transaction**        |                          ✅                          |   ✅ (۲۳۹ تست)   | ✅ زنده (۲۶ سناریو، بخش ۲۱-ج)                                                                                      |
| **تغییرناپذیری دفتر کل (Trigger پایگاه داده)**               |                          ✅                          | ✅ (Integration) | ✅ **از SQL خام** — `UPDATE`/`DELETE` روی `ledger_entry` و `journal` هر دو رد شدند                                 |
| **توازن هر Journal (Trigger معوق در COMMIT)**                |                          ✅                          | ✅ (Integration) | ✅ تراز آزمایشی زنده: `balanced: true`، ۱۳۶٬۰۰۰٬۰۰۰ = ۱۳۶٬۰۰۰٬۰۰۰                                                  |
| **`available = ledger − pending` (CHECK پایگاه داده)**       |                          ✅                          | ✅ (Integration) | ✅ زنده: Hold ۱۲م → available ۷۶م، pending ۱۲م، مجموع ۸۸م                                                          |
| **همروندی کیف پول — ۱۰۰ برداشت موازی**                       |                          ✅                          | ✅ (Integration) | ✅ دقیقاً ۱۰ موفق از ۱۰۰ برای موجودی ۱۰ واحدی؛ هرگز مانده منفی                                                     |
| **Idempotency واقعی (کلید ذخیره‌شده + Hash بدنه)**           |                          ✅                          |   ✅ (۱۳ تست)    | ✅ زنده: کلید تکراری → همان پاسخ؛ بدنه متفاوت → `409`؛ بدون کلید → `400`                                           |
| **تسویه اتمیک — شکست میانی چیزی باقی نمی‌گذارد**             |                          ✅                          | ✅ (Integration) | ✅ تزریق خطا پس از Post شدن Journal → صفر Journal، صفر تغییر مانده، وجه در Hold                                    |
| **اعتراض → توقف کامل تسویه**                                 |                          ✅                          |        ✅        | ✅ زنده: تسویه پیش از تأیید `409`؛ ماشین حالت یال DISPUTED→SETTLED ندارد                                           |
| **`AUDITOR` هیچ دسترسی اقتصادی ندارد**                       |                          ✅                          |        ✅        | ✅ زنده با توکن واقعی: کیف پول `403`، تراکنش `403`، تراز آزمایشی `403`                                             |
| **Maintenance → Kafka → economic (مسیر مرده پیشین)**         |                          ✅                          |    ✅ (۹ تست)    | ✅ **زنده** — `MAINTENANCE_APPROVED` → تعهد `PENDING_SETTLEMENT`، و **صفر حرکت پول**                               |
| **پرداخت شبیه‌سازی‌شده، با اعلام صریح**                      |                          ✅                          |        ✅        | ✅ زنده: `simulated: true` روی پاسخ، ردیف و رویداد؛ شکست قابل تحریک → `INSUFFICIENT_FUNDS`                         |
| Frontend (`apps/web`, `apps/admin`)                          |                          ❌                          |        —         | NOT_STARTED — پوشه خالی                                                                                            |
| Integration Tests (`*.int-spec.ts`)                          | ✅ ۱۸ Suite (fleet ۴، maintenance ۵، **economic ۹**) |        —         | ✅ **۱۷۳** — ۷۳ پیشین + ۱۰۰ economic                                                                               |
| E2E Tests (`tests/e2e`, Playwright)                          |                          ❌                          |        —         | پوشه خالی، بدون Config — بخش ۲۲ (**بدهی باز**)                                                                     |
| marketplace/procurement/… (۹ سرویس)                          |                          ❌                          |        —         | NOT_STARTED                                                                                                        |

---

## ۴. Architecture Summary

Microservices (NestJS 11) + Next.js 15 (برنامه‌ریزی‌شده، نساخته) + رویدادمحور
(Kafka 3.9 KRaft) + Workflow Engine (Temporal — هنوز در هیچ سرویسی استفاده
نشده). هر سرویس Prisma Client و Database مستقل خودش را دارد. `api-gateway`
بدون Database، فقط Routing/Rate-Limit/Circuit-Breaker/Auth-Forwarding.

مسیر یک درخواست کاربر واقعی:
`Client → api-gateway (auth+rate-limit+route) → <service> (auth دوباره،
tenant-scope، business logic) → Postgres (نوشتن + Outbox در یک Transaction)
→ OutboxRelay (Polling) → Kafka → EventConsumer سرویس‌های دیگر`

---

## ۵. Technology Stack

| لایه           | فناوری                                                                       |
| -------------- | ---------------------------------------------------------------------------- |
| زبان           | TypeScript 5.9 strict، Node 22/24                                            |
| Backend        | NestJS 11، Zod برای Validation                                               |
| Frontend       | Next.js 15 (برنامه‌ریزی‌شده — کد نساخته)                                     |
| Database       | PostgreSQL 16 + PostGIS 3.4 + ltree + pg_trgm + pgcrypto، Prisma 6           |
| Message Bus    | Kafka 3.9 KRaft (`apache/kafka:3.9.0`)                                       |
| Cache          | Redis 7.4                                                                    |
| Identity       | Keycloak 26 (OIDC/OAuth2، JWKS، RS256)                                       |
| Workflow       | Temporal 1.26 (زیرساخت بالا هست؛ هیچ سرویسی هنوز استفاده نمی‌کند)            |
| Object Storage | MinIO (S3-compatible)                                                        |
| Observability  | OpenTelemetry + Prometheus + pino (ساختاریافته، با Redaction)                |
| Test           | Jest + @swc/jest (Unit)؛ Testcontainers/Playwright برنامه‌ریزی‌شده، نصب‌نشده |
| Monorepo       | pnpm workspaces + Turborepo                                                  |
| Container      | Docker multi-stage (`pnpm deploy --prod --legacy`)                           |

---

## ۶. Repository Structure

```
services/
  api-gateway/           IMPLEMENTED — بدون Database
  identity-service/       IMPLEMENTED
  organization-service/   IMPLEMENTED
  asset-service/          IMPLEMENTED
  fleet-service/          IMPLEMENTED — کد، تست و تأیید زنده کامل
  maintenance-service/    IMPLEMENTED — کد، تست و تأیید زنده کامل
  economic-service/       IMPLEMENTED — کد، تست و تأیید زنده کامل
  (9 سرویس دیگر)          NOT_STARTED — حتی پوشه هم وجود ندارد

packages/
  contracts/    شیء‌های مشترک: ID، Money، Error، Event Envelope
  config/       بارگذاری/اعتبارسنجی Env
  logging/      pino + Redaction
  observability/ OTel + Prometheus
  nest-common/  Context، Auth Guard، Tenant Guard، Outbox، EventConsumer
  testing/      Matcher/Context مشترک برای تست (کم‌استفاده)

apps/
  web/    NOT_STARTED — پوشه خالی
  admin/  NOT_STARTED — پوشه خالی

tests/
  e2e/    NOT_STARTED — پوشه خالی، بدون Playwright Config

infrastructure/
  docker/   Postgres Init، Kafka Topics، Keycloak Realm — IMPLEMENTED
  k8s/      NOT_STARTED — پوشه خالی

docs/       ۲۴ سند + ۲۴ ADR + events/api/database/security/deployment/runbooks
scripts/
  copy-prisma-client.mjs   کپی Prisma Client تولیدشده به dist/
  prisma.mjs               Wrapper که DATABASE_URL_<SERVICE> را به Prisma CLI می‌دهد (این جلسه اضافه شد)
```

---

## ۷. Service Inventory

| Service                | Port        | Status                                                 | DB                   | Tests                          | Docker                                                          |
| ---------------------- | ----------- | ------------------------------------------------------ | -------------------- | ------------------------------ | --------------------------------------------------------------- |
| `api-gateway`          | 3000/3010\* | IMPLEMENTED                                            | — (بدون Database)    | 30 Unit                        | ❌ Dockerfile ندارد                                             |
| `identity-service`     | 3101        | IMPLEMENTED                                            | `rasta_identity`     | 14 Unit                        | ✅ در CI Matrix                                                 |
| `organization-service` | 3102        | IMPLEMENTED                                            | `rasta_organization` | 21 Unit                        | ✅ در CI Matrix                                                 |
| `asset-service`        | 3103        | IMPLEMENTED (با یک Gap — بخش ۱۸)                       | `rasta_asset`        | 74 Unit                        | ✅ **در CI Matrix**                                             |
| `fleet-service`        | 3104        | IMPLEMENTED · TESTED · LIVE VERIFIED · **CI VERIFIED** | `rasta_fleet`        | **88 Unit + 32 Integration**   | ✅ **در CI Matrix**، Build+Trivy سبز                            |
| `maintenance-service`  | 3105        | IMPLEMENTED · TESTED · LIVE VERIFIED · **CI VERIFIED** | `rasta_maintenance`  | **102 Unit + 41 Integration**  | ✅ **در CI Matrix**، Build+Trivy سبز                            |
| `economic-service`     | **3112**    | IMPLEMENTED · TESTED · LIVE VERIFIED · **CI VERIFIED** | `rasta_economic`     | **239 Unit + 100 Integration** | ✅ **در CI Matrix**، Build+Trivy سبز (۰ CRITICAL/HIGH، uid=100) |
| ۹ سرویس دیگر           | 3106–3116   | NOT_STARTED                                            | —                    | ۰                              | —                                                               |

\* پورت داکیومنت‌شده در `CLAUDE.md`/`docs` **۳۰۰۰** است؛ در `.env` محلی فعلی
روی **۳۰۱۰** تنظیم شده چون یک Container نامرتبط (`purchase-workflow-system-app-1`)
پورت ۳۰۰۰ را در این ماشین توسعه گرفته است. این یک تنظیم محلی است، نه تغییر
معماری — `PORT_API_GATEWAY` در `.env` (ریشه) کنترل می‌کند.

برای هر سرویس پیاده‌شده، Authentication/Authorization/Tenant Isolation همگی
Implemented + Tested + Live Verified هستند (بخش ۳).

---

## ۷-الف. fleet-service — ورودی کامل حافظه

> نوشته‌شده در پایان دروازه انتشار فاز ناوگان (2026-08-28). هر ادعا شاهد دارد.

| بُعد           | مقدار                                                                  |
| -------------- | ---------------------------------------------------------------------- |
| Service        | `fleet-service` (`@rasta/fleet-service`)                               |
| Status         | **IMPLEMENTED · TESTED · LIVE VERIFIED · CI VERIFIED**                 |
| Port           | `3104` (`PORT_FLEET`)                                                  |
| Database       | `rasta_fleet` — نقش اختصاصی، بدون دسترسی به پایگاه داده هیچ سرویس دیگر |
| Topic تولیدی   | `rasta.fleet.v1` (+ `.retry`, `.dlq`)                                  |
| Topic مصرفی    | `rasta.asset.v1` · `rasta.insurance.v1` · `rasta.maintenance.v1`       |
| Consumer Group | `fleet-service.asset-sync` (از Offset صفر)                             |

### مالکیت دامنه

**مالک است:** `Driver` · `Assignment` · `UsageRecord` · `AvailabilityWindow`
و نمای مشتق `Utilization`.

**مالک نیست — و این مرز اجرا می‌شود:**

> `Asset` در مالکیت `asset-service` باقی می‌ماند. `fleet-service` دارایی را
> **فقط با شناسه ارجاع می‌دهد** و هرگز داده اصلی دارایی را مالک نمی‌شود.

تأییدشده با بازرسی، نه با ادعا:

- صفر `import` از `services/asset-service/**` (`grep` اجرا شد)
- صفر ارجاع به `DATABASE_URL_ASSET` یا `rasta_asset`
- هیچ Foreign Key میان‌پایگاه‌داده‌ای؛ `assetId` یک ستون `String` است
- جدول `asset_ref` یک **Replica فقط‌خواندنی** از رویدادهاست (الگوی `docs/03` § ۳٫۶)
  و **هرگز** مبنای تصمیم مجوزدهی نیست

### رویدادها — تولیدشده روی `rasta.fleet.v1`

همه با Envelope استاندارد (`eventId`، `eventVersion`، `producer`،
`aggregateType`، `aggregateId`، `tenantId`، `correlationId`، `causationId`،
`traceparent`، `actor`، `payload`) و **کلید پارتیشن `assetId`**.

| رویداد                  | v   | Aggregate          | مصرف‌کنندگان                                   | هدف                            |
| ----------------------- | --- | ------------------ | ---------------------------------------------- | ------------------------------ |
| `DRIVER_REGISTERED`     | 1   | Driver             | audit · analytics                              | ثبت راننده تازه                |
| `DRIVER_STATUS_CHANGED` | 1   | Driver             | audit · analytics                              | تعلیق/فعال‌سازی — قابل حسابرسی |
| `ASSET_ASSIGNED`        | 1   | Assignment         | **asset** (پرونده + وضعیت) · analytics         | راننده دستگاه را تحویل گرفت    |
| `ASSIGNMENT_ENDED`      | 1   | Assignment         | **asset** (پرونده + بازگشت) · analytics        | دستگاه آزاد شد                 |
| `USAGE_RECORDED`        | 1   | UsageRecord        | **maintenance** · asset · economic · analytics | محرک نگهداری کارکردمحور        |
| `AVAILABILITY_CHANGED`  | 1   | AvailabilityWindow | construction · analytics                       | اعلام دستی در دسترس بودن       |

`MISSION_STARTED` / `MISSION_COMPLETED`: **DEFERRED** — به
`construction-service` گره خورده که وجود ندارد (ADR-026).

### مسیر رویداد — **LIVE VERIFIED**

```
HTTP (Gateway، توکن واقعی Keycloak)
  → fleet-service
  → PostgreSQL (تغییر وضعیت + Outbox در یک تراکنش)
  → OutboxRelay
  → Kafka (rasta.fleet.v1، کلید = assetId)
  → asset-service TimelineConsumer
  → asset_timeline_entry + تغییر OperationalStatus
```

این **دقیقاً همین مسیر** اجرا شد (بخش ۲۱، ردیف ۴ تا ۸): دارایی
`IDLE → ASSIGNED → ACTIVE` رفت، دو خط Timeline ساخته شد، و `correlationId`
از درخواست HTTP تا Header کافکا تا Timeline یکسان ماند.

### تست

| دسته             | تعداد | وضعیت                                                          |
| ---------------- | ----- | -------------------------------------------------------------- |
| Unit             | 88    | سبز — ۷ فایل                                                   |
| Integration      | 32    | سبز — ۴ Suite روی PostgreSQL و Kafka **واقعی**، بدون Mock      |
| Security/AuthZ   | —     | داخل دو دسته بالا؛ Tenant Isolation و مجوزدهی Suite جدا ندارند |
| E2E (Playwright) | ۰     | **NOT IMPLEMENTED** — بدون Config، پوشه خالی                   |

### محدودیت‌های شناخته‌شده

- `mission` پیاده نشده (**DEFERRED**، ADR-026)
- `asset_ref` در نهایت سازگار است — پنجره‌ای هست که fleet نمی‌داند دستگاهی
  تازه اسقاط شده (**OPEN**، پذیرفته‌شده در ADR-026)
- انحصار دارایی، شیفت‌بندی را ممنوع می‌کند (**OPEN** — Q-23)
- اعتبار گواهینامه ثبت می‌شود ولی اجرا نمی‌شود (**OPEN** — Q-22)
- `DELETE /v1/assignments/{id}` چیزی حذف نمی‌کند؛ مترادف `end` است

---

## ۷-ب. maintenance-service — ورودی کامل حافظه

> نوشته‌شده در پایان دروازه انتشار فاز نگهداری (2026-08-28). هر ادعا شاهد دارد.

| بُعد            | مقدار                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Service         | `maintenance-service` (`@rasta/maintenance-service`)                                                                     |
| Status          | **IMPLEMENTED · TESTED · LIVE VERIFIED · CI VERIFIED**                                                                   |
| Port            | `3105` (`PORT_MAINTENANCE`)                                                                                              |
| Database        | `rasta_maintenance` — نقش اختصاصی، بدون دسترسی به پایگاه داده هیچ سرویس دیگر                                             |
| Topic تولیدی    | `rasta.maintenance.v1` (+ `.retry`, `.dlq`)                                                                              |
| Topic مصرفی     | `rasta.fleet.v1` (کارکرد) · `rasta.asset.v1` (Replica مرجع)                                                              |
| Consumer Groups | `maintenance-service.usage` · `maintenance-service.asset-sync` — هر دو از Offset صفر                                     |
| Gateway         | **بدون تغییر.** ردیف‌های `maintenance-requests`، `maintenance-schedules` و `repair-orders` از قبل در جدول مسیریابی بودند |

### مالکیت دامنه

**مالک است:** `MaintenanceSchedule` · `MaintenanceRequest` · `RepairOrder` ·
`PartUsage` · `LaborEntry` · `MaintenanceCost` — دقیقاً همان شش جدولی که
`docs/04` § ۴٫۷ نوشته.

**مالک نیست — و این مرزها اجرا می‌شوند:**

| واقعیت           | مالک                | چطور به maintenance می‌رسد                     |
| ---------------- | ------------------- | ---------------------------------------------- |
| خود دارایی       | `asset-service`     | رویداد → `asset_ref` (Replica فقط‌خواندنی)     |
| رکورد کارکرد     | `fleet-service`     | رویداد → `asset_usage_meter` (کنتور مشتق‌شده)  |
| پروفایل تعمیرگاه | `supplier-service`  | فقط یک ارجاع `workshopOrganizationId` — نساخته |
| موجودی قطعه      | `inventory-service` | فقط `sourceReference` روی مصرف قطعه — نساخته   |
| هر حرکت پول      | `economic-service`  | `MAINTENANCE_APPROVED` — نساخته                |

تأییدشده با بازرسی، نه با ادعا:

- صفر `import` از `services/*/src/**` دیگر
- صفر ارجاع به `DATABASE_URL_ASSET`، `DATABASE_URL_FLEET` یا نام پایگاه داده دیگری
- هیچ `wallet`، `ledger`، `commission` یا `settlement` **پیاده نشده** — این
  کلمات فقط در کامنت‌هایی ظاهر می‌شوند که همین مرز را توضیح می‌دهند، و در نام یک
  تست قرارداد. (`grep` اجرا شد و خروجی‌اش خط‌به‌خط بررسی شد؛ ادعای «صفر ارجاع»
  نادرست می‌بود.)
- هیچ Foreign Key میان‌پایگاه‌داده‌ای؛ `assetId` یک ستون `String` است
- `asset_ref` و `asset_usage_meter` **هرگز** مبنای تصمیم مجوزدهی نیستند

**`asset_usage_meter` یک کپی از `UsageRecord` نیست.** تنها عدد مشتق‌شده‌ای است که
یک برنامه کارکردمحور لازم دارد — کنتور فعلی — که بدون پرسیدن از `fleet-service` در
هر ارزیابی، از هیچ راه دیگری به‌دست نمی‌آید. رکوردهای کارکرد خودشان هرگز کپی
نمی‌شوند.

### رویدادها — تولیدشده روی `rasta.maintenance.v1`

همه با Envelope استاندارد و **کلید پارتیشن `assetId`** (همان استثنای آگاهانه fleet).

| رویداد                  | v   | Aggregate           | مصرف‌کنندگان                                                    | هدف                          |
| ----------------------- | --- | ------------------- | --------------------------------------------------------------- | ---------------------------- |
| `MAINTENANCE_DUE`       | 1   | MaintenanceSchedule | notification · fleet · analytics                                | سررسید سرویس                 |
| `BREAKDOWN_REPORTED`    | 1   | MaintenanceRequest  | notification · asset · analytics                                | «چیزی خراب شد»               |
| `MAINTENANCE_CREATED`   | 1   | MaintenanceRequest  | **asset** (پرونده)                                              | «کاری وجود دارد»             |
| `WORKSHOP_ASSIGNED`     | 1   | RepairOrder         | notification · supplier                                         | ارجاع به تعمیرگاه            |
| `MAINTENANCE_STARTED`   | 1   | MaintenanceRequest  | **asset** (`IN_MAINTENANCE`) · **fleet** (`inMaintenance=true`) | خروج از سرویس                |
| `REPAIR_COMPLETED`      | 1   | RepairOrder         | asset · supplier (امتیاز)                                       | سهم یک تعمیرگاه، با هزینه‌اش |
| `MAINTENANCE_COMPLETED` | 1   | MaintenanceRequest  | **asset** (`ACTIVE`) · **fleet** (رفع مسدودی)                   | بازگشت دستگاه                |
| `MAINTENANCE_APPROVED`  | 1   | MaintenanceRequest  | **economic (مجوز تسویه)**                                       | **کنترل اجباری سند محصول**   |
| `MAINTENANCE_CANCELLED` | 1   | MaintenanceRequest  | asset · notification · audit                                    | افزوده این فاز — بخش زیر     |

**`MAINTENANCE_CANCELLED` تنها رویداد فراتر از کاتالوگ است، و قاعده‌اش این بود:**
رویداد تازه فقط برای **درست نگه داشتن ادعایی که قبلاً منتشر شده**. بدون آن، هر
مصرف‌کننده‌ای که `MAINTENANCE_CREATED` را دیده تا ابد باور می‌کند کار باز است.
برنامه سرویس رویداد ندارد، چون ساختش هرگز منتشر نشده — و همین شکاف به‌عنوان D-011
ثبت شده، نه پنهان.

**هزینه به‌صورت `totalCostMinor` (رشته، واحد فرعی) منتقل می‌شود، نه
`{ amountMinor, currency }`.** انحراف آگاهانه از قاعده پول کاتالوگ:
`TimelineConsumer` در `asset-service` پیش از ساخت این سرویس نوشته شده و فیلد مسطح
را می‌خواند و هر چیز دیگری را `null` می‌گیرد. شکل تودرتو یعنی پرونده هر دستگاه،
هزینه هر تعمیر را صفر ثبت می‌کرد.

### مسیر رویداد — **LIVE VERIFIED، هر دو جهت**

```
FLOW A  (مسیری که از روز نخست fleet مرده بود)
HTTP (Gateway، توکن واقعی Keycloak) → fleet-service
  → PostgreSQL + Outbox (یک تراکنش) → OutboxRelay → Kafka (rasta.fleet.v1)
  → maintenance-service UsageConsumer
  → asset_usage_meter (۴۳۸۰٫۵۰ → ۴۳۸۶٫۵۰) + ارزیابی برنامه
  → MAINTENANCE_DUE منتشر شد

FLOW B  (مسیری که مصرف‌کننده‌اش از روز نخست منتظر بود)
HTTP → maintenance-service
  → PostgreSQL + Outbox (یک تراکنش) → OutboxRelay → Kafka (rasta.maintenance.v1)
  → asset-service TimelineConsumer → ۳ خط Timeline + وضعیت IN_MAINTENANCE → ACTIVE
  → fleet-service AssetSyncConsumer → asset_ref.inMaintenance = true → false
```

هر دو **دقیقاً همین‌طور** اجرا شدند (بخش ۲۱-ب).

### تصمیم‌های معماری این فاز

| ADR | تصمیم                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ |
| ۰۲۷ | سررسید **در هر خواندن مشتق می‌شود**، ذخیره نمی‌شود. اعلام کارکردمحور رویدادمحور؛ اعلام زمان‌محور یک Scan محافظت‌شده به‌جای Temporal. |
| ۰۲۸ | هر خط هزینه **مبدأ** دارد؛ مجموع‌ها زیر قفل ردیف از خطوط بازمحاسبه می‌شوند؛ `MAINTENANCE_APPROVED` تفکیک حمل می‌کند.                 |
| ۰۲۹ | قواعد سطح Object برای `OPERATOR` و `WORKSHOP` **باریک‌سازی** شدند، نه تقریب — و در جهت امن.                                          |

### تست

| دسته             | تعداد | وضعیت                                                                        |
| ---------------- | ----- | ---------------------------------------------------------------------------- |
| Unit             | 102   | سبز — ۸ فایل                                                                 |
| Integration      | 41    | سبز — ۵ Suite روی PostgreSQL و Kafka **واقعی**، بدون Mock                    |
| Security/AuthZ   | —     | داخل دو دسته بالا؛ Tenant Isolation و باریک‌سازی سطح Object Suite جدا ندارند |
| E2E (Playwright) | ۰     | **NOT IMPLEMENTED** — بدون Config، پوشه خالی                                 |

پنج Suite Integration: `tenant-isolation` · `request-lifecycle` · `cost-atomicity` ·
`outbox` · `event-flow`. `test:integration` **`--passWithNoTests` ندارد.**

### محدودیت‌های شناخته‌شده

- پورتال `WORKSHOP` پیاده نشده (**DEFERRED**، ADR-029، Q-25) — نقش `WORKSHOP` در
  باریک‌سازی می‌افتد و هیچ نمی‌بیند؛ امن به‌صورت پیش‌فرض
- احراز صلاحیت تعمیرگاه بررسی نمی‌شود (**OPEN** — Q-25) — پشت Port
  `WorkshopDirectory`، که نبودِ بررسی را Log می‌کند
- قاعده «فقط دارایی تخصیص‌یافته» برای اپراتور اجرا نمی‌شود (**OPEN** — Q-24) —
  باریک‌سازی جایگزین، در جهت امن
- `PAYMENT_COMPLETED` مصرف نمی‌شود (**DEFERRED**) — `economic-service` نیست
- `MaintenanceDueScanWorkflow` در Temporal نوشته نشده (**DEFERRED**، ADR-027) —
  Scan درون‌پردازه‌ای جایش را گرفته؛ وضعیت سررسید مشتق است، پس نبودش چیزی را
  نادرست گزارش نمی‌کند
- تغییر برنامه سرویس رویداد تولید نمی‌کند (**D-011**)
- کنتور کارکرد هرگز عقب نمی‌رود؛ تعویض کنتور نیازمند Anchor دوباره است (**D-012**)
- `GetWorkshopPerformance` پیاده نشد — مال `supplier-service` است

---

## ۷-ج. economic-service — ورودی کامل حافظه

> نوشته‌شده در پایان دروازه انتشار فاز اقتصادی (2026-08-29). هر ادعا شاهد دارد.

| بُعد            | مقدار                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Service         | `economic-service` (`@rasta/economic-service`)                                                                                      |
| Status          | **IMPLEMENTED · TESTED · LIVE VERIFIED · CI VERIFIED**                                                                              |
| Port            | `3112` (`PORT_ECONOMIC`)                                                                                                            |
| Database        | `rasta_economic` — نقش اختصاصی، بدون دسترسی به پایگاه داده هیچ سرویس دیگر                                                           |
| Topic تولیدی    | `rasta.economic.v1` (+ `.retry`, `.dlq`)                                                                                            |
| Topic مصرفی     | `rasta.maintenance.v1` (تأیید + محرک پاداش) · `rasta.fleet.v1` (محرک پاداش)                                                         |
| Consumer Groups | `economic-service.settlement-authority` · `economic-service.reward-trigger` — هر دو از Offset صفر                                   |
| Gateway         | ردیف‌های `wallets`، `transactions`، `settlements`، `commissions`، `rewards`، `ledger` از قبل بودند؛ **`payment-intents` افزوده شد** |

### مالکیت دامنه

**مالک است:** `Wallet` · `WalletHold` · `LedgerAccount` · `Journal` ·
`LedgerEntry` · `Transaction` · `TransactionLeg` · `PaymentIntent` ·
`CommissionRule` · `Commission` · `RewardRule` · `Reward` · `RewardLevel` ·
`RewardBalance` · `Settlement` · `IdempotencyKey` — همان فهرست `docs/04` § ۴٫۱۴.

**مالک نیست — و این مرزها اجرا می‌شوند:**

| واقعیت               | مالک                      | چطور به economic می‌رسد                                                  |
| -------------------- | ------------------------- | ------------------------------------------------------------------------ |
| سفارش                | `marketplace-service`     | فقط `sourceReference` — نساخته                                           |
| قرارداد و صورت‌وضعیت | `contract-service`        | فقط `sourceReference` — نساخته                                           |
| هزینه تعمیر          | `maintenance-service`     | `MAINTENANCE_APPROVED` → مبلغ تأییدشده، هرگز بازمحاسبه نمی‌شود (ADR-028) |
| هویت و سازمان        | `identity`/`organization` | فقط شناسه، هرگز ردیف                                                     |
| **پول واقعی**        | **هیچ‌کس**                | ارائه‌دهنده شبیه‌سازی‌شده است (ADR-024)                                  |

تأییدشده با بازرسی، نه با ادعا:

- صفر `import` از `services/*/src/**` دیگر
- صفر ارجاع به `DATABASE_URL_*` سرویس دیگری
- هیچ Foreign Key میان‌پایگاه‌داده‌ای
- **صفر ارجاع به Redis در کل سرویس** — انحراف آگاهانه از `docs/10` § ۱۰٫۵،
  دلیلش در ADR-031
- **صفر نرخ کارمزد یا نرخ تبدیل پاداش در کد یا Seed** — `grep` اجرا شد

### پنج ماژول ADR-013، به‌علاوه دو

`wallet` · `ledger` · `payment` · `commission` · `reward` — دقیقاً همان‌طور که
ADR-013 خواسته، هرکدام با Interface داخلی و بدون Join میان‌ماژولی. دو پوشه
افزوده:

- `transaction/` — تعهدی که هر پنج ماژول رویش کار می‌کنند، با ماشین حالت صریح
- `settlement/` — فرآیندی که ADR-031 حاکم بر آن است
- `shared/` — Value Objectهای مالی و Idempotency

اینها دامنه تازه نیستند؛ درزهایی‌اند که پیش‌تر بی‌نام بودند.

### تصمیم‌های معماری این فاز

| ADR | تصمیم                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ۰۳۰ | `ledger_entry` **پارتیشن‌بندی نشده**. جدول پارتیشن‌بندی‌شده بدون پارتیشن ماه جاری، `INSERT` را رد می‌کند و هیچ ساز‌و‌کار خودکار ساختش اینجا نیست. شرط فعال‌سازی یک **عدد** است، نه یادداشت.     |
| ۰۳۱ | تسویه **یک تراکنش ACID** است، نه Saga — چون خودِ `docs/10` جبران خودکار را ممنوع کرده. قفل کیف پول‌ها به ترتیب صعودی `id`؛ Deadlock ساختاراً غیرممکن. **Redis در هیچ مسیر مالی نیست.**          |
| ۰۳۲ | فقط رویدادهایی مصرف می‌شوند که قراردادشان واقعاً تعریف شده. `ORDER_*` موکول است — نه چون تولیدکننده نیست، بلکه چون نوشتنش یعنی اختراع Payload سرویس دیگری. **و یک تأیید، پول را حرکت نمی‌دهد.** |
| ۰۳۳ | پاداش همیشه امتیاز می‌دهد؛ ارزش ریالی فقط با `creditPerPointMinor` پیکربندی‌شده. پاداش امتیازی **هیچ Journal نمی‌زند** — یک ورودی صفر `CHECK` را می‌شکند و چیزی نمی‌گوید.                       |
| ۰۳۴ | **حل تناقض میان بند ۱۰٫۳ و بند ۱۰٫۴.** امانت به‌ازای هر سازمان (`LIAB-<ORG>-ESCROW`)، و هر سه مانده از دفتر کل بازمحاسبه می‌شوند، نه افزایش تدریجی.                                             |

### آنچه پایگاه داده تحمیل می‌کند، نه کد

این مهم‌ترین بخش این ورودی است. هرچه می‌شد به محدودیت تبدیل کرد، شد:

| محدودیت                                       | چه چیزی را غیرممکن می‌کند                                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `trg_ledger_entry_immutable`                  | `UPDATE`/`DELETE` روی ورودی Post‌شده — **حتی از SQL خام**                                 |
| `trg_journal_immutable`                       | همان، برای Header. افزوده بر `docs/05`: Header تغییرپذیر روی خطوط تغییرناپذیر یک شکاف است |
| `trg_journal_balanced` (معوق)                 | Journal نامتوازن یا تک‌خطی، در `COMMIT`. معوق، چون خطوط در چند دستور درج می‌شوند          |
| `ck_wallet_balances`                          | **خرج بیش از موجودی.** بررسی Application فقط پیام خطا می‌سازد                             |
| `fk_ledger_entry_account_identity`            | ورودی با ارز یا سازمانِ ناسازگار با حسابش — هر دو شکست بی‌صدا                             |
| `uq_wallet_hold_active_reference`             | دو Hold زنده برای یک تعهد؛ دو Retry هم‌زمان، یک Hold                                      |
| `journal_reverses_id_key`                     | معکوس کردن یک Journal دو بار                                                              |
| `ck_reward_monetisation`                      | پرچم `monetised` که دروغ بگوید                                                            |
| `ck_commission_rule_rate`                     | نرخ خارج از ۰ تا ۱۰٬۰۰۰ Basis Point                                                       |
| `transaction(organizationId, idempotencyKey)` | تراکنش تکراری با یک کلید                                                                  |

### رویدادها — تولیدشده روی `rasta.economic.v1`

هر یازده رویداد کاتالوگ (`docs/07` § ۷٫۵)، همه با Envelope استاندارد، همه
اعتبارسنجی‌شده **پیش از** رسیدن به Outbox، و همه در `NEVER_AUTO_REPLAY`:

`WALLET_OPENED` · `FUNDS_HELD` · `FUNDS_RELEASED` · `PAYMENT_AUTHORIZED` ·
`PAYMENT_COMPLETED` · `PAYMENT_FAILED` · `COMMISSION_APPLIED` ·
`REWARD_GRANTED` · `REWARD_LEVEL_CHANGED` · `SETTLEMENT_COMPLETED` ·
`JOURNAL_POSTED`

**کلید پارتیشن رویدادهای یک تراکنش، خودِ `transactionId` است** — نه شناسه
Commission یا Settlement — تا مصرف‌کننده‌ای که یک تراکنش را بازسازی می‌کند
ترتیب را از دست ندهد.

سه فیلد که در کاتالوگ اولیه نبودند و عمداً افزوده شدند، چون نبودشان مصرف‌کننده
را به حدس زدن وامی‌داشت:

- `simulated` روی هر رویداد پرداخت (ADR-024 — سکوت خودش یک ادعاست)
- `resolution` روی `FUNDS_RELEASED` (آزادسازی در برابر بازگشت وجه)
- `monetised` روی `REWARD_GRANTED` (امتیازی در برابر پولی‌شده)

### مصرف — فعال در برابر موکول (ADR-032)

**فعال:** `MAINTENANCE_APPROVED` (تعهد قابل تسویه، **بدون حرکت پول**) ·
`USAGE_RECORDED` و `MAINTENANCE_COMPLETED` (محرک پاداش).

**موکول و نام‌دار:** `ORDER_CREATED` · `ORDER_RECEIPT_CONFIRMED` ·
`ORDER_CANCELLED` · `ORDER_DISPUTED` · `STATEMENT_APPROVED` ·
`PURCHASE_ORDER_ISSUED` · `GOODS_RECEIVED`.

**هیچ‌کدام Stub ندارند.** یک Handler خالی در `processed_event` رد می‌گذارد و
دقیقاً شبیه یکی است که کار کرد. کل چرخه Hold ← تسویه ← کارمزد ← پاداش از راه
**API** در دسترس و تست‌شده است — که همان چیزی است که `docs/08` § ۸٫۶ به‌شکل
Activity می‌خواهد.

### مسیر رویداد — **LIVE VERIFIED، هر دو جهت**

```
FLOW A  (مسیری که از فاز نگهداری مرده بود)
HTTP (Gateway، توکن واقعی) → maintenance-service → Outbox → Kafka
  → economic-service SettlementAuthorityConsumer
  → Transaction(PENDING_SETTLEMENT)، صفر Journal، صفر تغییر مانده
  → Replay همان رویداد = بدون اثر دوم
  → انتشار دوباره با eventId تازه = همچنان یک تعهد

FLOW B  (مصرف‌کننده‌هایش هنوز ساخته نشده‌اند، اما قرارداد اکنون واقعی است)
HTTP → economic-service → PostgreSQL + Outbox (یک تراکنش) → OutboxRelay
  → Kafka (rasta.economic.v1): WALLET_OPENED، PAYMENT_AUTHORIZED،
    PAYMENT_COMPLETED، FUNDS_HELD، JOURNAL_POSTED، COMMISSION_APPLIED،
    FUNDS_RELEASED، SETTLEMENT_COMPLETED
```

### تست

| دسته             | تعداد | وضعیت                                                                |
| ---------------- | ----- | -------------------------------------------------------------------- |
| Unit             | 239   | سبز — ۱۱ فایل                                                        |
| Integration      | 100   | سبز — ۹ Suite روی PostgreSQL و Kafka **واقعی**، بدون Mock            |
| Security/AuthZ   | —     | داخل دو دسته بالا؛ `access.spec.ts` و `tenant-isolation.int-spec.ts` |
| E2E (Playwright) | ۰     | **NOT IMPLEMENTED** — بدون Config، پوشه خالی (بخش ۲۲، بدهی باز)      |

نُه Suite یکپارچگی، سازمان‌یافته حول جدول اجباری `docs/10` § ۱۰٫۱۲ — نه حول
ساختار کد، چون همان جدول دروازه Merge است: `ledger-immutability` ·
`financial-consistency` · `wallet-concurrency` · `idempotency` ·
`settlement-atomicity` · `reward-cap` · `outbox` · `tenant-isolation` ·
`event-flow`.

`test:integration` **`--passWithNoTests` ندارد.**

### سه نقصی که تست‌ها گرفتند، نه بازبینی

1. **تراکنش تودرتوی Prisma.** `TransactionService.create` وقتی کیف پول هنوز
   وجود نداشت، `getOrOpen` را **داخل** تراکنش صدا می‌زد؛ Prisma تراکنش تودرتو
   را روی Connection دیگری اجرا می‌کند، پس تراکنش داخلی روی قفل‌هایی که بیرونی
   گرفته منتظر می‌ماند. تست همروندی گرفتش.
2. **نمای دریافت‌کننده که همیشه خالی بود.** فهرست تسویه، Filter نگهبان مستأجر
   را با Filter دریافت‌کننده AND می‌کرد — یعنی تسویه‌ای می‌خواست که پرداخت‌کننده
   و دریافت‌کننده‌اش یکی باشند، که `ck_settlement_distinct_parties` غیرممکنش
   کرده.
3. **گزارش شکست ناخوانا.** `jest-worker` نتایج را با `JSON.stringify` می‌فرستد،
   پس نخستین ادعای شکست‌خورده روی پول به‌جای خودِ شکست، «cannot serialize a
   BigInt» گزارش می‌شد. در سرویسی که هر مبلغش `bigint` است، این یعنی نخستین
   Regression واقعی ناخوانا می‌رسید.

### محدودیت‌های شناخته‌شده

- **پرداخت شبیه‌سازی‌شده است** (ADR-024، Q-01، Q-14). هیچ بانک، هیچ PSP، هیچ
  نگهداری وجه. `simulated: true` روی هر ردیف، رویداد و پاسخ.
- **هیچ نرخ کارمزدی پیکربندی نشده** (Q-08) — هر تسویه با کارمزد صفر و
  `commissionRuleMatched: false` انجام می‌شود. این وضعیت **درست** MVP است.
- **هیچ نرخ تبدیل پاداشی پیکربندی نشده** (Q-09) — پاداش امتیازی است و Journal
  نمی‌زند (ADR-033).
- **سطوح پاداش هیچ مزیتی ندارند** (Q-13) — محاسبه می‌شوند، رویداد منتشر می‌شود،
  هیچ‌چیز اعطا نمی‌شود.
- `ledger_entry` **پارتیشن‌بندی نشده** (D-013، ADR-030)
- **تسویه در Temporal نیست** (D-014، ADR-031) — یک تراکنش ACID با ماشین حالت صریح
- **مصرف‌کننده‌های `ORDER_*` و `STATEMENT_APPROVED` موکول** (D-015، ADR-032)
- `LedgerBalanceAudit` **درون‌پردازه‌ای** است، نه `LedgerBalanceAuditWorkflow` در
  Temporal. **گزارش می‌دهد، هرگز اصلاح نمی‌کند** — کیف پولی که با دفتر کل
  نمی‌خواند، یک حادثه برای انسان است، نه عددی که بی‌صدا درست شود.
- **پاداش روی تسویه فعال نیست.** قلاب هست و صدا زده می‌شود، اما هیچ قاعده‌ای
  علیه `SETTLEMENT_COMPLETED` پیکربندی نشده، چون `docs/10` § ۱۰٫۸ «پول گرفتن» را
  در فهرست رفتارهای امتیازآور ندارد و اختراعش یعنی اختراع یک انگیزه.

---

## ۸. Domain Ownership

| دامنه                                   | سرویس مالک             | یادداشت                                                 |
| --------------------------------------- | ---------------------- | ------------------------------------------------------- |
| User، Membership، Role                  | `identity-service`     | User مستأجر-محدود **نیست**؛ Membership هست              |
| Organization، Hierarchy، Policy         | `organization-service` | `ltree` برای سلسله‌مراتب                                |
| Asset، Insurance، Inspection، Timeline  | `asset-service`        | مرکز الگوی Asset-Centric (ADR-012)                      |
| Driver، Assignment، Usage، Availability | `fleet-service`        | نخستین مصرف‌کننده واقعی رویدادهای Asset                 |
| Schedule، Request، RepairOrder، Cost    | `maintenance-service`  | نخستین سرویسی که مبلغی می‌سازد که کسی بابتش پول می‌گیرد |
| ۱۰ دامنه دیگر                           | سرویس‌های نساخته       | نگاه کنید `docs/04-service-decomposition.md`            |

**مالکیت «در دسترس بودن» تقسیم‌شده است** (ADR-026). `fleet-service` آن را
**ترکیب می‌کند، نه مالکیت**:

| واقعیت                    | مالک                  | چطور به fleet می‌رسد                                               |
| ------------------------- | --------------------- | ------------------------------------------------------------------ |
| وضعیت چرخه عمر دارایی     | `asset-service`       | رویداد → `asset_ref.status`                                        |
| بیمه منقضی / معاینه مردود | `asset-service`       | رویداد → `dispatchBlockedReason`                                   |
| دستگاه در تعمیرگاه        | `maintenance-service` | رویداد → `inMaintenance` — **از 2026-08-28 تولیدکننده واقعی دارد** |
| تخصیص فعال                | `fleet-service`       | جدول `assignment` خودش                                             |
| اعلام دستی                | `fleet-service`       | جدول `availability_window`                                         |

`GET /v1/fleet/availability` برای هر مانع **مالکش را نام می‌برد**، تا اپراتور
بداند به تعمیرگاه زنگ بزند یا بیمه را تمدید کند.

قاعده تغییرناپذیر: **یک سرویس هرگز پایگاه داده سرویس دیگر را نمی‌خواند.**
تأیید زنده: `psql` با نقش `rasta_asset` تلاش برای اتصال به `rasta_organization`
→ `permission denied for database` (بخش ۳).

---

## ۹. Data Ownership

هر سرویس پیاده‌شده پایگاه داده و نقش PostgreSQL اختصاصی خودش را دارد
(`infrastructure/docker/postgres/00-init-databases.sh` — ۱۶ نقش/پایگاه‌داده
برای همه ۱۶ سرویس، از قبل ساخته شده، حتی برای سرویس‌های نساخته). `REVOKE ALL
FROM PUBLIC` روی هر پایگاه داده. Extension ها (`postgis`, `ltree`, `pg_trgm`,
`pgcrypto`) در `template1` نصب شده‌اند تا Shadow DB های Prisma هم آن‌ها را
داشته باشند.

Migration State: هر سه سرویس پیاده‌شده دقیقاً **یک** Migration دارند
(`..._init_<service>`) — یعنی Schema هرکدام یک‌باره کامل طراحی و اعمال شده،
هنوز هیچ Migration تکاملی (`add_*`) روی هیچ‌کدام اجرا نشده.

---

## ۱۰. Multi-Tenancy Model

مکانیزم: Prisma Client Extension (`createTenantGuardExtension`,
`packages/nest-common/src/tenancy/tenant-guard.extension.ts`) که خودکار
`organizationId` را به هر Query تزریق می‌کند. خروج از این محدودیت فقط با
`runUnscoped(reason, fn)` — با دلیل نوشته‌شده اجباری (حداقل ۱۰ کاراکتر) —
ممکن است، که هر مورد را Greppable می‌کند.

**قاعده پاسخ:** خواندن میان‌مستأجری → **۴۰۴**، نه ۴۰۳ — تا وجود رکورد در
مستأجر دیگر فاش نشود. Header نادرست `X-Organization-Id` → **۴۰۳
TENANT_MISMATCH** (چون کاربر می‌داند عضو کدام سازمان‌هاست، فقط اجازه یکی
غلط را ندارد).

**باگ کشف و رفع‌شده این جلسه (D-003، بخش ۲۳):** `runUnscoped` به‌خاطر تنبلی
Promise های Prisma، Scope را زودتر از موعد می‌بست و Query واقعاً بدون آن اجرا
می‌شد — شکست بی‌صدا. رفع شد؛ اکنون تست شده با یک Thenable ساختگی.

---

## ۱۱. Authentication & Authorization

- **احراز هویت کاربر:** Keycloak → JWT (RS256) → `TokenVerifier` با JWKS
  (`packages/nest-common/src/auth/token-verifier.ts`). ادعای سفارشی
  `rasta_uid` چون `sub` توکن، UUID کی‌کلوک است نه `User.id` داخلی.
- **احراز هویت سرویس‌به‌سرویس:** `x-internal-token` HS256، کوتاه‌عمر، به
  یک سرویس مقصد محدود (`InternalTokenService`). فقط روی Endpoint هایی که
  `@AllowService(...)` صریح دارند پذیرفته می‌شود؛ Endpoint بدون این
  Decorator، حتی با توکن معتبر، `403 "not callable by another service"`
  می‌دهد (Zero Trust، ADR-020).
- **RBAC:** `RolesGuard` + `@Roles(...)` سطح Endpoint (فیلتر درشت)؛
  هر سرویس دوباره در سطح Object بررسی می‌کند (`AGENTS.md` A-10).
- **Purpose توکن داخلی (رفع D-007، 2026-08-27):** توکن داخلی یک Claim
  `purpose` دارد با دو مقدار:
  - **`RELAY`** — `api-gateway` درخواست کسی دیگر را Forward می‌کند.
    Gateway **همیشه** همین را صادر می‌کند و هرگز از طرف خودش عمل نمی‌کند.
    `AuthGuard` این توکن را کامل اعتبارسنجی می‌کند اما آن را «اثبات Hop»
    می‌خواند نه «هویت بازیگر»؛ پس اگر درخواست اصلی Bearer نداشته،
    **گمنام** می‌ماند و `@Public()` درباره‌اش تصمیم می‌گیرد.
  - **`SERVICE`** — سرویس A از طرف خودش سرویس B را صدا می‌زند. همان قاعده
    قبلی: `@AllowService(...)` لازم است، وگرنه `403`. توکن بدون Claim هم
    `SERVICE` خوانده می‌شود (سازگاری رو به عقب، سخت‌گیرانه‌ترین قرائت).

  این تفکیک، Zero Trust را **سفت‌تر** کرد نه شل‌تر: توکن `RELAY` هرگز
  `@AllowService` را ارضا نمی‌کند، Gateway دیگر نمی‌تواند توکنی با اقتدار
  سرویس بسازد، و توکن داخلی حتی روی Endpoint عمومی هم اعتبارسنجی می‌شود —
  یک توکن جعلی روی `POST /v1/registration-requests` اکنون
  `401 TOKEN_INVALID` می‌گیرد. جزئیات کامل و جدول تأیید زنده: `docs/23`
  بخش D-007.

---

## ۱۲. Event Architecture

- Envelope واحد (`packages/contracts/src/events/envelope.ts`):
  `eventId, eventName, eventVersion, occurredAt, producer, aggregateType,
aggregateId, tenantId, correlationId, causationId, traceparent, actor, payload`.
- Topic هر دامنه: `rasta.<domain>.v1` (+ `.retry` و `.dlq`). امروز
  `asset`, `insurance`, `fleet` و **`maintenance`** تولیدکننده واقعی دارند؛
  `marketplace` و `construction` هنوز فقط مصرف‌شونده‌اند (توسط asset-service). ۴۹ Topic از قبل در Kafka ساخته شده
  (`infrastructure/docker/kafka/create-topics.sh`) — بقیه خالی منتظرند.
- کاتالوگ کامل رویدادها: [`docs/events/README.md`](docs/events/README.md) —
  این جلسه با کد Sync شد (۵ رویداد گم‌شده اضافه، نام فیلدهای غلط اصلاح).

---

## ۱۳. Outbox / DLQ

- **Producer:** `buildOutboxRow` + جدول `outbox_message` در همان Transaction
  نوشتن دامنه؛ `OutboxRelay` با Polling، `FOR UPDATE SKIP LOCKED`، منتشر به
  Kafka با `acks=-1`، `idempotent=true`، `maxInFlightRequests=1`.
- **Consumer (این جلسه اضافه شد):** `EventConsumer`
  (`packages/nest-common/src/consumer/event-consumer.ts`) — At-Least-Once؛
  پیام غیرقابل‌تجزیه یا نامعتبر مستقیم به DLQ؛ Handler شکست‌خورده تا ۳ بار
  Retry با Backoff، سپس DLQ با Header های `x-dlq-reason/original-topic/
attempts/error/first-failed-at`. هرگز Offset را بدون رسیدگی Commit
  نمی‌کند — یک Partition گیر‌کرده قابل مشاهده و بازیابی است؛ یک رویداد مالی
  گم‌شده نیست.
- **Idempotency سمت مصرف:** جدول `processed_event` + `markEventProcessed`
  در همان Transaction اثر کسب‌وکاری — زنده تأیید شد (بخش ۳: Replay رویداد
  یکسان → دقیقاً یک خط Timeline).

---

## ۱۴. Asset-Centric Model

جزئیات کامل در بخش ۱۸ (Asset Service Memory).

---

## ۱۵. Current API Surface

### identity-service (`3101`)

```
GET    /v1/users/me
POST   /v1/users/me/active-organization
GET    /v1/users              GET /v1/users/:id
POST   /v1/users              PATCH /v1/users/:id
POST   /v1/users/:id/memberships
POST   /v1/memberships/:id/roles      POST /v1/memberships/:id/revoke
POST   /v1/registration-requests (Public)
POST   /v1/registration-requests/:id/approve   .../reject
```

### organization-service (`3102`)

```
GET  /v1/organizations                GET /v1/organizations/nearby
GET  /v1/organizations/:id            GET /v1/organizations/:id/children
GET  /v1/organizations/:id/ancestors  GET /v1/organizations/:id/subtree
GET  /v1/organizations/:id/policies
POST /v1/organizations                PATCH /v1/organizations/:id
POST /v1/organizations/:id/move       POST /v1/organizations/:id/status
POST /v1/organizations/:id/policies   POST /v1/organizations/:id/locations
POST /v1/organizations/:id/contacts
```

### asset-service (`3103`)

```
GET  /v1/assets                       GET /v1/assets/nearby
GET  /v1/assets/:id                   GET /v1/assets/:id/dossier
GET  /v1/assets/:id/timeline          GET /v1/assets/:id/insurance-policies
GET  /v1/assets/:id/inspections
POST /v1/assets                       PATCH /v1/assets/:id
POST /v1/assets/:id/activate          POST /v1/assets/:id/status
POST /v1/assets/:id/transfer          POST /v1/assets/:id/decommission
POST /v1/assets/:id/locations         POST /v1/assets/:id/documents
POST /v1/assets/:id/insurance-policies
POST /v1/assets/:id/inspections
```

هیچ Endpoint ای برای `InsuranceClaim` نیست — جدول در Migration هست، بدون
Controller/Service (بخش ۱۸، Gap).

### fleet-service (`3104`)

```
POST /v1/drivers                     GET  /v1/drivers
GET  /v1/drivers/me                  GET  /v1/drivers/:id
PATCH /v1/drivers/:id                POST /v1/drivers/:id/status
GET  /v1/drivers/:id/assignments

POST /v1/assignments                 GET  /v1/assignments
GET  /v1/assignments/:id             POST /v1/assignments/:id/end
DELETE /v1/assignments/:id           (مترادف end)

POST /v1/usage-records               GET  /v1/usage-records
GET  /v1/usage-records/:id

GET  /v1/fleet/availability          POST /v1/fleet/availability
POST /v1/fleet/availability/:id/revoke
GET  /v1/fleet/utilization
```

**انحراف آگاهانه از `docs/04` § ۴٫۶** (ADR-026): آن سند
`POST /v1/assets/{id}/assignments` و `.../usage` را نوشته بود، اما Gateway از
**نخستین قطعه مسیر** مسیریابی می‌کند و `assets/` مال `asset-service` است. منابع
به Prefix های خود fleet منتقل شدند؛ یک ردیف به جدول مسیریابی Gateway افزوده شد
(`usage-records`).

### maintenance-service (`3105`)

```
POST  /v1/maintenance-schedules        GET   /v1/maintenance-schedules
GET   /v1/maintenance-schedules/due    GET   /v1/maintenance-schedules/:id
PATCH /v1/maintenance-schedules/:id    POST  /v1/maintenance-schedules/:id/status

POST  /v1/maintenance-requests         GET   /v1/maintenance-requests
GET   /v1/maintenance-requests/:id
POST  /v1/maintenance-requests/:id/assign
POST  /v1/maintenance-requests/:id/approve
POST  /v1/maintenance-requests/:id/cancel

GET   /v1/repair-orders                GET   /v1/repair-orders/:id
POST  /v1/repair-orders/:id/start      POST  /v1/repair-orders/:id/complete
POST  /v1/repair-orders/:id/cancel
POST  /v1/repair-orders/:id/parts      POST  /v1/repair-orders/:id/labour
POST  /v1/repair-orders/:id/costs
```

**بدون هیچ تغییری در `api-gateway`.** برخلاف fleet که یک ردیف مسیریابی لازم داشت،
هر سه Prefix این سرویس (`maintenance-schedules`، `maintenance-requests`،
`repair-orders`) از زمان نوشتن جدول مسیریابی در آن بودند. «تاریخچه نگهداری یک
دستگاه» یک مسیر جدا ندارد؛ `GET /v1/maintenance-requests?assetId=` همان است — چون
Gateway از نخستین قطعه مسیر مسیریابی می‌کند و `assets/` مال `asset-service` است
(همان استدلال ADR-026).

### api-gateway (`3010` محلی)

یک مسیر Catch-all (`ALL /v1/*path`) که طبق `ROUTES` در
`services/api-gateway/src/config/routes.ts` به سرویس درست Forward می‌کند.
جدول کامل ۳۲ Prefix برای ۱۶ سرویس در آن فایل — اکثر آن‌ها به سرویسی اشاره
می‌کنند که هنوز وجود ندارد (به‌درستی `503 UPSTREAM_UNAVAILABLE` می‌دهد،
زنده تأیید شد).

منبع واقعی API: خود کد Controller بالا؛ `docs/api/README.md` فقط ساختار
تولید OpenAPI را توضیح می‌دهد، فایل‌های `*.openapi.json` تولید نشده‌اند.

---

## ۱۶. Current Database State

۵ پایگاه داده فعال با داده واقعی (از `pnpm db:seed`):

- `rasta_identity` — ۴ کاربر Seed + Membership + Role
- `rasta_organization` — ۵ سازمان (Province → Union/County → 2× Dehyari)
- `rasta_asset` — ۵ دارایی، ۳ بیمه‌نامه، ۲ معاینه فنی
- `rasta_fleet` — راننده، تخصیص، کارکرد و Replica دارایی
- `rasta_maintenance` — ۳ برنامه سرویس، ۲ درخواست (یکی تأییدشده با ۵ خط هزینه)،
  ۳ کنتور کارکرد، ۴ ردیف Replica دارایی

مدل‌های هر Schema: بخش ۷ Service Inventory بالا برای شمارش کلی؛ فهرست کامل
مدل‌ها در `prisma/schema.prisma` هر سرویس.

**۱۱ پایگاه داده دیگر** طبق `00-init-databases.sh` ساخته شده‌اند (نقش +
Database خالی، بدون Schema) — منتظر سرویس‌های نساخته.

---

## ۱۷. Infrastructure

`docker-compose.yml` — پیش‌فرض (`pnpm infra:up`) این ۷ را بالا می‌آورد:
`postgres, redis, kafka, kafka-init, keycloak, minio, minio-init, temporal`.
دو Profile اختیاری: `tools` (kafka-ui, temporal-ui, mailpit) و
`observability` (otel-collector, prometheus, grafana) + `search`
(opensearch) — همگی پیاده‌سازی‌شده اما پیش‌فرض بالا نمی‌آیند.

**⚠️ یافته جدید این جلسه (D-006، بخش ۲۳):** یک نصب **Native Redis روی
Windows** (`C:\Program Files\Redis\redis-server.exe`) هم‌زمان روی پورت
`6379` گوش می‌دهد — دقیقاً همان الگوی تصادم پورتی که قبلاً برای PostgreSQL
مستند شده بود (D-002 قدیمی، حل‌شده با انتقال به ۵۴۳۳). این یکی حل نشده.
شواهد کامل و اثر آن روی Rate Limiting در بخش ۲۳.

**وضعیت مشاهده‌شده زیرساخت (2026-08-28، `docker ps`):**

| سرویس    | وضعیت       | یادداشت                                           |
| -------- | ----------- | ------------------------------------------------- |
| postgres | **HEALTHY** | ۵ ساعت پایدار                                     |
| redis    | **HEALTHY** | مصرف‌کننده: فقط `api-gateway`                     |
| kafka    | **HEALTHY** | ۶ Topic ناوگان/دارایی ساخته شده                   |
| keycloak | **HEALTHY** | ۴ کاربر Seed؛ `dehyari.admin` بازیابی شد (بخش ۲۲) |
| minio    | **HEALTHY** | **NOT USED** — هیچ سرویسی هنوز لمسش نمی‌کند       |
| temporal | **HEALTHY** | **NOT USED** — هیچ Workflow ای نوشته نشده         |

**✅ D-009 رفع شد (2026-08-28).** `rasta-temporal` اکنون `healthy` است با
`FailingStreak: 0`، و — که مهم‌تر است — `docker exec rasta-temporal temporal
--version` دیگر Hang نمی‌کند و پاسخ می‌دهد:

```
temporal version 0.0.0-DEV (Server 1.26.2-125.1, UI 2.32.0)
```

یعنی ثبت پیشین که «باینری `temporal` داخل Image روی این میزبان اجرا نمی‌شود»
**پیامد خرابی محیط Docker بود (D-010)، نه نقص Image**. پس از بازسازی محیط، هم
Healthcheck و هم CLI درست کار می‌کنند. این بار **مثبتاً تأیید شده**، نه
مشاهده‌شده.

پنج سرویس دیگر (`postgres, redis, kafka, keycloak, minio`) `healthy` بودند
و ۱۷+ ساعت پایدار ماندند.

---

## ۱۸. Observability

`packages/observability` — OpenTelemetry (`RastaSampler` هرگز Span های
علامت‌خورده مالی را Drop نمی‌کند)، Prometheus (`prom-client`,
`normalizeRoute` برای جمع کردن ID ها)، pino با Redaction
(`packages/logging`, `SENSITIVE_KEYS`). هر ۴ سرویس پیاده‌شده `/health/live`
و `/health/ready` و `/metrics` دارند — زنده تأیید شد (بخش ۳).

Stack مشاهده‌پذیری (Grafana/Prometheus/OTel Collector) پیاده‌سازی شده اما
Profile اختیاری است و در این Audit بالا آورده **نشد** — بنابراین Dashboard
های واقعی مشاهده نشده‌اند؛ فقط `/metrics` خام هر سرویس بررسی شد.

---

## ۱۹. Testing State

### 2026-08-29 — پس از فاز اقتصادی

| دسته                 | عدد                                                              |
| -------------------- | ---------------------------------------------------------------- |
| Unit در کل Monorepo  | **۶۵۴** (۴۱۵ پیشین + ۲۳۹ economic)                               |
| Integration در کل    | **۱۷۳** (۷۳ پیشین + ۱۰۰ economic) — روی PostgreSQL و Kafka واقعی |
| Suiteهای Integration | ۱۸ (fleet ۴، maintenance ۵، **economic ۹**)                      |
| E2E (Playwright)     | ۰ — همچنان بدهی باز                                              |

سرویس‌هایی که `test:integration` شان `--passWithNoTests` **ندارد**: `fleet`،
`maintenance`، `economic`.

### واقعی، از اجرای پیشین `pnpm verify` (نه از حافظه سند قدیمی):

```
@rasta/config                11 تست
@rasta/logging                9 تست
@rasta/observability         10 تست
@rasta/nest-common           56 تست
@rasta/api-gateway           30 تست
@rasta/identity-service      14 تست
@rasta/organization-service  21 تست
@rasta/asset-service         74 تست
@rasta/fleet-service         88 تست
@rasta/maintenance-service  102 تست   ← فاز نگهداری
———————————————————————————————
مجموع Unit                  415 تست، همه سبز
مجموع Integration            73 تست، همه سبز (fleet ۳۲، maintenance ۴۱)
E2E                           NOT IMPLEMENTED — بدون Playwright، پوشه خالی
```

از `pnpm verify` و `pnpm --filter @rasta/<service> test:integration`، اجراشده در
2026-08-28. اعداد از خروجی واقعی گرفته شده، نه از گزارش پیشین.

هر ۴۱۵ عدد روی Runner واقعی GitHub هم دیده شد — **Run `33172549841`،
Commit `24bef76`** — پس این شمارش دیگر فقط محلی نیست.

**Integration Tests — دو سرویس.** `fleet-service` (۴ Suite) و
`maintenance-service` (۵ Suite):

| Suite                                | چه چیزی را ثابت می‌کند                                                     |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `tenant-isolation.int-spec.ts`       | Extension واقعاً `where` را بازنویسی می‌کند؛ نوشتن میان‌تنانتی رد می‌شود   |
| `assignment-concurrency.int-spec.ts` | Partial Unique Index وجود دارد و دو درخواست هم‌زمان را به یکی می‌رساند     |
| `usage-outbox.int-spec.ts`           | تغییر وضعیت و Outbox با هم Commit می‌شوند؛ Replay رویداد دوم منتشر نمی‌کند |
| `event-flow.int-spec.ts`             | مسیر کامل تا Kafka و بازگشت از Consumer، با Envelope و correlationId       |

و در `services/maintenance-service/test/`:

| Suite                           | چه چیزی را ثابت می‌کند                                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `tenant-isolation.int-spec.ts`  | Extension واقعاً `where` را بازنویسی می‌کند؛ نوشتن میان‌تنانتی رد می‌شود؛ **اپراتور گزارش همکارش را در همان تنانت نمی‌بیند** |
| `request-lifecycle.int-spec.ts` | منع درخواست تکراری زیر مسابقه واقعی؛ دو تأیید هم‌زمان → یک رویداد؛ گذارهایی که جدول ممنوع کرده                               |
| `cost-atomicity.int-spec.ts`    | **ده ثبت هزینه هم‌زمان، مجموع دقیقاً برابر `SUM` پایگاه داده**؛ `ck_cost_provenance` خط بی‌مبدأ را رد می‌کند                 |
| `outbox.int-spec.ts`            | تغییر وضعیت و Outbox با هم Commit می‌شوند؛ Rollback هر دو را می‌برد؛ تفکیک هزینه روی رویداد تأیید                            |
| `event-flow.int-spec.ts`        | پیام واقعی `USAGE_RECORDED` روی Topic واقعی fleet → کنتور → `MAINTENANCE_DUE`؛ و تعمیر از Outbox تا Consumer کافکا           |

دو تغییر عمدی در Script ها:

- **`test:integration` در fleet `--passWithNoTests` ندارد.** حذف آخرین فایل
  `test/` از این پس Build را می‌شکند — دقیقاً همان شکستی که این Repository
  قبلاً تجربه کرد.
- **`test` در fleet فقط Project `unit` را اجرا می‌کند**، تا `pnpm verify` روی
  ماشین بدون Docker قابل اجرا بماند. Suite Integration یک دروازه جدا است که CI
  صریحاً در برابر سرویس‌های Provision‌شده اجرا می‌کند.

**وضعیت اجرا:** **۷۳ از ۷۳ سبز** روی PostgreSQL و Kafka واقعی (2026-08-28).

Suite ناوگان در نخستین اجرای واقعی‌اش **پنج باگ** گرفت که هیچ‌کدام با تست واحد
پیدا نمی‌شد — سه‌تا در کد تولیدی و دوتا در خود تست‌ها. فهرست کامل در بخش ۲۲.

Suite نگهداری در نخستین اجرا **هیچ باگ تولیدی نگرفت** — چون درس‌های همان پنج باگ
از ابتدا اعمال شده بودند: هیچ ستون زمانی کسب‌وکاری `@default(now())` ندارد، ترجمه
نقض Constraint روی **نام ستون** تطبیق می‌دهد نه نام Index، و `asActor` از همان روز
اول `async () => fn()` بود. **این نبودِ باگ، شاهدِ کارکردنِ حافظه پروژه است، نه
شاهدِ تست ضعیف‌تر:** تنها شکست آن اجرا یک ادعای نادرست در خودِ تست بود
(`dueBy` باید هنگام `NOT_DUE` هم گزارش شود).
همچنین هر دو Partial Unique Index و هر شش CHECK Constraint با پرس‌وجوی مستقیم
از `pg_indexes` و `pg_constraint` در پایگاه داده دیده شدند.

**E2E Tests:** `tests/e2e/` پوشه‌ای خالی است، بدون `playwright.config.ts`.
`pnpm test:e2e` هست اما `turbo run test:e2e` روی هیچ Package ای Script
واقعی ندارد.

### ✅ CI/CD — **CI VERIFIED** (به‌روزشده برای فاز اقتصادی)

**آخرین اجرا: Run `33219920446`، Commit `a36a2cf` روی `main`، هر ۹ Job سبز.**

```
✓ Lint, types and unit tests            2m33s
✓ Security scans                        1m13s
✓ Integration and security tests        4m18s
✓ Build and scan images (identity)      3m51s
✓ Build and scan images (organization)  4m29s
✓ Build and scan images (fleet)         3m47s
✓ Build and scan images (maintenance)   3m51s
✓ Build and scan images (asset)         4m44s
✓ Build and scan images (economic)      4m58s   ← افزوده این فاز
```

**یک نقص در خودِ CI که این فاز پیدا کرد.** این نخستین اجرای CI روی یک
Pull Request در این Repository بود. `gitleaks` برای تصمیم‌گیری درباره اینکه چه
چیزی را Scan کند، Commitهای PR را از API می‌خواند — و Job دسترسی
`pull-requests: read` نداشت، چون تا امروز فقط روی Push به `main` اجرا شده بود و
آنجا این فراخوانی اصلاً انجام نمی‌شود. نتیجه `403 Resource not accessible by
integration` بود که **دقیقاً شبیه یافتن یک Secret به نظر می‌رسید**. هیچ Secret ی
پیدا نشده بود؛ Scan اصلاً شروع نشده بود.

### پیشین — فاز ناوگان

**نخستین Run سبز روی کد کامل ناوگان: `33147827056`، Commit `d2f82f8`،
success در ۱۱ دقیقه.** این همان Commit ای است که آخرین تغییر کد فاز را دارد؛
Commit های پس از آن فقط مستندات‌اند.

| Run           | Commit    | محتوا                          | نتیجه                                               |
| ------------- | --------- | ------------------------------ | --------------------------------------------------- |
| `33147388059` | `97430e7` | کد کامل ناوگان                 | **failure** — Race در Group Coordinator کافکا (زیر) |
| `33147827056` | `d2f82f8` | + رفع همان Race                | success                                             |
| `33161899302` | `99ee98a` | فقط مستندات (پایان فاز ناوگان) | success                                             |
| `33172549841` | `24bef76` | **کد کامل نگهداری + مستندات**  | **success — هر ۸ Job، ۱۲ دقیقه و ۴۴ ثانیه**         |

**قاعده به‌روزرسانی:** این جدول فقط وقتی تغییر می‌کند که **کد** عوض شود؛ Commit
مستنداتیِ بعدی لازم نیست اینجا ثبت شود.

فاز نگهداری در **نخستین اجرا** سبز شد — برخلاف فاز ناوگان که یک بار شکست. هر
**هشت** Job سبز: پنج Image به‌جای چهار، و ۷۳ تست Integration به‌جای ۳۲.

| Job                            | مراحلی که واقعاً اجرا شدند                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| Lint, types and unit tests     | install · db:generate · Format · Lint · Typecheck · **۴۱۵ تست واحد** · Build                    |
| Security scans                 | Gitleaks · `pnpm audit --audit-level=high` · Semgrep                                            |
| Integration and security tests | Postgres + Redis + **Kafka** · ساخت ۸ Topic · Migration · **۷۳ تست Integration** · Tenant/AuthZ |
| Build and scan images × **۵**  | identity · organization · asset · fleet · **maintenance** — هرکدام Build + Trivy                |

**شواهد اینکه دروازه‌ها واقعاً چیزی را اجرا کردند** (نه اینکه تهی سبز شوند) — همه
از Log خود Runner، نه از وضعیت سبز:

- تست واحد: ده خط `Tests: N passed`، که جمعشان دقیقاً ۴۱۵ می‌شود
  (۱۰۲ تای آن `maintenance`).
- Integration: `PASS integration test/cost-atomicity.int-spec.ts`،
  `PASS integration test/event-flow.int-spec.ts (17.187 s)` و
  `Tests: 41 passed, 41 total` برای نگهداری، `32 passed` برای ناوگان.
- مرحله Tenant/AuthZ: الگوی نام حالا `duplicate` و `provenance` را هم می‌گیرد و
  روی نگهداری **۱۲ تست** و روی ناوگان **۱۹ تست** واقعاً اجرا شد — یعنی الگو
  چیزی را Match کرد، نه اینکه با صفر تست سبز شود.
- Trivy روی Image نگهداری: `Detected OS family="alpine" version="3.24.1"`،
  `os_version="3.24" pkg_num=18`، `Number of language-specific files num=1` —
  با شدت `CRITICAL,HIGH` و `exit-code: 1`، بدون یافته گذشت.

**نخستین اجرا (Run `33147388059`) شکست خورد — و درست شکست خورد.**
یک Race واقعی را پیدا کرد که هیچ اجرای محلی نمی‌توانست: Broker تازه‌راه‌افتاده به
`kafka-topics --list` پاسخ می‌دهد (که Healthcheck همان را می‌پرسد) در حالی که
`__consumer_offsets` هنوز بارگذاری می‌شود، پس Consumer تست «group coordinator is
not available» می‌گیرد و در پس‌زمینه Retry می‌کند — بی‌آنکه `run()` خطا بدهد.
تست آن‌گاه روی Topic ای منتشر می‌کرد که کسی نمی‌خواند. روی ماشین توسعه Broker
ساعت‌هاست بالاست، پس این هرگز دیده نمی‌شد.

**دو هشدار صادقانه که نباید با «سبز» اشتباه شوند:**

1. **`--passWithNoTests` هنوز در چهار سرویس دیگر هست** — `identity`,
   `organization`, `asset`, `api-gateway`. هر چهار Project Integration شان
   **تهی** است، پس سهم آن‌ها از مرحله Integration همچنان یعنی «چیزی نشکست».
   تنها `fleet-service` این Flag را ندارد. بستن این شکاف برای هر سرویس، کار
   همان سرویس است، نه فاز ناوگان.
2. مرحله «Tenant isolation and authorization» دو فرمان اجرا می‌کند؛ فرمان اول
   روی Project های Unit با Name Pattern فیلتر می‌شود و در بعضی سرویس‌ها صفر تست
   می‌ماند (`11 skipped`). شاهد واقعی، فرمان دوم روی Project Integration ناوگان
   است.

---

## ۲۰. Security State

| مکانیزم                               | Implemented | Tested |                  Live Verified                  | یادداشت                                                                                                                                                                                                                                                                                                |
| ------------------------------------- | :---------: | :----: | :---------------------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authentication (JWT/JWKS)             |     ✅      |   ✅   |                       ✅                        | زنده دوباره تأیید شد: `200` با JWT کی‌کلوک از راه Gateway                                                                                                                                                                                                                                              |
| Authorization (RBAC سطح Endpoint)     |     ✅      |   ✅   |                       ✅                        | زنده: `province.auditor` → `POST /v1/users` → `403 INSUFFICIENT_ROLE`                                                                                                                                                                                                                                  |
| Tenant Isolation (API + DB)           |     ✅      |   ✅   |                       ✅                        | زنده: `X-Organization-Id` بیگانه → `403 TENANT_MISMATCH`                                                                                                                                                                                                                                               |
| Service-to-Service Auth (Zero Trust)  |     ✅      |   ✅   |                       ✅                        | D-007 رفع شد؛ Claim `purpose` — RELAY در برابر SERVICE (بخش ۱۱)                                                                                                                                                                                                                                        |
| Rate Limiting (منطق Redis)            |     ✅      |   ✅   |                    ⚠️ مسدود                     | D-006: تصادم پورت Redis                                                                                                                                                                                                                                                                                |
| Input Validation (Zod در مرز)         |     ✅      |   ✅   |                       ✅                        |                                                                                                                                                                                                                                                                                                        |
| **Object-level Authorization (BOLA)** |     ✅      |   ✅   |                       ✅                        | **IMPLEMENTED در fleet و maintenance.** fleet (`src/fleet/access.ts`): `DRIVER`/`OPERATOR` فقط رکورد خود و دستگاهی که در دست دارند. maintenance (`src/maintenance/access.ts`): اپراتور فقط گزارش‌های خودش — **باریک‌تر از قاعده مستند، و در جهت امن** (ADR-029، Q-24/Q-25). سه سرویس دیگر هنوز ندارند. |
| **Non-disclosure میان تنانتی**        |     ✅      |   ✅   |                       ✅                        | زنده: منبع تنانت دیگر → **`404`**، هرگز `403` — روی Driver، Assignment و UsageRecord آزموده شد                                                                                                                                                                                                         |
| Audit Trail                           |   ⚠️ جزئی   |   —    |                       نشد                       | `audit-service` نساخته؛ Event های تولید می‌شوند اما جایی ذخیره نمی‌شوند                                                                                                                                                                                                                                |
| Secrets فقط از Env                    |     ✅      |   —    | ✅ (`.env` بررسی شد؛ Secret واقعی در Repo نیست) |                                                                                                                                                                                                                                                                                                        |
| Security Headers (helmet)             |     ✅      |   —    |                       ✅                        | CSP، HSTS، Referrer-Policy                                                                                                                                                                                                                                                                             |
| mTLS بین سرویس‌ها                     |     ❌      |   —    |                        —                        | **PLANNED** — صفر ارجاع در کد (`grep` تأیید شد). Production-only                                                                                                                                                                                                                                       |
| Database RLS                          |     ❌      |   —    |                        —                        | **PLANNED** — صفر Migration دارد. Tenant Isolation فعلاً **فقط لایه Application** است                                                                                                                                                                                                                  |

**وضعیت High-risk items پس از Task سخت‌سازی 2026-08-27:**

- ✅ **D-005 رفع شد** — CI روی GitHub Actions سبز است (**CI VERIFIED**).
- ✅ **D-007 رفع شد** — ثبت‌نام گمنام از راه Gateway کار می‌کند
  (**LIVE VERIFIED**)، بدون تضعیف Zero Trust.
- ✅ **D-010 رفع شد** — Docker بازیابی شد؛ ریشه: Socket های یتیم (بخش ۲۲).
- ⏳ **D-006 باز است** — تصادم پورت Redis روی این ماشین توسعه.
- 🆕 **D-008 باز است** — سه قاعده Supply-Chain که Lockfile فعلی رد می‌کند.
- ✅ **D-009 رفع شد** — Temporal `healthy` است و CLI داخل Image پاسخ می‌دهد.

**تفکیک IMPLEMENTED از PLANNED — تأییدشده با بازرسی کد، نه با سند:**

| کنترل                                              | وضعیت واقعی                                                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Keycloak / OIDC / JWKS                             | **IMPLEMENTED** + LIVE VERIFIED                                                                |
| اعتبارسنجی JWT (`iss`, `exp`)                      | **IMPLEMENTED** + LIVE VERIFIED — Container توکن با `iss` نامنطبق را رد کرد                    |
| Tenant Isolation سطح Application                   | **IMPLEMENTED** + LIVE VERIFIED + CI VERIFIED                                                  |
| Object-level Authorization                         | **IMPLEMENTED** در fleet و maintenance؛ سه سرویس دیگر **NOT IMPLEMENTED**                      |
| پورتال `WORKSHOP` (میان‌تنانتی)                    | **DEFERRED** — مدل دسترسی میان‌تنانتی وجود ندارد؛ نقش `WORKSHOP` هیچ نمی‌بیند (ADR-029)        |
| احراز صلاحیت تعمیرگاه                              | **NOT IMPLEMENTED** — `supplier-service` نیست؛ Port نام‌گذاری‌شده که نبودِ بررسی را Log می‌کند |
| Database RLS                                       | **PLANNED** — صفر Migration                                                                    |
| mTLS سرویس‌به‌سرویس                                | **PLANNED** — صفر ارجاع در کد                                                                  |
| Audit Trail ماندگار                                | **PLANNED** — `audit-service` وجود ندارد؛ رویدادها تولید می‌شوند اما مصرف‌کننده‌ای ندارند      |
| ریشه، خرابی محیط Docker بود (D-010)، نه نقص Image. |

---

## ۲۱. Current Runtime State

در لحظه تأیید زنده (2026-08-28)، هر ۶ سرویس پیاده‌شده از حالت تمیز بالا آمدند و
سالم گزارش دادند:

```
api-gateway           :3010   {"status":"ok","checks":{"redis":true}}
identity-service      :3101   {"status":"ok","checks":{"database":true,"kafka":true}}
organization-service  :3102   {"status":"ok","checks":{"database":true,"kafka":true}}
asset-service         :3103   {"status":"ok","checks":{"database":true,"kafka":true}}
fleet-service         :3104   {"status":"ok","checks":{"database":true,"kafka":true}}
maintenance-service   :3105   {"status":"ok","checks":{"database":true,"kafka":true}}
```

Infra Docker: `postgres, redis, kafka, keycloak, minio` همه `healthy`.
**`temporal` سالم است و این بار مثبتاً تأیید شد** — هم Healthcheck
(`FailingStreak: 0`) و هم `temporal --version` داخل Image. D-009 رفع شد؛ ریشه،
خرابی محیط Docker بود (D-010).

### جدول شواهد تأیید زنده — `fleet-service`

هر ردیف یک فرمان واقعی از راه Gateway (`:3010`) با توکن واقعی Keycloak است.

| #   | آنچه آزموده شد                      | نتیجه واقعی                                                                             |
| --- | ----------------------------------- | --------------------------------------------------------------------------------------- |
| ۱   | درخواست بدون توکن                   | `401` — Endpoint پیش‌فرض بسته                                                           |
| ۲   | توکن `dehyari.admin` (ORG-DEH-0001) | `200`، Claim ها: `rasta_uid`، `org_id`، ۳ نقش                                           |
| ۳   | `GET /v1/fleet/availability`        | هر مانع با **مالکش**: `ACTIVE_ASSIGNMENT(fleet-service)`، `ASSET_STATUS(asset-service)` |
| ۴   | `POST /v1/assignments`              | `201`، `active=true`، `assignedBy=USR-SEED-DEHYARI-ADMIN`                               |
| ۵   | Outbox → Kafka                      | ردیف `outbox_message` با `topic=rasta.fleet.v1`, `key=AST-SEED-0002`, منتشر             |
| ۶   | **Asset Projector**                 | خط `تخصیص به راننده` در Timeline دارایی، `sourceService=fleet-service`                  |
| ۷   | وضعیت دارایی                        | `IDLE → ASSIGNED` (توسط `ASSET_ASSIGNED`)                                               |
| ۸   | `correlationId`                     | `e2e-…` یکسان در: درخواست HTTP، `outbox.correlation_id`، Header کافکا                   |
| ۹   | Idempotency ثبت کارکرد              | دو ارسال با `clientReference` یکسان → **همان `USG_…`**                                  |
| ۱۰  | Idempotency مصرف‌کننده              | همان رویداد دوباره روی کافکا منتشر شد → Timeline **بدون خط دوم**                        |
| ۱۱  | انحصار دارایی                       | `422 BUSINESS_RULE_VIOLATION` — «machine in state ASSIGNED»                             |
| ۱۲  | انحصار راننده                       | `422` — «This driver already holds an active assignment»                                |
| ۱۳  | پایان تخصیص                         | `ASSIGNMENT_ENDED` → دارایی به `ACTIVE` بازگشت، خط Timeline ثبت شد                      |
| ۱۴  | Tenant Isolation (خواندن تخصیص)     | `union.admin` → **`404`**، نه ۴۰۳                                                       |
| ۱۵  | Tenant Isolation (خواندن راننده)    | `union.admin` → **`404`**                                                               |
| ۱۶  | مجوز سطح نقش                        | `province.auditor` → `POST /v1/drivers` → `403 INSUFFICIENT_ROLE`                       |
| ۱۷  | مجوز سطح Object                     | `province.auditor` → فهرست راننده‌ها **خالی** (به رکورد خودش محدود شد)                  |
| ۱۸  | انقضای توکن                         | توکن منقضی → `401 TOKEN_EXPIRED`                                                        |
| ۱۹  | Docker Image                        | Build شد، اجرا شد، `uid=100(rasta)`، بدون `npm/npx/corepack`                            |
| ۲۰  | E2E از داخل **Container**           | تخصیص از Container → Kafka → Timeline دارایی                                            |

**یک یافته امنیتی مثبت در همین مسیر:** Container با `OIDC_ISSUER_URL` داخلی
(`keycloak:8080`) توکنی با `iss=localhost:8080` را **رد کرد** (`TOKEN_INVALID`).
یعنی بررسی `iss` واقعاً اجرا می‌شود (S-04)، نه اینکه فقط امضا بررسی شود.

Kafka Consumer Group های فعال: `asset-service.timeline`،
`fleet-service.asset-sync`، `maintenance-service.usage` و
`maintenance-service.asset-sync`.

---

### جدول شواهد تأیید زنده — `maintenance-service` (بخش ۲۱-ب)

هر ردیف یک فرمان واقعی از راه Gateway (`:3010`) با توکن واقعی Keycloak است، مگر
جایی که صریحاً «پایگاه داده» یا «کافکا» نوشته شده. اجراشده در 2026-08-28 با هر شش
سرویس بالا.

| #   | آنچه آزموده شد                            | نتیجه واقعی                                                                                           |
| --- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| ۱   | درخواست بدون توکن                         | `401` — Endpoint پیش‌فرض بسته                                                                         |
| ۲   | توکن منقضی/نامعتبر                        | `401 TOKEN_INVALID`                                                                                   |
| ۳   | `GET /v1/maintenance-schedules/due`       | گریدر: **`OVERDUE` on `HOURS`**، کنتور `4380.50`، سررسید `4370.50` — **محاسبه‌شده، نه ذخیره‌شده**     |
| ۴   | `…/due?includeNotDue=true`                | برنامه دوم: `NOT_DUE` on `TIME`، `dueBy=2027-02-14` — هر دو پاسخ در یک فراخوان                        |
| ۵   | پیوند برنامه ↔ درخواست باز                | `openRequestId=MNT-SEED-0002` — بدون N+1، یک Query برای کل صفحه                                       |
| ۶   | `POST /v1/maintenance-requests`           | `201`، `status=OPEN`، `reportedBy=USR-SEED-DEHYARI-ADMIN`                                             |
| ۷   | **منع درخواست تکراری**                    | `422 BUSINESS_RULE_VIOLATION` — «This machine already has an open request of that kind»               |
| ۸   | `POST …/{id}/assign`                      | `201`، دستور تعمیر ساخته شد، `WORKSHOP_ASSIGNED` منتشر شد                                             |
| ۹   | `POST /v1/repair-orders/{id}/start`       | `200` — و اینجاست که دستگاه از سرویس خارج می‌شود                                                      |
| ۱۰  | ثبت دو قطعه، دستمزد و یک هزینه مستقیم     | ۴ ردیف؛ `2 × 850000 = 1700000`، `12.5 × 320000 = 4000000`، `6.5 × 900000 = 5850000`                   |
| ۱۱  | **مبدأ هر خط هزینه**                      | دو خط `PART` → `PTU_…`، یک `LABOUR` → `LBR_…`، یک `SERVICE` → «واردشده توسط `USR-SEED-DEHYARI-ADMIN`» |
| ۱۲  | مجموع‌ها                                  | `parts 5700000 + labour 5850000 + other 1200000 = 12750000` — بازمحاسبه‌شده از خطوط                   |
| ۱۳  | **fleet دستگاه در تعمیرگاه را رد می‌کند** | `POST /v1/assignments` → `422` «This machine is in maintenance and cannot be assigned»                |
| ۱۴  | تأیید پیش از اتمام کار                    | `409 INVALID_STATE_TRANSITION` — «cannot move from IN_PROGRESS to APPROVED»                           |
| ۱۵  | `POST /v1/repair-orders/{id}/complete`    | `200`؛ `REPAIR_COMPLETED` و `MAINTENANCE_COMPLETED` هر دو منتشر شدند                                  |
| ۱۶  | تأیید با مبلغ کهنه                        | `422` — «The cost has changed since it was shown to you»                                              |
| ۱۷  | تأیید با مبلغ درست                        | `200`، `status=APPROVED`، `approvedBy` ثبت شد                                                         |
| ۱۸  | تأیید دوباره                              | `409` — «This maintenance request is already APPROVED»                                                |
| ۱۹  | **پرونده دارایی (پایگاه داده asset)**     | سه خط Timeline از `maintenance-service`: گزارش خرابی · ثبت درخواست · شروع تعمیر                       |
| ۲۰  | **وضعیت دارایی**                          | `ACTIVE → IN_MAINTENANCE → ACTIVE` — هر دو گذار از رویداد، نه از API                                  |
| ۲۱  | **Replica ناوگان (پایگاه داده fleet)**    | `in_maintenance` روشن شد و پس از پایان تعمیر خاموش شد                                                 |
| ۲۲  | Outbox                                    | هر ۷ رویداد یک درخواست، همه با `partition_key = AST-SEED-0002` و همه `published`                      |
| ۲۳  | **کافکا (خواندن واقعی از Topic)**         | `MAINTENANCE_APPROVED` روی `rasta.maintenance.v1` با `totalCostMinor="12750000"` و تفکیک سه‌خطی       |
| ۲۴  | `correlationId`                           | `live-mnt-…` یکسان در: درخواست HTTP، `outbox.correlation_id`، و Envelope روی کافکا                    |
| ۲۵  | **downtime**                              | `3180` دقیقه — از `outOfServiceAt` (۲۶ مرداد ۰۸:۰۰)، نه از شروع تعمیر                                 |
| ۲۶  | **FLOW A زنده**                           | ثبت کارکرد در fleet → کافکا → کنتور `4380.50 → 4386.50` → `MAINTENANCE_DUE` منتشر شد                  |
| ۲۷  | Idempotency ثبت کارکرد                    | دو ارسال با `clientReference` یکسان → **همان `USG_…`**؛ کنتور یک‌بار شمرد (`43 → 44`)                 |
| ۲۸  | **اعلام یک‌بار در هر چرخه**               | خواندن دوم کارکرد → `MAINTENANCE_DUE` **دوباره منتشر نشد** (همچنان ۱ ردیف)                            |
| ۲۹  | Tenant Isolation (خواندن درخواست)         | `union.admin` → **`404`**، نه ۴۰۳                                                                     |
| ۳۰  | Tenant Isolation (خواندن دستور تعمیر)     | `union.admin` → **`404`**                                                                             |
| ۳۱  | Tenant Isolation (فهرست برنامه‌ها)        | `union.admin` → فهرست **خالی**، در حالی که دو برنامه در تنانت دیگر وجود دارد                          |
| ۳۲  | مجوز سطح نقش                              | `province.auditor` → ثبت درخواست، ارجاع و ساخت برنامه → هر سه `403 INSUFFICIENT_ROLE`                 |
| ۳۳  | Docker Image                              | Build شد، اجرا شد، `uid=100(rasta)`، بدون `npm/npx/corepack`، Healthcheck `healthy`                   |
| ۳۴  | آمادگی از داخل Container                  | `200 {"checks":{"database":true,"kafka":true}}` — و هر دو Consumer به Group پیوستند                   |
| ۳۵  | متریک‌ها                                  | ۹ سری با داده واقعی، از جمله Histogram توقف (۵۳ ساعت، سطل `72`)                                       |

**یک یافته مثبت در همین مسیر:** پیش از اینکه `MAINTENANCE_STARTED` منتشر شود،
`fleet-service` تخصیص راننده به همان دستگاه را می‌پذیرفت؛ پس از انتشار، `422` داد.
یعنی Replica ناوگان واقعاً از رویداد به‌روز می‌شود، نه از یک فرض.

---

---

### جدول شواهد تأیید زنده — `economic-service` (بخش ۲۱-ج)

اجرا شده 2026-08-29 روی Stack واقعی: PostgreSQL، Kafka، Keycloak و
`api-gateway` روی `localhost:3010`. هر درخواست با **توکن واقعی Keycloak** از
`rasta-web` و با `X-Correlation-Id` مشخص. هیچ Mock ی در مسیر نیست جز
ارائه‌دهنده پرداخت، که خودش موضوع ADR-024 است.

| #   | سناریو                                     | نتیجه مشاهده‌شده                                                                                                 |
| --- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| ۱   | اعلام ارائه‌دهنده پرداخت                   | `{"provider":"mock","simulated":true,"notice":"Simulated payment provider. No bank connection, no real funds…"}` |
| ۲   | `GET /v1/wallets/me` — نخستین استفاده      | کیف پول `WLT_01M1584GV0…` ساخته شد؛ هر سه مانده صفر                                                              |
| ۳   | شارژ **بدون** `Idempotency-Key`            | `400 VALIDATION_FAILED` روی `headers.idempotency-key`                                                            |
| ۴   | شارژ با کلید                               | `201`، `status: CAPTURED`، `simulated: true`، مانده ۵۰٬۰۰۰٬۰۰۰                                                   |
| ۵   | همان کلید، همان بدنه                       | `201` با **دقیقاً همان** `paymentIntentId` و `journalId` — بدون شارژ دوم                                         |
| ۶   | همان کلید، بدنه متفاوت                     | `409 IDEMPOTENCY_KEY_REUSED`                                                                                     |
| ۷   | مانده پس از یک شارژ (نه دو)                | ۵۰٬۰۰۰٬۰۰۰ — تأیید اینکه Replay شارژ دوم نزد                                                                     |
| ۸   | شکست تحریک‌شده ارائه‌دهنده                 | `status: FAILED`، `failureReason: INSUFFICIENT_FUNDS`، `transactionId: null`، `journalId: null`                  |
| ۹   | مانده پس از پرداخت شکست‌خورده              | **تغییر نکرد** — کیف پول فقط در Capture بستانکار می‌شود، نه در Authorize                                         |
| ۱۰  | ثبت تراکنش با Hold                         | `201`، `status: HELD`، دو Leg (PAYER/PAYEE)                                                                      |
| ۱۱  | کیف پول پس از Hold                         | مجموع ۱۰۰م، **در امانت ۱۲م، در دسترس ۸۸م** — پول ناپدید نشد، تعهد شد                                             |
| ۱۲  | تسویه **پیش از** تأیید دریافت              | `409 INVALID_STATE_TRANSITION` — «A HELD transaction cannot be settled»                                          |
| ۱۳  | تأیید دریافت                               | `200`، `status: PENDING_SETTLEMENT`                                                                              |
| ۱۴  | تسویه                                      | `201`، ناخالص ۱۲م، کارمزد **۰**، خالص ۱۲م، `commissionRuleMatched: false`                                        |
| ۱۵  | کیف پول پرداخت‌کننده پس از تسویه           | مجموع ۸۸م، در امانت ۱۲م (Hold قدیمی‌تر)، در دسترس ۷۶م                                                            |
| ۱۶  | نمای دریافت‌کننده (`includeIncoming=true`) | تراکنش `SETTLED` را می‌بیند — همان چیزی که Filter تک‌مستأجری پنهانش می‌کرد                                       |
| ۱۷  | کیف پول دریافت‌کننده                       | **۱۲٬۰۰۰٬۰۰۰ بستانکار شد**                                                                                       |
| ۱۸  | `AUDITOR` روی کیف پول                      | `403 INSUFFICIENT_ROLE`                                                                                          |
| ۱۹  | `AUDITOR` روی تراکنش‌ها                    | `403 INSUFFICIENT_ROLE`                                                                                          |
| ۲۰  | `AUDITOR` روی تراز آزمایشی                 | `403 FORBIDDEN`                                                                                                  |
| ۲۱  | خواندن میان‌مستأجری کیف پول با شناسه       | **`404 NOT_FOUND`**، نه ۴۰۳ — وجود رکورد فاش نمی‌شود                                                             |
| ۲۲  | تراز آزمایشی به‌عنوان `UNION_ADMIN`        | **`balanced: true`** — بدهکار ۱۳۶٬۰۰۰٬۰۰۰ = بستانکار ۱۳۶٬۰۰۰٬۰۰۰ روی ۴ حساب                                      |
| ۲۳  | تراز آزمایشی به‌عنوان `ORGANIZATION_ADMIN` | `403 FORBIDDEN` — در Gateway                                                                                     |
| ۲۴  | نمودار حساب‌های سازمان                     | دقیقاً دو حساب: `LIAB-ORG-UNION-YAZD-WALLET` و `…-ESCROW` (ADR-034)                                              |
| ۲۵  | قواعد کارمزد                               | **`{"items":[]}`** — وضعیت درست MVP؛ Q-08 باز است و هیچ نرخی Seed نمی‌شود                                        |
| ۲۶  | پاداش کاربر                                | `{"balance":null,"rewards":[]}` — هیچ قاعده‌ای پیکربندی نشده                                                     |

**تراز آزمایشی زنده، خط‌به‌خط:**

```
ASST-ORG-PLATFORM-PAYMENT_CLEARING   ASSET       100,000,000
LIAB-ORG-DEH-0001-WALLET             LIABILITY    12,000,000
LIAB-ORG-UNION-YAZD-ESCROW           LIABILITY    12,000,000
LIAB-ORG-UNION-YAZD-WALLET           LIABILITY    76,000,000

76,000,000 + 12,000,000 + 12,000,000 = 100,000,000  ✓
```

**رویدادهای منتشرشده روی `rasta.economic.v1`** (خوانده‌شده با
`kafka-console-consumer`، ۲۶۲ رویداد در کل، هر یازده نوع حاضر):

```
live-verify-2   WALLET_OPENED         actor=USR-SEED-UNION-ADMIN
live-verify-4   PAYMENT_AUTHORIZED    actor=USR-SEED-UNION-ADMIN
live-verify-4   PAYMENT_COMPLETED     simulated=True amount=50000000
live-verify-4   JOURNAL_POSTED
live-verify-8   PAYMENT_FAILED        reason=INSUFFICIENT_FUNDS simulated=True
live-verify-10  FUNDS_HELD            amount=12000000
live-verify-10  JOURNAL_POSTED
live-verify-14  COMMISSION_APPLIED
live-verify-14  FUNDS_RELEASED        resolution=RELEASED
live-verify-14  SETTLEMENT_COMPLETED  gross=12000000 comm=0 net=12000000
live-verify-14  JOURNAL_POSTED
live-verify-17  WALLET_OPENED         actor=USR-SEED-DEHYARI-ADMIN
```

**`correlationId` از HTTP تا Kafka دست‌نخورده می‌رسد** — هر رویداد بالا با
همان `X-Correlation-Id` که درخواست HTTP فرستاده برچسب خورده، و `actor` هم از
توکن Keycloak آمده.

**تأییدهای بیرون از Gateway:**

| بررسی                    | نتیجه                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------- |
| Container غیر‌Root       | `uid=100(rasta) gid=101(rasta)` — و `npm` از Image حذف شده                         |
| Trivy روی Image          | **۰ یافته CRITICAL/HIGH**، خروج ۰                                                  |
| Health/Readiness         | `{"status":"ok","checks":{"database":true,"kafka":true},"degraded":[]}`            |
| مصرف‌کننده‌ها هنگام Boot | هر دو Group به `rasta.maintenance.v1` و `rasta.fleet.v1` متصل شدند                 |
| تغییرناپذیری از SQL خام  | `UPDATE`/`DELETE` روی `ledger_entry` و `journal` هر دو `restrict_violation` گرفتند |
| Migration                | `migrate deploy` روی پایگاه داده تمیز اجرا شد؛ `down.sql` نوشته و بازبینی شده      |

---

## ۲۲. Known Issues

### فعال (رفع‌نشده)

| #     | مسئله                                                                            | شدت                             | تأثیر                                                                         | راه‌حل موقت                                                                                     |
| ----- | -------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| D-006 | Redis محلی Windows روی پورت ۶۳۷۹ با Redis داکری تصادم دارد                       | بالا (فقط محیط توسعه این ماشین) | تست زنده Rate Limiting/Idempotency از راه `localhost:6379` غیرقابل‌اعتماد     | استفاده از `docker exec rasta-redis redis-cli` مستقیم؛ یا تغییر `REDIS_PORT` مثل الگوی Postgres |
| D-008 | سه قاعده Supply-Chain که Lockfile فعلی رد می‌کند                                 | متوسط                           | پنجره نصب نسخه تازه‌منتشرشده مخرب باز است؛ ۴ هشدار Trust بررسی‌نشده           | Semgrep با `--exclude-rule` نام‌دار عبور می‌کند؛ بررسی کامل یک Task مستقل است                   |
| —     | چهار سرویس دیگر هنوز `--passWithNoTests` دارند و Project Integration شان تهی است | متوسط                           | سهم آن‌ها از مرحله Integration در CI یعنی «چیزی نشکست»، نه «مسیر داده تست شد» | برای هر سرویس، کار همان سرویس است؛ `fleet` الگو را نشان داده                                    |
| —     | `api-gateway` هیچ Dockerfile ندارد                                               | متوسط                           | نمی‌توان آن را Containerize کرد                                               | نوشتن Dockerfile لازم است                                                                       |
| D-011 | تغییر برنامه سرویس در `maintenance` هیچ رویدادی تولید نمی‌کند                    | متوسط (امروز پایین)             | خاموش کردن بی‌صدای یک برنامه سرویس را `audit-service` هرگز نمی‌بیند           | دلیل در ستون `notes` می‌ماند؛ هنگام ساخت `audit-service` رویداد لازم است                        |
| D-012 | کنتور کارکرد هرگز عقب نمی‌رود                                                    | پایین                           | پس از تعویض کنتور، برنامه‌های کارکردمحور جلوتر از عدد روی دستگاه‌اند          | مسیر پشتیبانی‌شده: `PATCH /v1/maintenance-schedules/{id}` با `lastServicedHourMeter`            |
| —     | `InsuranceClaim` جدول بدون API                                                   | پایین                           | داده قابل‌ثبت نیست از راه سرویس                                               | Controller/Service لازم است، هروقت claim-flow اولویت شد                                         |
| —     | `mission` و رویدادهای `MISSION_*` پیاده نشدند                                    | پایین                           | تحلیل «ناوگان داخلی در برابر برون‌سپاری» هنوز داده مأموریت ندارد              | عمدی — به `construction-service` گره خورده که وجود ندارد؛ ADR-026 § Consequences                |

### D-010 — Docker Desktop از کار افتاد و رفع شد (2026-08-28) ✅

**ریشه، به ترتیب کشف:**

1. `com.docker.service` (سرویس ویندوزی که Engine لینوکسی به آن وابسته است)
   متوقف بود.
2. پس از Start شدن آن، Named Pipe همچنان ساخته نمی‌شد چون Docker Desktop خطای
   `initializing Ingest server` می‌داد.
3. علت واقعی: چهار **Socket یتیم** در
   `%LOCALAPPDATA%\Docker
un\` — فایل‌های صفر-بایتی از نوع ReparsePoint که از
   Process کشته‌شده قبلی مانده بودند. Docker نمی‌توانست حذف و بازسازی‌شان کند، و
   API فایل ویندوز هم نمی‌توانست بازشان کند («The file cannot be accessed by
   the system»).

**رفع:** تغییر نام پوشه `run` (غیرمخرب — نسخه قدیمی به‌عنوان `run.stale-*` ماند)
و راه‌اندازی دوباره Docker Desktop. Docker پوشه را از نو ساخت و همه کانتینرها
سالم بالا آمدند.

**درس عملیاتی — این اشتباه در همین Task رخ داد.** Engine API از ابتدای جلسه
خطای ۵۰۰ می‌داد **اما کانتینرها کار می‌کردند** و پورت‌ها پاسخ می‌دادند. Restart
کردن Docker Desktop، یک Stack کارکن ولی غیرقابل‌مدیریت را به یک Stack خاموش
تبدیل کرد و ساعت‌ها وقت گرفت. **اول پورت‌ها را بررسی کن؛ اگر پاسخ می‌دهند، با
همان کار کن.**

**نکته جانبی — D-009 هم با همین رفع بسته شد.** پس از بازسازی محیط،
`rasta-temporal` هم `healthy` شد و هم `temporal --version` داخل Image پاسخ
داد. یعنی «باینری CLI اجرا نمی‌شود» پیامد همین خرابی بود، نه نقص Image.

### فاز نگهداری (2026-08-28) — هیچ باگ تولیدی نگرفت، و چرا

نخستین اجرای Suite Integration نگهداری **صفر باگ تولیدی** پیدا کرد. این ادعا فقط
وقتی معنا دارد که کنارش گفته شود چه چیزی آزموده شد: منع درخواست تکراری زیر مسابقه
واقعی، ده ثبت هزینه هم‌زمان، Rollback تراکنش Outbox، و یک پیام واقعی روی Topic
واقعی fleet. تنها شکست، یک **ادعای نادرست در خودِ تست** بود (`dueBy` باید هنگام
`NOT_DUE` هم گزارش شود — رفتار کد درست بود).

دلیلش ساده است: **هر پنج تله فاز ناوگان از روز اول بسته بودند** —

- هیچ ستون زمانی کسب‌وکاری `@default(now())` ندارد،
- ترجمه نقض Constraint روی **نام ستون** تطبیق می‌دهد، نه نام Index،
- `asActor` از ابتدا `async () => fn()` است،
- Invariant ها در پایگاه داده‌اند، نه فقط در لایه Application،
- و رویدادها `assetId` حمل می‌کنند چون Projector مقصد بدون آن Skip می‌کند.

### رفع‌شده در Task ناوگان (2026-08-28)

- **صفر فایل `*.int-spec.ts` — رفع شد.** چهار Suite واقعی در
  `services/fleet-service/test/`، و `test:integration` دیگر
  `--passWithNoTests` ندارد.
- **`asset-service` در CI Container Matrix نبود — رفع شد.** هم `asset-service`
  و هم `fleet-service` به Matrix افزوده شدند. (`api-gateway` همچنان
  Dockerfile ندارد و باز است.)
- **شش باگ که تست‌های Integration و CI گرفتند** — همه رفع شدند. هیچ‌کدام با
  تست واحد پیدا نمی‌شد؛ سه‌تا نیازمند پایگاه داده واقعی، دوتا نیازمند اجرای
  واقعی خود تست، و یکی **فقط روی Runner واقعی CI** قابل مشاهده بود.

  **در کد تولیدی:**

  1. **`AssetSyncConsumer` — تنانت پاک می‌شد.** یک کلید `patch` با مقدار
     `undefined` سازمان حل‌شده را بازنویسی می‌کرد. اثر: `ASSET_CREATED` که
     سازمانش فقط روی Envelope بود، ردیفی بدون سازمان می‌نوشت.

  2. **`AssignmentService` — ترجمه خطای انحصار هرگز کار نمی‌کرد.** کد روی
     **نام Index** تطبیق می‌داد (`ux_assignment_active_driver`)، اما Prisma در
     `P2002` **نام ستون** را در `meta.target` می‌گذارد (`driver_id`). پس هر
     مسابقه واقعی به مسیر عمومی `ALREADY_EXISTS` می‌افتاد. Invariant همیشه
     برقرار بود — چیزی که می‌شکست، وعده ADR-025 بود که «مسابقه از تعارض عادی
     قابل تشخیص نیست»: فراخوان ترتیبی `422` با نام قاعده می‌گرفت و فراخوان
     همزمان `409` بی‌نام.

  3. **`Assignment.startedAt` — دو ساعت روی یک ردیف.** ستون
     `@default(now())` داشت (ساعت PostgreSQL) در حالی که `ended_at` همیشه از
     Node می‌آید، و `ck_assignment_period` آن دو را مقایسه می‌کند. روی این
     ماشین PostgreSQL در WSL2 **۱۴ تا ۵۶ میلی‌ثانیه جلوتر** از میزبان است، پس
     تخصیصی که در همان پنجره ساخته و بسته شود، Constraint خودش را نقض می‌کند.
     مسیر تولیدی امن بود (همه جا `startedAt` صریح داده می‌شود)، ولی Default ای
     که هیچ‌کس استفاده نمی‌کند و فقط می‌تواند ساعت دوم وارد کند، یک تله است.
     حذف شد.

  4. **Race در Group Coordinator کافکا — فقط CI پیدایش کرد.** Broker
     تازه‌راه‌افتاده به Healthcheck پاسخ می‌دهد در حالی که
     `__consumer_offsets` هنوز بارگذاری می‌شود؛ `connect()`، `subscribe()` و
     `run()` همگی موفق برمی‌گردند اما Consumer به Group نپیوسته. تست روی
     Topic ای منتشر می‌کرد که کسی نمی‌خواند و با Timeout ای شکست می‌خورد که
     نام اشتباهی می‌برد. رفع با انتظار روی `GROUP_JOIN` (در تست) و گرم کردن
     Coordinator (در CI) — دو محافظ مستقل.

  **در خود تست‌ها:**

  4. **`test/helpers.ts` — همان تله D-003 در فایلی تازه.** Query تنبل Prisma
     **پس از** بسته شدن Context اجرا می‌شد، یعنی بدون هیچ Tenant Scope.

  5. **`usage-outbox.int-spec.ts` — خواندن خارج از Context.** یک `findMany`
     روی مدل Scope‌دار بیرون از `asActor`. Tenant Guard **درست** خطا داد — که
     خودش شاهدی است بر اینکه Guard کار می‌کند.

### یافته‌های دروازه انتشار (Release Gate، 2026-08-28)

سه مورد در Audit رسمی پیدا و رفع شد — هیچ‌کدام باگ رفتاری نبود، اما هر سه
ادعایی را که این Repository درباره خودش می‌کند نقض می‌کردند:

- **N+1 در گزارش بهره‌برداری.** برای هر دارایی یک Query جدا می‌زد تا نام را
  اضافه کند — تا ۲۰۰ رفت‌وبرگشت برای گزارشی که داده‌اش از دو Query می‌آمد.
  تنها Query سرویس که با اندازه ناوگان رشد می‌کرد، نه با اندازه صفحه.
- **یک عبور از مرز تنانت که Greppable نبود.** شمارنده تخصیص‌های فعال با Raw SQL
  میان‌تنانتی می‌شمرد. خود شمارش درست بود (Gauge است و هیچ تنانتی نمی‌بیندش)،
  اما Raw SQL را Extension رهگیری نمی‌کند، پس نه در `grep -r runUnscoped`
  دیده می‌شد و نه در Log حسابرسی. داستان حسابرسی فقط وقتی برقرار است که **هر**
  عبور قابل شمارش باشد، حتی بی‌ضررها.
- **OpenAPI هیچ Schema ای نداشت.** هر Endpoint نوشتنی با یک Summary و بدون
  Request Body منتشر می‌شد. علت ساختاری بود: پلتفرم با Zod اعتبارسنجی می‌کند و
  `@nestjs/swagger` از Class های Decorate شده Schema می‌سازد. یک Converter
  کوچک و بدون وابستگی نوشته شد که از **همان** Schema هایی که سرویس با آن‌ها
  اعتبارسنجی می‌کند، JSON Schema تولید می‌کند — پس سند نمی‌تواند واگرا شود.

### رفع‌شده در جلسه پیشین (برای شفافیت ثبت شده، نه به‌عنوان کار باقی‌مانده)

- D-003: `runUnscoped` دامنه‌اش را از دست می‌داد (Prisma Promise تنبل) —
  رفع در `packages/nest-common`.
- D-004: `pnpm db:migrate` بدون `DATABASE_URL` صریح کار نمی‌کرد —
  `scripts/prisma.mjs` اضافه شد.
- **D-005: CI هرگز روی GitHub سبز نشده بود — رفع و CI VERIFIED**
  (Run `33076090420`). ریشه: تصادم نسخه pnpm. در مسیر رفع، شش نقص واقعی
  دیگر هم آشکار و رفع شد که هیچ‌کدام محلی دیده نمی‌شدند — از جمله یک
  دروازه Semgrep که سبز گزارش می‌داد بی‌آنکه چیزی Scan کند.
- **D-007: Gateway مسیر عمومی را می‌شکست — رفع و LIVE VERIFIED**
  (`201` زنده). ریشه: توکن داخلی دو معنا را با یک شکل حمل می‌کرد؛ با Claim
  `purpose` تفکیک شد (بخش ۱۱).

### قدیمی (از پیش مستند، هنوز صادق)

- D-001: هشدار `TimeoutNegativeWarning` از kafkajs — فقط نویز Log.
- D-002: قفل Prisma Engine در ویندوز حین `generate` — سرویس باید متوقف شود.

جزئیات کامل هرکدام: [`docs/23-risks-and-tradeoffs.md`](docs/23-risks-and-tradeoffs.md)
بخش ۲۳٫۵-الف.

---

## ۲۳. Technical Debt

جدا از Known Issues (که رفتار غلط تولید می‌کنند)، این‌ها تصمیم‌های آگاهانه
با هزینه پذیرفته‌شده‌اند:

- T-01 تا T-05 در `docs/23-risks-and-tradeoffs.md` (Microservices در مقیاس
  کوچک، Kafka برای حجم کم، Temporal سنگین، رد Kong/APISIX، Prisma به‌ازای سرویس).
- Testcontainers نصب نشده — تست Integration واقعی هنوز ممکن نیست بدون آن.
- Playwright نصب نشده — E2E واقعی هنوز ممکن نیست.
- Production mTLS و Database RLS — Planned، نه Implemented (بخش ۲۰).

---

## ۲۴. Open Questions

**هیچ‌کدام در فاز اقتصادی هم حل نشدند — و این عمدی است.** آنچه عوض شد این است
که حالا **پاسخ هر کدام یک درج یا به‌روزرسانی رکورد است، نه تغییر کد**:

| پرسش           | پاسخ‌دادنش امروز چقدر کار دارد                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------- |
| **Q-08**       | یک `POST /v1/commissions/rules`. تا آن روز: کارمزد صفر و `commissionRuleMatched: false`            |
| **Q-09**       | یک `PATCH /v1/rewards/rules/{id}` با `creditPerPointMinor`. تا آن روز: پاداش امتیازی، بدون Journal |
| **Q-07**       | یک تغییر پرچم. تا آن روز: ساختن قاعده `CASHBACK` با `422` **رد** می‌شود                            |
| **Q-13**       | درج در `reward_level.benefits`. تا آن روز: سطح محاسبه می‌شود، مزیتی اعطا نمی‌شود                   |
| **Q-01، Q-14** | یک کلاس تازه `PaymentProvider` و یک شاخه پیکربندی. Domain Core دست نمی‌خورد                        |

همگی هنوز باز و در
[`docs/24-open-questions.md`](docs/24-open-questions.md) هستند:

- نرخ کارمزد پلتفرم (۲۴٫۲)
- مرجع موافقت زنجیره تأیید مناقصه/قرارداد (۲۴٫۱، ۲۴٫۲)
- الزامات حقوقی کیف پول/نگهداری وجوه (۲۴٫۱)
- یکپارچگی ملی (شاهکار، ثبت‌احوال و…) (۲۴٫۳)
- نگهداشت داده و حریم خصوصی (۲۴٫۱)
- برند و محصول نهایی (۲۴٫۴)

**دو پرسش تازه از فاز نگهداری (۲۴٫۶)، هر دو 🟠 و هر دو در ADR-029:**

- **Q-24** — قاعده «فقط دارایی تخصیص‌یافته» برای `OPERATOR` چگونه اجرا شود؟
  واقعیتش نزد `fleet-service` است و به شکلی که با یک توکن تطبیق بخورد در دسترس
  نیست. تصمیم موقت: اپراتور در سازمان خودش گزارش می‌دهد و فقط گزارش‌های خودش را
  می‌بیند — باریک‌تر در هر جهتی جز آن یکی که یک گزارش ایمنی را خفه می‌کرد.
- **Q-25** — مدل دسترسی تعمیرگاه چیست؟ خدمت‌رسانی به `WORKSHOP` یعنی خواندن
  میان‌تنانتی، که این پلتفرم ندارد. تصمیم موقت: پورتال به تعویق؛ نقش `WORKSHOP` در
  باریک‌سازی می‌افتد و هیچ نمی‌بیند.

هیچ‌کدام با حدس پر نشدند، طبق دستور صریح کاربر در همه Prompt های قبلی.

---

## ۲۵. Architecture Decisions

**۳۴** ADR موجود (`docs/adr/ADR-001` تا `ADR-034`)، فهرست کامل در
`docs/21-adr-list.md`. پنج تای آخر از فاز اقتصادی‌اند: **۰۳۰** (پارتیشن‌بندی
دفتر کل، موکول با شرط عددی)، **۰۳۱** (تسویه بدون Temporal و بدون Redis)،
**۰۳۲** (مرز مصرف رویداد، و اینکه یک تأیید پول را حرکت نمی‌دهد)، **۰۳۳**
(پولی‌سازی پاداش)، **۰۳۴** (امانت به‌ازای هر سازمان — حل یک تناقض در خودِ
`docs/10`).

پیشین: ۲۹ ADR (`ADR-001` تا `ADR-029`). سه تای آخر از فاز نگهداری‌اند: **۰۲۷** (سررسید مشتق‌شده،
Temporal موکول)، **۰۲۸** (مبدأ هزینه و درز اقتصادی)، **۰۲۹** (دسترسی تعمیرگاه و
مجوزدهی سطح Object). هیچ ADR جدیدی در این Audit لازم نبود — دو رفع باگ
(D-003, D-004) تصمیم معماری نبودند (اصلاح رفتار در برابر تصمیم موجود)، و
الگوی مصرف رویداد (`EventConsumer`) از قبل زیر چتر **ADR-021 (Outbox
Pattern)** پوشش داده شده (بخش «At-Least-Once + Idempotent Consumer» را
صریح ذکر کرده).

ADR های مرتبط با کاری که واقعاً ساخته شده:
ADR-001 (Microservices)، ADR-004/005 (Database + Ownership)، ADR-006
(Kafka)، ADR-007 (Redis)، ADR-008 (Keycloak)، ADR-009 (Gateway)، ADR-011
(Multi-Tenancy)، ADR-012 (Asset-Centric)، ADR-018 (Monorepo)، ADR-020
(Service-to-Service Auth)، ADR-021 (Outbox)، ADR-022 (Money).

---

## ۲۶. Completed Work

- ۲۴ سند معماری + ۲۴ ADR + AGENTS.md/CLAUDE.md/README.md
- Monorepo کامل با TS strict، ESLint، Prettier، Turborepo
- ۶ Package مشترک (`contracts, config, logging, observability, nest-common, testing`)
- Infrastructure کامل (Postgres+PostGIS، Redis، Kafka، Keycloak Realm با
  ۴ کاربر Seed، MinIO، Temporal) — با Runbook برای هر مشکل واقعی برخورده‌شده
- ۶ سرویس Backend کامل: `identity, organization, asset, api-gateway, fleet, maintenance`
- ۴۱۵ تست واحد + ۷۳ تست Integration، همه سبز — محلی و روی Runner واقعی
- **۹ Suite تست Integration واقعی** — ۴ در fleet، ۵ در maintenance
- Kafka Consumer عمومی (`EventConsumer`) + Projector واقعی (`asset-service`
  Timeline از رویدادهای سرویس‌های دیگر)
- **CI Pipeline سبز روی GitHub Actions** (۴ Job، ۸ اجرا با Matrix) —
  **CI VERIFIED** تا Commit `24bef76`، Run `33172549841` (بخش ۱۹)
- **fleet-service:** Driver · Assignment (با Invariant انحصار در پایگاه داده) ·
  UsageRecord (Idempotent برای ثبت آفلاین) · Availability (ترکیبی، با نام مالک هر
  مانع) · Utilization · Consumer دوطرفه با asset-service
- **maintenance-service:** MaintenanceSchedule (سه محرک، سررسید مشتق‌شده) ·
  MaintenanceRequest (با کنترل منع درخواست تکراری در پایگاه داده) · RepairOrder ·
  PartUsage · LaborEntry · MaintenanceCost (هر خط با مبدأ) · دو Consumer با دو
  Group · دروازه تأیید پیش از تسویه
- **دو مسیر مرده پلتفرم زنده شدند:** `USAGE_RECORDED` مصرف‌کننده گرفت، و
  `MAINTENANCE_STARTED`/`MAINTENANCE_COMPLETED` تولیدکننده — هر دو زنده تأیید شدند
- ۵ ADR تازه (۰۲۵ انحصار تخصیص، ۰۲۶ مرز fleet↔asset، ۰۲۷ سررسید مشتق‌شده،
  ۰۲۸ مبدأ هزینه، ۰۲۹ دسترسی تعمیرگاه) + ۴ Open Question (Q-22 تا Q-25)
- **رفع D-005 و D-007** با تأیید زنده و CI (بخش ۲۲؛ جزئیات در `docs/23`)
- Git History تمیز: هر Commit اتمیک، Conventional Commits

---

## ۲۷. Not Yet Implemented

> **به‌روزرسانی 2026-08-29.** `economic-service` از این فهرست خارج شد. باقی‌مانده:
> `marketplace` · `procurement` · `supplier` · `inventory` · `construction` ·
> `contract` · `notification` · `document` · `audit` · `analytics`، و هر دو
> Frontend.

- Frontend (`apps/web`, `apps/admin`) — پوشه خالی، هیچ خط کدی نیست
- ۱۰ سرویس Backend باقی‌مانده (`marketplace, procurement, supplier, inventory,
construction, contract, economic, notification, document, audit, analytics`)
- E2E Tests واقعی (فقط پوشه خالی، بدون Playwright)
- `mission` و رویدادهای `MISSION_*` در fleet — عمداً موکول شد (ADR-026)
- Kubernetes manifests (`infrastructure/k8s/` خالی)
- Temporal Workflow واقعی (زیرساخت هست، هیچ Workflow نوشته نشده) — نخستین سرویسی
  که به یکی نیاز داشت `maintenance` بود و آگاهانه یک Scan محافظت‌شده جایش گذاشت
  (ADR-027)
- پورتال `WORKSHOP` و احراز صلاحیت تعمیرگاه (Q-25) — Port نام‌گذاری شده، بدون
  پیاده‌سازی
- Dockerfile برای `api-gateway`

---

## ۲۸. Current Roadmap

ترتیب واقعی طبق Domain Ownership (Asset باید قبل از Fleet/Maintenance
بیاید چون آن‌ها روی رویدادهای Asset تکیه می‌کنند):

```
✅ identity → ✅ organization → ✅ api-gateway → ✅ asset → ✅ fleet → ✅ maintenance
      ↓
   marketplace-service   ← NEXT / RECOMMENDED — شروع نشده (بخش ۲۹)
      ↓
   economic-service
      ↓
   construction-service → contract-service
      ↓
   procurement, supplier, inventory, notification, document, audit, analytics
      ↓
   Frontend (apps/web, apps/admin)
```

این ترتیب از `docs/17-mvp-scope.md` و توالی واقعی Git History استخراج شده؛
هیچ تغییری در تاریخ یا دامنه این Roadmap داده نشده.

**وضعیت هر گام (2026-08-28):**

| سرویس           | وضعیت                                                  |
| --------------- | ------------------------------------------------------ |
| identity        | IMPLEMENTED · TESTED · LIVE VERIFIED · CI VERIFIED     |
| organization    | IMPLEMENTED · TESTED · LIVE VERIFIED · CI VERIFIED     |
| api-gateway     | IMPLEMENTED · TESTED · LIVE VERIFIED (بدون Dockerfile) |
| asset           | IMPLEMENTED · TESTED · LIVE VERIFIED · CI VERIFIED     |
| fleet           | IMPLEMENTED · TESTED · LIVE VERIFIED · CI VERIFIED     |
| **maintenance** | **IMPLEMENTED · TESTED · LIVE VERIFIED · CI VERIFIED** |
| marketplace     | **NEXT / RECOMMENDED — NOT_STARTED**                   |
| ۹ سرویس دیگر    | NOT_STARTED                                            |
| Frontend        | NOT_STARTED — UI پشت دروازه تأیید صریح کاربر است       |

---

## ۲۹. Immediate Next Task

### فاز اقتصادی بسته شد — **READY_FOR_NEXT_PHASE**

هر پنج سطح تأیید کامل است و هیچ نقص بازِ مسدودکننده‌ای در `economic-service`
نمانده:

| سطح           | شاهد                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------- |
| IMPLEMENTED   | Wallet · Hold · Ledger · Journal · Transaction · Payment · Commission · Reward · Settlement |
| TESTED        | ۲۳۹ تست واحد در economic، ۶۵۴ در Monorepo                                                   |
| INTEGRATION   | ۱۰۰ تست روی PostgreSQL و Kafka واقعی، ۹ Suite، بدون Mock                                    |
| LIVE VERIFIED | ۲۶ سناریو از راه Gateway با توکن واقعی Keycloak (بخش ۲۱-ج)                                  |
| CI VERIFIED   | بخش ۱۹                                                                                      |

### گام بعدی: `marketplace-service`

پورت ۳۱۰۶، پایگاه داده `rasta_marketplace`، Topic `rasta.marketplace.v1`.

**و این بار ابهامی که حافظه پیشین ثبت کرده بود وجود ندارد.** آن نوشته بود
«Marketplace بدون `economic-service` نیمه‌کاره است» و یک تصمیم انسانی
می‌خواست. `economic-service` اکنون هست، و همه‌چیزی که سفارش لازم دارد آماده
است:

| نیاز سفارش                     | چیزی که آماده است                                                        |
| ------------------------------ | ------------------------------------------------------------------------ |
| `ORDER_CREATED` باید Hold بزند | `POST /v1/transactions` با `holdFunds: true` — یک تراکنش، بدون پنجره باز |
| تأیید دریافت                   | `POST /v1/transactions/{id}/authorise-settlement`                        |
| تسویه + کارمزد                 | `POST /v1/settlements` — هر سه در یک Journal متوازن                      |
| لغو                            | `POST /v1/transactions/{id}/refund`                                      |
| اعتراض                         | `POST /v1/transactions/{id}/dispute` — توقف کامل، بدون حرکت خودکار       |
| پاداش                          | موتور قاعده‌محور، منتظر پیکربندی                                         |

همه با `@AllowService('marketplace-service')`، که همان چیزی است که `docs/08`
§ ۸٫۶ به‌شکل Activity می‌خواهد. **marketplace باید تصمیم بگیرد** چه چیزی
فراخوانی است و چه چیزی رویداد — ADR-032 عمداً پیش‌داوری نکرده.

**الگویی که در این فاز کار کرد و باید تکرار شود:**

1. **هر Invariant که می‌تواند یک محدودیت پایگاه داده باشد، باید باشد.**
   `ck_wallet_balances` است که خرج بیش از موجودی را غیرممکن می‌کند؛ بررسی کد
   فقط پیام خطا می‌سازد. همین برای توازن Journal، تغییرناپذیری، و یکتایی Hold.
2. **وقتی دو بند سند با هم نمی‌خوانند، ADR بنویس — حدس نزن.** تناقض بند ۱۰٫۳ و
   ۱۰٫۴ با یک انتخاب دلبخواهی هم «حل» می‌شد؛ ADR-034 توضیح می‌دهد کدام نیمه
   درست بود و چرا.
3. **تست همروندی واقعی، سه نقص گرفت که هیچ بازبینی‌ای نمی‌گرفت.**
4. **وضعیت مشتق‌شده را بازمحاسبه کن، افزایش نده.** افزایش تدریجی یک
   Read-Modify-Write است.
5. **شکاف را نام‌گذاری کن، Stub نساز.** مصرف‌کننده‌های موکول هیچ Handler خالی
   ندارند، چون یک Handler خالی در `processed_event` رد می‌گذارد و شبیه کارکرده
   به نظر می‌رسد.
6. **تأیید زنده، سه چیز پیدا کرد که تست‌ها نگرفتند** — یک Endpoint که Gateway
   ردش می‌کرد، ردیف‌های بازمانده از اجراهای شکست‌خورده، و یک پورت رزروشده
   ویندوز.

### کارهای مستقل و کوچک‌تر

| کار                                            | چرا                                          |
| ---------------------------------------------- | -------------------------------------------- |
| Playwright برای E2E واقعی                      | `AGENTS.md` § ۷ برای `economic` می‌خواهدش    |
| Dockerfile برای `api-gateway`                  | تنها سرویسی که ندارد                         |
| حذف `--passWithNoTests` از سه سرویس باقی‌مانده | Project Integration شان تهی است              |
| D-008 (Supply-Chain)                           | سه قاعده Semgrep که Lockfile رد می‌کند       |
| پاسخ Q-08 و Q-09                               | تصمیم کارگروه راهبری؛ یک `POST` و یک `PATCH` |

---

### پیشین — فاز نگهداری بسته شد

هر پنج سطح تأیید کامل است و هیچ نقص بازِ مسدودکننده‌ای در `maintenance-service`
نمانده:

| سطح           | شاهد                                                                        |
| ------------- | --------------------------------------------------------------------------- |
| IMPLEMENTED   | Schedule · Request · RepairOrder · PartUsage · LaborEntry · MaintenanceCost |
| TESTED        | ۱۰۲ تست واحد در maintenance، ۴۱۵ در Monorepo — `pnpm verify` سبز            |
| INTEGRATION   | ۴۱ تست روی PostgreSQL و Kafka واقعی، بدون Mock                              |
| LIVE VERIFIED | ۳۵ سناریو از راه Gateway با توکن واقعی Keycloak (بخش ۲۱-ب)                  |
| CI VERIFIED   | Run `33172549841`، Commit `24bef76`، هر ۸ Job سبز                           |

### گام بعدی: `marketplace-service`

پورت ۳۱۰۶، پایگاه داده `rasta_marketplace`، Topic `rasta.marketplace.v1`.

`asset-service` هم‌اکنون `ORDER_COMPLETED` را در جدول Projection خودش دارد و منتظر
تولیدکننده است — همان الگویی که نگهداری با `USAGE_RECORDED` دید. اما یک تفاوت مهم
با فاز نگهداری وجود دارد و باید پیش از شروع دیده شود:

> **Marketplace بدون `economic-service` نیمه‌کاره است.** `ORDER_CREATED` باید
> Hold بزند و `ORDER_RECEIPT_CONFIRMED` باید تسویه کند؛ هر دو مال `economic` اند.
> نگهداری توانست مرزش را تمیز نگه دارد چون فقط **یک** رویداد به economic می‌دهد و
> هیچ‌چیز از آن نمی‌گیرد. سفارش این‌طور نیست.

پس پیش از شروع، یک تصمیم انسانی لازم است: **`marketplace` اول یا `economic` اول؟**
هیچ‌کدام در این حافظه پیش‌فرض ندارد.

**الگویی که در این فاز کار کرد و باید تکرار شود:**

1. **درس‌های فاز قبل را از روز اول اعمال کن.** Suite Integration نگهداری هیچ باگ
   تولیدی نگرفت — نه چون ضعیف‌تر بود، بلکه چون هر پنج تله فاز ناوگان از ابتدا
   بسته بودند. حافظه پروژه وقتی ارزش دارد که **قبل** از نوشتن کد خوانده شود.
2. **تست همروندی واقعی بنویس.** ده نوشتن هم‌زمان روی یک ردیف، یک Lost Update
   می‌گیرد که هیچ تست تک‌نخی نمی‌تواند.
3. **وضعیت مشتق‌شده را ذخیره نکن** اگر شکستِ محاسبه‌اش «همه‌چیز سالم است» گزارش
   می‌کند.
4. **شکاف را نام‌گذاری کن، نه Stub.** یک Port با یک پیاده‌سازی صادق، از یک پرچم
   پیکربندی خاموش بهتر است — چون دومی کنترلی را ادعا می‌کند که ندارد.
5. **CI را واقعاً اجرا کن.** در فاز ناوگان، CI باگی گرفت که هیچ اجرای محلی
   نمی‌توانست.

### کارهای مستقل و کوچک‌تر

| کار                                                         | چرا                                     |
| ----------------------------------------------------------- | --------------------------------------- |
| Dockerfile برای `api-gateway`                               | تنها سرویسی که ندارد؛ در CI Matrix نیست |
| حذف `--passWithNoTests` از چهار سرویس دیگر                  | Project Integration شان تهی است         |
| D-008 (Supply-Chain)                                        | سه قاعده Semgrep که Lockfile رد می‌کند  |
| D-006 (تصادم پورت Redis روی این ماشین)                      | فقط محیط توسعه                          |
| D-011 (رویداد نداشتن تغییر برنامه سرویس)                    | هنگام ساخت `audit-service` باید حل شود  |
| `InsuranceClaim` بدون API در `asset-service`                | جدول هست، Controller نیست               |
| Playwright برای E2E واقعی                                   | `tests/e2e/` هنوز خالی است              |
| Q-24 / Q-25 — تصمیم انسانی درباره دسترسی اپراتور و تعمیرگاه | هر دو مسدودکننده پورتال تعمیرگاه‌اند    |

**هیچ‌کدام از این‌ها را خودکار شروع نکن.**

---

## ۳۰. Rules for Future AI Agents

**قواعد عمومی (تخطی‌ناپذیر):**

- هرگز مرز سرویس را دور نزن — بدون Import میان‌سرویسی، بدون Join
  میان‌پایگاه‌داده، فقط REST یا Event.
- هرگز مستقیم به پایگاه داده سرویس دیگر متصل نشو.
- هرگز Tenant Isolation را دور نزن؛ خروج از Scope فقط با `runUnscoped` +
  دلیل نوشته‌شده.
- هرگز نیاز کسب‌وکاری یا واقعیت مقرراتی اختراع نکن؛ ابهام → `docs/24-open-questions.md`.
- هرگز قابلیت تأییدنشده را «پیاده‌شده» اعلام نکن — سه سطح Implemented/
  Tested/Live Verified را جدا نگه دار (بخش ۳).
- از `AGENTS.md` (قواعد الزام‌آور) و ADR ها (`docs/adr/`) پیروی کن.
- بعد از هر تغییر معماری مهم، این فایل را به‌روزرسانی کن (بخش «Memory
  Update Protocol» زیر).
- پیش از اعلام «انجام شد»، تست کن؛ برای رفتار میان‌سرویسی، Live Verification
  زنده انجام بده — یک ادعای «قبلاً تست شد» بدون Evidence تازه در Repository،
  کافی نیست.
- بدون تأیید صریح کاربر، UI پیاده نکن.
- **پیش از شروع هر کار غیرپیش‌پاافتاده، این فایل (`PROJECT_MEMORY.md`) و
  سند معماری مرتبط را بخوان.**

**قواعد خاص این Repository (از کد و تجربه واقعی استخراج شده):**

- سرویس‌ها باید قبل از `prisma generate` روی ویندوز متوقف شوند (قفل DLL — D-002).
- برای اجرای محلی یک سرویس: `node -r @swc-node/register --env-file=../../.env src/main.ts`
  از پوشه همان سرویس (نه `tsx`/esbuild — `design:paramtypes` را از دست
  می‌دهد و DI را بی‌صدا می‌شکند).
- `pnpm db:migrate` اکنون (پس از D-004) از یک Shell تمیز کار می‌کند —
  `scripts/prisma.mjs` خودش `DATABASE_URL_<SERVICE>` درست را پیدا می‌کند.
- هرگز نتیجه تست Redis محلی روی این ماشین را بدون تأیید `docker exec
rasta-redis redis-cli` (نه `localhost:6379` از میزبان) قطعی نگیر — D-006.
- پیش از هر ادعا درباره CI، `gh run list` را واقعاً اجرا کن — فرض «CI سبز
  است» چون فایل Workflow وجود دارد، اشتباه اثبات‌شده در این Repository است (D-005).
- **یک دروازه سبز لزوماً یعنی دروازه کار کرد، نه اینکه چیزی را بررسی کرد.**
  در همین Repository، Semgrep ماه‌ها `0` برمی‌گرداند بی‌آنکه یک فایل را
  Scan کند، و مرحله «Integration tests» امروز هم با صفر تست سبز می‌شود.
  پیش از اتکا به یک دروازه، Log خروجی‌اش را بخوان و ببین واقعاً چند چیز را
  دید (D-005).
- Healthcheck داکر را به‌عنوان حقیقتِ سلامت نخوان — در هر دو جهت. `rasta-temporal`
  ماه‌ها `unhealthy` بود و Server سالم بود؛ ریشه در محیط Docker میزبان بود، نه
  در Image (D-009/D-010). سبز بودن Healthcheck هم اثبات سلامت نیست: Broker
  کافکا به `--list` پاسخ می‌دهد در حالی که Group Coordinator هنوز بالا نیامده.

**قواعد افزوده در Task ناوگان (2026-08-28):**

- **Prisma نام Index را در خطای یکتایی گزارش نمی‌کند** — نام **ستون** را در
  `meta.target` می‌گذارد. هر کدی که نقض Constraint را به خطای کسب‌وکاری ترجمه
  می‌کند باید روی ستون تطبیق دهد، نه نام Index. این باگ در `fleet` بی‌صدا زنده
  بود تا نخستین تست Integration واقعی.
- **هرگز Default پایگاه داده و مقدار برنامه را در یک CHECK مقایسه نکن.**
  PostgreSQL در WSL2 روی این ماشین ۱۴–۵۶ میلی‌ثانیه از میزبان جلوتر است. اگر
  یک ستون `@default(now())` دارد و ستون دیگری از `new Date()` می‌آید و
  Constraint آن دو را مقایسه می‌کند، ردیف Constraint خودش را نقض می‌کند.
- **تست Integration را از روز اول بنویس، نه بعداً.** در `fleet` پنج باگ گرفت
  که هیچ‌کدام با تست واحد پیدا نمی‌شد — سه‌تا در کد تولیدی. تست واحد نمی‌تواند
  شکل خطای Prisma، انحراف ساعت، یا رفتار Tenant Guard را بسنجد؛ فقط پایگاه
  داده واقعی می‌تواند.
- **Docker Desktop خراب را Restart نکن اگر کانتینرها هنوز کار می‌کنند.**
  در این Task، Engine API از ابتدا خطای ۵۰۰ می‌داد ولی Runtime سالم بود و
  Migration و تست اجرا می‌شد. Restart، Stack کارکن را کشت و Engine هم
  برنگشت (D-010). اول بررسی کن پورت‌ها پاسخ می‌دهند یا نه؛ اگر می‌دهند، با
  همان کار کن. اگر ناچار شدی: ریشه معمولاً Socket های یتیم در
  `%LOCALAPPDATA%\Docker
un\` است — تغییر نام آن پوشه رفعش می‌کند.
- **PUT روی کاربر Keycloak، نمایش کامل را جایگزین می‌کند.** فرستادن فقط
  `{"attributes": …}` فیلدهای `email`/`firstName`/`lastName` را پاک کرد و کاربر
  با «Account is not fully set up» از کار افتاد. همیشه نمایش کامل را بفرست —
  `infrastructure/docker/keycloak/rasta-realm.json` منبع درست آن است.
- **Prisma نمی‌تواند Partial Index یا CHECK را بیان کند.** هر دو در SQL
  دست‌نویس انتهای Migration زندگی می‌کنند. اگر `prisma migrate dev` پیشنهاد
  `DROP` روی `ux_assignment_*` یا `ck_*` داد، **آن Hunk را رد کن** — Drift
  واقعی نیست، Prisma فقط نمی‌بیندشان.
- **تله Prisma Promise تنبل دوباره ظاهر می‌شود.** D-003 آن را در
  `runUnscoped` رفع کرد، ولی همان اشتباه در `test/helpers.ts` تازه تکرار شد:
  اگر Callback را non-async بنویسی، Query **بعد از** بسته شدن Context اجرا
  می‌شود. هر تابعی که یک Callback را داخل `AsyncLocalStorage` اجرا می‌کند،
  باید `async () => fn()` بنویسد نه `fn`.
- **رویدادی که یک Projector مصرف می‌کند، باید کلید Aggregate مقصد را حمل کند.**
  `timelineSourceSchema` در `asset-service` هر رویداد بدون `assetId` را بی‌صدا
  Skip می‌کند. ستون «Payload کلیدی» در کاتالوگ **خلاصه است، نه کامل** — پیش از
  اتکا به آن، Consumer واقعی را بخوان.
- **`--passWithNoTests` را به Suite Integration برنگردان.** در `fleet-service`
  عمداً حذف شده تا حذف آخرین تست، Build را بشکند. اگر `pnpm verify` روی ماشین
  بدون Docker شکست، راه‌حل این است که `test` فقط Project `unit` را اجرا کند —
  نه اینکه Flag برگردد.
- **مالکیت وضعیت را تقسیم کن و نامش را ببر.** «در دسترس بودن» از واقعیت چهار
  سرویس ساخته می‌شود؛ هیچ‌کدام را کپی نکن، و در پاسخ API مالک هر مانع را
  صریح بگو (ADR-026).

**قواعد افزوده در Task نگهداری (2026-08-28):**

- **حافظه پروژه را پیش از نوشتن کد بخوان، نه بعدش.** Suite Integration نگهداری
  هیچ باگ تولیدی نگرفت — نه چون ضعیف‌تر بود، بلکه چون هر پنج تله فاز ناوگان از روز
  اول بسته بودند. این تنها موردی است که «صفر باگ» یک شاهد مثبت است.
- **وضعیت مشتق‌شده را ذخیره نکن اگر شکستِ محاسبه‌اش «همه‌چیز سالم است» می‌گوید.**
  یک ستون `due` که Job شبانه پرش می‌کند، وقتی Job اجرا نشود هر دستگاه
  سررسیدگذشته را «سالم» گزارش می‌کند و هیچ‌چیز غلط به نظر نمی‌رسد. سامانه‌ای که
  سکوتش از خبر خوب قابل تشخیص نیست، از نبودش بدتر است.
- **مجموع را از اجزایش بازمحاسبه کن، هرگز افزایش نده.** افزایش یک
  Read-Modify-Write است. ده ثبت هزینه هم‌زمان روی یک دستور تعمیر، پیاده‌سازی
  افزایشی را قابل‌اعتماد می‌شکند — و **هیچ تست تک‌نخی این را نمی‌گیرد**. قفل ردیف
  والد پیش از جمع زدن، کل راه‌حل است.
- **تست همروندی واقعی بنویس، نه فقط تست ترتیبی.** `Promise.allSettled` روی ده
  فراخوان، ارزان‌ترین تستی است که یک Lost Update را می‌گیرد.
- **شکاف را نام‌گذاری کن، Stub نکن.** یک پرچم پیکربندی خاموش با شاخه‌ای که هرگز
  اجرا نمی‌شود، کنترلی را ادعا می‌کند که وجود ندارد. یک Port با یک پیاده‌سازی صادق
  (`WorkshopDirectory`) هم `grep` می‌شود و هم Log می‌دهد. و حکمش دو فیلد جدا دارد:
  `permitted` و `verified` — «مجاز چون واجد شرایط است» و «مجاز چون کسی نمی‌تواند
  تشخیص دهد» دو واقعیت متفاوت‌اند.
- **مجوزدهی را به‌صورت باریک‌سازی بنویس، نه گشاده‌سازی.** «اگر Supervisor است اجازه
  بده» یعنی نقشی که فردا به Keycloak اضافه می‌شود، به دسترسی کامل می‌افتد. جهت
  درست: همه باریک‌اند مگر آنکه صریحاً Supervisor باشند.
- **وقتی یک قاعده مستند قابل اجرا نیست، باریک‌ترش کن و ثبتش کن — تقریبش نزن.** و
  جهت باریک‌سازی را از روی **حالت شکست** انتخاب کن: رد کردن یک گزارش خرابی به‌خاطر
  Replica کهنه، بدتر از مزاحمتی است که قاعده جلویش را می‌گیرد.
- **رویداد تازه فراتر از کاتالوگ فقط برای درست نگه داشتن ادعایی که قبلاً منتشر
  شده.** `MAINTENANCE_CANCELLED` افزوده شد چون `MAINTENANCE_CREATED` قبلاً گفته بود
  کاری وجود دارد. `MAINTENANCE_SCHEDULE_CREATED` افزوده **نشد** چون هیچ ادعایی
  برای اصلاح نبود — و همان شکاف به‌عنوان D-011 ثبت شد، نه پنهان.
- **پیش از طراحی Payload، مصرف‌کننده موجود را بخوان.** `TimelineConsumer` در
  `asset-service` هزینه را از یک فیلد **مسطح** `totalCostMinor` می‌خواند و هر شکل
  دیگری را `null` می‌گیرد؛ شکل تودرتوی کاتالوگ، هزینه هر تعمیر را صفر ثبت می‌کرد.
  ستون «Payload کلیدی» کاتالوگ خلاصه است، نه قرارداد.
- **Heredoc طولانی در این محیط قابل اعتماد نیست.** نوشتن فایل‌های بزرگ با
  `cat <<'EOF'` گاهی نیمه‌کاره قطع می‌شود و Backslash ها را می‌خورد
  (یک Backslash دوتایی به یکی تبدیل می‌شود، و یکی در Template Literal اصلاً
  Backslash نیست — یعنی الگویی که هیچ‌چیز را Match نمی‌کند و هیچ خطایی هم نمی‌دهد).
  فایل‌های بزرگ را با ابزار نوشتن فایل بنویس، نه با Heredoc.
- **`docker exec` در Git Bash روی ویندوز مسیرها را تبدیل می‌کند.**
  `docker exec x /opt/kafka/bin/…` به `C:/Program Files/Git/opt/…` تبدیل می‌شود.
  `MSYS_NO_PATHCONV=1` جلویش را می‌گیرد.

---

## Memory Update Protocol

این فایل باید با هرکدام از این تغییرات به‌روز شود:

- افزودن یا حذف یک Service
- افزودن یک Event جدید (Producer یا Consumer)
- تغییر در Domain Ownership یا مرز Database
- تغییر در مدل Security/Authentication/Authorization
- تغییر در Database Ownership یا Schema اصلی یک سرویس
- افزودن/تغییر یک Integration بین سرویس‌ها
- کشف یا رفع یک Known Issue بحرانی

به‌روزرسانی یعنی: بخش مربوطه در همین فایل ویرایش شود (نه فقط یک خط اضافه
در انتها)، و جدول بخش ۳ (Current Verified State) با شواهد تازه هم‌راستا
بماند.

---

_آخرین Audit کامل: 2026-08-27. آخرین به‌روزرسانی: 2026-08-28 (Task ناوگان).
برای جزئیات هر یافته، به `docs/23-risks-and-tradeoffs.md` بخش ۲۳٫۵-الف مراجعه کنید._
