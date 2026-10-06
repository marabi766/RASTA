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
| **مرز امنیتی**   | ساخت ریشه، جابه‌جایی و تغییر وضعیت فقط `SYSTEM_ADMIN`. بقیه — `UNION_ADMIN` هم (Q-80) — فقط سازمان خود و زیردرختش را می‌خوانند و می‌نویسند؛ بیرون از آن `404`.                                                               |
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
| **Consumes**     | `USAGE_RECORDED` · `MAINTENANCE_COMPLETED` · `PROJECT_ASSET_ASSIGNED` → همه برای ساخت `asset_timeline` (`ORDER_COMPLETED` نه: دارایی نام نمی‌برد، docs/07 § 7.6) · `ORGANIZATION_*` → Replica مرجع                                                                                    |
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

**اعلام در دسترس بودن و انتقال دارایی.** هر دارایی یک اعلام زنده دارد (قفل هر دارایی + ایندکس یکتای جزئی؛ docs/06 § ۶٫۸).
fleet رونوشت `asset_ref` را از رویداد می‌سازد و وابستگی همگام به asset-service ندارد، پس میان Commit انتقال در asset-service و
اعمال `ASSET_TRANSFERRED` در fleet یک **فاصلهٔ تأخیر** هست که در آن مالک قبلی هنوز می‌تواند اعلام بدهد یا بازپخش ذخیره‌شده بگیرد.
بستن آن همین‌جاست و بیشتر نیست: با اعمال رویداد، اعلام‌های سازمان قبلی از `transferredAt` به بعد باطل می‌شوند (علت سیستمی
ثبت‌شده) و از آن لحظه اعلام و بازپخش او `404` است. آنچه در فاصله پذیرفته شد، تا اعمال رویداد دیده می‌شود.

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
| **Consumes**     | از `rasta.marketplace.v1`: `ORDER_CREATED` · `ORDER_FULFILLED` · `REVIEW_SUBMITTED` · `ORDER_DISPUTE_RESOLVED` · `ORDER_CANCELLED` · `ORDER_COMPLETED` (ADR-052 گام ۵)    |
| **Dependencies** | PostgreSQL · Kafka · OpenSearch · `document-service`                                                                                                                      |
| **مرز امنیتی**   | تأمین‌کننده پروفایل خود را می‌بیند و ویرایش می‌کند؛ **امتیاز عملکرد را نمی‌تواند تغییر دهد.**                                                                             |
| **Scale**        | کم. خواندن‌محور با Cache.                                                                                                                                                 |
| **Failure**      | افت آن ثبت‌نام جدید را می‌خواباند؛ خریدها با Replica محلی ادامه می‌یابند.                                                                                                 |

**فرمول امتیاز عملکرد Configurable است** (کیفیت، زمان، رضایت، اختلاف — با وزن قابل تنظیم).
سند محصول این را مبنای رتبه‌بندی جست‌وجو می‌داند.

**وزن‌ها تصویب شدند (Q-12، 2026-09-07 — [ADR-052](adr/ADR-052-supplier-performance-scoring.md)):**
کیفیت ۳۰٪ · تحویل/تکمیل به‌موقع ۲۵٪ · رضایت مشتری ۲۰٪ · نبودِ اختلاف معتبر ۱۵٪ ·
نبودِ لغو منتسب ۱۰٪. وزن‌ها نسخه‌دارند و مجموع نسخهٔ فعال دقیقاً ۱۰۰٪ است.

**تصمیم پذیرفته شد؛ امتیازی محاسبه نمی‌شود.** ذخیره‌سازی (گام‌های ۲ تا ۴) و Consumer رویدادهای
marketplace (گام ۵) پیاده شده‌اند؛ موتور محاسبه (گام ۶)، Endpoint امتیاز و `PERFORMANCE_SCORE_UPDATED` نه — وضعیت هر گام
در [برنامهٔ پیاده‌سازی ADR-052](adr/ADR-052-implementation-plan.md).

**در 2026-09-07، ۸۰٪ وزن تولیدکننده نداشت.** از پنج مؤلفه فقط «رضایت مشتری» از
`REVIEW_SUBMITTED` قابل محاسبه بود؛ کیفیت هیچ سیگنالی نداشت، «به‌موقع بودن» هیچ
تاریخ وعده‌ای در هیچ رویدادی نداشت، `ORDER_DISPUTED` فقط طرح اختلاف بود (رویداد
حل وجود نداشت) و `ORDER_CANCELLED` انتساب ساخت‌یافتهٔ مسئولیت نداشت. ADR-052 § ۲
این را با شواهد کد ثبت کرده و تا عبور پوشش از ۵۰٪، انتشار هیچ عددی را ممنوع
می‌کند.

**امروز (2026-09-27) ۷۰٪ وزن تولیدکننده دارد.** marketplace سه سیگنال کم‌شده را
منتشر می‌کند (ADR-052 گام ۱-الف تا ۱-پ): `promisedDeliveryAt` روی `ORDER_CREATED`،
رویداد `ORDER_DISPUTE_RESOLVED` با `responsibility` در enum بسته، و
`cancellationCause` روی `ORDER_CANCELLED`. کیفیت (۳۰٪، گام ۱-ت) هنوز هیچ سیگنالی
ندارد و پرسش محصول باز است. تولیدکننده داشتن یعنی واقعیت ثبت‌شدنی است، نه اینکه
عددی محاسبه می‌شود: موتور (گام ۶) منتظر پاسخ Q-77 تا Q-79 است.

### وضعیت پیاده‌سازی — فاز ۱

جدول بالا طراحی کامل سرویس است. آنچه واقعاً پیاده شده کمتر از آن است، و تفاوت
عمدی است:

| قابلیت                                                           | وضعیت                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RegisterSupplier` · پروفایل و حوزه تخصص                         | ✅ پیاده                                                                                                                                                                                                                                                                                                                              |
| `SubmitQualification` + ارجاع مدرک (شناسه مبهم)                  | ✅ پیاده                                                                                                                                                                                                                                                                                                                              |
| `ApproveQualification` · `RejectQualification`                   | ✅ پیاده — تصمیم انسانی صریح، با ثبت کنشگر و زمان                                                                                                                                                                                                                                                                                     |
| `SuspendSupplier` · `ReinstateSupplier`                          | ✅ پیاده — تعلیق **نگه می‌دارد**، باطل نمی‌کند؛ بازگردانی تصمیم تازه لازم ندارد                                                                                                                                                                                                                                                       |
| `SearchSuppliers` · `ListQualifiedFor` · `GetSupplier`           | ✅ پیاده — فهرست عمومی میان‌مستأجری با Projection ایمن                                                                                                                                                                                                                                                                                |
| `SUPPLIER_REGISTERED` · `QUALIFIED` · `REJECTED` · `SUSPENDED`   | ✅ پیاده — Outbox (ADR-050) + تخصیص ترتیب ADR-051 B3 روی `supplierId`                                                                                                                                                                                                                                                                 |
| ذخیره‌سازی عملکرد: پیکربندی وزن · `performance_event` · Snapshot | ✅ پیاده (ADR-052 گام‌های ۲ تا ۴، #120) — الحاقی و تغییرناپذیر. هیچ Snapshotی نوشته نمی‌شود: نویسندهٔ آن موتور گام ۶ است.                                                                                                                                                                                                             |
| `GetPerformanceScore` · موتور امتیاز · `performance_score`       | ❌ **پیاده نشد.** Q-12 در 2026-09-07 بسته شد ([ADR-052](adr/ADR-052-supplier-performance-scoring.md))؛ موتور (گام ۶) منتظر پاسخ Q-77، Q-78 و Q-79 است و API خواندنی (گام ۷) پس از آن.                                                                                                                                                 |
| `PERFORMANCE_SCORE_UPDATED`                                      | ❌ **منتشر نمی‌شود** — رویدادی برای عددی که وجود ندارد. طراحی‌اش در ADR-052 گام ۸ آمده.                                                                                                                                                                                                                                               |
| `supplier_license`                                               | ❌ **مدل نشد.** مجوز مرجع صادرکننده، دورهٔ اعتبار و قاعدهٔ تمدید دارد و سند محصول هیچ‌یک را نام نمی‌برد.                                                                                                                                                                                                                              |
| مصرف ۶ رویداد امتیازدهی (`RecordPerformanceEvent`)               | ✅ پیاده، **به‌طور پیش‌فرض خاموش** (ADR-052 گام ۵، § ۲۵) — Consumer `supplier-service.performance` روی `rasta.marketplace.v1` فقط واقعیت ثبت می‌کند؛ علامت `processed_event` با اثر در یک تراکنش (ADR-032). روشن‌کردنش تا احراز Broker (RUN-006) در راه‌اندازی رد می‌شود — `docs/23` D-036. تا 2026-09-26 هیچ Consumerی ثبت نشده بود. |
| `document-service` (بررسی مدرک)                                  | ❌ Port ای وجود ندارد؛ شناسه مدرک هرگز Resolve نمی‌شود. Integration Handoff.                                                                                                                                                                                                                                                          |
| OpenSearch                                                       | ❌ استفاده نمی‌شود؛ جست‌وجوی متن آزاد و مرتب‌سازی بر اساس امتیاز وجود ندارد.                                                                                                                                                                                                                                                          |

یک تأییدیه **نمی‌گوید** مدرکی واکشی، باز، اسکن یا معتبر تشخیص داده شده است؛
می‌گوید یک اپراتور پلتفرمِ نام‌برده در زمانی مشخص یک درخواست را تأیید کرده است.

---

## ۴٫۱۱ inventory-service

| بُعد             | مشخصات                                                                                                                                                                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mission**      | انبار و رهگیری تحویل — از عرضه‌کننده تا کاربر نهایی. یک انبار می‌تواند نزد هر نوع سازمانی باشد (اتحادیه، شرکت، سازمان دولتی یا ملی)؛ مالکیت از `ownerOrganizationId` می‌آید، نه از یک فرض ساختاری تک‌مالکی (ADR-056 § ۵).                          |
| **مسئولیت‌ها**   | انبار (با موقعیت PostGIS) · موجودی و رزرو · حرکت موجودی · ماژول `logistics`: محموله، مسیر، رهگیری، شریک حمل                                                                                                                                        |
| **مالکیت داده**  | `warehouse` · `stock_item` · `stock_movement` · `stock_reservation` · `shipment` · `shipment_leg` · `tracking_event`                                                                                                                               |
| **داخل نیست**    | تعریف کالا (نزد `marketplace`) · سفارش خرید (نزد `procurement`)                                                                                                                                                                                    |
| **Commands**     | `CreateWarehouse` · `ReceiveStock` · `ReserveStock` · `ReleaseReservation` · `IssueStock` · `CreateShipment` · `RecordTrackingEvent` · `ConfirmDelivery`                                                                                           |
| **Queries**      | `GetStockLevel` · `ListMovements` · `GetShipment` · `TrackShipment` · `FindNearestWarehouse`                                                                                                                                                       |
| **REST**         | `POST /warehouses` · `GET /warehouses` · `GET /stock` · `POST /stock/reservations` · `POST /shipments` · `GET /shipments/{id}/tracking` · `POST /shipments/{id}/deliver`                                                                           |
| **Publishes**    | `STOCK_RECEIVED` · `STOCK_RESERVED` · `STOCK_RELEASED` · `STOCK_ISSUED` · `LOW_STOCK_DETECTED` · `SHIPMENT_CREATED` · `SHIPMENT_DISPATCHED` · `SHIPMENT_DELIVERED`                                                                                 |
| **Consumes**     | `ORDER_CREATED` (رزرو) · `ORDER_CANCELLED` (آزادسازی) · `GOODS_RECEIVED` · `PURCHASE_ORDER_ISSUED`                                                                                                                                                 |
| **Dependencies** | PostgreSQL + PostGIS · Kafka                                                                                                                                                                                                                       |
| **مرز امنیتی**   | خواندن/نوشتن موجودی یک انبار: عضویت در `warehouse.ownerOrganizationId` + نقش پیکربندی‌شدهٔ آن سازمان (نه یک نقش سراسری تنها). کاربر فقط محموله‌هایی را رهگیری می‌کند که گیرنده یا مالک انبار مبدأش باشد. مرز کامل و آزمون‌های منفی در ADR-056 § ۵. |
| **Scale**        | نوشتن متوسط. **رزرو موجودی با قفل ردیف PostgreSQL** (`SELECT ... FOR UPDATE`، ترتیب صعودی `stock_item.id`) در همان تراکنش که مانده را به‌روز می‌کند — نه Redis Redlock.                                                                            |
| **Failure**      | افت آن رزرو را می‌خواباند → سفارش‌ها در Saga منتظر می‌مانند و پس از Timeout جبران می‌شوند.                                                                                                                                                         |

> **اصلاح 2026-09-17 (ADR-056).** این جدول پیش‌تر «انبار مرکزی اتحادیه» و «فقط
> `UNION_ADMIN`» نوشته بود — یک فرض تک‌مالکی که با اصل Organization-Agnostic
> (ADR-012) در تناقض بود — و رزرو موجودی را به Redis Redlock وابسته کرده بود،
> بدون آنکه چنین تغییر Stack ای ADR داشته باشد. ADR-056 هر دو را با سه ستون
> مالکیت/دارندگی/گیرندگی مستقل و قفل ردیف PostgreSQL جایگزین کرد؛ ردیف‌های
> Mission، مرز امنیتی، Dependencies و Scale بالا با آن ADR اصلاح شدند. ردیف
> `Consumes` (`ORDER_CREATED`/`ORDER_CANCELLED`) هنوز طراحی هدف است، نه رفتار
> امروز: ADR-041 § ۲ و ADR-056 § ۷ هر دو ثبت کرده‌اند که این مصرف‌کننده هنوز
> فعال نشده — گام `RESERVE_STOCK` در Saga سفارش `DEFERRED` می‌ماند.

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
| **مرز امنیتی**   | **بالاترین حساسیت.** پیشنهادها در حالت سکون **رمزنگاری‌شده** و تا بازگشایی صریح از راه API برای هیچ نقشی دیدنی نیستند؛ هر خواندن حسابرسی می‌شود و از هر پیشنهاد Hash تعهد ثبت می‌شود (ADR-066). اپراتور پلتفرم از نظر رمزنگاری بیرون نیست (D-043). هر تصمیم در Audit با مهر زمانی.                                                                                                     |
| **Scale**        | کم اما بلندمدت — یک مناقصه هفته‌ها طول می‌کشد. Temporal این را می‌سازد، نه Cron.                                                                                                                                                                                                                                                                                                       |
| **Failure**      | افت آن ثبت پیشنهاد جدید را می‌خواباند. **مهلت‌ها در Temporal‌اند و از دست نمی‌روند.**                                                                                                                                                                                                                                                                                                  |

**CONSTRAINT.** `ApprovalPolicy` و `EvaluationCriteria` **داده‌اند، نه کد**. هیچ مرجع تأیید و
هیچ وزن معیاری در کد Hard-Code نمی‌شود. `Tender.procurementNature` اجباری است و پیش از انتشار
توسط کارفرما تعیین می‌شود.

### وضعیت پیاده‌سازی — CON-001، PR نخست (2026-09-26)

اسکلت سرویس و دو چرخهٔ عمر `Project` و `ProjectNeed` ساخته شد؛ ماشین حالت صریح پایگاه داده با گذار Compare-and-Set و
رویداد Outbox در همان تراکنش، بی Temporal ([ADR-063](adr/ADR-063-construction-lifecycles-and-approval-policy-ownership.md)).
Endpointها: `POST/GET /v1/projects`، `GET/PATCH /v1/projects/{id}`، `POST /v1/projects/{id}/cancel` و
`/v1/projects/{id}/needs[/{needId}[/submit|/withdraw]]`. رویدادها: `PROJECT_CREATED` و شش رویداد افزوده
(`docs/events/README.md` § Construction). فیلدهای پروژه و نقش‌ها پاسخ موقت Q-68 و Q-69‌اند.

**PR دوم CON-001 (2026-09-26):** موافقت‌های پیکربندی‌شده (`/v1/approval-policies`، `/v1/approvals`،
`/v1/projects/{id}/approvals`)، آغاز (`/start`)، گزارش پیشرفت (`/progress`) و پایان با تأیید فنی نهایی پیکربندی‌پذیر
(`/complete`)؛ نبود سیاست = ۴۲۲، بی هیچ Timer (ADR-063 § Implementation notes).
سیاست را `UNION_ADMIN` برای سازمان خودش یا زیرمجموعه می‌نویسد و `SYSTEM_ADMIN` پیش از حاکم‌شدن تأیید می‌کند (Q-70
بند ۷، تصمیم مالک 2026-09-26)؛ تنها وابستگی هم‌زمان این سرویس، پرسش سلسله‌مراتب از `organization-service` هنگام نوشتن
سیاست است (`GET /v1/organizations/{id}` با توکن داخلی؛ پاسخ فقط `{ id }` یا `404`؛ هر پاسخ دیگر رد).

**CON-002 (در دست اجرا، 2026-09-30).** طراحی در ADR-065 (چرخهٔ مناقصه/پیشنهاد و مهلت؛ جاروکننده پیش از Temporal)، ADR-066 (محرمانگی پیشنهاد)
و ADR-067 (ارزیابی و تعارض منافع)؛ پرسش‌ها Q-84 تا Q-90؛ قرارداد API در
[`docs/api/construction-service.tender.planned.openapi.json`](api/construction-service.tender.planned.openapi.json) (طرح، نه رفتار امروز).
**وابستگی:** فقط `SUPPLIER_QUALIFIED`/`SUPPLIER_SUSPENDED` از COM-005 (که هنوز `IN_PROGRESS` است).

**CON-002 PR 2 (هستهٔ مناقصه).** `Tender` Aggregate جدا با ماشین حالت پایگاه داده (هفت حالت، همه در enum؛ فقط `DRAFT` و `CANCELLED` قابل‌دسترس):
`POST /v1/projects/{id}/tenders` (فقط زیر پروژهٔ `APPROVED`)، `GET /v1/tenders[/{id}]`، `PATCH /v1/tenders/{id}` (فقط `DRAFT`) و
`POST /v1/tenders/{id}/cancel`. نقش‌ها همان نقش‌های پروژه‌اند (Q-69). پروژه‌ای که مناقصهٔ تمام‌نشده دارد لغو نمی‌شود (`422`).
انتشار، پیشنهاد، ارزیابی و انتخاب گام‌های بعدی‌اند.

**CON-002 PR 4a (معیارهای ارزیابی).** قالب معیار نسخه‌دار و تغییرناپذیر (`POST/GET /v1/criteria-templates[/{id}]`؛ همان برچسب دوباره = نسخهٔ بعدی) و
معیارهای مناقصه (`PUT/GET /v1/tenders/{id}/criteria`): از قالب کپی یا صریح نوشته می‌شود، کل فهرست جایگزین می‌شود (CAS روی نسخهٔ مناقصه)، وزن‌ها
به Basis Point و مجموعشان حداکثر ۱۰۰۰۰؛ با انتشار دقیقاً ۱۰۰۰۰ لازم است (PR 4b). پس از `DRAFT` معیارها **در پایگاه داده** قفل‌اند (Trigger؛ تهدید C3).
هیچ وزن یا معیاری در کد نیست و پلتفرم قالبی نمی‌دهد. Gateway پیشوند `criteria-templates` را از یافتهٔ #223 F1 به این سرویس
می‌رساند (بسته، بی نقش در لبه، کلید Idempotency اختیاری مثل خود سرویس)؛ پیش از آن این مسیرها فقط در خود سرویس پاسخ می‌دادند.

**CON-002 PR 4b (انتشار و دعوت).** `POST /v1/tenders/{id}/publish` (`DRAFT → PUBLISHED`): ماهیت و دید انتخاب‌شده (بی پیش‌فرض)، بازهٔ دریافت
(حداقل بازهٔ پیکربندی‌پذیر، پیش‌فرض ۰؛ **بسته‌نشده با ساعت پایگاه داده**)، معیارهایی که دقیقاً ۱۰۰۰۰ Basis Point جمع می‌شوند، و برای مناقصهٔ
محدود دست‌کم یک دعوت — همهٔ دلیل‌های رد یک‌جا در پیام `422`. با انتشار جفت‌کلید مناقصه ساخته و کلید خصوصی‌اش **فقط پیچیده** با KEK ذخیره می‌شود
(`tender_key`؛ هرگز حذف نمی‌شود و بخش عمومی‌اش تغییر نمی‌کند)؛ بی KEK پیکربندی‌شده هیچ مناقصه‌ای منتشر نمی‌شود (`503`). دعوت:
`POST/GET /v1/tenders/{id}/invitations` (فقط `RESTRICTED`؛ خود کارفرما دعوت نمی‌شود؛ سازمان دعوت‌شده باید در organization-service وجود
داشته باشد و در نبود تأیید `503`، پس هیچ دعوتِ تأییدنشده‌ای ثبت نمی‌شود؛ صلاحیتِ پیشنهاد در زمان پیشنهاد سنجیده می‌شود). **دروازهٔ موافقت
`tender.publication` (Q-84، گام ۱۱):** بی سیاست فعال `422 APPROVAL_POLICY_REQUIRED`؛ با سیاست فعال `POST /publish` درخواستی می‌سازد که به مناقصه
و نسخه‌اش بسته است و پاسخش `202` است، و همان فرمان وقتی درخواست تصویب شد (و مناقصه عوض نشده — وگرنه `409 APPROVAL_STALE`) منتشر می‌کند و موافقت را
در همان تراکنش یک‌بار مصرف می‌کند. زمان انتشار و رویداد، لحظهٔ پایگاه داده **پس از قفل** است. بازگشت مهاجرت (`down.sql`) تا وقتی کلید مناقصه‌ای
یا دعوتی هست رد می‌شود.

**CON-002 PR 5 (وضعیت پیمانکار).** مدل خواندنی از رویدادهای supplier-service روی `rasta.supplier.v1` (گروه
`construction-service.supplier-standing`): `SUPPLIER_QUALIFIED` فقط وقتی `CONTRACTING` در `qualifiedFor` باشد،
`SUPPLIER_SUSPENDED`/`SUPPLIER_REINSTATED` به‌ازای شناسهٔ دورهٔ تعلیق. هر نوشتن جابه‌جاپذیر و تکرارپذیر است (بیشینهٔ زمان تأیید؛
پر شدن هر نیمهٔ دوره حداکثر یک بار)، پس ترتیب و بازپخش پاسخ را عوض نمی‌کند. سازمانِ ناشناخته **واجد شرایط نیست** (بستهٔ
شکست‌پذیر)؛ محتوای نامعتبر یا شناسهٔ دوره‌ای از سازمان دیگر به صف مرده می‌رود. وابستگی COM-005 فقط
`SUPPLIER_QUALIFIED`/`SUSPENDED` است (تصمیم ۳). مصرف‌کننده: گام ۶ (پیشنهاد).
**Bootstrap (بازبینی Codex روی #170):** گروه مصرف‌کننده از انتهای لاگ هفت‌روزه شروع می‌کند، پس آنچه پیش از آن بوده فقط از
`supplier-service` خوانده می‌شود: `GET /v1/suppliers/standing-snapshot` (`@AllowService('construction-service')`، توکن بی مستأجر، صفحه‌بندی با
Cursor؛ هر سازمانِ دارای تأیید `CONTRACTING` یا دورهٔ تعلیق، با شناسه و لحظه‌ها، بی هیچ متن). `construction-service` پس از شروع مصرف‌کننده آن را به
همان شکل هم‌گرا در دو جدول می‌نویسد و نشانگر `standing_bootstrap` را ثبت می‌کند؛ **تا آن‌گاه هر پرسش صلاحیت `STANDING_NOT_LOADED` است**
(Fail Closed). Snapshot و رویداد زنده با هم تکرارپذیرند. **این مدل خواندنی مشورتی است (بازبینی دور دوم Codex):** برای فهرست و UI است، نه منبع تصمیم؛
چون پس از قطعی بلندتر از نگه‌داشت لاگ (هفت روز) تعلیقِ منقضی‌شده را نمی‌بیند، و تعلیقی که در `supplier-service` Commit شده ولی Outbox هنوز
نرسانده را هم. **صلاحیت برای پیشنهاد تصمیمی قطعی است:** هنگام ثبت، `construction-service` وضعیت همان یک پیمانکار را با
`GET /v1/suppliers/standing-snapshot/{organizationId}` (همان `@AllowService` و توکن بی مستأجر) از `supplier-service` می‌پرسد (بیرون از
تراکنش و قفل مناقصه) و اگر در دسترس نبود `503/504` می‌دهد، یعنی Fail Closed (`StandingAuthority`). همین مسیر، بازسازی پس از `down.sql` است
(`docs/runbooks/contractor-standing-bootstrap.md`).

**CON-002 PR 6 (پیشنهاد).** سمت پیمانکار (نقش `CONTRACTOR` در سازمان خودش؛ نه `SYSTEM_ADMIN` و نه `AUDITOR`): `GET /v1/open-tenders[/{id}]`
(عمومی یا دعوت‌شده، هرگز مناقصهٔ خودش)، `POST /v1/tenders/{id}/bids`، `PUT .../bids/{bidId}` (`revision` + ۱)، `POST .../withdraw`،
`GET .../bids/mine`. محتوا (قیمت رشتهٔ ریالی، پاسخ هر معیار، یادداشت) هنگام ثبت با کلید عمومی مناقصه **مهر** می‌شود و هیچ‌جا خوانده
نمی‌شود؛ پاسخ فقط رسید است. **مهلت با ساعت پایگاه داده پس از قفل ردیف مناقصه** سنجیده می‌شود (`TenderClock`؛ بازهٔ نیم‌باز:
در لحظهٔ `bidClosingAt` رد)، و Trigger `bid_guard` همان را در پایگاه داده نگه می‌دارد. **صلاحیت پیمانکار در زمان ثبت** از `supplier-service` (تصمیم مرجع،
نه مدل خواندنیِ مشورتی) پرسیده می‌شود، ناروشن = رد (`BIDDER_NOT_ELIGIBLE` / `503`)، و لحظهٔ پرسش با هر ویرایش ثبت می‌شود
(`bid_receipt.eligible_as_of`؛ `award` موقعیت جاری را دوباره می‌سنجد، ADR-067). زنجیرهٔ رسید الحاقی و سرِ تازه روی رویداد می‌رود و
**`audit-service`** آن را (با پیوستگی‌سنجی، نگه‌داشتن تحویل نامرتب و خواندن مستأجرمحور) بیرون از پایگاه داده نگه می‌دارد (ADR-066 § ۲)؛ **هر خواندن پیشنهاد**
(رد شده هم) یک ردیف `bid_access_log` (الحاقی) و `BID_ACCESSED` در همان تراکنش می‌نویسد و نوشتن ناموفق، خواندن را ناموفق می‌کند.
Gateway پیشوند `open-tenders` را نیز از یافتهٔ #223 F1 به این سرویس می‌رساند (بسته، فقط خواندنی)؛ پیمانکار مناقصه را از همین‌جا پیدا می‌کند
و هرچه نتواند بر آن پیشنهاد دهد — از جمله مناقصهٔ محدودی که دعوت نشده — `404` است. در سمت کارفرمای پیشنهادها (بازگشایی، خواندن،
دفتر دسترسی) مالکیت **پیش از نقش** سنجیده می‌شود: کاربر سازمان دیگر، هر نقشی داشته باشد، همان `404` مناقصهٔ ناموجود را می‌گیرد و `403`
فقط به عضو سازمان مالک داده می‌شود (#223 F3، ADR-066 § ۴). این قاعدهٔ `404` برای **کاربر شناخته‌شدهٔ پلتفرم** است: توکنی که شناسهٔ کاربر
پلتفرم (`rasta_uid`) ندارد، پیش از آنکه هیچ مناقصه‌ای جست‌وجو شود، در هر مسیری که ثبت یا مقایسه می‌کند چه کسی عمل کرده
(`@RequirePlatformUserId()`، پیش‌شرط احراز هویت، #188؛ از جمله پیشنهاد، بازگشایی و پس‌گرفتن پیشنهاد بازگشایی) با `403` رد می‌شود —
برای مناقصهٔ خودش، سازمان دیگر یا ناموجود یکسان (`api-open-bids.int-spec.ts`).
**CON-002 PR 8 (بازگشایی).** سمت کارفرما (نقش‌های `CONSTRUCTION_TENDER_OPEN_ROLES`، پیش‌فرض همان مجموعهٔ نقش‌های مالک؛ نه
`SYSTEM_ADMIN`، `AUDITOR`، توکن سرویس یا عضو سازمانِ یکی از پیشنهاددهندگان): `POST /v1/tenders/{id}/open-bids`،
`GET .../bids`، `GET .../bids/{bidId}`، `GET .../bid-access-log`. بازگشایی **فقط پس از `CLOSED`** است (ساعت پایگاه داده پس از قفل؛ مناقصهٔ
هنوز `PUBLISHED`، حتی پس از مهلت، `422 NOT_CLOSED` می‌گیرد — بستن کار جاروکننده است). زنجیرهٔ رسید و سر را **از `audit-service`** می‌خواند
(توکن امضاشده برای سازمان مالک؛ نه از جدول این سرویس)، با زنجیرهٔ محلی سنجیده می‌شود (`compareChains`) و هر پیشنهاد با **همان**
رسیدها با `openBid` باز می‌شود. در دسترس‌نبودن یا عقب‌بودن `audit-service` ⇒ `503/504`، ناهماهنگی یا جعل ⇒ `422 INTEGRITY`؛ در همه‌شان
هیچ‌چیز باز نمی‌شود. کلید خصوصی فقط در حافظهٔ همان فراخوانی باز و صفر می‌شود. `BIDS_OPENED` فقط شمار و Digest شناسه‌ها دارد (کران‌دار)؛ **هر بازگشایی و هر
خواندن** (از جمله ردشده) `bid_access_log` و `BID_ACCESSED` دارد. بازگشایی Idempotent است (بار دوم همان نما با `alreadyOpened`، بی‌رویداد).
پیش از بازگشایی کارفرما فقط شمار و مهر زمان دریافت را می‌بیند. **چهارچشمی برای بازگشایی** (Q-91، موقت تا تأیید صاحب محصول): بازگشایی به پیشنهاد یک کاربر مجاز و تأیید کاربر دوم نیاز دارد، هیچ‌کدام عضو سازمان پیشنهاددهنده نیست؛
`CONSTRUCTION_TENDER_OPEN_FOUR_EYES` (پیش‌فرض روشن؛ خاموش فقط در `development` و `test`). **هنگام تأیید** عضویت _فعلی_ هر دو نفر (پیشنهاددهنده
و تأییدکننده) دوباره از `identity-service` (`GET /v1/users/{id}/organizations`، فقط `construction-service`، توکن بی‌مستأجر) خوانده می‌شود، نه آنچه هنگام
پیشنهاد بود؛ ناخوانا بودن ⇒ `502/504` و هیچ‌چیز باز نمی‌شود (`IDENTITY_SERVICE_URL`، `CONSTRUCTION_IDENTITY_REQUEST_TIMEOUT_MS`). خودِ پیشنهاد هم
یک ردیف `bid_access_log` و `BID_ACCESSED` (هدف `PROPOSE_OPENING`، بی `bidId`) در همان تراکنش می‌گذارد. بررسی تعارض منافع **پیش از** هر پاسخی دربارهٔ
وضعیت مناقصه (`NOT_CLOSED`/`NOT_OPENED`) انجام می‌شود. `down.sql` مهاجرت تا وقتی بازگشایی یا پیشنهادی در انتظار ثبت شده باشد رد می‌کند.
**عضویت خواننده در هر مسیر سمت کارفرما** (فهرست و خواندن پیشنهاد، لاگ دسترسی، بازگشایی تکراری، پیشنهاد و پس‌گرفتن) از عضویت زندهٔ identity
(ساعت پایگاه‌دادهٔ identity) سنجیده می‌شود (Fail Closed؛ `identity_unavailable`، هشدار): پاسخ identity مرجع است و توکن فقط می‌تواند محدود کند، نه بیفزاید —
باید عضویت زندهٔ سازمان کارفرما با نقش مجاز بازگشایی در کار باشد و نقش‌های ممنوع (`SYSTEM_ADMIN`، `CONTRACTOR`، `AUDITOR`: یک فهرست برای توکن و برای نقش زنده) را نداشته باشد، وگرنه (مدیرِ ابطال‌شده با توکن هنوز معتبر) رد می‌شود. پیشنهاددهنده می‌تواند پیشنهادش را پس بگیرد
(`POST /v1/tenders/{id}/open-bids/proposal/withdraw`)، و تأییدی که او را عضو پیشنهاددهنده بیابد رد می‌کند و پیشنهاد را پاک می‌کند. **باقیماندهٔ مستند** (بدون قفل
میان‌سرویسی؛ ADR-066 § ۴): پس از Commit بازگشایی، عضویت دو نفر در بازهٔ زودترین خواندن identity در تأیید/لحظهٔ تصمیم تا پاسخ (`GET …/organizations?from=`) دوباره پرسیده می‌شود؛ تضاد ⇒ هشدار
بحرانی و `BID_OPENING_CONFLICT_DETECTED`.

**CON-002 PR 9 (ارزیابی).** ارزیابانِ کارفرما (نقش‌های `CONSTRUCTION_TENDER_EVALUATE_ROLES`، پیش‌فرض همان مجموعهٔ نقش‌های مالک؛ **همان** فهرست ممنوع‌های بازگشایی:
`SYSTEM_ADMIN`، `AUDITOR`، `CONTRACTOR`، توکن سرویس): `POST /v1/tenders/{id}/bids/{bidId}/qualification` (`OPENED → QUALIFIED | DISQUALIFIED`، یک‌بار و نهایی؛
رد با دلیل بستهٔ `reasonCode` و متن که فقط در پایگاه داده می‌ماند)، `POST …/recusal` (کناره‌گیری از یک پیشنهاد، نهایی)، `POST …/scores` (امتیاز عددصحیح = نمره × ۱۰۰ به‌ازای معیار)، `POST /v1/tenders/{id}/evaluate`
(`EVALUATING → EVALUATED`)، `GET /v1/tenders/{id}/evaluation` (ماتریس و رتبه‌بندی). **وزن‌ها و بیشینهٔ نمره از معیارهای منجمدشدهٔ همان مناقصه می‌آید؛ هیچ وزن یا معیاری در کد نیست.**
جمع هر ارزیاب `Σ weightBp × scoreScaled` به‌صورت `bigint` است (رشته در API)، بی تقسیم و بی گرد کردن؛ رتبه = ۱ + شمار پیشنهادهای **اکیداً** بهتر و تساوی رتبهٔ مشترک می‌گیرد؛ **رتبهٔ نخست انتخاب نیست**
(`award` گام ۱۰ است). ثبت **الحاقی** است (بازبینی = ردیف تازه با `revision`، ماتریس آخرین بازبینی هر خانه)؛ هر چهار جدول (`bid_qualification`، `bid_evaluation`، `bid_evaluation_recusal`،
`bid_evaluation_score`) با Trigger الحاقی‌اند و **فقط وقتی مناقصه `EVALUATING` است** پذیرفته می‌شوند، پس ماتریس پس از `evaluate` برای هیچ نویسنده‌ای تغییر نمی‌کند؛ Trigger همچنین بازهٔ نمره، توالی بازبینی،
معیارِ همان مناقصه و کناره‌گیری را در پایگاه داده نگه می‌دارد و `bid.status` را فقط با تصمیم ثبت‌شده به `QUALIFIED/DISQUALIFIED` می‌برد. هر فرمان قفل `FOR UPDATE` ردیف مناقصه را می‌گیرد و لحظه را **پس از قفل** از ساعت پایگاه داده می‌خواند؛
یک امتیاز که پشت `evaluate` منتظر مانده مناقصه را `EVALUATED` می‌یابد و `422 NOT_EVALUATING` می‌گیرد. هر تغییر، رویداد خود را در همان تراکنش دارد (`BID_QUALIFIED`/`BID_DISQUALIFIED`، `BID_SCORED`، `BID_EVALUATOR_RECUSED`، `BIDS_EVALUATED`) و یک ردیف
`bid_access_log` با `BID_ACCESSED`. **تعارض منافع (ADR-067 § ۴):** هویت فعلی ارزیاب از identity (Fail Closed) و عضو **هر** سازمان پیشنهاددهنده (حتی پس‌گرفته‌شده) در **هر** مسیر ارزیابی `403 CONFLICT_OF_INTEREST` می‌گیرد، پیش از هر پاسخی دربارهٔ
مناقصه؛ `CONSTRUCTION_COI_RULES` (پیش‌فرض خالی) `EVALUATOR_NOT_TENDER_AUTHOR` (سازندهٔ یا منتشرکنندهٔ مناقصه) را روشن می‌کند و `AWARDER_NOT_EVALUATOR` را برای `award` ثبت می‌کند. **هر رد روی مناقصهٔ سازمانِ خودِ بازیگر ممیزی می‌شود** (مالکیت اول: مناقصهٔ ناموجود یا سازمان دیگر ⇒ `404` بی ثبت و بی رویداد، برای هر نقش؛ مسیرها نقشی را در نگهبان سراسری نام نمی‌برند و تصمیم در سرویس است): ردیف `REFUSED` با ستون تازهٔ
`refusal_code` (کد بسته) و `BID_ACCESSED.refusalCode`. `qualification` با `QUALIFIED` وضعیت جاری پیمانکار را از `supplier-service` می‌پرسد (Q-85؛ بیرون از قفل، Fail Closed؛ ناواجد ⇒ `422 BIDDER_NOT_ELIGIBLE`، و می‌توان رد کرد).
تعداد ارزیاب (`CONSTRUCTION_EVALUATION_MIN_EVALUATORS`/`_MAX_EVALUATORS`، پیش‌فرض ۱ و ۱ — MVP ADR-067)، تجمیع چند ارزیاب (میانگین دقیق با ضرب متقاطع) و فهرست دلیل‌های بسته **پاسخ موقت‌اند، Q-92**. `evaluate` وقتی مجاز است که دست‌کم یک پیشنهاد `QUALIFIED`
باشد، هر `QUALIFIED` به‌اندازهٔ حداقل ارزیاب امتیاز کامل داشته باشد و پیشنهاد `OPENED` تصمیم‌نگرفته نمانده باشد؛ صفر `QUALIFIED` ⇒ `422 NO_QUALIFIED_BID` (فقط ابطال؛ با دروازهٔ ابطال، گام ۱۱).
**پیمانکار پیشنهاد خودش را پس از بازگشایی می‌خواند:** `GET /v1/tenders/{id}/bids/mine/opened` (نقش `CONTRACTOR`؛ مسیر هیچ شناسهٔ پیشنهادی نمی‌گیرد، پس پیشنهاد پیمانکار دیگر در دسترس نیست): محتوایی که مهر کرده، با
رسیدهای `audit-service` سنجیده (`BidContentReader`، همان بررسی خواندن مالک: در دسترس‌نبودن ⇒ `503/504`، ناهماهنگی ⇒ `422 INTEGRITY`)، وضعیت، تصمیم (فقط کد دلیلِ رد) و — فقط پس از `EVALUATED` — جمع خودش و بیشینهٔ ممکن، بی رتبه و بی پیشنهاددهندهٔ
دیگر (Q-89). هر خواندن، granted یا refused، `BID_ACCESSED` (`OWN_BID_CONTENT`) با نتیجه دارد. `down.sql` مهاجرت تا وقتی هر دادهٔ ارزیابی هست رد می‌کند.

**CON-002 PR 10 (انتخاب برنده).** `POST /v1/tenders/{id}/award` (نقش‌های `CONSTRUCTION_TENDER_AWARD_ROLES`، پیش‌فرض همان مجموعهٔ نقش‌های مالک؛ **همان** فهرست ممنوع‌های بازگشایی و ارزیابی،
هویت زنده از identity و `403 CONFLICT_OF_INTEREST` برای عضو هر سازمان پیشنهاددهنده): **یک انسان** یک پیشنهاد `QUALIFIED` را از مناقصهٔ `EVALUATED` برمی‌گزیند (`EVALUATED → AWARDED`)؛ سیستم رتبه می‌دهد و نمی‌گزیند. هر انتخابی
جز رتبهٔ نخستِ بی‌تساوی `justification` می‌خواهد (`422 JUSTIFICATION_REQUIRED`؛ متن فقط در پایگاه داده، رویداد فقط `hasJustification`). **شایستگی برنده در لحظهٔ `award` دوباره از `supplier-service` پرسیده می‌شود**
(Q-85، ADR-067 § ۳؛ مرجع و Fail Closed؛ بیرون از قفل مناقصه): ناواجد یا معلق ⇒ `422 WINNER_NOT_ELIGIBLE` و ردیف ممیزی، در دسترس‌نبودن ⇒ `503/504`؛ **جایگزینیِ خودکار با رتبهٔ بعدی نیست** (Q-93): مناقصه `EVALUATED` می‌ماند و
انسان می‌تواند پیشنهاد `QUALIFIED` دیگری را بنامد. مبلغ برنده از محتوای مهرشدهٔ همان پیشنهاد و با رسیدهای `audit-service` خوانده می‌شود، در `tender_award` می‌ماند و **روی هیچ رویدادی نمی‌آید** (Topic مشترک است): `GET /v1/tenders/{id}/award` آن را به شخص مجاز مالک و به `contract-service` (توکن داخلی برای سازمان مالک) می‌دهد و هر خواندن ممیزی است (`READ_AWARD`) (`BidContentReader`؛ ناهماهنگی ⇒ `422 INTEGRITY`، در دسترس‌نبودن ⇒ `503/504`) و
خواندنش مثل هر خواندن پیشنهاد ممیزی می‌شود (`AWARD_TENDER`). تراکنش یکی است و زیر قفل `FOR UPDATE` مناقصه با لحظهٔ ساعت پایگاه داده **پس از قفل**: ردیف `tender_award` (الحاقی؛ یکی برای هر مناقصه: پیشنهاد، سازمان برنده، `amount_minor` به `bigint`،
رتبه و تساوی، Digest ماتریس منجمد، دلیل، `standing_as_of`، و فاعل با `awarded_by_issuer`/`awarded_by_subject` — جفتِ تهی‌پذیر، هر دو یا هیچ)، مناقصه `AWARDED`، پیشنهاد برنده `AWARDED`، هر `QUALIFIED` دیگر `NOT_AWARDED`، `TENDER_AWARDED`، یک `BID_NOT_AWARDED` به‌ازای هر بازنده
(فقط شناسه‌ها و لحظه؛ نه برنده، نه مبلغ، نه رتبه — Q-89؛ بازندگان را فقط رویداد خبر می‌دهد و notification-service تغییر نکرده) و `BID_ACCESSED`. پایگاه داده همین را نگه می‌دارد: Trigger درج `tender_award` مناقصه را `FOR SHARE` قفل می‌کند و فقط برای مناقصهٔ `EVALUATED` و پیشنهاد `QUALIFIED` همان
مناقصه می‌پذیرد، مناقصه و پیشنهادها فقط با ردیف `tender_award` به `AWARDED`/`NOT_AWARDED` می‌روند، و Constraint Trigger معوق اجازه نمی‌دهد ردیف بدون هر دو Commit شود؛ پس دو `award` هم‌زمان یکی است و دیگری `409`، و نوشتن ارزیابی دیرهنگام (هر نویسنده‌ای) ماتریس منجمد را تغییر نمی‌دهد.
**بررسی کشفی پس از Commit (ماندگار):** قفل میان‌سرویسی نیست، پس ردیفی `tender_award_standing_check` در همان تراکنشِ انتخاب نوشته می‌شود (پایگاه داده انتخاب بی آن را Commit نمی‌کند) و جاروکنندهٔ `AwardStandingCheckSweeper` (Lease و Fence، Backoff؛ `CONSTRUCTION_AWARD_CHECK_*`) شایستگی برنده را دوباره می‌پرسد و بازهٔ «لحظهٔ خواندن پیش از انتخاب تا ساعت supplier-service» را می‌سنجد؛ تعلیق یا برداشته‌شدن صلاحیت در بازه ⇒ ردیف `DONE/CONFLICT` و `TENDER_AWARD_STANDING_CONFLICT_DETECTED` (فقط شناسه) در یک Commit و هشدار بحرانی `RastaConstructionAwardStandingConflictDetected`؛ انتخاب پس گرفته نمی‌شود؛ بررسی‌ای که انجام نمی‌شود با Gauge و هشدار `RastaConstructionAwardStandingCheckOverdue` دیده می‌شود. پاسخ `award` منتظر آن نیست (runbook: `award-standing-conflict`). همان `award` دوباره خودش را پاسخ می‌دهد (`alreadyAwarded`) و چیزی نمی‌نویسد و نمی‌پرسد. `AWARDER_NOT_EVALUATOR` (`CONSTRUCTION_COI_RULES`، **پیش‌فرض روشن و سخت‌گیر** — حکم مدیر پروژه 2026-10-03؛ مقدار تهی همهٔ قواعد اختیاری را خاموش می‌کند): انتخاب‌کننده نباید کسی باشد که در ارزیابی تصمیم گرفته، امتیاز داده، کناره گرفته یا آن را کامل کرده —
`403 AWARDER_IS_EVALUATOR`، یا `422 ACTOR_IDENTITY_UNKNOWN` وقتی سوابق نشان نمی‌دهند دو شناسه دو نفرند؛ افراد با `compareActors` (#188) و هویتی که ردیف‌های ارزیابی ثبت کرده‌اند مقایسه می‌شوند؛ مسیر `@RequirePlatformUserId()` دارد. **دروازهٔ موافقت (Q-84، گام ۱۱):** `award` بی سیاست فعال `tender.award` `422 APPROVAL_POLICY_REQUIRED` می‌دهد؛ با سیاست فعال درخواستی می‌سازد که به
مناقصه و نسخه، پیشنهاد، رتبه، توجیه، چکیدهٔ ماتریس و وضعیت برنده بسته است (`202`) و پس از تصویب (تصویب‌کننده زیر قواعد تعارض منافع انتخاب‌کننده است و
هرگز درخواست‌دهنده نیست) همان فرمان، پس از پرسش دوبارهٔ صلاحیت برنده، انتخاب را می‌نویسد و موافقت را مصرف می‌کند. `down.sql` مهاجرت تا وقتی هر انتخابی هست رد می‌کند.
**`projectId` در پاسخ `award` (افزودنی، برای CON-003):** `GET /v1/tenders/{id}/award` (برای شخص مالک و `contract-service`) و پاسخ `POST …/award` اکنون `projectId` را از مناقصهٔ ذخیره‌شده می‌دهند (هرگز از درخواست)؛ `contract-service` آن را با `projectId` رویداد `TENDER_AWARDED` می‌سنجد و ناهمخوانی را نمی‌پذیرد.

**CON-002 — دلیل بستهٔ امتناع در `details` (#227).** هر امتناع construction که دلیل بسته دارد (انتشار، دعوت، پیشنهاد، بازگشایی، ارزیابی،
انتخاب، موافقت، ابطال) آن را در `details[]` بدنهٔ خطا می‌آورد، با همان الگوی identity و asset (docs/06 § ۶٫۷):
`{ "path": "<حوزه>", "code": "<دلیل>", "message": "<پیشوند حوزه>: <دلیل>" }`، یک ورودی برای هر دلیل (انتشار ممکن است چند دلیل داشته باشد).
`path` حوزه است (`publication`، `invitation`، `bid`، `opening`، `evaluation`، `award`، `approval`، `cancellation`)، نه میدانی از بدنهٔ درخواست.
`code` سطح بالا و `message` تغییر نکرده‌اند (سازگار با گذشته). فقط کدهای فهرست‌های بستهٔ همان حوزه می‌آیند؛ نه شناسه، نه متن آزاد، نه `internalContext` (S-09).
امتناع بی‌دلیل بسته (گذار نامعتبر ماشین حالت، نقش، ۵xx) اصلاً `details` ندارد. فهرست بستهٔ هر مسیر به تفکیک وضعیت در OpenAPI به‌صورت enum آمده است.
امتناعِ عضو سازمان پیشنهاددهنده در بازگشایی اکنون `details` با `opening:CONFLICT_OF_INTEREST` دارد، ولی `refusal_code` ردیف ممیزی‌اش همچنان `FORBIDDEN` است.
ابطال با `NO_QUALIFIED_BID` نابجا، دلیل خودش را می‌گوید: `cancellation:REASON_CODE_NOT_APPLICABLE` (پیام همچنان با `NO_QUALIFIED_BID` آغاز می‌شود).

**هنوز نیست:** پیوست مدارک و تصویر پیشرفت (Q-72)؛ E2E و مستندات گام ۱۲ — CON-002 (دروازه‌های موافقت انتشار، انتخاب و ابطال، و ابطال `NO_QUALIFIED_BID`، با گام ۱۱ بالا آمد)؛ قرارداد — CON-003؛
تحلیل ناوگان؛ هیچ Consumer رویدادی.

**رابطه با `organization_policy`.** منبع حقیقت موافقت‌های پروژه جدول `approval_policy` همین سرویس است (ADR-063).
کلیدهای `approval.*` در `organization_policy` (`organization-service`) **هیچ موافقتی را برای پروژه الزامی یا مجاز
نمی‌کنند** و این سرویس آن‌ها را نمی‌خواند؛ پر کردنشان سیاست پروژه نمی‌سازد (Q-70).

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

> **وضعیت (2026-10-05): CON-003 PR 1 — فقط اسکلت و پیش‌نویس** ([ADR-068](adr/ADR-068-contract-lifecycle-and-boundary.md)؛ Q-95..Q-97).
> پورت ۳۱۱۱. پیاده‌شده: جدول `contract`، Consumer `TENDER_AWARDED` (پیش‌نویس `DRAFT` یکتا به‌ازای هر مناقصه؛ **مبلغ از خواندن احرازشدهٔ
> `GET /v1/tenders/{id}/award` از `construction-service` می‌آید، نه از رویداد**؛ خواندن ناموفق = بی قرارداد)، رویداد `CONTRACT_DRAFTED`،
> و `GET /v1/contracts[/{id}]` (کارفرما و پیمانکار برنده؛ هر سازمان دیگر `404`). **ساخته نشده:** امضا، الحاقیه، Milestone، صورت‌وضعیت، کسورات،
> تأیید فنی و مالی، تسویه، مسیر Gateway.
>
> **CON-003 PR 2 — امضا و لغو پیش‌نویس** (ردیف‌های `DRAFT → SIGNED` و `DRAFT → CANCELLED` در ADR-068 § ۲؛ Q-95 همچنان باز):
>
> - `POST /v1/contracts/{id}/sign` (`Idempotency-Key`): هر طرف **جدا** و با هویت پایدار امضاکننده (`compareActors`، #188) ثبت می‌شود؛ قرارداد فقط با
>   امضای **دوم** `SIGNED` می‌شود (CAS روی `version` با `organization_id` در گزاره). اختیار امضای کارفرما **سیاست `contract.signature` سازمان خود او** است
>   (جدول `approval_policy` همین سرویس؛ نه فهرست نقش در محیط اجرا که برای همهٔ کارفرمایان معتبر می‌شد): بدون سیاستِ برقرار ⇒ `422 SIGNATURE_POLICY_REQUIRED`؛ شناسه و نسخهٔ سیاست روی امضا ثبت می‌شود؛
>   امضای پیمانکار نقش `CONTRACTOR` در سازمان خودش است.
>   تفکیک وظایف (بسته در شکست): عضو هر دو سازمان `403 MEMBER_OF_BOTH_PARTIES`؛ یک شخص برای دو طرف `403 SAME_PERSON_BOTH_SIDES`؛ هویت ناشناخته `422 ACTOR_IDENTITY_UNKNOWN`؛ امضای دوباره‌ی همان طرف `409 SIDE_ALREADY_SIGNED`.
>   هر امضا یک رکورد حسابرسی و رویداد `CONTRACT_SIGNATURE_RECORDED` و امضای دوم `CONTRACT_SIGNED` (هر دو بی مبلغ) در همان تراکنش.
> - `POST /v1/contracts/{id}/cancel` (`Idempotency-Key`): فقط کارفرما (`CONTRACT_CANCEL_ROLES`)، فقط `DRAFT`، با کد دلیل از فهرست بستهٔ
>   `CONTRACT_CANCEL_REASON_CODES` و یادداشت اختیاری (متن آزاد، حداکثر ۱۰۰۰ نویسه، بی نویسهٔ کنترل دوسویه)؛ رویداد `CONTRACT_CANCELLED` فقط کد دلیل را دارد.
>   **پس از یک امضا لغو نمی‌شود** (`422 SIGNATURE_RECORDED`) مگر `CONTRACT_CANCEL_AFTER_SIGNATURE=true` — پاسخ محتاطانهٔ موقت برای Q-95 (۴).
> - سازمان دیگر ⇒ `404` مثل نبودن؛ `AUDITOR` و توکن سرویس رد می‌شوند؛ دلیل هر رد در `details[].code`. **ساخته نشده:** مسیر Gateway، الحاقیه، Milestone، صورت‌وضعیت، تسویه.
> - **سیاست‌های تأیید (`/v1/approval-policies`، ADR-068 § ۵، همان سازوکار `construction-service`، Q-70 (۷)):** پیش‌نویس را `UNION_ADMIN` برای سازمان خود یا سازمانِ زیردستش می‌نویسد
>   (سلسله‌مراتب را `organization-service` تأیید می‌کند؛ پاسخ ناتأییدشده نوشتن را رد می‌کند) یا `SYSTEM_ADMIN` برای هر سازمانِ موجود؛ `ORGANIZATION_ADMIN` هرگز سیاست خودش را نمی‌نویسد.
>   `DRAFT → PENDING_PLATFORM_APPROVAL → ACTIVE | REJECTED`، و `ACTIVE → RETIRED`؛ فقط `SYSTEM_ADMIN` برقرار می‌کند و **هرگز نویسنده یا ارسال‌کنندهٔ همان سیاست** (چهار چشم، روی هویت پایدار؛ سیاستِ نوشتهٔ اتحادیه حتی با خاموش‌بودن
>   `CONTRACT_POLICY_FOUR_EYES` به‌دست همان شخص تأیید نمی‌شود). سیاست یک‌بار نوشته می‌شود و ویرایش نمی‌شود (پایگاه داده نگه می‌دارد)؛ تغییر یعنی نسخهٔ تازه که در تراکنش تأیید، نسخهٔ پیشین را بازنشسته می‌کند.
>   برای `contract.signature` هر گام یک نقش از **همان سازمانِ تحت پوشش** است (جایگزین‌ها، نه ترتیب)؛ `AUDITOR` و `SYSTEM_ADMIN` هرگز مرجع نیستند. **تعلیق هنگام `ORGANIZATION_MOVED` (Q-83، همان سازوکار `construction-service`؛ دور دوم بازبینی #231):** سیاستِ `ACTIVE` یا `PENDING_PLATFORM_APPROVAL` که اتحادیه‌ای نوشته، با خارج‌شدن کارفرما از زیرمجموعهٔ آن اتحادیه به‌دست سیستم `SUSPENDED` می‌شود (هرگز احیا نمی‌شود؛ نسخهٔ تازه همان مسیر نوشتن/ارسال/تأیید را می‌رود). گروه `contract-service.organization-moves` روی `rasta.organization.v1` فقط کار پایگاه داده می‌کند (برای هر سیاست یک وظیفه در صف پایدار `policy_reconciliation_task`)؛ پاروبِ پس‌زمینه پاسخ سلسله‌مراتب را از `organization-service` می‌پرسد و تعلیق می‌کند (`APPROVAL_POLICY_SUSPENDED`). **اما مرجع، لحظهٔ امضاست:** `sign` زیر قفل جایگاه سیاست از سلسله‌مراتب می‌پرسد که نویسندهٔ سیاست هنوز کارفرما را اداره می‌کند؛ «نه» ⇒ `403 POLICY_AUTHOR_NOT_GOVERNING` (و سیاست تعلیق می‌شود)، «نتوانستم تأیید کنم» ⇒ `503/504` و هیچ امضایی ثبت نمی‌شود. سیاستِ نوشتهٔ `SYSTEM_ADMIN` به سلسله‌مراتب وابسته نیست.
>
> **تفاوت عمدی با جدول بالا (ADR-068، پذیرفتنش با مدیر پروژه):**
>
> - `POST /contracts` / `CreateContract` **باز نمی‌شود:** قرارداد فقط از `TENDER_AWARDED` می‌آید؛ قرارداد بی مناقصه سند و منبعی برای مبلغش ندارد (Q-95).
> - `CONTRACT_CREATED` (با `amount` و `parties[]`) جایش را به **`CONTRACT_DRAFTED`** (بی مبلغ؛ Topic مشترک است و audit همه‌چیز را می‌خواند) می‌دهد.
> - **بی Temporal:** گذارها ماشین حالت پایگاه داده‌اند و هیچ مهلتی تأییدی نمی‌سازد (ADR-043)؛ ردیف «Temporal» در Dependencies تا PR 5 اجرا نمی‌شود.
> - **جهت تسویه برعکس `docs/08` § ۸٫۵:** `contract-service` پول حرکت نمی‌دهد و `economic.createPayment` را صدا نمی‌زند؛ تأیید مالی `STATEMENT_APPROVED` را (فقط شناسه) می‌نویسد و economic تعهد را از REST احرازشدهٔ contract می‌کشد (ADR-068 § ۶، Q-97).
> - تأیید فنی و مالی دو **زنجیرهٔ جدا** با سیاست قابل‌پیکربندی‌اند (نه مرجع، نرخ یا آستانهٔ سخت‌کد؛ Q-96).

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
| **ADR**         | [ADR-054](adr/ADR-054-notification-service-delivery.md) — `Proposed`، پیاده نشده.                    |

> **CONSTRAINT.** «Email (P0، Mailpit در dev)» بالا یک **Adapter توسعه** را توصیف می‌کند، نه یک مسیر تحویل واقعی.
> **هیچ ارائه‌دهندهٔ ایمیل Production و هیچ هویت فرستنده‌ای انتخاب نشده است** — [Q-37](24-open-questions.md). این
> انتشار ایمیل واقعی را مسدود می‌کند، نه پیاده‌سازی را و نه نیمهٔ In-App را. Mailpit پشت Profile های `tools`/`all`
> است و `pnpm infra:up` بالا نمی‌آوردش.

### document-service (P0)

| بُعد             | مشخصات                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Mission**      | فراداده و کنترل دسترسی اسناد. **فایل هرگز در پایگاه داده نمی‌رود.**                                                                                    |
| **مالکیت داده**  | `document` · `document_version` · `access_grant` · `virus_scan_result` — فایل در S3                                                                    |
| **REST**         | `POST /documents/upload-url` (URL امضاشده) · `POST /documents` · `GET /documents/{id}` · `GET /documents/{id}/download-url` · `DELETE /documents/{id}` |
| **Publishes**    | `DOCUMENT_UPLOADED` · `DOCUMENT_SCANNED` · `DOCUMENT_DELETED` · `VIRUS_DETECTED`                                                                       |
| **مرز امنیتی**   | بررسی نوع واقعی محتوا (Magic Number، نه پسوند) · محدودیت اندازه · URL امضاشده کوتاه‌عمر (۵ دقیقه) · دسترسی سطح Object · فایل هرگز اجرا نمی‌شود         |
| **اسکن بدافزار** | **ClamAV** خودمیزبان به‌صورت Sidecar، ناهمزمان (ADR-049). سند `PENDING` ثبت می‌شود و تنها یک `CLEAN` معتبر دانلود را مجاز می‌کند. Q-18 بسته شد.        |

### audit-service (P0)

> **وضعیت پیاده‌سازی — 2026-09-08 (AUD-001).** فقط **مسیر A** ساخته شده: گروه `audit-service.domain-projector` روی ده Topic
> دامنه‌ای، با `fromBeginning: true`، که به‌ازای هر Envelope یک ردیف `audit_event` می‌نویسد. جدول ماهانه بر `occurred_at`
> پارتیشن‌بندی شده (۱۸ ماه + `DEFAULT`) و فقط‌الحاقی است در دو لایه: Schema `audit` را نقش `rasta_audit_migrator` مالک است و
> `rasta_audit` فقط `SELECT` و `INSERT` دارد، به‌علاوهٔ Triggerهای `BEFORE UPDATE OR DELETE` و `BEFORE TRUNCATE` روی والد و
> **روی هر پارتیشن** (PostgreSQL Trigger سطح‌جمله را به پارتیشن‌ها Clone نمی‌کند).
>
> **افزودهٔ 2026-09-09 (AUD-002) — API خواندنِ مستأجر-امن.** `GET /v1/audit-events` و `GET /v1/audit-events/{id}` پشت
> `AuthGuard` و `RolesGuard` سراسری. `from`/`to` اجباری‌اند و پنجره سقف پیکربندی‌شده دارد
> (`AUDIT_MAX_QUERY_WINDOW_DAYS`، پیش‌فرض ۹۰)؛ بیش از آن `400 VALIDATION_FAILED` است که حد را نام می‌برد، **پیش از اجرای هر
> Query**. صفحه‌بندی Cursor (پیش‌فرض ۲۵، حداکثر ۲۰۰) بر `occurredAt DESC, id DESC`؛ Cursor مبهم است و **هیچ دامنه‌ای حمل
> نمی‌کند** — دامنه در هر درخواست از Token تأییدشده بازمحاسبه می‌شود. خواندن یک رکورد خارج از دامنه همان `404` شناسهٔ ناموجود
> را می‌گیرد.
>
> زیردرختِ `UNION_ADMIN` از یک Projection محلی تصمیم گرفته می‌شود که `organization_ref` را با
> `parent_organization_id`، `status` و `relation_state` گسترش می‌دهد (Migration افزایشی
> `20260909093000_audit_org_hierarchy_projection`) و از `ORGANIZATION_CREATED` / `_MOVED` / `_STATUS_CHANGED` روی
> `rasta.organization.v1` پر می‌شود. تصمیم از **پیوند والد** گرفته می‌شود نه از مسیر ذخیره‌شده — یک جابه‌جایی، مسیرِ هر فرزند
> را کهنه می‌کند و کهنگی در جهت گسترش، همان چیزی است که ADR-053 § ۱۰ ممنوع می‌کند. رابطهٔ غایب، ناشناخته یا شکسته **هرگز**
> نتیجه را گسترده نمی‌کند.
>
> **افزودهٔ 2026-09-10 (AUD-003، نیمهٔ شواهد دست‌نخوردگی) — پیاده و روی PostgreSQL واقعی اثبات‌شده.** `record_hash` و
> `previous_hash` اکنون در همان تراکنشِ درج نوشته می‌شوند:
> `recordHash = SHA256( canonical(record بدون میدان‌های Hash) || previousHash )`، با دامنهٔ **یک زنجیره به‌ازای
> `(organizationId, ماه UTC)`** و یک زنجیرهٔ جدا برای ردیف‌های بدون مستأجر. جدول تازهٔ `audit_chain_head` (Migration افزایشی
> `20260910120000_audit_chain_head`) نوکِ هر زنجیره را نگه می‌دارد؛ نویسنده آن را با `FOR UPDATE` قفل می‌کند و `sequence_no`
> را زیر همان قفل می‌کشد، پس ترتیب Sequence با ترتیب زنجیره یکی است. Trigger `audit_chain_head_forward_only` عقب بردن Head،
> تغییر هویت و پرش طول را رد می‌کند، و `first_sequence_no` **یک بار** نوشته و از آن پس تغییرناپذیر می‌شود.
>
> `GET /v1/audit-events/verify` یک بازه از **یک** زنجیره را بازمحاسبه می‌کند و نخستین واگرایی را برمی‌گرداند. چهار وضعیت:
> `VALID`، `EMPTY`، `UNVERIFIABLE_LEGACY` (پنجره ردیف پیش از AUD-003 دارد — هرگز Backfill نمی‌شود و هرگز `valid` نیست) و
> `DIVERGENT` با شش دلیل: `RECORD_HASH_MISMATCH`، `PREVIOUS_HASH_MISMATCH`، `MISSING_CHAIN_LINK`، `CHAIN_HEAD_MISMATCH`،
> `CHAIN_TAIL_MISSING`، `CHAIN_LENGTH_MISMATCH`. `scope=PLATFORM` فقط `SYSTEM_ADMIN` است و یک `SYSTEM_ADMIN` که مستأجری را
> تأیید می‌کند باید نامش را ببرد، چون زنجیره‌ای که چند مستأجر را بپوشاند وجود ندارد. سقف دوم `AUDIT_MAX_VERIFICATION_RECORDS`
> (پیش‌فرض ۱۰۰۰۰۰) روی بازهٔ **پیوستهٔ** زنجیره — نه شمار رکوردهای داخل پنجره — و **پیش از خواندن هر ردیف** اعمال می‌شود.
> متریک `rasta_audit_chain_verification_failures_total{reason,scope}` تنها برای واگرایی واقعی حرکت می‌کند.
> Runbook: [`runbooks/audit-chain-divergence.md`](runbooks/audit-chain-divergence.md).
>
> **زنجیره Tamper-Evident است، نه Tamper-Proof: هیچ امضایی وجود ندارد و یک Superuser پایگاه داده می‌تواند شواهد و Head را
> با هم بازنویسی کند** (ADR-053 § ۶، `AGENTS.md` S-10).
>
> **آنچه هنوز نیست:** هیچ رکورد جبرانی (`audit.correction`) — ADR-053 § ۷ اصلاح را از **مسیر B** لازم می‌داند و این سرویس نه
> Producer دارد، نه Outbox، نه API نوشتن، پس `correctionOf` ستونی بی‌اثر است که همیشه `null` نوشته می‌شود؛ هیچ **صادرات**؛
> هیچ انتشار Digest بیرونی؛ هیچ امضا؛ هیچ تجمیع ردها؛ و هیچ مصرف‌کنندهٔ `rasta.audit.trail.v1` (مسیر B — AUD-004؛ به همین
> دلیل یک جست‌وجوی ردشده هنوز خودش رکورد `REFUSED` نمی‌سازد). `COM-009` همچنان `READY` است و ۱۳ امتیازش داده نشده.
>
> **به‌روزرسانی 2026-09-12 — بند «آنچه هنوز نیست» بالا بخشی‌اش گذشته است.** مسیر B مصرف می‌شود (AUD-004 Phase B)، ردها از
> نُه محل در `identity-service` با تجمیع پنجره‌ای ثبت می‌شوند (C1–C10)، و **رکورد جبرانی پیاده شد (نیمهٔ اصلاحِ AUD-003):**
> فرمان `POST /v1/audit-corrections` در `identity-service` (فقط `SYSTEM_ADMIN`، `Idempotency-Key` الزامی، تصمیم موقت
> Q-53) هدف را از راه Endpoint داخلی و باریک `GET /v1/internal/audit-events/{id}` همین سرویس — فقط توکن سرویسِ
> `identity-service`، سه میدان، بی‌هیچ شاهد — اثبات می‌کند و یک `AUDIT_EVENT_RECORDED` v1 از `outbox_message` استاندارد خودش
> منتشر می‌کند. این سرویس آن را رکورد **تازهٔ** زنجیرشده با `correction_of` می‌نویسد؛ اصل و Hashاش دست‌نخورده می‌مانند؛ و هر
> رکورد اکنون `correctionOf` و `correctedBy[]` را با همان دامنهٔ مستأجرِ خودِ رکورد منتشر می‌کند. **این سرویس همچنان هیچ
> API نوشتنی ندارد.** هنوز نیست: صادرات، Digest بیرونی، امضا، Purge و هشدار.

| بُعد            | مشخصات                                                                                                                                                                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Mission**     | سابقه تغییرناپذیر «چه کسی، چه کرد، کِی، از کجا، با چه نتیجه‌ای».                                                                                                                                                                         |
| **مالکیت داده** | `audit_event` — **فقط الحاقی**؛ بدون UPDATE و بدون DELETE                                                                                                                                                                                |
| **REST**        | `GET /audit-events` (فیلتر بر actor، resource، action، بازه) · `GET /audit-events/{id}` · `GET /audit-events/verify` · داخلی: `GET /v1/internal/audit-events/{id}` (فقط توکن سرویسِ `identity-service`؛ اثبات هدف اصلاح)                 |
| **Consumes**    | **دو مسیر:** هر ده Topic دامنه‌ای (Projector) + `rasta.audit.trail.v1` (قرارداد صریح). ADR-053                                                                                                                                           |
| **مرز امنیتی**  | نوشتن فقط از Kafka (بدون API نوشتن). خواندن `SYSTEM_ADMIN` و `UNION_ADMIN`؛ صادرات فقط `SYSTEM_ADMIN`.                                                                                                                                   |
| **ADR**         | [ADR-053](adr/ADR-053-audit-service-append-only-evidence.md) — `Proposed`. **AUD-001 و AUD-002 پیاده شدند؛ از AUD-003 نیمهٔ شواهد دست‌نخوردگی (زنجیرهٔ Hash + `verify`) پیاده شد و نیمهٔ اصلاح نه — وابسته به مسیر B؛ AUD-004 هنوز نه.** |

> **اصلاح 2026-09-07.** این جدول پیش‌تر خواندن را به «`SYSTEM_ADMIN`، `UNION_ADMIN` و **مالک منبع**» می‌داد، در حالی که
> `docs/09` § ۹٫۸ و جدول Gateway (`services/api-gateway/src/config/routes.ts:172-176`) فقط دو نقش مدیر را می‌دهند.
> «مالک منبع» هیچ‌جا تعریف نشده و پیاده‌سازی‌اش نیازمند یک جست‌وجوی مالکیت میان‌سرویسی است که A-01 ممنوع می‌کند. قرائت
> باریک‌تر (کمینهٔ امتیاز) گرفته شد و پرسش باز به‌عنوان [Q-39](24-open-questions.md) ثبت است. `AUDITOR` **هیچ دسترسی‌ای
> به این سرویس ندارد** — تنها سرویسی که به آن می‌رسد `analytics-service` است، و فقط Endpointهای تجمیعی.
> | **Scale** | فقط الحاقی، پارتیشن ماهانه. نگهداشت: **OPEN QUESTION** (پیش‌فرض موقت ۷ سال). |
> | **MVP → PROD** | در Production زنجیره Hash برای اثبات دست‌نخوردگی افزوده می‌شود. |

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
