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
> **آخرین به‌روزرسانی:** 2026-08-28 — **`fleet-service` ساخته شد** (پنجمین سرویس).
> ۶۷ تست واحد + ۴ Suite تست Integration **واقعی** — نخستین تست‌های Integration
> این Repository، که خودشان دو باگ واقعی گرفتند. `pnpm verify` کامل سبز
> (۲۹۲ تست). دو ADR تازه (۰۲۵، ۰۲۶) و دو Open Question تازه (Q-22، Q-23).
>
> **⚠️ Live Verification انجام نشد.** Docker Desktop روی این ماشین در میانه کار
> از کار افتاد و بازنگشت — بخش ۲۲، **D-010**. مسیر E2E زنده
> (Gateway → fleet → Kafka → Asset Projector) **NOT VERIFIED** است. تست‌های
> Integration پیش از خرابی تا حدی روی PostgreSQL واقعی اجرا شدند اما **یک اجرای
> کامل سبز ثبت نشده**. CI هم هنوز روی این تغییرات اجرا نشده.

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
12. fleet-service  ← کامل (کد + تست)، اما Live Verify نشده (D-010)
```

**گام بعدی طبق مستندسازی این Repository:** `maintenance-service` (بخش ۲۸) —
**پس از** رفع D-010 و تأیید زنده `fleet-service`.

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

| Feature                                                      |          Implemented           | Automated Tests  | Live Verified (2026-08-27)                                                                   |
| ------------------------------------------------------------ | :----------------------------: | :--------------: | -------------------------------------------------------------------------------------------- |
| Tenant Isolation (API)                                       |               ✅               |        ✅        | ✅ (403 TENANT_MISMATCH زنده گرفته شد)                                                       |
| Tenant Isolation (Database)                                  |               ✅               |        —         | ✅ (`permission denied for database` زنده گرفته شد)                                          |
| Cross-tenant read → 404                                      |               ✅               |        ✅        | ✅                                                                                           |
| RBAC (Roles Guard)                                           |               ✅               |        ✅        | ✅ (Auditor → 403 روی POST)                                                                  |
| JWT verification (Keycloak/JWKS)                             |               ✅               |        ✅        | ✅ (۴ کاربر Seed، توکن واقعی گرفته شد)                                                       |
| Transactional Outbox → Kafka                                 |               ✅               |        ✅        | ✅ (Asset ساخته شد → Outbox → Kafka، Correlation تطبیق)                                      |
| Event Consumer / Dossier Projector                           |               ✅               |   ✅ (18 تست)    | ✅ (رویداد ساختگی maintenance → یک خط Timeline، Replay دوباره = بدون تکرار)                  |
| API Gateway routing + circuit breaker                        |               ✅               |   ✅ (21 تست)    | ✅ (مسیر به سرویس نساخته‌شده fleet → 503 تمیز)                                               |
| Redis Rate Limiting (منطق)                                   |               ✅               |    ✅ (واحد)     | ⚠️ **مسدود شده توسط تداخل Port میزبان — بخش ۲۲.۳ D-006**                                     |
| Anonymous public endpoint (self-registration) از راه Gateway |               ✅               |   ✅ (17 تست)    | ✅ **`201` زنده گرفته شد — D-007 رفع شد**                                                    |
| CI/CD روی GitHub Actions                                     |               ✅               |        —         | ✅ **CI VERIFIED** تا Commit `1872bd7` — Run `33076090420`. تغییرات fleet **هنوز اجرا نشده** |
| Docker Build (identity, organization)                        |               ✅               |        —         | ✅ **CI VERIFIED** — Build + Trivy Scan هر دو Image روی Runner سبز                           |
| Docker Build (asset, fleet)                                  | ✅ Dockerfile دارند، در Matrix |        —         | ⚠️ **NOT VERIFIED** — به Matrix افزوده شد اما هنوز روی Runner ساخته نشده                     |
| Docker Build (api-gateway)                                   |      ❌ Dockerfile ندارد       |        —         | ❌ باز (بخش ۲۲)                                                                              |
| **fleet-service — Driver/Assignment/Usage/Availability**     |               ✅               |   ✅ (۶۷ تست)    | ❌ **NOT VERIFIED** — Docker از کار افتاد (D-010)                                            |
| **Assignment Exclusivity (Partial Unique Index)**            |               ✅               | ✅ (Integration) | ⚠️ Index در پایگاه داده **مستقیماً تأیید شد**؛ اجرای کامل Suite ثبت نشده                     |
| **Fleet → Kafka → Asset Projector**                          |               ✅               |   ✅ (قرارداد)   | ❌ **NOT VERIFIED** زنده — تست نوشته شده، اجرا نشده                                          |
| Frontend (`apps/web`, `apps/admin`)                          |               ❌               |        —         | NOT_STARTED — پوشه خالی                                                                      |
| Integration Tests (`*.int-spec.ts`)                          |    ✅ **۴ Suite در fleet**     |        —         | ⚠️ اجرای جزئی روی PostgreSQL واقعی؛ اجرای کامل سبز ثبت نشده (D-010)                          |
| E2E Tests (`tests/e2e`, Playwright)                          |               ❌               |        —         | پوشه خالی، بدون Config                                                                       |
| maintenance/marketplace/… (۱۱ سرویس)                         |               ❌               |        —         | NOT_STARTED                                                                                  |

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
  fleet-service/          IMPLEMENTED — کد و تست کامل؛ Live Verify نشده (D-010)
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

| Service                | Port       | Status                           | DB                   | Tests                    | Docker                          |
| ---------------------- | ---------- | -------------------------------- | -------------------- | ------------------------ | ------------------------------- |
| `api-gateway`          | 3000/3010* | IMPLEMENTED                      | — (بدون Database)    | 21                       | ❌ ندارد                        |
| `identity-service`     | 3101       | IMPLEMENTED                      | `rasta_identity`     | 14                       | ✅ در CI Matrix                 |
| `organization-service` | 3102       | IMPLEMENTED                      | `rasta_organization` | 21                       | ✅ در CI Matrix                 |
| `asset-service`        | 3103       | IMPLEMENTED (با یک Gap — بخش ۱۸) | `rasta_asset`        | 74                       | ✅ دارد؛ **اکنون در CI Matrix** |
| `fleet-service`        | 3104       | IMPLEMENTED                      | `rasta_fleet`        | 67 + ۴ Suite Integration | ✅ دارد؛ **در CI Matrix**       |
| ۱۱ سرویس دیگر          | 3105–3116  | NOT_STARTED                      | —                    | ۰                        | —                               |

\* پورت داکیومنت‌شده در `CLAUDE.md`/`docs` **۳۰۰۰** است؛ در `.env` محلی فعلی
روی **۳۰۱۰** تنظیم شده چون یک Container نامرتبط (`purchase-workflow-system-app-1`)
پورت ۳۰۰۰ را در این ماشین توسعه گرفته است. این یک تنظیم محلی است، نه تغییر
معماری — `PORT_API_GATEWAY` در `.env` (ریشه) کنترل می‌کند.

برای هر سرویس پیاده‌شده، Authentication/Authorization/Tenant Isolation همگی
Implemented + Tested + Live Verified هستند (بخش ۳).

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

**⚠️ تصحیح ثبت قبلی (D-009، 2026-08-27):** جمله پیشین این بخش می‌گفت
`docker compose ps` هر ۶ سرویس را `healthy` نشان داد. **این درست نبود.**
`rasta-temporal` از لحظه بالا آمدن `unhealthy` بوده، با
`FailingStreak: 754` — یعنی هرگز حتی یک‌بار Healthcheck را رد نکرده.

بررسی ریشه (اجرا شد، حدس نیست): Healthcheck فرمان
`temporal operator cluster health` را اجرا می‌کند و Timeout می‌خورد، اما
مسئله شبکه نیست — `docker exec rasta-temporal temporal --version`، که هیچ
شبکه‌ای لمس نمی‌کند، هم Hang می‌کند، درحالی‌که
`docker exec rasta-temporal echo hi` بلافاصله برمی‌گردد. یعنی **باینری
`temporal` داخل Image روی این میزبان اجرا نمی‌شود**، نه اینکه Server مرده
باشد.

وضعیت Server: پورت gRPC `7233` از میزبان باز است و Log ها جریان عادی
`Started/Stopped physicalTaskQueueManager` را بدون هیچ خطا یا Restart نشان
می‌دهند — اما چون هر ابزار Probe در دسترس Hang می‌کند، سلامت gRPC
**مثبتاً تأیید نشده** است. وضعیت درست: **NOT_VERIFIED**، نه `healthy`.

اثر امروز: هیچ — هیچ سرویسی هنوز Temporal را لمس نمی‌کند و CI آن را بالا
نمی‌آورد. رفع موکول به نخستین سرویسی که واقعاً Workflow بنویسد.

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
@rasta/config              11 تست
@rasta/logging               9 تست
@rasta/observability         10 تست
@rasta/nest-common           56 تست  (+16: قواعد دسترسی Endpoint عمومی، D-007)
@rasta/api-gateway           25 تست  (+4: Gateway توکن RELAY صادر می‌کند)
@rasta/organization-service  21 تست
@rasta/asset-service         74 تست
@rasta/identity-service      14 تست
@rasta/fleet-service         67 تست  (جدید — 2026-08-28)
@rasta/api-gateway           +5 تست  (مسیرهای fleet؛ مجموع 30)
———————————————————————————————
مجموع                       292 تست، همه سبز — محلی، 2026-08-28
```

۲۲۰ عدد پیشین روی Runner واقعی GitHub دیده شده بود (Run `33076090420`).
**۲۹۲ تا این لحظه فقط محلی تأیید شده؛ CI روی تغییرات fleet هنوز اجرا نشده.**

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

**⚠️ وضعیت اجرا — صادقانه.** این تست‌ها پیش از خرابی Docker (D-010) تا حدی روی
PostgreSQL واقعی اجرا شدند و **در همان اجرا دو باگ واقعی گرفتند** (هر دو رفع
شد — بخش ۲۲). اما **یک اجرای کامل سبز ثبت نشده است.** تنها چیزی که مثبتاً تأیید
شد: هر دو Partial Unique Index و هر شش CHECK Constraint با پرس‌وجوی مستقیم از
`pg_indexes` و `pg_constraint` در پایگاه داده دیده شدند.

**E2E Tests:** `tests/e2e/` پوشه‌ای خالی است، بدون `playwright.config.ts`.
`pnpm test:e2e` هست اما `turbo run test:e2e` روی هیچ Package ای Script
واقعی ندارد.

### ✅ CI/CD — **CI VERIFIED** (D-005 رفع شد، 2026-08-27)

**Run `33076090420`، Commit `1872bd7`: success در ۹ دقیقه و ۸ ثانیه.**
نخستین اجرای موفق Pipeline در تمام عمر این Repository.

هر پنج Job سبز، و هر مرحله واقعاً اجرا شد — نه Skip، نه Cache:

| Job                            | مراحلی که واقعاً اجرا شدند                                                                                     |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Lint, types and unit tests     | `pnpm install --frozen-lockfile` · `db:generate` · Format check · Lint · Type check · Unit tests (۲۲۰) · Build |
| Security scans                 | Gitleaks · Dependency audit (`--audit-level=high`) · Semgrep                                                   |
| Integration and security tests | Provision PostgreSQL+Redis · Migrations · Integration tests · Tenant isolation and authorization tests         |
| Build and scan images × ۲      | Docker build + Trivy scan (`identity-service`، `organization-service`)                                         |

**دو هشدار صادقانه که نباید با «سبز» اشتباه گرفته شوند:**

1. مرحله «Integration tests» سبز است اما **صفر فایل `*.int-spec.ts`**
   وجود دارد؛ با `--passWithNoTests` عبور می‌کند. سبز بودنش یعنی «چیزی
   نشکست»، نه «مسیر داده تست شد».
2. `asset-service` و `api-gateway` هنوز در Matrix ساخت Image نیستند
   (Gateway اصلاً Dockerfile ندارد). یعنی CI هنوز همه چیزی را که می‌سازیم
   Scan نمی‌کند.

مسیر رسیدن به این نقطه — و شش نقص دیگری که فقط Runner واقعی می‌توانست
نشانشان دهد — در `docs/23` بخش D-005 ثبت شده.

---

## ۲۰. Security State

| مکانیزم                              | Implemented | Tested |                  Live Verified                  | یادداشت                                                                 |
| ------------------------------------ | :---------: | :----: | :---------------------------------------------: | ----------------------------------------------------------------------- |
| Authentication (JWT/JWKS)            |     ✅      |   ✅   |                       ✅                        | زنده دوباره تأیید شد: `200` با JWT کی‌کلوک از راه Gateway               |
| Authorization (RBAC سطح Endpoint)    |     ✅      |   ✅   |                       ✅                        | زنده: `province.auditor` → `POST /v1/users` → `403 INSUFFICIENT_ROLE`   |
| Tenant Isolation (API + DB)          |     ✅      |   ✅   |                       ✅                        | زنده: `X-Organization-Id` بیگانه → `403 TENANT_MISMATCH`                |
| Service-to-Service Auth (Zero Trust) |     ✅      |   ✅   |                       ✅                        | D-007 رفع شد؛ Claim `purpose` — RELAY در برابر SERVICE (بخش ۱۱)         |
| Rate Limiting (منطق Redis)           |     ✅      |   ✅   |                    ⚠️ مسدود                     | D-006: تصادم پورت Redis                                                 |
| Input Validation (Zod در مرز)        |     ✅      |   ✅   |                       ✅                        |                                                                         |
| Audit Trail                          |   ⚠️ جزئی   |   —    |                       نشد                       | `audit-service` نساخته؛ Event های تولید می‌شوند اما جایی ذخیره نمی‌شوند |
| Secrets فقط از Env                   |     ✅      |   —    | ✅ (`.env` بررسی شد؛ Secret واقعی در Repo نیست) |                                                                         |
| Security Headers (helmet)            |     ✅      |   —    |                       ✅                        | CSP، HSTS، Referrer-Policy                                              |
| mTLS بین سرویس‌ها                    |     ❌      |   —    |                        —                        | Planned — Production-only                                               |
| Database RLS                         |     ❌      |   —    |                        —                        | Tenant Isolation فعلاً فقط لایه Application است                         |

**وضعیت High-risk items پس از Task سخت‌سازی 2026-08-27:**

- ✅ **D-005 رفع شد** — CI روی GitHub Actions سبز است (**CI VERIFIED**).
- ✅ **D-007 رفع شد** — ثبت‌نام گمنام از راه Gateway کار می‌کند
  (**LIVE VERIFIED**)، بدون تضعیف Zero Trust.
- ⏳ **D-006 باز است** — تصادم پورت Redis روی این ماشین توسعه.
- 🆕 **D-008 باز است** — سه قاعده Supply-Chain که Lockfile فعلی رد می‌کند.
- 🆕 **D-009 باز است** — Healthcheck کانتینر Temporal (اثر عملی: هیچ).

---

## ۲۱. Current Runtime State

در لحظه این Audit (2026-08-27، بعدازظهر)، از حالت **کاملاً تمیز** (همه
پردازه‌ها Kill شده) بالا آورده شدند و سالم گزارش دادند:

```
identity-service      :3101   {"status":"ok","checks":{"database":true,"kafka":true}}
organization-service  :3102   {"status":"ok","checks":{"database":true,"kafka":true}}
asset-service         :3103   {"status":"ok","checks":{"database":true,"kafka":true}}
api-gateway           :3010   {"status":"ok","checks":{"redis":true}}
```

Infra Docker (`docker compose ps`): `postgres, redis, kafka, keycloak,
minio` همه `healthy`؛ **`temporal` unhealthy** — بخش ۱۷ و D-009.

Kafka Consumer Group `asset-service.timeline`: فعال، Lag صفر روی هر ۱۲
Partition (۴ Topic × ۳ Partition).

---

## ۲۲. Known Issues

### فعال (رفع‌نشده)

| #         | مسئله                                                                       | شدت                               | تأثیر                                                                     | راه‌حل موقت                                                                                     |
| --------- | --------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| D-006     | Redis محلی Windows روی پورت ۶۳۷۹ با Redis داکری تصادم دارد                  | بالا (فقط محیط توسعه این ماشین)   | تست زنده Rate Limiting/Idempotency از راه `localhost:6379` غیرقابل‌اعتماد | استفاده از `docker exec rasta-redis redis-cli` مستقیم؛ یا تغییر `REDIS_PORT` مثل الگوی Postgres |
| D-008     | سه قاعده Supply-Chain که Lockfile فعلی رد می‌کند                            | متوسط                             | پنجره نصب نسخه تازه‌منتشرشده مخرب باز است؛ ۴ هشدار Trust بررسی‌نشده       | Semgrep با `--exclude-rule` نام‌دار عبور می‌کند؛ بررسی کامل یک Task مستقل است                   |
| D-009     | Healthcheck کانتینر Temporal همیشه Fail (باینری CLI Hang می‌کند)            | پایین                             | **هیچ** — هیچ سرویسی هنوز Temporal را لمس نمی‌کند                         | نادیده گرفتن تا نخستین Workflow واقعی؛ سلامت Server مثبتاً تأیید نشده (NOT_VERIFIED)            |
| **D-010** | **Docker Desktop روی این ماشین از کار افتاده — Engine API خطای ۵۰۰ می‌دهد** | **بالا (مسدودکننده Live Verify)** | **هیچ Live Verification و هیچ اجرای کامل Integration ممکن نیست**          | جزئیات و مسیر بازیابی در ادامه همین بخش                                                         |
| —         | `api-gateway` هیچ Dockerfile ندارد                                          | متوسط                             | نمی‌توان آن را Containerize کرد                                           | نوشتن Dockerfile لازم است                                                                       |
| —         | `InsuranceClaim` جدول بدون API                                              | پایین                             | داده قابل‌ثبت نیست از راه سرویس                                           | Controller/Service لازم است، هروقت claim-flow اولویت شد                                         |
| —         | `mission` و رویدادهای `MISSION_*` پیاده نشدند                               | پایین                             | تحلیل «ناوگان داخلی در برابر برون‌سپاری» هنوز داده مأموریت ندارد          | عمدی — به `construction-service` گره خورده که وجود ندارد؛ ADR-026 § Consequences                |

### D-010 — Docker Desktop از کار افتاد (2026-08-28)

**نشانه.** هر فرمان `docker` با این خطا برمی‌گردد:

```
request returned 500 Internal Server Error for API route and version
http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.55/containers/json
```

هر دو Context (`default` و `desktop-linux`) یکسان شکست می‌خورند و Pin کردن
`DOCKER_API_VERSION` روی ۱٫۴۱ تا ۱٫۵۱ کمکی نکرد. `docker desktop status` روی
`starting` گیر کرده و از آن جلوتر نمی‌رود.

**تاریخچه دقیق — مهم برای اینکه علت با معلول اشتباه نشود.**

۱. این خطا **از ابتدای این جلسه وجود داشت**: نخستین `docker compose ps` هم
همین ۵۰۰ را داد. اما کانتینرها از قبل در حال اجرا بودند و پورت‌ها (۵۴۳۳،
۹۰۹۲، ۸۰۸۰، ۹۰۰۰، ۶۳۷۹) پاسخ می‌دادند. یعنی **Engine API خراب بود ولی
Runtime سالم** — Migration با موفقیت اجرا شد و بخشی از تست‌های Integration
واقعاً روی PostgreSQL اجرا شدند.

۲. برای بازیابی Engine، Docker Desktop **Restart شد**. این کار کانتینرهای در
حال اجرا را از بین برد و چون Engine خراب است، دیگر بالا نیامدند. **این یک
اشتباه عملیاتی در همین Task بود**: یک Stack کارکن ولی غیرقابل‌مدیریت، به یک
Stack خاموش تبدیل شد.

۳. تلاش‌های بعدی — `docker desktop restart`، `wsl --shutdown`، اجرای CLI از
داخل distro — هیچ‌کدام Engine را برنگرداندند.

**اثر امروز.** مسدودکننده برای: Live Verification سناریوی E2E، اجرای کامل
Suite Integration، و Build واقعی Image. غیر‌مسدودکننده برای: `pnpm verify`
کامل (سبز، ۲۹۲ تست) و CI (که Runner خودش را دارد).

**مسیر بازیابی پیشنهادی، به ترتیب کم‌هزینه‌ترین:**

1. Restart کامل ویندوز — رایج‌ترین رفع برای Named Pipe گیرکرده.
2. `Settings → Troubleshoot → Clean / Purge data` در Docker Desktop، سپس
   `pnpm infra:up` و `pnpm db:migrate && pnpm db:seed` (داده محلی دورریختنی است).
3. اگر باز هم شکست خورد: نصب دوباره Docker Desktop، یا سنجش نسخه CLI
   (۲۹٫۷٫۲) در برابر Backend.

**پس از بازیابی، این‌ها باید اجرا و نتیجه‌شان اینجا ثبت شود:**

```bash
pnpm infra:up && pnpm db:migrate && pnpm db:seed
KAFKA_BROKERS=localhost:9092 pnpm --filter @rasta/fleet-service test:integration
# سپس ۵ سرویس را بالا بیاور و سناریوی بخش ۲۹ را اجرا کن
```

### رفع‌شده در Task ناوگان (2026-08-28)

- **صفر فایل `*.int-spec.ts` — رفع شد.** چهار Suite واقعی در
  `services/fleet-service/test/`، و `test:integration` دیگر
  `--passWithNoTests` ندارد.
- **`asset-service` در CI Container Matrix نبود — رفع شد.** هم `asset-service`
  و هم `fleet-service` به Matrix افزوده شدند. (`api-gateway` همچنان
  Dockerfile ندارد و باز است.)
- **دو باگ واقعی که تست‌های Integration گرفتند** — هر دو رفع شد:
  - `AssetSyncConsumer`: یک کلید `patch` که مقدارش `undefined` بود، تنانت
    حل‌شده را بازنویسی می‌کرد. اثر: یک `ASSET_CREATED` که سازمانش فقط روی
    Envelope بود، ردیفی بدون سازمان می‌نوشت.
  - `test/helpers.ts`: همان تله‌ای که `runUnscoped` مستندش کرده — Query تنبل
    Prisma **پس از** بسته شدن Context اجرا می‌شد، یعنی بدون هیچ Tenant Scope.
    این دقیقاً شکل D-003 است که در یک فایل تازه دوباره ظاهر شد.

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
- ۲۹۲ تست واحد، همه سبز — ۲۲۰ تای اول روی Runner واقعی هم دیده شده
- **۴ Suite تست Integration واقعی** (نخستین در این Repository) — در fleet
- Kafka Consumer عمومی (`EventConsumer`) + Projector واقعی (`asset-service`
  Timeline از رویدادهای سرویس‌های دیگر)
- **CI Pipeline سبز روی GitHub Actions** (۴ Job، ۵ اجرا با Matrix) —
  **CI VERIFIED** تا Commit `1872bd7`، Run `33076090420` (بخش ۱۹)
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
   maintenance-service   ← گام بعدی (بخش ۲۹)
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

---

## ۲۹. Immediate Next Task

**`fleet-service` ساخته شد** — کد، تست واحد، تست Integration، مستندات، ADR و
Commit های اتمیک. `pnpm verify` کامل سبز است.

### اولویت ۱ — رفع D-010 و تکمیل تأیید (مسدودکننده)

Docker Desktop روی این ماشین از کار افتاد و **Live Verification انجام نشد**.
این تنها بخش ناتمام این Task است، و باید پیش از هر سرویس تازه بسته شود —
وگرنه `maintenance-service` روی پایه‌ای ساخته می‌شود که هرگز زنده اجرا نشده.

```bash
# ۱. زیرساخت را برگردان (مسیر بازیابی در بخش ۲۲، D-010)
pnpm infra:up && pnpm db:migrate && pnpm db:seed

# ۲. Suite Integration را کامل اجرا کن و نتیجه را در بخش ۱۹ ثبت کن
KAFKA_BROKERS=localhost:9092 pnpm --filter @rasta/fleet-service test:integration

# ۳. پنج سرویس را بالا بیاور و سناریوی زیر را واقعاً اجرا کن
```

**سناریوی E2E که باید اجرا و ثبت شود:**

1. توکن واقعی از Keycloak برای `dehyari.admin` بگیر.
2. از راه Gateway: `POST /v1/drivers` با `userId` کاربر Seed.
3. `POST /v1/assignments` با `AST-SEED-0002` (وضعیت `IDLE`).
4. تأیید ردیف در `assignment`، ردیف در `outbox_message`، سپس انتشار روی
   `rasta.fleet.v1`.
5. تأیید اینکه `asset-service` یک خط `تخصیص به راننده` در
   `GET /v1/assets/AST-SEED-0002/timeline` ساخت و وضعیت به `ASSIGNED` رفت.
6. `POST /v1/usage-records` با `clientReference`؛ همان درخواست را دوباره
   بفرست و تأیید کن **یک** رکورد و **یک** رویداد ساخته شد.
7. با توکن `dehyari2.admin` همان تخصیص را بخوان → باید **۴۰۴** بگیرد.
8. `correlationId` را از پاسخ HTTP تا Envelope کافکا تا خط Timeline دنبال کن.

**تا وقتی این اجرا نشده، هیچ ادعای LIVE VERIFIED برای `fleet-service` نکن.**

### اولویت ۲ — اجرای CI روی این تغییرات

CI هنوز روی این Commit ها اجرا نشده. Pipeline اکنون شامل یک Container کافکا و
دو Image تازه در Matrix است؛ هر دو تغییر **NOT VERIFIED** اند.
`gh run list` را واقعاً اجرا کن — فرض «CI سبز است» چون فایل Workflow تغییر
کرده، همان اشتباه اثبات‌شده D-005 است.

### اولویت ۳ — گام بعدی نقشه راه

**`maintenance-service`** (پورت ۳۱۰۵). دو دلیل که آن را گام درست بعدی می‌کند:

- `fleet-service` از امروز `USAGE_RECORDED` منتشر می‌کند، که **محرک اصلی
  نگهداری پیشگیرانه** است (`docs/04` § ۴٫۶). مصرف‌کننده‌اش هنوز وجود ندارد.
- `fleet-service` از پیش `MAINTENANCE_STARTED` و `MAINTENANCE_COMPLETED` را
  مصرف می‌کند و به `asset_ref.inMaintenance` می‌نویسد. تولیدکننده‌اش وجود
  ندارد، پس آن مسیر امروز **مرده** است.

**کارهای کوچک‌تر و مستقل:** Dockerfile برای `api-gateway` · D-008
(Supply-Chain) · `InsuranceClaim` بدون API · نصب Playwright برای E2E واقعی.

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
- Healthcheck داکر را به‌عنوان حقیقتِ سلامت نخوان: `rasta-temporal`
  `unhealthy` است چون باینری CLI داخل Image اجرا نمی‌شود، نه چون Server
  مرده (D-009). و برعکس — سبز بودن Healthcheck هم اثبات سلامت نیست.

**قواعد افزوده در Task ناوگان (2026-08-28):**

- **Docker Desktop خراب را Restart نکن اگر کانتینرها هنوز کار می‌کنند.**
  در این Task، Engine API از ابتدا خطای ۵۰۰ می‌داد ولی Runtime سالم بود و
  Migration و تست اجرا می‌شد. Restart، Stack کارکن را کشت و Engine هم
  برنگشت (D-010). اول بررسی کن پورت‌ها پاسخ می‌دهند یا نه؛ اگر می‌دهند، با
  همان کار کن.
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
