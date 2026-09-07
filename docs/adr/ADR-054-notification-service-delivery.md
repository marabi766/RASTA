# ADR-054: سرویس اعلان — تحویل، ترجیحات و مرزِ کانال

- **وضعیت:** Proposed
- **تاریخ:** 2026-09-07
- **اهمیت:** پلتفرم امروز هشدار انقضای بیمه و سررسید سرویس تولید می‌کند و **هیچ‌کدام به هیچ انسانی نمی‌رسد**؛ این ADR تعیین می‌کند چگونه برسد و چگونه سیل نشود.
- **مربوط به:** `COM-008` (`READY`، ۱۳ امتیاز — **بدون تغییر**)
- **پیش‌نیاز:** [ADR-005](ADR-005-database-ownership.md) · [ADR-011](ADR-011-multi-tenancy.md) · [ADR-020](ADR-020-service-to-service-auth.md) · [ADR-021](ADR-021-outbox-pattern.md) · [ADR-024](ADR-024-payment-abstraction.md) (الگوی Port/Adapter) · [ADR-035](ADR-035-signed-internal-tenant-context.md) · [ADR-041](ADR-041-marketplace-missing-dependencies.md) · [ADR-049](ADR-049-malware-scanning-clamav.md) (همان الگو برای وابستگی بیرونی) · [ADR-050](ADR-050-outbox-durable-claim.md) · [ADR-051](ADR-051-outbox-semantic-ordering.md)
- **همراه:** [ADR-053](ADR-053-audit-service-append-only-evidence.md) — سرویس حسابرسی. دو سرویس، دو پایگاه داده، دو Topic. هیچ ماژول یا پایگاه دادهٔ مشترکی.
- **برنامهٔ اجرا:** [ADR-054 implementation plan](ADR-054-implementation-plan.md)

> **این سند تصمیم است، نه گزارش.** `services/notification-service/` وجود ندارد. هیچ جدول، هیچ Consumer، هیچ Endpoint، هیچ قالب و
> هیچ خطی از کد نوشته نشده. **هیچ ایمیلی تا امروز از این پلتفرم ارسال نشده است** و این سند چنین ادعایی نمی‌کند.

---

## خلاصهٔ اجرایی

`notification-service` **تحویل** را مالک است. تصمیم اینکه «چه اتفاقی مهم است» مالِ سرویس مبدأ است — `docs/04` § ۴٫۱۵:
«تصمیم اینکه «چه اتفاقی مهم است» — آن در سرویس مبدأ است. اینجا فقط تحویل.» همین یک قاعده بیشتر پرسش‌های مرزی را حل می‌کند.

| #   | تصمیم                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------- |
| ۱   | **Recipient از راه API احراز هویت‌شدهٔ identity حل می‌شود و Snapshot می‌گیرد** — هیچ رویدادی نشانی نمی‌آورد و نباید بیاورد |
| ۲   | **Deduplication محتوامحور، نه `eventId`محور** — یک الزام صحت، نه یک سخت‌سازی                                               |
| ۳   | **نردبان ترجیحات با سیاست اعلانِ الزامی در بالای آن** — و رد صریح ترجیح غیرمجاز با `422`                                   |
| ۴   | **ساعات سکوت به تعویق می‌اندازند، نه حذف** — و `CRITICAL` اصلاً از آن‌ها عبور می‌کند                                       |
| ۵   | **کانال پشت Port؛ Adapter توسعه = Mailpit** — هیچ ارائه‌دهندهٔ Production انتخاب نشده و این سند یکی اختراع نمی‌کند         |

**و یک واقعیت که پنهان نمی‌شود:** **ارائه‌دهندهٔ ایمیل Production و هویت فرستنده تعیین نشده‌اند.** این **انتشار ایمیل واقعی** را
مسدود می‌کند — نه نوشتن این ADR را، نه پیاده‌سازی را، و نه نیمهٔ In-App را. § ۶ و Q-37.

---

## Context

### آنچه امروز واقعاً هست — با شواهد

| بررسی                          | نتیجه                                                                                                                                                                                                    |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/notification-service/` | **وجود ندارد**                                                                                                                                                                                          |
| تولیدکنندهٔ `NOTIFICATION_SENT`  | **هیچ.** `docs/04` § ۴٫۱۵ و `docs/events/README.md` § Notification آن را تعریف کرده‌اند؛ هیچ سرویسی منتشرش نمی‌کند                                                                                       |
| مصرف‌کنندهٔ `MAINTENANCE_DUE`    | **هیچ.** `docs/07` § ۷٫۹ notification را مقصد می‌نامد؛ Consumer وجود ندارد                                                                                                                               |
| وضعیت اعلام‌شده در ADR-041       | «`notification-service` — واقعیت منتشر می‌شود، تحویل ادعا نمی‌شود». گام ۴ Saga (`notifySupplier`) عمداً پیاده نشده                                                                                        |
| زیرساخت ایمیل                    | فقط **Mailpit**، و `docker-compose.yml:425-432` آن را پشت Profileهای `tools`/`all` می‌گذارد. `pnpm infra:up` برابر `docker compose up -d` بدون Profile است، پس **Mailpit در Stack پیش‌فرض بالا نمی‌آید** |
| SMTP در `.env.example`           | **هیچ Host، Port، Credential یا هویت فرستنده‌ای وجود ندارد**                                                                                                                                             |

**نتیجه:** COM-008 هیچ رفتار قدیمی برای مهاجرت ندارد. Greenfield با قرارداد ورودی واقعی و پایدار.

### آنچه از قبل آماده است

- `services/api-gateway/src/config/routes.ts:70, 160-161, 208` — پیشوندهای `notifications` و `preferences` بدون `roles` (یعنی
  هر فراخوان احراز هویت‌شده مجاز به تلاش است — درست برای منبعِ متعلق به کاربر)، و `NOTIFICATION_SERVICE_URL` **الزامی**.
  **هیچ تغییری در Gateway لازم نیست.**
- `infrastructure/docker/postgres/00-init-databases.sh` — `rasta_notification` و نقش آن.
- `infrastructure/docker/kafka/create-topics.sh` — `rasta.notification.v1`، `.retry`، `.dlq`.
- `.env.example:47, 221, 239` — `DATABASE_URL_NOTIFICATION`، `PORT_NOTIFICATION=3113`، `NOTIFICATION_SERVICE_URL`.
- `docs/events/README.md` § Notification — `NOTIFICATION_SENT` و `NOTIFICATION_FAILED` با Payload
  `notificationId`, `channel`, `recipientId` (+ `reason`) از پیش در کاتالوگ ثبت شده‌اند.

### نقصی که این طراحی را شکل می‌دهد — و ادعای غلطی که در کد نوشته شده

`services/asset-service/src/insurance/insurance.service.ts:239-243` می‌گوید:

> «Re-emitting a warning on every sweep is avoided by the outbox's own dedupe: a repeat carries the same aggregate and event
> name, and consumers are idempotent.»

**چنین Dedupeای وجود ندارد.** بررسی مستقیم:

- `enqueueEvent` (`services/asset-service/src/asset/asset.repository.ts:37-76`) یک `tx.outboxMessage.create` ساده با
  `id: row.id` انجام می‌دهد، و `row.id` یک **ULID تازه** است که در هر فراخوان داخل `buildOutboxRow` ساخته می‌شود.
- `model OutboxMessage` در `services/asset-service/prisma/schema.prisma` هیچ محدودیت یکتایی روی `(aggregateId, eventName)`
  ندارد؛ تنها Index آن `@@index([createdAt], map: "idx_outbox_pending")` است.
- `runExpirySweep` هیچ حالتِ «قبلاً هشدار داده شد» نگه نمی‌دارد.

حساب: `EXPIRY_WARNING_DAYS` پیش‌فرض ۳۰ است (`config/env.ts:27`) و Sweep هر ۶ ساعت اجرا می‌شود
(`app.module.ts`، `6 * 60 * 60 * 1000`) — یعنی **۴ بار در روز**. یک بیمه‌نامه داخل پنجرهٔ هشدارش تا **حدود ۱۲۰ بار**
`INSURANCE_EXPIRING` منتشر می‌کند، **هرکدام با `eventId` متمایز**.

Idempotency سمت مصرف‌کننده روی `eventId` کلید می‌خورد (`docs/07` § ۷٫۵، `ProcessedEvent @@id([eventId, consumerName])`)، پس
**نمی‌تواند** این‌ها را سرکوب کند: این‌ها تکرارِ یک رویداد نیستند، ۱۲۰ رویداد متمایزند.

**پیامد مستقیم:** مصرف‌کننده‌ای که فقط بر `eventId` کلید بزند، حدود **۱۲۰ ایمیل به‌ازای هر بیمه‌نامه در هر چرخهٔ تمدید**
می‌فرستد. برای همین § ۳ Deduplication محتوامحور را **یک الزام صحت** می‌داند، نه یک بهبود.

> نقص در `asset-service` است، نه در این طرح. رفعش خارج از دامنهٔ COM-008 است؛ **درست بودن در حضورش** نیست. کامنت گمراه‌کننده
> صرف‌نظر از COM-008 باید اصلاح شود (R-3).

### قید سختی که مدل را تعیین می‌کند: نشانی گیرنده روی سیم نیست و نباید باشد

`services/identity-service/src/identity/events.ts:3-13` قاعده را می‌نویسد:

> «Payloads carry identifiers and decisions, never credentials and never more personal data than a consumer needs… A consumer
> needing a person's full profile calls the API for it, and that call is authorized and audited. Reading it off an event is
> neither.»

و آن را رعایت می‌کند: `userRegisteredPayload` فقط `userId`، `username`، `requestedOrganizationId` و `requestedRoles` دارد —
**هیچ ایمیلی**. ایمیل و تلفن فقط روی `User` در `services/identity-service/prisma/schema.prisma` هستند.

**پس `notification-service` نمی‌تواند نشانی گیرنده را از هیچ رویدادی استخراج کند.** باید identity را به‌عنوان یک فراخوان
`SERVICE` صدا بزند. این یک قید معماری است، نه یک ترجیح.

---

## Decision

### ۱. حل گیرنده از راه دسترسی احراز هویت‌شدهٔ سرویس‌به‌سرویس

```
GET /v1/users?role=FLEET_MANAGER&status=ACTIVE&limit=200
Authorization: Bearer <Token داخلی SERVICE، ادعای org_id امضاشده>
```

- از `InternalTokenService` با `purpose: 'SERVICE'` و ادعای **امضاشدهٔ** `org_id` استفاده می‌کند (ADR-035): «درون امضاست، پس
  یک فراخوان نمی‌تواند بدون کلید امضا، سازمانی را که برایش عمل می‌کند عوض کند.»
- **نیازمند افزودن `@AllowService()` به `GET /v1/users` در identity-service است** (ADR-020). امروز آن Endpoint
  `@Roles('ORGANIZATION_ADMIN', 'UNION_ADMIN')` دارد و هیچ `@AllowService` ندارد، پس هر فراخوان سرویس‌به‌سرویس رد می‌شود. این
  یک Decorator روی یک Endpoint موجود است، **دسترسی هیچ فراخوان انسانی را گشاد نمی‌کند**، و **داخل دامنهٔ COM-008 است**.
- **شکست کشنده نیست.** identity در دسترس نباشد → Intent در `PENDING` می‌ماند، `resolutionAttempts` بالا می‌رود، و همان Worker
  مبتنی بر Claim دوباره تلاش می‌کند. **پارتیشن Kafka هرگز روی این مسدود نمی‌شود**، چون حل گیرنده روی مسیر ارسال است نه مسیر مصرف.
- **Fan-out کراندار.** حل گیرنده‌ای که بیش از `NOTIFICATION_MAX_RECIPIENTS_PER_INTENT` (پیش‌فرض ۵۰۰) برگرداند، بریده، ثبت و
  هشدار داده می‌شود. Fan-out بی‌کران یعنی یک بمب ایمیلِ خودساخته.
- **Cache کوتاه** به‌ازای `(organizationId, role)` با TTL پیش‌فرض ۶۰ ثانیه، تا انفجار ۵۰۰ رویدادی به ۵۰۰ فراخوان یکسان تبدیل
  نشود. **هرگز مبنای یک تصمیم مجوزدهی نیست** — فقط برای نشانی‌دادن یک پیام.

### ۲. Snapshot گیرنده — و چرا باید Snapshot باشد

```
recipient_resolution
  id, intentId, organizationId
  userId
  resolvedRole      text?     -- نقشی که او را گیرنده کرد، اگر نقش‌محور بود
  emailSnapshot     text?     -- نشانی در لحظهٔ حل
  localeSnapshot    text      -- پیش‌فرض fa-IR
  timezoneSnapshot  text      -- پیش‌فرض Asia/Tehran
  resolvedAt        timestamptz
  resolutionSource  enum      -- IDENTITY_API | EVENT_PAYLOAD | CONFIGURED_ROLE
```

**چرا Snapshot و نه خواندن دوباره در لحظهٔ ارسال.** اگر نشانی در لحظهٔ ارسال دوباره خوانده شود، یک تلاش مجدد سه ساعت بعد ممکن
است به نشانی **متفاوتی** تحویل دهد — و پس از یک تغییر عضویت، به کسی که دیگر محق دانستن نیست. Snapshot، «به چه کسی و کجا گفتیم»
را برای همیشه از پایگاه دادهٔ خود notification پاسخ‌دادنی می‌کند، بدون فراخوان میان‌سرویسی و بدون وابستگی به حالت فعلی identity.

**قاعدهٔ تازه‌سازی:** Snapshot قدیمی‌تر از `NOTIFICATION_RECIPIENT_SNAPSHOT_MAX_AGE_SECONDS` (پیش‌فرض ۳۶۰۰) پیش از ساختن یک
تحویل **تازه** دوباره حل می‌شود. تلاش مجدد یک تحویل **موجود** همیشه از Snapshot اصلی استفاده می‌کند. تصمیم تازه با نشانی قدیمی —
هرگز برعکس.

**تغییر عضویت پس از رویداد مبدأ.** استحقاق در زمان حل بررسی می‌شود و **پیش از نخستین تلاش هر تحویل دوباره بررسی می‌شود**: عضویت
باطل‌شده → `SUPPRESSED` با `RECIPIENT_INACTIVE`، ثبت‌شده، هرگز ارسال‌نشده. تلاش‌های مجدد دوباره بررسی نمی‌کنند — یک تحویل که یک‌بار
`SENT` شده، پس گرفته نمی‌شود. `USER_DEACTIVATED` و `MEMBERSHIP_REVOKED` هم مصرف می‌شوند تا تحویل‌های در انتظار را
`SUPPRESSED` کنند. این بررسی روی **مسیر ارسال** است نه مسیر مصرف، پس پارتیشن را متوقف نمی‌کند.

**عضو تازه به عقب اطلاع داده نمی‌شود.** رویدادی که پیش از پیوستن کسی رخ داده، مالِ او نیست. سکوت رفتار درست است.

### ۳. Deduplication محتوامحور — سه لایه که سه کار متفاوت می‌کنند

قاطی‌کردن این سه، همان چیزی است که ۱۲۰ ایمیل را می‌سازد.

**لایهٔ ۱ — Idempotency مصرف‌کننده (استاندارد پلتفرم).** `processed_event(eventId, 'notification-service.dispatcher')` در همان
تراکنش اثر. پاسخ به «آیا دقیقاً همین پیام Kafka را پردازش کرده‌ام؟» **به‌تنهایی ناکافی است.**

**لایهٔ ۲ — Deduplication معنایی (لایه‌ای که نقص بالا اجباری‌اش می‌کند).**

```
dedupeKey = SHA256(organizationId | ruleKey | subjectType | subjectId | dedupeWindowBucket)
```

- `subjectType`/`subjectId` — *چیزی* که اعلان دربارهٔ آن است (`InsurancePolicy`/`POL_x`)، نه رویداد.
- `dedupeWindowBucket` — یک سطل زمانی درشت، به‌ازای هر قاعده، از پیکربندی.

برای `INSURANCE_EXPIRING`، سطل از `daysRemaining` ساخته می‌شود که **از پیش روی Payload هست** و به `{30, 14, 7, 3, 1}` باند
می‌شود. آن ۱۲۰ انتشار به **حداکثر ۵** اعلان جمع می‌شوند، یکی به‌ازای هر باند معنادار — که همان چیزی است که یک انسان واقعاً
می‌خواهد. **باندبندی پیکربندی قاعده است، نه کد.**

```
notification_dedupe
  dedupeKey  text PRIMARY KEY
  organizationId, intentId, firstSeenAt, lastSeenAt, seenCount, expiresAt
```

تکرار، `lastSeenAt`/`seenCount` را بالا می‌برد و **هیچ تحویلی** نمی‌سازد. `seenCount` عمداً دیده می‌شود: قاعده‌ای که شمارشش بالا
می‌رود، قاعده‌ای بدتنظیم است، و § ۹ آن را به‌صورت متریک صادر می‌کند.

**صداقت دربارهٔ کرانِ پنجره.** `notification_dedupe` در `NOTIFICATION_DEDUPE_RETENTION_DAYS` (پیش‌فرض ۴۵) هرس می‌شود — بیشتر از
پنجرهٔ ۳۰ روزهٔ بیمه و بیشتر از نگهداشت ۷ روزهٔ Topic. **رویدادی که پس از هرس شدن کلیدش بازپخش شود، دوباره اعلان می‌سازد.** این
یک محدودیت اعلام‌شده و کراندار است، نه یک محدودیت بی‌صدا؛ § ۸ بازپخش را یک عمل عملیاتی صریح با همین پنجره به‌عنوان قیدش می‌کند.

**لایهٔ ۳ — Idempotency سطح API.** طبق `docs/06` § ۶٫۸ برای نوشتن‌های مدیریتی. روی `read`/`dismiss` لازم نیست؛ آن‌ها ذاتاً
Idempotentاند.

| لایه                | کلید                                                         | پاسخ به                        |
| ------------------- | ------------------------------------------------------------ | ------------------------------ |
| Idempotency مصرف    | `(eventId, consumerName)`                                    | «این پیام را پردازش کرده‌ام؟»  |
| **Dedupe معنایی**   | `SHA256(orgId, ruleKey, subjectType, subjectId, windowBucket)` | «قبلاً همین را به او گفته‌ام؟» |
| Idempotency API     | Header `Idempotency-Key`                                     | «این یک درخواست تکراری است؟»   |

### ۴. مدل داده — Intent، Resolution، Delivery، Attempt، In-App

| Aggregate               | مرجع حقیقت      | چرخهٔ عمر                                                       |
| ----------------------- | --------------- | ---------------------------------------------------------------- |
| `NotificationIntent`    | notification    | `PENDING → RESOLVED → DISPATCHED`؛ `SUPPRESSED` و `DISCARDED` پایانی |
| `RecipientResolution`   | notification    | پس از نوشتن تغییرناپذیر (Snapshot؛ حقیقت زیرین مالِ identity است) |
| `NotificationDelivery`  | notification    | `QUEUED → SENDING → SENT → DELIVERED` / `FAILED` / `DEAD` / `SUPPRESSED` |
| `DeliveryAttempt`       | notification    | ردیف فرزند فقط‌الحاقی                                             |
| `InAppNotification`     | notification    | `UNREAD → READ → DISMISSED`؛ `EXPIRED` با نگهداشت                |
| `NotificationPreference`| notification    | تغییرپذیر                                                        |
| `NotificationTemplate` + `TemplateVersion` | notification | نسخه پس از ارجاع تغییرناپذیر                        |
| هویت، ایمیل، تلفن       | **identity**    | notification فقط Snapshot دارد                                   |
| «این اتفاق مهم است»     | **سرویس مبدأ**  | `docs/04` § ۴٫۱۵                                                 |

**چرا Intent جدا از Delivery وجود دارد** — سه حالت شکست واقعی: حل گیرنده یک فراخوان REST است که مستقل از مصرف رویداد شکست
می‌خورد، پس مصرف‌کننده باید بتواند Commit کند و حل را جدا تلاش کند؛ یک رویداد به N گیرنده × M کانال باز می‌شود و این باز شدن باید
بدون مصرف دوبارهٔ رویداد قابل ازسرگیری باشد؛ و یک اعلان سرکوب‌شده باید **به‌عنوان سرکوب‌شده ثبت شود** — «به هیچ‌کس گفته نشد، و
دلیلش این است» پرسشی است که پلتفرم باید بتواند پاسخ دهد.

`NotificationIntent` میدان‌های `sourceEventId`، `sourceEventName`، `sourceTopic`، `sourcePartitionKey`، `sourceStreamSeq`،
`occurredAt` (زمان دامنه، نه زمان دریافت)، `correlationId`، `causationId`، `ruleKey`، `templateKey`، `severity`
(`INFO|WARNING|CRITICAL`)، `classification` (`ROUTINE|MANDATORY`)، `dedupeKey` و `contextData` را نگه می‌دارد.

**Invariantهای `NotificationDelivery`:**

۱. `SENT` دست‌کم یک `DeliveryAttempt` با `outcome = SUCCESS` می‌خواهد.
۲. `SUPPRESSED` یک `suppressionReason` غیرخالی و **صفر** تلاش می‌خواهد. سرکوب یک تصمیم است، نه یک شکست.
۳. `DEAD` پایانی است و `attemptCount >= maxAttempts` می‌خواهد.
۴. یک تحویل `DELIVERED` به وضعیت غیرپایانی برنمی‌گردد.
۵. `channel = IN_APP` یعنی دقیقاً یک ردیف `InAppNotification`.
۶. **دقیقاً یک تحویل به‌ازای `(intentId, userId, channel)`** — یک محدودیت یکتایی، پس بازپخش مصرف‌کننده نمی‌تواند دومی بسازد.

**هیچ پرچم تجمیعی «Intent موفق شد» وجود ندارد.** موفقیت خاصیت هر تحویل است. یک وضعیت خلاصه باید به «اگر ۳ از ۵ کار کرد چه؟»
پاسخ دهد و هر پاسخی به آن یک دروغ است.

**معناشناسی In-App:**

| وضعیت       | معنا                                          | گذار                              |
| ----------- | --------------------------------------------- | --------------------------------- |
| `UNREAD`    | `readAt IS NULL AND dismissedAt IS NULL`      | اولیه                             |
| `READ`      | `readAt IS NOT NULL AND dismissedAt IS NULL`  | `POST /notifications/{id}/read`   |
| `DISMISSED` | `dismissedAt IS NOT NULL`                     | `POST /notifications/{id}/dismiss`|
| `EXPIRED`   | `expiresAt < now()`                           | Sweep نگهداشت                     |

- **خواندن Idempotent و یکنواخت است.** فراخوان دوم `200` با همان `readAt` اصلی برمی‌گرداند. **گذار «نخوانده کردن» وجود ندارد**:
  پلتفرم دربارهٔ توجه یک انسان ادعایی می‌کرد که نمی‌تواند بداند.
- **Dismiss یعنی خوانده شد.** Dismiss کردن یک نخوانده هر دو Timestamp را `now()` می‌کند، وگرنه کاربر یک ردیف همیشه‌نخوانده به جا
  می‌گذارد که شمارندهٔ Badge را باد می‌کند.
- **Dismiss حذف نیست.** ردیف تا پایان نگهداشت می‌ماند. کاربری که یک مورد را از دید خودش برمی‌دارد نباید رکورد «به او گفته شد» را
  نابود کند.
- **شمارندهٔ نخوانده کراندار است.** `GET /notifications/unread-count` روی ۹۹ سقف می‌خورد و `{ count: 99, capped: true }`
  برمی‌گرداند. یک `COUNT(*)` بی‌کران روی یک مسیر داغ به‌ازای هر کاربر، یک مشکل بار خودساخته است.

### ۵. ترجیحات، تقدم، ساعات سکوت و اعلانِ الزامی

```
notification_preference
  id, organizationId, userId
  scope     enum   -- GLOBAL | CATEGORY | RULE
  scopeKey  text?  -- null برای GLOBAL، نام دسته، یا ruleKey
  channel   enum   -- IN_APP | EMAIL
  enabled   boolean
  quietHoursStart time?, quietHoursEnd time?, timezone text
  updatedAt, updatedBy
  UNIQUE (userId, organizationId, scope, scopeKey, channel)
```

**تقدم — مشخص‌ترین برنده، و ترتیب ثابت است:**

```
۱. سیاست اعلانِ الزامی پلتفرم   (بالاترین — کاربر نمی‌تواند بازنویسی کند)
۲. ترجیح در دامنهٔ RULE
۳. ترجیح در دامنهٔ CATEGORY
۴. ترجیح GLOBAL
۵. پیش‌فرض کانال از پیکربندی    (پایین‌ترین)
```

به‌ازای `(userId, organizationId, channel)`. **ترجیحات به‌ازای مستأجرند**، و این یک تصمیم واقعی است: یک انسان که سه عضویت دارد
(«One human administering three dehyaris is one User with three Memberships») باید بتواند نویز روتین یک سازمان را ساکت کند بدون
ساکت‌کردن دیگری. یک ترجیح سراسری کاربر این را غیرممکن می‌کرد.

**پیش‌فرض وقتی کاربر ترجیحی اعلام نکرده:** `IN_APP` روشن؛ `EMAIL` روشن برای `WARNING` و `CRITICAL`، خاموش برای `INFO`.
پیکربندی، نه ثابت.

**ساعات سکوت به تعویق می‌اندازند، نه حذف.** در منطقهٔ زمانی Snapshot گیرنده ارزیابی می‌شوند (پیش‌فرض `Asia/Tehran`) در برابر
ذخیره‌سازی UTC (`AGENTS.md` § ۳). تحویل با `scheduledFor` در انتهای پنجره ساخته می‌شود. دو پیامد: **هیچ‌چیز گم نمی‌شود**، و یک
اعلان با شدت `CRITICAL` **کلاً از ساعات سکوت عبور می‌کند**. یک خرابی در ساعت ۲ بامداد دقیقاً وقتی است که کسی باید بداند.

**اعلانِ الزامی.** `classification = MANDATORY` لایه‌های ۲ تا ۴ را برای دست‌کم یک کانال دور می‌زند. **این یک تصمیم محصول است، نه
مهندسی** — Q-38. پیش‌فرض موقت پیشنهادی: `MANDATORY` همیشه یک اعلان `IN_APP` تولید می‌کند (که نمی‌شود از آن انصراف داد، فقط
Dismiss)، و `EMAIL` تحت کنترل ترجیح می‌ماند. این تضمین می‌کند پلتفرم همیشه می‌تواند یک اعلان لازم را نشان دهد، بی‌آنکه ادعای
اختیارِ گذاشتن نامه در صندوقی را بکند که کسی صریحاً نخواسته. **به‌ازای هر قاعده پیکربندی‌پذیر**، پس پاسخ می‌تواند بدون Migration
عوض شود.

**رد صریح، نه پذیرش‌و-نادیده‌گرفتن.** تلاش برای غیرفعال‌کردن کانالی که قاعده‌اش `MANDATORY` و غیرقابل‌بازنویسی است،
`422 BUSINESS_RULE_VIOLATION` می‌گیرد. سابقهٔ آن `docs/24` Q-07 است: «یک قاعده که وجود دارد، `ACTIVE` است و کاری نمی‌کند، کنترلی
را ادعا می‌کند که ندارد.» ترجیحی که UI «خاموش» نشان دهد در حالی که نامه می‌آید، دقیقاً همان شکست است.

`GET /v1/preferences/effective?ruleKey=&channel=` مقدار حل‌شده **به‌همراه لایهٔ برنده** را برمی‌گرداند. کاربران به سیستم ترجیحی که
نتوانند بازرسی کنند باور نمی‌کنند.

### ۶. کانال پشت Port — و ارائه‌دهنده‌ای که وجود ندارد

**کانال‌های MVP دقیقاً `IN_APP | EMAIL` هستند.** Enum عمداً `SMS` و `PUSH` را از پیش ندارد: مقداری که وجود دارد و کاری نمی‌کند،
قابلیتی را ادعا می‌کند که پلتفرم ندارد — همان استدلال Q-07. `docs/04` § ۴٫۱۵ SMS را P1 با ارائه‌دهندهٔ باز (Q-15) و Push را P2
می‌گذارد. **WhatsApp در هیچ‌جای مخزن نیست** و بنابراین یک کانال «موکول» نیست، یک کانال **ذکرنشده** است؛ ساختن نقشهٔ راه برایش
اختراع واقعیت کسب‌وکاری است (`AGENTS.md` § ۹٫۵).

**`MailChannel` یک Port است. Adapter توسعه، SMTP روی Mailpit است.**

این دقیقاً همان شکلی است که `MockPaymentProvider` (ADR-024) و `MalwareScanner` (ADR-049) از پیش دارند، و به همان دلیل: انتخاب
ارائه‌دهنده یک تصمیم تدارکاتی و محل‌داده است، نه یک تصمیم مهندسی.

> **CONSTRAINT — و این باید در هر سند و هر UI صریح بماند.**
> **هیچ ارائه‌دهندهٔ ایمیل Production و هیچ هویت فرستنده‌ای انتخاب نشده است.** `docs/04` § ۴٫۱۵ فقط «Mailpit در dev» می‌گوید و
> هیچ ارائه‌دهنده‌ای نام نمی‌برد؛ `docs/24` **Q-15 دربارهٔ پیامک است، نه ایمیل**، و هیچ پرسش بازی برای ایمیل وجود نداشت — Q-37
> همین ADR آن را ثبت می‌کند. `.env.example` هیچ Host، Port، Credential یا فرستنده‌ای ندارد.
>
> **این انتشار ایمیل واقعی را مسدود می‌کند، نه نوشتن این ADR را و نه پیاده‌سازی را.** نیمهٔ In-App کاملاً قابل انتشار است.
> نیمهٔ ایمیل در برابر Mailpit ساخته، تست و نمایش داده می‌شود و **نباید به گیرندگان واقعی نشانه رود** تا Q-37 پاسخ بگیرد.

مانند `ECONOMIC_PAYMENT_PROVIDER` که هر مقدار جز `mock` را در Boot رد می‌کند، `NOTIFICATION_MAIL_ADAPTER` در MVP فقط `smtp`
(Mailpit) را می‌پذیرد و هر مقدار دیگری Boot را **رد می‌کند** — بازگشت بی‌صدا به یک Adapter توسعه در محیطی که انتظار ارائه‌دهندهٔ
واقعی دارد، بدترین حالت شکست ممکن است.

### ۷. طبقه‌بندی تلاش مجدد، Backoff و شکست ارائه‌دهنده

این مستقل از Retry مشترک `EventConsumer` است. آن یکی **مصرف** را اداره می‌کند و به‌درستی کوتاه است؛ این یکی **ارسال** را، جایی که
شکست مالِ سیستم دیگری است.

| کلاس          | نمونه                                                              | رفتار                                             |
| ------------- | ------------------------------------------------------------------ | ------------------------------------------------- |
| `TRANSIENT`   | SMTP 4xx، Reset اتصال، Timeout، ۴۲۹/۵۰۳ ارائه‌دهنده                | تلاش مجدد با Backoff                              |
| `PERMANENT`   | SMTP 5xx گیرندهٔ نامعتبر، شکست Render، متغیر الزامی غایب            | **بدون تلاش مجدد** → `FAILED`، پایانی             |
| `SUPPRESSED`  | انصراف ترجیحی، ساعات سکوت، نبود نشانی، گیرندهٔ غیرفعال              | اصلاً تلاشی انجام نمی‌شود                          |
| `POISON`      | Envelope از Schema رد می‌شود                                        | مستقیم DLQ (رفتار پلتفرم، `event-consumer.ts:140-145`) |

Backoff برای `TRANSIENT`، با همان شکلی که `docs/07` § ۷٫۶ توصیف می‌کند:

```
تلاش ۱ → ۱s     تلاش ۲ → ۵s     تلاش ۳ → ۳۰s
تلاش ۴ → ۲m     تلاش ۵ → ۱۰m    سپس DEAD
```

با **Full Jitter** (`random(0, computed)`) که `docs/07` مشخص نمی‌کند و اینجا مهم است: بدون آن، یک قطعی ارائه‌دهنده که ۵۰۰۰ تحویل
صف‌شده را شکست می‌دهد، هر ۵۰۰۰ را در یک ثانیه دوباره تلاش می‌کند و **تلاش بازیابی، قطعی دوم می‌شود**.

پیاده‌سازی با `nextAttemptAt` روی ردیف به‌علاوهٔ یک Worker مبتنی بر Claim — **همان شکل Claim بادوام ADR-050**، عمداً، تا پلتفرم یک
الگوی همروندی داشته باشد نه دو تا. تایمرمحور و روی هر Replica امن، دقیقاً مثل Sweep موجود `asset-service` و Scanner
`maintenance`.

`DEAD` پایانی و هشداردهنده است. هرگز بی‌صدا ناپدید نمی‌شود.

- **Circuit Breaker به‌ازای هر کانال.** شکست‌های پیاپی `TRANSIENT` بالای آستانه، مدار را باز می‌کنند؛ تحویل‌ها با
  `nextAttemptAt` عقب‌رانده در `QUEUED` می‌مانند. همان الگویی که `api-gateway` از پیش برای Upstreamها دارد.
- **استقلال کانال نکتهٔ اصلی است.** از کار افتادن ایمیل هرگز نباید In-App را متوقف کند. ردیف به‌ازای گیرنده و به‌ازای کانال دقیقاً
  برای همین وجود دارد که موفقیت جزئی قابل نمایش باشد.
- **مصرف Kafka هرگز روی ارائه‌دهنده مسدود نمی‌شود.** کار مصرف‌کننده در «Intent و Deliveryها Commit شدند» تمام می‌شود. ارسال یک
  Worker جداست.

### ۸. رویداد، ترتیب و بازپخش

| ویژگی                | مقدار                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| گروه مصرف‌کننده      | `notification-service.dispatcher` — همان نامی که `docs/07` § ۷٫۱۰ از پیش می‌برد                                 |
| Topicهای MVP         | `rasta.identity.v1`، `rasta.insurance.v1`، `rasta.maintenance.v1`، `rasta.marketplace.v1`، `rasta.economic.v1` |
| Topicهای بعدی        | `asset`، `fleet`، `organization`، `document`، `supplier`                                                        |
| `fromBeginning`      | **`false`**                                                                                                     |
| DLQ                  | `rasta.notification.v1.dlq`                                                                                     |
| منتشر می‌کند         | `NOTIFICATION_SENT`، `NOTIFICATION_FAILED` روی `rasta.notification.v1`، از Outbox استاندارد با تخصیص B3         |

**یک گروه، نه یکی به‌ازای هر Topic:** ترتیب میان Topicها به‌هرحال ادعا نمی‌شود، و N گروه فقط سطح Rebalance و Lag را چند برابر
می‌کند.

**`fromBeginning: false` عمدی است.** یک استقرار نخست نباید ۷ روز تاریخ را به صندوق پستی مردم بازپخش کند. چیزی بادوام گم نمی‌شود:
شرایط انقضای فعال در Sweep بعدی (حداکثر ۶ ساعت) دوباره منتشر می‌شوند. **این عدم‌تقارن با ADR-053 نکتهٔ اصلی است**: بازخوانی Log
برای حسابرسی ردیف می‌نویسد؛ برای اعلان نامه می‌فرستد.

**Payload رویدادهای منتشرشده** همان است که کاتالوگ از پیش ثبت کرده: `notificationId`، `channel`، `recipientId` و برای
`NOTIFICATION_FAILED` به‌علاوهٔ `reason`. **هیچ نشانی، هیچ متن پیام.** به `templateKey`/`templateVersion`، `sourceEventId` و
`causationId = <eventId مبدأ>` هم مجهزند تا زنجیرهٔ «عمل دامنه → اعلان → نتیجهٔ تحویل» تا انتها پیمودنی باشد و ADR-053 بتواند ثبت
کند که یک اعلان `MANDATORY` واقعاً تحویل شده — **بدون آنکه ردیف تحویل به انبار شواهد برود.**

**ترتیب.** ADR-051 B4/B5 پیاده نشده‌اند؛ تضمین امروز هم‌پارتیشن بودن است نه مرتب بودن. طراحی **تحمل‌کنندهٔ بی‌ترتیبی** است، و
`streamSeq` را برای یک **نگهبان کهنگی** ارزان به کار می‌گیرد: اگر Intentای برای همان `(streamKey, subjectId)` با `sourceStreamSeq`
**بزرگ‌تر** موجود باشد، رویداد رسیده کهنه است و به‌جای اعلان، `DISCARDED` ثبت می‌شود. این نیازمند جدول `stream_progress` نیست و
وقتی `streamSeq` غایب باشد به رفتار امروز تنزل می‌کند.

**بازپخش یک رویهٔ عملیاتی است، نه یک پرچم پیکربندی.** نیازمند Reset صریح Offset گروه، یک پنجرهٔ مستند، و آگاهی از اینکه رویدادهای
قدیمی‌تر از `NOTIFICATION_DEDUPE_RETENTION_DAYS` **دوباره ارسال خواهند شد**. Runbook `notification-replay.md` این را صریحاً خطرناک
می‌نامد و ذکر دلیل را الزامی می‌کند.

**اعلان یک Read Model نیست و بازسازی نمی‌شود.** تاریخچهٔ تحویل، رکوردِ آنچه رخ داد است.

### ۹. Poison، DLQ و دو Invariant

`EventConsumer` بدون تغییر: Envelope غیرقابل تجزیه → DLQ با `VALIDATION_FAILED` و پارتیشن ادامه می‌دهد؛ Handler شکست‌خورده ۳ بار
درون‌فرآیندی و سپس DLQ.

**قاعدهٔ اختصاصی: شکست Render یک رویداد Poison نیست.** متغیر غایب قالب یک `PERMANENT_FAILURE` روی *تحویل* است، ثبت‌شده و دیده‌شده،
**نه** یک رویداد DLQ‌شده. رویداد سالم بود؛ قالب ما غلط بود. DLQ کردنش یک نقص قالب را در صفی پنهان می‌کند که کسی نمی‌خواند.

**Invariant ۱ — تحویل اعلان نباید تراکنش مبدأ را مسدود کند.** با سه خاصیت مستقل تضمین می‌شود: A-08 یعنی سرویس مبدأ فقط یک ردیف
Outbox داخل تراکنشش می‌نویسد و هرگز notification را صدا نمی‌زند؛ Relay ذاتاً ناهمزمان است؛ و درون notification، مصرف (که Intent
را Commit می‌کند) از ارسال (Worker مبتنی بر Claim) جداست، پس تأخیر ارائه‌دهنده هرگز به مصرف‌کننده نمی‌رسد چه رسد به مبدأ. حتی یک
قطعی کامل notification، تراکنش‌های مبدأ را عادی Commit می‌گذارد — فقط Lag رشد می‌کند. `docs/04` § ۴٫۱۵: «افت آن اعلان را به تأخیر
می‌اندازد، نه از بین می‌برد.»

**Invariant ۲ — یک رویداد تکراری نباید اثر قابل‌مشاهدهٔ دوم بگذارد.** لایهٔ ۱ همان `eventId` را می‌گیرد؛ لایهٔ ۲ رویدادهای
**متمایزی** را می‌گیرد که یک واقعیت را توصیف می‌کنند؛ و محدودیت یکتایی `(intentId, userId, channel)` در پایگاه داده آخرین خط است.
**هر سه لازم‌اند** — لایهٔ ۱ به‌تنهایی سبز می‌شد در حالی که ۱۲۰ ایمیل می‌رفت.

### ۱۰. قالب‌ها، فارسی، RTL و ایمنی محتوا

```
notification_template          (templateKey, channel, name, description, isActive)
notification_template_version  (templateKey, channel, version, locale,
                                subjectTemplate, bodyTemplate, requiredVariables jsonb,
                                createdAt, createdBy, publishedAt)
                               PRIMARY KEY (templateKey, channel, version, locale)
```

۱. **نسخهٔ منتشرشده تغییرناپذیر است.** ویرایش یعنی انتشار نسخهٔ تازه. تحویل به `(templateKey, version)` ارجاع می‌دهد، پس «دقیقاً
چه چیزی برایشان فرستادیم» پس از تغییر قالب هم پاسخ‌دادنی می‌ماند.
۲. **قالب‌ها در MVP پیکربندی Seed شده‌اند، نه CRUD زمان اجرا.** `docs/17:113` فقط «رویداد → اعلان؛ تنظیمات کاربر رعایت می‌شود» را
الزام می‌کند. یک API نویسندگی، یک سطح تزریق قالب، یک پرسش تأیید و یک UI نسخه‌بندی اضافه می‌کند بدون هیچ الزام اعلام‌شده‌ای. دو
Endpoint فقط‌خواندنی برای عیب‌یابی می‌مانند (`GET /v1/notification-templates`، `GET /v1/notification-rules`، هر دو
`SYSTEM_ADMIN`). خواندن تشخیص است؛ نوشتن نویسندگی.
۳. **Render سخت‌گیر است.** یک متغیر الزامی غایب `PERMANENT_FAILURE` است، نه جای‌گذاری خالی. قالبی که بی‌صدا «بیمه‌نامهٔ شما تا
روز دیگر منقضی می‌شود» تولید کند، بدتر از قالبی است که با صدا شکست بخورد.
۴. **Locale:** دقیق → بازگشت به `fa-IR` → شکست دائم. هرگز یک پیام نیمه‌ترجمه.
۵. **Escape متناسب با زمینه الزامی است.** HTML-escape برای بدنهٔ ایمیل، متن ساده برای Subject و برای In-App، URL-encode برای هر
جزء لینک درون‌گذاری‌شده. `\r\n` در متغیر Subject حذف می‌شود، نه عبور داده — تزریق Header ایمیل.

**فارسی و RTL** (`CLAUDE.md`): قالب‌ها از Logical Property های CSS استفاده می‌کنند (`margin-inline-start`، هرگز `margin-left`)؛
قالب ایمیل `dir="rtl"` و `lang="fa-IR"` دارد؛ **رقم فارسی فقط در لایهٔ ارائه** — که برای ایمیل همان قالب است، تنها جایی که یک
قالب مشروعاً لایهٔ ارائه است — و داده و API همیشه لاتین؛ ذخیره‌سازی میلادی/UTC و نمایش هجری شمسی در منطقهٔ زمانی Snapshot گیرنده؛
پول از راه یک Formatter مشترک، هرگز الحاق رشته (ADR-022).

**ایمنی Payload — بدون Secret، بدون دادهٔ حساس در پیام** (`AGENTS.md` S-09، `docs/07` § ۷٫۳ «شناسه حمل کن، نه داده شخصی»):

۱. `contextData` یک **فهرست مجاز اعلام‌شده به‌ازای هر قاعده** می‌پذیرد — شناسه، Enum، عدد صحیح، تاریخ. هر چیز اعلام‌نشده **در
   زمان ورود** دور ریخته می‌شود، نه در زمان Render.
۲. کلیدهای `SENSITIVE_KEYS` (`packages/logging/src/redaction.ts:14-62`) یکسره رد می‌شوند.
۳. **`bidAmount`، `bidContent`، `quotationAmount` و `sealedPayload` در همان فهرست‌اند** — یک پیشنهاد مهرشده هرگز نباید پیش از
   مهلتش در بدنهٔ یک اعلان ظاهر شود.
۴. بدنه‌های Render شده فقط به‌صورت **SHA-256** ذخیره می‌شوند. پایگاه دادهٔ notification نسخهٔ دوم هر پیام ارسال‌شده نیست.
۵. لینک عمیق **مسیر نسبی** است که Web App نسبت به Origin خودش حل می‌کند. یک URL مطلق ذخیره‌شده، یک ابزار Open-Redirect با
   سازوکار تحویل ایمیل ضمیمه است — و با یک CHECK در پایگاه داده رد می‌شود، نه فقط در DTO.
۶. **`email` در `SENSITIVE_KEYS` نیست** (فقط `personalEmail` هست، `redaction.ts:45`)، پس Redactor مشترک نشانی گیرنده را پوشش
   **نمی‌دهد**. `notification-service` باید نشانی‌ها را در Log خودش صریحاً Redact کند، با یک تست اختصاصی (R-5). افزودن `email`
   به فهرست مشترک، تغییری در `packages/` است که هر سرویس را تحت تأثیر می‌گذارد و یک‌جانبه اینجا انجام نمی‌شود.

### ۱۱. مجوزدهی، جداسازی مستأجر و Rate Limit

همه زیر `/v1`. Endpointها:

| متد    | مسیر                                | مجوز                | نکته                                     |
| ------ | ----------------------------------- | ------------------- | ---------------------------------------- |
| `GET`  | `/v1/notifications`                 | هر احراز هویت‌شده   | فقط ردیف‌های **خودِ** فراخوان            |
| `GET`  | `/v1/notifications/unread-count`    | هر احراز هویت‌شده   | سقف ۹۹                                   |
| `GET`  | `/v1/notifications/{id}`            | فقط مالک            | غیرمالک → `404`                          |
| `POST` | `/v1/notifications/{id}/read`       | فقط مالک            | Idempotent، یکنواخت                      |
| `POST` | `/v1/notifications/{id}/dismiss`    | فقط مالک            | `readAt` را هم می‌گذارد                  |
| `POST` | `/v1/notifications/read-all`        | فقط مالک            | `{updated: n}`                           |
| `GET`  | `/v1/preferences`                   | فقط خود             | + پیش‌فرض‌هایی که اعمال می‌شوند          |
| `PUT`  | `/v1/preferences`                   | فقط خود             | `422` برای قاعدهٔ `MANDATORY`            |
| `GET`  | `/v1/preferences/effective`         | فقط خود             | مقدار حل‌شده + لایهٔ برنده               |
| `GET`  | `/v1/notification-templates`        | `SYSTEM_ADMIN`      | فقط خواندن                               |
| `GET`  | `/v1/notification-rules`            | `SYSTEM_ADMIN`      | فقط خواندن                               |

**هیچ `DELETE`ای نیست.** Dismiss حذفِ سمت کاربر است؛ ردیف تا پایان نگهداشت می‌ماند.

**`organizationId` هرگز پارامتر Query نیست.** دامنه از Token تأییدشده و انتخاب `X-Organization-Id` می‌آید که `AuthGuard` از پیش
در برابر مجموعهٔ عضویت‌های خود Token اعتبارسنجی می‌کند (`request-context.ts:38-52`). فراخوانی که مستأجر را خودش بدهد، همان نقص
D-2 است.

**مالکیت `userId` است، نه فقط مستأجر.** دو کاربر در یک سازمان نباید اعلان‌های هم را ببینند. گزارهٔ فیلتر همیشه
`userId = ctx.userId AND organizationId = ctx.organizationId` است — سطح Object (S-03)، نه سطح Endpoint. **در MVP هیچ Endpoint
مدیریتی برای خواندن اعلان‌های کاربر دیگر وجود ندارد**؛ یک سطح افشای دادهٔ مستأجر بدون هیچ الزام اعلام‌شده‌ای پشتش.

**دسترسی میان‌مستأجری `404` می‌گیرد، نه `403`** (`docs/06` § ۶٫۷).

**`AUDITOR` اعلان‌های خودش را می‌بیند** — او هم کاربری است مثل بقیه. محدودیت `AUDITOR` مربوط به `analytics` و `audit` است
(ADR-053 § ۱۰)، نه به اعلان شخصی خودش.

**Rate Limit:**

- **سقف به‌ازای هر گیرنده**، به‌ازای هر کانال در هر پنجره (پیش‌فرض ۲۰ در ساعت). مازاد **به تعویق می‌افتد، دور ریخته نمی‌شود**، و
  شمرده می‌شود.
- **سقف سراسری خروجی** روی کانال ایمیل، با یک Token Bucket در Redis، که پس از پاسخ Q-37 با حد خود ارائه‌دهنده هماهنگ می‌شود.
- **Rate Limit خود Gateway از پیش اعمال می‌شود** — `notifications` و `preferences` روی پیش‌فرض به‌ازای کاربر؛ اگر لازم شد، میدان
  `rateLimit` در `routes.ts` بدون تغییر کد سقف تنگ‌تری می‌گیرد.

### ۱۲. نگهداشت و عملیات

- **نگهداشت In-App کوتاه است.** یک اعلان خوانده‌شده دورریختنی است؛ Sweep نگهداشت ردیف‌های منقضی را در دسته‌های کراندار حذف
  می‌کند. `EXPIRED` به‌صورت پیش‌فرض پنهان می‌شود، نه بی‌درنگ حذف.
- **`notification_dedupe`** در ۴۵ روز هرس می‌شود (§ ۳).
- **مغایرت‌گیری فقط‌گزارشی**، روی مدل `LedgerBalanceAudit` (فقط‌خواندنی، روی هر Replica امن، بدون انتخاب Leader): Intentهای بدون
  تحویل قدیمی‌تر از N دقیقه؛ تحویل‌های گیرکرده در `SENDING` بعد از Lease؛ و — مهم‌ترین — **Intentهای `MANDATORY` با صفر تحویل
  موفق**، چون یک اعلان الزامی که به کسی نرسیده یک واقعیت انطباقی است. **گزارش می‌دهد، هرگز ترمیم نمی‌کند.**
- **متریک‌ها** (`docs/13` § ۱۳٫۳ CONSTRAINT — هیچ برچسب پرCardinality؛ هیچ `userId`، هیچ نشانی):

| متریک                                            | نوع       | برچسب                    | هشدار                                                     |
| ------------------------------------------------ | --------- | ------------------------ | --------------------------------------------------------- |
| `rasta_notification_intents_total`               | Counter   | `event_name`, `rule_key` | —                                                         |
| `rasta_notification_deliveries_total`            | Counter   | `channel`, `status`      | —                                                         |
| `rasta_notification_delivery_duration_seconds`   | Histogram | `channel`                | p99 > ۳۰ ثانیه                                            |
| `rasta_notification_queue_depth`                 | Gauge     | `channel`                | > ۱۰٬۰۰۰                                                  |
| `rasta_notification_oldest_queued_age_seconds`   | Gauge     | `channel`                | **> ۹۰۰ ثانیه** — عدد قابل هشدار؛ عمق به‌تنهایی یک انفجار سالم را از یک صف گیرکرده جدا نمی‌کند |
| `rasta_notification_dead_total`                  | Counter   | `channel`, `error_class` | **هر افزایش**                                             |
| `rasta_notification_suppressed_total`            | Counter   | `reason`                 | —                                                         |
| `rasta_notification_deduped_total`               | Counter   | `rule_key`               | صعود تند = قاعدهٔ بدتنظیم                                 |
| `rasta_notification_recipient_truncated_total`   | Counter   | `rule_key`               | **هر افزایش**                                             |
| `rasta_notification_provider_circuit_state`      | Gauge     | `channel`                | باز > ۵ دقیقه                                             |
| `rasta_notification_recipient_resolution_failures_total` | Counter | `reason`           | پایدار > ۰                                                |

به‌علاوهٔ مجموعهٔ استاندارد پلتفرم و — چون notification یک Outbox دارد — پنج متریک Claim از ADR-050. Gaugeها با
`SELECT count(*)` نمونه‌برداری می‌شوند، هرگز `inc`/`dec`.

- **سه Runbook تازه:** `notification-queue-stuck.md`، `notification-provider-outage.md`، `notification-replay.md`.

### ۱۳. برش MVP قاعده‌ها — هشت قاعده، نه سی

`docs/04` § ۴٫۱۵ می‌گوید «نگاشت رویداد→قالب یک جدول پیکربندی است»، پس قاعده‌ها **داده‌اند، نه کد**. ۱۳ امتیاز COM-008 سی قاعده با
سی قالب را پوشش نمی‌دهد. مجموعهٔ پیشنهادی روز نخست، انتخاب‌شده بر مبنای ارزش قابل‌مشاهده به‌ازای واحد کار:

۱. `INSURANCE_EXPIRING` (باندشده) — همان شکافی که Sweep برایش وجود دارد
۲. `INSPECTION_EXPIRING` (باندشده) — همان، مرتبط با ایمنی
۳. `MAINTENANCE_DUE` — پرچم‌دار، و از پیش درست محافظت‌شده (`DueAnnouncerService` با `WHERE due_announced_at IS NULL`)
۴. `BREAKDOWN_REPORTED` — `CRITICAL`
۵. `INSPECTION_FAILED` — `CRITICAL`، ایمنی
۶. `ORDER_CREATED` — تجارت، دو مستأجر، اثبات مدل Fan-out
۷. `PAYMENT_FAILED` — `MANDATORY`، مالی
۸. `USER_ACTIVATED` — اثبات انتها-به-انتهای مسیر ایمیل روی یک پیام کم‌ریسک

قاعده‌های ۹ تا ۳۰ **داده‌اند** و بدون استقرار اضافه می‌شوند. همین است که برش هشت‌تایی را یک تصمیم دامنه می‌کند نه یک بدهی.

**پیام‌های سفارش marketplace امروز اعلان نیستند و خودشان می‌گویند.** `recordReminder` یک ردیف `order_status_history` از نوع
`REMINDER` می‌نویسد و **هیچ پیامی نمی‌فرستد** (ADR-041 § ۳: «یادآورهای Q-11 (ADR-043) هم رویدادند نه اعلان»). آن ردیف روی هیچ
Topicی نیست، پس notification نمی‌تواند ببیندش مگر marketplace رویدادی منتشر کند. خارج از دامنهٔ COM-008.

### ۱۴. آنچه `notification-service` عمداً انجام نمی‌دهد

- **تصمیم نمی‌گیرد چه چیزی مهم است.** `docs/04` § ۴٫۱۵.
- **رکورد حسابرسی تولید نمی‌کند.** یک `delivery_attempt` می‌گوید «ساعت ۱۰:۱۵ به USR_x ایمیل زدیم و SMTP جواب ۲۵۰ داد» — این
  Telemetry عملیاتی دربارهٔ رفتار خروجی خودِ پلتفرم است. یک `audit_event` می‌گوید «USR_y ساعت ۱۰:۱۵ از 10.0.1.42 دارایی AST_z را
  اسقاط کرد.» بازیگر متفاوت، موضوع متفاوت، نگهداشت متفاوت، خوانندهٔ متفاوت. تنها هم‌پوشانی مشروع — «آیا آن اعلان الزامی واقعاً
  تحویل شد؟» — با انتشار `NOTIFICATION_SENT`/`NOTIFICATION_FAILED` به‌عنوان رویداد دامنهٔ عادی حل می‌شود که ADR-053 مثل هر رویداد
  دیگری مصرفش می‌کند (§ ۸)، **نه** با بردن ردیف تحویل به انبار شواهد.
- **Digest، Batch، قالب به‌ازای مستأجر و CRUD مدیریتی قالب در MVP نیست.**
- **هیچ ادعای SMS، Push یا تحویل واقعی ایمیل نمی‌کند** (§ ۶).

---

## Alternatives Considered

| گزینه                                          | چرا رد شد                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **ادغام با `audit-service`**                   | یک انبار نمی‌تواند هم‌زمان برای شواهد فقط‌الحاقی باشد و برای «خوانده شد» تغییرپذیر. ADR-053 § Alternatives                                             |
| **قرار دادن نشانی گیرنده در Payload رویداد**   | `identity/events.ts:3-13` صریحاً منعش می‌کند: رویداد در Log می‌ماند و در پایگاه دادهٔ هر مصرف‌کننده کپی می‌شود                                          |
| **خواندن نشانی در لحظهٔ ارسال به‌جای Snapshot** | تلاش مجدد می‌تواند به نشانی متفاوت یا به کسی که دیگر محق نیست تحویل دهد. § ۲                                                                            |
| **Dedupe فقط بر `eventId`**                    | ۱۲۰ رویداد **متمایز** یک واقعیت را توصیف می‌کنند. § ۳ و نقص مستند asset-service                                                                         |
| **ذخیرهٔ حالت «قبلاً هشدار داده شد» در asset**  | نقصِ asset را رفع می‌کند و نه مسئلهٔ عمومی را؛ خارج از دامنهٔ COM-008 و یک ستون که می‌تواند Drift کند                                                   |
| **ساعات سکوت به‌عنوان سرکوب**                  | یک اعلان از دست می‌رود چون شب بود. تعویق چیزی را گم نمی‌کند                                                                                             |
| **`MANDATORY` همهٔ کانال‌ها را بازنویسی کند**  | ادعای اختیارِ گذاشتن نامه در صندوقی که کسی صریحاً نخواسته. Q-38، و پیش‌فرض قابل تغییر بدون Migration است                                                |
| **پذیرش خاموش ترجیح غیرمجاز**                  | UI «خاموش» نشان می‌دهد و نامه می‌آید. سابقهٔ Q-07: `422` صریح                                                                                           |
| **انتخاب یک ارائه‌دهندهٔ ایمیل تجاری الان**    | یک تصمیم تدارکاتی و محل‌داده (Q-06 دربارهٔ محلی‌سازی باز است) که مهندسی نباید بگیرد. § ۶                                                                |
| **موکول‌کردن کامل ایمیل به P1**                | با `docs/17:140` هم‌خوان است، اما COM-008 را از برآوردن معیار پذیرش خودش ناتوان می‌گذارد. § پرسش‌های باز                                                |
| **پیش‌پرکردن Enum کانال با `SMS`/`PUSH`**      | مقداری که وجود دارد و کاری نمی‌کند، قابلیتی را ادعا می‌کند که پلتفرم ندارد (Q-07). افزودن بعدی = یک مقدار Enum، یک Adapter، یک Migration               |
| **CRUD قالب در MVP**                           | سطح نویسندگی، سطح تزریق، پرسش تأیید و UI نسخه‌بندی، بدون هیچ الزام اعلام‌شده‌ای                                                                          |
| **`fromBeginning: true`**                      | استقرار نخست یک هفته اعلان را هم‌زمان به همه می‌فرستد                                                                                                   |

---

## Consequences

### مثبت

- هشدارهایی که پلتفرم از پیش تولید می‌کند برای نخستین بار به یک انسان می‌رسند.
- نیمهٔ In-App **کاملاً قابل انتشار است** و به هیچ تصمیم بیرونی وابسته نیست.
- تحویل ایمیل پشت یک Port است، پس ارائه‌دهندهٔ Production یک Adapter و یک بلوک محیطی است، بدون لمس دامنه.
- سیل ۱۲۰ ایمیلی به‌صورت ساختاری غیرممکن می‌شود، با یک تست برگشتی که همان عدد را می‌آزماید.
- ترجیحات به‌ازای مستأجر، مسئلهٔ واقعی «یک انسان، سه سازمان» را حل می‌کنند.

### منفی — و هیچ‌کدام کوچک نیست

- **ایمیل قابل انتشار نیست** تا Q-37 پاسخ بگیرد. NTF-004 در برابر Mailpit سبز است و **نباید** به گیرندهٔ واقعی نشانه رود.
- **یک وابستگی بیرونی وارد می‌شود:** `notification → identity`. طراحی آن را غیرکشنده می‌کند، اما وابستگی همچنان هست و باید پایش
  شود.
- **یک تغییر میان‌سرویسی لازم است:** `@AllowService()` روی `GET /v1/users` در identity-service. کوچک، تست‌شده، و بخشی از دامنهٔ
  COM-008 — ولی یک PR در سرویس دیگری است.
- **پنجرهٔ Dedupe کراندار است.** بازپخش بیرون از ۴۵ روز دوباره اعلان می‌فرستد. اعلام‌شده، نه بی‌صدا.
- **نخستین استقرار یک انفجار هشدار تولید می‌کند** (R-4): نخستین Sweep پس از استقرار برای هر بیمه‌نامهٔ داخل پنجرهٔ ۳۰ روزه هشدار
  می‌دهد. Dedupe باندشده، سقف نرخ به‌ازای گیرنده و یک Rollout مرحله‌ای (اول In-App، ایمیل پس از مشاهدهٔ حجم) لازم‌اند **پیش از**
  آن نخستین اجرا.
- **`email` در `SENSITIVE_KEYS` نیست** (R-5)، پس Redactor مشترک نشانی‌ها را نمی‌گیرد و این سرویس باید صریحاً بگیرد.
- **قالب‌ها Seed شده‌اند**، پس تغییر یک واژه یک استقرار است. تصمیم آگاهانه؛ CRUD یک داستان افزایشی پس از MVP است.
- **`COM-008` دو فاز دامنه را در بر می‌گیرد.** `docs/17` اعلان درون‌برنامه‌ای را P0 (`:113`) و اعلان ایمیل را P1 (`:140`)
  می‌گذارد، در حالی که `COM-008` یک قلم P0 است که هر دو را می‌پوشاند. این سند **آن را حل نمی‌کند** و Backlog را دست نمی‌زند؛
  صاحب محصول باید بداند. برنامهٔ اجرا داستان‌ها را چنان می‌چیند که نیمهٔ P0 مستقلاً قابل پذیرش باشد.

---

## Compliance

| قاعده                     | چگونه برآورده می‌شود                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| A-01 مالکیت پایگاه داده   | `rasta_notification` تنها پایگاه دادهٔ سرویس؛ هویت از راه API خوانده می‌شود، نه جدول                          |
| A-02 ارتباط بین‌سرویسی    | Kafka برای ورودی، REST برای حل گیرنده. هیچ `import` میان‌سرویسی                                               |
| A-03 `packages/*`         | هیچ Business Logic تازه‌ای در `packages/` نمی‌رود                                                             |
| A-04 Tenant Scope         | هر Query با `organizationId` **و** `userId` از Token                                                          |
| A-08 Outbox               | `NOTIFICATION_SENT`/`NOTIFICATION_FAILED` از Outbox استاندارد با تخصیص B3                                     |
| A-09 Idempotency          | `processed_event` + Dedupe معنایی + یکتایی `(intentId, userId, channel)`                                      |
| A-11 گردش‌کار             | چرخهٔ عمر تحویل یک ماشین حالت صریح است، نه `if` تودرتو                                                        |
| A-12 بدون دور زدن         | ترجیح نمی‌تواند یک بررسی امنیتی را دور بزند؛ سرکوب فقط تحویل را عوض می‌کند، نه مجوزدهی را                     |
| S-02 بسته به‌صورت پیش‌فرض | هیچ Endpoint `@Public`؛ Endpoint مدیریتی نقش صریح دارد                                                        |
| S-03 مجوزدهی سطح Object   | `userId = ctx.userId AND organizationId = ctx.organizationId` روی هر خواندن و هر گذار                          |
| S-06 رکورد Audit          | گذارهای تحویل به‌عنوان رویداد منتشر می‌شوند و ADR-053 آن‌ها را مثل هر رویداد دیگری مصرف می‌کند                 |
| S-08 Zero Trust           | فراخوان به identity با Token داخلی `SERVICE` و `org_id` امضاشده (ADR-035)                                     |
| S-09 دادهٔ حساس           | فهرست مجاز `contextData`، `SENSITIVE_KEYS`، بدنه فقط به‌صورت Hash، Redact صریح نشانی در Log                    |
| S-10 بدون ادعای مطلق      | «تحویل تلاش شد و نتیجه‌اش ثبت شد»، نه «تحویل تضمین‌شده»؛ هیچ ادعای exactly-once                                |

---

## پرسش‌های باز که این ADR حل نمی‌کند

| پرسش     | موضوع                                              | مسدودکنندهٔ توسعه؟ | مسدودکنندهٔ انتشار؟   |
| -------- | -------------------------------------------------- | :----------------: | :-------------------: |
| **Q-37** | ارائه‌دهندهٔ ایمیل Production و هویت فرستنده        |         نه         | **بله — فقط ایمیل**   |
| **Q-38** | آیا کاربر می‌تواند از یک اعلان الزامی انصراف دهد   |         نه         | نه — ولی پیش از پذیرش داستان ترجیحات لازم است |
| **Q-41** | آیا دلیل رد به شخص رد‌شده نشان داده می‌شود         |         نه         | نه                    |

**تنها Q-37 چیزی را مسدود می‌کند، و فقط نیمهٔ ایمیل COM-008 را.**

---

## آنچه این ADR وضعیت `COM-008` را به آن می‌رساند

با پذیرش این سند و برنامهٔ اجرای همراهش، `COM-008` از «آماده برای ADR» به **آماده برای پیاده‌سازی** می‌رسد — با یک قید صادقانه که
پنهان نمی‌شود: نیمهٔ In-App بی‌قید قابل پیاده‌سازی و انتشار است؛ نیمهٔ ایمیل قابل پیاده‌سازی و نمایش در برابر Mailpit است و
**قابل انتشار به گیرندگان واقعی نیست** تا Q-37 پاسخ بگیرد.

**وضعیت Backlog دست نمی‌خورد.** `COM-008` در `planning/backlog.json` همچنان `READY` با **۱۳ امتیاز** است. آمادگی، ارزیابی این
ADR است؛ تغییر وضعیت Backlog یک عمل حاکمیتی جداگانه طبق `docs/25-progress-governance.md` است و اینجا انجام نشده.
