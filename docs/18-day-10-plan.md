# ۱۸ — Day-10 Plan · Demo-Ready Vertical Slice

> هدف: دو مسیر End-to-End **واقعی** که با داده واقعی، در معماری واقعی، قابل نمایش باشند.
>
> **قاعده حاکم:** اگر یکی از دو مسیر ناقص باشد، **Feature جدید متوقف می‌شود** و مسیر
> End-to-End کامل می‌شود. عمق بر عرض مقدم است.

---

## ۱۸٫۱ سناریوی ۱ — از ورود تا داشبورد

```
Login → Organization → Machine → Driver → Fleet → Maintenance
      → Marketplace → Order → Mock Payment → Commission → Reward → Dashboard
```

| #   | گام                 | چه اتفاقی می‌افتد (واقعی)                                                               | سرویس‌ها                        |
| --- | ------------------- | --------------------------------------------------------------------------------------- | ------------------------------- |
| ۱   | **Login**           | OIDC Authorization Code + PKCE با Keycloak؛ JWT با `org_id` و نقش‌ها                    | keycloak, identity, gateway     |
| ۲   | **Organization**    | داشبورد سازمان؛ کاربر چندعضویتی سازمان فعال را عوض می‌کند                               | organization, identity          |
| ۳   | **Machine**         | ثبت بیل مکانیکی؛ `AST_<ULID>` صادر می‌شود؛ `ASSET_CREATED` منتشر                        | asset                           |
| ۴   | **Driver**          | ثبت راننده و تخصیص؛ Invariant «یک تخصیص فعال» اعمال می‌شود                              | fleet                           |
| ۵   | **Fleet**           | ثبت کارکرد ۱۲۰ ساعت؛ `USAGE_RECORDED` منتشر می‌شود                                      | fleet                           |
| ۶   | **Maintenance**     | برنامه «هر ۲۵۰ ساعت» با رویداد کارکرد ارزیابی می‌شود → `MAINTENANCE_DUE` → اعلان        | maintenance, notification       |
| ۷   | **Breakdown**       | ثبت خرابی با تصویر؛ **درخواست تکراری رد می‌شود**؛ ارجاع به تعمیرگاه واجد شرایط          | maintenance, supplier, document |
| ۸   | **Marketplace**     | جست‌وجوی «فیلتر روغن»؛ مقایسه پیشنهاد سه تأمین‌کننده بر قیمت/امتیاز/زمان                | marketplace                     |
| ۹   | **Order**           | ثبت سفارش با `Idempotency-Key`؛ **قیمت از سمت سرور**؛ `OrderSagaWorkflow` شروع می‌شود   | marketplace, temporal           |
| ۱۰  | **Hold**            | `FUNDS_HELD`؛ کیف پول: `available −= x`، `pending += x`؛ **Journal متوازن Post می‌شود** | economic                        |
| ۱۱  | **Fulfillment**     | تأمین‌کننده تحویل را اعلام می‌کند                                                       | marketplace                     |
| ۱۲  | **Confirm Receipt** | کاربر دریافت را تأیید می‌کند → **مجوز تسویه صادر می‌شود**                               | marketplace                     |
| ۱۳  | **Settlement**      | `MockPaymentProvider` → تسویه؛ خالص به تأمین‌کننده                                      | economic                        |
| ۱۴  | **Commission**      | نرخ از `CommissionRule` خوانده می‌شود؛ `COMMISSION_APPLIED`؛ درآمد در دفتر کل           | economic                        |
| ۱۵  | **Reward**          | `RewardRule` ارزیابی؛ امتیاز اعطا؛ **Journal هزینه پاداش Post می‌شود**                  | economic                        |
| ۱۶  | **Dashboard**       | همه‌چیز دیده می‌شود: آمادگی ناوگان، سرویس پیش رو، سفارش، موجودی کیف پول، امتیاز         | web, analytics                  |

### آنچه باید در Demo اثبات شود

```
✅ رویدادها در Kafka UI قابل مشاهده‌اند (نه صرفاً تغییر جدول)
✅ Journalهای دفتر کل متوازن‌اند و در UI قابل مشاهده
✅ یک correlationId کل مسیر را در Log به هم وصل می‌کند
✅ Workflow در Temporal UI با حالت واقعی دیده می‌شود
✅ کاربر سازمان دیگر همین داده را نمی‌بیند (نمایش زنده Tenant Isolation)
✅ UI صریحاً «حالت نمایشی پرداخت» را نشان می‌دهد
```

---

## ۱۸٫۲ سناریوی ۲ — رستا عمران

```
Project → Approval → Tender → Bid → Evaluation → Contract → Progress
```

| #   | گام             | چه اتفاقی می‌افتد (واقعی)                                                                      | سرویس‌ها                             |
| --- | --------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------ |
| ۱   | **Project**     | ثبت «بهسازی معبر روستایی» با محل (PostGIS)، شرح، برآورد، پیوست                                 | construction, document               |
| ۲   | **Fleet Check** | `GET /projects/{id}/fleet-analysis`: کدام ماشین‌آلات آزادند، هزینه داخلی در برابر برون‌سپاری   | construction, fleet                  |
| ۳   | **Approval**    | `ApprovalPolicy` خوانده می‌شود → موافقت‌های لازم؛ **مرجع از پیکربندی، نه از کد**               | construction                         |
| ۴   | **Decision**    | مرجع تأیید تصمیم می‌گیرد؛ در Audit با هویت و مهر زمانی ثبت می‌شود                              | construction, audit                  |
| ۵   | **Tender**      | تهیه اسناد؛ **`procurementNature` اجباراً تعیین می‌شود**؛ معیارهای ارزیابی با وزن Configurable | construction                         |
| ۶   | **Publish**     | انتشار؛ Timerهای `bidOpeningAt` و `bidClosingAt` در Temporal؛ اعلان به پیمانکاران              | construction, temporal, notification |
| ۷   | **Bid**         | سه پیمانکار پیشنهاد ثبت می‌کنند؛ **مهر زمانی سرور**؛ **محتوا رمزنگاری‌شده**                    | construction                         |
| ۸   | **Closing**     | Timer مهلت را می‌بندد — **حتی اگر سرویس در این فاصله Restart شده باشد**                        | temporal                             |
| ۹   | **Evaluation**  | رمزگشایی؛ ماتریس چندمعیاره محاسبه و **ثبت** می‌شود                                             | construction                         |
| ۱۰  | **Award**       | انتخاب برنده با **دلیل ثبت‌شده**؛ `TENDER_AWARDED` منتشر                                       | construction                         |
| ۱۱  | **Contract**    | `contract-service` پیش‌نویس قرارداد می‌سازد؛ امضا → `CONTRACT_SIGNED`                          | contract                             |
| ۱۲  | **Progress**    | ثبت پیشرفت ۳۰٪ با تصویر و ماشین‌آلات به‌کاررفته؛ داشبورد پروژه به‌روز می‌شود                   | construction, analytics              |

### آنچه باید در Demo اثبات شود

```
✅ مرجع موافقت از پیکربندی می‌آید — با تغییر یک رکورد، گردش کار عوض می‌شود
✅ پیشنهاد پیش از مهلت حتی برای UNION_ADMIN قابل مشاهده نیست
✅ پیشنهاد پس از مهلت قطعاً رد می‌شود
✅ ماتریس ارزیابی کامل و قابل حسابرسی است
✅ مهلت در Temporal ماندگار است (با Restart سرویس نمایش داده می‌شود)
✅ کل چرخه در Audit قابل ردیابی است
```

---

## ۱۸٫۳ برنامه روزانه

| روز     | تحویل                                                                 | Definition of Done                                                  |
| ------- | --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **۱**   | Repository Foundation                                                 | `pnpm build/typecheck/lint` سبز · `docker compose up` سالم · CI سبز |
| **۱**   | ۲۴ سند + ADRها + `AGENTS.md` + `CLAUDE.md`                            | همه فایل‌ها موجود و منسجم                                           |
| **۲**   | `packages/*` — contracts، config، logging، observability، nest-common | Outbox، TenantContext، Guardها، Error Filter با تست                 |
| **۲–۳** | `identity-service` + `organization-service`                           | ورود کار می‌کند · نقش‌ها Seed شده · **تست Tenant Isolation سبز**    |
| **۳**   | `api-gateway`                                                         | JWT، RBAC، Rate Limit، Correlation، Idempotency، مسیریابی           |
| **۴**   | `asset-service` (+ ماژول insurance)                                   | CRUD، چرخه عمر، پرونده، رویدادها · تست جداسازی سبز                  |
| **۵**   | `fleet-service`                                                       | راننده، تخصیص، کارکرد · Invariant تخصیص · رویدادها                  |
| **۵**   | `maintenance-service`                                                 | برنامه، خرابی، دستور تعمیر، تأیید کاربر · منع درخواست تکراری        |
| **۶**   | `economic-service` — wallet + ledger                                  | **همه تست‌های یکپارچگی مالی سبز**                                   |
| **۷**   | `economic-service` — payment + commission + reward                    | Mock Provider · قواعد Rule-Based · Saga تسویه                       |
| **۷**   | `marketplace-service`                                                 | فهرست، پیشنهاد، سفارش، Saga · Idempotency                           |
| **۸**   | `construction-service`                                                | پروژه، موافقت، مناقصه، پیشنهاد، ارزیابی · Workflow Temporal         |
| **۸**   | `contract-service`                                                    | قرارداد، امضا، پیشرفت                                               |
| **۹**   | `apps/web` — Design System + صفحات P0                                 | RTL، سه حالت، صفحات § ۱۶٫۶                                          |
| **۹**   | `document`، `notification`، `audit` (حداقلی)                          | آپلود، اعلان درون‌برنامه‌ای، سوابق                                  |
| **۱۰**  | یکپارچه‌سازی + Seed نمایشی + **تست E2E دو سناریو**                    | **هر دو مسیر End-to-End سبز**                                       |

---

## ۱۸٫۴ Definition of Done — روز ۱۰

### الزامی

- [ ] `pnpm verify` کاملاً سبز (format · lint · typecheck · test · build)
- [ ] `docker compose up -d` کل زیرساخت را سالم بالا می‌آورد
- [ ] `pnpm db:migrate && pnpm db:seed` بدون خطا
- [ ] **سناریوی ۱ به‌صورت E2E سبز**
- [ ] **سناریوی ۲ به‌صورت E2E سبز**
- [ ] **تست Tenant Isolation برای هر سرویس P0 سبز**
- [ ] **همه تست‌های یکپارچگی مالی سبز**
- [ ] تست ماتریس مجوزدهی سبز
- [ ] Dataset نمایشی کامل (§ ۱۷٫۱)
- [ ] CI روی `main` سبز شامل اسکن Secret
- [ ] OpenAPI هر سرویس P0 تولید و Commit شده
- [ ] کاتالوگ رویدادها با کد همگام
- [ ] `README` کافی برای راه‌اندازی از صفر توسط فرد جدید
- [ ] Commitهای اتمیک و معنادار

### آنچه در روز ۱۰ **لازم نیست**

```
❌ پوشش کامل تست  (هدف روز ۳۰)
❌ تست بار
❌ استقرار Kubernetes
❌ همه سرویس‌های P1
❌ ارائه‌دهنده پرداخت واقعی  (هرگز — CONSTRAINT)
❌ OpenSearch  (P0 با pg_trgm جست‌وجو می‌کند)
❌ صیقل کامل UI  (حرفه‌ای بله، کامل نه)
```

---

## ۱۸٫۵ ریسک‌های روز ۱۰

| ریسک                                          | کاهش                                                                       |
| --------------------------------------------- | -------------------------------------------------------------------------- |
| زیرساخت (Kafka/Temporal/Keycloak) وقت می‌خورد | روز ۱ کاملاً به Foundation اختصاص دارد؛ Health Check از ابتدا              |
| پیچیدگی دفتر کل کمتر از حد برآورد شده         | روز ۶ فقط wallet + ledger؛ تست‌های مالی پیش از هر Feature دیگر             |
| Workflow مناقصه دیر آماده می‌شود              | State Machine صریح جدا از Temporal؛ ابتدا با فراخوانی مستقیم، سپس Temporal |
| UI عقب می‌ماند                                | Design System روز ۹ اما Component پایه از روز ۲ همراه سرویس‌ها             |
| Seed نمایشی ناسازگار                          | Seed قطعی با ULID ثابت؛ تولید از یک اسکریپت واحد                           |
| تلاش برای عرض به‌جای عمق                      | **قاعده § ۱۸: مسیر ناقص = توقف Feature جدید**                              |
