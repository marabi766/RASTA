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

| رویداد               | Aggregate | مصرف‌کنندگان                                   | Payload کلیدی                         |
| -------------------- | --------- | ---------------------------------------------- | ------------------------------------- |
| `USER_REGISTERED`    | User      | notification · audit · analytics               | `userId`, `email`, `requestedRole`    |
| `USER_ACTIVATED`     | User      | notification · **economic (باز کردن کیف پول)** | `userId`, `organizationId`            |
| `USER_DEACTIVATED`   | User      | همه (ابطال Session)                            | `userId`, `reason`                    |
| `MEMBERSHIP_CREATED` | User      | audit · analytics                              | `userId`, `organizationId`, `roles[]` |
| `MEMBERSHIP_REVOKED` | User      | audit · gateway (ابطال Cache)                  | `userId`, `organizationId`            |
| `ROLE_ASSIGNED`      | User      | audit · **gateway (ابطال Cache مجوز)**         | `userId`, `organizationId`, `role`    |
| `ROLE_REVOKED`       | User      | audit · gateway                                | `userId`, `organizationId`, `role`    |

## Organization — `rasta.organization.v1`

| رویداد                        | مصرف‌کنندگان                                | Payload کلیدی                                  |
| ----------------------------- | ------------------------------------------- | ---------------------------------------------- |
| `ORGANIZATION_CREATED`        | **همه (Replica مرجع)** · economic (کیف پول) | `organizationId`, `name`, `type`, `parentId`   |
| `ORGANIZATION_UPDATED`        | همه (Replica مرجع)                          | `organizationId`, `changes`                    |
| `ORGANIZATION_MOVED`          | analytics · audit                           | `organizationId`, `fromParentId`, `toParentId` |
| `ORGANIZATION_DEACTIVATED`    | identity (ابطال عضویت) · همه                | `organizationId`, `reason`                     |
| `ORGANIZATION_POLICY_CHANGED` | audit                                       | `organizationId`, `policyKey`, `value`         |

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

| رویداد                | مصرف‌کنندگان                        | Payload کلیدی                                                |
| --------------------- | ----------------------------------- | ------------------------------------------------------------ |
| `INSURANCE_RECORDED`  | notification · analytics            | `assetId`, `policyId`, `insurerName`, `validFrom`, `validTo` |
| `INSURANCE_EXPIRING`  | **notification** · analytics        | `assetId`, `policyId`, `insurerName`, `daysRemaining`        |
| `INSURANCE_EXPIRED`   | fleet · notification · analytics    | `assetId`, `policyId`, `validTo`                             |
| `INSPECTION_RECORDED` | analytics                           | `assetId`, `inspectionId`, `certificateNo`, `result`         |
| `INSPECTION_EXPIRING` | notification                        | `assetId`, `inspectionId`, `daysRemaining`                   |
| `INSPECTION_FAILED`   | **fleet** · maintenance · analytics | `assetId`, `inspectionId`, `notes`                           |

`INSPECTION_FAILED` رویدادی ایمنی است، نه اداری: `fleet` باید بلافاصله دستگاه را از
فهرست قابل اعزام بردارد، و نباید مجبور باشد برای فهمیدن این موضوع فیلد `result` یک
رویداد عمومی «ثبت شد» را بازرسی کند. `daysRemaining` در رویدادهای انقضا حمل می‌شود تا
`notification` بتواند بدون محاسبه دوباره تاریخ، یادآور ۳۰ روزه را از ۳ روزه تشخیص دهد.

## Fleet — `rasta.fleet.v1`

> پیاده‌شده در `services/fleet-service/src/fleet/events.ts`. Schema هر Payload
> آنجاست و در زمان انتشار اعتبارسنجی می‌شود.

| رویداد                  | Aggregate          | مصرف‌کنندگان                                                        | Payload                                                                                                                                                        |
| ----------------------- | ------------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DRIVER_REGISTERED`     | Driver             | audit · analytics                                                   | `driverId`, `organizationId`, `userId`, `status`                                                                                                               |
| `DRIVER_STATUS_CHANGED` | Driver             | audit · analytics                                                   | `driverId`, `organizationId`, `userId`, `previousStatus`, `newStatus`, `reason`                                                                                |
| `ASSET_ASSIGNED`        | Assignment         | **asset (پرونده + وضعیت `ASSIGNED`)** · analytics                   | `assignmentId`, `assetId`, `driverId`, `organizationId`, `startedAt`, `purpose`                                                                                |
| `ASSIGNMENT_ENDED`      | Assignment         | **asset (پرونده + بازگشت به `ACTIVE`)** · analytics                 | `assignmentId`, **`assetId`**, `driverId`, `organizationId`, `startedAt`, `endedAt`, `reason`                                                                  |
| `USAGE_RECORDED`        | UsageRecord        | **maintenance (محرک سرویس)** · asset · economic (پاداش) · analytics | `usageRecordId`, `assetId`, `organizationId`, `driverId`, `assignmentId`, `periodStart`, `periodEnd`, `hours`, `kilometres`, `hourMeter`, `odometer`, `source` |
| `AVAILABILITY_CHANGED`  | AvailabilityWindow | construction · analytics                                            | `assetId`, `organizationId`, `available`, `reason`, `from`, `to`                                                                                               |

**کلید پارتیشن هر شش رویداد `assetId` است، نه `aggregateId`.** استثنای آگاهانه‌ای بر
قاعده § «کلید پارتیشن». هر مصرف‌کننده درباره **یک دستگاه** استدلال می‌کند — پرونده
الکترونیکی، برنامه سرویس کارکردمحور — و ترتیب فقط درون یک پارتیشن تضمین می‌شود. اگر
`ASSET_ASSIGNED` و `ASSIGNMENT_ENDED` یک دستگاه روی دو پارتیشن می‌نشستند، دستگاه
آزادشده می‌توانست برای همیشه در `ASSIGNED` گیر کند. (`DRIVER_*` هم به همین شکل کلید
ندارند و روی `aggregateId` می‌مانند، چون هیچ ترتیبی میان راننده و دستگاه لازم نیست.)

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
| **`INSPECTION_FAILED`**                    | asset         | **مسدودسازی فوری اعزام** — رویداد ایمنی                   |
| **`INSURANCE_EXPIRED`**                    | asset         | **مسدودسازی فوری اعزام**                                  |
| `MAINTENANCE_STARTED`                      | maintenance\* | `inMaintenance = true`                                    |
| `MAINTENANCE_COMPLETED`                    | maintenance\* | `inMaintenance = false` + رفع مسدودی اعزام                |

\* تولیدکننده هنوز ساخته نشده؛ اشتراک از امروز برقرار است تا راه‌اندازی
`maintenance-service` یک استقرار باشد، نه تغییر کد.

## Maintenance — `rasta.maintenance.v1`

> **پیاده‌شده و LIVE VERIFIED (2026-08-28).** `maintenance-service` نُه رویداد
> نخست زیر را تولید می‌کند؛ دهمی، `MAINTENANCE_SCHEDULE_CHANGED`، در 2026-09-19
> برای بستن `D-011` افزوده شد.
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
| `MAINTENANCE_SCHEDULE_CHANGED` | MaintenanceSchedule | **audit** · analytics                        | `scheduleId`, `assetId`, `organizationId`, `change`, `status`, `previousStatus`, `reason`, `changedFields[]`, `changedAt`, `changedBy`              |

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

**کلید پارتیشن هر ده رویداد `assetId` است، نه `aggregateId`** — همان استثنای
آگاهانه‌ای که `rasta.fleet.v1` دارد. هر مصرف‌کننده درباره **یک دستگاه** استدلال
می‌کند، و ترتیب فقط درون یک پارتیشن تضمین می‌شود. اگر `MAINTENANCE_STARTED` و
`MAINTENANCE_COMPLETED` یک دستگاه روی دو پارتیشن می‌نشستند، دستگاه تعمیرشده
می‌توانست برای همیشه در `IN_MAINTENANCE` بماند.

**هر ده رویداد `assetId` حمل می‌کنند — بدون استثنا.** ستون Payload نسخه پیشین
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

| رویداد                    | مصرف‌کنندگان                                             | Payload کلیدی                                                                                                                   |
| ------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `OFFER_PUBLISHED`         | search · analytics                                       | `offerId`, `productId`, `supplierOrganizationId`, `price`                                                                       |
| `ORDER_CREATED`           | **economic (Hold)** · inventory (رزرو) · notification    | `orderId`, `buyerOrganizationId`, `supplierOrganizationId`, `total`, `lines[]`, `promisedDeliveryAt` (اختیاری، ADR-052 § ۱-الف) |
| `ORDER_CONFIRMED`         | notification · analytics                                 | `orderId`                                                                                                                       |
| `ORDER_FULFILLED`         | notification · inventory                                 | `orderId`, `fulfillmentId`                                                                                                      |
| `ORDER_RECEIPT_CONFIRMED` | **economic (Release + تسویه + کارمزد)**                  | `orderId`, `confirmedBy`                                                                                                        |
| `ORDER_COMPLETED`         | economic (پاداش) · supplier (امتیاز) · asset · analytics | `orderId`, `total`                                                                                                              |
| `ORDER_CANCELLED`         | economic (بازگشت) · inventory (آزادسازی)                 | `orderId`, `reason`, `cancellationCause` (اختیاری، enum بسته، ADR-052 § ۱-پ)                                                    |
| `ORDER_DISPUTED`          | **economic (توقف تسویه)** · notification · supplier      | `orderId`, `disputeId`, `reason`                                                                                                |
| `ORDER_DISPUTE_RESOLVED`  | supplier (امتیاز)                                        | `orderId`, `disputeId`, `outcome`, `responsibility` (enum بسته، الزامی، ADR-052 § ۱-ب)                                          |
| `REVIEW_SUBMITTED`        | supplier (امتیاز) · economic (پاداش)                     | `orderId`, `rating`, `criteria`                                                                                                 |

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

| رویداد                      | مصرف‌کنندگان                                                      | Payload کلیدی                                    |
| --------------------------- | ----------------------------------------------------------------- | ------------------------------------------------ |
| `SUPPLIER_REGISTERED`       | analytics · audit                                                 | `supplierId`, `organizationId`, `capabilities[]` |
| `SUPPLIER_QUALIFIED`        | marketplace · procurement · construction                          | `supplierId`, `qualifiedFor[]`                   |
| `SUPPLIER_REJECTED`         | notification                                                      | `supplierId`, `reason`                           |
| `SUPPLIER_SUSPENDED`        | **marketplace (پنهان‌سازی پیشنهاد)** · procurement · construction | `supplierId`, `reason`, `until`                  |
| `PERFORMANCE_SCORE_UPDATED` | **marketplace (رتبه‌بندی)** · search                              | `supplierId`, `score`, `breakdown`               |

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

| رویداد                     | مصرف‌کنندگان                                            | Payload کلیدی                                          |
| -------------------------- | ------------------------------------------------------- | ------------------------------------------------------ |
| `PROJECT_CREATED`          | analytics · audit                                       | `projectId`, `title`, `estimate`, `location`           |
| `APPROVAL_REQUESTED`       | **notification (مرجع تأیید)** · audit                   | `approvalId`, `projectId`, `approvalType`, `authority` |
| `APPROVAL_GRANTED`         | notification · audit · analytics                        | `approvalId`, `grantedBy`, `conditions`                |
| `APPROVAL_REJECTED`        | notification · audit                                    | `approvalId`, `reason`                                 |
| `TENDER_CREATED`           | audit                                                   | `tenderId`, `projectId`, `procurementNature`           |
| `TENDER_PUBLISHED`         | **notification (پیمانکاران)** · search · analytics      | `tenderId`, `bidOpeningAt`, `bidClosingAt`             |
| `BID_SUBMITTED`            | notification · **audit (مهر زمانی)**                    | `bidId`, `tenderId`, `contractorId`, `submittedAt`     |
| `BIDS_EVALUATED`           | audit · analytics                                       | `tenderId`, `matrix`, `ranking`                        |
| `TENDER_AWARDED`           | **contract (ایجاد پیش‌نویس)** · notification · supplier | `tenderId`, `winnerId`, `amount`, `justification`      |
| `PROJECT_STARTED`          | fleet · analytics                                       | `projectId`, `contractId`                              |
| `PROJECT_PROGRESS_UPDATED` | contract · notification · analytics                     | `projectId`, `percentage`, `assetsUsed[]`              |
| `PROJECT_COMPLETED`        | contract · supplier (امتیاز) · analytics                | `projectId`, `completedAt`                             |

## Contract — `rasta.contract.v1`

| رویداد                | مصرف‌کنندگان                           | Payload کلیدی                                                                      |
| --------------------- | -------------------------------------- | ---------------------------------------------------------------------------------- |
| `CONTRACT_CREATED`    | construction · notification            | `contractId`, `tenderId`, `parties[]`, `amount`                                    |
| `CONTRACT_SIGNED`     | construction · economic · notification | `contractId`, `signedAt`, `signatories[]`                                          |
| `CONTRACT_AMENDED`    | audit · analytics                      | `contractId`, `amendmentId`, `deltaAmount`                                         |
| `STATEMENT_SUBMITTED` | notification · analytics               | `statementId`, `contractId`, `grossAmount`                                         |
| `STATEMENT_APPROVED`  | **economic (پرداخت)** · analytics      | `statementId`, `netAmount`, `deductions`, `technicalApprover`, `financialApprover` |
| `STATEMENT_REJECTED`  | notification                           | `statementId`, `reason`                                                            |
| `CONTRACT_COMPLETED`  | supplier (امتیاز) · analytics          | `contractId`, `finalAmount`                                                        |

## Economic — `rasta.economic.v1`

**تولیدکننده واقعی از 2026-08-29.** هر یازده رویداد پیاده و زنده تأیید شده‌اند.
Schema رسمی در `services/economic-service/src/events/events.ts` و اعتبارسنجی
**پیش از رسیدن به Outbox** انجام می‌شود.

| رویداد                 | مصرف‌کنندگان                                        | Payload واقعی                                                                                                                                             |
| ---------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WALLET_OPENED`        | notification                                        | `walletId`, `organizationId`, `currency`, `openedAt`                                                                                                      |
| `FUNDS_HELD`           | marketplace (Saga) · analytics                      | `holdId`, `walletId`, `organizationId`, `transactionId`, `reference`, `referenceType`, `amountMinor`, `currency`, `heldAt`                                |
| `FUNDS_RELEASED`       | marketplace · analytics                             | `holdId`, `walletId`, `transactionId`, `reference`, `amountMinor`, `currency`, **`resolution`**, `resolvedAt`                                             |
| `PAYMENT_AUTHORIZED`   | marketplace · contract                              | `paymentIntentId`, `organizationId`, `walletId`, `amountMinor`, `currency`, `provider`, **`simulated`**, `authorizedAt`                                   |
| `PAYMENT_COMPLETED`    | marketplace · maintenance · contract · notification | `paymentIntentId`, `transactionId`, `journalId`, `amountMinor`, `currency`, `provider`, **`simulated`**, `completedAt`                                    |
| `PAYMENT_FAILED`       | **marketplace (جبران)** · notification              | `paymentIntentId`, `amountMinor`, `currency`, `provider`, **`simulated`**, `reason`, `failedAt`                                                           |
| `COMMISSION_APPLIED`   | **analytics (درآمد پلتفرم)** · audit                | `commissionId`, `transactionId`, `organizationId`, **`ruleId` (nullable)**, `rateBasisPoints`, `grossAmountMinor`, `amountMinor`                          |
| `REWARD_GRANTED`       | notification · analytics                            | `rewardId`, `userId`, `ruleId`, `triggerEvent`, `sourceReference`, `points`, `creditAmountMinor`, **`monetised`**, `journalId`                            |
| `REWARD_LEVEL_CHANGED` | notification                                        | `organizationId`, `userId`, `from` (nullable), `to`, `totalPoints`, `changedAt`                                                                           |
| `SETTLEMENT_COMPLETED` | marketplace · supplier · notification               | `settlementId`, `transactionId`, `payerOrganizationId`, `payeeOrganizationId`, `journalId`, `grossAmountMinor`, `commissionAmountMinor`, `netAmountMinor` |
| `JOURNAL_POSTED`       | audit · analytics                                   | `journalId`, `transactionId`, `journalType`, `reversesJournalId`, `entries[]` (حداقل دو)                                                                  |

**کلید پارتیشن هر یازده رویداد (ADR-036).** «درباره چیست» و «با چه چیزی مرتب
می‌ماند» دو پرسش‌اند و اینجا برای چهار رویداد پاسخشان یکی نیست:

| رویداد                 | Aggregate (Envelope) | کلید پارتیشن                     |
| ---------------------- | -------------------- | -------------------------------- |
| `WALLET_OPENED`        | `Wallet`             | `walletId`                       |
| `FUNDS_HELD`           | `WalletHold`         | **`transactionId`**              |
| `FUNDS_RELEASED`       | `WalletHold`         | **`transactionId`**              |
| `PAYMENT_AUTHORIZED`   | `PaymentIntent`      | `paymentIntentId`                |
| `PAYMENT_COMPLETED`    | `PaymentIntent`      | **`transactionId`**              |
| `PAYMENT_FAILED`       | `PaymentIntent`      | `paymentIntentId`                |
| `COMMISSION_APPLIED`   | `Commission`         | `transactionId`                  |
| `REWARD_GRANTED`       | `Reward`             | `rewardId`                       |
| `REWARD_LEVEL_CHANGED` | `RewardBalance`      | `${organizationId}:${userId}`    |
| `SETTLEMENT_COMPLETED` | `Settlement`         | `transactionId`                  |
| `JOURNAL_POSTED`       | `Journal`            | **`transactionId ?? journalId`** |

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

| رویداد              | مصرف‌کنندگان                      | Payload کلیدی                                                               |
| ------------------- | --------------------------------- | --------------------------------------------------------------------------- |
| `DOCUMENT_UPLOADED` | مالک منبع · audit                 | `documentId`, `documentClass`, `contentType`, `scanState` (همیشه `PENDING`) |
| `DOCUMENT_SCANNED`  | مالک منبع · audit                 | `documentId`, `scanState`, `engine`, `signatureVersion`, `failureReason`    |
| `DOCUMENT_DELETED`  | audit                             | `documentId`, `reason`                                                      |
| `VIRUS_DETECTED`    | **notification (بحرانی)** · audit | `documentId`, `engine`, `signature`                                         |

**همه با `documentId` کلید می‌خورند**، پس تاریخچهٔ یک سند روی **یک** Partition می‌نشیند
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

## افزودن رویداد جدید

```
۱. packages/contracts/src/events/<domain>.ts  →  نام + Zod Schema
۲. سرویس تولیدکننده  →  درج در outbox_message در همان تراکنش تغییر وضعیت
۳. سرویس مصرف‌کننده  →  Handler با processed_event برای Idempotency
۴. همین فایل  →  ثبت Producer، Consumer، Payload
۵. تست قرارداد  →  Payload تولیدشده با Schema مطابقت دارد
۶. تست Idempotency  →  پردازش دو باره اثر دوم ندارد
```
