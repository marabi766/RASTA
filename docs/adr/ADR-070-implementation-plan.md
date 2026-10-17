# ADR-070 — برنامهٔ اجرا (COM-007)

> برش PR به PR برای [ADR-070](ADR-070-procurement-service-boundary-and-lifecycle.md). **هیچ‌کدام ساخته نشده است** (2026-10-15؛ بازبینی 2026-10-16
> با `main` @ `7da6e20`: PR 5، PR 11 و PR 12؛ بازبینی دوم 2026-10-16 پس از بازبینی PR-300 دور ۱: مرز PR 1/PR 2، سقف مقدار، PR 5، PR 6، PR 8،
> PR 11، PR 12، PR 14)؛ این سند وضعیت
> نیست، نقشه است. هر PR جداگانه با CI سبز ادغام می‌شود؛ هر PRی که مسیر کاربری می‌سازد آزمون جداسازی مستأجر و آزمون رد نقش دارد.

**اندازه:** `S` ≈ تا ۳۰۰ خط تغییر با آزمون؛ `M` ≈ ۳۰۰ تا ۹۰۰؛ `L` ≈ ۹۰۰ تا ۲۰۰۰ (مرجع: برش‌های CON-002 و CON-003 روی `main`). امتیاز
برآوردی کنار هر برش است؛ جمع آن (۷۰، با همین PR) از ۲۱ امتیاز COM-007 بسیار بیشتر است — **بازبرآورد پرسش باز مدیر پروژه و صاحب محصول است**
(همان یادداشت ADR-065 و ADR-068)؛ این سند آن را نمی‌بندد و `backlog.json` را تغییر نمی‌دهد. بازبینی 2026-10-16 کاری به برش‌ها افزود (پذیرش
procurement در organization-service در PR 11) ولی امتیازی را عوض نکرد.

## نقشه

| PR  | عنوان                                                                             | اندازه | امتیاز | وابسته به | معیار COM-007 |
| --- | --------------------------------------------------------------------------------- | ------ | ------ | --------- | ------------- |
| 0   | طراحی: ADR-070، OpenAPI طرح‌شده، Q-119 تا Q-124، D-055 (همین PR)                  | S      | ۲      | —         | —             |
| 1   | Skeleton سرویس + `DemandRequest` + پیوستن به تجمیع                                | L      | ۵      | 0         | (الف)         |
| 2   | پایان پنجره: جاروکننده، آستانه، سیاست کمبود                                       | M      | ۳      | 1         | (الف)         |
| 3   | تنظیمات تجمیع به‌ازای سازمان (نسخه‌دار، Snapshot)                                 | M      | ۳      | 2         | (الف)         |
| 4   | استخراج مهر و موم به Package بی‌دامنه (construction بی‌تغییر رفتار)               | M      | ۳      | 0         | (ب)           |
| 5   | پورت‌های خواندنی: supplier (`GOODS_SUPPLY`) و identity برای `procurement-service` | S      | ۲      | 0         | (ب)           |
| 6   | صدور RFQ، دعوت، معیار منجمد، بستن مهلت، ابطال                                     | L      | ۵      | 2، 4، 5   | (ب)           |
| 7   | audit-service: برآمد شواهد رسید RFQ و خواندن داخلی زنجیره                         | M      | ۵      | 0         | (ب)           |
| 8   | پیشنهاد قیمت مهرشده: ثبت، بازنگری، انصراف، رسید، لاگ دسترسی                       | L      | ۸      | 4، 6، 7   | (ب)           |
| 9   | بازگشایی چهارچشمی، تعارض منافع، مقایسه                                            | L      | ۵      | 8         | (ب)           |
| 10  | ارزیابی: صلاحیت، امتیاز، `evaluate`، ماتریس منجمد                                 | L      | ۵      | 9         | (ب)           |
| 11  | ماژول سیاست موافقت `procurement.purchase_order` + `ORGANIZATION_MOVED`            | L      | ۸      | 1         | (ب)           |
| 12  | صدور سفارش خرید: انتخاب، درخواست موافقت، اجرا، بررسی کشفی، خواندن داخلی           | L      | ۸      | 10، 11    | (ب)           |
| 13  | رسید، کنترل کیفیت، لغو سفارش                                                      | M      | ۳      | 12        | (ب)           |
| 14  | مسیرهای Gateway و E2E (دومی در مالکیت `tests/e2e`)                                | M      | ۵      | 13        | هر دو         |

برش‌های ۴، ۵ و ۷ به برش ۱ وابسته نیستند و می‌توانند موازی بروند (برش ۶ جفت‌کلید RFQ را با Package برش ۴ می‌سازد). برش ۱۱ فقط به Skeleton نیاز دارد.
**معیار (الف) COM-007 با برش‌های ۱ تا ۳ برآورده می‌شود** و پس از آن‌ها می‌تواند جدا گزارش شود؛ معیار (ب) با برش‌های ۶ تا ۱۳.

## برش‌ها

### PR 1 — Skeleton و نیاز (`L`)

- `services/procurement-service` (پورت ۳۱۰۷، `rasta_procurement`، Topic `rasta.procurement.v1`)، تقسیم نقش مالک/زمان‌اجرا (D-045)، Outbox (ADR-050) و
  پاک‌سازی (D-052)، Health/Metrics، OpenAPI تولیدشده، Compose، Matrix تصویر، `TOPIC_PRODUCERS`/`TOPIC_CONSUMERS`/ACL، Runbook راه‌اندازی پایگاه داده.
  `PROCUREMENT_SERVICE_URL` در Gateway از پیش هست و **مسیر Gateway هم**: `demand-requests` و `aggregations` از `76dfe7f5` به procurement می‌روند
  (بی `requiresIdempotencyKey`)، پس مسیرهای این برش با استقرار رسیدنی‌اند و خود سرویس `Idempotency-Key` را الزام می‌کند؛ پرچم Gateway در PR 14.
- جدول‌های `demand_request` و `demand_aggregation` (همهٔ وضعیت‌ها از همین PR در `CHECK` متنی، نه enum؛ ADR-068 § ۲ دربارهٔ برگشت‌ناپذیری enum)؛ شاخص یکتای
  جزئی «یک `OPEN` به‌ازای (سازمان، کالا)»؛ `CHECK` هم‌سازمانی (Q-119)؛ ستون‌های Snapshot (طول، آستانه، سیاست، `setting_version` تهی = پیش‌فرض محیطی)؛
  `total_quantity` از نوع `bigint` با `CHECK` تا `MAX_QUANTITY` (۲۱۴۷۴۸۳۶۴۷).
- `POST /v1/demand-requests`، `POST /v1/demand-requests/{id}/withdraw`، `GET /v1/demand-requests[/{id}]`، `GET /v1/aggregations[/{id}]`؛ پیوستن زیر قفل با
  ساعت پایگاه داده. **پایان پنجره در مسیر همزمان از همین برش است** (ADR-070 § ۲؛ تصمیم بازبینی PR-300 F1): نیازی که در `closes_at` یا پس از آن برسد
  پنجره را با تابع گذار و جدول گذار پایان پنجره (`READY`، `EXTEND`، `REFERRED`، `LAPSED`) و رویدادش پایان می‌دهد و به پنجرهٔ بعدی می‌پیوندد — با
  `EXTEND` همان ردیف، `k` طول جلوتر در یک گذار؛ وگرنه ردیف `OPEN` تازه. نیازی که مجموع را از سقف بگذراند `422 AGGREGATION_QUANTITY_LIMIT_EXCEEDED`.
- تنظیمات فقط از محیط (پیش‌فرض‌های Q-10)؛ رویدادها `DEMAND_SUBMITTED`، `DEMAND_WITHDRAWN`، `DEMAND_AGGREGATED`، `AGGREGATION_WINDOW_EXTENDED`،
  `AGGREGATION_REFERRED`، `AGGREGATION_LAPSED` (با `demandCount` و `demandIdsSha256`، بی فهرست شناسه؛ ADR-070 § ۹)؛ `totalQuantity` در API و رویداد
  عدد `int32`.
- آزمون: ماتریس گذار، مرز `closes_at`، هر چهار پایان پنجره از مسیر همزمان، `EXTEND` چند طول دیر ⇒ یک ردیف `OPEN`، سقف مجموع (`MAX_QUANTITY` پذیرفته،
  یک بیشتر ⇒ `422` و هیچ نوشتن)، دو نیاز هم‌زمان ⇒ یک تجمیع، جداسازی مستأجر، نقش‌ها (`AUDITOR` در پیکربندی ⇒ راه‌اندازی رد).

> **وضعیت: ساخته شد (2026-10-16، COM-007 PR 1).** همان فهرست بالا (با تصمیم‌های F1 و F2 بازبینی PR-300)، با این تفاوت‌ها که هر کدام اینجا و
> در PR نام برده شده‌اند:
>
> 1. **پایان پنجره در مسیر همزمان** (F1): تابع `windowOutcome` و جدول گذارش در `demand.state-machine.ts` و چهار رویداد پایان پنجره؛ PR 2 همان
>    تابع را از جاروکننده صدا می‌زند؛ `AGGREGATION_CANCELLED` با لغو در PR 2 می‌ماند. نام‌های تازه همچنان با مدیر پروژه.
> 2. **سقف مقدار** (F2): `MAX_QUANTITY` (۲۱۴۷۴۸۳۶۴۷) برای نیاز و مجموع؛ `total_quantity` ستون `bigint` با `CHECK` تا سقف؛ نیازی که از سقف بگذرد
>    `422 BUSINESS_RULE_VIOLATION` با `details[].code = AGGREGATION_QUANTITY_LIMIT_EXCEEDED` (ناحیهٔ `submission`) و هیچ نوشتن؛ `totalQuantity` در
>    API و رویداد عدد. رویدادهای پایان پنجره `demandCount` و `demandIdsSha256` دارند، بی `demandIds[]`.
> 3. **شکل API در برابر OpenAPI طرح‌شده:** نیاز `note`، `withdrawnAt` و `withdrawReason` را هم برمی‌گرداند (یادداشت «فقط API» است) و تجمیع
>    `closedAt` را؛ صفحه‌ها `{ items, nextCursor }`.
> 4. تصمیم‌های موقت تازه در Q-119 (یادداشت PR 1: `SYSTEM_ADMIN` بیرون از سمت خریدار، پنجرهٔ تهی تا پایانش باز، تمدید چندطولی) و Q-120
>    (انصراف با هر نقش نیاز همان سازمان).
> 5. پایگاه داده نگهبان چرخه‌ها و مرز پنجره را خودش دارد (Trigger)، و جمع و شمار هر تجمیع با نیازهایش در Commit سنجیده می‌شود (Constraint
>    Trigger معوق). رویه راه‌اندازی پایگاه داده: `docs/runbooks/database-bootstrap.md` بخش procurement.
> 6. **بازبینی PR-327 r1:** (F1) بستن پنجرهٔ بزرگ خطی است: آن Constraint Trigger به‌روزرسانی‌ای را که مجموعهٔ شمرده را تغییر نمی‌دهد (گذار پایان
>    پنجره `SUBMITTED → REFERRED|LAPSED`، وضعیت یا تمدید تجمیع) بی بازشماری می‌پذیرد؛ آزمون: ۱۰٬۰۰۰ نیاز در یک ارسال، زیر بودجهٔ تراکنش. (F2) رد
>    مجوز در لاگ ساختاریافته ثبت می‌شود (`warn`، `Access denied: <code>`، بی بدنه و اعتبارنامه)، نه ممیزی ماندگار — مانند همهٔ سرویس‌ها؛ ممیزی
>    ماندگار رد، پیگیری سراسری S-06 است. (F3) طرح‌وارهٔ خطای منتشرشده همان پوشش پلتفرم (`@rasta/contracts`). (PR-300 r2 R2-1) آستانهٔ محیطی، نمای
>    Snapshot و `CHECK` آن تا `MAX_QUANTITY`.

### PR 2 — پایان پنجره (`M`)

- `AggregationWindowSweeper` (اجاره، حصار، `SKIP LOCKED`، دستهٔ کران‌دار، الگوی `TenderCloseSweeper`) که **همان** تابع گذار پایان پنجرهٔ PR 1 را
  صدا می‌زند (گذارها و چهار رویدادش از PR 1 است)؛ `POST /v1/aggregations/{id}/cancel`.
- رویداد تازه: `AGGREGATION_CANCELLED`.
- متریک: سن قدیمی‌ترین تجمیع سررسیده، شمار تمدید؛ هشدار مانند `RastaConstructionTenderClose…`.
- آزمون: هر سه سیاست، آستانهٔ صفر، تجمیع بی نیاز زنده، دو جاروکنندهٔ هم‌زمان، Restart و بستن به‌دست جاروکننده، Rollback رویداد و گذار با هم.

> **وضعیت: ساخته شد (2026-10-17، COM-007 PR 2).** همان فهرست بالا، با این تفاوت‌ها که هر کدام اینجا و در PR نام برده شده‌اند:
>
> 1. **پایان پنجره کران‌دار است، هر اندازه که باشد** (بازبینی PR-327 r1 F1: بستن هم‌زمان PR 1 حدود ۳۵٬۰۰۰ نیاز را در بودجهٔ ۵ ثانیه‌ای
>    تراکنش جا می‌داد). `WindowEnd` (تابع گذار مشترک ثبت نیاز و جاروکننده) حداکثر `PROCUREMENT_WINDOW_FOLLOW_BATCH_SIZE` (پیش‌فرض ۲۰۰۰،
>    حداکثر ۱۰٬۰۰۰) نیاز زنده را با پنجرهٔ `REFERRED`/`LAPSED` در همان تراکنش جابه‌جا می‌کند؛ باقی در ستون `demands_to_follow` شمرده و
>    جاروکننده آن‌ها را دسته‌دسته، هر دسته در یک تراکنش، جابه‌جا می‌کند. شمار و Digest نیازها در پایگاه داده حساب می‌شود (همان تعریف
>    `demandIdsDigest`). **حد تازه:** پایان پنجره در خود ثبت نیاز دیررس با ۲۰۰٬۰۰۰ نیاز ۰٫۸۴ ثانیه و با ۱٬۰۰۰٬۰۰۰ نیاز ۲٫۸۵ ثانیه طول کشید
>    (rasta-dev، از راه API)، پس حدود ۱٫۸ میلیون نیاز زنده در هر پنجره؛ آزمون `window-close-scale` آن را با ۲۰۰٬۰۰۰ نیاز (پنج برابر حد
>    PR 1) و هر گام بعدی جاروکننده زیر بودجه نشان می‌دهد. پیامد: در پنجرهٔ `REFERRED`/`LAPSED` بزرگ‌تر از یک دسته، نیازهای باقی‌مانده تا چند
>    دور جاروکننده `SUBMITTED` خوانده می‌شوند (انصرافشان مانند پیش `422 AGGREGATION_WINDOW_ENDED` است و رویداد پنجره همه را از همان آغاز
>    نام می‌برد). سقف شمار نیاز در پنجره قاعدهٔ تجاری است و ساخته نشد (یادداشت Q-120).
> 2. **دفترداری جاروکننده روی ردیف پنجره** (`sweep_lease_until`، `sweep_fence`، `sweep_attempts`، `sweep_next_attempt_at`، الگوی
>    `tender`): `demand_aggregation_guard` تغییر فقط‌دفترداری را بی `version` می‌پذیرد، `demands_to_follow` را فقط پایان پنجره می‌گذارد و
>    پس از آن فقط کم می‌شود، و `closed_at` پنجرهٔ پایان‌یافته منجمد است. Migration برگشت‌پذیر است و روی تجمیع `CANCELLED` یا نیاز در
>    راه رد می‌شود.
> 3. **ابطال:** نقش‌ها از `PROCUREMENT_RFQ_ISSUER_ROLES` (پیش‌فرض `ORGANIZATION_ADMIN`، ADR-070 § ۳) که همین‌جا ساخته شد؛ ابطال فقط از
>    `READY` (پنجرهٔ `OPEN` حتی پس از پایانش `422 AGGREGATION_NOT_READY` است؛ ابطال پنجره را پایان نمی‌دهد)؛ نیازهای تجمیع باطل‌شده همان
>    `SUBMITTED` می‌مانند و با آن پایانی‌اند (یادداشت Q-119)؛ نما `cancelledAt` و `cancelReason` هم دارد (فقط API)؛ `AGGREGATION_CANCELLED`
>    شمار، Digest و `cancelledBy` دارد، نه دلیل.
> 4. **متریک و هشدار:** `rasta_procurement_window_sweep_total{result}`، Gaugeهای `…_window_sweep_due`، `…_oldest_due_age_seconds`،
>    `…_window_demands_to_follow`، `…_window_sweep_max_attempts`، `…_window_max_extension_count`، شمارندهٔ
>    `rasta_procurement_aggregation_extensions_total` و برچسب `trigger="sweeper"`؛ هشدارهای `RastaProcurementWindowSweepRetriesHigh` و
>    `RastaProcurementWindowSweepOverdue` با آزمون promtool و Runbook `aggregation-window-sweep-stuck`. جاروکننده در `OutboxShutdown` با همان
>    موعد Relay و Purge می‌ایستد (D-052).

### PR 3 — تنظیمات به‌ازای سازمان (`M`)

- `aggregation_setting` الحاقی و نسخه‌دار (طول پنجره به ساعت، آستانهٔ مقدار، سیاست کمبود)؛ نویسنده طبق پاسخ موقت Q-119؛ Snapshot در گشودن پنجره
  (ستون‌ها از PR 1؛ اینجا `setting_version` پر می‌شود)؛
  رویداد `AGGREGATION_SETTING_CHANGED` (نام با مدیر پروژه).
- **کران‌های تنظیم** (بازبینی PR-300 r2 R2-1): `minQuantity` بین ۰ و `MAX_QUANTITY` (۲۱۴۷۴۸۳۶۴۷) — آستانه‌ای بالاتر از بیشترین مجموع پنجره هرگز
  `READY` نمی‌شود و با `EXTEND` بی‌پایان تمدید می‌شود، و چون Snapshot پنجرهٔ باز تغییرناپذیر است تنظیم بعدی درمانش نمی‌کند؛ `windowHours` بین ۱ و ۸۷۶۰.
  همان کران‌ها در ورودی `RecordAggregationSetting` (`400 VALIDATION_FAILED`)، در پیکربندی محیطی (`PROCUREMENT_AGGREGATION_MIN_QUANTITY` و
  `_WINDOW_HOURS`، از PR 1)، در `CHECK` ستون‌های `aggregation_setting` و Snapshot (`ck_demand_aggregation_snapshot`، از PR 1) و در OpenAPI طرح‌شده
  (`maximum`).
- آزمون: تغییر تنظیم پنجرهٔ باز را عوض نمی‌کند؛ نبود ردیف ⇒ پیش‌فرض محیطی؛ نقش‌های غیرمجاز رد و ممیزی؛ خود سقف پذیرفته و سقف + ۱ رد (ورودی و
  محیط).

### PR 4 — استخراج مهر و موم (`M`)

- انتقال توابع خالص `sealBid`/`openBid`، تعهد، زنجیرهٔ رسید و `trustedReceiptsOf` از `construction-service/src/tender/sealing` به یک Package بی‌دامنه
  (Utility رمزنگاری؛ A-03 فقط Business Logic را منع می‌کند)؛ construction همان را import می‌کند؛ آزمون‌های بردار شناخته بی‌تغییر می‌گذرند.
- **تصمیم مدیر پروژه:** استخراج (پیشنهاد) یا کپی. اگر کپی، این برش حذف و PR 8 بزرگ‌تر می‌شود و دو نسخه باید هم‌زمان نگه داشته شوند.

### PR 5 — پورت‌های خواندنی (`S`)

- supplier-service: `GET /v1/suppliers/standing-snapshot/:organizationId` امروز فقط `construction-service` و فقط `contractingApprovedAt` دارد. برش
  `procurement-service` را به `@AllowService` و بررسی فراخوانندهٔ سرویس (`assertCallerIsConstructionService` امروز) می‌افزاید و لحظهٔ تأیید
  `GOODS_SUPPLY` را میدان **افزایشی** پاسخ می‌کند (شکل `.strict()` construction با آن بازبینی می‌شود)؛ قرارداد توکن بی‌تغییر: **بی مستأجر**، توکن
  مستأجردار `403`. رفتار و آزمون موجود construction بی‌تغییر.
- identity-service: `GET /v1/users/:id/organizations` (امروز فقط `construction-service`، توکن **بی مستأجر**) ـ گسترش `@AllowService` **و** بررسی
  فراخوانندهٔ لایهٔ سرویس (`identity.service.ts`، امروز `callerService === 'construction-service'`؛ فقط Decorator ⇒ procurement `403`) به
  `procurement-service`، همان قرارداد توکن.
- آزمون در هر دو سرویس: سرویس دیگر و شخص ⇒ `403`؛ توکن مستأجردار ⇒ `403`؛ procurement و construction ⇒ `200`.

### PR 6 — صدور RFQ (`L`)

- `rfq`، `rfq_invitation`، `rfq_criterion` (منجمد با Trigger)، کلید RFQ (KEK جدا: `PROCUREMENT_RFQ_KEKS`)؛ `POST /v1/aggregations/{id}/rfq` (اتمیک با
  `READY → RFQ_ISSUED`)، `procurementNature` اجباری، دعوت صریح با پرسش مرجع supplier (Fail Closed)، `PROCUREMENT_RFQ_MAX_INVITEES`.
- `RfqCloseSweeper` و `POST /v1/rfqs/{id}/close` (نقش‌های `PROCUREMENT_RFQ_ISSUER_ROLES` خریدار؛ نقش دیگر `403`، تأمین‌کننده و سازمان سوم `404`)؛ `POST /v1/rfqs/{id}/cancel`؛ خواندن سمت خریدار و سمت تأمین‌کنندهٔ دعوت‌شده (`runUnscoped` با دلیل).
- رویدادها: `RFQ_ISSUED`، `RFQ_CLOSED`، `RFQ_CANCELLED`.
- آزمون: دعوت تأمین‌کنندهٔ معلق/ناواجد ⇒ `422`؛ supplier ناپیدا ⇒ `503` و هیچ ردیف؛ دعوت‌نشده ⇒ `404`؛ مرز مهلت.

### PR 7 — شواهد در audit-service (`M`)

- مصرف‌کنندهٔ `audit-service.rfq-evidence` روی `rasta.procurement.v1` و جدول الحاقی پیوند رسید (همان قواعد `tender_receipt_link`: Genesis، پیوستگی،
  نگه‌داشتن تحویل نامرتب، `FORK`، ناسازگاری هویت، هشدار شکاف)؛ `GET /v1/internal/rfq-evidence/{rfqId}/chain` با `@AllowService('procurement-service')`.
- رویدادهای `QUOTATION_*` هنوز تولید نمی‌شوند؛ آزمون با رویدادهای ساختگی هم‌شکل قرارداد `@rasta/contracts` (همان ترتیب CON-002 PR 6).

### PR 8 — پیشنهاد قیمت مهرشده (`L`)

- `quotation`، `quotation_receipt`، `quotation_access_log` (الحاقی)؛ ثبت/بازنگری/انصراف پیش از مهلت با `FOR SHARE`، پرسش مرجع صلاحیت و `eligible_as_of`،
  محتوا طبق Q-120/Q-86؛ `unitPriceMinor × quantity ≤ 2^63 − 1` پیش از مهر (`422 QUOTATION_AMOUNT_OUT_OF_RANGE`)؛ رسید به تأمین‌کننده؛ هر خواندن
  مرتبط و ردش در همان تراکنش ممیزی (`QUOTATION_ACCESSED`؛ سازمان دیگر `404` بی ردیف، ADR-070 § ۴).
- آزمون: مهلت (`−1ms` و دقیقاً مهلت)، انتظار قفل از مهلت می‌گذرد، انصراف در برابر بستن، ماتریس خواندن پیش از بازگشایی (هر خانهٔ جدول ADR-066 § ۴)،
  «رشتهٔ ساختگی در محتوا و قیمت هیچ‌جا در لاگ و رویداد نیست».

### PR 9 — بازگشایی (`L`)

- `POST /v1/rfqs/{id}/open-quotations` با پیشنهاد/تأیید چهارچشمی، خواندن زنجیره از audit-service و مقایسهٔ حلقه‌به‌حلقه، تعارض منافع با identity (توکن
  و عضویت زنده)، بررسی کشفی پس از Commit؛ `GET /v1/rfqs/{id}/quotations` و `GET /v1/rfqs/{id}/comparison` (مقایسهٔ قیمت‌ها پس از بازگشایی).
- آزمون: سرِ محلیِ بازنویسی‌شده ⇒ رد؛ audit ناپیدا ⇒ رد بی‌اثر؛ عضو سازمان پیشنهاددهنده ⇒ `403 CONFLICT_OF_INTEREST`؛ بازگشایی تکراری Idempotent؛ اندازهٔ
  بدترین حالت زیر مهلت بازگشایی (الگوی `tender-open-scale.int-spec.ts`).

### PR 10 — ارزیابی (`L`)

- `quotation_qualification`، `quotation_evaluation`، `quotation_evaluation_score`، کناره‌گیری (همه الحاقی، Trigger با `FOR SHARE`)؛ `evaluate` و
  `GET /v1/rfqs/{id}/evaluation` (ماتریس، `ready`، `readinessBlockedBy`)؛ `QUOTATIONS_EVALUATED` بی امتیاز.
- آزمون: همان مجموعهٔ CON-002 PR 9 (یک شخص یک ارزیاب، هویت نامعلوم، جمع بیش از 2^53، تساوی).

### PR 11 — سیاست موافقت سفارش (`L`)

- کپی ماژول سیاست contract-service **همان‌گونه که روی `main` است** با کلید `procurement.purchase_order`: نویسنده طبق Q-70 (۷)،
  `DRAFT → PENDING_PLATFORM_APPROVAL → ACTIVE | REJECTED`، چهارچشمی `SYSTEM_ADMIN`، Snapshot، پرسش سلسله‌مراتب از organization-service، Consumer
  `ORGANIZATION_MOVED` (فقط محرک) و جاروکنندهٔ آشتی (D-041)؛ مرجع گام هر (سازمان، نقش) جز `AUDITOR` و `SYSTEM_ADMIN` (`400`)، دو گام با یک
  (سازمان، نقش) مجاز، کران مبلغ گام فقط پس از اعتبارسنجی هر دو کران مقایسه می‌شود (ADR-068 § ۵ و بازبینی #312).
- مسیرها، همان هشت مسیر `/v1/contract-approval-policies` زیر `/v1/purchase-order-policies` (OpenAPI طرح‌شده): `POST /`، `GET /`،
  `GET /pending-platform-approval` (فقط `SYSTEM_ADMIN`)، `GET /{id}` (نویسنده، سازمان حاکم‌شده، مدیر پلتفرم؛ دیگران `404`)، `POST /{id}/submit`،
  `POST /{id}/approve` (چهارچشمی)، `POST /{id}/reject` (دلیل)، `POST /{id}/retire`.
- organization-service: `procurement-service` به `@AllowService` ـ `GET /v1/organizations/{id}` (امروز construction و contract) و آزمون Provider
  همان پاسخ `{ id }`/`404` برای procurement (الگوی `construction-hierarchy-contract.int-spec.ts`).
- آزمون: همان مجموعهٔ contract-service (سیاست اتحادیه برای سازمان بیرون از زیردرخت، تعلیق پس از جابه‌جایی، چهارچشمی، `SYSTEM_ADMIN` و
  `AUDITOR` به‌عنوان مرجع گام ⇒ `400`).

### PR 12 — صدور سفارش خرید (`L`)

- `purchase_order`، `purchase_order_line`، `purchase_order_approval_request`، `purchase_order_standing_check`؛ `POST /v1/rfqs/{id}/purchase-order`
  (`422 APPROVAL_POLICY_REQUIRED` بی سیاست؛ `202` با سیاست؛ اجرا در یک تراکنش پس از تصویب؛ `409 APPROVAL_STALE`)؛ مسیرهای موافقت:
  `GET /v1/purchase-order-approvals` (صندوق مرجع)، `GET /v1/purchase-order-approvals/{id}`، `GET /v1/rfqs/{id}/purchase-order-approvals` (خریدار: وضعیت و
  گام‌ها) و `POST /v1/purchase-order-approvals/{id}/decision`، با قاعدهٔ خواندن میان‌مستأجری مرجع ADR-070 § ۶ (`runUnscoped` با Predicate گام؛ دیگران
  `404`)؛ بازسنجی شایستگی برنده، عضویت identity و **زنجیرهٔ رسید audit پیش از تراکنش**، زیر قفل فقط سنجش نسخه/رسید (`409
PURCHASE_ORDER_INPUT_CHANGED`) و مبلغ از محتوای مهرشده (`bigint`، کران سرریز) — همین ترتیب در تصمیم آخرین گام؛ `GET /v1/purchase-orders[/{id}]`
  برای خریدار و تأمین‌کننده،
  `GET /v1/internal/purchase-orders/{id}` به الگوی `GET /v1/internal/statements/{id}` contract-service (#320؛ ADR-070 § ۸): فقط
  `@AllowService('economic-service')` و بررسی فراخواننده در سرویس (هر توکن کاربر `403`)، مستأجر = سازمان امضاشده در توکن (خریدار)، پاسخ فقط از ردیف
  با هر وضعیت (`PurchaseOrderSourceFact`)، OpenAPI تولیدشده با طرح `internalToken` فقط روی `/v1/internal/` (`enrichOpenApiDocument` و `document.spec`
  به‌ازای عملیات، همان #320). `inventory-service` اینجا افزوده نمی‌شود (Q-123).
- رویدادها: `PURCHASE_ORDER_APPROVAL_ACTION`، `PURCHASE_ORDER_ISSUED` (بی مبلغ)، `QUOTATION_NOT_SELECTED`، `PURCHASE_ORDER_STANDING_CONFLICT_DETECTED`.
- آزمون: دو صدور هم‌زمان ⇒ یکی؛ برندهٔ معلق ⇒ `422`؛ supplier ناپیدا ⇒ `503`؛ audit کند هیچ قفل RFQ ای نگه نمی‌دارد و RFQ تغییرکرده میان خواندن و
  قفل ⇒ `409`؛ مرجع گام از سازمان دیگر درخواست را می‌خواند و تصمیم می‌گیرد، نقش دیگرِ همان سازمان و سازمان سوم `404`؛ درخواست‌دهنده تصویب‌کنندهٔ خودش نیست؛ هیچ رویدادی میدان مبلغ ندارد؛
  خواندن داخلی: خریدار `200`، تأمین‌کننده/بیگانه/ناموجود همان `404`، کاربر و سرویس دیگر `403`، توکن بی سازمان `403`، بی توکن `401`، توکن سرویس در
  `Authorization` ⇒ `401` (الگوی `statement-settlement-read.int-spec.ts`).

### PR 13 — رسید، کنترل کیفیت، لغو (`M`)

- `receipt`، `quality_check`؛ `POST /v1/purchase-orders/{id}/receipts`، `POST /v1/receipts/{id}/quality-check`، `POST /v1/purchase-orders/{id}/cancel`
  (فقط پیش از هر رسید، همان دروازهٔ سیاست)؛ شمارندهٔ مقدار دریافت‌شده با `CHECK` و قفل سفارش؛ جدایی ثبت‌کننده و بازرس (`PROCUREMENT_SOD_RULES`).
- رویدادها: `GOODS_RECEIVED`، `QUALITY_CHECK_RECORDED`، `PURCHASE_ORDER_CANCELLED`.
- آزمون: رسید بیش از سفارش ⇒ `422`؛ دو رسید هم‌زمان؛ کنترل کیفیت `FAIL` هیچ وضعیتی را عوض نمی‌کند؛ لغو پس از رسید ⇒ `422`.

### PR 14 — Gateway و E2E (`M`)

- جدول مسیر Gateway: چهار Prefix موجود (`demand-requests`، `aggregations`، `rfqs`، `purchase-orders`، از `76dfe7f5`) `requiresIdempotencyKey` می‌گیرند
  (امروز فقط `purchase-orders`)، و `aggregation-settings`، `purchase-order-policies`، `purchase-order-approvals` و `receipts` افزوده می‌شوند (بی هیچ
  Prefix برای `AUDITOR`، آزمون `routes.spec.ts`)؛ مهلت Gateway برای بازگشایی هم‌اندازهٔ `GATEWAY_TENDER_OPEN_TIMEOUT_MS`.
- E2E (در مالکیت `tests/e2e`): نیاز → تجمیع → RFQ → پیشنهاد → بازگشایی → ارزیابی → سفارش (با سیاست) → رسید؛ و منفی‌ها (سازمان سوم، دعوت‌نشده، تعارض
  منافع، بی سیاست).

## بیرون از COM-007 (نام‌دار، ساخته نمی‌شوند)

| چه                                                                                  | چرا                                               | مالک تصمیم             |
| ----------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------- |
| مصرف `PURCHASE_ORDER_ISSUED`/`GOODS_RECEIVED` در economic                           | Q-124 باز؛ ADR-032 موکول                          | economic + صاحب محصول  |
| `PurchaseOrderReceiptConsumer` در inventory                                         | Q-123؛ ADR-056 § ۷                                | inventory + صاحب محصول |
| قاعدهٔ اعلان دعوت تأمین‌کننده                                                       | پیکربندی notification؛ نه کد procurement          | notification           |
| قالب معیار سازمانی، روش قیمتی، چند ارزیاب                                           | ADR-067، Q-88، Q-92                               | صاحب محصول             |
| تجمیع میان سازمان‌ها، RFQ عمومی، خرید چندتأمین‌کننده‌ای                             | Q-119، Q-121، Q-122                               | صاحب محصول + کارفرما   |
| Temporal برای پنجره و مهلت                                                          | ADR-070 § ۱۱؛ D-055                               | معماری (ADR جدا)       |
| برداشتن `procurement-service` از `@AllowService` economic (تراکنش‌ها، `wallets/me`) | بی‌مصرف از 2026-08-29 و با PR 1 زنده؛ ADR-070 § ۷ | economic               |
| صفحه‌های `/procurement/*` در `apps/web`                                             | `EXP-004`، پس از PR 14                            | Frontend               |
