# مستندات مهندسی رستا

> **نسخه:** ۱٫۰ · **وضعیت:** زنده (Living Documents) · **تاریخ:** ۱۴۰۵/۰۶ — 2026-08

این پوشه، حافظه مهندسی پروژه است. هر تصمیم مهمی که هنگام کدنویسی گرفته می‌شود،
باید سند مربوطه را همان لحظه به‌روز کند. **Repository و این اسناد، منبع حافظه پروژه‌اند،
نه Context یک Session طولانی.**

---

## ۲۴ سند مهندسی

| #   | سند                                                              | پاسخ به چه پرسشی؟                                       |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------- |
| 01  | [Executive Architecture](01-executive-architecture.md)           | تصویر کلان، اصول، Stack، تصمیم‌های بنیادین              |
| 02  | [Product Context](02-product-context.md)                         | چه مسئله‌ای، برای چه کسی، در چه مقیاسی                  |
| 03  | [Domain Model](03-domain-model.md)                               | Bounded Context، Aggregate، Ubiquitous Language         |
| 04  | [Service Decomposition](04-service-decomposition.md)             | هر سرویس چه می‌کند و چه نمی‌کند                         |
| 05  | [Data Architecture](05-data-architecture.md)                     | چه کسی مالک چه داده‌ای است، Index، Partition، Retention |
| 06  | [API Architecture](06-api-architecture.md)                       | قرارداد HTTP، Versioning، Idempotency، خطا              |
| 07  | [Event Architecture](07-event-architecture.md)                   | Envelope، Catalogue، Outbox، Retry/DLQ                  |
| 08  | [Workflow Architecture](08-workflow-architecture.md)             | Temporal، Saga، State Machineها                         |
| 09  | [Security Architecture](09-security-architecture.md)             | IAM، RBAC/ABAC، Zero Trust، Threat Model                |
| 10  | [Economic Architecture](10-economic-architecture.md)             | Wallet، Ledger، Commission، Reward، Payment             |
| 11  | [Infrastructure Architecture](11-infrastructure-architecture.md) | PostgreSQL، Redis، Kafka، Object Storage، Search        |
| 12  | [Deployment Architecture](12-deployment-architecture.md)         | محیط‌ها، Kubernetes، CI/CD، Backup/DR                   |
| 13  | [Observability](13-observability.md)                             | Log، Metric، Trace، SLO، هشدار                          |
| 14  | [Testing Strategy](14-testing-strategy.md)                       | هرم تست، Contract Test، DoD هر سرویس                    |
| 15  | [Repository Architecture](15-repository-architecture.md)         | Monorepo، بسته‌های مشترک، مرزهای وابستگی                |
| 16  | [UI Architecture](16-ui-architecture.md)                         | Next.js، Design System، RTL، صفحات                      |
| 17  | [MVP Scope](17-mvp-scope.md)                                     | P0..P3 با Acceptance Criteria                           |
| 18  | [Day-10 Plan](18-day-10-plan.md)                                 | Vertical Slice و دو سناریوی Demo                        |
| 19  | [Day-20 Plan](19-day-20-plan.md)                                 | Feature-Complete MVP                                    |
| 20  | [Day-30 Plan](20-day-30-plan.md)                                 | Hardening و تحویل                                       |
| 21  | [ADR List](21-adr-list.md)                                       | فهرست تصمیم‌های معماری                                  |
| 22  | [Developer Handoff](22-developer-handoff.md)                     | تیم انسانی چطور پروژه را ادامه می‌دهد                   |
| 23  | [Risks & Trade-offs](23-risks-and-tradeoffs.md)                  | چه چیزی را آگاهانه معاوضه کردیم                         |
| 24  | [Open Questions](24-open-questions.md)                           | چه چیزی نیازمند تصمیم انسانی است                        |

## پوشه‌های تکمیلی

| مسیر            | محتوا                                                        |
| --------------- | ------------------------------------------------------------ |
| [`adr/`](adr/)  | متن کامل تصمیم‌های معماری (Context/Decision/Alternatives/Consequences/Status) |
| [`api/`](api/)  | OpenAPI تولیدشده هر سرویس + راهنمای مصرف                     |
| [`events/`](events/) | کاتالوگ کامل رویدادها با Schema، Producer، Consumer     |
| [`database/`](database/) | نمودار ERD و راهنمای Migration                       |
| [`security/`](security/) | Threat Model، مدیریت Secret، راهنمای امنیت           |
| [`deployment/`](deployment/) | راهنمای استقرار محیط‌ها                            |
| [`runbooks/`](runbooks/) | دستورالعمل‌های عملیاتی (حادثه، Restore، Rollback)    |

---

## قواعد خواندن

| برچسب                | معنا                                                                     |
| -------------------- | ------------------------------------------------------------------------ |
| **ASSUMPTION**       | فرضیه فنی؛ سند محصول درباره‌اش ساکت است. قابل تغییر با تأیید کارفرما.     |
| **CONSTRAINT**       | الزام غیرقابل مذاکره (حقوقی، مقرراتی، یا معماری هسته).                    |
| **MVP → PRODUCTION** | راهکار دو مرحله‌ای: ساده‌سازی امروز، مسیر تکامل فردا.                     |
| **OPEN QUESTION**    | نیازمند تصمیم انسانی؛ در سند ۲۴ ثبت شده و **با حدس پر نشده است**.        |

## اصل حاکم

> هر جا میان **سرعت MVP** و **معماری Production** تعارض هست، راه‌حل دو مرحله‌ای ارائه می‌شود.
> ساده‌سازی مجاز است. شکستن **مرز سرویس**، **مالکیت داده**، **Tenant Isolation**،
> **Financial Integrity** یا **Security** مجاز نیست — حتی برای Demo.
