# ۲۲ — Developer Handoff

> معیار موفقیت: **یک توسعه‌دهنده جدید، در حداکثر یک روز کاری**، محیط را بالا می‌آورد،
> سرویس‌ها را اجرا می‌کند، تست‌ها را می‌گیرد، معماری را می‌فهمد و اولین Feature را توسعه می‌دهد —
> **بدون هیچ وابستگی به عاملی که این کد را نوشته است.**
>
> اگر این ممکن نباشد، Handoff ناقص است و مستندسازی باید اصلاح شود.

---

## ۲۲٫۱ مسیر روز اول یک توسعه‌دهنده جدید

| زمان        | کار                                   | منبع                                                                                                    |
| ----------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| ۰۰:۰۰–۰۰:۳۰ | Clone، نصب، راه‌اندازی محیط           | [`README.md`](../README.md) § ۲                                                                         |
| ۰۰:۳۰–۰۱:۰۰ | اجرای سرویس‌ها و مرور UI              | `pnpm dev` → http://localhost:3200                                                                      |
| ۰۱:۰۰–۰۱:۳۰ | اجرای تست‌ها                          | `pnpm test`                                                                                             |
| ۰۱:۳۰–۰۳:۰۰ | **فهمیدن معماری**                     | [`01`](01-executive-architecture.md) · [`03`](03-domain-model.md) · [`04`](04-service-decomposition.md) |
| ۰۳:۰۰–۰۳:۳۰ | **فهمیدن قواعد**                      | [`AGENTS.md`](../AGENTS.md) — الزام‌آور                                                                 |
| ۰۳:۳۰–۰۴:۳۰ | مرور یک سرویس نمونه                   | `services/asset-service/` انتها به انتها                                                                |
| ۰۴:۳۰–۰۶:۰۰ | **افزودن یک فیلد** (Migration تا API) | § ۲۲٫۴ زیر                                                                                              |
| ۰۶:۰۰–۰۸:۰۰ | **افزودن یک Endpoint**                | § ۲۲٫۵ زیر                                                                                              |

---

## ۲۲٫۲ ترتیب خواندن مستندات

```
۱. README.md                        چه چیزی، چطور اجرا می‌شود
۲. AGENTS.md                        ★ قواعد الزام‌آور — پیش از نخستین تغییر
۳. docs/01-executive-architecture   تصویر کلان و اصول
۴. docs/02-product-context          چرا این تصمیم‌ها گرفته شده‌اند
۵. docs/03-domain-model             زبان مشترک — نام‌ها را از اینجا بگیر
۶. docs/04-service-decomposition    نقشه سرویس‌ها
۷. docs/05..08                      داده، API، رویداد، گردش‌کار
۸. docs/09-security-architecture    ★ پیش از نوشتن هر Endpoint
۹. docs/14-testing-strategy         ★ پیش از اعلام Done
۱۰. docs/adr/                       چرا این‌طور و نه آن‌طور
```

★ = پیش از نوشتن کد بخوان، نه بعد از آن.

---

## ۲۲٫۳ راه‌اندازی محیط

### پیش‌نیاز

| ابزار          | حداقل | بررسی                    |
| -------------- | ----- | ------------------------ |
| Node.js        | 22    | `node -v`                |
| pnpm           | 10    | `pnpm -v`                |
| Docker Engine  | 24    | `docker --version`       |
| Docker Compose | v2    | `docker compose version` |
| Git            | 2.40  | `git --version`          |

منابع: **۸ گیگابایت RAM آزاد**، ۲۰ گیگابایت دیسک، ۴ هسته.

### راه‌اندازی

```bash
git clone <repo-url> rasta && cd rasta
pnpm install
cp .env.example .env
pnpm infra:up
pnpm db:migrate
pnpm db:seed
pnpm dev
```

### تأیید

```bash
curl http://localhost:3000/health/ready     # Gateway
curl http://localhost:3101/health/ready     # Identity
docker compose ps                            # همه سالم
```

ورود: http://localhost:3200 با `dehyari.admin` / `RastaDev!2026`

---

## ۲۲٫۴ راهنما — افزودن یک فیلد به یک موجودیت

مثال: افزودن `fuelType` به `Asset`.

```bash
# ۱. مدل Prisma
#    services/asset-service/prisma/schema.prisma
#    fuelType  FuelType?  @map("fuel_type")

# ۲. Migration
pnpm --filter @rasta/asset-service exec prisma migrate dev --name add_asset_fuel_type

# ۳. DTO — services/asset-service/src/asset/dto/
#    fuelType: fuelTypeSchema.optional()

# ۴. اگر در رویداد ظاهر می‌شود:
#    packages/contracts/src/events/asset.ts  →  فیلد اختیاری (تغییر غیرشکننده)

# ۵. تست
pnpm --filter @rasta/asset-service test

# ۶. OpenAPI
pnpm --filter @rasta/asset-service build && pnpm --filter @rasta/asset-service openapi:generate

# ۷. دروازه کیفیت
pnpm verify
```

**Checklist:** Migration قابل بازگشت · DTO به‌روز · Schema رویداد (اگر لازم) · تست ·
OpenAPI Commit شده · مستند به‌روز (اگر مفهوم دامنه‌ای جدیدی است).

---

## ۲۲٫۵ راهنما — افزودن یک Endpoint

```typescript
// ۱. Schema در dto/ — همیشه .strict()
export const archiveAssetSchema = z.object({
  reason: z.string().min(10).max(500),
}).strict();

// ۲. Controller — فقط HTTP، بدون منطق
@Post(':id/archive')
@Roles('FLEET_MANAGER', 'ORGANIZATION_ADMIN')
@ApiOperation({ summary: 'Archive an asset' })
async archive(
  @Param('id') id: string,
  @Body(new ZodPipe(archiveAssetSchema)) dto: ArchiveAssetDto,
  @Ctx() ctx: RequestContext,
) {
  return this.assetService.archive(id, dto, ctx);
}

// ۳. Service — منطق دامنه و Invariantها
// ۴. Repository — Scope مستأجر خودکار اعمال می‌شود
// ۵. رویداد از راه Outbox، در همان تراکنش
// ۶. AuditEvent برای تغییر وضعیت
```

**Checklist اجباری:**

- [ ] بررسی نقش (`@Roles`)
- [ ] **بررسی مجوزدهی سطح Object** در Service
- [ ] ورودی با Zod `.strict()`
- [ ] Query دارای `organizationId`
- [ ] **تست Tenant Isolation** — مستأجر دیگر → ۴۰۴
- [ ] تست ماتریس مجوزدهی — هر نقش، مثبت و منفی
- [ ] تست API — موفق، ۴۰۰، ۴۰۱، ۴۰۳، ۴۰۴، ۴۲۲
- [ ] `AuditEvent` تولید می‌شود
- [ ] `Idempotency-Key` اگر اثر مالی یا برگشت‌ناپذیر دارد
- [ ] OpenAPI به‌روز و Commit
- [ ] پیام خطا داده حساس فاش نمی‌کند

---

## ۲۲٫۶ راهنما — افزودن یک رویداد

```
۱. packages/contracts/src/events/<domain>.ts
   ├─ نام رویداد در Enum
   ├─ Zod Schema برای Payload
   └─ ثبت در کاتالوگ رویدادها

۲. سرویس تولیدکننده
   └─ درج در outbox_message **در همان تراکنش تغییر وضعیت**

۳. سرویس(های) مصرف‌کننده
   ├─ Handler با درج processed_event برای Idempotency
   └─ پردازش در همان تراکنش

۴. docs/events/catalog.md — Producer، Consumer، Schema، Retry، DLQ

۵. تست قرارداد — Payload تولیدشده با Schema مطابقت دارد
۶. تست Idempotency — پردازش دو باره اثر دوم ندارد
```

**قاعده.** نام رویداد **فعل گذشته** است: `ASSET_ARCHIVED`، نه `ARCHIVE_ASSET`.
رویداد چیزی است که اتفاق افتاده، نه دستوری برای اجرا.

---

## ۲۲٫۷ راهنما — افزودن یک سرویس

Checklist کامل در [`15-repository-architecture.md § ۱۵٫۸`](15-repository-architecture.md).
خلاصه: پوشه و `package.json` · `tsconfig`/`eslint`/`jest` · `Dockerfile` · `prisma/schema.prisma`
· پایگاه داده و نقش در اسکریپت init · Topic کافکا · متغیرهای `.env.example` · مستندسازی در
سند ۰۴ · ماژول Health و Outbox · **تست Tenant Isolation پیش از نخستین Endpoint** · Helm.

---

## ۲۲٫۸ عیب‌یابی

| علامت                                      | علت محتمل                              | اقدام                                                                                        |
| ------------------------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------- |
| `ECONNREFUSED` روی پایگاه داده             | زیرساخت بالا نیست                      | `pnpm infra:up`؛ `docker compose ps`                                                         |
| Migration شکست می‌خورد                     | پایگاه داده یا نقش ساخته نشده          | `pnpm infra:reset` (⚠️ داده پاک می‌شود)                                                      |
| `401` روی همه درخواست‌ها                   | Keycloak آماده نیست یا Realm نیامده    | `docker compose logs keycloak`؛ Realm در `/opt/keycloak/data/import`                         |
| `403 TENANT_MISMATCH`                      | `X-Organization-Id` با عضویت نمی‌خواند | عضویت کاربر را بررسی کن                                                                      |
| رویداد مصرف نمی‌شود                        | Topic نیست یا Consumer Group گیر کرده  | Kafka UI (`--profile tools`)؛ `create-topics.sh`                                             |
| `outbox_message` انباشته می‌شود            | Relay متوقف است                        | Log سرویس؛ متریک `rasta_outbox_pending_age_seconds`                                          |
| Workflow پیش نمی‌رود                       | Worker متصل نیست                       | Temporal UI (`--profile tools`)؛ Task Queue را بررسی کن                                      |
| تست یکپارچگی Timeout می‌خورد               | Docker کند یا Image نیامده             | `docker pull` تصاویر؛ `testTimeout` را افزایش بده                                            |
| `EADDRINUSE`                               | پورت اشغال است                         | `netstat -ano \| findstr :<port>`                                                            |
| Build شکست می‌خورد ولی محلی سبز است        | Cache Turbo کهنه                       | `pnpm clean && pnpm install && pnpm build`                                                   |
| تست جداسازی می‌شکند                        | **Query بدون Tenant Scope**            | **این باگ است، نه تست شکننده — Repository را درست کن**                                       |
| `EPERM ... query_engine-windows.dll.node`  | سرویس در حال اجرا، DLL را قفل کرده     | سرویس را متوقف کن، سپس `prisma generate` (فقط ویندوز)                                        |
| `TimeoutNegativeWarning` هنگام اتصال Kafka | باگ شناخته‌شده در خود `kafkajs`        | بی‌اثر؛ رجوع به `docs/23` مورد D-001                                                         |
| Journal نامتوازن                           | **باگ منطق مالی**                      | **متوقف شو. این بحرانی است.** [`runbooks/ledger-imbalance.md`](runbooks/ledger-imbalance.md) |

---

## ۲۲٫۹ Runbookها

| موقعیت                    | Runbook                                                              |
| ------------------------- | -------------------------------------------------------------------- |
| Journal نامتوازن          | [`runbooks/ledger-imbalance.md`](runbooks/ledger-imbalance.md)       |
| پیام در DLQ               | [`runbooks/replay-dlq.md`](runbooks/replay-dlq.md)                   |
| Outbox Relay گیر کرده     | [`runbooks/outbox-stuck.md`](runbooks/outbox-stuck.md)               |
| Bootstrap پایگاه داده     | [`runbooks/database-bootstrap.md`](runbooks/database-bootstrap.md)   |
| بازیابی پایگاه داده       | [`runbooks/restore-database.md`](runbooks/restore-database.md)       |
| بازیابی از فاجعه          | [`runbooks/disaster-recovery.md`](runbooks/disaster-recovery.md)     |
| نشت Secret                | [`runbooks/secret-leak.md`](runbooks/secret-leak.md)                 |
| Rollback استقرار          | [`runbooks/rollback-deployment.md`](runbooks/rollback-deployment.md) |
| Workflow شکست‌خورده تسویه | [`runbooks/failed-settlement.md`](runbooks/failed-settlement.md)     |

**قاعده.** هر هشدار باید Runbook داشته باشد. هشدار بدون دستورالعمل پاسخ، نویز است.

---

## ۲۲٫۱۰ سؤال‌های متداول معماری

**چرا نمی‌توانم مستقیم از پایگاه داده سرویس دیگر بخوانم؟**
چون آنگاه Schema داخلی آن سرویس بخشی از قرارداد عمومی می‌شود و تغییرش شما را می‌شکند.
از REST یا رویداد استفاده کنید. → ADR-005

**چرا `Wallet` و `Ledger` جدا هستند؟**
دفتر کل تغییرناپذیر و قابل حسابرسی است — «چه اتفاقی افتاد». کیف پول نمای عملیاتی است —
«چقدر می‌توانم خرج کنم». ادغام آن‌ها یعنی از دست دادن حسابرسی‌پذیری. → ADR-013

**چرا `float` برای پول ممنوع است؟**
`0.1 + 0.2 !== 0.3`. در یک دفتر کل که باید به صفر برسد، این خطا انباشته می‌شود.
`bigint` در واحد فرعی. → ADR-022

**چرا نرخ کارمزد را Hard-Code نکنم؟**
سند محصول صریح است که نرخ باید پس از بررسی هزینه و الزامات قانونی تعیین شود و از
کارگروه راهبری بگذرد. Hard-Code کردن آن نقض سند است. → ADR-023

**چرا رویداد را مستقیم منتشر نکنم؟**
چون «ذخیره در پایگاه داده» و «انتشار در Kafka» دو عمل غیراتمیک‌اند. یک Crash میان آن‌ها
یا رویداد گمشده می‌سازد یا رویداد شبح. Outbox این را حل می‌کند. → ADR-021

**تست Tenant Isolation شکست خورد. می‌توانم Skip کنم؟**
**نه.** این تست یعنی یک مستأجر می‌تواند داده مستأجر دیگر را ببیند. این یک نشتی داده است،
نه یک تست شکننده.

**می‌توانم برای سرعت Demo، Auth را روی یک Endpoint خاموش کنم؟**
**نه.** `AGENTS.md` قاعده A-12. هیچ استثنایی.

---

## ۲۲٫۱۱ Checklist تحویل

پیش از اعلام تحویل، این‌ها باید درست باشند:

- [ ] توسعه‌دهنده جدید با `README` تنها محیط را بالا می‌آورد
- [ ] `pnpm verify` روی Clone تازه سبز است
- [ ] `docker compose up -d` بدون دخالت دستی کار می‌کند
- [ ] هر سرویس `/health/ready` سبز دارد
- [ ] هر دو سناریوی Demo در مرورگر کار می‌کنند
- [ ] ۲۴ سند با کد همگام‌اند
- [ ] هر ADR وضعیت روشن دارد
- [ ] هر هشدار Runbook دارد
- [ ] `24-open-questions.md` صادقانه و کامل است
- [ ] فهرست بدهی معماری باقی‌مانده صریح است
- [ ] **تست Developer Handoff (§ ۲۰٫۵) واقعاً اجرا شده و نتیجه‌اش ثبت شده**
