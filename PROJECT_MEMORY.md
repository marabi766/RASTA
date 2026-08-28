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
> **آخرین به‌روزرسانی:** 2026-08-28 — **فاز `fleet-service` بسته شد:
> READY_FOR_NEXT_PHASE.** پنجمین سرویس، با هر پنج سطح تأیید کامل:
>
> | سطح             | شاهد                                                                       |
> | --------------- | -------------------------------------------------------------------------- |
> | IMPLEMENTED     | Driver · Assignment · UsageRecord · Availability · Utilization             |
> | TESTED          | ۸۸ تست واحد در fleet؛ ۳۱۳ در کل Monorepo                                   |
> | INTEGRATION     | ۳۲ تست روی PostgreSQL و Kafka **واقعی** — بدون Mock                        |
> | LIVE VERIFIED   | ۲۰ سناریو از راه Gateway با توکن واقعی Keycloak (بخش ۲۱)                   |
> | **CI VERIFIED** | **Run `33147827056`، Commit `d2f82f8` (آخرین تغییر کد فاز)، هر ۷ Job سبز** |
>
> دو ADR تازه (۰۲۵، ۰۲۶) و دو Open Question تازه (Q-22، Q-23).
>
> **تست‌ها در مجموع شش باگ گرفتند** — پنج‌تا در نخستین اجرای Integration محلی و
> **یکی که فقط CI می‌توانست پیدا کند** (Race در Group Coordinator کافکا).
> جزئیات هر شش در بخش ۲۲. **D-009 و D-010 هر دو رفع شدند.**

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
```

**گام بعدی طبق مستندسازی این Repository:** `maintenance-service` (بخش ۲۸) —
`fleet-service` زنده تأیید شد (بخش ۲۱).

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

| Feature                                                      |     Implemented     | Automated Tests  | Live Verified (2026-08-27)                                                                       |
| ------------------------------------------------------------ | :-----------------: | :--------------: | ------------------------------------------------------------------------------------------------ |
| Tenant Isolation (API)                                       |         ✅          |        ✅        | ✅ (403 TENANT_MISMATCH زنده گرفته شد)                                                           |
| Tenant Isolation (Database)                                  |         ✅          |        —         | ✅ (`permission denied for database` زنده گرفته شد)                                              |
| Cross-tenant read → 404                                      |         ✅          |        ✅        | ✅                                                                                               |
| RBAC (Roles Guard)                                           |         ✅          |        ✅        | ✅ (Auditor → 403 روی POST)                                                                      |
| JWT verification (Keycloak/JWKS)                             |         ✅          |        ✅        | ✅ (۴ کاربر Seed، توکن واقعی گرفته شد)                                                           |
| Transactional Outbox → Kafka                                 |         ✅          |        ✅        | ✅ (Asset ساخته شد → Outbox → Kafka، Correlation تطبیق)                                          |
| Event Consumer / Dossier Projector                           |         ✅          |   ✅ (18 تست)    | ✅ (رویداد ساختگی maintenance → یک خط Timeline، Replay دوباره = بدون تکرار)                      |
| API Gateway routing + circuit breaker                        |         ✅          |   ✅ (21 تست)    | ✅ (مسیر به سرویس نساخته‌شده fleet → 503 تمیز)                                                   |
| Redis Rate Limiting (منطق)                                   |         ✅          |    ✅ (واحد)     | ⚠️ **مسدود شده توسط تداخل Port میزبان — بخش ۲۲.۳ D-006**                                         |
| Anonymous public endpoint (self-registration) از راه Gateway |         ✅          |   ✅ (17 تست)    | ✅ **`201` زنده گرفته شد — D-007 رفع شد**                                                        |
| CI/CD روی GitHub Actions                                     |         ✅          |        —         | ✅ **CI VERIFIED** — Run `33147827056`، Commit `d2f82f8`، هر ۷ Job سبز؛ ۴ Run پیاپی سبز پس از آن |
| Docker Build (identity, organization)                        |         ✅          |        —         | ✅ **CI VERIFIED** — Build + Trivy Scan هر دو Image روی Runner سبز                               |
| Docker Build (asset, fleet)                                  | ✅ Dockerfile دارند |        —         | ✅ **CI VERIFIED** — Build + Trivy روی Runner برای هر دو                                         |
| Docker Build (api-gateway)                                   | ❌ Dockerfile ندارد |        —         | ❌ باز (بخش ۲۲)                                                                                  |
| **fleet-service — Driver/Assignment/Usage/Availability**     |         ✅          |   ✅ (۸۸ تست)    | ✅ زنده + **CI VERIFIED**                                                                        |
| **Assignment Exclusivity (Partial Unique Index)**            |         ✅          | ✅ (Integration) | ✅ زنده: راننده مشغول → `422 DRIVER_ALREADY_ASSIGNED`                                            |
| **Fleet → Kafka → Asset Projector**                          |         ✅          |   ✅ (۳۲ تست)    | ✅ **زنده** — Timeline پر شد، وضعیت `IDLE→ASSIGNED→ACTIVE`                                       |
| **Idempotency (ثبت آفلاین + Replay مصرف‌کننده)**             |         ✅          |        ✅        | ✅ زنده: ارسال دوباره = همان رکورد؛ Replay کافکا = بدون اثر دوم                                  |
| **correlationId در کل زنجیره**                               |         ✅          |        ✅        | ✅ زنده: HTTP → Outbox → Header کافکا → Timeline، یکسان                                          |
| Frontend (`apps/web`, `apps/admin`)                          |         ❌          |        —         | NOT_STARTED — پوشه خالی                                                                          |
| Integration Tests (`*.int-spec.ts`)                          | ✅ ۴ Suite در fleet |        —         | ✅ **۳۲ از ۳۲ روی Runner واقعی GitHub**                                                          |
| E2E Tests (`tests/e2e`, Playwright)                          |         ❌          |        —         | پوشه خالی، بدون Config                                                                           |
| maintenance/marketplace/… (۱۱ سرویس)                         |         ❌          |        —         | NOT_STARTED                                                                                      |

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
  (11 سرویس دیگر)         NOT_STARTED — حتی پوشه هم وجود ندارد

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

| Service                | Port        | Status                                                 | DB                   | Tests                        | Docker                               |
| ---------------------- | ----------- | ------------------------------------------------------ | -------------------- | ---------------------------- | ------------------------------------ |
| `api-gateway`          | 3000/3010\* | IMPLEMENTED                                            | — (بدون Database)    | 30 Unit                      | ❌ Dockerfile ندارد                  |
| `identity-service`     | 3101        | IMPLEMENTED                                            | `rasta_identity`     | 14 Unit                      | ✅ در CI Matrix                      |
| `organization-service` | 3102        | IMPLEMENTED                                            | `rasta_organization` | 21 Unit                      | ✅ در CI Matrix                      |
| `asset-service`        | 3103        | IMPLEMENTED (با یک Gap — بخش ۱۸)                       | `rasta_asset`        | 74 Unit                      | ✅ **در CI Matrix**                  |
| `fleet-service`        | 3104        | IMPLEMENTED · TESTED · LIVE VERIFIED · **CI VERIFIED** | `rasta_fleet`        | **88 Unit + 32 Integration** | ✅ **در CI Matrix**، Build+Trivy سبز |
| ۱۱ سرویس دیگر          | 3105–3116   | NOT_STARTED                                            | —                    | ۰                            | —                                    |

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

## ۸. Domain Ownership

| دامنه                                   | سرویس مالک             | یادداشت                                      |
| --------------------------------------- | ---------------------- | -------------------------------------------- |
| User، Membership، Role                  | `identity-service`     | User مستأجر-محدود **نیست**؛ Membership هست   |
| Organization، Hierarchy، Policy         | `organization-service` | `ltree` برای سلسله‌مراتب                     |
| Asset، Insurance، Inspection، Timeline  | `asset-service`        | مرکز الگوی Asset-Centric (ADR-012)           |
| Driver، Assignment، Usage، Availability | `fleet-service`        | نخستین مصرف‌کننده واقعی رویدادهای Asset      |
| ۱۱ دامنه دیگر                           | سرویس‌های نساخته       | نگاه کنید `docs/04-service-decomposition.md` |

**مالکیت «در دسترس بودن» تقسیم‌شده است** (ADR-026). `fleet-service` آن را
**ترکیب می‌کند، نه مالکیت**:

| واقعیت                    | مالک                  | چطور به fleet می‌رسد             |
| ------------------------- | --------------------- | -------------------------------- |
| وضعیت چرخه عمر دارایی     | `asset-service`       | رویداد → `asset_ref.status`      |
| بیمه منقضی / معاینه مردود | `asset-service`       | رویداد → `dispatchBlockedReason` |
| دستگاه در تعمیرگاه        | `maintenance-service` | رویداد → `inMaintenance`         |
| تخصیص فعال                | `fleet-service`       | جدول `assignment` خودش           |
| اعلام دستی                | `fleet-service`       | جدول `availability_window`       |

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
- Topic هر دامنه: `rasta.<domain>.v1` (+ `.retry` و `.dlq`). امروز فقط
  `asset`, `insurance` (تولیدکننده واقعی) و `fleet`, `maintenance`,
  `marketplace`, `construction` (مصرف‌شونده توسط asset-service، تولیدکننده
  هنوز نساخته) دارای ترافیک واقعی هستند. ۴۹ Topic از قبل در Kafka ساخته شده
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

۳ پایگاه داده فعال با داده واقعی (از `pnpm db:seed`):

- `rasta_identity` — ۴ کاربر Seed + Membership + Role
- `rasta_organization` — ۵ سازمان (Province → Union/County → 2× Dehyari)
- `rasta_asset` — ۵ دارایی، ۳ بیمه‌نامه، ۲ معاینه فنی

مدل‌های هر Schema: بخش ۷ Service Inventory بالا برای شمارش کلی؛ فهرست کامل
مدل‌ها در `prisma/schema.prisma` هر سرویس.

**۱۳ پایگاه داده دیگر** طبق `00-init-databases.sh` ساخته شده‌اند (نقش +
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

### واقعی، از اجرای امروز `pnpm verify` (نه از حافظه سند قدیمی):

```
@rasta/config                11 تست
@rasta/logging                9 تست
@rasta/observability         10 تست
@rasta/nest-common           56 تست
@rasta/api-gateway           30 تست
@rasta/identity-service      14 تست
@rasta/organization-service  21 تست
@rasta/asset-service         74 تست
@rasta/fleet-service         88 تست   ← فاز ناوگان
———————————————————————————————
مجموع Unit                  313 تست، همه سبز
مجموع Integration            32 تست، همه سبز (فقط fleet)
E2E                           NOT IMPLEMENTED — بدون Playwright، پوشه خالی
```

از `pnpm run test` و `pnpm --filter @rasta/fleet-service test:integration`،
اجراشده در 2026-08-28. اعداد از خروجی واقعی گرفته شده، نه از گزارش پیشین.

هر ۳۱۳ عدد روی Runner واقعی GitHub هم دیده شد — **Run `33147827056`،
Commit `d2f82f8`** — پس این شمارش دیگر فقط محلی نیست.

**Integration Tests — دیگر تهی نیست.** `fleet-service` نخستین سرویسی است که تست
Integration واقعی دارد (۴ Suite در `services/fleet-service/test/`):

| Suite                                | چه چیزی را ثابت می‌کند                                                     |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `tenant-isolation.int-spec.ts`       | Extension واقعاً `where` را بازنویسی می‌کند؛ نوشتن میان‌تنانتی رد می‌شود   |
| `assignment-concurrency.int-spec.ts` | Partial Unique Index وجود دارد و دو درخواست هم‌زمان را به یکی می‌رساند     |
| `usage-outbox.int-spec.ts`           | تغییر وضعیت و Outbox با هم Commit می‌شوند؛ Replay رویداد دوم منتشر نمی‌کند |
| `event-flow.int-spec.ts`             | مسیر کامل تا Kafka و بازگشت از Consumer، با Envelope و correlationId       |

دو تغییر عمدی در Script ها:

- **`test:integration` در fleet `--passWithNoTests` ندارد.** حذف آخرین فایل
  `test/` از این پس Build را می‌شکند — دقیقاً همان شکستی که این Repository
  قبلاً تجربه کرد.
- **`test` در fleet فقط Project `unit` را اجرا می‌کند**، تا `pnpm verify` روی
  ماشین بدون Docker قابل اجرا بماند. Suite Integration یک دروازه جدا است که CI
  صریحاً در برابر سرویس‌های Provision‌شده اجرا می‌کند.

**وضعیت اجرا:** **۳۲ از ۳۲ سبز** روی PostgreSQL و Kafka واقعی (2026-08-28).

این Suite در نخستین اجرای واقعی‌اش **پنج باگ** گرفت که هیچ‌کدام با تست واحد
پیدا نمی‌شد — سه‌تا در کد تولیدی و دوتا در خود تست‌ها. فهرست کامل در بخش ۲۲.
همچنین هر دو Partial Unique Index و هر شش CHECK Constraint با پرس‌وجوی مستقیم
از `pg_indexes` و `pg_constraint` در پایگاه داده دیده شدند.

**E2E Tests:** `tests/e2e/` پوشه‌ای خالی است، بدون `playwright.config.ts`.
`pnpm test:e2e` هست اما `turbo run test:e2e` روی هیچ Package ای Script
واقعی ندارد.

### ✅ CI/CD — **CI VERIFIED** (به‌روزشده برای فاز ناوگان)

**نخستین Run سبز روی کد کامل ناوگان: `33147827056`، Commit `d2f82f8`،
success در ۱۱ دقیقه.** این همان Commit ای است که آخرین تغییر کد فاز را دارد؛
Commit های پس از آن فقط مستندات‌اند.

| Run           | Commit    | محتوا           | نتیجه                                               |
| ------------- | --------- | --------------- | --------------------------------------------------- |
| `33147388059` | `97430e7` | کد کامل ناوگان  | **failure** — Race در Group Coordinator کافکا (زیر) |
| `33147827056` | `d2f82f8` | + رفع همان Race | success                                             |
| `33148910234` | `7acd619` | فقط مستندات     | success                                             |
| `33149848438` | `af74157` | فقط مستندات     | success                                             |
| `33150357661` | `1edf8ee` | فقط مستندات     | success                                             |

چهار Run پیاپی سبز پس از آن یک شکست — یعنی سبز بودن یک وضعیت پایدار است، نه
یک اتفاق. **قاعده به‌روزرسانی:** این جدول فقط وقتی تغییر می‌کند که **کد** عوض
شود؛ Commit مستنداتیِ بعدی لازم نیست اینجا ثبت شود.
هر **هفت** Job سبز — چهار Image به‌جای دو، و برای نخستین‌بار یک Broker واقعی
در Pipeline.

| Job                            | مراحلی که واقعاً اجرا شدند                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| Lint, types and unit tests     | install · db:generate · Format · Lint · Typecheck · **۳۱۳ تست واحد** · Build                    |
| Security scans                 | Gitleaks · `pnpm audit --audit-level=high` · Semgrep                                            |
| Integration and security tests | Postgres + Redis + **Kafka** · ساخت ۶ Topic · Migration · **۳۲ تست Integration** · Tenant/AuthZ |
| Build and scan images × **۴**  | identity · organization · **asset** · **fleet** — هرکدام Build + Trivy                          |

**شواهد اینکه مرحله Integration واقعاً چیزی را اجرا کرد** (نه اینکه تهی سبز شود):
Log خود Runner نشان می‌دهد `PASS integration test/event-flow.int-spec.ts` و
`Tests: 32 passed, 32 total`. Trivy روی Image ناوگان
`os_version="3.24" pkg_num=18` را با شدت `CRITICAL,HIGH` اسکن کرد و بدون یافته
گذشت.

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

| مکانیزم                               | Implemented | Tested |                  Live Verified                  | یادداشت                                                                                                                                                                          |
| ------------------------------------- | :---------: | :----: | :---------------------------------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication (JWT/JWKS)             |     ✅      |   ✅   |                       ✅                        | زنده دوباره تأیید شد: `200` با JWT کی‌کلوک از راه Gateway                                                                                                                        |
| Authorization (RBAC سطح Endpoint)     |     ✅      |   ✅   |                       ✅                        | زنده: `province.auditor` → `POST /v1/users` → `403 INSUFFICIENT_ROLE`                                                                                                            |
| Tenant Isolation (API + DB)           |     ✅      |   ✅   |                       ✅                        | زنده: `X-Organization-Id` بیگانه → `403 TENANT_MISMATCH`                                                                                                                         |
| Service-to-Service Auth (Zero Trust)  |     ✅      |   ✅   |                       ✅                        | D-007 رفع شد؛ Claim `purpose` — RELAY در برابر SERVICE (بخش ۱۱)                                                                                                                  |
| Rate Limiting (منطق Redis)            |     ✅      |   ✅   |                    ⚠️ مسدود                     | D-006: تصادم پورت Redis                                                                                                                                                          |
| Input Validation (Zod در مرز)         |     ✅      |   ✅   |                       ✅                        |                                                                                                                                                                                  |
| **Object-level Authorization (BOLA)** |     ✅      |   ✅   |                       ✅                        | **IMPLEMENTED در fleet** (`src/fleet/access.ts`): `DRIVER`/`OPERATOR` فقط رکورد خود و دستگاهی که در دست دارند. زنده: `province.auditor` → فهرست خالی. سایر سرویس‌ها هنوز ندارند. |
| **Non-disclosure میان تنانتی**        |     ✅      |   ✅   |                       ✅                        | زنده: منبع تنانت دیگر → **`404`**، هرگز `403` — روی Driver، Assignment و UsageRecord آزموده شد                                                                                   |
| Audit Trail                           |   ⚠️ جزئی   |   —    |                       نشد                       | `audit-service` نساخته؛ Event های تولید می‌شوند اما جایی ذخیره نمی‌شوند                                                                                                          |
| Secrets فقط از Env                    |     ✅      |   —    | ✅ (`.env` بررسی شد؛ Secret واقعی در Repo نیست) |                                                                                                                                                                                  |
| Security Headers (helmet)             |     ✅      |   —    |                       ✅                        | CSP، HSTS، Referrer-Policy                                                                                                                                                       |
| mTLS بین سرویس‌ها                     |     ❌      |   —    |                        —                        | **PLANNED** — صفر ارجاع در کد (`grep` تأیید شد). Production-only                                                                                                                 |
| Database RLS                          |     ❌      |   —    |                        —                        | **PLANNED** — صفر Migration دارد. Tenant Isolation فعلاً **فقط لایه Application** است                                                                                            |

**وضعیت High-risk items پس از Task سخت‌سازی 2026-08-27:**

- ✅ **D-005 رفع شد** — CI روی GitHub Actions سبز است (**CI VERIFIED**).
- ✅ **D-007 رفع شد** — ثبت‌نام گمنام از راه Gateway کار می‌کند
  (**LIVE VERIFIED**)، بدون تضعیف Zero Trust.
- ✅ **D-010 رفع شد** — Docker بازیابی شد؛ ریشه: Socket های یتیم (بخش ۲۲).
- ⏳ **D-006 باز است** — تصادم پورت Redis روی این ماشین توسعه.
- 🆕 **D-008 باز است** — سه قاعده Supply-Chain که Lockfile فعلی رد می‌کند.
- ✅ **D-009 رفع شد** — Temporal `healthy` است و CLI داخل Image پاسخ می‌دهد.

**تفکیک IMPLEMENTED از PLANNED — تأییدشده با بازرسی کد، نه با سند:**

| کنترل                                              | وضعیت واقعی                                                                               |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Keycloak / OIDC / JWKS                             | **IMPLEMENTED** + LIVE VERIFIED                                                           |
| اعتبارسنجی JWT (`iss`, `exp`)                      | **IMPLEMENTED** + LIVE VERIFIED — Container توکن با `iss` نامنطبق را رد کرد               |
| Tenant Isolation سطح Application                   | **IMPLEMENTED** + LIVE VERIFIED + CI VERIFIED                                             |
| Object-level Authorization                         | **IMPLEMENTED** در fleet؛ سایر سرویس‌ها **NOT IMPLEMENTED**                               |
| Database RLS                                       | **PLANNED** — صفر Migration                                                               |
| mTLS سرویس‌به‌سرویس                                | **PLANNED** — صفر ارجاع در کد                                                             |
| Audit Trail ماندگار                                | **PLANNED** — `audit-service` وجود ندارد؛ رویدادها تولید می‌شوند اما مصرف‌کننده‌ای ندارند |
| ریشه، خرابی محیط Docker بود (D-010)، نه نقص Image. |

---

## ۲۱. Current Runtime State

در لحظه تأیید زنده (2026-08-28)، هر ۵ سرویس پیاده‌شده از حالت تمیز بالا آمدند و
سالم گزارش دادند:

```
api-gateway           :3010   {"status":"ok","checks":{"redis":true}}
identity-service      :3101   {"status":"ok","checks":{"database":true,"kafka":true}}
organization-service  :3102   {"status":"ok","checks":{"database":true,"kafka":true}}
asset-service         :3103   {"status":"ok","checks":{"database":true,"kafka":true}}
fleet-service         :3104   {"status":"ok","checks":{"database":true,"kafka":true}}
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

Kafka Consumer Group های فعال: `asset-service.timeline` و
`fleet-service.asset-sync`.

---

## ۲۲. Known Issues

### فعال (رفع‌نشده)

| #     | مسئله                                                                            | شدت                             | تأثیر                                                                         | راه‌حل موقت                                                                                     |
| ----- | -------------------------------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| D-006 | Redis محلی Windows روی پورت ۶۳۷۹ با Redis داکری تصادم دارد                       | بالا (فقط محیط توسعه این ماشین) | تست زنده Rate Limiting/Idempotency از راه `localhost:6379` غیرقابل‌اعتماد     | استفاده از `docker exec rasta-redis redis-cli` مستقیم؛ یا تغییر `REDIS_PORT` مثل الگوی Postgres |
| D-008 | سه قاعده Supply-Chain که Lockfile فعلی رد می‌کند                                 | متوسط                           | پنجره نصب نسخه تازه‌منتشرشده مخرب باز است؛ ۴ هشدار Trust بررسی‌نشده           | Semgrep با `--exclude-rule` نام‌دار عبور می‌کند؛ بررسی کامل یک Task مستقل است                   |
| —     | چهار سرویس دیگر هنوز `--passWithNoTests` دارند و Project Integration شان تهی است | متوسط                           | سهم آن‌ها از مرحله Integration در CI یعنی «چیزی نشکست»، نه «مسیر داده تست شد» | برای هر سرویس، کار همان سرویس است؛ `fleet` الگو را نشان داده                                    |
| —     | `api-gateway` هیچ Dockerfile ندارد                                               | متوسط                           | نمی‌توان آن را Containerize کرد                                               | نوشتن Dockerfile لازم است                                                                       |
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

**هیچ‌کدام در این Audit حل نشدند** — همگی هنوز باز و در
[`docs/24-open-questions.md`](docs/24-open-questions.md) هستند:

- نرخ کارمزد پلتفرم (۲۴٫۲)
- مرجع موافقت زنجیره تأیید مناقصه/قرارداد (۲۴٫۱، ۲۴٫۲)
- الزامات حقوقی کیف پول/نگهداری وجوه (۲۴٫۱)
- یکپارچگی ملی (شاهکار، ثبت‌احوال و…) (۲۴٫۳)
- نگهداشت داده و حریم خصوصی (۲۴٫۱)
- برند و محصول نهایی (۲۴٫۴)

هیچ‌کدام با حدس پر نشدند، طبق دستور صریح کاربر در همه Prompt های قبلی.

---

## ۲۵. Architecture Decisions

۲۴ ADR موجود (`docs/adr/ADR-001` تا `ADR-024`)، فهرست کامل در
`docs/21-adr-list.md`. هیچ ADR جدیدی در این Audit لازم نبود — دو رفع باگ
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
- ۵ سرویس Backend کامل: `identity, organization, asset, api-gateway, fleet`
- ۳۱۳ تست واحد + ۳۲ تست Integration، همه سبز — محلی و روی Runner واقعی
- **۴ Suite تست Integration واقعی** (نخستین در این Repository) — در fleet
- Kafka Consumer عمومی (`EventConsumer`) + Projector واقعی (`asset-service`
  Timeline از رویدادهای سرویس‌های دیگر)
- **CI Pipeline سبز روی GitHub Actions** (۴ Job، ۵ اجرا با Matrix) —
  **CI VERIFIED** تا Commit `d2f82f8`، Run `33147827056` (بخش ۱۹)
- **fleet-service:** Driver · Assignment (با Invariant انحصار در پایگاه داده) ·
  UsageRecord (Idempotent برای ثبت آفلاین) · Availability (ترکیبی، با نام مالک هر
  مانع) · Utilization · Consumer دوطرفه با asset-service
- ۲ ADR تازه (۰۲۵ انحصار تخصیص، ۰۲۶ مرز fleet↔asset) + ۲ Open Question (Q-22، Q-23)
- **رفع D-005 و D-007** با تأیید زنده و CI (بخش ۲۲؛ جزئیات در `docs/23`)
- Git History تمیز: هر Commit اتمیک، Conventional Commits

---

## ۲۷. Not Yet Implemented

- Frontend (`apps/web`, `apps/admin`) — پوشه خالی، هیچ خط کدی نیست
- ۱۱ سرویس Backend باقی‌مانده (`maintenance, marketplace, procurement,
supplier, inventory, construction, contract, economic, notification,
document, audit, analytics`)
- E2E Tests واقعی (فقط پوشه خالی، بدون Playwright)
- `mission` و رویدادهای `MISSION_*` در fleet — عمداً موکول شد (ADR-026)
- Kubernetes manifests (`infrastructure/k8s/` خالی)
- Temporal Workflow واقعی (زیرساخت هست، هیچ Workflow نوشته نشده)
- Dockerfile برای `api-gateway`

---

## ۲۸. Current Roadmap

ترتیب واقعی طبق Domain Ownership (Asset باید قبل از Fleet/Maintenance
بیاید چون آن‌ها روی رویدادهای Asset تکیه می‌کنند):

```
✅ identity → ✅ organization → ✅ api-gateway → ✅ asset → ✅ fleet
      ↓
   maintenance-service   ← NEXT / RECOMMENDED — شروع نشده (بخش ۲۹)
      ↓
   marketplace-service → economic-service
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

| سرویس         | وضعیت                                                  |
| ------------- | ------------------------------------------------------ |
| identity      | IMPLEMENTED · TESTED · LIVE VERIFIED · CI VERIFIED     |
| organization  | IMPLEMENTED · TESTED · LIVE VERIFIED · CI VERIFIED     |
| api-gateway   | IMPLEMENTED · TESTED · LIVE VERIFIED (بدون Dockerfile) |
| asset         | IMPLEMENTED · TESTED · LIVE VERIFIED · CI VERIFIED     |
| **fleet**     | **IMPLEMENTED · TESTED · LIVE VERIFIED · CI VERIFIED** |
| maintenance   | **NEXT / RECOMMENDED — NOT_STARTED**                   |
| ۱۰ سرویس دیگر | NOT_STARTED                                            |
| Frontend      | NOT_STARTED — UI پشت دروازه تأیید صریح کاربر است       |

---

## ۲۹. Immediate Next Task

### فاز ناوگان بسته شد — **READY_FOR_NEXT_PHASE**

هر پنج سطح تأیید کامل است و هیچ نقص بازِ مسدودکننده‌ای در `fleet-service` نمانده:

| سطح           | شاهد                                                           |
| ------------- | -------------------------------------------------------------- |
| IMPLEMENTED   | Driver · Assignment · UsageRecord · Availability · Utilization |
| TESTED        | ۸۸ تست واحد در fleet، ۳۱۳ در Monorepo — `pnpm verify --force`  |
| INTEGRATION   | ۳۲ تست روی PostgreSQL و Kafka واقعی، بدون Mock                 |
| LIVE VERIFIED | ۲۰ سناریو از راه Gateway با توکن واقعی Keycloak (بخش ۲۱)       |
| CI VERIFIED   | Run `33147827056`، Commit `d2f82f8`، هر ۷ Job سبز              |

### گام بعدی: `maintenance-service`

پورت ۳۱۰۵، پایگاه داده `rasta_maintenance`، Topic `rasta.maintenance.v1`.

دو مسیر امروز **مرده**اند و این سرویس هر دو را زنده می‌کند — یعنی نخستین سرویسی
است که هر دو سرش از قبل آماده است:

- `fleet` هم‌اکنون `USAGE_RECORDED` منتشر می‌کند، **محرک اصلی نگهداری
  پیشگیرانه** (`docs/04` § ۴٫۶). مصرف‌کننده‌اش وجود ندارد.
- `fleet` هم‌اکنون `MAINTENANCE_STARTED`/`MAINTENANCE_COMPLETED` را مصرف می‌کند
  و به `asset_ref.inMaintenance` می‌نویسد. تولیدکننده‌اش وجود ندارد.

**الگویی که در این فاز کار کرد و باید تکرار شود:**

1. **تست Integration واقعی از روز اول** — بدون `--passWithNoTests`. در `fleet`
   شش باگ گرفت که هیچ‌کدام با تست واحد پیدا نمی‌شد.
2. **Invariant را در پایگاه داده بگذار**، نه فقط در لایه Application. دو
   درخواست هم‌زمان از بررسی Application عبور می‌کنند.
3. **مرز مالکیت را با Replica رویدادمحور نگه دار**، نه با REST همزمان.
4. **CI را واقعاً اجرا کن.** در همین فاز، CI باگی را گرفت که هیچ اجرای محلی
   نمی‌توانست.

### کارهای مستقل و کوچک‌تر

| کار                                          | چرا                                     |
| -------------------------------------------- | --------------------------------------- |
| Dockerfile برای `api-gateway`                | تنها سرویسی که ندارد؛ در CI Matrix نیست |
| حذف `--passWithNoTests` از چهار سرویس دیگر   | Project Integration شان تهی است         |
| D-008 (Supply-Chain)                         | سه قاعده Semgrep که Lockfile رد می‌کند  |
| D-006 (تصادم پورت Redis روی این ماشین)       | فقط محیط توسعه                          |
| `InsuranceClaim` بدون API در `asset-service` | جدول هست، Controller نیست               |
| Playwright برای E2E واقعی                    | `tests/e2e/` هنوز خالی است              |

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
