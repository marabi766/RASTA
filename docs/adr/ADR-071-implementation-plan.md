# ADR-071 — برنامهٔ اجرا (RUN-001)

> برش PR به PR برای [ADR-071](ADR-071-analytics-read-models-and-governed-views.md). **فقط PR 0 (همین) و PR 1 (انباشته روی همین)
> در جریان‌اند** (2026-10-17)؛ این سند وضعیت نیست، نقشه است. هر PR جداگانه با CI سبز ادغام می‌شود؛ هر PRی که مسیر خواندن
> می‌سازد آزمون جداسازی مستأجر و آزمون رد نقش (به‌ویژه `AUDITOR` روی نماهای مستأجر) دارد، و هر Consumer آزمون Idempotency.

**اندازه:** `S` ≈ تا ۳۰۰ خط تغییر با آزمون؛ `M` ≈ ۳۰۰ تا ۹۰۰؛ `L` ≈ ۹۰۰ تا ۲۰۰۰؛ `XL` بیش از آن (مرجع: Skeleton
contract-service در #228، ۸٬۳۰۰ خط با سیم‌کشی CI، ACL و نگهبان‌ها). امتیاز برآوردی کنار هر برش است؛ جمع آن (۳۴) از ۲۱ امتیاز
RUN-001 بیشتر است — **بازبرآورد پرسش باز مدیر پروژه و صاحب محصول است** (همان یادداشت ADR-065، ADR-068 و ADR-070)؛ این سند
`backlog.json` را تغییر نمی‌دهد.

## نقشه

| PR  | عنوان                                                                                             | اندازه | امتیاز | وابسته به        | معیار RUN-001 |
| --- | ------------------------------------------------------------------------------------------------- | ------ | ------ | ---------------- | ------------- |
| 0   | طراحی: ADR-071، Q-141، Q-142 (همین PR)                                                            | S      | ۱      | —                | —             |
| 1   | Skeleton سرویس + `fact_maintenance` از `MAINTENANCE_COMPLETED` + `GET /v1/dashboards/fleet`       | XL     | ۵      | 0                | (۱)           |
| 2   | `baseline_metric` + تعریف KPIها + `GET /v1/kpis` (مستأجر) با `INSUFFICIENT_BASELINE`              | M      | ۳      | 1                | (۲)           |
| 3   | Projection سلسله‌مراتب + نمای حاکمیتی + قاعدهٔ گروه کوچک (`GET /v1/dashboards/governance`)        | L      | ۵      | 2                | (۲)           |
| 4   | Factهای ناوگان: چرخهٔ عمر نگهداری، `fact_usage`، ترکیب ناوگان                                     | L      | ۵      | 1                | (۱)           |
| 5   | Factهای بازارگاه و اقتصادی: `fact_order`، `fact_transaction` (`COMMISSION_APPLIED`)؛ داشبورد مالی | L      | ۵      | 1                | (۱)           |
| 6   | Factهای عمران و قرارداد: `fact_project`؛ داشبورد عمران                                            | M      | ۳      | 1                | (۱)           |
| 7   | `kpi_snapshot` + Snapshot روزانه + پاک‌کنندهٔ `processed_event`؛ حاکمیتی از Snapshot              | M      | ۴      | 3                | (۲)           |
| 8   | شاخص کاهش هزینه از رویدادهای procurement                                                          | M      | ۳      | 2، ADR-070 PR 12 | (۲)           |

برش‌های ۴، ۵ و ۶ فقط به Skeleton وابسته‌اند و می‌توانند موازی بروند. **معیار (۱) RUN-001 با PR 1 نشان داده می‌شود** (نخستین
Projection رویدادمحور و ایمن) و با ۴ تا ۶ گسترده؛ **معیار (۲) با PR 2 و PR 3**، و PR 7 آن را از دوره‌های ثابت سرو می‌کند.
صفحه‌های پورتال (`apps/web`) برای این نماها برش جداگانهٔ مالک پورتال‌اند و این‌جا شمرده نمی‌شوند.

## برش‌ها

### PR 1 — Skeleton و نخستین Projection (`XL`)

- `services/analytics-service` (پورت ۳۱۱۶، `rasta_analytics`، نقش مالک/زمان‌اجرا D-045) با همان اسکلت سرویس‌های دیگر: `env`،
  Health، OpenAPI از Zod، Prisma با Tenant Scope، متریک بی برچسب سازمان، Dockerfile، CI (Integration و Migration).
- **بی Outbox و بی Topic اصلی**؛ فقط `rasta.analytics.v1.dlq`. اعلام در `TOPIC_CONSUMERS` (`rasta.maintenance.v1`)، ACLهای
  تولیدشده، Principal بروکر، `topics.txt`. Consumer مثل بقیه پشت پرچم پیکربندی و فقط با بروکر احرازشده روشن می‌شود.
- Migration `init_analytics`: `processed_event` و `fact_maintenance` (یکتا روی `(organization_id, request_id)`، `type` متن
  کران‌دار، `completed_at`، `downtime_minutes` قابل Null، `total_cost_minor` bigint، `currency`، `event_id` منبع، `recorded_at`)؛
  `down.sql` و آزمون برگشت‌پذیری روی پایگاه دادهٔ ناخالی.
- Consumer `analytics-service.maintenance-facts`: Zod محلی، مستأجر از Envelope، نشانگر و Fact در یک تراکنش؛ تحویل دوباره بی‌اثر؛
  رویداد تازهٔ یکسان برای همان درخواست بی‌اثر با نشانگر؛ متناقض ← `BUSINESS_RULE_VIOLATION`.
- `GET /v1/dashboards/fleet?from&to` برای سازمان فعال: به‌ازای هر نوع کار تکمیل‌شده، شمارش، جمع مدت توقف **فقط روی رکوردهایی که
  مدت توقف دارند** (و تعداد آن‌ها، تا Null صفر شمرده نشود)، و جمع هزینه به‌تفکیک ارز؛ و زمان نخستین Fact. **بی نسبت** (ADR-071 §
  «پرسش‌های باز»). نقش‌ها از پیکربندی (پیش‌فرض `ORGANIZATION_ADMIN`، `FLEET_MANAGER`)؛ `AUDITOR` در Boot، Guard و سرویس رد.
- آزمون‌ها: Unit (Projection، پیکربندی، دسترسی)، یکپارچگی Consumer (تکرار، متناقض، مستأجر غایب/ناهمخوان، Payload نامعتبر)،
  API (نقش‌ها، `AUDITOR`، پنجرهٔ نامعتبر)، **جداسازی مستأجر**، Migration.

### PR 2 — خط مبنا و KPIها (`M`)

- جدول `baseline_metric` (فقط الحاقی؛ Trigger) — **بی مسیر نوشتن** (Q-142 (۱)).
- ثبت تعریف شاخص‌ها در کد (کلید، واحد، وابستگی به خط مبنا)؛ `GET /v1/kpis` برای سازمان فعال با وضعیت بستهٔ `AVAILABLE` /
  `INSUFFICIENT_BASELINE`. آزمون: بی ردیف، ردیف محدوده یا دورهٔ دیگر، هر دو `INSUFFICIENT_BASELINE` و `value: null`.

### PR 3 — نمای حاکمیتی (`L`)

- Consumer سلسله‌مراتب از `rasta.organization.v1` (الگوی ADR-053 § ۱۰: شناسه‌ها هرگز کوتاه نمی‌شوند) و پرسش زیردرخت روی جدول خود.
- `GET /v1/dashboards/governance`: فقط `AUDITOR` و `SYSTEM_ADMIN`؛ کل زیردرخت سازمان فعال، بی هیچ شناسهٔ ردیف؛ دو آستانهٔ
  `ANALYTICS_GOVERNANCE_MIN_ORGANIZATIONS` و `ANALYTICS_GOVERNANCE_MIN_RECORDS` بی پیش‌فرض (تعریف‌نشده ← همه `SUPPRESSED`).
  آزمون مرز آستانه با Mutation؛ آزمون اینکه پاسخ هیچ شناسهٔ سازمان، دارایی یا درخواست ندارد.

### PR 4 تا PR 6 — Factهای دیگر

هر کدام: Consumer با همان قواعد ADR-071 § ۲، ردیف کاتالوگ، Migration برگشت‌پذیر، بخش تازهٔ داشبورد مستأجر، آزمون جداسازی. ترکیب
ناوگان فقط با `aggregateVersion` دارایی پیش می‌رود (ADR-071 § ۲ (۳)). `COMMISSION_APPLIED` فقط شمرده و جمع می‌شود، هرگز بازمحاسبه.

### PR 7 — Snapshot و نگهداشت (`M`)

- تصمیم Temporal (`docs/08` `KpiSnapshotWorkflow`) در برابر جاروکنندهٔ درون‌سرویسی، ثبت در ADR-071 § ۸.
- `kpi_snapshot` یکتا به‌ازای (شاخص، محدوده، دوره)؛ نمای حاکمیتی فقط از دوره‌های بسته.
- پاک‌کنندهٔ `processed_event` با نگهداشت از پیکربندی (پیش‌فرض ۳۰ روز، `docs/07` § ۷٫۵).

### PR 8 — کاهش هزینه (`M`)

وابسته به رویدادهای procurement روی `main` (ADR-070 § ۹) و به تعریف شاخص در `docs/24`؛ پیش از آن شروع نمی‌شود.
