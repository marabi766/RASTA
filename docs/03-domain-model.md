# ۰۳ — Domain Model

> Bounded Contextها، Aggregateها و زبان مشترک. این سند مرجع **نام‌گذاری** در کل کدبیس است:
> اگر یک مفهوم اینجا نامی دارد، همان نام در کد، API، رویداد و UI به کار می‌رود.

---

## ۳٫۱ نقشه Bounded Contextها

```
┌──────────────────────────────────────────────────────────────────────────┐
│                          IDENTITY & ACCESS                               │
│  Identity Context          │  Organization Context                       │
│  User · Credential ·       │  Organization · Hierarchy ·                 │
│  Membership · Session      │  Policy · Location                          │
└────────────┬───────────────┴──────────────┬─────────────────────────────┘
             │ USR_/MBR_                    │ ORG_
             ▼                              ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                            ASSET DOMAIN  ◄── هسته کسب‌وکار                │
│  Asset Context        │ Fleet Context      │ Maintenance Context         │
│  Asset · Document ·   │ Driver ·           │ Schedule · Request ·        │
│  InsurancePolicy ·    │ Assignment ·       │ RepairOrder · Part ·        │
│  Inspection           │ UsageRecord        │ Labor                       │
└────────────┬──────────┴──────────┬─────────┴──────────┬──────────────────┘
             │ AST_                 │                    │
             ▼                      ▼                    ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                          COMMERCE DOMAIN                                 │
│  Marketplace     │ Procurement      │ Supplier        │ Inventory        │
│  Catalog·Product │ DemandRequest·   │ Supplier·       │ Warehouse·Stock· │
│  Offer·Order·    │ RFQ·Quotation·   │ Contractor·     │ Movement·        │
│  Review          │ PurchaseOrder    │ Qualification   │ Shipment         │
└────────────┬─────────────────────────────────────────────┬───────────────┘
             │ ORD_/PO_                                     │
             ▼                                              ▼
┌───────────────────────────────────┐  ┌──────────────────────────────────┐
│      RASTA OMRAN (CIVIL WORKS)    │  │       ECONOMIC ENGINE            │
│  Construction  │ Contract         │  │  Wallet · Ledger · Transaction   │
│  Project·Need· │ Contract·        │  │  Payment · Commission · Reward   │
│  Approval·     │ Amendment·       │  │                                  │
│  Tender·Bid·   │ Statement·       │  │  ◄── همه Contextها اینجا         │
│  Evaluation·   │ Milestone        │  │      اثر مالی می‌گذارند          │
│  Progress      │                  │  │                                  │
└───────────────────────────────────┘  └──────────────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                       PLATFORM SUPPORT                                   │
│  Notification  │  Document  │  Audit (فقط الحاقی)  │  Analytics (ReadModel)│
└──────────────────────────────────────────────────────────────────────────┘
```

**قاعده جهت وابستگی.** جریان همیشه از بالا به پایین است. `asset` می‌داند `organization`
وجود دارد؛ `organization` چیزی درباره `asset` نمی‌داند. `economic` رویدادهای همه را مصرف
می‌کند اما هیچ‌کس منطق مالی را فراخوانی نمی‌کند — کارمزد و پاداش **نتیجه رویداد**اند،
نه فراخوانی مستقیم.

---

## ۳٫۲ Ubiquitous Language

جدول مرجع نام‌گذاری. ستون «کد» دقیقاً همان چیزی است که در TypeScript، پایگاه داده و API می‌آید.

### هویت و سازمان

| فارسی (سند محصول)      | کد                     | تعریف                                                              |
| ---------------------- | ---------------------- | ------------------------------------------------------------------ |
| سازمان                 | `Organization`         | هر واحد سازمانی: دهیاری، شهرداری، اتحادیه، شرکت، سازمان دولتی        |
| نوع سازمان             | `OrganizationType`     | `DEHYARI\|MUNICIPALITY\|UNION\|COOPERATIVE\|COMPANY\|GOVERNMENT\|PRIVATE\|NATIONAL_ORGANIZATION` |
| کاربر                  | `User`                 | هویت فردی؛ مستقل از سازمان                                          |
| عضویت سازمانی          | `Membership`           | رابطه کاربر ↔ سازمان با مجموعه نقش‌ها. یک کاربر می‌تواند چند عضویت داشته باشد |
| سازمان فعال            | `activeOrganizationId` | مستأجر جاری درخواست؛ از JWT می‌آید و در برابر عضویت‌ها اعتبارسنجی می‌شود |
| نقش                    | `Role`                 | مجموعه نام‌دار مجوزها                                               |
| مجوز                   | `Permission`           | `<resource>:<action>` مثل `asset:update`                            |

### دارایی و ناوگان

| فارسی                  | کد                     | تعریف                                                              |
| ---------------------- | ---------------------- | ------------------------------------------------------------------ |
| دارایی / ماشین‌آلات    | `Asset`                | **Aggregate Root مرکزی.** هویت دیجیتال پایدار یک ماشین یا تجهیز    |
| پرونده الکترونیکی      | `AssetDossier`         | نمای تجمیعی تاریخچه دارایی (Read Model، از رویدادها ساخته می‌شود)  |
| نوع دستگاه             | `AssetType`            | گریدر، لودر، بیل مکانیکی، کامیون، تراکتور، …                        |
| وضعیت بهره‌برداری      | `OperationalStatus`    | `ACTIVE\|IDLE\|IN_MAINTENANCE\|ASSIGNED\|OUT_OF_SERVICE\|DECOMMISSIONED` |
| راننده / اپراتور       | `Driver`               | فرد مسئول بهره‌برداری؛ به `User` پیوند می‌خورد اما موجودیت جداست    |
| تخصیص                  | `Assignment`           | رابطه زمان‌دار راننده ↔ دارایی                                      |
| کارکرد                 | `UsageRecord`          | ثبت ساعت/کیلومتر با منبع (`MANUAL\|TELEMATICS\|IMPORTED`)          |
| بیمه‌نامه              | `InsurancePolicy`      | پوشش، تاریخ شروع و پایان، شرکت بیمه                                 |
| معاینه فنی             | `TechnicalInspection`  | گواهی معاینه فنی با تاریخ انقضا                                     |

### نگهداری و تعمیر

| فارسی                  | کد                       | تعریف                                                            |
| ---------------------- | ------------------------ | ---------------------------------------------------------------- |
| برنامه سرویس           | `MaintenanceSchedule`    | قاعده دوره‌ای بر مبنای **زمان یا کارکرد**                        |
| نگهداری پیشگیرانه      | `PREVENTIVE`             | نوع `MaintenanceRequest`                                          |
| تعمیر اصلاحی / خرابی   | `CORRECTIVE`             | نوع `MaintenanceRequest`                                          |
| درخواست تعمیر          | `MaintenanceRequest`     | Aggregate Root؛ چرخه از ثبت تا تأیید کاربر                        |
| دستور تعمیر            | `RepairOrder`            | کار ارجاع‌شده به یک تعمیرگاه                                      |
| قطعه مصرفی             | `PartUsage`              | قطعه به‌کاررفته در یک `RepairOrder`، با هزینه                     |
| تعمیرگاه               | `Workshop`               | ارائه‌دهنده خدمت (در `supplier-service` مدل می‌شود)               |

### بازار و تأمین

| فارسی                  | کد                       | تعریف                                                            |
| ---------------------- | ------------------------ | ---------------------------------------------------------------- |
| فهرست کالا             | `Catalog` / `Product`    | تعریف کالا یا خدمت قابل عرضه                                     |
| پیشنهاد عرضه           | `Offer`                  | قیمت و شرایط یک تأمین‌کننده برای یک `Product`                     |
| سفارش                  | `Order`                  | Aggregate Root؛ چرخه از ثبت تا تسویه                             |
| تحویل                  | `Fulfillment`/`Delivery` | مرحله تحویل کالا یا خدمت                                          |
| ارزیابی طرف مقابل      | `Review` / `Rating`      | امتیاز پس از تراکنش؛ مبنای رتبه‌بندی جست‌وجو                      |
| درخواست نیاز           | `DemandRequest`          | نیاز ثبت‌شده یک سازمان، پیش از تبدیل به سفارش                     |
| تجمیع تقاضا            | `DemandAggregation`      | گروه‌بندی چند `DemandRequest` هم‌قلم در یک پنجره زمانی            |
| استعلام                | `RFQ`                    | درخواست قیمت از تأمین‌کنندگان                                     |
| پیشنهاد قیمت           | `Quotation`              | پاسخ تأمین‌کننده به `RFQ`                                         |
| سفارش خرید             | `PurchaseOrder`          | سند خرید نهایی‌شده                                                |
| رسید و کنترل کیفیت     | `Receipt` / `QualityCheck`| تأیید دریافت و انطباق                                            |
| تأمین‌کننده            | `Supplier`               | سازمان عرضه‌کننده؛ دارای `Qualification` و `PerformanceScore`     |

### رستا عمران

| فارسی                  | کد                       | تعریف                                                            |
| ---------------------- | ------------------------ | ---------------------------------------------------------------- |
| پروژه / نیاز عمرانی    | `Project`                | Aggregate Root؛ عنوان، نوع عملیات، محل، شرح کار، برآورد          |
| موافقت                 | `Approval`               | تأیید الکترونیکی یک مرحله، با مرجع، نتیجه، تاریخ، شماره و شرایط   |
| سیاست موافقت           | `ApprovalPolicy`         | **پیکربندی:** کدام موافقت لازم است، مرجعش کیست، آستانه مبلغی چیست |
| مناقصه / استعلام       | `Tender`                 | فراخوان؛ دارای `procurementNature` اجباری                        |
| ماهیت تأمین            | `ProcurementNature`      | `FORMAL_TENDER\|INQUIRY\|RFP\|MARKETPLACE_DEAL` — تعیین‌شده توسط کارفرما |
| سند مناقصه             | `TenderDocument`         | شرح خدمات، مشخصات فنی، مقادیر، شرایط، معیارهای ارزیابی           |
| پیشنهاد                | `Bid`                    | پاسخ پیمانکار، با **ثبت زمان دقیق دریافت**                       |
| ارزیابی                | `Evaluation`             | امتیاز چندمعیاره یک `Bid`                                        |
| معیار ارزیابی          | `EvaluationCriteria`     | **پیکربندی:** معیار، وزن، روش امتیازدهی                          |
| قرارداد                | `Contract`               | Aggregate Root در `contract-service`                             |
| الحاقیه                | `Amendment`              | تغییر قرارداد، با سابقه کامل                                     |
| گزارش پیشرفت           | `ProgressReport`         | درصد پیشرفت، مصالح، ماشین‌آلات، نیروی انسانی، موانع              |
| صورت‌وضعیت             | `Statement`              | مقدار کار، مبلغ، کسورات، تأیید فنی، تأیید مالی                   |
| پیمانکار               | `Contractor`             | ارائه‌دهنده خدمت عمرانی (در `supplier-service`)                  |

### موتور اقتصادی

| فارسی                  | کد                       | تعریف                                                            |
| ---------------------- | ------------------------ | ---------------------------------------------------------------- |
| کیف پول                | `Wallet`                 | حساب عملیاتی هر سازمان؛ نمای دفتر کل                             |
| موجودی در دسترس        | `availableBalance`       | قابل خرج کردن                                                     |
| موجودی معلق            | `pendingBalance`         | Hold شده برای سفارش تأییدنشده                                     |
| نگه‌داشت / آزادسازی    | `Hold` / `Release`       | رزرو مبلغ و آزاد کردن آن پس از تأیید دریافت                       |
| حساب دفتر کل           | `LedgerAccount`          | حساب در نظام دوطرفه، با `AccountType`                            |
| دفتر روزنامه           | `Journal`                | مجموعه اتمیک ورودی‌ها؛ مجموع بدهکار = مجموع بستانکار             |
| ورودی دفتر کل          | `LedgerEntry`            | **تغییرناپذیر.** بدهکار یا بستانکار روی یک حساب                   |
| ورودی معکوس            | `ReversalEntry`          | تنها راه اصلاح                                                    |
| تراکنش                 | `Transaction`            | واحد کسب‌وکاری پرداخت؛ دارای `IdempotencyKey`                    |
| کارمزد                 | `Commission`             | سهم پلتفرم؛ محاسبه‌شده از `CommissionRule`                       |
| قاعده کارمزد           | `CommissionRule`         | **پیکربندی:** نوع تراکنش، نرخ (Basis Point)، سقف، کف             |
| پاداش                  | `Reward`                 | امتیاز یا اعتبار اعطاشده                                          |
| قاعده پاداش            | `RewardRule`             | **پیکربندی:** رویداد محرک، شرط، امتیاز، سقف دوره‌ای              |
| سطح کاربر              | `RewardLevel`            | دسته‌بندی بر مبنای امتیاز انباشته                                 |
| تسویه                  | `Settlement`             | انتقال نهایی به ارائه‌دهنده خدمت پس از کسر کارمزد                |

---

## ۳٫۳ Aggregateها و مرزهای تراکنشی

**قاعده.** یک تراکنش پایگاه داده، **یک Aggregate** را تغییر می‌دهد. تغییر چند Aggregate
از راه رویداد و در نهایت سازگاری (Eventual Consistency) انجام می‌شود — مگر آنکه هر دو
در یک Bounded Context و یک پایگاه داده باشند و ثبات فوری الزام کسب‌وکار باشد.

| Aggregate Root         | موجودیت‌های داخل مرز                                       | چرا این مرز                                                       |
| ---------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------- |
| `Organization`         | `OrganizationPolicy`, `OrganizationLocation`               | سیاست بدون سازمان معنا ندارد                                       |
| `User`                 | `Credential`, `Membership`, `Session`                      | عضویت‌ها باید با کاربر اتمیک تغییر کنند (فعال/غیرفعال شدن)         |
| `Asset`                | `AssetDocument`, `InsurancePolicy`, `TechnicalInspection`  | ثبات فوری لازم: دارایی بدون بیمه معتبر نباید فعال شمرده شود         |
| `Driver`               | `Assignment`                                               | یک راننده نباید هم‌زمان به دو دارایی فعال تخصیص یابد               |
| `MaintenanceRequest`   | `RepairOrder`, `PartUsage`, `LaborEntry`                   | هزینه کل باید با اجزایش اتمیک بماند                                |
| `Order`                | `OrderLine`, `Fulfillment`, `OrderStatusHistory`           | جمع سفارش و اقلامش باید همیشه سازگار باشند                          |
| `DemandAggregation`    | `AggregatedDemandLine`                                     | تجمیع یک عمل اتمیک است                                             |
| `Project`              | `ProjectNeed`, `Approval`                                  | موافقت بدون پروژه معنا ندارد                                        |
| `Tender`               | `TenderDocument`, `Bid`, `Evaluation`                      | ارزیابی باید در برابر مجموعه کامل پیشنهادها اتمیک باشد              |
| `Contract`             | `Amendment`, `Milestone`, `Statement`                      | مبلغ قرارداد و الحاقیه‌هایش باید سازگار بمانند                      |
| `Wallet`               | `WalletHold`                                               | موجودی و Holdها **باید** اتمیک باشند — مبنای Insufficient Balance   |
| `Journal`              | `LedgerEntry`                                              | **CONSTRAINT:** توازن Journal یک Invariant اتمیک است               |
| `Transaction`          | `TransactionLeg`, `Commission`                             | کارمزد و تراکنش در یک لحظه ثبت می‌شوند                              |

### Invariantهای بحرانی

| Aggregate    | Invariant                                                                 | اجرا                          |
| ------------ | ------------------------------------------------------------------------- | ----------------------------- |
| `Journal`    | `Σ debit = Σ credit` (بر حسب هر ارز)                                      | بررسی در Domain + تست + Constraint پایگاه داده |
| `LedgerEntry`| پس از `POSTED` تغییرناپذیر                                                 | بدون متد Update؛ Trigger پایگاه داده |
| `Wallet`     | `availableBalance ≥ 0` و `availableBalance + pendingBalance = ledgerBalance`| قفل ردیف + بررسی Domain      |
| `Asset`      | `ownerOrganizationId` فقط با رویداد `ASSET_TRANSFERRED` تغییر می‌کند       | بدون Setter عمومی             |
| `Assignment` | یک راننده، حداکثر یک تخصیص فعال در هر لحظه                                 | Unique Index جزئی             |
| `Bid`        | پس از مهلت، `Bid` جدید پذیرفته نمی‌شود؛ `submittedAt` تغییرناپذیر          | بررسی Domain + Audit          |
| `Tender`     | گذار وضعیت فقط طبق State Machine                                          | State Machine صریح            |

---

## ۳٫۴ چرخه عمر دارایی (Asset Lifecycle)

مهم‌ترین چرخه عمر پلتفرم، چون سند محصول دارایی را «هسته ماژول مدیریت ناوگان» می‌داند.

```
                    ┌──────────────┐
                    │  REGISTERED  │  ثبت اولیه، پرونده ناقص
                    └──────┬───────┘
                           │ تکمیل مدارک، مالکیت، بیمه
                    ┌──────▼───────┐
       ┌────────────│    ACTIVE    │◄───────────┐
       │            └──┬────────┬──┘            │
       │               │        │               │
  تخصیص به راننده  موعد سرویس  خرابی      اتمام تعمیر
       │               │        │               │
┌──────▼──────┐ ┌──────▼──────┐ │        ┌──────┴────────┐
│  ASSIGNED   │ │    IDLE     │ └───────►│IN_MAINTENANCE │
└──────┬──────┘ └─────────────┘          └───────────────┘
       │
       │ پایان مأموریت
       └──────────────► ACTIVE

       ACTIVE / IDLE ──► OUT_OF_SERVICE ──► DECOMMISSIONED  (نهایی)
                              │
                              └──► ACTIVE  (بازگشت به سرویس)
```

**قواعد گذار:**

| از                | به                | شرط                                                          | رویداد منتشرشده          |
| ----------------- | ----------------- | ------------------------------------------------------------ | ------------------------ |
| `REGISTERED`      | `ACTIVE`          | مدارک مالکیت کامل + بیمه معتبر                               | `ASSET_ACTIVATED`        |
| `ACTIVE`          | `ASSIGNED`        | راننده معتبر و بدون تخصیص فعال دیگر                          | `ASSET_ASSIGNED`         |
| `ACTIVE`/`IDLE`   | `IN_MAINTENANCE`  | `MaintenanceRequest` پذیرفته‌شده                             | `ASSET_MAINTENANCE_STARTED` |
| `IN_MAINTENANCE`  | `ACTIVE`          | `RepairOrder` تأییدشده توسط کاربر                            | `ASSET_MAINTENANCE_COMPLETED` |
| هر وضعیت          | `OUT_OF_SERVICE`  | تصمیم `FLEET_MANAGER` با دلیل ثبت‌شده                        | `ASSET_OUT_OF_SERVICE`   |
| `OUT_OF_SERVICE`  | `DECOMMISSIONED`  | تصمیم `ORGANIZATION_ADMIN`؛ **بازگشت‌ناپذیر**                | `ASSET_DECOMMISSIONED`   |
| هر وضعیت فعال     | (تغییر مالک)      | رویداد انتقال صریح؛ تاریخچه همراه دارایی می‌ماند             | `ASSET_TRANSFERRED`      |

**CONSTRAINT.** `DECOMMISSIONED` نهایی است. دارایی اسقاط‌شده حذف نمی‌شود — سوابق مالی و
حسابرسی آن باید بماند. حذف نرم (`deletedAt`) فقط برای رکوردهای ثبت‌شده به اشتباه، با Audit.

---

## ۳٫۵ Context Mapping — الگوی ارتباط

| از → به                        | الگو                     | مکانیزم                                                     |
| ------------------------------ | ------------------------ | ----------------------------------------------------------- |
| `identity` → همه               | Published Language       | JWT با `sub`, `org_id`, `roles`                             |
| `organization` → همه           | Open Host Service        | REST `GET /organizations/{id}` + رویداد `ORGANIZATION_*`     |
| `asset` ← `maintenance`        | Customer/Supplier        | `maintenance` رویداد منتشر می‌کند؛ `asset` تاریخچه می‌سازد   |
| `asset` ← `fleet`              | Customer/Supplier        | `fleet` رویداد کارکرد منتشر می‌کند                          |
| `marketplace` → `economic`     | Customer/Supplier        | `ORDER_COMPLETED` → محاسبه کارمزد و تسویه                    |
| `construction` → `contract`    | Partnership              | `TENDER_AWARDED` → ایجاد قرارداد                             |
| `contract` → `economic`        | Customer/Supplier        | `STATEMENT_APPROVED` → پرداخت                                |
| `construction` → `fleet`       | Conformist               | استعلام در دسترس بودن دارایی از راه REST                     |
| همه → `audit`                  | Published Language       | هر رویداد دامنه به `rasta.audit.trail.v1` می‌رود             |
| همه → `analytics`              | Published Language       | مصرف رویدادها؛ ساخت Read Model                               |
| همه → `notification`           | Published Language       | مصرف رویدادها؛ ارسال اعلان                                   |

**Anti-Corruption Layer.** هر سرویسی که داده سرویس دیگر را مصرف می‌کند، آن را در **مدل خودش**
ترجمه می‌کند. `analytics-service` مدل داخلی `marketplace` را کپی نمی‌کند؛ `OrderFact` خودش
را می‌سازد. این تضمین می‌کند تغییر Schema داخلی یک سرویس، سرویس‌های دیگر را نشکند.

---

## ۳٫۶ داده مرجع مشترک (Reference Data)

بعضی داده‌ها را چند سرویس لازم دارند. سه گزینه وجود داشت:

| گزینه                     | تصمیم    | دلیل                                                              |
| ------------------------- | -------- | ------------------------------------------------------------------ |
| جدول مشترک                | ❌ رد     | نقض مالکیت داده                                                    |
| فراخوانی همزمان در هر Query| ❌ رد     | جفت‌شدگی زمانی؛ افت یک سرویس همه را می‌خواباند                     |
| **Replica محلی از راه رویداد** | ✅ انتخاب | هر سرویس نسخه فقط‌خواندنی خودش را از رویداد می‌سازد               |

**الگوی پیاده‌سازی.** `asset-service` جدول `organization_ref` دارد با فقط
`(id, name, type, status)` که از رویدادهای `ORGANIZATION_*` به‌روز می‌شود. این جدول:

- فقط‌خواندنی است؛ هرگز مستقیم نوشته نمی‌شود.
- در نهایت سازگار است — و این پذیرفته‌شده است: نام سازمان اگر ۲ ثانیه قدیمی باشد اشکالی ندارد.
- **هرگز** برای تصمیم مجوزدهی استفاده نمی‌شود. مجوزدهی همیشه از JWT و `identity` می‌آید.

---

## ۳٫۷ مدل داده مرکزی (نمای ساده‌شده)

```
Organization ─┬─< Membership >─┬─ User
              │                │
              │                └─< Session
              │
              ├─< Asset ─┬─< AssetDocument
              │          ├─< InsurancePolicy
              │          ├─< TechnicalInspection
              │          ├─< UsageRecord
              │          ├─< Assignment >── Driver
              │          └─< MaintenanceRequest ─< RepairOrder ─< PartUsage
              │
              ├─< Order ─< OrderLine >── Offer >── Product
              │      └─< Fulfillment
              │
              ├─< DemandRequest >── DemandAggregation ─< RFQ ─< Quotation
              │
              ├─< Project ─┬─< Approval
              │            └─< Tender ─┬─< TenderDocument
              │                        └─< Bid ─< Evaluation
              │                              │
              │                              └── Contract ─┬─< Amendment
              │                                            ├─< Milestone
              │                                            └─< Statement
              │
              └─── Wallet ─< WalletHold
                      │
                      └── LedgerAccount ─< LedgerEntry >── Journal >── Transaction
                                                                  └─< Commission
```

نمودار ERD کامل به‌ازای هر سرویس: [`database/`](database/)

---

## ۳٫۸ قواعد نام‌گذاری

| مورد                  | قاعده                              | مثال                                    |
| --------------------- | ---------------------------------- | --------------------------------------- |
| کلاس / Type           | `PascalCase`                       | `MaintenanceRequest`                    |
| متد / متغیر           | `camelCase`                        | `calculateCommission`                   |
| جدول پایگاه داده      | `snake_case` مفرد                  | `maintenance_request`                   |
| ستون پایگاه داده      | `snake_case`                       | `owner_organization_id`                 |
| مسیر API              | `kebab-case` جمع                   | `/maintenance-requests`                 |
| نام رویداد            | `SCREAMING_SNAKE_CASE` (فعل گذشته) | `MAINTENANCE_COMPLETED`                 |
| Topic کافکا           | `rasta.<domain>.v<n>`              | `rasta.maintenance.v1`                  |
| Enum                  | `SCREAMING_SNAKE_CASE`             | `OperationalStatus.IN_MAINTENANCE`      |
| بسته Workspace        | `@rasta/<name>`                    | `@rasta/asset-service`                  |
| شناسه                 | `<PREFIX>_<ULID>`                  | `AST_01JBQ8Z4K7M2N5P8R1T3V6X9Y2`        |

**نام رویداد همیشه فعل گذشته است.** رویداد چیزی است که **اتفاق افتاده**، نه دستوری که
باید اجرا شود. `ORDER_CREATED` درست است؛ `CREATE_ORDER` غلط.
