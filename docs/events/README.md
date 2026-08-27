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

| رویداد                                  | مصرف‌کنندگان                                                        | Payload کلیدی                              |
| --------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------ |
| `DRIVER_REGISTERED`                     | asset · analytics                                                   | `driverId`, `userId`                       |
| `ASSET_ASSIGNED`                        | asset · analytics                                                   | `assetId`, `driverId`, `assignmentId`      |
| `ASSIGNMENT_ENDED`                      | asset · analytics                                                   | `assignmentId`, `endedAt`                  |
| `USAGE_RECORDED`                        | **maintenance (محرک سرویس)** · asset · economic (پاداش) · analytics | `assetId`, `hours`, `kilometers`, `source` |
| `AVAILABILITY_CHANGED`                  | construction · analytics                                            | `assetId`, `available`, `from`, `to`       |
| `MISSION_STARTED` / `MISSION_COMPLETED` | asset · analytics                                                   | `missionId`, `assetId`, `projectId`        |

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
