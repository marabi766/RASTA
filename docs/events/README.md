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
| کلید پارتیشن | همیشه `aggregateId` — تضمین ترتیب به‌ازای Aggregate                     |
| انتشار       | **همیشه از راه Transactional Outbox** (ADR-021)                         |
| مصرف         | **همیشه Idempotent** با جدول `processed_event`                          |
| Payload      | **شناسه حمل می‌کند، نه داده شخصی**                                      |
| پول          | `{ amountMinor: string, currency: string }`                             |
| زمان         | ISO-8601 با UTC                                                         |

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

| رویداد                  | مصرف‌کنندگان                                 | Payload کلیدی                             |
| ----------------------- | -------------------------------------------- | ----------------------------------------- |
| `MAINTENANCE_DUE`       | **notification** · fleet · analytics         | `assetId`, `scheduleId`, `dueBy`, `basis` |
| `BREAKDOWN_REPORTED`    | notification · asset · analytics             | `assetId`, `requestId`, `severity`        |
| `MAINTENANCE_CREATED`   | asset · analytics                            | `requestId`, `assetId`, `type`            |
| `MAINTENANCE_STARTED`   | fleet (در دسترس بودن) · asset                | `requestId`, `assetId`                    |
| `WORKSHOP_ASSIGNED`     | notification · supplier                      | `requestId`, `workshopOrganizationId`     |
| `REPAIR_COMPLETED`      | asset · supplier (امتیاز) · analytics        | `repairOrderId`, `totalCost`              |
| `MAINTENANCE_COMPLETED` | asset · economic (پاداش) · fleet · analytics | `requestId`, `assetId`, `totalCost`       |
| `MAINTENANCE_APPROVED`  | **economic (مجوز تسویه)** · analytics        | `requestId`, `approvedBy`, `amount`       |

## Marketplace — `rasta.marketplace.v1`

| رویداد                    | مصرف‌کنندگان                                             | Payload کلیدی                                                                  |
| ------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `OFFER_PUBLISHED`         | search · analytics                                       | `offerId`, `productId`, `supplierOrganizationId`, `price`                      |
| `ORDER_CREATED`           | **economic (Hold)** · inventory (رزرو) · notification    | `orderId`, `buyerOrganizationId`, `supplierOrganizationId`, `total`, `lines[]` |
| `ORDER_CONFIRMED`         | notification · analytics                                 | `orderId`                                                                      |
| `ORDER_FULFILLED`         | notification · inventory                                 | `orderId`, `fulfillmentId`                                                     |
| `ORDER_RECEIPT_CONFIRMED` | **economic (Release + تسویه + کارمزد)**                  | `orderId`, `confirmedBy`                                                       |
| `ORDER_COMPLETED`         | economic (پاداش) · supplier (امتیاز) · asset · analytics | `orderId`, `total`                                                             |
| `ORDER_CANCELLED`         | economic (بازگشت) · inventory (آزادسازی)                 | `orderId`, `reason`                                                            |
| `ORDER_DISPUTED`          | **economic (توقف تسویه)** · notification · supplier      | `orderId`, `disputeId`, `reason`                                               |
| `REVIEW_SUBMITTED`        | supplier (امتیاز) · economic (پاداش)                     | `orderId`, `rating`, `criteria`                                                |

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

| رویداد                 | مصرف‌کنندگان                                        | Payload کلیدی                                                |
| ---------------------- | --------------------------------------------------- | ------------------------------------------------------------ |
| `WALLET_OPENED`        | notification                                        | `walletId`, `organizationId`, `currency`                     |
| `FUNDS_HELD`           | marketplace (Saga) · analytics                      | `holdId`, `walletId`, `amount`, `reference`                  |
| `FUNDS_RELEASED`       | marketplace · analytics                             | `holdId`, `amount`                                           |
| `PAYMENT_AUTHORIZED`   | marketplace · contract                              | `paymentIntentId`, `amount`, `provider`                      |
| `PAYMENT_COMPLETED`    | marketplace · maintenance · contract · notification | `paymentIntentId`, `transactionId`, `amount`                 |
| `PAYMENT_FAILED`       | **marketplace (جبران)** · notification              | `paymentIntentId`, `reason`                                  |
| `COMMISSION_APPLIED`   | **analytics (درآمد پلتفرم)** · audit                | `commissionId`, `transactionId`, `rateBasisPoints`, `amount` |
| `REWARD_GRANTED`       | notification · analytics                            | `rewardId`, `userId`, `points`, `ruleId`                     |
| `REWARD_LEVEL_CHANGED` | notification                                        | `userId`, `from`, `to`                                       |
| `SETTLEMENT_COMPLETED` | marketplace · supplier · notification               | `settlementId`, `netAmount`, `commissionAmount`              |
| `JOURNAL_POSTED`       | audit · analytics                                   | `journalId`, `entries[]`, `type`                             |

## Document — `rasta.document.v1`

| رویداد              | مصرف‌کنندگان                      | Payload کلیدی                                             |
| ------------------- | --------------------------------- | --------------------------------------------------------- |
| `DOCUMENT_UPLOADED` | مالک منبع · audit                 | `documentId`, `resourceType`, `resourceId`, `contentType` |
| `DOCUMENT_DELETED`  | audit                             | `documentId`, `reason`                                    |
| `VIRUS_DETECTED`    | **notification (بحرانی)** · audit | `documentId`, `signature`                                 |

## Notification — `rasta.notification.v1`

| رویداد                | مصرف‌کنندگان | Payload کلیدی                              |
| --------------------- | ------------ | ------------------------------------------ |
| `NOTIFICATION_SENT`   | analytics    | `notificationId`, `channel`, `recipientId` |
| `NOTIFICATION_FAILED` | analytics    | `notificationId`, `channel`, `reason`      |

## Audit — `rasta.audit.trail.v1`

**همه سرویس‌ها** روی این Topic می‌نویسند. تنها مصرف‌کننده `audit-service` است.

| رویداد                 | Payload                                                                                                     |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| `AUDIT_EVENT_RECORDED` | `actor`, `organizationId`, `action`, `resourceType`, `resourceId`, `outcome`, `changes`, `reason`, `source` |

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
