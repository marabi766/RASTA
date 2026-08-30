# ۰۴ — Service Decomposition

> ۱۶ سرویس دامنهٔ قابل استقرار در برنامهٔ MVP + یک API Gateway؛ مقصد معماری ۲۲ سرویس
> منطقی است (ADR-044). برای هر سرویس: مأموریت، مسئولیت‌ها، **مالکیت داده**،
> **آنچه داخل آن نیست**، API، رویدادها، وابستگی‌ها، مرز امنیتی، مشخصات مقیاس و شکست.

---

## ۴٫۱ نمای کلی

| سرویس                  | پورت | فاز | پایگاه داده          | Topic                                   | استقلال؟                                              |
| ---------------------- | ---- | --- | -------------------- | --------------------------------------- | ----------------------------------------------------- |
| `api-gateway`          | 3000 | P0  | — (بدون State)       | —                                       | ✅                                                    |
| `identity-service`     | 3101 | P0  | `rasta_identity`     | `rasta.identity.v1`                     | ✅                                                    |
| `organization-service` | 3102 | P0  | `rasta_organization` | `rasta.organization.v1`                 | ✅                                                    |
| `asset-service`        | 3103 | P0  | `rasta_asset`        | `rasta.asset.v1` + `rasta.insurance.v1` | ✅ (شامل ماژول insurance)                             |
| `fleet-service`        | 3104 | P0  | `rasta_fleet`        | `rasta.fleet.v1`                        | ✅                                                    |
| `maintenance-service`  | 3105 | P0  | `rasta_maintenance`  | `rasta.maintenance.v1`                  | ✅                                                    |
| `marketplace-service`  | 3106 | P0  | `rasta_marketplace`  | `rasta.marketplace.v1`                  | ✅                                                    |
| `procurement-service`  | 3107 | P1  | `rasta_procurement`  | `rasta.procurement.v1`                  | ✅                                                    |
| `supplier-service`     | 3108 | P1  | `rasta_supplier`     | `rasta.supplier.v1`                     | ✅                                                    |
| `inventory-service`    | 3109 | P1  | `rasta_inventory`    | `rasta.inventory.v1`                    | ✅ (شامل ماژول logistics)                             |
| `construction-service` | 3110 | P0  | `rasta_construction` | `rasta.construction.v1`                 | ✅                                                    |
| `contract-service`     | 3111 | P0  | `rasta_contract`     | `rasta.contract.v1`                     | ✅                                                    |
| `economic-service`     | 3112 | P0  | `rasta_economic`     | `rasta.economic.v1`                     | ✅ **IMPLEMENTED** (۵ ماژول + transaction/settlement) |
| `notification-service` | 3113 | P0  | `rasta_notification` | `rasta.notification.v1`                 | ✅                                                    |
| `document-service`     | 3114 | P0  | `rasta_document`     | `rasta.document.v1`                     | ✅                                                    |
| `audit-service`        | 3115 | P0  | `rasta_audit`        | `rasta.audit.trail.v1`                  | ✅                                                    |
| `analytics-service`    | 3116 | P1  | `rasta_analytics`    | — (فقط مصرف‌کننده)                      | ✅                                                    |

### سرویس‌های تجمیع‌شده و دلیل

معماری هدف ۲۲ دامنه را فهرست می‌کند. سه تجمیع آگاهانه برای استقرار MVP انجام شد. **هر سه با مرزبندی داخلی
کامل**: Schema جدا، ماژول Nest جدا، بدون Join میان‌ماژولی، Topic جدا. استخراج هرکدام یک
تغییر استقرار است، نه بازنویسی.

| سرویس مقصد          | ادغام‌شده                                       | چرا                                                                                                                                                         | محرک استخراج آتی                         |
| ------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `economic-service`  | wallet · ledger · payment · commission · reward | مرز تراکنشی مشترک: تکمیل سفارش باید در **یک تراکنش ACID** کیف پول، دفتر کل و کارمزد را بزند. تقسیم = جایگزینی تراکنش با Saga پنج‌مرحله‌ای، بدون فایده مقیاس | محرک اختصاصی هر دامنه در ADR-044         |
| `asset-service`     | insurance registry                              | ثبت بیمه‌نامه و هشدار انقضا بخشی از پروندهٔ دارایی است؛ چرخهٔ تجاری و Claim در مقصد نزد `insurance-service` خواهد بود                                       | استعلام/صدور، Claim واقعی یا چند بیمه‌گر |
| `inventory-service` | logistics                                       | حرکت موجودی و حمل، یک جریان پیوسته‌اند؛ تقسیم آن‌ها یک Saga برای عملیاتی می‌سازد که ذاتاً یکی است                                                           | ورود شرکای حمل شخص ثالث با API مستقل     |

**IoT / Telematics** ساخته نمی‌شود (فاز ۳). اما `UsageRecord.source` از امروز
`MANUAL | TELEMATICS | IMPORTED` را می‌پذیرد تا ورود خودکار بعداً یک Consumer جدید باشد.

### مقصد ۲۲سرویسی

پنج ماژول اقتصادی و بیمه «حذف‌شده» نیستند؛ آن‌ها مقصد استخراج مستقل دارند. فهرست رسمی:
`identity`، `organization`، `asset`، `fleet`، `maintenance`، `insurance`،
`marketplace`، `procurement`، `supplier`، `inventory-and-logistics`، `construction`،
`contract`، `wallet`، `ledger`، `payment`، `commission`، `reward`، `notification`،
`document`، `audit`، `analytics` و `iot-telematics`.

استخراج فقط پس از تحقق محرک، ADR مهاجرت و اثبات اینکه مرز تراکنشی جدید ایمن است انجام
می‌شود. تا آن زمان وضعیت Deployment با وضعیت قابلیت اشتباه نمی‌شود.

---

## ۴٫۲ api-gateway

| بُعد             | مشخصات                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Mission**      | تنها نقطه ورود ترافیک بیرونی. هر درخواست را احراز هویت، محدوده‌گذاری و مسیریابی می‌کند.                                                                            |
| **مسئولیت‌ها**   | اعتبارسنجی JWT (JWKS) · حل `activeOrganizationId` · RBAC سطح مسیر · Rate Limit · CORS · تولید Correlation ID · Idempotency Cache · Circuit Breaker · تجمیع OpenAPI |
| **مالکیت داده**  | **هیچ.** فقط Cache در Redis (کلید Idempotency، شمارنده Rate Limit، JWKS)                                                                                           |
| **داخل نیست**    | هیچ منطق کسب‌وکاری. هیچ دسترسی به پایگاه داده. هیچ تبدیل داده دامنه‌ای.                                                                                            |
| **Dependencies** | Keycloak (JWKS) · Redis · همه سرویس‌های Downstream                                                                                                                 |
| **مرز امنیتی**   | مرز اعتماد بیرونی. **تنها** سرویسی که در Kubernetes از Ingress ترافیک می‌گیرد.                                                                                     |
| **Scale**        | بی‌حالت، افقی. HPA بر مبنای CPU و RPS.                                                                                                                             |
| **Failure**      | افت آن = قطع کامل دسترسی بیرونی. حداقل ۲ Replica. Circuit Breaker برای هر Downstream.                                                                              |

**MVP → PRODUCTION.** در Production یک Edge Gateway (Kong/APISIX) با TLS Termination، WAF و
Rate Limit سراسری جلوی این می‌نشیند. این Gateway مسئول منطق **مستأجر** می‌ماند. → ADR-009

---

## ۴٫۳ identity-service

| بُعد             | مشخصات                                                                                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mission**      | مرجع حقیقت «چه کسی هستی و در کدام سازمان چه نقشی داری».                                                                                                                                 |
| **مسئولیت‌ها**   | ثبت‌نام و چرخه کاربر · همگام‌سازی با Keycloak · عضویت سازمانی · تخصیص نقش · Permission · Session · MFA-ready                                                                            |
| **مالکیت داده**  | `user` · `membership` · `role` · `permission` · `role_permission` · `user_session` · `registration_request`                                                                             |
| **داخل نیست**    | ذخیره رمز عبور (نزد Keycloak) · تعریف سازمان (نزد `organization`) · محتوای مدارک (نزد `document`)                                                                                       |
| **Commands**     | `RegisterUser` · `ApproveRegistration` · `AssignRole` · `RevokeRole` · `CreateMembership` · `SwitchActiveOrganization` · `DeactivateUser`                                               |
| **Queries**      | `GetUser` · `ListUsers` · `GetMemberships` · `ResolveEffectivePermissions`                                                                                                              |
| **REST**         | `POST /users` · `GET /users/{id}` · `PATCH /users/{id}` · `GET /users/me` · `POST /users/{id}/memberships` · `DELETE /memberships/{id}` · `GET /roles` · `POST /memberships/{id}/roles` |
| **Publishes**    | `USER_REGISTERED` · `USER_ACTIVATED` · `USER_DEACTIVATED` · `MEMBERSHIP_CREATED` · `MEMBERSHIP_REVOKED` · `ROLE_ASSIGNED` · `ROLE_REVOKED`                                              |
| **Consumes**     | `ORGANIZATION_CREATED` · `ORGANIZATION_DEACTIVATED` (برای Replica مرجع + ابطال عضویت)                                                                                                   |
| **Dependencies** | Keycloak Admin API · PostgreSQL · Kafka                                                                                                                                                 |
| **مرز امنیتی**   | **بالاترین.** افت آن = ناتوانی در احراز هویت. اعتبارنامه Keycloak فقط اینجا.                                                                                                            |
| **Scale**        | خواندن‌محور. Cache مجوزهای مؤثر در Redis با TTL کوتاه (۶۰ ثانیه) و ابطال فعال با رویداد.                                                                                                |
| **Failure**      | توکن‌های صادرشده تا انقضا معتبر می‌مانند → افت کوتاه، کاربران فعال را قطع نمی‌کند.                                                                                                      |

---

## ۴٫۴ organization-service

| بُعد             | مشخصات                                                                                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mission**      | مدل عمومی و قابل توسعه سازمان و سلسله‌مراتب آن — مستقل از «دهیاری».                                                                                                                                                          |
| **مسئولیت‌ها**   | چرخه عمر سازمان · درخت سلسله‌مراتب · نوع و وضعیت · موقعیت جغرافیایی (PostGIS) · فراداده · سیاست‌های سازمانی                                                                                                                  |
| **مالکیت داده**  | `organization` · `organization_hierarchy` · `organization_policy` · `organization_location` · `organization_contact`                                                                                                         |
| **داخل نیست**    | کاربران (نزد `identity`) · دارایی (نزد `asset`) · کیف پول (نزد `economic`)                                                                                                                                                   |
| **Commands**     | `CreateOrganization` · `UpdateOrganization` · `MoveInHierarchy` · `SetPolicy` · `DeactivateOrganization`                                                                                                                     |
| **Queries**      | `GetOrganization` · `ListOrganizations` · `GetSubtree` · `GetAncestors` · `FindNearby` (GIS)                                                                                                                                 |
| **REST**         | `POST /organizations` · `GET /organizations` · `GET /organizations/{id}` · `PATCH /organizations/{id}` · `GET /organizations/{id}/children` · `GET /organizations/{id}/ancestors` · `PUT /organizations/{id}/policies/{key}` |
| **Publishes**    | `ORGANIZATION_CREATED` · `ORGANIZATION_UPDATED` · `ORGANIZATION_MOVED` · `ORGANIZATION_DEACTIVATED` · `ORGANIZATION_POLICY_CHANGED`                                                                                          |
| **Consumes**     | — (بالادست‌ترین سرویس دامنه)                                                                                                                                                                                                 |
| **Dependencies** | PostgreSQL + PostGIS · Kafka                                                                                                                                                                                                 |
| **مرز امنیتی**   | نوشتن فقط `SYSTEM_ADMIN` و `UNION_ADMIN`. خواندن محدود به زیردرخت مجاز کاربر.                                                                                                                                                |
| **Scale**        | خواندن‌محور، تغییر بسیار کم. Cache تهاجمی (TTL ۵ دقیقه) + ابطال با رویداد.                                                                                                                                                   |
| **Failure**      | افت آن APIهای نوشتن را می‌خواباند اما سرویس‌های دیگر با Replica محلی کار می‌کنند.                                                                                                                                            |

**نکته پیاده‌سازی.** سلسله‌مراتب با **Materialized Path** (`path ltree`) ذخیره می‌شود، نه
Adjacency List خالص. دلیل: پرس‌وجوی «همه دهیاری‌های زیرمجموعه شهرستان X» باید یک Index Scan
باشد، نه Recursive CTE — این پرس‌وجو در هر داشبورد استانداری اجرا می‌شود.

---

## ۴٫۵ asset-service

| بُعد             | مشخصات                                                                                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mission**      | هویت دیجیتال پایدار هر دارایی و پرونده الکترونیکی کامل آن.                                                                                                                                                                                                                            |
| **مسئولیت‌ها**   | ثبت و چرخه عمر دارایی · مشخصات فنی · مالکیت و انتقال · موقعیت · **پرونده الکترونیکی (Read Model از رویدادها)** · ماژول `insurance`: بیمه‌نامه، پوشش، انقضا، معاینه فنی                                                                                                                |
| **مالکیت داده**  | `asset` · `asset_specification` · `asset_document_ref` · `asset_location` · `asset_transfer` · `asset_timeline` (Read Model) · `insurance_policy` · `insurance_claim` · `technical_inspection`                                                                                        |
| **داخل نیست**    | کارکرد و راننده (نزد `fleet`) · دستور تعمیر (نزد `maintenance`) · فایل مدارک (نزد `document`، اینجا فقط ارجاع)                                                                                                                                                                        |
| **Commands**     | `RegisterAsset` · `UpdateAsset` · `ActivateAsset` · `TransferAsset` · `DecommissionAsset` · `RecordInsurancePolicy` · `RecordInspection`                                                                                                                                              |
| **Queries**      | `GetAsset` · `ListAssets` · `SearchAssets` · `GetAssetDossier` · `GetExpiringInsurance` · `FindAssetsNearby`                                                                                                                                                                          |
| **REST**         | `POST /assets` · `GET /assets` · `GET /assets/{id}` · `PATCH /assets/{id}` · `POST /assets/{id}/transfer` · `POST /assets/{id}/decommission` · `GET /assets/{id}/dossier` · `GET /assets/{id}/timeline` · `POST /assets/{id}/insurance-policies` · `GET /insurance-policies/expiring` |
| **Publishes**    | `ASSET_CREATED` · `ASSET_UPDATED` · `ASSET_ACTIVATED` · `ASSET_TRANSFERRED` · `ASSET_DECOMMISSIONED` · `ASSET_STATUS_CHANGED` · `INSURANCE_RECORDED` · `INSURANCE_EXPIRING` · `INSPECTION_EXPIRING`                                                                                   |
| **Consumes**     | `USAGE_RECORDED` · `MAINTENANCE_COMPLETED` · `ORDER_COMPLETED` · `PROJECT_ASSET_ASSIGNED` → همه برای ساخت `asset_timeline` · `ORGANIZATION_*` → Replica مرجع                                                                                                                          |
| **Dependencies** | PostgreSQL + PostGIS · Kafka · `document-service` (REST، برای اعتبارسنجی ارجاع)                                                                                                                                                                                                       |
| **مرز امنیتی**   | خواندن و نوشتن محدود به `ownerOrganizationId`. انتقال دارایی نیازمند مجوز هر دو سازمان.                                                                                                                                                                                               |
| **Scale**        | خواندن‌محور. `asset_timeline` تنها بخش نوشتن‌سنگین است — پارتیشن‌بندی بر حسب ماه.                                                                                                                                                                                                     |
| **Failure**      | افت آن جست‌وجوی دارایی و ثبت جدید را می‌خواباند. `fleet` و `maintenance` با شناسه دارایی که دارند کار می‌کنند.                                                                                                                                                                        |

**Invariant.** `ASSET_ACTIVATED` تنها زمانی صادر می‌شود که مدارک مالکیت کامل و **بیمه‌نامه
معتبر** موجود باشد. این دلیل قرار گرفتن `insurance` در همین سرویس است.

---

## ۴٫۶ fleet-service

| بُعد             | مشخصات                                                                                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mission**      | «چه کسی از کدام دستگاه، کِی و چقدر استفاده می‌کند» و «کدام دستگاه الان آزاد است».                                                                                                                                            |
| **مسئولیت‌ها**   | راننده/اپراتور · تخصیص زمان‌دار · ثبت کارکرد (ساعت/کیلومتر) · در دسترس بودن · مأموریت · ساعات کار · داشبورد پایه ناوگان                                                                                                      |
| **مالکیت داده**  | `driver` · `assignment` · `usage_record` · `availability_window` · `mission`                                                                                                                                                 |
| **داخل نیست**    | مشخصات دارایی (نزد `asset`) · هویت کاربر (نزد `identity`) · تعمیر (نزد `maintenance`)                                                                                                                                        |
| **Commands**     | `RegisterDriver` · `AssignDriverToAsset` · `EndAssignment` · `RecordUsage` · `SetAvailability` · `StartMission` · `CompleteMission`                                                                                          |
| **Queries**      | `GetDriver` · `ListAssignments` · `GetUsageHistory` · `GetAvailableAssets` · `GetUtilization`                                                                                                                                |
| **REST**         | `POST /drivers` · `GET /drivers` · `POST /assets/{assetId}/assignments` · `DELETE /assignments/{id}` · `POST /assets/{assetId}/usage` · `GET /assets/{assetId}/usage` · `GET /fleet/availability` · `GET /fleet/utilization` |
| **Publishes**    | `DRIVER_REGISTERED` · `ASSET_ASSIGNED` · `ASSIGNMENT_ENDED` · `USAGE_RECORDED` · `AVAILABILITY_CHANGED` · `MISSION_STARTED` · `MISSION_COMPLETED`                                                                            |
| **Consumes**     | `ASSET_CREATED` / `ASSET_DECOMMISSIONED` (Replica مرجع) · `MAINTENANCE_STARTED` / `MAINTENANCE_COMPLETED` (به‌روزرسانی در دسترس بودن)                                                                                        |
| **Dependencies** | PostgreSQL · Kafka                                                                                                                                                                                                           |
| **مرز امنیتی**   | `DRIVER` و `OPERATOR` فقط دارایی‌های تخصیص‌یافته به خود را می‌بینند — بررسی سطح Object.                                                                                                                                      |
| **Scale**        | نوشتن‌سنگین‌ترین سرویس ناوگان (`usage_record`). پارتیشن ماهانه + Index مرکب `(asset_id, recorded_at DESC)`.                                                                                                                  |
| **Failure**      | افت آن ثبت کارکرد را می‌خواباند. UI باید صف محلی داشته باشد (PWA offline).                                                                                                                                                   |

**نکته.** `USAGE_RECORDED` محرک اصلی نگهداری پیشگیرانه است: `maintenance-service` آن را مصرف
می‌کند و برنامه‌های مبتنی بر کارکرد را ارزیابی می‌کند. این دقیقاً همان «سرویس دوره‌ای بر مبنای
زمان یا کارکرد» سند محصول است.

---

## ۴٫۷ maintenance-service

| بُعد             | مشخصات                                                                                                                                                                                                                                                                                                                           |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mission**      | تبدیل نگهداری از واکنشی به پیشگیرانه، و مدیریت چرخه کامل تعمیر تا تسویه.                                                                                                                                                                                                                                                         |
| **مسئولیت‌ها**   | برنامه سرویس (زمان/کارکرد) · هشدار پیش از موعد · ثبت خرابی · ارجاع به تعمیرگاه · دستور تعمیر · قطعات و دستمزد · هزینه · **تأیید کاربر پیش از تسویه**                                                                                                                                                                             |
| **مالکیت داده**  | `maintenance_schedule` · `maintenance_request` · `repair_order` · `part_usage` · `labor_entry` · `maintenance_cost`                                                                                                                                                                                                              |
| **داخل نیست**    | پروفایل تعمیرگاه (نزد `supplier`) · پرداخت (نزد `economic`) · موجودی قطعه (نزد `inventory`)                                                                                                                                                                                                                                      |
| **Commands**     | `DefineSchedule` · `ReportBreakdown` · `CreateMaintenanceRequest` · `AssignWorkshop` · `StartRepair` · `RecordParts` · `RecordLabor` · `CompleteRepair` · `ApproveByUser`                                                                                                                                                        |
| **Queries**      | `GetRequest` · `ListRequests` · `GetDueMaintenance` · `GetAssetMaintenanceHistory` · `GetWorkshopPerformance`                                                                                                                                                                                                                    |
| **REST**         | `POST /maintenance-schedules` · `GET /maintenance-schedules/due` · `POST /maintenance-requests` · `GET /maintenance-requests` · `GET /maintenance-requests/{id}` · `POST /maintenance-requests/{id}/assign` · `POST /repair-orders/{id}/parts` · `POST /repair-orders/{id}/complete` · `POST /maintenance-requests/{id}/approve` |
| **Publishes**    | `MAINTENANCE_DUE` · `BREAKDOWN_REPORTED` · `MAINTENANCE_CREATED` · `MAINTENANCE_STARTED` · `WORKSHOP_ASSIGNED` · `REPAIR_COMPLETED` · `MAINTENANCE_COMPLETED` · `MAINTENANCE_APPROVED`                                                                                                                                           |
| **Consumes**     | `USAGE_RECORDED` (ارزیابی برنامه‌های مبتنی بر کارکرد) · `ASSET_*` (Replica مرجع) · `PAYMENT_COMPLETED` (بستن چرخه تسویه)                                                                                                                                                                                                         |
| **Dependencies** | PostgreSQL · Kafka · Temporal (Timer سررسید) · `supplier-service` (REST، احراز صلاحیت تعمیرگاه)                                                                                                                                                                                                                                  |
| **مرز امنیتی**   | تعمیرگاه فقط دستورهای ارجاع‌شده به خود را می‌بیند. **کنترل سند محصول:** تسویه بدون `MAINTENANCE_APPROVED` ممنوع.                                                                                                                                                                                                                 |
| **Scale**        | متوسط. Timerهای سررسید در Temporal، نه Cron.                                                                                                                                                                                                                                                                                     |
| **Failure**      | افت آن ثبت خرابی جدید را می‌خواباند. Timerهای Temporal پس از بازیابی اجرا می‌شوند (از دست نمی‌روند).                                                                                                                                                                                                                             |

**کنترل الزامی سند محصول:** «الزام تأیید کاربر پیش از تسویه نهایی» و «جلوگیری از ثبت درخواست
تکراری». دومی با کلید یکتای `(asset_id, type, status IN ('OPEN','IN_PROGRESS'))` اجرا می‌شود.

**وضعیت (2026-08-28): IMPLEMENTED · TESTED · LIVE VERIFIED.** پورت ۳۱۰۵، پایگاه
داده `rasta_maintenance`، Topic `rasta.maintenance.v1`. آنچه هنگام پیاده‌سازی با
جدول بالا تفاوت کرد، اینجاست — سه انحراف، هر سه با ADR:

| مورد در جدول                    | واقعیت پیاده‌شده                                                                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Temporal (Timer سررسید)`       | **پیاده نشد.** ارزیابی سررسید در هر خواندن **مشتق** می‌شود؛ اعلام کارکردمحور رویدادمحور است و اعلام زمان‌محور یک Scan درون‌پردازه‌ای محافظت‌شده (ADR-027). |
| `PAYMENT_COMPLETED` مصرف می‌شود | **DEFERRED.** `economic-service` وجود ندارد، پس معنای «بستن چرخه» تعریف‌نشده است؛ اختراعش یعنی اختراع فرآیند مالی (ADR-028).                               |
| `supplier-service` (REST)       | **Port نام‌گذاری‌شده، بدون پیاده‌سازی.** `WorkshopDirectory` هر ارجاع را می‌پذیرد و نبودِ بررسی را Log می‌کند (ADR-029، Q-25).                             |
| «تعمیرگاه فقط ارجاع‌شده به خود» | **DEFERRED.** دسترسی میان‌تنانتی مدل ندارد؛ نقش `WORKSHOP` در باریک‌سازی عمومی می‌افتد و هیچ نمی‌بیند — امن به‌صورت پیش‌فرض (ADR-029، Q-25).               |
| `GetWorkshopPerformance`        | **پیاده نشد.** امتیاز عملکرد تأمین‌کننده مال `supplier-service` است.                                                                                       |

**افزوده‌ها نسبت به جدول بالا:**

- `MAINTENANCE_CANCELLED` منتشر می‌شود — تنها رویداد فراتر از کاتالوگ، و فقط برای
  درست نگه داشتن ادعایی که `MAINTENANCE_CREATED` قبلاً منتشر کرده (AGENTS.md S-06).
- `asset_usage_meter` — یک Read Model که این سرویس **مالکش است**: کنتور مشتق‌شده از
  `USAGE_RECORDED`. رکوردهای کارکرد خودشان هرگز کپی نمی‌شوند؛ مالکشان `fleet` است.
- مسیرهای `POST /repair-orders/{id}/start`، `.../labour`، `.../costs`، `.../cancel`
  و `POST /maintenance-requests/{id}/cancel`، که جدول بالا نامشان نبرده بود.

**کنترل «منع درخواست تکراری» دقیقاً همان‌طور که `docs/05` § ۵٫۵ نوشته پیاده شد** —
`UNIQUE (asset_id, type) WHERE status IN ('OPEN','IN_PROGRESS')` — و زیر یک مسابقه
واقعی تست شده، نه فقط ترتیبی.

---

## ۴٫۸ marketplace-service

| بُعد             | مشخصات                                                                                                                                                                                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **وضعیت**        | ✅ **پیاده‌شده (2026-08-30).** چرخه کامل سفارش تا تسویه، روی Temporal. سه وابستگی مستند و موکول: `supplier` (احراز صلاحیت `UNAVAILABLE`)، `inventory` (رزرو انبار ادعا نمی‌شود)، `notification` (تحویل اعلان ادعا نمی‌شود) — ADR-041.                                                   |
| **Mission**      | بازار تخصصی کالا و خدمات ناوگان، با رقابت شفاف میان تأمین‌کنندگان.                                                                                                                                                                                                                      |
| **مسئولیت‌ها**   | فهرست کالا · محصول و خدمت · پیشنهاد عرضه و قیمت · موجودی عرضه · سبد · سفارش · تحویل · **کنترل کیفیت پیش از تأیید** · **اعتراض پیش از آزادسازی** · ارزیابی و امتیاز                                                                                                                      |
| **مالکیت داده**  | `product` · `offer` · `offer_price_history` · `order` · `order_line` · `fulfillment` · `order_status_history` · `order_dispute` · `review` — ‏`delivery` و `fulfillment` یک جدول شدند و `cart` موکول شد (ADR-037 §§ ۲–۳)                                                                |
| **داخل نیست**    | پروفایل تأمین‌کننده (نزد `supplier`) · موجودی انبار (نزد `inventory`) · پول (نزد `economic`)                                                                                                                                                                                            |
| **Commands**     | `PublishOffer` · `UpdatePrice` · `AddToCart` · `PlaceOrder` · `ConfirmFulfillment` · `ConfirmReceipt` · `RaiseDispute` · `SubmitReview` · `CancelOrder`                                                                                                                                 |
| **Queries**      | `SearchProducts` · `GetOffers` · `GetOrder` · `ListOrders` · `GetSupplierRating`                                                                                                                                                                                                        |
| **REST**         | `GET /products` · `GET /products/{id}/offers` · `POST /offers` · `POST /cart/items` · `POST /orders` **(Idempotency-Key الزامی)** · `GET /orders/{id}` · `POST /orders/{id}/fulfill` · `POST /orders/{id}/confirm-receipt` · `POST /orders/{id}/disputes` · `POST /orders/{id}/reviews` |
| **Publishes**    | `OFFER_PUBLISHED` · `ORDER_CREATED` · `ORDER_CONFIRMED` · `ORDER_FULFILLED` · `ORDER_RECEIPT_CONFIRMED` · `ORDER_COMPLETED` · `ORDER_CANCELLED` · `ORDER_DISPUTED` · `REVIEW_SUBMITTED`                                                                                                 |
| **Consumes**     | `PAYMENT_AUTHORIZED` · `PAYMENT_COMPLETED` · `PAYMENT_FAILED` (پیشبرد Saga سفارش) · `SUPPLIER_QUALIFIED` / `SUPPLIER_SUSPENDED` · `STOCK_RESERVED`                                                                                                                                      |
| **Dependencies** | PostgreSQL (شامل `pg_trgm` برای جست‌وجو — ADR-042) · Kafka · Temporal (Saga سفارش، صف `rasta-order`) · `economic-service`. **بدون Redis و بدون OpenSearch**: سبد موکول شد و جست‌وجو در PostgreSQL است.                                                                                  |
| **مرز امنیتی**   | تأمین‌کننده فقط پیشنهادها و سفارش‌های خود را می‌بیند. **رتبه‌بندی جست‌وجو هیچ امتیاز ساختاری به اتحادیه نمی‌دهد.**                                                                                                                                                                      |
| **Scale**        | خواندن‌سنگین (جست‌وجو) → OpenSearch. نوشتن متوسط.                                                                                                                                                                                                                                       |
| **Failure**      | افت آن سفارش جدید را می‌خواباند. سفارش‌های در جریان در Temporal ادامه می‌یابند.                                                                                                                                                                                                         |

---

## ۴٫۹ procurement-service

| بُعد             | مشخصات                                                                                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Mission**      | تبدیل تقاضای پراکنده به قدرت خرید تجمیعی — **در Backend، نه در UI**.                                                                                                                                                                                   |
| **مسئولیت‌ها**   | ثبت نیاز · **تجمیع تقاضا (پنجره زمانی + SKU + آستانه)** · استعلام (RFQ) · دریافت پیشنهاد قیمت · ارزیابی · سفارش خرید · رسید · کنترل کیفیت                                                                                                              |
| **مالکیت داده**  | `demand_request` · `demand_aggregation` · `aggregated_line` · `rfq` · `rfq_invitation` · `quotation` · `quotation_line` · `purchase_order` · `receipt` · `quality_check`                                                                               |
| **داخل نیست**    | سفارش خرده (نزد `marketplace`) · پروفایل تأمین‌کننده (نزد `supplier`) · انبار (نزد `inventory`)                                                                                                                                                        |
| **Commands**     | `SubmitDemandRequest` · `RunAggregation` · `IssueRFQ` · `SubmitQuotation` · `EvaluateQuotations` · `IssuePurchaseOrder` · `RecordReceipt` · `RecordQualityCheck`                                                                                       |
| **Queries**      | `GetDemandRequest` · `ListOpenAggregations` · `GetRFQ` · `CompareQuotations` · `GetPurchaseOrder`                                                                                                                                                      |
| **REST**         | `POST /demand-requests` · `GET /demand-requests` · `GET /aggregations` · `POST /aggregations/{id}/rfq` · `GET /rfqs/{id}` · `POST /rfqs/{id}/quotations` · `POST /rfqs/{id}/evaluate` · `POST /purchase-orders` · `POST /purchase-orders/{id}/receipt` |
| **Publishes**    | `DEMAND_SUBMITTED` · `DEMAND_AGGREGATED` · `RFQ_ISSUED` · `QUOTATION_SUBMITTED` · `QUOTATIONS_EVALUATED` · `PURCHASE_ORDER_ISSUED` · `GOODS_RECEIVED` · `QUALITY_CHECK_RECORDED`                                                                       |
| **Consumes**     | `SUPPLIER_QUALIFIED` · `ORGANIZATION_*`                                                                                                                                                                                                                |
| **Dependencies** | PostgreSQL · Kafka · Temporal (پنجره تجمیع، مهلت RFQ) · `supplier-service`                                                                                                                                                                             |
| **مرز امنیتی**   | پیشنهاد قیمت تا پایان مهلت **رمزنگاری‌شده در حالت سکون** و غیرقابل مشاهده حتی برای اپراتور.                                                                                                                                                            |
| **Scale**        | کم. تجمیع یک کار زمان‌بندی‌شده Temporal است.                                                                                                                                                                                                           |
| **Failure**      | افت آن نیازهای در انتظار را نگه می‌دارد؛ پنجره تجمیع پس از بازیابی اجرا می‌شود.                                                                                                                                                                        |

**الگوریتم تجمیع (پیاده‌سازی واقعی).** پنجره Temporal باز می‌شود → `DemandRequest`های هم‌SKU
و هم‌مشخصات گروه می‌شوند → اگر مجموع مقدار ≥ `minAggregationThreshold` باشد، `RFQ` صادر
می‌شود؛ در غیر این صورت به پنجره بعدی منتقل یا به `marketplace` ارجاع می‌شود.
هر سه پارامتر (طول پنجره، آستانه، سیاست انتقال) **پیکربندی سازمانی**اند.

---

## ۴٫۱۰ supplier-service

| بُعد             | مشخصات                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mission**      | فهرست باز و معیارمحور تأمین‌کنندگان، تعمیرگاه‌ها و پیمانکاران، با سابقه عملکرد قابل استناد.                                                                               |
| **مسئولیت‌ها**   | ثبت‌نام و احراز صلاحیت · حوزه تخصص · مجوزها · ظرفیت اجرایی · امتیاز عملکرد · سوابق تأخیر و اختلاف · تعلیق                                                                 |
| **مالکیت داده**  | `supplier` · `supplier_qualification` · `supplier_capability` · `supplier_license` · `performance_score` · `performance_event` · `suspension`                             |
| **داخل نیست**    | سفارش (نزد `marketplace`) · قرارداد (نزد `contract`) · کیف پول (نزد `economic`)                                                                                           |
| **Commands**     | `RegisterSupplier` · `SubmitQualification` · `ApproveQualification` · `RejectQualification` · `RecordPerformanceEvent` · `SuspendSupplier` · `ReinstateSupplier`          |
| **Queries**      | `GetSupplier` · `SearchSuppliers` · `GetPerformanceScore` · `ListQualifiedFor`                                                                                            |
| **REST**         | `POST /suppliers` · `GET /suppliers` · `GET /suppliers/{id}` · `POST /suppliers/{id}/qualifications` · `POST /suppliers/{id}/suspend` · `GET /suppliers/{id}/performance` |
| **Publishes**    | `SUPPLIER_REGISTERED` · `SUPPLIER_QUALIFIED` · `SUPPLIER_REJECTED` · `SUPPLIER_SUSPENDED` · `PERFORMANCE_SCORE_UPDATED`                                                   |
| **Consumes**     | `REVIEW_SUBMITTED` · `ORDER_COMPLETED` · `ORDER_DISPUTED` · `REPAIR_COMPLETED` · `CONTRACT_COMPLETED` · `CONTRACTOR_RATED` → همه برای محاسبه امتیاز                       |
| **Dependencies** | PostgreSQL · Kafka · OpenSearch · `document-service`                                                                                                                      |
| **مرز امنیتی**   | تأمین‌کننده پروفایل خود را می‌بیند و ویرایش می‌کند؛ **امتیاز عملکرد را نمی‌تواند تغییر دهد.**                                                                             |
| **Scale**        | کم. خواندن‌محور با Cache.                                                                                                                                                 |
| **Failure**      | افت آن ثبت‌نام جدید را می‌خواباند؛ خریدها با Replica محلی ادامه می‌یابند.                                                                                                 |

**فرمول امتیاز عملکرد Configurable است** (کیفیت، زمان، رضایت، اختلاف — با وزن قابل تنظیم).
سند محصول این را مبنای رتبه‌بندی جست‌وجو می‌داند.

---

## ۴٫۱۱ inventory-service

| بُعد             | مشخصات                                                                                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Mission**      | انبار مرکزی اتحادیه و رهگیری تحویل — از عرضه‌کننده تا کاربر نهایی.                                                                                                       |
| **مسئولیت‌ها**   | انبار (با موقعیت PostGIS) · موجودی و رزرو · حرکت موجودی · ماژول `logistics`: محموله، مسیر، رهگیری، شریک حمل                                                              |
| **مالکیت داده**  | `warehouse` · `stock_item` · `stock_movement` · `stock_reservation` · `shipment` · `shipment_leg` · `tracking_event`                                                     |
| **داخل نیست**    | تعریف کالا (نزد `marketplace`) · سفارش خرید (نزد `procurement`)                                                                                                          |
| **Commands**     | `CreateWarehouse` · `ReceiveStock` · `ReserveStock` · `ReleaseReservation` · `IssueStock` · `CreateShipment` · `RecordTrackingEvent` · `ConfirmDelivery`                 |
| **Queries**      | `GetStockLevel` · `ListMovements` · `GetShipment` · `TrackShipment` · `FindNearestWarehouse`                                                                             |
| **REST**         | `POST /warehouses` · `GET /warehouses` · `GET /stock` · `POST /stock/reservations` · `POST /shipments` · `GET /shipments/{id}/tracking` · `POST /shipments/{id}/deliver` |
| **Publishes**    | `STOCK_RECEIVED` · `STOCK_RESERVED` · `STOCK_RELEASED` · `STOCK_ISSUED` · `LOW_STOCK_DETECTED` · `SHIPMENT_CREATED` · `SHIPMENT_DISPATCHED` · `SHIPMENT_DELIVERED`       |
| **Consumes**     | `ORDER_CREATED` (رزرو) · `ORDER_CANCELLED` (آزادسازی) · `GOODS_RECEIVED` · `PURCHASE_ORDER_ISSUED`                                                                       |
| **Dependencies** | PostgreSQL + PostGIS · Kafka · Redis (قفل توزیع‌شده برای رزرو)                                                                                                           |
| **مرز امنیتی**   | موجودی انبار مرکزی فقط برای `UNION_ADMIN`. کاربر فقط محموله‌های خود را رهگیری می‌کند.                                                                                    |
| **Scale**        | نوشتن متوسط. **رزرو موجودی نیازمند قفل** — Redis Redlock + بررسی خوش‌بینانه در پایگاه داده.                                                                              |
| **Failure**      | افت آن رزرو را می‌خواباند → سفارش‌ها در Saga منتظر می‌مانند و پس از Timeout جبران می‌شوند.                                                                               |

---

## ۴٫۱۲ construction-service — «رستا عمران»

| بُعد             | مشخصات                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mission**      | چرخه کامل پروژه عمرانی از ثبت نیاز تا انتخاب پیمانکار و کنترل پیشرفت — **بدون ایجاد مرجع حقوقی جدید**.                                                                                                                                                                                                                                                                                 |
| **مسئولیت‌ها**   | پروژه و نیاز · **موافقت‌های پیکربندی‌شده** · اسناد مناقصه · انتشار (عمومی/محدود) · پرسش و پاسخ · دریافت پیشنهاد با **ثبت زمان دقیق** · ارزیابی چندمعیاره Configurable · انتخاب برنده · گزارش پیشرفت · **تصمیم ناوگان داخلی در برابر برون‌سپاری**                                                                                                                                       |
| **مالکیت داده**  | `project` · `project_need` · `approval` · `approval_policy` · `tender` · `tender_document` · `tender_qa` · `bid` · `bid_document` · `evaluation` · `evaluation_criteria` · `award` · `progress_report`                                                                                                                                                                                 |
| **داخل نیست**    | قرارداد و صورت‌وضعیت (نزد `contract`) · پروفایل پیمانکار (نزد `supplier`) · پرداخت (نزد `economic`)                                                                                                                                                                                                                                                                                    |
| **Commands**     | `CreateProject` · `SubmitNeed` · `RequestApproval` · `GrantApproval` · `RejectApproval` · `PrepareTenderDocument` · `PublishTender` · `SubmitBid` · `AnswerQuestion` · `EvaluateBids` · `AwardTender` · `SubmitProgressReport`                                                                                                                                                         |
| **Queries**      | `GetProject` · `ListProjects` · `GetTender` · `ListOpenTenders` · `GetBids` · `GetEvaluationMatrix` · `GetFleetVsOutsourcingAnalysis`                                                                                                                                                                                                                                                  |
| **REST**         | `POST /projects` · `GET /projects/{id}` · `POST /projects/{id}/approvals` · `POST /approvals/{id}/decision` · `POST /projects/{id}/tenders` · `POST /tenders/{id}/publish` · `GET /tenders` · `POST /tenders/{id}/bids` · `GET /tenders/{id}/bids` · `POST /tenders/{id}/evaluate` · `POST /tenders/{id}/award` · `POST /projects/{id}/progress` · `GET /projects/{id}/fleet-analysis` |
| **Publishes**    | `PROJECT_CREATED` · `APPROVAL_REQUESTED` · `APPROVAL_GRANTED` · `APPROVAL_REJECTED` · `TENDER_CREATED` · `TENDER_PUBLISHED` · `BID_SUBMITTED` · `BIDS_EVALUATED` · `TENDER_AWARDED` · `PROJECT_STARTED` · `PROJECT_PROGRESS_UPDATED` · `PROJECT_COMPLETED`                                                                                                                             |
| **Consumes**     | `SUPPLIER_QUALIFIED` / `SUPPLIER_SUSPENDED` · `CONTRACT_SIGNED` · `ASSET_*` و `AVAILABILITY_CHANGED` (تحلیل ناوگان)                                                                                                                                                                                                                                                                    |
| **Dependencies** | PostgreSQL + PostGIS · Kafka · **Temporal (گردش‌کار مناقصه)** · `supplier` · `fleet` · `document`                                                                                                                                                                                                                                                                                      |
| **مرز امنیتی**   | **بالاترین حساسیت.** پیشنهادها تا پایان مهلت **رمزنگاری‌شده** و غیرقابل مشاهده برای همه، از جمله اپراتور. هر تصمیم در Audit با مهر زمانی.                                                                                                                                                                                                                                              |
| **Scale**        | کم اما بلندمدت — یک مناقصه هفته‌ها طول می‌کشد. Temporal این را می‌سازد، نه Cron.                                                                                                                                                                                                                                                                                                       |
| **Failure**      | افت آن ثبت پیشنهاد جدید را می‌خواباند. **مهلت‌ها در Temporal‌اند و از دست نمی‌روند.**                                                                                                                                                                                                                                                                                                  |

**CONSTRAINT.** `ApprovalPolicy` و `EvaluationCriteria` **داده‌اند، نه کد**. هیچ مرجع تأیید و
هیچ وزن معیاری در کد Hard-Code نمی‌شود. `Tender.procurementNature` اجباری است و پیش از انتشار
توسط کارفرما تعیین می‌شود.

---

## ۴٫۱۳ contract-service

| بُعد             | مشخصات                                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Mission**      | پرونده قرارداد و صورت‌وضعیت — از امضا تا تسویه نهایی.                                                                                                                                                              |
| **مسئولیت‌ها**   | قرارداد و طرفین · مبلغ و مدت · ضمانت‌ها · شرایط پرداخت · Milestone · الحاقیه با سابقه · صورت‌وضعیت · کسورات · تأیید فنی و مالی                                                                                     |
| **مالکیت داده**  | `contract` · `contract_party` · `contract_document_ref` · `amendment` · `milestone` · `guarantee` · `statement` · `statement_line` · `deduction` · `statement_approval`                                            |
| **داخل نیست**    | مناقصه (نزد `construction`) · پرداخت واقعی (نزد `economic`) · فایل قرارداد (نزد `document`)                                                                                                                        |
| **Commands**     | `CreateContract` · `SignContract` · `AddAmendment` · `RecordGuarantee` · `SubmitStatement` · `ApproveStatementTechnical` · `ApproveStatementFinancial` · `RejectStatement` · `CloseContract`                       |
| **Queries**      | `GetContract` · `ListContracts` · `GetStatements` · `GetContractFinancialSummary`                                                                                                                                  |
| **REST**         | `POST /contracts` · `GET /contracts/{id}` · `POST /contracts/{id}/sign` · `POST /contracts/{id}/amendments` · `POST /contracts/{id}/statements` · `POST /statements/{id}/approvals` · `POST /contracts/{id}/close` |
| **Publishes**    | `CONTRACT_CREATED` · `CONTRACT_SIGNED` · `CONTRACT_AMENDED` · `STATEMENT_SUBMITTED` · `STATEMENT_APPROVED` · `STATEMENT_REJECTED` · `CONTRACT_COMPLETED`                                                           |
| **Consumes**     | `TENDER_AWARDED` (ایجاد پیش‌نویس قرارداد) · `PROJECT_PROGRESS_UPDATED` · `PAYMENT_COMPLETED`                                                                                                                       |
| **Dependencies** | PostgreSQL · Kafka · Temporal (چرخه تأیید صورت‌وضعیت) · `document-service`                                                                                                                                         |
| **مرز امنیتی**   | فقط طرفین قرارداد و اپراتور پلتفرم. تأیید فنی و مالی **باید توسط دو نقش متفاوت** انجام شود (تفکیک وظایف).                                                                                                          |
| **Scale**        | کم.                                                                                                                                                                                                                |
| **Failure**      | افت آن ثبت صورت‌وضعیت را می‌خواباند؛ چرخه‌های در جریان در Temporal حفظ می‌شوند.                                                                                                                                    |

**Invariant.** `Σ(مبلغ صورت‌وضعیت‌های تأییدشده) ≤ مبلغ قرارداد + Σ(الحاقیه‌ها)`.
نقض این، `BUSINESS_RULE_VIOLATION` است، نه هشدار.

---

## ۴٫۱۴ economic-service

> پنج ماژول با مرزبندی داخلی کامل: `wallet` · `ledger` · `payment` · `commission` · `reward`
> — به‌علاوه `transaction` (تعهدی که هر پنج‌تا رویش کار می‌کنند) و `settlement`
> (فرآیندی که ADR-031 حاکم بر آن است) و `shared`.
> تفصیل کامل در [`10-economic-architecture.md`](10-economic-architecture.md).
>
> **وضعیت (2026-08-29): IMPLEMENTED · TESTED · LIVE VERIFIED.**
>
> **مصرف رویداد، واقعی در برابر مستند (ADR-032).** فقط سه رویداد مصرف می‌شوند —
> `MAINTENANCE_APPROVED`، `USAGE_RECORDED` و `MAINTENANCE_COMPLETED` — چون فقط
> قرارداد این سه واقعاً تعریف شده است. `ORDER_*`، `STATEMENT_APPROVED`،
> `PURCHASE_ORDER_ISSUED` و `GOODS_RECEIVED` **موکول**اند: نبودِ تولیدکننده
> به‌تنهایی مانع نیست، اما نوشتن آن Handler‌ها یعنی این سرویس شکل Payload سرویس
> دیگری را اختراع کند. **هیچ Handler خالی‌ای برایشان وجود ندارد** — یک
> مصرف‌کننده که رویداد را می‌بلعد و کاری نمی‌کند، در `processed_event` رد
> می‌گذارد و دقیقاً شبیه یکی است که کار کرد.
>
> آنچه آن جریان‌ها لازم دارند از راه **API** در دسترس است، که همان چیزی است که
> `docs/08` § ۸٫۶ می‌خواهد: `OrderSagaWorkflow` مراحلش را به‌عنوان **Activity**
> صدا می‌زند، نه به‌عنوان رویداد.
>
> **و `MAINTENANCE_APPROVED` پول را حرکت نمی‌دهد** — یک تعهد
> `PENDING_SETTLEMENT` ثبت می‌کند، تا یک تعمیر واقعیِ تأییدشده به‌خاطر کیف پول
> خالی گم نشود. تسویه یک فرمان صریح است.

| بُعد             | مشخصات                                                                                                                                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Mission**      | تبدیل هر رویداد اقتصادی به ورودی دفتر کل قابل حسابرسی، و تسویه شفاف میان طرفین.                                                                                                                                                                                                                        |
| **مسئولیت‌ها**   | کیف پول و Hold/Release · **دفتر کل دوطرفه تغییرناپذیر** · تراکنش با Idempotency · Abstraction پرداخت · موتور کارمزد Rule-Based · موتور پاداش Rule-Based · تسویه                                                                                                                                        |
| **مالکیت داده**  | `wallet` · `wallet_hold` · `ledger_account` · `journal` · `ledger_entry` · `transaction` · `transaction_leg` · `payment_intent` · `commission_rule` · `commission` · `reward_rule` · `reward` · `reward_level` · `settlement`                                                                          |
| **داخل نیست**    | سفارش (نزد `marketplace`) · قرارداد (نزد `contract`) · هویت (نزد `identity`)                                                                                                                                                                                                                           |
| **Commands**     | `OpenWallet` · `TopUp` · `PlaceHold` · `ReleaseHold` · `RefundHold` · `PostJournal` · `ReverseJournal` · `AuthorizePayment` · `CapturePayment` · `ApplyCommission` · `GrantReward` · `SettleToProvider`                                                                                                |
| **Queries**      | `GetWallet` · `GetBalance` · `ListTransactions` · `GetJournal` · `GetLedgerEntries` · `GetTrialBalance` · `GetCommissionRevenue` · `GetRewardBalance`                                                                                                                                                  |
| **REST**         | `GET /wallets/me` · `POST /wallets/{id}/top-up` **(Idempotency-Key)** · `POST /transactions` **(Idempotency-Key)** · `GET /transactions/{id}` · `GET /transactions` · `GET /ledger/accounts/{id}/entries` · `GET /ledger/trial-balance` · `GET /commissions` · `GET /rewards/me` · `POST /settlements` |
| **Publishes**    | `WALLET_OPENED` · `FUNDS_HELD` · `FUNDS_RELEASED` · `PAYMENT_AUTHORIZED` · `PAYMENT_COMPLETED` · `PAYMENT_FAILED` · `COMMISSION_APPLIED` · `REWARD_GRANTED` · `REWARD_LEVEL_CHANGED` · `SETTLEMENT_COMPLETED` · `JOURNAL_POSTED`                                                                       |
| **Consumes**     | **واقعی:** `MAINTENANCE_APPROVED` · `USAGE_RECORDED` · `MAINTENANCE_COMPLETED`. **برنامه‌ریزی‌شده:** `STATEMENT_APPROVED` پس از تعریف Producer. اثرهای مالی سفارش با فرمان احراز‌شده از Temporal می‌آیند، نه Consumer رویداد (ADR-040).                                                                |
| **Dependencies** | PostgreSQL · Kafka · Redis (قفل کیف پول) · Temporal (Saga تسویه)                                                                                                                                                                                                                                       |
| **مرز امنیتی**   | **بالاترین.** هر عمل نیازمند Idempotency-Key. هر تغییر در Audit. **استانداری (`AUDITOR`) دسترسی ندارد** — فقط تجمیع در `analytics`.                                                                                                                                                                    |
| **Scale**        | نوشتن‌سنگین در `ledger_entry` → پارتیشن ماهانه، فقط الحاقی.                                                                                                                                                                                                                                            |
| **Failure**      | افت آن پرداخت را می‌خواباند. **هیچ داده مالی گم نمی‌شود** — Outbox و Saga تضمین می‌کنند.                                                                                                                                                                                                               |

---

## ۴٫۱۵ سرویس‌های پشتیبان

### notification-service (P0)

| بُعد            | مشخصات                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------- |
| **Mission**     | تبدیل رویداد دامنه به اعلان مناسب، در کانال درست، با احترام به تنظیمات کاربر.                        |
| **مالکیت داده** | `notification` · `notification_template` · `delivery_attempt` · `user_preference` · `channel_config` |
| **داخل نیست**   | تصمیم اینکه «چه اتفاقی مهم است» — آن در سرویس مبدأ است. اینجا فقط تحویل.                             |
| **REST**        | `GET /notifications` · `POST /notifications/{id}/read` · `GET /preferences` · `PUT /preferences`     |
| **Publishes**   | `NOTIFICATION_SENT` · `NOTIFICATION_FAILED`                                                          |
| **Consumes**    | **همه Topicهای دامنه.** نگاشت رویداد→قالب یک جدول پیکربندی است.                                      |
| **کانال‌ها**    | In-App (P0) · Email (P0، Mailpit در dev) · SMS (P1، **OPEN QUESTION** — ارائه‌دهنده) · Push (P2)     |
| **Failure**     | افت آن اعلان را به تأخیر می‌اندازد، نه از بین می‌برد (Kafka Offset حفظ می‌شود).                      |

### document-service (P0)

| بُعد            | مشخصات                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Mission**     | فراداده و کنترل دسترسی اسناد. **فایل هرگز در پایگاه داده نمی‌رود.**                                                                                    |
| **مالکیت داده** | `document` · `document_version` · `access_grant` · `virus_scan_result` — فایل در S3                                                                    |
| **REST**        | `POST /documents/upload-url` (URL امضاشده) · `POST /documents` · `GET /documents/{id}` · `GET /documents/{id}/download-url` · `DELETE /documents/{id}` |
| **Publishes**   | `DOCUMENT_UPLOADED` · `DOCUMENT_DELETED` · `VIRUS_DETECTED`                                                                                            |
| **مرز امنیتی**  | بررسی نوع واقعی محتوا (Magic Number، نه پسوند) · محدودیت اندازه · URL امضاشده کوتاه‌عمر (۵ دقیقه) · دسترسی سطح Object · فایل هرگز اجرا نمی‌شود         |
| **MVP → PROD**  | اسکن بدافزار در MVP یک Stub است که نتیجه را ثبت می‌کند؛ در Production ClamAV یا سرویس معادل. **OPEN QUESTION**                                         |

### audit-service (P0)

| بُعد            | مشخصات                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------ |
| **Mission**     | سابقه تغییرناپذیر «چه کسی، چه کرد، کِی، از کجا، با چه نتیجه‌ای».                           |
| **مالکیت داده** | `audit_event` — **فقط الحاقی**؛ بدون UPDATE و بدون DELETE                                  |
| **REST**        | `GET /audit-events` (فیلتر بر actor، resource، action، بازه) · `GET /audit-events/{id}`    |
| **Consumes**    | `rasta.audit.trail.v1` — همه سرویس‌ها اینجا می‌نویسند                                      |
| **مرز امنیتی**  | نوشتن فقط از Kafka (بدون API نوشتن). خواندن فقط `SYSTEM_ADMIN`، `UNION_ADMIN` و مالک منبع. |
| **Scale**       | فقط الحاقی، پارتیشن ماهانه. نگهداشت: **OPEN QUESTION** (پیش‌فرض موقت ۷ سال).               |
| **MVP → PROD**  | در Production زنجیره Hash برای اثبات دست‌نخوردگی افزوده می‌شود.                            |

### analytics-service (P1)

| بُعد            | مشخصات                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mission**     | Read Model داشبوردها و محاسبه **سه منطق اقتصادی** سند محصول.                                                                                 |
| **مالکیت داده** | `fact_order` · `fact_maintenance` · `fact_usage` · `fact_transaction` · `fact_project` · `kpi_snapshot` · **`baseline_metric`**              |
| **REST**        | `GET /dashboards/fleet` · `GET /dashboards/financial` · `GET /dashboards/construction` · `GET /dashboards/governance` (تجمیعی) · `GET /kpis` |
| **Consumes**    | همه Topicهای دامنه                                                                                                                           |
| **مرز امنیتی**  | **تنها سرویسی که `AUDITOR` به آن دسترسی دارد** — و فقط به Endpointهای تجمیعی.                                                                |
| **CONSTRAINT**  | KPIهای وابسته به خط مبنا تا پر شدن `baseline_metric` وضعیت `INSUFFICIENT_BASELINE` برمی‌گردانند — **نه صفر، نه تخمین.**                      |

---

## ۴٫۱۶ ماتریس وابستگی

`R` = فراخوانی REST همزمان · `E` = مصرف رویداد (ناهمزمان)

| از ↓ / به →      | ident | org | asset | fleet | maint | mkt | proc | supp | inv | cons | contr | econ |
| ---------------- | ----- | --- | ----- | ----- | ----- | --- | ---- | ---- | --- | ---- | ----- | ---- |
| **identity**     | —     | E   |       |       |       |     |      |      |     |      |       |      |
| **organization** |       | —   |       |       |       |     |      |      |     |      |       |      |
| **asset**        |       | E   | —     | E     | E     | E   |      |      |     | E    |       |      |
| **fleet**        |       | E   | E     | —     | E     |     |      |      |     |      |       |      |
| **maintenance**  |       | E   | E     | E     | —     |     |      | R    | E   |      |       | E    |
| **marketplace**  |       | E   |       |       |       | —   |      | E    | E   |      |       | E    |
| **procurement**  |       | E   |       |       |       |     | —    | R,E  | E   |      |       |      |
| **supplier**     |       | E   |       |       | E     | E   | E    | —    |     | E    | E     |      |
| **inventory**    |       | E   |       |       |       | E   | E    |      | —   |      |       |      |
| **construction** |       | E   | R,E   | R,E   |       |     |      | R,E  |     | —    | E     |      |
| **contract**     |       | E   |       |       |       |     |      | E    |     | E    | —     | E    |
| **economic**     |       | E   |       | E     | E     | E   |      |      |     |      | E     | —    |

**بدون وابستگی دوری همزمان.** هر جا حلقه‌ای دیده می‌شود (`construction ↔ contract`)، یک جهت
REST و جهت دیگر Event است — یعنی حلقه زمانی وجود ندارد.

---

## ۴٫۱۷ فازبندی

| فاز                       | سرویس‌ها                                                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0 — Day 10 Demo**      | gateway · identity · organization · asset · fleet · maintenance · marketplace · economic · construction · contract · document · audit · notification |
| **P1 — MVP کامل**         | procurement · supplier · inventory · analytics + تکمیل ماژول‌های reward، insurance registry، logistics و لجستیک معکوس پایه                           |
| **P2 — Day 30 Hardening** | بدون سرویس جدید. امنیت، تست، کارایی، پایایی، مستندسازی.                                                                                              |
| **P3 — پس از MVP/Pilot**  | iot-telematics · استخراج‌های مشروط ADR-044 · بیمهٔ تجاری کامل · Marketplace عمومی · اتصال ملی                                                        |
