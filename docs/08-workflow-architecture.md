# ۰۸ — Workflow Architecture

> گردش‌کارهای بلندمدت با Temporal. تراکنش‌های توزیع‌شده با Saga.
> **Business Logic فرآیند هرگز در Controller نوشته نمی‌شود.**

---

## ۸٫۱ چرا Temporal

فرآیندهای رستا دو ویژگی دارند که آن‌ها را از یک درخواست HTTP معمولی جدا می‌کند:

1. **بلندمدت‌اند.** یک مناقصه از انتشار تا انعقاد قرارداد **هفته‌ها** طول می‌کشد.
   یک پنجره تجمیع تقاضا روزها. یک چرخه تأیید صورت‌وضعیت روزها.
2. **باید از افت سرویس جان سالم به در ببرند.** اگر `construction-service` در میانه مهلت
   مناقصه Restart شود، مهلت **نباید** از دست برود.

| گزینه                      | چرا رد شد                                                                  |
| -------------------------- | -------------------------------------------------------------------------- |
| Cron + جدول وضعیت          | هر Timer یک Poll است؛ حالت میانی دست‌ساز؛ جبران خطا دست‌ساز؛ شکننده        |
| BPMN Engine (Camunda)      | مدل‌سازی گرافیکی برای این تیم ارزش افزوده ندارد؛ وزن JVM اضافه             |
| صف تأخیردار (Redis/BullMQ) | Timer دارد اما حالت، تاریخچه، جبران و Determinism ندارد                    |
| **Temporal** ✅            | Timer ماندگار، تاریخچه کامل اجرا، Retry و جبران داخلی، SDK بومی TypeScript |

معاوضه: یک وابستگی زیرساختی سنگین. آگاهانه پذیرفته شده — ADR-010.

**MVP → PRODUCTION.** MVP: یک Instance تک‌گره Temporal با پایگاه داده PostgreSQL مشترک.
Production: Cluster چندگره با پایگاه داده اختصاصی و Namespace جدا به‌ازای محیط.

---

## ۸٫۲ اصول Workflow

| اصل                                                             | دلیل                                                     |
| --------------------------------------------------------------- | -------------------------------------------------------- |
| کد Workflow **قطعی (Deterministic)** است                        | Temporal با بازپخش تاریخچه بازیابی می‌کند                |
| `Date.now()`، `Math.random()`، I/O مستقیم در Workflow **ممنوع** | غیر قطعی‌اند و بازپخش را می‌شکنند                        |
| هر عارضه بیرونی داخل یک **Activity** است                        | Activityها Retry می‌شوند؛ Workflow نه                    |
| Activity باید **Idempotent** باشد                               | Retry تضمین‌شده است، نه احتمالی                          |
| حالت‌ها **صریح و پیکربندی‌پذیر**اند                             | الزام سند محصول: «Workflow باید قابل تنظیم باشد»         |
| Workflow تصمیم **حکمرانی** نمی‌گیرد                             | مرجع تأیید از `ApprovalPolicy` می‌آید، نه از کد Workflow |

**تفکیک مسئولیت:**

```
Controller  →  فقط HTTP و DTO
Service     →  قواعد دامنه، Invariantها
Workflow    →  ترتیب، زمان‌بندی، جبران
Activity    →  یک عارضه بیرونی (فراخوانی سرویس، انتشار رویداد، نوشتن پایگاه داده)
```

---

## ۸٫۳ State Machine مناقصه

مرکزی‌ترین گردش‌کار پلتفرم — مستقیماً از فصل پنجم سند محصول.

```
                        ┌─────────┐
                        │  DRAFT  │  ثبت نیاز، تهیه اسناد
                        └────┬────┘
                             │ requestApproval()
                    ┌────────▼──────────┐
                    │ PENDING_APPROVAL  │◄────┐
                    └────┬─────────┬────┘     │ اصلاح و ارسال دوباره
              grant()    │         │ reject() │
                    ┌────▼───┐  ┌──▼──────────┴──┐
                    │APPROVED│  │ CHANGES_REQUESTED│
                    └────┬───┘  └─────────────────┘
                         │ publish()
                    ┌────▼──────┐
                    │ PUBLISHED │  انتشار عمومی یا محدود، دعوت پیمانکاران
                    └────┬──────┘
                         │ (خودکار در bidOpeningAt)
                    ┌────▼──────┐
                    │ BID_OPEN  │  دریافت پیشنهاد، پرسش و پاسخ
                    └────┬──────┘
                         │ (خودکار در bidClosingAt — Timer ماندگار)
                    ┌────▼──────────┐
                    │  EVALUATION   │  ارزیابی چندمعیاره Configurable
                    └────┬─────┬────┘
                 award()│     │ cancel() / noQualifiedBid()
                    ┌───▼────┐└──────────► CANCELLED / FAILED (نهایی)
                    │AWARDED │
                    └───┬────┘
                        │ (رویداد TENDER_AWARDED → contract-service)
                   ┌────▼───────┐
                   │ CONTRACTED │
                   └────┬───────┘
                        │ startExecution()
                   ┌────▼─────────┐
                   │ IN_PROGRESS  │◄─┐ گزارش پیشرفت، صورت‌وضعیت
                   └────┬─────────┘  │
                        │ ──────────►┘
                        │ completeExecution()
                   ┌────▼──────┐
                   │ COMPLETED │
                   └────┬──────┘
                        │ (همه صورت‌وضعیت‌ها تسویه شد)
                   ┌────▼────┐
                   │ SETTLED │  (نهایی)
                   └─────────┘
```

### جدول گذارها

| از                        | به                  | محرک                          | نگهبان (Guard)                                               |
| ------------------------- | ------------------- | ----------------------------- | ------------------------------------------------------------ |
| `DRAFT`                   | `PENDING_APPROVAL`  | `requestApproval`             | اسناد کامل · **`procurementNature` تعیین‌شده**               |
| `PENDING_APPROVAL`        | `APPROVED`          | `grantApproval`               | **همه موافقت‌های الزامی `ApprovalPolicy` اخذ شده**           |
| `PENDING_APPROVAL`        | `CHANGES_REQUESTED` | `rejectApproval`              | دلیل ثبت شده                                                 |
| `APPROVED`                | `PUBLISHED`         | `publish`                     | `bidOpeningAt` < `bidClosingAt` · معیارهای ارزیابی تعریف‌شده |
| `PUBLISHED`               | `BID_OPEN`          | **Timer** (`bidOpeningAt`)    | —                                                            |
| `BID_OPEN`                | `EVALUATION`        | **Timer** (`bidClosingAt`)    | —                                                            |
| `EVALUATION`              | `AWARDED`           | `award`                       | حداقل یک پیشنهاد واجد شرایط · ارزیابی کامل · موافقت انتخاب   |
| `EVALUATION`              | `FAILED`            | `noQualifiedBid`              | صفر پیشنهاد واجد شرایط                                       |
| `AWARDED`                 | `CONTRACTED`        | رویداد `CONTRACT_SIGNED`      | —                                                            |
| `CONTRACTED`              | `IN_PROGRESS`       | `startExecution`              | ضمانت‌نامه ثبت‌شده (اگر `ApprovalPolicy` الزام کند)          |
| `IN_PROGRESS`             | `COMPLETED`         | `completeExecution`           | پیشرفت ۱۰۰٪ · تأیید فنی نهایی                                |
| `COMPLETED`               | `SETTLED`           | رویداد `SETTLEMENT_COMPLETED` | همه صورت‌وضعیت‌ها تسویه‌شده                                  |
| هر وضعیت پیش از `AWARDED` | `CANCELLED`         | `cancel`                      | دلیل ثبت‌شده · موافقت ابطال                                  |

**CONSTRAINT — پیکربندی‌پذیری.**
`ApprovalPolicy` تعیین می‌کند **کدام** موافقت‌ها الزامی‌اند و **مرجع** هرکدام کیست.
Workflow این را می‌خواند؛ Hard-Code نمی‌کند. سند محصول صریح است: پلتفرم «هیچ کمیته یا مرجع
قانونی جدیدی ایجاد نمی‌کند».

**CONSTRAINT — محرمانگی پیشنهاد.**
تا رسیدن به `EVALUATION`، محتوای `Bid` **رمزنگاری‌شده در حالت سکون** است و هیچ نقشی — از
جمله `UNION_ADMIN` — نمی‌تواند آن را ببیند. زمان دقیق دریافت هر پیشنهاد ثبت و در Audit مهر
زمانی می‌خورد.

### پیاده‌سازی Temporal

```
TenderWorkflow (construction-service)
├── تا سیگنال requestApproval صبر می‌کند
├── Activity: ارزیابی ApprovalPolicy → فهرست موافقت‌های لازم
├── منتظر سیگنال approvalDecision برای هر مورد (با Timeout قابل تنظیم)
├── Timer: تا bidOpeningAt  ◄── ماندگار؛ از Restart جان سالم به در می‌برد
├── Timer: تا bidClosingAt  ◄── ماندگار
├── Activity: بستن دریافت پیشنهاد، رمزگشایی پیشنهادها
├── Activity: محاسبه ماتریس ارزیابی (فرمول Configurable)
├── منتظر سیگنال award یا cancel
└── Activity: انتشار TENDER_AWARDED
```

---

## ۸٫۴ Saga سفارش Marketplace

**Orchestration** (نه Choreography) — چون جبران باید مرکزی و قابل مشاهده باشد.

```
OrderSagaWorkflow (marketplace-service)

 ۱. ایجاد سفارش (PENDING)
 ۲. Activity: economic.placeHold(orderAmount)        ─┐
 ۳. Activity: inventory.reserveStock(items)           │ مراحل جبران‌پذیر
 ۴. Activity: notifySupplier()                        │
 ۵. صبر برای سیگنال fulfillment  (Timeout: ۷ روز)     │
 ۶. صبر برای سیگنال confirmReceipt (Timeout: ۳ روز)  ─┘
 ۷. Activity: economic.releaseHold() + settle()
 ۸. Activity: economic.applyCommission()
 ۹. Activity: economic.grantReward()
۱۰. انتشار ORDER_COMPLETED
```

### جدول جبران

| مرحله شکست‌خورده         | جبران (به ترتیب معکوس)                                                                |
| ------------------------ | ------------------------------------------------------------------------------------- |
| رزرو موجودی (۳)          | `releaseHold` → لغو سفارش                                                             |
| Timeout تحویل (۵)        | `releaseStock` → `releaseHold` → لغو + اعلان                                          |
| Timeout تأیید دریافت (۶) | **تأیید خودکار** پس از مهلت پیکربندی‌شده، **یا** ارجاع به اعتراض — سیاست Configurable |
| اعتراض ثبت شد            | **توقف تسویه**؛ وجه Hold می‌ماند تا رفع اختلاف                                        |
| شکست تسویه (۷)           | Retry (۵ بار)؛ سپس هشدار عملیاتی — **هرگز جبران خودکار مالی**                         |

**CONSTRAINT.** مرحله ۷ به بعد **جبران خودکار ندارد**. اگر تسویه شکست بخورد، وجه در Hold
می‌ماند و هشدار انسانی صادر می‌شود. برگرداندن خودکار پول در یک سیستم مالی، ریسک بزرگ‌تری از
مشکل اصلی است.

**ASSUMPTION.** مهلت‌های ۷ روز و ۳ روز فرضیه‌اند؛ سند محصول عددی نداده.
هر دو **پیکربندی سازمانی**اند. ثبت شده در [`24-open-questions.md`](24-open-questions.md).

---

## ۸٫۵ Workflow تأیید صورت‌وضعیت

```
StatementApprovalWorkflow (contract-service)

 ۱. صورت‌وضعیت ثبت شد (SUBMITTED)
 ۲. Activity: اعلان به مسئول بررسی فنی
 ۳. صبر برای سیگنال technicalApproval  (Timeout پیکربندی‌شده)
 ۴. Activity: اعلان به مسئول بررسی مالی
 ۵. صبر برای سیگنال financialApproval  (Timeout پیکربندی‌شده)
 ۶. Activity: محاسبه کسورات
 ۷. Activity: economic.createPayment(netAmount)
 ۸. Activity: economic.applyCommission()
 ۹. انتشار STATEMENT_APPROVED
```

**CONSTRAINT — تفکیک وظایف.** تأیید فنی و تأیید مالی **باید توسط دو کاربر متفاوت** انجام
شوند. Workflow این را در Activity اعتبارسنجی بررسی می‌کند و نقض آن `BUSINESS_RULE_VIOLATION`
است. این مهم‌ترین کنترل ضدتقلب این مسیر است.

**Invariant.** `Σ(صورت‌وضعیت‌های تأییدشده) ≤ مبلغ قرارداد + Σ(الحاقیه‌ها)` — بررسی در مرحله ۶.

---

## ۸٫۶ Workflow تجمیع تقاضا

```
DemandAggregationWorkflow (procurement-service)  — یکی به‌ازای هر (سازمان، SKU)

 ۱. با نخستین DemandRequest شروع می‌شود
 ۲. Timer: پنجره تجمیع (پیکربندی‌شده، پیش‌فرض ۷ روز)
 ۳. سیگنال addDemand → افزودن به تجمیع
 ۴. در پایان پنجره:
    ├─ مجموع ≥ آستانه؟ → صدور RFQ → انتظار پیشنهاد قیمت → ارزیابی → سفارش خرید
    └─ کمتر از آستانه؟ → طبق سیاست: تمدید پنجره | ارجاع به Marketplace | بستن
```

هر سه پارامتر (طول پنجره، آستانه، سیاست کمبود) **پیکربندی سازمانی**اند.
این همان «تجمیع تقاضا … در بستری خودکار» سند محصول است — **در Backend، نه در UI**.

---

## ۸٫۷ Workflowهای زمان‌بندی‌شده

| Workflow                      | زمان‌بندی    | کار                                                      |
| ----------------------------- | ------------ | -------------------------------------------------------- |
| `MaintenanceDueScanWorkflow`  | روزانه ۰۶:۰۰ | ارزیابی برنامه‌های زمان‌محور → انتشار `MAINTENANCE_DUE`  |
| `InsuranceExpiryScanWorkflow` | روزانه ۰۶:۳۰ | بیمه/معاینه در آستانه انقضا → `INSURANCE_EXPIRING`       |
| `LowStockScanWorkflow`        | هر ۶ ساعت    | آستانه موجودی → `LOW_STOCK_DETECTED`                     |
| `KpiSnapshotWorkflow`         | روزانه ۰۱:۰۰ | ساخت Snapshot شاخص‌ها در `analytics`                     |
| `OutboxHealthWorkflow`        | هر ۵ دقیقه   | تشخیص Relay گیرکرده → هشدار                              |
| `LedgerBalanceAuditWorkflow`  | روزانه ۰۲:۰۰ | **بررسی توازن همه Journalها** → هشدار بحرانی در صورت نقض |

> نگهداری **کارکردمحور** رویدادمحور است (محرک `USAGE_RECORDED`)، نه زمان‌بندی‌شده.
> فقط بخش **زمان‌محور** اسکن روزانه دارد.

**وضعیت واقعی (2026-08-28).** هیچ‌کدام از این شش Workflow نوشته نشده و هیچ سرویسی
هنوز Temporal را لمس نمی‌کند. `maintenance-service` نخستین سرویسی است که به یکی از
آن‌ها نیاز داشت، و به‌جای بالا آوردن عجولانه یک موتور گردش‌کار داخل یک فاز نگهداری،
دو کار کرد (ADR-027):

- **نیمه کارکردمحور دقیقاً همان‌طور که این بخش می‌گوید پیاده شد** — رویدادمحور، با
  محرک `USAGE_RECORDED`، بدون هیچ زمان‌بندی.
- **نیمه زمان‌محور یک Scan درون‌پردازه‌ای است** با یک Update محافظت‌شده
  (`WHERE due_announced_at IS NULL`) که آن را روی چند Replica امن می‌کند — بدون
  قفل، بدون انتخاب رهبر.

و — که مهم‌تر است — **وضعیت سررسید ذخیره نمی‌شود**. در هر خواندن مشتق می‌شود، پس
Scan ای که اجرا نشده فقط چیزی را که اعلام شده تغییر می‌دهد، نه چیزی را که API
گزارش می‌کند. این همان حالت شکستی است که یک `MaintenanceDueScanWorkflow` تنها هم
داشت: اگر اجرا نشود، هر دستگاه سررسیدگذشته «سالم» گزارش می‌شود.

`MaintenanceDueScanWorkflow` **تصمیم معماری باقی می‌ماند**؛ `DueScanner` عمداً طوری
نوشته شده که جایگزینی‌اش یک حذف باشد — همان متد `DueAnnouncerService.announceIfDue`
را صدا می‌زند که مسیر رویدادمحور هم صدا می‌زند.

---

## ۸٫۸ الگوهای پایایی

| الگو                | کجا                        | پیکربندی                                                |
| ------------------- | -------------------------- | ------------------------------------------------------- |
| **Retry**           | همه Activityها             | Backoff نمایی، ۱s → ۱۰۰s، حداکثر ۵ تلاش                 |
| **Timeout**         | همه Activityها             | `startToClose`: ۳۰s؛ عملیات سنگین: ۵ دقیقه              |
| **Idempotency**     | همه Activityهای تغییردهنده | `Idempotency-Key` مشتق از `workflowId + activityId`     |
| **Compensation**    | Sagaها                     | جبران صریح به ترتیب معکوس                               |
| **Circuit Breaker** | کلاینت‌های REST داخلی      | ۵ خطای متوالی → باز؛ ۳۰s → نیمه‌باز                     |
| **Bulkhead**        | Task Queueهای Temporal     | صف جدا به‌ازای دامنه — مناقصه کند، سفارش را نمی‌خواباند |
| **DLQ**             | مصرف‌کننده‌های Kafka       | پس از ۵ تلاش                                            |
| **Outbox**          | همه سرویس‌های منتشرکننده   | Poll هر ۵۰۰ms                                           |

### Task Queueهای Temporal

```
rasta-tender        ← گردش‌کار مناقصه (بلندمدت، کم‌حجم)
rasta-order         ← Saga سفارش (کوتاه‌مدت، پرحجم)
rasta-settlement    ← تسویه مالی (بحرانی، جدا و ایزوله)
rasta-scheduled     ← کارهای زمان‌بندی‌شده
```

**چرا Bulkhead؟** اگر همه در یک صف باشند، صد Workflow مناقصه که هفته‌ها منتظرند می‌توانند
Worker Slotها را اشغال کنند و پردازش سفارش را بخوابانند. صف جدا این را غیرممکن می‌کند.

---

## ۸٫۹ پیکربندی گردش‌کار

**CONSTRAINT.** حالت‌ها و گذارها در پایگاه داده پیکربندی می‌شوند، نه در کد:

```
workflow_definition   (key, version, states[], transitions[], status)
approval_policy       (organizationId, workflowKey, requiredApprovals[], thresholds[])
evaluation_criteria   (tenderId | templateId, criteria[{name, weight, scoringMethod}])
```

Workflow این تعاریف را در **شروع اجرا** می‌خواند و در طول عمر آن اجرا ثابت نگه می‌دارد
(Determinism). تغییر پیکربندی روی اجراهای **جدید** اثر می‌گذارد، نه روی اجراهای جاری —
که هم از نظر Temporal درست است و هم از نظر حقوقی: قواعد یک مناقصه نباید وسط راه عوض شود.

---

## ۸٫۱۰ مشاهده‌پذیری Workflow

- Temporal UI روی `http://localhost:8088` (پروفایل `tools`).
- هر Workflow با `correlationId` به‌عنوان `workflowId` یا Memo اجرا می‌شود.
- Spanهای OpenTelemetry از API به Workflow و Activity منتشر می‌شوند.
- متریک‌ها: `temporal_workflow_completed`، `temporal_workflow_failed`،
  `temporal_activity_retry`، `temporal_workflow_task_queue_latency`.

| هشدار                                        | آستانه                          |
| -------------------------------------------- | ------------------------------- |
| Workflow شکست‌خورده در صف `rasta-settlement` | **هر مورد** → بحرانی            |
| تأخیر Task Queue                             | p99 > ۳۰ ثانیه                  |
| Retry بیش از حد Activity                     | > ۳ تلاش میانگین                |
| Workflow معلق بیش از SLA                     | مناقصه > ۹۰ روز، سفارش > ۱۴ روز |
