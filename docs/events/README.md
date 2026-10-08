# کاتالوگ رویدادها — Event Catalogue

> مرجع کامل رویدادهای پلتفرم. معماری و قواعد در
> [`../07-event-architecture.md`](../07-event-architecture.md).
>
> **این فایل باید همیشه با کد همگام باشد.** CI بررسی می‌کند هر رویداد ثبت‌شده در
> `packages/contracts/src/events/` اینجا مستند شده باشد — انحراف = شکست Build.

---

## قواعد

| قاعده        | توضیح                                                                   |
| ------------ | ----------------------------------------------------------------------- |
| نام          | `SCREAMING_SNAKE_CASE`، **فعل گذشته** — رویداد چیزی است که اتفاق افتاده |
| Topic        | `rasta.<domain>.v1` + `.retry` + `.dlq`                                 |
| کلید پارتیشن | پیش‌فرض `aggregateId`؛ انحراف صریح و مستند (ADR-036، `docs/07` § ۷٫۷)¹  |
| انتشار       | **همیشه از راه Transactional Outbox** (ADR-021)                         |
| مصرف         | **همیشه Idempotent** با جدول `processed_event`                          |
| Payload      | **شناسه حمل می‌کند، نه داده شخصی**                                      |
| پول          | `{ amountMinor: string, currency: string }`                             |
| زمان         | ISO-8601 با UTC                                                         |

> ¹ **کلید پارتیشن رویدادها را هم‌Partition می‌کند؛ امروز مرتب‌بودنشان را تضمین
> نمی‌کند.** هر جا در این سند «مرتب می‌ماند» آمده، نیتِ آن کلید توصیف شده است. چند
> Replica از Relay می‌توانند ردیف‌های مجزای یک کلید را هم‌زمان منتشر کنند، و Backoff،
> Lease زنده و بازپخش دستی DLQ می‌توانند رویداد بعدیِ همان کلید را جلو بیندازند —
> اندازه‌گیری‌شده با Kafka واقعی: ۸ وارونگی از ۲۰ آزمون با دو Relay روی یک Partition.
> این **D-027** است و باز می‌ماند؛ طرح در
> [ADR-051](../adr/ADR-051-outbox-semantic-ordering.md) — **`Accepted`** ولی **هنوز
> پیاده نشده**، پس هیچ‌کدام از این تضمین‌ها امروز برقرار نیست.

## Envelope

هر پیام Kafka این ساختار را دارد — بدون استثنا:

```jsonc
{
  "eventId": "01JBQ8Z4K7M2N5P8R1T3V6X9Y2",
  "eventName": "ORDER_COMPLETED",
  "eventVersion": 1,
  "occurredAt": "2026-08-26T10:15:30.123Z",
  "producer": "marketplace-service",
  "producerVersion": "0.3.1",
  "aggregateType": "Order",
  "aggregateId": "ORD_01JBQ8...",
  "aggregateVersion": 7,
  "tenantId": "ORG_01JBQ8...",
  "correlationId": "01JBQ8...",
  "causationId": "01JBQ8...",
  "traceparent": "00-4bf92f...-01",
  "actor": { "type": "USER", "id": "USR_01JBQ8..." },
  "payload": {},
}
```

## سیاست Retry و DLQ (پیش‌فرض همه رویدادها)

| نوع خطا                           | رفتار                                    |
| --------------------------------- | ---------------------------------------- |
| گذرا (شبکه، Timeout، افت وابستگی) | Retry: ۱s → ۵s → ۳۰s → ۲m → ۱۰m، سپس DLQ |
| Deadlock پایگاه داده              | Retry فوری، حداکثر ۳ بار                 |
| Payload نامعتبر / Schema ناسازگار | **DLQ مستقیم** — Retry کمکی نمی‌کند      |
| نقض قاعده کسب‌وکار                | **DLQ مستقیم** + هشدار                   |
| رویداد ناشناخته                   | Log + Skip (سازگاری رو به جلو)           |

**هر پیام DLQ هشدار تولید می‌کند.**
**CONSTRAINT:** پیام DLQ حاوی رویداد مالی **هرگز خودکار بازپخش نمی‌شود** — نیازمند بررسی انسانی.

---

## Identity — `rasta.identity.v1`

| رویداد                         | Aggregate | مصرف‌کنندگان                                   | Payload کلیدی                                        |
| ------------------------------ | --------- | ---------------------------------------------- | ---------------------------------------------------- |
| `USER_REGISTERED`              | User      | notification · audit · analytics               | `userId`, `email`, `requestedRole`                   |
| `USER_ACTIVATED`               | User      | notification · **economic (باز کردن کیف پول)** | `userId`, `organizationId`                           |
| `USER_DEACTIVATED`             | User      | همه (ابطال Session)                            | `userId`, `reason`                                   |
| `MEMBERSHIP_CREATED`           | User      | audit · analytics                              | `userId`, `organizationId`, `roles[]`                |
| `MEMBERSHIP_REVOKED`           | User      | audit · gateway (ابطال Cache)                  | `userId`, `organizationId`                           |
| `MEMBERSHIP_EXPIRED`           | User      | audit · identity (Projection به Keycloak)      | `userId`, `organizationId`, `validUntil`             |
| `ROLE_ASSIGNED`                | User      | audit · **gateway (ابطال Cache مجوز)**         | `userId`, `organizationId`, `role`                   |
| `ROLE_REVOKED`                 | User      | audit · gateway                                | `userId`, `organizationId`, `role`                   |
| `ACTIVE_ORGANIZATION_SWITCHED` | User      | **audit**                                      | `userId`, `previousOrganizationId`, `organizationId` |

`ACTIVE_ORGANIZATION_SWITCHED` (L7-14، 2026-09-25) رکورد حسابرسیِ تغییر سازمان فعال است: در همان تراکنشی نوشته می‌شود که
`user.active_organization_id` را جابه‌جا می‌کند، زیر مستأجرِ سازمان مقصد ثبت می‌شود و فقط وقتی مقدار واقعاً عوض شده باشد.
Projection به Keycloak روی آن عمل نمی‌کند — تغییر سازمان هم‌زمان Project می‌شود و خطای خودش را گزارش می‌دهد.

## Organization — `rasta.organization.v1`

| رویداد                         | مصرف‌کنندگان                                       | Payload کلیدی                                                                                                     |
| ------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `ORGANIZATION_CREATED`         | **همه (Replica مرجع)** · economic (کیف پول)        | `organizationId`, `name`, `type`, `parentId`                                                                      |
| `ORGANIZATION_UPDATED`         | همه (Replica مرجع)                                 | `organizationId`, `changes`                                                                                       |
| `ORGANIZATION_MOVED`           | analytics · audit · construction · contract (Q-83) | `organizationId`, `fromParentId`, `toParentId`, `hierarchyVersion` (D-050)                                        |
| `ORGANIZATION_DEACTIVATED`     | identity (ابطال عضویت) · همه                       | `organizationId`, `reason`                                                                                        |
| `ORGANIZATION_POLICY_CHANGED`  | audit                                              | `organizationId`, `policyKey`, `value`                                                                            |
| `ORGANIZATION_CONTACT_CHANGED` | audit                                              | `organizationId`, `contactId`, `change`, `kind`, `isPrimary`, `demotedContactIds[]` — **بدون** تلفن، ایمیل یا نام |

## Asset — `rasta.asset.v1`

| رویداد                    | مصرف‌کنندگان                       | Payload کلیدی                                                     |
| ------------------------- | ---------------------------------- | ----------------------------------------------------------------- |
| `ASSET_CREATED`           | fleet · analytics · audit · search | `assetId`, `organizationId`, `name`, `type`, `assetTag`, `status` |
| `ASSET_ACTIVATED`         | fleet · analytics                  | `assetId`, `organizationId`, `commissionedAt`                     |
| `ASSET_UPDATED`           | fleet · search · analytics         | `assetId`, `organizationId`, `changedFields`                      |
| `ASSET_TRANSFERRED`       | fleet · analytics · audit          | `assetId`, `fromOrganizationId`, `toOrganizationId`, `reason`     |
| `ASSET_STATUS_CHANGED`    | fleet · construction · analytics   | `assetId`, `previousStatus`, `newStatus`, `reason`                |
| `ASSET_DECOMMISSIONED`    | fleet · maintenance · analytics    | `assetId`, `reason`, `decommissionedAt`                           |
| `ASSET_LOCATION_RECORDED` | fleet · construction · analytics   | `assetId`, `locationId`, `hasCoordinate`, `source`                |
| `ASSET_DOCUMENT_ATTACHED` | document · analytics               | `assetId`, `documentId`, `kind`, `expiresAt`                      |

`ASSET_UPDATED` حمل نام فیلدهای تغییریافته است، نه مقدار پیشین آن‌ها: یک تغییر نام
نباید مقدار قدیمی را روی Topic‌ای بگذارد که همه سرویس‌ها می‌خوانند و نگه می‌دارند.

## Insurance — `rasta.insurance.v1`

| رویداد                | مصرف‌کنندگان                         | Payload کلیدی                                                            |
| --------------------- | ------------------------------------ | ------------------------------------------------------------------------ |
| `INSURANCE_RECORDED`  | **fleet** · notification · analytics | `assetId`, `policyId`, `insurerName`, `coverage`, `validFrom`, `validTo` |
| `INSURANCE_EXPIRING`  | **notification** · analytics         | `assetId`, `policyId`, `insurerName`, `daysRemaining`                    |
| `INSURANCE_EXPIRED`   | fleet · notification · analytics     | `assetId`, `policyId`, `coverage`, `validTo`                             |
| `INSPECTION_RECORDED` | analytics                            | `assetId`, `inspectionId`, `certificateNo`, `result`                     |
| `INSPECTION_EXPIRING` | notification                         | `assetId`, `inspectionId`, `daysRemaining`                               |
| `INSPECTION_FAILED`   | **fleet** · maintenance · analytics  | `assetId`, `inspectionId`, `notes`                                       |

`INSPECTION_FAILED` رویدادی ایمنی است، نه اداری: `fleet` باید بلافاصله دستگاه را از
فهرست قابل اعزام بردارد، و نباید مجبور باشد برای فهمیدن این موضوع فیلد `result` یک
رویداد عمومی «ثبت شد» را بازرسی کند. `daysRemaining` در رویدادهای انقضا حمل می‌شود تا
`notification` بتواند بدون محاسبه دوباره تاریخ، یادآور ۳۰ روزه را از ۳ روزه تشخیص دهد.

**`fleet` اکنون `INSURANCE_RECORDED` را هم مصرف می‌کند (L3-02).** ممنوعیت اعزام
Causeهای مستقل دارد و هیچ‌کدام دیگری را پاک یا بازنویسی نمی‌کند. `INSPECTION_FAILED`
Cause معاینه را می‌گذارد و فقط `MAINTENANCE_COMPLETED` آن را برمی‌دارد. بیمه به‌ازای
هر **نوع پوشش** (`coverage`) جدا نگه داشته می‌شود: `INSURANCE_EXPIRED` پوششِ منقضی را
به مجموعهٔ Lapseها می‌افزاید، و فقط بیمه‌نامه‌ای از **همان پوشش** که `validFrom` تا
`validTo`‌اش اکنون را در بر بگیرد آن را پاسخ می‌دهد. این پاسخ هنگام اعزام حساب می‌شود،
نه ذخیره: تمدیدی که پیش از انقضای بیمه‌نامهٔ قبلی ثبت شده (ترتیب عادی) Lapse بعدی را
از پیش پاسخ داده، و تمدیدی که هفتهٔ بعد شروع می‌شود از هفتهٔ بعد حساب می‌شود.
`coverage` در `INSURANCE_EXPIRED` از همین تغییر افزوده شد؛ Lapseی که آن را ندارد
(تولیدکنندهٔ قدیمی‌تر) `UNKNOWN` ثبت می‌شود و هر بیمه‌نامهٔ معتبری پاسخش می‌دهد. اینکه
کدام پوشش‌ها اصلاً باید مانع اعزام باشند پرسش باز `docs/24` **Q-65** است؛ تا پاسخ،
هر Lapse مانع است، مثل پیش از این تغییر. کد مانع در پاسخ دسترس‌پذیری همان
`DISPATCH_BLOCKED` می‌ماند (قرارداد `ADR-026`)، با یک ورودی به‌ازای هر Cause.

## Fleet — `rasta.fleet.v1`

> پیاده‌شده در `services/fleet-service/src/fleet/events.ts`. Schema هر Payload
> آنجاست و در زمان انتشار اعتبارسنجی می‌شود.

| رویداد                  | Aggregate          | مصرف‌کنندگان                                                        | Payload                                                                                                                                                        |
| ----------------------- | ------------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DRIVER_REGISTERED`     | Driver             | audit · analytics                                                   | `driverId`, `organizationId`, `userId`, `status`                                                                                                               |
| `DRIVER_STATUS_CHANGED` | Driver             | audit · analytics                                                   | `driverId`, `organizationId`, `userId`, `previousStatus`, `newStatus`, `reason`                                                                                |
| `DRIVER_UPDATED`        | Driver             | **audit** · analytics                                               | `driverId`, `organizationId`, `changedFields`                                                                                                                  |
| `ASSET_ASSIGNED`        | Assignment         | **asset (پرونده + وضعیت `ASSIGNED`)** · analytics                   | `assignmentId`, `assetId`, `driverId`, `organizationId`, `startedAt`, `purpose`                                                                                |
| `ASSIGNMENT_ENDED`      | Assignment         | **asset (پرونده + بازگشت به `ACTIVE`)** · analytics                 | `assignmentId`, **`assetId`**, `driverId`, `organizationId`, `startedAt`, `endedAt`, `reason`                                                                  |
| `USAGE_RECORDED`        | UsageRecord        | **maintenance (محرک سرویس)** · asset · economic (پاداش) · analytics | `usageRecordId`, `assetId`, `organizationId`, `driverId`, `assignmentId`, `periodStart`, `periodEnd`, `hours`, `kilometres`, `hourMeter`, `odometer`, `source` |
| `AVAILABILITY_CHANGED`  | AvailabilityWindow | construction · analytics                                            | `assetId`, `organizationId`, `available`, `reason`, `from`, `to`                                                                                               |

**کلید پارتیشن چهار رویداد asset-scoped (`ASSET_ASSIGNED`، `ASSIGNMENT_ENDED`،
`USAGE_RECORDED`، `AVAILABILITY_CHANGED`) `assetId` است، نه `aggregateId`.**
استثنای آگاهانه‌ای بر قاعده § «کلید پارتیشن». هر مصرف‌کننده درباره **یک دستگاه**
استدلال می‌کند — پرونده الکترونیکی، برنامه سرویس کارکردمحور — و ترتیب فقط درون یک
پارتیشن تضمین می‌شود. اگر `ASSET_ASSIGNED` و `ASSIGNMENT_ENDED` یک دستگاه روی دو
پارتیشن می‌نشستند، دستگاه آزادشده می‌توانست برای همیشه در `ASSIGNED` گیر کند.
سه رویداد `DRIVER_*` کلید جدا ندارند و روی `aggregateId` (یعنی `driverId`) می‌مانند،
چون هیچ ترتیبی میان راننده و دستگاه لازم نیست.

**`DRIVER_UPDATED` دومین افزودهٔ آگاهانه به کاتالوگ است، کنار
`DRIVER_STATUS_CHANGED` (L3-11).** پیش از این، ویرایش پروندهٔ راننده — شماره
گواهینامه، کلاس، شماره پرسنلی — هیچ رویدادی تولید نمی‌کرد؛ فقط ردیف را با
`updatedBy` تازه می‌نوشت. `audit-service` تنها ورودی‌اش رویداد است، پس این
تغییرها از دید آن نامرئی بودند (`AGENTS.md` S-06). `changedFields` فقط نام
فیلدهای تغییرکرده را حمل می‌کند، نه مقدارشان — شماره گواهینامه دقیقاً همان دادهٔ
شخصی است که یادداشت بالای این فایل از قرار گرفتنش روی یک Topic ماندگار برحذر
می‌دارد.

**`ASSIGNMENT_ENDED` حتماً `assetId` دارد.** ستون «Payload کلیدی» نسخه پیشین این سند
فقط `assignmentId` و `endedAt` را فهرست کرده بود. پیروی تحت‌اللفظی از آن، رویدادی
می‌ساخت که `TimelineConsumer` در `asset-service` نمی‌تواند به چیزی بچسباند
(`timelineSourceSchema` بدون `assetId` رویداد را Skip می‌کند) — یعنی نگاشت
`ASSIGNMENT_ENDED → ACTIVE` هرگز اجرا نمی‌شد و هر دستگاه آزادشده در `ASSIGNED`
می‌ماند. تست قرارداد این را قفل کرده (`src/fleet/events.spec.ts`).

**`hours`/`kilometres`/`hourMeter`/`odometer` رشته‌اند، نه عدد.** ستون‌ها `NUMERIC`
هستند؛ عبور از `float` در JSON دقیقاً همان دریفتی را برمی‌گرداند که نوع ستون برای
جلوگیری از آن انتخاب شده. `maintenance-service` ساعت‌ها را از همین رویداد انباشته
می‌کند تا «سرویس هر ۲۵۰ ساعت» را ارزیابی کند، پس دریفت در نهایت یعنی دستگاهی که
سرویسش را از دست داده. همان استدلال ADR-022 برای پول.

**تفکیک Delta از قرائت کنتور.** `hours`/`kilometres` مقدار **مصرف‌شده در دوره**اند؛
`hourMeter`/`odometer` **قرائت کنتور** در پایان دوره. هر دو حمل می‌شوند تا
مصرف‌کننده برای ارزیابی برنامه کارکردمحور مجبور به بازسازی مجموع از همه ردیف‌های
پیشین نباشد.

**Idempotency:** `eventId` کلید مصرف‌کننده است (جدول `processed_event`). سمت تولید،
ثبت کارکرد با `clientReference` تکراری **رویداد دوم منتشر نمی‌کند** — وگرنه
`maintenance-service` ساعت‌ها را دوبار می‌شمرد. Retry/DLQ: سیاست پیش‌فرض این سند؛
DLQ روی `rasta.fleet.v1.dlq`.

**`MISSION_STARTED` / `MISSION_COMPLETED` — PLANNED، پیاده نشده.** مأموریت به پروژه‌های
`construction-service` گره خورده که هنوز وجود ندارد، و `docs/17` آن را در دامنه MVP
نیاورده. `TimelineConsumer` در `asset-service` از پیش برایشان نگاشت دارد، پس افزودنشان
بعداً هیچ تغییری در سرویس مصرف‌کننده نمی‌خواهد. (ADR-026، بخش Consequences)

### رویدادهایی که fleet مصرف می‌کند

Consumer Group: `fleet-service.asset-sync`. Topicها: `rasta.asset.v1` ·
`rasta.insurance.v1` · `rasta.maintenance.v1`. از Offset صفر می‌خواند (Replica باید
دستگاه‌های پیش از استقرار را هم بشناسد).

| رویداد                                     | از            | اثر در fleet                                              |
| ------------------------------------------ | ------------- | --------------------------------------------------------- |
| `ASSET_CREATED` / `ASSET_UPDATED`          | asset         | ساخت/به‌روزرسانی `asset_ref`                              |
| `ASSET_ACTIVATED` / `ASSET_STATUS_CHANGED` | asset         | وضعیت Replica                                             |
| `ASSET_TRANSFERRED`                        | asset         | دستگاه به سازمان جدید منتقل می‌شود؛ وضعیت به `REGISTERED` |
| `ASSET_DECOMMISSIONED`                     | asset         | وضعیت `DECOMMISSIONED` — دیگر قابل تخصیص نیست             |
| **`INSPECTION_FAILED`**                    | asset         | **مسدودسازی اعزام، Cause معاینه**                         |
| **`INSURANCE_EXPIRED`**                    | asset         | **مسدودسازی اعزام، Cause بیمه**                           |
| **`INSURANCE_RECORDED`**                   | asset         | **پاسخ Lapse همان پوشش** — فقط در بازهٔ اعتبار (L3-02)    |
| `MAINTENANCE_STARTED`                      | maintenance\* | `inMaintenance = true`                                    |
| `MAINTENANCE_COMPLETED`                    | maintenance\* | `inMaintenance = false` + رفع مسدودی Cause معاینه (فقط)   |

\* تولیدکننده هنوز ساخته نشده؛ اشتراک از امروز برقرار است تا راه‌اندازی
`maintenance-service` یک استقرار باشد، نه تغییر کد.

## Maintenance — `rasta.maintenance.v1`

> **پیاده‌شده و LIVE VERIFIED (2026-08-28).** `maintenance-service` نُه رویداد
> نخست زیر را تولید می‌کند؛ دهمی، `MAINTENANCE_SCHEDULE_CHANGED`، در 2026-09-19
> برای بستن `D-011` افزوده شد؛ یازدهمی، `REPAIR_CANCELLED`، در 2026-09-25
> برای بستن `L3-11` افزوده شد؛ سه رویداد سطر هزینه (`REPAIR_PART_RECORDED`،
> `REPAIR_LABOUR_RECORDED`، `REPAIR_COST_RECORDED`) در 2026-09-25 برای بستن
> بخش maintenance از `L7-14` افزوده شدند.
> جدول این بخش پیش از ساخت سرویس نوشته شده بود و اینجا با
> کد Sync شده — سه تفاوت که پیروی تحت‌اللفظی از نسخه پیشین، مصرف‌کننده‌ها را
> بی‌صدا می‌شکست، در پی جدول توضیح داده شده است.

| رویداد                         | Aggregate           | مصرف‌کنندگان                                 | Payload                                                                                                                                             |
| ------------------------------ | ------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAINTENANCE_DUE`              | MaintenanceSchedule | **notification** · fleet · analytics         | `scheduleId`, `assetId`, `organizationId`, `title`, `basis`, `state`, `dueBy`, `dueAtMeter`                                                         |
| `BREAKDOWN_REPORTED`           | MaintenanceRequest  | notification · asset · analytics             | `requestId`, `assetId`, `organizationId`, `severity`, `title`, `reportedAt`                                                                         |
| `MAINTENANCE_CREATED`          | MaintenanceRequest  | **asset** (پرونده) · analytics               | `requestId`, `assetId`, `organizationId`, `type`, `title`, `scheduleId`, `dueDate`, `reportedAt`                                                    |
| `WORKSHOP_ASSIGNED`            | RepairOrder         | notification · supplier                      | `requestId`, `repairOrderId`, `assetId`, `organizationId`, `workshopOrganizationId`, `assignedAt`                                                   |
| `MAINTENANCE_STARTED`          | MaintenanceRequest  | **fleet** (در دسترس بودن) · **asset**        | `requestId`, `repairOrderId`, `assetId`, `organizationId`, `startedAt`, `workshopOrganizationId`                                                    |
| `REPAIR_COMPLETED`             | RepairOrder         | asset · supplier (امتیاز) · analytics        | `repairOrderId`, `requestId`, `assetId`, `organizationId`, `workshopOrganizationId`, `completedAt`, **`totalCostMinor`**, `currency`                |
| `MAINTENANCE_COMPLETED`        | MaintenanceRequest  | **asset** · **fleet** · economic · analytics | `requestId`, `assetId`, `organizationId`, `type`, `scheduleId`, `completedAt`, `downtimeMinutes`, **`totalCostMinor`**, `currency`                  |
| `MAINTENANCE_APPROVED`         | MaintenanceRequest  | **economic (مجوز تسویه)** · analytics        | `requestId`, `assetId`, `organizationId`, `approvedBy`, `approvedAt`, `workshopOrganizationId`, **`totalCostMinor`**, `currency`, `costBreakdown[]` |
| `MAINTENANCE_CANCELLED`        | MaintenanceRequest  | asset · notification · audit · analytics     | `requestId`, `assetId`, `organizationId`, `cancelledAt`, `reason`, `previousStatus`                                                                 |
| `REPAIR_CANCELLED`             | RepairOrder         | **audit** · supplier · analytics             | `repairOrderId`, `requestId`, `assetId`, `organizationId`, `workshopOrganizationId`, `cancelledAt`, `reason`, `previousStatus`                      |
| `MAINTENANCE_SCHEDULE_CHANGED` | MaintenanceSchedule | **audit** · analytics                        | `scheduleId`, `assetId`, `organizationId`, `change`, `status`, `previousStatus`, `reason`, `changedFields[]`, `changedAt`, `changedBy`              |
| `REPAIR_PART_RECORDED`         | RepairOrder         | **audit** · analytics                        | پایهٔ سطر هزینه + `partUsageId`, `source`, `quantity`, **`unitCostMinor`**, **`totalCostMinor`**                                                    |
| `REPAIR_LABOUR_RECORDED`       | RepairOrder         | **audit** · analytics                        | پایهٔ سطر هزینه + `laborEntryId`, `hours`, **`hourlyRateMinor`**, **`totalCostMinor`**, `performedAt`                                               |
| `REPAIR_COST_RECORDED`         | RepairOrder         | **audit** · analytics                        | پایهٔ سطر هزینه + `category`, **`amountMinor`**                                                                                                     |

**`MAINTENANCE_SCHEDULE_CHANGED` رویداد دهم است و برای بستن `D-011` اضافه شد.**
برنامهٔ سرویس تعیین می‌کند دستگاهی هر چند وقت سرویس می‌شود؛ تا پیش از این،
ساخت، ویرایش و خاموش‌کردن آن هیچ رویدادی تولید نمی‌کرد و دلیلش فقط به ستون
`notes` الحاق می‌شد. `audit-service` تنها ورودی‌اش رویداد است، پس پرپیامدترین
تصمیم این سرویس دقیقاً همانی بود که هرگز نمی‌دید — و `AGENTS.md` S-06 می‌گوید
هر تغییر وضعیت رکورد حسابرسی تولید می‌کند.

`changedFields` فقط **نام** فیلدهای تغییرکرده را دارد، نه مقدارشان — همان قاعده‌ای
که `ASSET_UPDATED` از پیش رعایت می‌کند (بالاتر در همین سند). لاگ رویداد را هر
سرویسی می‌خواند و نگه می‌دارد؛ کپی‌کردن کل قاعده در آن، دادهٔ این سرویس را
جایی تکثیر می‌کند که هیچ مصرف‌کننده‌ای لازمش ندارد و هیچ‌کس نمی‌تواند اصلاحش کند.
گذار وضعیت اما کامل می‌آید (`previousStatus` و `status` و `reason`)، چون پرسشی
که یک حسابرس واقعاً می‌پرسد همین است: چه کسی این را خاموش کرد و چرا.

تکمیل تعمیرِ کار برنامه‌ریزی‌شده هم برنامه را تغییر می‌دهد و همین رویداد را در همان
تراکنش منتشر می‌کند (PR #116): `UPDATED` برای جلو رفتن چرخه (فیلدهای لنگر سرویس) و
`STATUS_CHANGED` از `ACTIVE` به `ARCHIVED` برای برنامهٔ `ONE_TIME` با دلیل ثابت
`ONE_TIME_SCHEDULE_SERVED`؛ `changedBy` تکمیل‌کننده است و `causationId` همان RepairOrder.

**`REPAIR_CANCELLED` رویداد یازدهم است.** از `MAINTENANCE_CANCELLED` مجزاست:
لغو یک RepairOrder یعنی withdrawal یک ارجاع به یک کارگاه، نه رهاشدن کل درخواست
— درخواست باقی می‌ماند تا به کارگاه دیگری ارجاع شود. پیش از این، `cancel()`
فقط ردیف را می‌نوشت (`cancelledBy`، `cancellationReason`) و هیچ رویدادی
منتشر نمی‌شد؛ `audit-service` هرگز نمی‌فهمید ارجاعی پس گرفته شده (`AGENTS.md`
S-06).

**سه رویداد سطر هزینه (`L7-14`).** ثبت قطعه، دستمزد و هزینهٔ مستقیم هر کدام پول
به صورتحسابی می‌افزایند که مالک بعداً تأیید می‌کند، و تا پیش از این هیچ‌کدام رویدادی
تولید نمی‌کرد. هر سه دربارهٔ RepairOrder‌اند (سطر هزینه درون Aggregate آن است،
docs/03 § 3.3) و «پایهٔ سطر هزینه» را مشترک دارند: `repairOrderId`، `requestId`،
`assetId`، `organizationId`، `workshopOrganizationId`، `costId`، `currency`،
`recordedAt`، `recordedBy`، **`orderTotalCostMinor`** و **`requestTotalCostMinor`**
(جمع‌ها پس از همین سطر، بازمحاسبه‌شده از سطرها). مبالغ رشتهٔ واحد فرعی‌اند و
مقدار/ساعت رشتهٔ اعشاری. متن آزاد — نام قطعه، شرح کار، شرح هزینه و به‌ویژه نام
تکنسین — عمداً حمل نمی‌شود. لغو RepairOrder در پی لغو درخواست هم اکنون برای هر
ارجاع زنده یک `REPAIR_CANCELLED` (با `causationId` درخواست) منتشر می‌کند؛ `reason` آن
دلیل ثابت `MAINTENANCE_REQUEST_CANCELLED` است و متن آزاد لغو فقط در پایگاه دادهٔ مستأجر
می‌ماند (PR #116). **پیگیری:** `MAINTENANCE_CANCELLED` و لغو مستقیم RepairOrder هنوز متن
آزاد `reason` را حمل می‌کنند؛ تغییر آن قرارداد به این PR تعلق ندارد.

**کلید پارتیشن هر چهارده رویداد `assetId` است، نه `aggregateId`** — همان استثنای
آگاهانه‌ای که `rasta.fleet.v1` دارد. هر مصرف‌کننده درباره **یک دستگاه** استدلال
می‌کند، و ترتیب فقط درون یک پارتیشن تضمین می‌شود. اگر `MAINTENANCE_STARTED` و
`MAINTENANCE_COMPLETED` یک دستگاه روی دو پارتیشن می‌نشستند، دستگاه تعمیرشده
می‌توانست برای همیشه در `IN_MAINTENANCE` بماند.

**هر چهارده رویداد `assetId` حمل می‌کنند — بدون استثنا.** ستون Payload نسخه پیشین
این سند برای `MAINTENANCE_DUE`، `WORKSHOP_ASSIGNED` و `MAINTENANCE_APPROVED`
آن را نیاورده بود. پیروی تحت‌اللفظی از آن، رویدادی می‌ساخت که `TimelineConsumer`
در `asset-service` نمی‌تواند به چیزی بچسباند (`timelineSourceSchema` بدون
`assetId` رویداد را بی‌صدا Skip می‌کند) — همان اشتباهی که `ASSIGNMENT_ENDED`
مرتکب شد. تست قرارداد این را قفل کرده (`src/maintenance/events.spec.ts`).

**هزینه به‌صورت `totalCostMinor` (رشته، واحد فرعی) + `currency` منتقل می‌شود،
نه `{ amountMinor, currency }`.** انحراف آگاهانه از قاعده پول این سند. علت:
`TimelineConsumer` در `asset-service` پیش از ساخت این سرویس نوشته شده و فیلد
مسطح `totalCostMinor` را می‌خواند و هر چیز دیگری را `null` می‌گیرد — یعنی شکل
تودرتو باعث می‌شد پرونده هر دستگاه، هزینه هر تعمیر را صفر ثبت کند. حمل هر دو
شکل بدتر بود: دو نمایش از یک مبلغ، در نهایت با هم اختلاف پیدا می‌کنند.

**`MAINTENANCE_CANCELLED` افزوده این فاز است و در نسخه پیشین کاتالوگ نبود.**
بدون آن، هر مصرف‌کننده‌ای که `MAINTENANCE_CREATED` را دیده تا ابد باور می‌کند
کار باز است، و `audit-service` — که تنها ورودی‌اش رویداد است — هرگز نمی‌فهمد کار
رها شده (AGENTS.md S-06). قاعده افزودن رویداد فراتر از کاتالوگ در این سرویس یکی
است: **فقط برای درست نگه داشتن ادعایی که قبلاً منتشر شده.**

**`MAINTENANCE_APPROVED` تنها مجوز تسویه است.** کنترل اجباری سند محصول
(«الزام تأیید کاربر پیش از تسویه نهایی»، `docs/17`). `costBreakdown` تفکیک
به‌ازای دسته (`PART`, `LABOUR`, `SERVICE`, `EXTERNAL_REPAIR`, `OTHER`) را حمل
می‌کند تا `economic-service` بتواند تسویه را خط‌به‌خط تطبیق دهد، نه اینکه یک عدد
را بپذیرد (ADR-028). هیچ نرخ کارمزد، هیچ قاعده تقسیم و هیچ زمان‌بندی پرداختی در
این Payload نیست — هیچ‌کدام مال این سرویس نیستند و چند تا از آن‌ها هنوز پرسش باز
هستند (`docs/24` Q-08).

**Idempotency:** `eventId` کلید مصرف‌کننده است (جدول `processed_event`).
Retry/DLQ: سیاست پیش‌فرض این سند؛ DLQ روی `rasta.maintenance.v1.dlq`.

### رویدادهایی که maintenance مصرف می‌کند

دو Consumer Group جدا، چون دو کار متفاوت با دو نوع شکست‌اند (`docs/07` § ۷٫۱۰):

| Consumer Group                   | Topic            | رویدادها                                                                                                    | اثر                                                        |
| -------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `maintenance-service.usage`      | `rasta.fleet.v1` | **`USAGE_RECORDED`**                                                                                        | انباشت `asset_usage_meter` + ارزیابی برنامه‌های کارکردمحور |
| `maintenance-service.asset-sync` | `rasta.asset.v1` | `ASSET_CREATED` · `ASSET_ACTIVATED` · `ASSET_STATUS_CHANGED` · `ASSET_TRANSFERRED` · `ASSET_DECOMMISSIONED` | Replica مرجع `asset_ref`                                   |

هر دو از Offset صفر می‌خوانند: سرویسی که فقط دستگاه‌های ثبت‌شده — و ساعت‌های
کارکرد — پس از نخستین استقرار خودش را می‌شناسد، نمی‌تواند یک برنامه سرویس را
ارزیابی کند.

**آنچه عمداً مصرف نمی‌شود:**

- **`ASSET_UPDATED`** — فقط _نام_ فیلدهای تغییرکرده را حمل می‌کند، نه مقدارشان،
  پس چیزی برای اعمال ندارد. مصرف یک رویداد برای انجام ندادن هیچ کاری، فهرست
  اشتراک را از توصیف واقعیت تهی می‌کند.
- **`PAYMENT_COMPLETED`** — `docs/04` § ۴٫۷ آن را برای «بستن چرخه تسویه» فهرست
  کرده. `economic-service` وجود ندارد، پس معنای «بستن» تعریف‌نشده است و اختراع
  یک وضعیت پس از تأیید، دقیقاً همان فرآیند مالی را اختراع می‌کند که این سرویس
  اجازه مالکیتش را ندارد (ADR-028). **DEFERRED، آگاهانه.**

## Marketplace — `rasta.marketplace.v1`

**تولیدکننده واقعی از 2026-08-30.** هر نُه رویداد اولیه پیاده و زنده تأیید
شده‌اند. Schema رسمی در `services/marketplace-service/src/events/events.ts` و
اعتبارسنجی **پیش از رسیدن به Outbox** انجام می‌شود. `eventVersion` هر نُه،
**۱** است — قراردادهای تازه‌اند و چیزی برای سازگار بودن با آن وجود ندارد.

**افزودهٔ ADR-052 Phase 2 گام ۱ (COM-005):** `ORDER_CREATED` و `ORDER_CANCELLED`
هرکدام یک فیلد اختیاری تازه گرفتند — `promisedDeliveryAt` و
`cancellationCause` — بدون تغییر `eventVersion` (`docs/07` § ۷٫۸: افزودن فیلد
اختیاری شکننده نیست). یک رویداد دهم، `ORDER_DISPUTE_RESOLVED`، به کاتالوگ
افزوده شد؛ `responsibility`‌اش الزامی است چون رویدادی تازه است، نه تغییری روی
یکی موجود. سیگنال کیفیت (۳۰٪ وزن امتیاز عملکرد) عمداً پیاده نشد — Q-56 باز
است.

**کلید پارتیشن (ADR-036 روی این دامنه).** هر رویداد چرخه‌عمر سفارش با
`orderId` پارتیشن می‌شود — همان Invariant که مصرف‌کننده برای بازسازی یک سفارش
به آن تکیه می‌کند. `REVIEW_SUBMITTED` هم با `orderId`، چون آخرین چیزی است که
برای یک سفارش اتفاق می‌افتد و چرخه‌عمر مستقلی ندارد. تنها استثنا
`OFFER_PUBLISHED` است که با `offerId` پارتیشن می‌شود: یک عرضه بارها قیمت عوض
می‌کند و Index جست‌وجو باید آن تغییرها را به ترتیب اعمال کند.

**دو تصحیح نسبت به طرح زیر، که هنگام پیاده‌سازی لازم شد:**

- `ORDER_RECEIPT_CONFIRMED` در طرح فقط `orderId, confirmedBy` داشت. ADR-032
  همین را دلیل نوشت که `economic-service` نمی‌تواند مصرفش کند: «مصرف‌کننده باید
  از قبل بداند چه چیزی را تسویه کند». حالا `totalAmountMinor` و هر دو سازمان را
  حمل می‌کند.
- `ORDER_COMPLETED` علاوه بر `total`، `commissionAmountMinor` و
  `netAmountMinor` را حمل می‌کند — **بازتاب پاسخ تسویه**، نه محاسبه محلی. این
  سرویس نرخ کارمزد را نمی‌داند و نباید به‌نظر برسد که می‌داند (ADR-040 § ۶).

| رویداد                    | مصرف‌کنندگان                                                              | Payload کلیدی                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `OFFER_PUBLISHED`         | search · analytics                                                        | `offerId`, `productId`, `supplierOrganizationId`, `price`                                                                       |
| `ORDER_CREATED`           | **economic (Hold)** · inventory (رزرو) · notification · supplier (امتیاز) | `orderId`, `buyerOrganizationId`, `supplierOrganizationId`, `total`, `lines[]`, `promisedDeliveryAt` (اختیاری، ADR-052 § ۱-الف) |
| `ORDER_CONFIRMED`         | notification · analytics                                                  | `orderId`                                                                                                                       |
| `ORDER_FULFILLED`         | notification · inventory · supplier (امتیاز)                              | `orderId`, `fulfillmentId`                                                                                                      |
| `ORDER_RECEIPT_CONFIRMED` | **economic (Release + تسویه + کارمزد)**                                   | `orderId`, `confirmedBy`                                                                                                        |
| `ORDER_COMPLETED`         | economic (پاداش) · supplier (امتیاز) · analytics                          | `orderId`, `total`                                                                                                              |
| `ORDER_CANCELLED`         | economic (بازگشت) · inventory (آزادسازی) · supplier (امتیاز)              | `orderId`, `reason`, `cancellationCause` (اختیاری، enum بسته، ADR-052 § ۱-پ)                                                    |
| `ORDER_DISPUTED`          | **economic (توقف تسویه)** · notification · supplier                       | `orderId`, `disputeId`, `reason`                                                                                                |
| `ORDER_DISPUTE_RESOLVED`  | supplier (امتیاز)                                                         | `orderId`, `disputeId`, `outcome`, `responsibility` (enum بسته، الزامی، ADR-052 § ۱-ب)                                          |
| `REVIEW_SUBMITTED`        | supplier (امتیاز) · economic (پاداش)                                      | `orderId`, `rating`, `criteria`                                                                                                 |

### رکوردهای حسابرسی — L7-14 (2026-09-25)

هفت تغییر وضعیت که هیچ رویدادی منتشر نمی‌کردند (`AGENTS.md` S-06). هر کدام در همان تراکنشِ تغییر نوشته می‌شود و فقط وقتی
چیزی واقعاً عوض شده باشد.

| رویداد                     | Aggregate / کلید    | مصرف‌کنندگان | Payload کلیدی                                                                                           |
| -------------------------- | ------------------- | ------------ | ------------------------------------------------------------------------------------------------------- |
| `PRODUCT_CREATED`          | Product / productId | **audit**    | `productId`, `sku`, `category`, `kind`, `unit`, `createdBy`                                             |
| `OFFER_DRAFTED`            | Offer / offerId     | **audit**    | شرایط عرضه، `version`, `createdBy`                                                                      |
| `OFFER_UPDATED`            | Offer / offerId     | **audit**    | شرایط عرضه، `previousStatus`, `status` (هرگز `PUBLISHED`), `changedFields[]`, `updatedBy`               |
| `ORDER_FUNDS_HELD`         | Order / orderId     | **audit**    | طرفین و مبلغ، `transactionId`, `status` (`FUNDS_HELD` یا `CANCELLING`)                                  |
| `ORDER_FAILED`             | Order / orderId     | **audit**    | طرفین و مبلغ، `failedAt` — **بدون دلیل**: متن ردِ economic-service است و روی ردیف سفارش پشت API می‌ماند |
| `ORDER_SETTLEMENT_STARTED` | Order / orderId     | **audit**    | طرفین و مبلغ، `startedAt`                                                                               |
| `ORDER_SETTLEMENT_FAILED`  | Order / orderId     | **audit**    | طرفین و مبلغ، `failedAt`                                                                                |

تغییری که عرضه را `PUBLISHED` نگه دارد همچنان `OFFER_PUBLISHED` است؛ `OFFER_UPDATED` ویرایش پیش‌نویس و هر خروج از انتشار
را پوشش می‌دهد — همان چیزی که Index جست‌وجو نباید از دست بدهد. رویدادهای Saga زیر مستأجر خریدار ثبت می‌شوند، مثل بقیهٔ
رویدادهای سفارش، با Actor از نوع `SERVICE` (`marketplace-service`). کلید مشترک (`orderId` / `offerId`) فقط **هم‌پارتیشنی**
است، نه تحویل مرتب: Relay هنوز می‌تواند ردیف بعدیِ یک کلید را پیش از ردیف قبلی منتشر کند (D-027، باز؛ رفعش ADR-051 B4
است و در این تغییر نیست). ترتیب واقعی را `occurredAt` و `streamSeq` می‌گویند، نه ترتیب رسیدن.

## Procurement — `rasta.procurement.v1`

| رویداد                   | مصرف‌کنندگان                        | Payload کلیدی                                    |
| ------------------------ | ----------------------------------- | ------------------------------------------------ |
| `DEMAND_SUBMITTED`       | analytics                           | `demandId`, `sku`, `quantity`                    |
| `DEMAND_AGGREGATED`      | notification · analytics            | `aggregationId`, `demandIds[]`, `totalQuantity`  |
| `RFQ_ISSUED`             | **notification (دعوت تأمین‌کننده)** | `rfqId`, `invitedSuppliers[]`, `deadline`        |
| `QUOTATION_SUBMITTED`    | analytics                           | `rfqId`, `quotationId`, `supplierOrganizationId` |
| `QUOTATIONS_EVALUATED`   | audit · analytics                   | `rfqId`, `scores[]`, `selectedQuotationId`       |
| `PURCHASE_ORDER_ISSUED`  | inventory · economic · notification | `purchaseOrderId`, `total`                       |
| `GOODS_RECEIVED`         | inventory · economic                | `receiptId`, `purchaseOrderId`                   |
| `QUALITY_CHECK_RECORDED` | supplier (امتیاز)                   | `receiptId`, `passed`, `notes`                   |

## Supplier — `rasta.supplier.v1`

| رویداد                                  | مصرف‌کنندگان                                                      | Payload کلیدی                                                                                                                    |
| --------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `SUPPLIER_REGISTERED`                   | analytics · audit                                                 | `supplierId`, `organizationId`, `capabilities[]`                                                                                 |
| `SUPPLIER_QUALIFIED`                    | marketplace · procurement · construction                          | `supplierId`, `qualifiedFor[]`                                                                                                   |
| `SUPPLIER_REJECTED`                     | notification                                                      | `supplierId`, `reason`                                                                                                           |
| `SUPPLIER_SUSPENDED`                    | **marketplace (پنهان‌سازی پیشنهاد)** · procurement · construction | `supplierId`, `reason`, `until`                                                                                                  |
| `SUPPLIER_REINSTATED`                   | **audit** · مصرف‌کنندگانِ `SUPPLIER_SUSPENDED`                    | `supplierId`, `suspensionId`, `reason`, `reinstatedBy`                                                                           |
| `PERFORMANCE_SCORE_UPDATED`             | **marketplace (رتبه‌بندی)** · search                              | `supplierId`, `score`, `breakdown`                                                                                               |
| `PERFORMANCE_FORMULA_VERSION_CREATED`   | **audit**                                                         | `formulaVersionId`, `formulaVersion`, `windowDays`, `minSampleCount`, `minCoverageBp`, `ratingMapping`, `weights[]`, `createdBy` |
| `PERFORMANCE_FORMULA_VERSION_ACTIVATED` | **audit**                                                         | `formulaVersionId`, `formulaVersion`, `supersededFormulaVersionId`, `activatedBy`                                                |
| `PERFORMANCE_FORMULA_VERSION_RETIRED`   | **audit**                                                         | `formulaVersionId`, `formulaVersion`, `successorFormulaVersionId`, `retiredBy`                                                   |

> **سه رویداد `PERFORMANCE_FORMULA_VERSION_*` (ADR-052 گام ۲).** رکورد Audit هر تغییر فرمول سراسری امتیاز عملکرد
> (S-06) — در همان تراکنش ردیف، از راه Outbox. فرمول به هیچ مستأجری تعلق ندارد (`docs/24` Q-75)، پس این رویدادها
> `tenantId` ندارند و کلید جریانشان **شناسهٔ نسخهٔ فرمول** است، نه `supplierId`. بازنشستگی فقط همراه فعال‌سازی جانشین رخ
> می‌دهد و `successorFormulaVersionId` همیشه پر است. `PERFORMANCE_SCORE_UPDATED` همچنان منتشر **نمی‌شود** (گام ۸).

## Inventory — `rasta.inventory.v1`

| رویداد                | مصرف‌کنندگان                 | Payload کلیدی                                 |
| --------------------- | ---------------------------- | --------------------------------------------- |
| `STOCK_RECEIVED`      | procurement · analytics      | `warehouseId`, `sku`, `quantity`              |
| `STOCK_RESERVED`      | **marketplace (Saga سفارش)** | `reservationId`, `orderId`, `sku`, `quantity` |
| `STOCK_RELEASED`      | marketplace (Saga سفارش)     | `reservationId`, `reason`                     |
| `STOCK_ISSUED`        | marketplace · analytics      | `sku`, `quantity`, `destination`              |
| `LOW_STOCK_DETECTED`  | notification · procurement   | `warehouseId`, `sku`, `current`, `threshold`  |
| `SHIPMENT_CREATED`    | marketplace · notification   | `shipmentId`, `orderId`, `carrier`            |
| `SHIPMENT_DISPATCHED` | notification                 | `shipmentId`, `dispatchedAt`                  |
| `SHIPMENT_DELIVERED`  | marketplace · notification   | `shipmentId`, `deliveredAt`                   |

## Construction — `rasta.construction.v1`

> **CON-001 PR نخست (2026-09-26).** `construction-service` هفت رویداد زیر را تولید می‌کند: `PROJECT_CREATED` و شش
> رویداد تازه‌ای که مدیر پروژه برای همین PR پذیرفت (ردیف‌های **پررنگ** در جدول دوم). بقیهٔ ردیف‌های جدول نخست هنوز
> **برنامه‌ریزی‌شده**‌اند: موافقت‌ها، آغاز و پایان و پیشرفت با PR دوم CON-001، و مناقصه با CON-002. Payloadها در
> `services/construction-service/src/events/events.ts` تعریف و در زمان انتشار اعتبارسنجی می‌شوند (`.strict()`).
>
> **CON-001 PR دوم.** شش ردیف کاتالوگ `APPROVAL_REQUESTED`، `APPROVAL_GRANTED`، `APPROVAL_REJECTED`، `PROJECT_STARTED`،
> `PROJECT_PROGRESS_UPDATED` و `PROJECT_COMPLETED` پیاده شدند؛ ستون Payload آن‌ها اکنون Payload واقعی است. نثرِ
> کاتالوگ (`approvalType`، `conditions`، `reason`) طبق همان قاعدهٔ حریم روی رویداد نمی‌آید؛ `percentage` به
> `progressBasisPoints` تبدیل شد. پنج رویداد تازه (جدول سوم) را مدیر پروژه **پذیرفت** (2026-09-26).
>
> **کلید پارتیشن همهٔ رویدادهای پروژه `projectId` است** و `aggregateType` آن‌ها `Project` (رویدادهای سیاست موافقت
> استثنایند؛ جدول سوم): نیاز، موافقت و
> گزارش پیشرفت درون مرز Aggregate پروژه‌اند (`docs/03` § ۳٫۳)، و هر مصرف‌کننده دربارهٔ **یک پروژه** استدلال می‌کند.
> شناسهٔ نیاز در Payload می‌آید (`needId`). این هم‌Partition‌کردن است، نه ترتیب تضمین‌شده (D-027).
>
> **Payloadها فقط شناسه، وضعیت، مهر زمانی، مبلغ و کدهای کران‌دار حمل می‌کنند — هیچ متن آزاد، داده شخصی، شناسهٔ سند
> یا چندضلعی محدوده.** عنوان پروژه، نوع عملیات (که بی‌فهرست پیکربندی‌شده متن آزاد است، Q-68)، شرح کار، شرح نیاز و
> دلیل نوشته‌شدهٔ لغو یا انصراف نثری‌اند که کسی برای سازمان خودش نوشته، نه برای هر مصرف‌کنندهٔ پلتفرم؛ در پایگاه دادهٔ
> همین سرویس می‌مانند و مصرف‌کننده از API (با مجوز خودش) می‌خواندشان (بازبینی Codex روی #119، یافتهٔ ۴). `PROJECT_CREATED`
> به‌جای `location` فقط `hasArea` دارد. `estimate` با نام `estimatedCostMinor` (رشتهٔ ریالی، یا `null`) می‌آید.
> تحویل مرتب میان Replicaهای Relay تضمین **نمی‌شود** (D-027، ADR-051 B4).
>
> **مصرف (CON-002 PR 5).** `construction-service` از `rasta.supplier.v1` فقط `SUPPLIER_QUALIFIED` (وقتی `qualifiedFor`
> شامل `CONTRACTING` باشد)، `SUPPLIER_SUSPENDED` و `SUPPLIER_REINSTATED` را می‌خواند (گروه
> `construction-service.supplier-standing`، صف مرده `rasta.construction.v1.dlq`) و از `rasta.organization.v1` فقط
> `ORGANIZATION_MOVED` را. پیاده‌سازی مدل خواندنی: جابه‌جاپذیر و تکرارپذیر؛ سازمانِ ناشناخته واجد شرایط نیست.

| رویداد                     | مصرف‌کنندگان                                            | Payload کلیدی                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PROJECT_CREATED`          | analytics · audit                                       | `projectId`, `organizationId`, `estimatedCostMinor`, `hasArea`, `createdBy`, `createdAt`                                                                                 |
| `APPROVAL_REQUESTED`       | **notification (مرجع تأیید)** · audit                   | `approvalId`, `projectId`, `organizationId`, `workflowKey`, `round`, `stepOrder`, `authorityOrganizationId`, `authorityRole`, `policyId`, `policyVersion`, `requestedAt` |
| `APPROVAL_GRANTED`         | notification · audit · analytics                        | `approvalId`, `projectId`, `organizationId`, `workflowKey`, `round`, `stepOrder`, `decidedBy`, `decidedAt`, `hasConditions`                                              |
| `APPROVAL_REJECTED`        | notification · audit                                    | `approvalId`, `projectId`, `organizationId`, `workflowKey`, `round`, `stepOrder`, `decidedBy`, `decidedAt`                                                               |
| `TENDER_CREATED`           | audit                                                   | `tenderId`, `projectId`, `procurementNature`                                                                                                                             |
| `TENDER_PUBLISHED`         | **notification (پیمانکاران)** · search · analytics      | `tenderId`, `bidOpeningAt`, `bidClosingAt`                                                                                                                               |
| `BID_SUBMITTED`            | notification · **audit (مهر زمانی)**                    | `bidId`, `tenderId`, `contractorId`, `submittedAt`                                                                                                                       |
| `BIDS_EVALUATED`           | audit · analytics                                       | `tenderId`, `matrix`, `ranking`                                                                                                                                          |
| `TENDER_AWARDED`           | **contract (ایجاد پیش‌نویس)** · notification · supplier | `tenderId`, `winnerId`, `amount`, `justification`                                                                                                                        |
| `PROJECT_STARTED`          | fleet · analytics                                       | `projectId`, `organizationId`, `contractId` (تا CON-003 همیشه `null`), `startedBy`, `startedAt`                                                                          |
| `PROJECT_PROGRESS_UPDATED` | contract · notification · analytics                     | `projectId`, `reportId`, `organizationId`, `progressBasisPoints` (۰..۱۰۰۰۰), `submittedBy`, `submittedAt` — **بدون `assetsUsed`** (پایین‌تر)                             |
| `PROJECT_COMPLETED`        | contract · supplier (امتیاز) · analytics                | `projectId`, `organizationId`, `completedBy`, `completedAt`                                                                                                              |

**رویدادهای مناقصه — CON-002 (طرح، 2026-09-30؛ هنوز تولید نمی‌شوند).** ردیف‌های `TENDER_*`/`BID_*`/`BIDS_EVALUATED` جدول
بالا **طرح**‌اند و با این جدول (ADR-065/066/067) جایگزین می‌شوند: `aggregateType = Tender`، **کلید پارتیشن `tenderId`**
(`docs/07` § ۷٫۴)، مالک Topic و ACL تولیدکننده بی‌تغییر. **هیچ Payloadی محتوا، قیمت پیشنهادی، رمزنوشته یا متن آزاد
حمل نمی‌کند** (`.strict()`)؛ `matrix`/`justification`/`amount` کاتالوگ نیز به‌جایشان شناسه و شمار و `hasJustification` می‌آیند. بازیگر
در لفافه است؛ پس شناسهٔ پیمانکار روی Topic دیدنی است و فقط `audit-service` آن را می‌خواند (D-044).

| رویداد                               | مصرف‌کنندگان                                               | Payload کلیدی                                                                                                                                                                                                                                 |
| ------------------------------------ | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TENDER_CREATED`                     | audit                                                      | `tenderId`, `projectId`, `organizationId`, `procurementNature` (یا `null` تا انتشار), `createdBy`, `createdAt`                                                                                                                                |
| `TENDER_PUBLISHED`                   | audit · notification (پیمانکاران) · search                 | `tenderId`, `organizationId`, `visibility`, `bidOpeningAt`, `bidClosingAt`, `criteriaCount`, `approvalRequestId`, `publishedBy`, `publishedAt`                                                                                                |
| `TENDER_CLOSED`                      | audit · notification                                       | `tenderId`, `organizationId`, `bidCount`, `closedAt`, `closedBy` (بازیگر سیستم برای جاروکننده)                                                                                                                                                |
| `BID_SUBMITTED`                      | audit (مهر زمانی و رسید)                                   | `bidId`, `tenderId`, `organizationId`, `bidderOrganizationId`, `revision`, `receivedAt`, `contentCommitment`, `receipt`                                                                                                                       |
| `BID_REVISED`                        | audit                                                      | همان `BID_SUBMITTED` با `revision` بالاتر                                                                                                                                                                                                     |
| `BID_WITHDRAWN`                      | audit                                                      | `bidId`, `tenderId`, `organizationId`, `bidderOrganizationId`, `withdrawnAt`                                                                                                                                                                  |
| `BIDS_OPENED`                        | audit · notification                                       | `tenderId`, `projectId`, `organizationId`, `bidCount`, `bidIdsDigest`, `receiptHead`, `openedBy`, `proposedBy`, `openedAt`                                                                                                                    |
| `BID_ACCESSED`                       | audit                                                      | `bidId`, `tenderId`, `organizationId`, `accessorOrganizationId`, `purpose` (بسته), `outcome`, `accessedAt`                                                                                                                                    |
| `BID_QUALIFIED` / `BID_DISQUALIFIED` | audit                                                      | `bidId`, `tenderId`, `organizationId`, `reasonCode` (بسته، فقط رد), `decidedBy`, `decidedAt`                                                                                                                                                  |
| `BIDS_EVALUATED`                     | audit · analytics                                          | `tenderId`, `organizationId`, `evaluatedBidCount`, `evaluatedBy`, `evaluatedAt`                                                                                                                                                               |
| `TENDER_AWARDED`                     | **contract (پیش‌نویس، CON-003)** · notification · supplier | `tenderId`, `projectId`, `organizationId`, `winningBidId`, `winnerOrganizationId`, `hasJustification`, `matrixDigest`, `approvalRequestId`, `awardedBy`, `awardedAt` — **بی مبلغ**                                                            |
| `BID_NOT_AWARDED`                    | notification (بازنده) · audit                              | `bidId`, `tenderId`, `organizationId`, `bidderOrganizationId`, `decidedAt`                                                                                                                                                                    |
| `TENDER_CANCELLED`                   | audit · notification                                       | `tenderId`, `organizationId`, `from`, `reasonCode` (بسته، مثل `NO_QUALIFIED_BID`), `approvalRequestId`, `cancelledBy`, `cancelledAt`                                                                                                          |
| `TENDER_APPROVAL_ACTION`             | audit                                                      | `tenderId`, `projectId`, `organizationId`, `workflowKey` (`tender.*`)، `requestId`, `action` (`REQUEST`/`GRANT`/`REJECT`/`EXECUTE`/`STALE`/`READ`)، `outcome`, `refusalCode` (بسته)، `stepOrder`, `actedBy`, `actorOrganizationId`, `actedAt` |

`TENDER_AWARDED` **مبلغ ندارد** (دور اول بازبینی #199): مبلغ برنده محتوای یک پیشنهاد است و این Topic را همهٔ سرویس‌ها می‌خوانند. CON-003 قرارداد را با کلید Idempotency `tenderId` می‌سازد و مبلغ را
از `GET /v1/tenders/{id}/award` (احراز هویت‌شده، محدود به مستأجر، `@AllowService('contract-service')`) می‌خواند. `BID_ACCESSED` و `BID_QUALIFIED`/`BID_DISQUALIFIED` رویدادهای **افزودهٔ CON-002** برای پوشش S-06
هستند. **هشت رویداد افزوده — `BID_ACCESSED`، `BID_QUALIFIED`، `BID_DISQUALIFIED`، `BIDS_OPENED`، `BID_REVISED`، `BID_WITHDRAWN`، `TENDER_CLOSED`،
`TENDER_CANCELLED` — را مدیر پروژه با همین نام‌ها پذیرفت (2026-09-30).** `BID_ACCESSED` هرگز محتوای پیشنهاد حمل نمی‌کند: فقط
شناسه‌ها، بازیگر، زمان و هدف بسته (`.strict()` هر فیلد دیگر را رد می‌کند).

**پیاده‌شده در CON-002 PR 6 (پیشنهاد):** `BID_SUBMITTED` و `BID_REVISED` علاوه بر ستون بالا `ciphertextSha256`، `previousReceipt`،
`receipt` و `submittedBy` دارند: `receipt` **سرِ تازهٔ زنجیرهٔ رسید** همان مناقصه است و `audit-service` آن را بیرون از
پایگاه دادهٔ این سرویس نگه می‌دارد؛ بازگشایی (گام ۸) سر را از آنجا می‌گیرد، نه از جدول `bid_receipt` (ADR-066 § ۲). Digestها
امن‌اند؛ محتوا، قیمت و رمزنوشته هرگز نمی‌آیند. `BID_WITHDRAWN` شامل `revision` و `withdrawnBy` است. `BID_ACCESSED` برای هر خواندن
پیشنهاد (رد شده هم) در همان تراکنش نوشته می‌شود: `bidId` (یا `null` اگر پیشنهادی برای خواننده نبود)، `accessorOrganizationId`،
`accessedBy`، `purpose` (بسته: `OWN_BID_RECEIPT`؛ هدف‌های سمت کارفرما با گام ۸)، `outcome` (`GRANTED | REFUSED`)، `accessedAt`.
هیچ‌کدام `projectId` ندارند؛ کلید پارتیشن `tenderId` است.

**پیاده‌شده در CON-002 PR 7 (بستن مهلت):** `TENDER_CLOSED` (`aggregateType = Tender`، کلید `tenderId`؛ `projectId`، `organizationId`،
`bidCount` — شمار پیشنهادهای ایستاده، نه انصراف‌یافته‌ها — `closedAt` و `closedBy`؛ برای جاروکننده `system:construction-service`).
هیچ شناسهٔ پیمانکار، قیمت یا محتوایی نمی‌آید (`.strict()`). هر مناقصه **یک** `TENDER_CLOSED` دارد: بستن در پایگاه داده Idempotent است
(مناقصه‌ای که دیگر `PUBLISHED` نیست بی‌اثر و بی‌رویداد برمی‌گردد). `closedAt` ساعت پایگاه داده است که پس از قفل مناقصه خوانده می‌شود و
هرگز پیش از `bidClosingAt` نیست. رویداد با گذار در یک تراکنش نوشته می‌شود؛ تأخیر بسته‌شدن به فاصلهٔ جاروکننده
(`CONSTRUCTION_TENDER_CLOSE_INTERVAL_MS`) کران می‌خورد و درستی پذیرش پیشنهاد به آن وابسته نیست (ADR-065 § ۲-۳).

**پیاده‌شده در CON-002 PR 8 (بازگشایی):** `BIDS_OPENED` (`aggregateType = Tender`، کلید `tenderId`؛ `projectId`، `organizationId`، `bidCount` —
پیشنهادهای ایستاده که باز شدند، نه انصراف‌یافته‌ها — `bidIdsDigest` (SHA-256 به‌صورت hex از شناسهٔ پیشنهادهای بازشده، مرتب‌شدهٔ صعودی و
پیوسته با `\n`؛ رویداد **کران‌دار** است و با شمار پیشنهادها بزرگ نمی‌شود، خود شناسه‌ها با `GET /v1/tenders/:id/bids` خوانده می‌شوند)،
`receiptHead` (سرِ زنجیرهٔ رسید که پیشنهادها با آن سنجیده شدند؛ Digest و پیشتر عمومی)، `openedBy`، `proposedBy` (نفر نخستِ چهارچشمی، Q-91؛
در غیاب آن `null`)، `openedAt`). هیچ قیمت، پاسخ، یادداشت، رمزنوشته یا کلیدی نمی‌آید (`.strict()`). هر مناقصه **یک** `BIDS_OPENED` دارد.
هدف‌های `BID_ACCESSED` اکنون: `OWN_BID_RECEIPT` (پیمانکار)، و سمت کارفرما `OPEN_BIDS` (به‌ازای هر پیشنهاد بازشده)، `PROPOSE_OPENING` (پیشنهادِ بازگشایی، چهارچشمی؛ بی `bidId`، پیشنهادی خوانده نمی‌شود)، `COUNT_BIDS` (شمار پیش
از بازگشایی؛ بی `bidId`)، `LIST_BIDS`، `READ_BID`؛ ردشده‌ها `outcome = REFUSED` و `bidId = null`. بازگشایی یا خواندنی که پیشنهادی برای
نشان‌دادن ندارد (مناقصه‌ای بی پیشنهاد) هم یک ردیف سطح مناقصه (`bidId = null`، `outcome = GRANTED`) می‌گذارد.

**افزوده در دور چهارم Codex #184 (تضاد منفعت):** هدف `BID_ACCESSED` تازه: `WITHDRAW_PROPOSAL` (پس‌گرفتن یا پاک‌شدن پیشنهادِ بازگشایی؛ بی `bidId`).
دو رویداد (`aggregateType = Tender`، کلید `tenderId`؛ هیچ‌کدام `projectId` ندارند؛ فقط شناسه، `.strict()`):

- `BID_OPENING_CONFLICT_DETECTED` — **نام را مدیر پروژه داد (2026-10-02).** پس از Commit بازگشایی، identity گفت پیشنهاددهنده یا
  تأییدکننده در بازهٔ `windowStart` تا `checkedAt` عضو سازمانی پیشنهاددهنده بوده است (باقیماندهٔ ADR-066 § ۴): `tenderId`، `organizationId`، `openedAt`
  (لحظهٔ تصمیم)، `openedBy`،
  `proposedBy` (یا `null`)، `windowStart` (آغاز بازه: زودترین از خواندن‌های identity در تأیید و لحظهٔ تصمیم)، `checkedAt` (ساعت identity هنگام پاسخ، پس از Commit؛ پایان بازه) و `conflicts` (۱ تا ۲ مورد: `userId`، `role` = `PROPOSER | APPROVER`، `organizationIds`
  حداکثر ۱۰۰ و `organizationCount`). بازگشایی پس گرفته نمی‌شود.
- `BID_OPENING_PROPOSAL_WITHDRAWN` — **افزودهٔ CON-002 برای S-06؛ در انتظار پذیرش.** پیشنهادِ بازگشایی را پیشنهاددهنده پس گرفت یا تأییدی که او را
  عضو پیشنهاددهنده یافت پاکش کرد: `tenderId`، `organizationId`، `proposedBy`، `withdrawnBy`، `reason`
  (`WITHDRAWN_BY_PROPOSER | PROPOSER_CONFLICTED | PROPOSER_IDENTITY_UNKNOWN`)، `withdrawnAt`. `PROPOSER_IDENTITY_UNKNOWN` (#188):
  تأییدِ شخص دوم پیشنهادی را یافت که هویت پایدار پیشنهاددهنده‌اش ثبت نشده (یا با صادرکنندهٔ دیگری)، پس آن را پاک کرد و خودش با
  `422 ACTOR_IDENTITY_UNKNOWN` رد شد — مقدار افزوده به Enum؛ شکل Payload همان است.

**پیاده‌شده در CON-002 PR 9 (ارزیابی؛ ADR-067).** پنج رویداد (`aggregateType = Tender`، کلید `tenderId`؛ فقط شناسه، کد بسته، شمار و Digest، `.strict()`؛ بی `projectId` جز `BIDS_EVALUATED`):

- `BID_QUALIFIED` / `BID_DISQUALIFIED` — **نام‌ها را مدیر پروژه پذیرفت (2026-09-30).** `bidId`، `tenderId`، `organizationId`، `decidedBy`، `decidedAt`؛ `BID_DISQUALIFIED` فقط
  `reasonCode` (`NOT_ELIGIBLE | NON_RESPONSIVE | INTEGRITY_VIOLATION | OTHER`، Q-92) را هم دارد — **متن دلیل هرگز نمی‌آید.** هر پیشنهاد یک تصمیم دارد.
- `BIDS_EVALUATED` — **نام را مدیر پروژه پذیرفت (2026-09-30)؛ ستون `matrixDigest` افزوده شد.** `tenderId`، `projectId`، `organizationId`، `evaluatedBidCount` (پیشنهادهای `QUALIFIED`)، `matrixDigest`
  (SHA-256 به‌صورت hex از خطوط مرتب‌شدهٔ همهٔ تصمیم‌ها، کناره‌گیری‌ها و هر بازبینی هر خانه؛ ماتریس منجمدشده را مهر می‌کند)، `evaluatedBy`، `evaluatedAt`. نه نمره، نه رتبه، نه برنده. هر مناقصه **یک** `BIDS_EVALUATED` دارد.
- `BID_SCORED` — **افزودهٔ CON-002 برای S-06؛ مدیر پروژه پذیرفت (2026-10-02، دور اول بازبینی #190).** `bidId`، `tenderId`، `organizationId`، `evaluationId`، `evaluatorId`، `recordedCount` (خانه‌های نوشته‌شده؛ هر یک بازبینی تازه)، `scoresDigest`
  (SHA-256 از خطوط `criterionCode|revision|scoreScaled`، مرتب و پیوسته با `\n`)، `scoredAt`. **خود نمره‌ها روی رویداد نیست.** نمرهٔ برابر با نمرهٔ ایستاده چیزی نمی‌نویسد و رویدادی ندارد.
- `BID_EVALUATOR_RECUSED` — **افزودهٔ CON-002 برای S-06؛ مدیر پروژه پذیرفت (2026-10-02).** `bidId`، `tenderId`، `organizationId`، `evaluatorId`، `reasonCode` (`CONFLICT_OF_INTEREST | OTHER`)، `recusedAt`.

`BID_ACCESSED`: فیلد تازهٔ `refusalCode` (کد بستهٔ دلیل رد: دلیل رد مثل `CONFLICT_OF_INTEREST`، `NOT_OPENED`، `RECUSED`، یا کد خطای پلتفرم مثل `NOT_FOUND`؛ در `GRANTED` برابر `null`) و هدف‌های تازهٔ
`OWN_BID_CONTENT` (پیمانکار پیشنهاد بازشدهٔ خودش را می‌خواند)، `QUALIFY_BID`، `SCORE_BID`، `RECUSE`، `EVALUATE_BIDS` (فرمان ارزیابی؛ بی `bidId` برای `EVALUATE_BIDS`) و `READ_EVALUATION` (خواندن ماتریس، به‌ازای هر پیشنهاد).
هر رد (از جمله تعارض منافع) ردیف `REFUSED` با کدش دارد. فیلد `refusalCode` و ستون `matrixDigest` را مدیر پروژه پذیرفت (2026-10-02). **`audit-service` کد را می‌خواند و در `bid_access_evidence.refusal_code` نگه می‌دارد** (ستون تهی‌پذیر، مهاجرت برگشت‌پذیر `20261002160000_bid_access_refusal_code`؛ الحاقی می‌ماند): فقط یک رد کد دارد و کد باید بسته باشد (الگوی `^[A-Z][A-Z0-9_]{0,63}$`)، وگرنه رویداد ناقرارداد است (DLQ). رویدادِ پیش از این فیلد همچنان ثبت می‌شود، بی کد. `down.sql` تا وقتی ردیفی کد دارد رد می‌کند.

**پیاده‌شده در CON-002 PR 10 (انتخاب برنده؛ ADR-067 § ۳).** سه رویداد (`aggregateType = Tender`، کلید `tenderId`؛ فقط شناسه، پرچم، شمار، Digest و لحظه، `.strict()` — **هرگز مبلغ**)، دو تای اول در تراکنشِ `award`:

- `TENDER_AWARDED` — **نام از فهرست `docs/04` و `docs/07` است؛ ستون `matrixDigest` افزوده شد و مبلغ برداشته شد (مدیر پروژه، 2026-10-03).** `tenderId`، `projectId`، `organizationId`، `winningBidId`، `winnerOrganizationId`،
  `hasJustification` (متن دلیل فقط در پایگاه داده است)، `matrixDigest` (همان `BIDS_EVALUATED`: انتخاب بر ماتریسِ منجمدِ همین Digest انجام شد)، `awardedBy`، `awardedAt`. نه رتبه، نه نمره، نه پیشنهاددهندهٔ دیگر.
  هر مناقصه **یک** `TENDER_AWARDED` دارد؛ CON-003 قرارداد را با کلید Idempotency `tenderId` می‌سازد.
- `BID_NOT_AWARDED` — **افزودهٔ CON-002 برای خبردادن به بازندگان فقط با رویداد (بی تغییر notification-service)؛ مدیر پروژه پذیرفت (2026-10-03، ثبت زیر Q-84 مانند بقیه).** یکی به‌ازای هر پیشنهاد `QUALIFIED` که برنده نشد (`QUALIFIED → NOT_AWARDED`):
  `bidId`، `tenderId`، `organizationId` (مالک)، `bidderOrganizationId`، `decidedAt`. **نه برنده، نه مبلغ، نه رتبه، نه نمره** (Q-89: بازنده وضعیت و جمع خودش را از API و با مجوز خودش می‌بیند). پیشنهادِ ردصلاحیت‌شده
  پیش‌تر `BID_DISQUALIFIED` گرفته و پس‌گرفته‌شده خبر لازم ندارد. شمار رویدادها با شمار بازندگان می‌رسد (بدون سقف؛ ناچیز در MVP).
- `TENDER_AWARD_STANDING_CONFLICT_DETECTED` — **افزودهٔ CON-002 (کنترل کشفی؛ حکم مدیر پروژه، دور اول #199)؛ نام، هشدارها و runbook را مدیر پروژه پذیرفت (2026-10-03، ثبت زیر Q-84 مانند بقیه).** نه در درخواست `award` که توسط جاروکنندهٔ بررسی ماندگار (`tender_award_standing_check`) و در همان تراکنشی نوشته می‌شود که ردیف را `DONE` می‌کند. پس از Commit انتخاب، supplier-service گفت برنده ممکن است در بازهٔ میان خواندن شایستگی پیش از انتخاب و Commit معلق شده یا صلاحیتش برداشته شده باشد:
  `tenderId`، `projectId`، `organizationId`، `winningBidId`، `winnerOrganizationId`، `awardedBy`، `awardedAt`، `windowStart` (لحظهٔ خواندن شایستگی پیش از انتخاب)، `checkedAt` (ساعت supplier-service هنگام پاسخ، پس از Commit)،
  `suspensionIds` (حداکثر ۲۰) و `suspensionCount`، `qualificationRemoved`. فقط شناسه و شمار. بررسی محافظه‌کارانه است (تعلیقی که در بازه آغاز و پایان یافته هم می‌شمرد)؛ انتخاب پس گرفته نمی‌شود؛ هشدار `RastaConstructionAwardStandingConflictDetected`.

- `TENDER_APPROVAL_ACTION` — **افزودهٔ CON-002 PR 11 (الگوی `BID_ACCESSED`)؛ نام را مدیر پروژه بپذیرد.** هر درخواست، تصمیم، اجرا و ردِ دروازه‌های موافقتِ مناقصه (Q-84)، با همان تراکنشی که کار را می‌کند (ردّ در تراکنشی جدا، بهترین تلاش) و ردیف `tender_approval_log`. `REQUEST`: درخواست باز شد (یا فرمان رد شد)؛ `GRANT`/`REJECT`: تصمیم یک گام؛ `EXECUTE`: فرمانِ تصویب‌شده اجرا و موافقت مصرف شد (رویداد خود فرمان — `TENDER_PUBLISHED`/`TENDER_AWARDED`/`TENDER_CANCELLED` — هم می‌آید و `approvalRequestId` دارد)؛ `STALE`: سیستم درخواستی را که دیگر با مناقصه نمی‌خواند پایان داد؛ `READ`: خواندنِ جزئیات موافقتِ انتخاب رد شد (فقط ردّ). **نه دلیل، نه توجیه، نه پیشنهاد، نه مبلغ** (`.strict()` هر فیلد دیگر را رد می‌کند). `aggregateType = Tender`، کلید `tenderId`.

`BID_ACCESSED`: هدف تازهٔ `READ_AWARD` — خواندن award ذخیره‌شده (مبلغ برنده) با `GET /v1/tenders/{id}/award`، توسط شخص مجاز مالک یا `contract-service` (ثبت‌شده با `accessedBy = service:contract-service`)؛ و هدف تازهٔ `AWARD_TENDER` — خواندن مبلغ پیشنهاد برنده در `award` (`bidId` = برنده)؛ و رد هر `award` (از جمله `WINNER_NOT_ELIGIBLE`، `JUSTIFICATION_REQUIRED`، `CONFLICT_OF_INTEREST`، `AWARDER_IS_EVALUATOR`،
`APPROVAL_POLICY_REQUIRED`) با `bidId` پیشنهادِ نام‌برده (اگر از همان مناقصه باشد) و `refusalCode` بسته.

**مصرف در `audit-service` (برآمد Tender-Evidence، گروه `audit-service.tender-evidence`):** `BID_SUBMITTED`/`BID_REVISED` به
`tender_receipt_link` (الحاقی) می‌روند و پیوستگی زنجیره هنگام درج وارسی می‌شود. رسیدی که پیش از پیشینش برسد **نگه داشته می‌شود**
(`tender_receipt_pending`) و در تراکنشِ الحاق پیشینش به ترتیب تخلیه می‌شود؛ شکافِ باز پس از `AUDIT_TENDER_GAP_ALERT_SECONDS` هشدار
می‌دهد. دوشاخه‌شدن و ناسازگاری `tenantId` پاکت با `payload.organizationId` (یا `aggregateId` با `payload.tenderId`) پذیرفته
نمی‌شود (DLQ و هشدار). `BID_ACCESSED` با فیلدهای شناسه‌ای و `outcome` واقعی (`GRANTED | REFUSED`) در `bid_access_evidence` می‌ماند.
سرِ زنجیره را فقط `GET /v1/internal/tender-evidence/{tenderId}/chain` (`@AllowService('construction-service')`، با توکن امضاشده برای
سازمان مالکِ Tender؛ جستجو با سازمان و Tender) می‌دهد.

**پیاده‌شده در CON-002 PR 2:** `TENDER_CREATED` و `TENDER_CANCELLED` (`from` وضعیت پیشین، `reasonCode` از مجموعهٔ بستهٔ
`OWNER_REQUEST | NO_QUALIFIED_BID`؛ دلیل نوشتاری فقط در پایگاه داده) و **`TENDER_UPDATED`** (`changedFields[]`، فقط نام فیلدها؛ مثل
`PROJECT_UPDATED`، برای پوشش S-06 از ویرایش پیش‌نویس) — **`TENDER_UPDATED` در فهرست هشت‌تایی نبود؛ مدیر پروژه آن را پذیرفت (2026-09-30) — فقط نام فیلدها، هرگز مقدارشان.**
همه با `aggregateType = Tender` و کلید پارتیشن `tenderId`. بقیه هنوز تولید نمی‌شوند.

**پیاده‌شده در CON-002 PR 4a (دو رویداد افزوده، منتظر پذیرش مدیر پروژه — برای پوشش S-06 از تغییر معیارها):**
`TENDER_CRITERIA_SET` (`aggregateType = Tender`، کلید `tenderId`؛ `criteriaCount`، `totalWeightBp`، `templateId` یا `null`، `setBy`،
`setAt`) و `CRITERIA_TEMPLATE_CREATED` (`aggregateType = CriteriaTemplate`، کلید `{organizationId}/{templateId}`؛ `version`،
`criteriaCount`، `totalWeightBp`، `createdBy`، `createdAt`). هیچ‌کدام کد، برچسب یا متن معیار را حمل نمی‌کنند (`.strict()`).
این دو را مدیر پروژه پذیرفت (2026-09-30).

**پیاده‌شده در CON-002 PR 4b:** `TENDER_PUBLISHED` (رویداد کاتالوگ؛ `aggregateType = Tender`، کلید `tenderId`؛ `visibility`،
`bidOpeningAt`، `bidClosingAt`، `criteriaCount`، `keyId` — شناسهٔ کدر جفت‌کلید، `publishedBy`، `publishedAt`؛ **نه** عنوان، متن،
معیار یا کلید عمومی) و **`TENDER_BIDDER_INVITED`** (`invitedOrganizationId`، `invitedBy`، `invitedAt`) — دومی برای پوشش S-06 از دعوت
افزوده شد و **مدیر پروژه پذیرفت (2026-09-30؛ فقط شناسه‌ها)**.

**`assetsUsed` روی Kafka نمی‌آید** (بازبینی Codex روی #122). شناسه‌های دارایی گزارش پیشرفت فقط در قالب شناسهٔ
دارایی پلتفرم (`AST_<ULID>`، `assetIdSchema` در `@rasta/contracts`) پذیرفته می‌شوند — هر چیز دیگر `400` — و همراه
گزارش در پایگاه داده می‌مانند؛ ولی تا مالکیتشان در برابر `asset-service` سنجیده نشود، روی `rasta.construction.v1`
منتشر نمی‌شوند (`.strict()` فیلد را رد می‌کند). مصرف‌کننده هرگز ادعای سنجیده‌نشدهٔ «پروژهٔ P از دارایی A استفاده کرد»
را نمی‌خواند.

**رویدادهای افزودهٔ CON-001** (پذیرفته‌شده به‌دست مدیر پروژه، 2026-09-26). هر تغییر وضعیت پروژه و نیاز باید به
`audit-service` برسد (`AGENTS.md` S-06، A-08)، و کاتالوگ برای ویرایش پروژه، لغو، و چرخهٔ نیاز رویدادی نداشت — همان
شکافی که `DRIVER_UPDATED` و `SUPPLIER_REINSTATED` بستند.

| رویداد                       | مصرف‌کنندگان      | Payload کلیدی                                                                        |
| ---------------------------- | ----------------- | ------------------------------------------------------------------------------------ |
| **`PROJECT_UPDATED`**        | audit · analytics | `projectId`, `organizationId`, `changedFields[]`, `updatedBy`, `updatedAt`           |
| **`PROJECT_STATUS_CHANGED`** | audit · analytics | `projectId`, `organizationId`, `from`, `to`, `changedBy`, `changedAt`                |
| **`PROJECT_NEED_ADDED`**     | audit · analytics | `projectId`, `needId`, `organizationId`, `addedBy`, `addedAt`                        |
| **`PROJECT_NEED_UPDATED`**   | audit             | `projectId`, `needId`, `organizationId`, `changedFields[]`, `updatedBy`, `updatedAt` |
| **`PROJECT_NEED_SUBMITTED`** | audit · analytics | `projectId`, `needId`, `organizationId`, `submittedBy`, `submittedAt`                |
| **`PROJECT_NEED_WITHDRAWN`** | audit · analytics | `projectId`, `needId`, `organizationId`, `withdrawnBy`, `withdrawnAt`                |

`PROJECT_UPDATED` و `PROJECT_NEED_UPDATED` فقط **نام** فیلدهای تغییریافته را حمل می‌کنند، نه مقدارشان (همان قاعدهٔ
`ASSET_UPDATED` و `DRIVER_UPDATED`). `PROJECT_STATUS_CHANGED` گذارهایی را می‌پوشاند که رویداد اختصاصی ندارند — در PR
نخست فقط لغو (`to = CANCELLED`)، و در PR دوم ورود به `PENDING_APPROVAL`، `APPROVED` و `CHANGES_REQUESTED`. گذارهای
`PROJECT_STARTED` و `PROJECT_COMPLETED` رویداد خودشان را دارند و `PROJECT_STATUS_CHANGED` تکراری برایشان منتشر
نمی‌شود. دلیل لغو یا انصراف روی رویداد نمی‌آید؛ در `project.status_reason` و `project_need.withdrawal_reason` می‌ماند.

**رویدادهای تازهٔ CON-001 PR دوم** (پذیرفته‌شده به‌دست مدیر پروژه، 2026-09-26). نوشتن، فعال‌سازی و بازنشسته‌کردن سیاست موافقت و
پیش‌نویس و کنارگذاشتن گزارش پیشرفت تغییر وضعیت‌اند و باید به `audit-service` برسند (S-06). رویدادهای سیاست دربارهٔ
`ApprovalPolicy` هستند، نه پروژه، و کلیدشان `{organizationId}/{workflowKey}` است: همهٔ نسخه‌های سیاست یک گردش‌کار
یک جریان‌اند.

| رویداد                                  | مصرف‌کنندگان | Payload کلیدی                                                                                                                                                                                                                                                |
| --------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **`APPROVAL_POLICY_CREATED`**           | audit        | `policyId`, `organizationId`, `authorOrganizationId`, `authorRole`, `workflowKey`, `policyVersion`, `stepCount`, `isSample`, `createdBy`, `createdAt`                                                                                                        |
| **`APPROVAL_POLICY_SUBMITTED`**         | audit        | `policyId`, `organizationId`, `workflowKey`, `policyVersion`, `submittedBy`, `submittedAt`                                                                                                                                                                   |
| **`APPROVAL_POLICY_REJECTED`**          | audit        | `policyId`, `organizationId`, `workflowKey`, `policyVersion`, `rejectedBy`, `rejectedAt`                                                                                                                                                                     |
| **`APPROVAL_POLICY_ACTIVATED`**         | audit        | `policyId`, `organizationId`, `workflowKey`, `policyVersion`, `retiredPolicyId`, `activatedBy`, `activatedAt`                                                                                                                                                |
| **`APPROVAL_POLICY_RETIRED`**           | audit        | `policyId`, `organizationId`, `workflowKey`, `policyVersion`, `retiredBy`, `retiredAt`                                                                                                                                                                       |
| **`APPROVAL_POLICY_SUSPENDED`**         | audit        | `policyId`, `organizationId`, `authorOrganizationId`, `workflowKey`, `policyVersion`, `fromStatus`, `reason` (`ORGANIZATION_MOVED` \| `ROUND_OPENING_RECHECK`), `causeEventId` and `movedOrganizationId` (null for the latter), `suspendedBy`, `suspendedAt` |
| **`PROJECT_PROGRESS_REPORT_DRAFTED`**   | audit        | `projectId`, `reportId`, `organizationId`, `draftedBy`, `draftedAt`                                                                                                                                                                                          |
| **`PROJECT_PROGRESS_REPORT_DISCARDED`** | audit        | `projectId`, `reportId`, `organizationId`, `discardedBy`, `discardedAt`                                                                                                                                                                                      |

**دو رویداد گام تأیید پلتفرم** (نام‌ها پذیرفته‌شده به‌دست مدیر پروژه، 2026-09-26؛ همان الگوی Aggregate + فعل گذشته). Q-70 بند ۷ (تصمیم مالک، 2026-09-26) گام تأیید پلتفرم را
افزود: `APPROVAL_POLICY_SUBMITTED` (`DRAFT → PENDING_PLATFORM_APPROVAL`) و `APPROVAL_POLICY_REJECTED`
(`PENDING_PLATFORM_APPROVAL → REJECTED`). دلیل رد روی رویداد نمی‌آید و روی سیاست می‌ماند. `APPROVAL_POLICY_CREATED`
اکنون نویسنده را هم حمل می‌کند (`authorOrganizationId`، `authorRole` ∈ `UNION_ADMIN`/`SYSTEM_ADMIN`)، و
`APPROVAL_POLICY_ACTIVATED` نتیجهٔ تأیید `SYSTEM_ADMIN` است (`activatedBy` همان تأییدکننده).

## Contract — `rasta.contract.v1`

| رویداد                                           | مصرف‌کنندگان                                           | Payload کلیدی                                                                                                                                                                                                                                                                                  |
| ------------------------------------------------ | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTRACT_DRAFTED`                               | audit                                                  | `contractId`, `tenderId`, `projectId`, `organizationId`, `contractorOrganizationId`, `winningBidId`, `draftedAt` — **پیاده‌شده (CON-003 PR 1)؛ بی مبلغ**                                                                                                                                       |
| ~~`CONTRACT_CREATED`~~                           | ~~construction · notification~~                        | ~~`contractId`, `tenderId`, `parties[]`, `amount`~~ — **جایش را `CONTRACT_DRAFTED` گرفت** (پایین)                                                                                                                                                                                              |
| `CONTRACT_SIGNATURE_RECORDED`                    | audit                                                  | `contractId`, `organizationId`, `side`, `signerOrganizationId`, `signedBy`, `authorityRole`, `signedAt` — **پیاده‌شده (CON-003 PR 2)؛ بی مبلغ**                                                                                                                                                |
| `CONTRACT_SIGNED`                                | audit (+ construction · economic · notification بعداً) | `contractId`, `tenderId`, `projectId`, `organizationId`, `contractorOrganizationId`, `winningBidId`, `employerSignedAt`, `contractorSignedAt`, `signedAt` — **پیاده‌شده (CON-003 PR 2)؛ بی مبلغ، بی امضاکننده**                                                                                |
| `CONTRACT_CANCELLED`                             | audit                                                  | `contractId`, `tenderId`, `projectId`, `organizationId`, `contractorOrganizationId`, `reasonCode`, `cancelledAt` — **پیاده‌شده (CON-003 PR 2)**                                                                                                                                                |
| `CONTRACT_AMENDED`                               | audit · analytics                                      | `contractId`, `amendmentId`, `amendmentNumber`, `organizationId`, `contractorOrganizationId`, `reasonCode`, `employerSignedAt`, `contractorSignedAt`, `effectiveAt` — **پیاده‌شده (CON-003 PR 3)؛ بی مبلغ و بی متن** (جایگزین `deltaAmount`)                                                   |
| `CONTRACT_AMENDMENT_PROPOSED`                    | audit                                                  | `contractId`, `amendmentId`, `amendmentNumber`, `organizationId`, `contractorOrganizationId`, `reasonCode`, `proposedBy`, `proposedAt` — **پیاده‌شده (CON-003 PR 3)؛ بی مبلغ و بی متن**                                                                                                        |
| `CONTRACT_AMENDMENT_SIGNATURE_RECORDED`          | audit                                                  | `contractId`, `amendmentId`, `organizationId`, `side`, `signerOrganizationId`, `signedBy`, `authorityRole`, `policyId`, `policyVersion`, `signedAt` — **پیاده‌شده (CON-003 PR 3)**                                                                                                             |
| `CONTRACT_AMENDMENT_SIGNATURE_AUTHORITY_FLAGGED` | audit                                                  | `contractId`, `amendmentId`, `organizationId`, `side`, `policyId`, `policyVersion`, `reason`, `detectedBy` (`ORGANIZATION_MOVED` \| `MOVE_RECHECK`)، `causeEventId` و `movedAt` (`null` برای `MOVE_RECHECK`)، `movedVersion`, `flaggedAt` — **پیاده‌شده (CON-003 PR 3)**؛ فقط با نسخه، بی ساعت |
| `CONTRACT_MILESTONE_PLANNED`                     | audit                                                  | `contractId`, `milestoneId`, `organizationId`, `contractorOrganizationId`, `plannedBy`, `plannedAt` — **پیاده‌شده (CON-003 PR 3)؛ بی عنوان، تاریخ و سهم**                                                                                                                                      |
| `CONTRACT_MILESTONE_CHANGED`                     | audit                                                  | `contractId`, `milestoneId`, `organizationId`, `contractorOrganizationId`, `version`, `changedBy`, `changedAt` — **پیاده‌شده (CON-003 PR 3)**                                                                                                                                                  |
| `CONTRACT_AUTHORITY_REFUSED`                     | audit                                                  | `contractId`, `organizationId`, `action`, `side`, `subjectId`, `reason`, `policyId`, `refusedBy`, `refusedAt` — **پیاده‌شده (CON-003 PR 3)**                                                                                                                                                   |
| `STATEMENT_SUBMITTED`                            | notification · analytics                               | `statementId`, `contractId`, `grossAmount`                                                                                                                                                                                                                                                     |
| `STATEMENT_APPROVED`                             | **economic (پرداخت)** · analytics                      | `statementId`, `netAmount`, `deductions`, `technicalApprover`, `financialApprover`                                                                                                                                                                                                             |
| `STATEMENT_REJECTED`                             | notification                                           | `statementId`, `reason`                                                                                                                                                                                                                                                                        |
| `CONTRACT_COMPLETED`                             | supplier (امتیاز) · analytics                          | `contractId`, `finalAmount`                                                                                                                                                                                                                                                                    |

**پیاده‌شده در CON-003 PR 1 (ADR-068 § ۳ و § ۴).** یک رویداد؛ سایر ردیف‌های بالا **طرح**‌اند (PR 2..6) و هنوز تولید نمی‌شوند.

- `CONTRACT_DRAFTED` — **نام از دستور مدیر پروژه (2026-10-05)؛ حذف `amount`/`parties[]` نسبت به `CONTRACT_CREATED` را مدیر پروژه باید بپذیرد** (جایگزین آن).
  `aggregateType = Contract`، کلید پارتیشن `contractId`، `.strict()`: `contractId`، `tenderId`، `projectId`، `organizationId` (کارفرما، مستأجر قرارداد)،
  `contractorOrganizationId`، `winningBidId`، `draftedAt`. **هرگز مبلغ:** مبلغ برنده محتوای یک پیشنهاد است و Topic را `audit-service` در کل
  می‌خواند؛ مصرف‌کننده‌ای که مبلغ لازم دارد از API می‌پرسد (همان دلیل `TENDER_AWARDED`، #199). در **همان** تراکنشی نوشته می‌شود که ردیف `contract` را
  می‌سازد (Outbox)، و `causationId` = شناسهٔ `TENDER_AWARDED` است. هر مناقصه حداکثر یک `CONTRACT_DRAFTED` دارد (یکتایی `(organization_id, tender_id)`).
  **پیاده‌شده در CON-003 PR 2 (ADR-068 § ۲، ردیف‌های `DRAFT → SIGNED` و `DRAFT → CANCELLED`).** هر سه `.strict()`، `aggregateType = Contract`، کلید پارتیشن `contractId`، و هر کدام در **همان** تراکنشی که وضعیت را تغییر می‌دهد (Outbox)؛ هیچ‌کدام مبلغ ندارد.

- `CONTRACT_SIGNATURE_RECORDED` — برای **هر یک** از دو امضا یک‌بار: `side` ∈ `EMPLOYER`/`CONTRACTOR`، سازمانی که امضاکننده برایش عمل کرده، `signedBy` (شناسهٔ کاربر؛ امضای بی‌شخص رکورد حسابرسی نیست)، نقشی که امضا با آن پذیرفته شد، و برای کارفرما `policyId`/`policyVersion` (سیاست `contract.signature` که اختیار را داد؛ برای پیمانکار `null`). جفت هویت پایدار برای بررسی تفکیک وظایف (#188) در پایگاه داده‌ی همین سرویس می‌ماند و روی Topic نمی‌آید.
- `CONTRACT_SIGNED` — فقط با امضای **دوم** و فقط یک‌بار؛ فقط لحظه‌ها و سازمان‌ها، بی امضاکننده. `signedAt` = دیرترین دو امضا. (`docs/08` § 8.3: `AWARDED → CONTRACTED`.) ردیف قدیمی `signatories[]` با این جایگزین شد؛ مصرف‌کنندگان دیگر (construction، economic، notification) با PRهای بعدی افزوده می‌شوند.
- `CONTRACT_CANCELLED` — فقط **کد دلیل بسته**؛ یادداشت متنی آزاد در پایگاه داده می‌ماند و از API برای دو طرف خوانده می‌شود (متن آزاد مشتری است و Topic را همهٔ سرویس‌ها می‌خوانند).
- **الحاقیه و Milestone (CON-003 PR 3؛ ADR-068 § ۹، Q-100).** `aggregateType = Contract`، کلید پارتیشن `contractId`، `.strict()`، فقط شناسه، کد بسته و لحظه — **هرگز مبلغ (`deltaMinor`)، `reasonText`، عنوان، تاریخ برنامه‌ای یا سهم** (Topic مشترک است). `CONTRACT_AMENDED` (کاتالوگ: `deltaAmount`) با امضای **دوم** و فقط یک‌بار، در همان تراکنشی که الحاقیه را مؤثر و `amendments_total_minor` را زیاد می‌کند؛ مصرف‌کنندهٔ نیازمند مبلغ از API می‌پرسد (همان دلیل `CONTRACT_DRAFTED`؛ پذیرفتن حذف مبلغ با مدیر پروژه). `CONTRACT_AUTHORITY_REFUSED`: `action` ∈ `PROPOSE_AMENDMENT`/`SIGN_AMENDMENT`/`PLAN_MILESTONE`/`CHANGE_MILESTONE`، `reason` ∈ `ROLE_NOT_PERMITTED`/`NOT_EMPLOYER`/`SIGNATURE_POLICY_REQUIRED`/`POLICY_AUTHOR_NOT_GOVERNING` — فقط برای ردِ **طرف** قرارداد، در تراکنشی جدا؛ برای غیرطرف هرگز (او `404` می‌گیرد).
- `APPROVAL_POLICY_CREATED` · `_SUBMITTED` · `_REJECTED` · `_ACTIVATED` · `_RETIRED` · `_SUSPENDED` — سیاستی که می‌گوید چه نقش‌هایی از سازمان کارفرما برای او امضا می‌کنند (ADR-068 § ۵؛ همان سازوکار و همان شکل رویدادهای `construction-service`). `APPROVAL_POLICY_SUSPENDED` (دور دوم بازبینی #231، Q-83): `authorOrganizationId`، `fromStatus` (`ACTIVE` \| `PENDING_PLATFORM_APPROVAL`)، `reason` (`ORGANIZATION_MOVED` \| `MOVE_RECHECK` \| `SIGNING_RECHECK`)، `causeEventId` و `movedOrganizationId` (فقط برای `ORGANIZATION_MOVED`؛ برای دو دیگر `null` — رویدادی که علتِ ثابت‌شده نیست نام برده نمی‌شود، دور ۶)، `suspendedBy` (بازیگر سیستمی `system:contract-service`) و `suspendedAt`؛ دلیل متنی روی رویداد نمی‌آید.
  `aggregateType = ApprovalPolicy`؛ کلید پارتیشن `(organizationId)/(workflowKey)` تا همهٔ نسخه‌های یک خط سیاست روی یک پارتیشن بمانند؛ `.strict()`: `policyId`، `organizationId`، `workflowKey` (`contract.signature`)، `policyVersion` و چه‌کسی/چه‌وقت (و برای `CREATED` نویسنده و تعداد گام‌ها،
  برای `ACTIVATED` سیاستِ بازنشسته‌شده). **هرگز برچسب، توجیه، دلیل رد یا نقش‌ها**: آن‌ها با خودِ سیاست می‌مانند و از API خوانده می‌شوند.

- **مصرف:** گروه `contract-service.tender-awarded` روی `rasta.construction.v1` (+ `.retry`)، DLQ ‏`rasta.contract.v1.dlq`. کلید Idempotency = `tenderId`
  (در مستأجر). پیش از نوشتن، award از مالکش پرسیده و با رویداد سنجیده می‌شود: عدم تأیید ⇒ `SOURCE_UNCONFIRMED`؛ منبع در دسترس نیست ⇒ تلاش دوباره و
  سپس `UPSTREAM_UNAVAILABLE`؛ پاکت و Payload یک مستأجر نیستند ⇒ `SOURCE_UNCONFIRMED` پیش از هر پرسش؛ تکرار متناقض ⇒ `VALIDATION_FAILED`؛ تکرار همان ⇒ `SKIPPED`.
- `CONTRACT_SIGNATURE_AUTHORITY_FLAGGED` (D-050، #231 r3): امضای کارفرما که `ORGANIZATION_MOVED` ممکن است با آن همزمان شده باشد، برای بازبینی علامت خورده است — `contractId`، `organizationId`، `side` (`EMPLOYER`)، `policyId`، `policyVersion`، `reason` (`AUTHORITY_CHANGED_DURING_SIGNING`)، `detectedBy` (`ORGANIZATION_MOVED` \| `MOVE_RECHECK`)، `causeEventId` و `movedAt` (دقیقاً یکی از دو حالت، دور ۸: برای `ORGANIZATION_MOVED` هر دو مقدار دارند؛ برای `MOVE_RECHECK` — جابه‌جایی‌ای که بازبینی را صف کرد، ولی علتِ آن ثابت نشد — هر دو `null`؛ یکی بدون دیگری شکلِ منتشرشده نیست)، `movedVersion` (نسخهٔ سلسله‌مراتبِ جابه‌جایی که نسخهٔ ثبت‌شدهٔ امضا از آن کمتر بود؛ `null` برای رویداد بی‌نسخه)، `flaggedAt`؛ هرگز لغو نیست. `CONTRACT_SIGNATURE_REFUSED`: امضای رد‌شده برای نبود اختیار، در تراکنشی جدا Commit می‌شود — `contractId`، `organizationId`، `side`، `reason` (`SIGNATURE_POLICY_REQUIRED` \| `POLICY_AUTHOR_NOT_GOVERNING`)، `policyId` (یا `null`)، `refusedBy`، `refusedAt`. هر دو `aggregateType = Contract`، کلید `contractId`، بی متن آزاد.
- **`ORGANIZATION_MOVED.hierarchyVersion` (D-050، #231 دور ۴):** عدد صحیح ≥ ۱ که `organization-service` در **همان تراکنشِ** جابه‌جایی روی سازمان و همهٔ نوادگانش می‌زند (`max + 1` زیر قفل سلسله‌مراتب؛ ستون `organization.hierarchy_version`). پاسخ سرویس‌به‌سرویسِ `GET /v1/organizations/{id}` (فقط construction و contract) اکنون `{ id, hierarchyVersion }` است. مصرف‌کننده نسخهٔ خوانده‌شده را ثبت می‌کند و جابه‌جایی را با **عدد** ترتیب می‌دهد، نه مهر زمانی. فیلد برای مصرف‌کنندهٔ قدیمی افزایشی است.
- **مصرف دوم (Q-83):** گروه `contract-service.organization-moves` روی `rasta.organization.v1` (+ `.retry`)، همان DLQ؛ فقط `ORGANIZATION_MOVED`، به‌عنوان **ماشه** نه پاسخ: برای هر سیاستِ نوشتهٔ اتحادیه یک وظیفهٔ بازبینی در صف پایدار می‌گذارد (بدون هیچ فراخوانی شبکه‌ای در Handler؛ تکرار و `.retry` در همان وظیفهٔ باز ادغام می‌شوند) و پاروبِ پس‌زمینه از `organization-service` می‌پرسد و تعلیق می‌کند.
- Topic، تولیدکننده/مصرف‌کننده و ACLهای کافکا از `packages/contracts` (`TOPIC_PRODUCERS`، `TOPIC_CONSUMERS`) با `pnpm kafka:acl:generate` تولید می‌شوند؛
  `audit-service` برچسب منبع `rasta.contract.v1` را هم می‌خواند.

## Economic — `rasta.economic.v1`

**تولیدکننده واقعی از 2026-08-29.** هر یازده رویداد پیاده و زنده تأیید شده‌اند.
Schema رسمی در `services/economic-service/src/events/events.ts` و اعتبارسنجی
**پیش از رسیدن به Outbox** انجام می‌شود.

| رویداد                                   | مصرف‌کنندگان                                        | Payload واقعی                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WALLET_OPENED`                          | notification                                        | `walletId`, `organizationId`, `currency`, `openedAt`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `FUNDS_HELD`                             | marketplace (Saga) · analytics                      | `holdId`, `walletId`, `organizationId`, `transactionId`, `reference`, `referenceType`, `amountMinor`, `currency`, `heldAt`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `FUNDS_RELEASED`                         | marketplace · analytics                             | `holdId`, `walletId`, `transactionId`, `reference`, `amountMinor`, `currency`, **`resolution`**, `resolvedAt`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `PAYMENT_AUTHORIZED`                     | marketplace · contract                              | `paymentIntentId`, `organizationId`, `walletId`, `amountMinor`, `currency`, `provider`, **`simulated`**, `authorizedAt`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `PAYMENT_COMPLETED`                      | marketplace · maintenance · contract · notification | `paymentIntentId`, `transactionId`, `journalId`, `amountMinor`, `currency`, `provider`, **`simulated`**, `completedAt`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PAYMENT_FAILED`                         | **marketplace (جبران)** · notification              | `paymentIntentId`, `amountMinor`, `currency`, `provider`, **`simulated`**, `reason`, `failedAt`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `PAYMENT_CAPTURE_UNRECONCILED`           | audit · هشدار عملیات                                | `paymentIntentId`, `organizationId`, `walletId`, `amountMinor`, `currency`, `provider`, **`simulated`**, **`reason`** (`WALLET_BALANCE_LIMIT`/`CAPTURE_NOT_CREDITED`), **`providerRefund`** (`DECLINED`/`UNKNOWN`), `detectedAt` — Capture شده، اعتبار نگرفته، بازپرداخت Provider موفق نشده؛ در همان تراکنش علامت `CAPTURED_NOT_CREDITED` (Provider بازپرداخت را **رد کرد**؛ تلاش دوباره با همان کلید اعتبار را ثبت می‌کند) یا `CAPTURED_REFUND_UNKNOWN` (فراخوانی **بی‌پاسخ** شکست خورد؛ شاید بازپرداخت شده باشد، پس هیچ تلاش دوباره‌ای اعتبار نمی‌دهد — ADR-064، U6)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PAYMENT_REFUND_UNRECONCILED`            | audit · هشدار عملیات                                | `paymentIntentId`, `organizationId`, `walletId`, `amountMinor`, `currency`, `provider`, **`simulated`**, **`reason`** (`PROVIDER_OUTCOME_UNKNOWN`/`PROVIDER_DECLINED_RELEASE_PENDING`/`INSUFFICIENT_BALANCE`/`REVERSAL_FAILED`), `detectedAt` — بازپرداخت اپراتور که نتیجه‌اش ثبت نشد. مبلغ پیش از پرسیدن از Provider Hold شده و Hold می‌ماند: `PROVIDER_OUTCOME_UNKNOWN` یعنی فراخوانی Provider **بی‌پاسخ** شکست خورد (علامت `REFUND_UNKNOWN`؛ بازپرداخت دوم رد می‌شود تا وضعیت Provider روشن شود)، دو دلیل دیگر یعنی Provider بازپرداخت کرد و معکوس‌کردن ثبت نشد (علامت `REFUNDED_NOT_REVERSED`؛ تلاش دوباره بی پرسیدن از Provider معکوس می‌کند)، و `PROVIDER_DECLINED_RELEASE_PENDING` یعنی Provider رد کرد و برگرداندن Hold شکست خورد (علامت `REFUND_DECLINED_RELEASE_PENDING`؛ تلاش دوباره فقط Hold را برمی‌گرداند و هرگز دوباره از Provider نمی‌پرسد) — ADR-064، R2                                                                                                                                                                                                                                                                           |
| `PAYMENT_REFUNDED`                       | audit                                               | `paymentIntentId`, `organizationId`, `walletId`, `amountMinor`, `currency`, `reversalJournalId`, `refundedBy`, `provider`, **`simulated`**, `refundedAt` — بازپرداخت ثبت شد: Provider پول را برگرداند، Hold بازپرداخت به کیف برگشت، Journal شارژ با `reversalJournalId` معکوس شد و Intent `REFUNDED` است. در همان تراکنش `recordRefund` منتشر می‌شود — مسیر مشترک بازپرداخت اپراتور، آشتی‌دهنده و حل تأییدشدهٔ اپراتور — پس یک بار، و فقط برای بازپرداختی که در دفتر کل هست. بی Instrument و بی دلیل متنی (S-09) — ADR-064 § ۹                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `PAYMENT_REFUND_FAILED`                  | audit                                               | `paymentIntentId`, `organizationId`, `walletId`, `amountMinor`, `currency`, **`reason`** (`PROVIDER_DECLINED`), `provider`, **`simulated`**, `failedAt` — Provider بازپرداخت را رد کرد: پول نزد اوست، Hold بازپرداخت به کیف برگشت و Intent دوباره یک شارژ عادی `CAPTURED` است. در تراکنشی منتشر می‌شود که Hold را برمی‌گرداند (`returnDeclinedHold`)، و فقط همان تراکنش؛ تلاش دوباره پس از شکست مبهم دوباره اعلام نمی‌کند. حداکثر یک بار به‌ازای (Intent، کلید بازپرداخت Provider)، با کلید اصلی `payment_refund_decline` در همان تراکنش — تکرار همان درخواست پس از آزادشدن کلید Idempotency دوباره اعلام نمی‌کند. بازپرداختی که هرگز به Provider نرسید رد نیست و اینجا اعلام نمی‌شود (`PAYMENT_RECONCILIATION_RESOLVED` با `REFUND_NOT_REACHED`) — ADR-064 § ۹                                                                                                                                                                                                                                                                                                                                                                                     |
| `PAYMENT_RECONCILIATION_ESCALATED`       | audit · هشدار عملیات                                | `paymentIntentId`, `organizationId`, `walletId`, **`kind`** (`REFUND`/`UNCREDITED_REFUND`), **`marker`** (علامت B0، یا null وقتی دیگر نیست), **`lastOutcome`** (کد بسته، مثل `PROVIDER_OUTCOME_UNKNOWN`/`HOLD_WITHOUT_MARKER`)، `attempts`, `amountMinor`, `currency`, `provider`, **`simulated`**, `escalatedAt` — آشتی‌دهنده پس از سقف تلاش یا سن، یا در وضعیتی که نباید حدس بزند، بازپرداخت ناتمام را به انسان سپرد. **Hold می‌ماند.** در همان تراکنشی که تسک `ESCALATED` می‌شود — ADR-064 گام B2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `PAYMENT_RECONCILIATION_RESOLVED`        | audit                                               | `paymentIntentId`, `organizationId`, `walletId`, **`kind`**, **`marker`** (علامتی که یافت، یا null), **`providerRefund`** (`REFUNDED`/`DECLINED`/`NOT_FOUND`، یا null وقتی علامت معلوم بود و پرسیده نشد), **`resolution`** (`REFUNDED`/`REFUND_DECLINED`/`REFUND_NOT_REACHED`/`UNCREDITED_REFUNDED`/`UNCREDITED_DECLINED`/`UNCREDITED_NOT_REACHED`/`NOTHING_TO_RECONCILE`), **`resolvedBy`** (`PAYMENT_RECONCILER`، یا تأییدکنندهٔ حل انسانی), `attempts`, `amountMinor`, `currency`, `provider`, **`simulated`**, `resolvedAt`، و برای حل انسانی (B3) **`resolutionId`**, **`proposedBy`**, **`approvedBy`**, **`evidenceReference`** (مرجع شاهد، الگو‌محدود، نه متن آزاد), **`fourEyes`** — بازپرداخت ناتمام حل شد؛ در همان تراکنشی که پول (اگر جابه‌جا شود) جابه‌جا و تسک `DONE` می‌شود — ADR-064 گام B2 **audit-service نمای فهرست‌سفید v1 را نگه می‌دارد** (`payment_reconciliation_evidence`، D-046، #204): `resolution`, `resolvedBy`, `kind` و برای حل انسانی `resolutionId`, `proposedBy`, `approvedBy`, `evidenceReference`, `fourEyes` (هر پنج یا هیچ) — نه مبلغ، Provider یا متن؛ محمولهٔ ناسازگار هیچ ردیفی نمی‌نویسد و به DLQ می‌رود. |
| `PAYMENT_RECONCILIATION_OPERATOR_ACTION` | audit                                               | `paymentIntentId`, `organizationId`, `walletId`, **`kind`**, **`action`** (`REQUEUED`/`PROPOSED`/`REJECTED`), **`actor`**, `requeueId` (برای `REQUEUED`: ردیفی که دلیل را نگه می‌دارد؛ وگرنه null), `resolutionId` (یا null برای `REQUEUED`), **`providerOutcome`** (`REFUNDED`/`DECLINED`/`NOT_REACHED`، یا null), **`evidenceReference`** (یا null), **`proposedBy`** (برای `REJECTED`: پیشنهاددهندهٔ ردشده), **`fourEyes`**, `amountMinor`, `currency`, `provider`, **`simulated`**, `occurredAt` — اپراتور بی جابه‌جایی پول روی آشتی بازپرداخت کاری کرد؛ تأیید، `PAYMENT_RECONCILIATION_RESOLVED` است. دلیل متنی در سرویس می‌ماند. هرگز خودکار بازپخش نمی‌شود — ADR-064 گام B3 **audit-service نمای فهرست‌سفید v1 را نگه می‌دارد** (`payment_reconciliation_evidence`، D-046، #204): `action`, `actor`, `requeueId`, `resolutionId`, `providerOutcome`, `evidenceReference`, `proposedBy`, `fourEyes`, `kind` — نه مبلغ، Provider یا متن؛ محمولهٔ ناسازگار هیچ ردیفی نمی‌نویسد و به DLQ می‌رود.                                                                                                                                                 |
| `COMMISSION_APPLIED`                     | **analytics (درآمد پلتفرم)** · audit                | `commissionId`, `transactionId`, `organizationId`, **`ruleId` (nullable)**, `rateBasisPoints`, `grossAmountMinor`, `amountMinor`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `REWARD_GRANTED`                         | notification · analytics                            | `rewardId`, `userId`, `ruleId`, `triggerEvent`, `sourceReference`, `points`, `creditAmountMinor`, **`monetised`**, `journalId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `REWARD_LEVEL_CHANGED`                   | notification                                        | `organizationId`, `userId`, `from` (nullable), `to`, `totalPoints`, `changedAt`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `SETTLEMENT_COMPLETED`                   | marketplace · supplier · notification               | `settlementId`, `transactionId`, `payerOrganizationId`, `payeeOrganizationId`, `journalId`, `grossAmountMinor`, `commissionAmountMinor`, `netAmountMinor`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `JOURNAL_POSTED`                         | audit · analytics                                   | `journalId`, `transactionId`, `journalType`, `reversesJournalId`, `entries[]` (حداقل دو)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `COMMISSION_RULE_CHANGED`                | audit                                               | `ruleId`, **`change`** (`CREATED`/`UPDATED`), `changedBy`, `changedAt`, **`before` (nullable)**, `after` — شرایط کامل قاعده، نرخ به Basis Point                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `REWARD_RULE_CHANGED`                    | audit                                               | `ruleId`, `change`, `changedBy`, `changedAt`, `before` (nullable), `after` — شرایط کامل قاعده، `creditPerPointMinor` به‌صورت رشته                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `TRANSACTION_STATUS_CHANGED`             | audit                                               | `transactionId`, `organizationId`, `counterpartyOrganizationId` (nullable), `transactionType`, **`action`**, **`fromStatus`** (nullable فقط در ثبت), `toStatus`, `grossAmountMinor`, `currency`, `changedBy`, `changedAt` — بدون متن آزاد دلیل                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

**کلید پارتیشن هر بیست‌ویک رویداد (ADR-036).** «درباره چیست» و «با چه چیزی مرتب
می‌ماند» دو پرسش‌اند و اینجا برای چهار رویداد پاسخشان یکی نیست:

| رویداد                                   | Aggregate (Envelope) | کلید پارتیشن                     |
| ---------------------------------------- | -------------------- | -------------------------------- |
| `WALLET_OPENED`                          | `Wallet`             | `walletId`                       |
| `FUNDS_HELD`                             | `WalletHold`         | **`transactionId`**              |
| `FUNDS_RELEASED`                         | `WalletHold`         | **`transactionId`**              |
| `PAYMENT_AUTHORIZED`                     | `PaymentIntent`      | `paymentIntentId`                |
| `PAYMENT_COMPLETED`                      | `PaymentIntent`      | **`transactionId`**              |
| `PAYMENT_FAILED`                         | `PaymentIntent`      | `paymentIntentId`                |
| `PAYMENT_CAPTURE_UNRECONCILED`           | `PaymentIntent`      | `paymentIntentId`                |
| `PAYMENT_REFUND_UNRECONCILED`            | `PaymentIntent`      | `paymentIntentId`                |
| `PAYMENT_REFUNDED`                       | `PaymentIntent`      | `paymentIntentId`                |
| `PAYMENT_REFUND_FAILED`                  | `PaymentIntent`      | `paymentIntentId`                |
| `PAYMENT_RECONCILIATION_ESCALATED`       | `PaymentIntent`      | `paymentIntentId`                |
| `PAYMENT_RECONCILIATION_RESOLVED`        | `PaymentIntent`      | `paymentIntentId`                |
| `PAYMENT_RECONCILIATION_OPERATOR_ACTION` | `PaymentIntent`      | `paymentIntentId`                |
| `COMMISSION_APPLIED`                     | `Commission`         | `transactionId`                  |
| `REWARD_GRANTED`                         | `Reward`             | `rewardId`                       |
| `REWARD_LEVEL_CHANGED`                   | `RewardBalance`      | `${organizationId}:${userId}`    |
| `SETTLEMENT_COMPLETED`                   | `Settlement`         | `transactionId`                  |
| `JOURNAL_POSTED`                         | `Journal`            | **`transactionId ?? journalId`** |
| `COMMISSION_RULE_CHANGED`                | `CommissionRule`     | `ruleId`                         |
| `REWARD_RULE_CHANGED`                    | `RewardRule`         | `ruleId`                         |
| `TRANSACTION_STATUS_CHANGED`             | `Transaction`        | `transactionId`                  |

`PAYMENT_AUTHORIZED` و `PAYMENT_FAILED` عمداً تراکنشی نیستند: در لحظه انتشارشان
هیچ تراکنشی وجود ندارد (`PaymentIntent.transaction_id` هنگام Capture نوشته
می‌شود) و اختراع یکی، نوشتن شناسه‌ای دروغین در یک Payload مالی است. قاعده در
`services/economic-service/src/events/routing.ts` تنها یک‌جا نوشته شده و افزودن
رویداد بدون تصمیم درباره ترتیب، Compile نمی‌شود.

**چهار قاعده که در جدول بالا پیدا نیست:**

- **پول همیشه رشته در واحد فرعی است**، کنار یک `currency` صریح — هرگز عدد JSON
  (ADR-022). شکل مسطح `amountMinor` + `currency` استفاده می‌شود، نه شیء تودرتو،
  چون `maintenance-service` از پیش همین را منتشر می‌کند.
- **`simulated` روی هر رویداد پرداخت اجباری است.** ADR-024 هر ادعای اتصال بانکی
  را ممنوع می‌کند و سکوت خودش یک ادعاست.
- **`resolution` و `monetised` وجود دارند تا مصرف‌کننده مجبور به حدس نباشد.**
  یک `FUNDS_RELEASED` بدون `resolution` مصرف‌کننده‌ای را که سفارش لغوشده را
  جبران می‌کند از یکی که سفارش تحویل‌شده را می‌بندد، جدا نمی‌کند. یک
  `creditAmountMinor: "0"` بدون `monetised` «فقط امتیاز» را از «نرخی که به صفر
  گرد شد» جدا نمی‌کند.
- **`ruleId` می‌تواند `null` باشد و این حالت واقعی است، نه دفاعی:** بدون قاعده
  فعال، کارمزد صفر است و قاعده‌ای برای نام بردن وجود ندارد (ADR-023، Q-08).

### مصرف‌شده توسط economic — فعال در برابر موکول (ADR-032)

| رویداد                                                                             | وضعیت                                                                         |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `MAINTENANCE_APPROVED`                                                             | **فعال.** یک تعهد `PENDING_SETTLEMENT` ثبت می‌کند و **هیچ پولی حرکت نمی‌دهد** |
| `USAGE_RECORDED` · `MAINTENANCE_COMPLETED`                                         | **فعال.** محرک پاداش                                                          |
| `ORDER_CREATED` · `ORDER_RECEIPT_CONFIRMED` · `ORDER_CANCELLED` · `ORDER_DISPUTED` | **موکول** — قرارداد فقط طرح فیلدهای کلیدی است                                 |
| `STATEMENT_APPROVED` · `PURCHASE_ORDER_ISSUED` · `GOODS_RECEIVED`                  | **موکول** — همان دلیل                                                         |

موکول‌ها **Stub ندارند**. یک Handler خالی در `processed_event` رد می‌گذارد و
دقیقاً شبیه یکی است که کار کرد. آنچه آن جریان‌ها لازم دارند از راه API در
دسترس است — که همان چیزی است که `docs/08` § ۸٫۶ می‌خواهد.

## Document — `rasta.document.v1`

| رویداد                 | مصرف‌کنندگان                      | Payload کلیدی                                                                                             |
| ---------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `DOCUMENT_UPLOADED`    | مالک منبع · audit                 | `documentId`, `documentClass`, `contentType`, `scanState` (همیشه `PENDING`)                               |
| `DOCUMENT_SCANNED`     | مالک منبع · audit                 | `documentId`, `scanState`, `engine`, `signatureVersion`, `failureReason`                                  |
| `DOCUMENT_DELETED`     | audit                             | `documentId`, `reason`                                                                                    |
| `VIRUS_DETECTED`       | **notification (بحرانی)** · audit | `documentId`, `engine`, `signature`                                                                       |
| `UPLOAD_INTENT_ISSUED` | **audit**                         | `uploadIntentId`, `documentClass`, `declaredContentType`, `declaredSizeBytes`, `requestedBy`, `expiresAt` |

**هر رویدادِ دربارهٔ یک سند با `documentId` کلید می‌خورد**، پس تاریخچهٔ یک سند روی **یک** Partition می‌نشیند
— شرط لازمِ مرتب‌ماندن، و امروز نه شرط کافی‌اش (¹ بالا، D-027).
این از ADR-049 به بعد باربر است: اسکن ناهمزمان شد، پس `DOCUMENT_UPLOADED` همیشه
`PENDING` حمل می‌کند و نتیجه بعداً به‌عنوان `DOCUMENT_SCANNED` می‌رسد — دنباله‌ای که فقط
اگر دنباله بماند معنا دارد. مصرف‌کننده‌ای که `SCANNED` را پیش از `UPLOADED` ببیند دربارهٔ
سندی رأی می‌شنود که هرگز نشنیده وجود دارد.

**`DOCUMENT_SCANNED` برای هر نتیجهٔ نهایی منتشر می‌شود، نه فقط برای خبر خوب.** یک اسکن
`FAILED` دقیقاً همان چیزی است که مصرف‌کننده پیش از گفتن «پیوست شما آماده است» باید بداند،
و جریانی که فقط موفقیت‌ها را حمل کند سکوت را دومعنا می‌کند.

**`VIRUS_DETECTED` جدا می‌ماند** و در کنار یک نتیجهٔ `INFECTED` منتشر می‌شود، نه به‌جای
آن: اولی تغییر وضعیتی است که هر مصرف‌کنندهٔ علاقه‌مند می‌خواند و دومی یافته‌ای امنیتی است
که notification-service بحرانی می‌داندش. تنها از موتوری که واقعاً محتوا را بازرسی کرده
منتشر می‌شود — یافتهٔ ساختگی بدتر از سکوت است، چون کسی رویش عمل می‌کند.

**`UPLOAD_INTENT_ISSUED` (L7-14، 2026-09-25) استثناست:** هنوز سندی وجود ندارد، پس با `uploadIntentId` خودش کلید می‌خورد
(Aggregate: `UploadIntent`). رکورد حسابرسیِ اجازهٔ بارگذاری است، در همان تراکنشِ ردیف Intent و پیش از امضای URL؛ آنچه
مشتری **اعلام** کرده را حمل می‌کند — نه کلید شیء، نه URL، نه نام فایل.

**هیچ‌کدام کلید شیء، Bucket، Endpoint یا URL امضاشده حمل نمی‌کنند.** رویداد هفت روز در
Log ای می‌ماند که هر سرویسی می‌خواندش. تست `events.spec.ts` این را روی **همهٔ** Schema ها
با هم بررسی می‌کند، نه فقط روی آنکه اول نوشته شد.

## Notification — `rasta.notification.v1`

> **از 2026-09-19 تولیدکننده دارد.** `notification-service` سه رویداد حسابرسی زیر را منتشر می‌کند؛ دو رویداد تحویل
> (`NOTIFICATION_SENT`، `NOTIFICATION_FAILED`) هنوز با NTF-004 می‌آیند. Payload هیچ نشانی و هیچ متن پیامی حمل نمی‌کند.

### رویدادهای حسابرسی — NTF-002 (2026-09-19)

خواندن، نادیده‌گرفتن و «همه را خوانده‌شده کن» **تغییر وضعیت‌اند**، و `AGENTS.md` S-06 برای هر تغییر وضعیت رکورد حسابرسی
می‌خواهد. `audit-service` تنها یک ورودی دارد: لاگ رویداد. نبودن این سه رویداد در `ADR-054 § ۳` به‌عنوان **انحراف از یک
قاعدهٔ الزام‌آور** ثبت شده بود، نه به‌عنوان انتخاب دامنه، و پذیرش `NTF-002` را مسدود کرده بود.

| رویداد                   | Aggregate         | مصرف‌کنندگان | Payload                                                                             |
| ------------------------ | ----------------- | ------------ | ----------------------------------------------------------------------------------- |
| `NOTIFICATION_READ`      | InAppNotification | **audit**    | `notificationId`, `organizationId`, `userId`, `occurredAt`                          |
| `NOTIFICATION_DISMISSED` | InAppNotification | **audit**    | `notificationId`, `markedReadByDismissal`, `organizationId`, `userId`, `occurredAt` |
| `NOTIFICATION_ALL_READ`  | NotificationInbox | **audit**    | `count`, `organizationId`, `userId`, `occurredAt`                                   |

**کلید پارتیشن هر سه `userId` است** — گیرنده، نه اعلان. خواندن و نادیده‌گرفتنِ یک نفر باید به همان ترتیبی برسد که رخ داده،
و Kafka ترتیب را فقط درون یک Partition تضمین می‌کند. کلیدزدن با `notificationId` صندوق ورودی یک نفر را روی چند Partition
پخش می‌کرد.

سه تصمیم دربارهٔ محتوا که عمدی‌اند:

- **هیچ عنوان و متنی حمل نمی‌شود.** محتوای اعلان از قبل در جدول همین سرویس هست و برای واقعیت منبع، در رویدادی که آن را
  ساخته. کپی‌کردنش در لاگی که هر سرویسی می‌خواند و نگه می‌دارد، جزئیات عملیاتی مستأجر را بیش از نیاز هر مصرف‌کننده‌ای
  پخش می‌کند.
- **`NOTIFICATION_ALL_READ` یک رویداد با شمارنده است، نه یکی به‌ازای هر ردیف.** کسی با دویست اعلان نخوانده، وگرنه برای یک
  کلیک دویست رویداد تولید می‌کرد — که به حسابرس کمتر می‌گوید تا یک رویداد که دقیقاً همین را می‌گوید.
- **کنشی که چیزی را عوض نکرده، چیزی منتشر نمی‌کند.** خواندنِ دوبارهٔ یک اعلانِ خوانده‌شده رویداد نمی‌دهد. به‌روزرسانی شرطی
  همان چیزی است که این Endpoint ها را Idempotent می‌کند، و شمارندهٔ سطرهای تغییرکرده تنها پاسخ صادقانه به «آیا چیزی عوض
  شد» است.

### تنظیمات شخص — L7-14 (2026-09-25)

تغییر ترجیح‌ها و بازهٔ سکوت هم تغییر وضعیت‌اند و همان ارزش شاهدی را دارند: «ایمیل این قاعده را پیش از یادآوری خاموش کرده
بود» واقعیتی است که اختلاف بر سر «آیا به او گفته شد» رویش می‌چرخد.

| رویداد                              | Aggregate               | مصرف‌کنندگان | Payload                                                                     |
| ----------------------------------- | ----------------------- | ------------ | --------------------------------------------------------------------------- |
| `NOTIFICATION_PREFERENCES_REPLACED` | NotificationPreferences | **audit**    | `preferences[]` (کل مجموعهٔ جدید), `organizationId`, `userId`, `occurredAt` |
| `NOTIFICATION_QUIET_HOURS_CHANGED`  | NotificationQuietHours  | **audit**    | `quietHours` (یا `null`), `organizationId`, `userId`, `occurredAt`          |

هر دو در همان تراکنشِ نوشتن، با کلید `userId`، و **فقط وقتی وضعیت ذخیره‌شده واقعاً عوض شده باشد** — همان قاعدهٔ
`NOTIFICATION_ALL_READ`. هیچ نشانی و هیچ محتوایی حمل نمی‌شود؛ فقط تنظیمات.

### آنچه `notification-service` مصرف می‌کند — NTF-001 (2026-09-17)

گروه مصرف‌کننده `notification-service.dispatcher` (همان نامی که § ۷٫۱۰ از پیش می‌برد)، `fromBeginning: false`،
DLQ اختصاصی `rasta.notification.v1.dlq`. **فقط دو Topic و سه رویداد:**

| Topic                  | رویداد                | قاعده                 | Subject               | سطل Dedupe                                                    |
| ---------------------- | --------------------- | --------------------- | --------------------- | ------------------------------------------------------------- |
| `rasta.insurance.v1`   | `INSURANCE_EXPIRING`  | `insurance.expiring`  | `InsurancePolicy`     | باند `daysRemaining` روی `{30, 14, 7, 3, 1}`                  |
| `rasta.insurance.v1`   | `INSPECTION_EXPIRING` | `inspection.expiring` | `TechnicalInspection` | باند `daysRemaining` روی `{30, 14, 7, 3, 1}`                  |
| `rasta.maintenance.v1` | `MAINTENANCE_DUE`     | `maintenance.due`     | `MaintenanceSchedule` | `state` (`DUE_SOON` و `OVERDUE` دو اعلان‌اند، تکرار یکی نیست) |

- هر رویداد دیگری روی این دو Topic **نادیده گرفته می‌شود** (`SKIPPED`)، نه DLQ. `BREAKDOWN_REPORTED` و
  `INSPECTION_FAILED` (قاعده‌های ۴ و ۵ برش هشت‌تایی) هنوز مصرف نمی‌شوند.
- Envelope بدون `tenantId`، Payload مردود از Schema قاعده، یا `organizationId` ناسازگار با `tenantId` → Poison → DLQ با
  `MAX_RETRIES_EXCEEDED` (رفتار `EventConsumer` مشترک). Idempotency مصرف روی `(eventId, consumerName)`؛ Dedupe معنایی روی
  `SHA256(organizationId | ruleKey | subjectType | subjectId | bucket)` با نگهداشت ۴۵ روز. `rasta.identity.v1` هنوز مصرف
  نمی‌شود (`USER_DEACTIVATED`/`MEMBERSHIP_REVOKED` با سرکوب تحویل‌های در انتظار می‌آید).
- گیرنده‌ها از `GET /v1/users?role=&status=ACTIVE` سرویس identity با Token داخلی `SERVICE` و `org_id` امضاشده حل می‌شوند
  (`@AllowService('notification-service')`، فقط همان یک Endpoint). **هیچ نشانی‌ای وارد Kafka یا پایگاه دادهٔ notification نمی‌شود.**

| رویداد                | مصرف‌کنندگان | Payload کلیدی                              |
| --------------------- | ------------ | ------------------------------------------ |
| `NOTIFICATION_SENT`   | analytics    | `notificationId`, `channel`, `recipientId` |
| `NOTIFICATION_FAILED` | analytics    | `notificationId`, `channel`, `reason`      |

## Audit — `rasta.audit.trail.v1`

> **وضعیت — 2026-09-11 (AUD-004 Phase C1).** `audit-service` **ساخته شده** (AUD-001..003، `docs/04` § ۴٫۱۵) و مسیر
> نخستِ ورودی‌اش — Projector روی هر ده Topic دامنه‌ای، `docs/07` § ۷٫۱۰ — زنده است. این Topic **مسیر دوم** است
> (ADR-053 § ۱)، و آنچه در ادامه می‌آید فقط دربارهٔ همین مسیر دوم صادق است:
>
> - **قرارداد وجود دارد (Phase A).** `packages/contracts/src/events/audit-trail.ts` رویداد `AUDIT_EVENT_RECORDED`
>   (**نسخهٔ ۱**) را با Zod Schema پیاده می‌کند و از `packages/contracts/src/index.ts` صادر می‌شود.
> - **Consumer وجود دارد (Phase B).** `AuditTrailConsumer` در `audit-service` با گروه ثابت `audit-service.trail` فقط
>   همین Topic را می‌خواند — جدا از گروه Projector، و بی‌اعتنا به `KAFKA_CONSUMER_GROUP`. پیش از هر نوشتن به‌ترتیب
>   بررسی می‌کند: Envelope استاندارد Parse شود؛ `eventName === AUDIT_EVENT_RECORDED` و `eventVersion === 1` روی همین
>   Topic؛ Payload با `auditTrailPayloadSchemaV1`؛ و **توافق مستأجر، بسته در خطا**: `payload.organizationId` دقیقاً
>   برابر `envelope.tenantId`، یا هر دو غایب برای رکورد پلتفرمی — هر ترکیب دیگر (یک‌طرفه، ناهمسان، تهی) رد می‌شود و
>   مستأجر هرگز از Actor یا Resource حدس زده نمی‌شود. پیام ردشده **هیچ ردیف و هیچ نشانگر `processed_event`** نمی‌سازد؛
>   Throw می‌شود، Retry می‌شود و به `rasta.audit.v1.dlq` می‌رود، و خطا/Log فقط مسیر Schema و نام کلید دارد، نه مقدار.
>   Idempotency روی `(eventId, 'audit-service.trail')` در همان تراکنشِ ردیف و زنجیرهٔ Hash است؛ فضای نام آن از مسیر A
>   جداست. اصلاح یک **ردیف تازه** با `correction_of` است، هرگز UPDATE.
> - **یک Producer، برای یک رد (Phase C1).** `identity-service` تنها سرویسی است که روی این Topic می‌نویسد، و فقط یک
>   رد را: `POST /v1/users/me/active-organization` که با `403 TENANT_MISMATCH` رد می‌شود. Exception Filter ردیف را در
>   جدول محلی `security_event_outbox` می‌نویسد (تراکنش کوتاه و کراندار؛ شکستش پاسخ `403` را عوض نمی‌کند) و Relay دوم
>   (ADR-050) آن را پس از اعتبارسنجی Envelope و Payload منتشر می‌کند. مقادیر ثابت این Producer: `outcome = REFUSED`،
>   `occurrenceCount = 1`، `action = identity.active_organization.switch`، `resourceType = User`، `resourceId` =
>   شناسهٔ خود کاربر (همان کلید Partition)، مستأجر = سازمانی که فراخوان از طرفش عمل می‌کرد — هرگز سازمان درخواستی.
> - **وضعیت 2026-09-12 — دو بند بالا دیگر همهٔ امروز نیستند.** Producerِ ردها در `identity-service` اکنون **نُه** محل رد
>   دارد (AUD-004 Phase C1–C10: محل دامنه‌ای `SWITCH_ACTIVE_ORGANIZATION`، هفت Route دارای `@Roles` و `TENANT_MISMATCH`ِ خودِ
>   `AuthGuard`) و ردهای یکسان را در یک پنجرهٔ UTC در یک ردیف با `occurrenceCount` تجمیع می‌کند (Phase C2)؛ ردیف فقط پس از
>   بسته‌شدن پنجره منتشر می‌شود.
> - **Producerِ اصلاح وجود دارد (نیمهٔ اصلاحِ AUD-003).** `POST /v1/audit-corrections` در `identity-service` (فقط
>   `SYSTEM_ADMIN`، `Idempotency-Key` الزامی) هدف را از راه Endpoint داخلی `audit-service` اثبات می‌کند و **یک**
>   `AUDIT_EVENT_RECORDED` v1 را از `outbox_message` **استاندارد** identity — نه `security_event_outbox` — و با Relay
>   استاندارد (ADR-050) منتشر می‌کند، در همان تراکنشِ رکورد Idempotency. مقادیر ثابت: `action = audit.correction`،
>   `resourceType = AuditEvent`، `resourceId = correctionOf =` شناسهٔ هدف، `outcome = SUCCESS`، بی `errorCode`، `reason`
>   الزامی، `changes` با Redaction، `occurrenceCount = 1`؛ Actor و نقش‌ها از Token تأییدشده؛ مستأجر فقط از هدفِ اثبات‌شده
>   (برای هدفِ پلتفرمی، هم `organizationId` و هم `tenantId` غایب)؛ `aggregateType/aggregateId = AuditEvent`/شناسهٔ هدف و
>   **کلید Partition = شناسهٔ هدف**. شکل HTTP فرمان تصمیم موقت **Q-53** است.
> - **هنوز ساخته نشده:** رول‌اوت به هر سرویس دیگر (R-2)، ثبت ردهایی که Gateway یک Hop زودتر می‌گیرد،
>   `SERVICE_TENANT_CONTEXT_INVALID`/`FORBIDDEN`، صادرات، Purge، امضا و قاعدهٔ هشدار. سطر «همه سرویس‌ها روی این Topic
>   می‌نویسند» زیر همچنان **نیت طراحی** ADR-053 § ۱ است، نه رفتار امروز — جزئیات در
>   [ADR-053 implementation plan](../adr/ADR-053-implementation-plan.md) § ۴ و § ۵.
> - **Runbook (2026-09-12).** رکورد حسابرسیِ مورد انتظار که نرسیده، یا پیام در `rasta.audit.v1.dlq` →
>   [`audit-gap-detected.md`](../runbooks/audit-gap-detected.md)؛ رکورد ثبت‌شده‌ای که با زنجیره‌اش نمی‌خواند →
>   [`audit-chain-divergence.md`](../runbooks/audit-chain-divergence.md)؛ صف ردهای identity →
>   [`security-event-outbox.md`](../runbooks/security-event-outbox.md).
> - `Proposed`. جزئیات کامل ADR-053 در
>   [ADR-053](../adr/ADR-053-audit-service-append-only-evidence.md).

**نیت طراحی — چه کسی روی این Topic خواهد نوشت، وقتی Producerها ساخته شوند.** همهٔ سرویس‌ها (ADR-053 § ۱: هر رویداد
پرامتیاز یا رد که مسیر A ساختاراً نمی‌تواند بسازد). **تنها مصرف‌کننده** `audit-service` است، زیر گروه مصرف‌کنندهٔ
`audit-service.trail` (ADR-053 § ۱، § ۸).

**کلید Partition.** قاعدهٔ پیش‌فرض همین سند (ستون «قواعد» بالا): `aggregateId` — که برای یک رکورد معمولی همان
`resourceId` عمل حسابرسی‌شده است، و برای یک اصلاح همان `correctionOf`. وقتی عملی `resourceId` ندارد، `actor.id`
جایگزین می‌شود (پیاده‌سازی implementation plan § ۵).

| رویداد                 | نسخه | Payload (v1)                                                                                                                                                                                              |
| ---------------------- | :--: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUDIT_EVENT_RECORDED` |  ۱   | `actor {type, id, roles[]}`, `organizationId?`, `action`, `resourceType`, `resourceId`, `outcome`, `errorCode?`, `reason?`, `changes[]?`, `occurrenceCount`, `source? {ip?, userAgent?}`, `correctionOf?` |

**چهار ناورداییِ اصلاح، در Schema اجباری‌اند** (ADR-053 § ۷): `correctionOf` حاضر باشد یعنی `action ===
'audit.correction'`، `outcome === 'SUCCESS'`، `reason` غیرخالی، و `actor.type === 'USER'` — هرکدام نبود، Schema رد
می‌کند. **مجوزدهی، Redaction و تجمیعِ ردها در این Schema نیست** — همه سمتِ Producer‌اند (`identity-service`).

**آنچه Consumer افزون بر Schema رد می‌کند — بدون بازنویسی هیچ مقدار.** تغییری در `changes` که میدانش (یا یک بخش نقطه‌دارِ
آن) در `SENSITIVE_KEYS` از `@rasta/logging` است و مقدار خامِ Scalar به‌جای `{redacted:true}`/`{hash}` دارد؛ `correctionOf`
بلندتر از ستون ۶۴ نویسه‌ای؛ `occurrenceCount` بیرون از بازهٔ `INTEGER`؛ و شناسه‌های تهی (`actor.id`، `resourceType`،
`resourceId`، `reason`، `correctionOf`). هرکدام **رد** می‌شود، نه کوتاه یا اصلاح: این جدول تنها جایی است که مقدارِ نشت‌کرده
هرگز از آن حذف نمی‌شود، و پیوند اصلاحِ کوتاه‌شده به رکوردی اشاره می‌کند که هیچ‌کس نام نبرده. **آنچه Consumer بررسی
نمی‌کند:** اینکه رکوردِ `correctionOf` واقعاً وجود دارد یا در همان مستأجر است — این بر عهدهٔ Producer فرمان اصلاح است.

---

## بازپخش DLQ — `rasta.ops.replay.v1`

رکورد پلتفرم از هر بازپخش اجراشده (D-039، [`docs/runbooks/replay-dlq.md`](../runbooks/replay-dlq.md) گام ۳). **تنها
ناشر** ابزار بازپخش اپراتور است، Principal `ops-replay` (`TOPIC_PRODUCERS`؛ ACL Broker هیچ سرویسی را اجازهٔ نوشتن
نمی‌دهد)؛ **تنها مصرف‌کننده** audit-service با گروه ثابت `audit-service.ops-replay` که هر رکورد را فقط‌الحاقی در
`audit_event` نگه می‌دارد. قرارداد: `packages/contracts/src/events/ops-replay.ts`.

**یک رکورد برای هر رویداد بازپخش‌شده، در همان تراکنش Kafka که بازپخش را روی `.retry` می‌نویسد** (شناسهٔ تراکنشی
`ops-replay.<reportId>`؛ مصرف‌کننده‌ها فقط Commit‌شده می‌خوانند): هر دو با هم Commit می‌شوند یا هیچ‌کدام دیده نمی‌شود — و بی
رکورد جداگانهٔ «شروع». کلید
پیام شناسهٔ گزارش اجرا است (یک اجرا روی یک پارتیشن، به ترتیب)؛ `correlationId` همان شناسه است تا یک اجرا با یک جست‌وجو
بازسازی شود. `tenantId` مستأجرِ رویداد بازپخش‌شده است و باید با `replayedEvent.tenantId` یکی باشد — رویداد بی مستأجر
رکورد پلتفرمی می‌سازد (فقط `SYSTEM_ADMIN`، ADR-053 § ۱۰). `actor` کاربری است به نام اپراتور (`REPLAY_OPERATOR`،
ادعای دارندهٔ اعتبار `ops-replay`). **هرگز Payload رویداد بازپخش‌شده.**

| رویداد            | نسخه | Payload (v1)                                                                                                                                                                           |
| ----------------- | :--: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REPLAY_EXECUTED` |  ۱   | `reportId`، `operator`، `replayedEvent {eventId, eventName, tenantId?}`، `dlq {topic, partition, offset}`، `target {topic, partition, offset}`، `stale` (`false`\|`true`\|`'UNKNOWN'`) |

Consumer هر رکوردی را که با خودش نخواند **رد** می‌کند (بازپخش و سپس DLQ `rasta.audit.v1.dlq`): نام یا نسخهٔ دیگر،
ناشری جز `ops-replay`، Topic دیگر، Payload ناسازگار با Schema، `correlationId` ≠ `reportId`، `actor` ≠ اپراتور، و
مستأجرِ ناهمخوان. ردیف: `action = REPLAY_EXECUTED`، `resourceType = Event` / `resourceId` = شناسهٔ رویداد بازپخش‌شده،
و در `changes` جابه‌جایی رویداد (Topic، Partition، Offset از DLQ به `.retry`) و نام رویداد و حکم کهنگی.

---

## افزودن رویداد جدید

```
۱. packages/contracts/src/events/<domain>.ts  →  نام + Zod Schema
۲. سرویس تولیدکننده  →  درج در outbox_message در همان تراکنش تغییر وضعیت
۳. سرویس مصرف‌کننده  →  Handler با processed_event برای Idempotency
۴. همین فایل  →  ثبت Producer، Consumer، Payload
۵. تست قرارداد  →  Payload تولیدشده با Schema مطابقت دارد
۶. تست Idempotency  →  پردازش دو باره اثر دوم ندارد
```
