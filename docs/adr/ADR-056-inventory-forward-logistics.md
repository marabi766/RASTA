# ADR-056: مرز، صحت موجودی و لجستیک رفت `inventory-service`

- **وضعیت:** Proposed
- **تاریخ:** 2026-09-17
- **تصمیم‌گیرنده:** معماری پلتفرم (C1)
- **اهمیت:** مرز سرویس، صحت داده عملیاتی، همروندی، جداسازی مستأجر — نخستین ADR
  `inventory-service`
- **مرتبط:** ADR-005 (مالکیت پایگاه داده)، ADR-011 (چندمستأجری)، ADR-031
  (هماهنگی تسویه بدون Redis)، ADR-036 (کلید پارتیشن)، ADR-037 (مالکیت
  Aggregate در marketplace)، ADR-041 (مرز موقت وابستگی‌های نبود)، ADR-048 (مرز
  لجستیک معکوس)، ADR-050 (Claim بادوام Outbox)، ADR-051 (ترتیب معنایی Outbox)
- **Story:** `COM-006` — می‌ماند `READY`، بدون امتیاز Story تا پیاده‌سازی و
  پذیرش. این سند تصمیم معماری است، نه گزارش پیاده‌سازی.

> این ADR **طراحی** است. هیچ جدول، Migration، Endpoint یا Consumer‌ای که پایین
> آمده امروز وجود ندارد. `services/inventory-service` هنوز ساخته نشده. برنامهٔ
> اجرا در [ADR-056-implementation-plan.md](ADR-056-implementation-plan.md) است.

## Context

`docs/04` § ۴٫۱۱ مأموریت، مالکیت داده، Command/Query و رویدادهای
`inventory-service` را از پیش نوشته: `warehouse`، `stock_item`،
`stock_movement`، `stock_reservation`، `shipment`، `shipment_leg`،
`tracking_event`. `docs/17` § ۱۷٫۲ آن را P1 گذاشته با دو Acceptance Criteria:
«رزرو با قفل؛ حرکت موجودی» و «کاربر وضعیت تحویل را می‌بیند». `planning/backlog.json`
آن را `COM-006` نام‌گذاری کرده، `READY`، ۲۱ امتیاز، با وابستگی رسمی به
`COM-005`.

بازرسی مستقیم کد و اسناد چهار شکاف را نشان داد که پیش از هر خط کد باید بسته
شوند:

1. **`docs/04` § ۴٫۱۱ ردیف Dependencies و Scale «Redis Redlock» را برای رزرو
   موجودی می‌خواهد** — دقیقاً همان مکانیزمی که ADR-031 برای تسویه رد کرده بود
   («Redis در هیچ مسیر مالی استفاده نمی‌شود») بدون آنکه خودِ این ADR نوشته شده
   باشد. تغییر Stack بدون ADR بدهی معماری است (`AGENTS.md` § تغییر Stack).
2. **`docs/04` § ۴٫۱۱ مأموریت را «انبار مرکزی اتحادیه» نوشته و مرز امنیتی را
   «فقط `UNION_ADMIN`»** — یک انبار، یک مالک، یک نقش. این با اصل
   Organization-Agnostic (ADR-012، CLAUDE.md اصل ۲) در تناقض است: انبار می‌تواند
   نزد یک شرکت، یک سازمان دولتی یا یک سازمان ملی هم باشد، نه فقط اتحادیه.
3. **`marketplace-service` از پیش یک `Fulfillment` دارد** (ADR-037 § ۲) —
   ادعای تحویل **خودِ تأمین‌کننده**، متن آزاد و مبهم برای این سرویس
   (`trackingReference`، `note`)، بدون هیچ ارتباط با یک محمولهٔ فیزیکی واقعی.
   `inventory-service` مفهوم دوم و مستقلی به نام `Shipment` می‌آورد. این دو باید
   صریحاً از هم جدا شوند، وگرنه یک سفارش با حمل مستقیم تأمین‌کننده (بدون عبور
   از انبار پلتفرم) وانمود می‌کند که یک محمولهٔ ردیابی‌شدهٔ `inventory-service`
   دارد.
4. **`ORDER_CREATED`/`ORDER_CANCELLED` امروز رزرو موجودی را فراخوانی نمی‌کنند**
   (ADR-041 § ۲): گام `RESERVE_STOCK` در Saga سفارش `DEFERRED` است و هیچ
   Activity ندارد. `inventory-service`، وقتی ساخته شود، **مصرف‌کنندهٔ فعالی
   برای این رویدادها نخواهد داشت** تا marketplace این گام را از حالت Deferred
   خارج کند — که تصمیمی در آن سرویس است، نه اینجا.

بازرسی گیت‌وی (`services/api-gateway/src/config/routes.ts`) نشان داد
Prefixهای `warehouses`، `stock` و `shipments` از پیش به `inventory` مسیریابی
شده‌اند (الگوی ADR-041: Prefix می‌ماند، Handler نیست) اما **هیچ‌کدام
`requiresIdempotencyKey` ندارند** — با اینکه `ReserveStock`، `IssueStock` و
`CreateShipment` اثر غیرقابل‌برگشت می‌سازند، دقیقاً همان کلاس عملیاتی که
`orders`، `wallets` و `purchase-orders` را به این پرچم رسانده.

بازرسی `maintenance-service` (`PROJECT_MEMORY.md` بخش ۷) نشان داد
`PartUsage.sourceReference` از پیش یک ارجاع مبهم به `inventory-service` نگه
می‌دارد و صریحاً نوشته «نساخته». `supplier-service` Phase 1 روی `main` است
(Merge `36d718cf`) اما Phase 2 (امتیاز عملکرد) شروع نشده و `COM-005`
`IN_PROGRESS` می‌ماند بدون امتیاز.

## Decision

### ۱. مرز مالکیت — بدون تغییر در جدول داده، با اجرای سخت‌گیرانه‌تر

`inventory-service` مالک انحصاری هفت جدول `docs/04` § ۴٫۱۱ است:
`warehouse`، `stock_item`، `stock_movement`، `stock_reservation`، `shipment`،
`shipment_leg`، `tracking_event`. هیچ سرویس دیگری این جداول را نمی‌خواند یا
نمی‌نویسد (A-01). به‌صراحت:

- **تعریف کالا** نزد `marketplace` می‌ماند. `stock_item.productId` یک ستون
  `String` مبهم است — همان الگوی `Offer.supplierOrganizationId` در ADR-037 §
  ۶ — **بدون Foreign Key میان‌پایگاه‌داده‌ای**.
- **سفارش خرید** نزد `procurement` می‌ماند (وقتی ساخته شود). `stock_movement`
  و `stock_reservation` یک ستون مبهم `sourceReference` دارند (شکل
  `ORD_<ULID>` یا `PO_<ULID>`)، نه یک رابطه واقعی.
- **مرجوعی، حمل برگشت، بازرسی فیزیکی و Disposition** نزد `inventory-service`
  هستند اما **در دامنهٔ این ADR نیستند** — مرزشان از پیش در ADR-048 بسته شده
  و § ۷ همین سند آن را تکرار می‌کند.

### ۲. `Shipment` در برابر `Fulfillment` — دو مفهوم، دو مالک، یک رابطهٔ صریح

| مفهوم         | مالک                  | چیست                                                                                                                                                          | امروز                     |
| ------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| `Fulfillment` | `marketplace-service` | **ادعای تأمین‌کننده** که سفارش را تحویل داده — متن آزاد (`trackingReference`، `note`)، مبهم برای این سرویس، بدون رابطه با هیچ حرکت فیزیکی واقعی (ADR-037 § ۲) | پیاده و زنده              |
| `Shipment`    | `inventory-service`   | **حرکت فیزیکی واقعی** یک محموله از یک انبار پلتفرم‌مدیریت‌شده، با `ShipmentLeg` و `TrackingEvent` قابل رهگیری                                                 | این ADR — هنوز پیاده نشده |

**قاعده.** یک `Order` می‌تواند صفر یا یک `Fulfillment` و صفر یا یک زنجیرهٔ
`Shipment` مرتبط داشته باشد — این دو **مستقل**اند:

- سفارشی که تأمین‌کننده مستقیماً برای خریدار ارسال می‌کند (بدون عبور از انبار
  پلتفرم) هرگز `Shipment` نخواهد داشت. `Fulfillment` تنها رکورد است و باید
  همچنان مبهم بماند — **هیچ کدی در `inventory-service` یا `marketplace`
  اجازه ندارد برای چنین سفارشی یک `Shipment` ساختگی بسازد** تا فیلد خالی پر
  شود.
- سفارشی که از یک انبار پلتفرم‌مدیریت‌شده تحویل می‌شود می‌تواند **هم**
  `Fulfillment` (ادعای تأمین‌کننده) **هم** `Shipment` (رهگیری واقعی) داشته
  باشد — این دو منبع حقیقت جداگانه‌اند و **یکی جای دیگری را تأیید نمی‌کند**.

**اتصال، نه ادغام.** اتصال `Fulfillment` به `Shipment` فقط با یک ستون مرجع در
سمت `marketplace` (مثلاً `Fulfillment.inventoryShipmentId`، Nullable، بدون
Foreign Key) ممکن است — و ساختن آن ستون و Consumer ای که پرش کند، **تصمیم
`marketplace-service` است، خارج از این ADR**. تا آن زمان دو رکورد کنار هم
می‌مانند، بدون ادعای هم‌ارزی.

**آنچه این ADR تصمیم نمی‌گیرد.** اینکه UI خریدار وقتی هر دو رکورد وجود دارند
کدام را «وضعیت تحویل» نمایش دهد، یک قاعدهٔ محصولی نمایشی است، نه یک تصمیم
معماری. حدس زده نمی‌شود — **Q-44** در `docs/24-open-questions.md` ثبت شد.

### ۳. صحت موجودی — دفتر حرکت الحاقی + مانده در همان تراکنش

**مدل داده.**

```
stock_item (
  id, warehouse_id, product_id,               -- product_id مبهم، بدون FK
  on_hand_quantity   integer NOT NULL,
  reserved_quantity  integer NOT NULL,
  available_quantity integer GENERATED ALWAYS AS
                        (on_hand_quantity - reserved_quantity) STORED,
  CHECK (on_hand_quantity >= 0),
  CHECK (reserved_quantity >= 0),
  CHECK (reserved_quantity <= on_hand_quantity),   -- available >= 0 به‌طور استنتاجی
  UNIQUE (warehouse_id, product_id)
)

stock_movement (                                -- فقط‌الحاقی
  id, stock_item_id, warehouse_id, type,          -- RECEIPT|RESERVE|RELEASE|ISSUE|ADJUSTMENT
  quantity_delta, on_hand_after, reserved_after,
  source_reference,                                -- ORD_/PO_/ADJ_ مبهم
  idempotency_key UNIQUE, correlation_id, created_at, created_by
)

stock_reservation (
  id, stock_item_id, warehouse_id, holder_organization_id,
  order_reference, quantity, status,               -- ACTIVE|CONSUMED|RELEASED|EXPIRED
  idempotency_key UNIQUE, expires_at, created_at, released_at, consumed_at
)
```

**تغییرناپذیری.** `stock_movement` مثل `ledger_entry` (ADR § ۳٫۳ Invariant
جدول) با یک Trigger پایگاه داده `BEFORE UPDATE OR DELETE` مسدود می‌شود. اصلاح
فقط با یک ردیف `ADJUSTMENT` جدید ممکن است، نه ویرایش ردیف موجود.

**اتمیک بودن.** هر Command (`ReserveStock`، `ReleaseReservation`،
`IssueStock`، `ReceiveStock`، `AdjustStock`) در **یک تراکنش پایگاه داده** هم
`stock_movement` را درج می‌کند هم `stock_item.on_hand_quantity` /
`reserved_quantity` را به‌روز می‌کند. این دو هرگز در دو تراکنش جدا نیستند —
درست همان درسی که ADR-028 برای `maintenance_cost` ثبت کرد: مجموع باید از
رویدادها بازمحاسبه و در همان تراکنش نگه داشته شود، نه یک Counter مجزا که
می‌تواند از منبع واقعی جدا بیفتد.

**گذارهای رزرو — ماشین حالت صریح:**

```
                 ReserveStock                 IssueStock
   (هیچ)  ────────────────►  ACTIVE  ─────────────────►  CONSUMED
                                │
                                │ ReleaseReservation یا انقضا
                                ▼
                            RELEASED / EXPIRED
```

- `ReserveStock`: `reserved_quantity += n`؛ `on_hand_quantity` **تغییر
  نمی‌کند**. `CHECK (reserved_quantity <= on_hand_quantity)` رد می‌کند اگر
  ظرفیت کافی نباشد — بدون بررسی جداگانه در Application که فراموش‌شدنی است.
- `ReleaseReservation` (لغو سفارش، انقضا): `reserved_quantity -= n`؛
  `on_hand_quantity` تغییر نمی‌کند.
- `IssueStock` (مصرف رزرو، خروج فیزیکی): `on_hand_quantity -= n` **و**
  `reserved_quantity -= n` در یک نوشتن — چون کالا هم از انبار خارج شده هم
  رزرو تمام شده.
- `ReceiveStock`: `on_hand_quantity += n`. `reserved_quantity` تغییر
  نمی‌کند.
- بدون رزرو فعال، `IssueStock` مستقیم روی `on_hand_quantity` مجاز است (مثلاً
  اصلاح انباری) و یک `stock_movement` نوع `ADJUSTMENT` می‌سازد.

**Idempotency.** هر Command یک `Idempotency-Key` می‌گیرد (هدر `X-Idempotency-Key`
یا معادل `docs/06` § ۶٫۸) که مستقیماً `stock_movement.idempotency_key`
(`UNIQUE`) می‌شود. تکرار درخواست با همان کلید همان ردیف را برمی‌گرداند، اثر
دوم نمی‌گذارد — همان الگوی `idempotency_record` که `economic-service` و
`marketplace-service` از پیش دارند.

**ترتیب قفل قطعی.** وقتی یک Command بیش از یک `stock_item` را لمس می‌کند
(مثلاً رزرو چند SKU برای یک سفارش)، ردیف‌ها به **ترتیب صعودی `stock_item.id`**
(ULID، پس ترتیب صعودی = ترتیب ساخت) با `SELECT ... FOR UPDATE` قفل می‌شوند —
دقیقاً الگوی ترتیب `wallet.id` در ADR-031، که Deadlock را **ساختاری غیرممکن**
می‌کند، نه فقط کم‌احتمال.

**همروندی زیر آزمون واقعی.** الزام پذیرش: «N رزرو موازی روی موجودی M واحدی،
دقیقاً M رزرو موفق، هرگز `available_quantity` منفی» — با PostgreSQL واقعی، نه
Mock، به همان شکل که `economic-service` «۱۰۰ برداشت موازی، ۱۰ موفق از ۱۰۰
برای موجودی ۱۰ واحدی» را زنده اثبات کرد (`PROJECT_MEMORY.md` بخش ۷-ج).

**بازیابی از Crash.** چون درج `stock_movement` و به‌روزرسانی `stock_item` در
یک تراکنش ACID هستند، هیچ حالت میانی روی دیسک باقی نمی‌ماند — Rollback
پایگاه داده کامل است. آنچه از Crash عبور می‌کند مسیر Outbox است (انتشار پس از
Commit)، که مکانیزمش را § ۶ از ADR-050/۰۵۱ به‌طور کامل به عاریت می‌گیرد، نه
دوباره می‌سازد.

### ۴. Redis Redlock رد شد — قفل ردیف پایگاه داده جایگزین آن است

`docs/04` § ۴٫۱۱ ردیف Dependencies و Scale «Redis Redlock» را برای رزرو
موجودی خواسته بود. **این ADR آن را رد می‌کند و با قفل ردیف PostgreSQL
(`SELECT ... FOR UPDATE`) جایگزین می‌کند** — با همان استدلال ADR-031 برای
هماهنگی تسویه، که این‌جا کلمه‌به‌کلمه صادق است:

- **حوزهٔ شکست.** یک قفل Redlock بیرون از تراکنشی است که واقعاً داده را
  تغییر می‌دهد. اگر Redis منقضی شود (GC Pause، Clock Drift، افت شبکه) پیش از
  آنکه تراکنش PostgreSQL Commit شود، دو فرآیند می‌توانند هم‌زمان معتقد باشند
  قفل را دارند — دقیقاً همان نقد شناخته‌شدهٔ Redlock (Martin Kleppmann، «How
  to do distributed locking») که پیشتر در ADR-031 برای تسویه رد شده بود. قفل
  ردیف PostgreSQL این مشکل را ندارد چون خودِ چیزی است که تراکنش را می‌بندد،
  نه چیزی بیرون از آن که باید با آن هماهنگ بماند.
- **حوزهٔ شکست، برعکس.** افت PostgreSQL همین حالا `inventory-service` را
  کاملاً می‌خواباند (بدون پایگاه داده، بدون سرویس). افزودن Redis یک حوزهٔ
  شکست **دوم** اضافه می‌کند بدون آنکه هیچ ضمانتی که PostgreSQL از پیش ندارد
  اضافه کند.
- **همسانی با پیشینه.** ADR-025 (انحصار تخصیص) با Partial Unique Index و
  بدون Redis بسته شد؛ ADR-031 (تسویه) با ترتیب قطعی `wallet.id` و بدون Redis
  بسته شد. یک سوم قفل توزیع‌شده برای رزرو موجودی، الگوی معماری یکنواخت
  پلتفرم را می‌شکست بدون آنکه مزیت اندازه‌گیری‌شده‌ای بیاورد.
- **مقیاس واقعی.** `docs/04` § ۴٫۱۱ خودش نوشتن را «متوسط» ارزیابی کرده — نه
  حجمی که یک قفل بیرونی برای آن توجیه داشته باشد.

**این تصمیم `docs/04` § ۴٫۱۱ را اصلاح می‌کند** (§ ۸ همین سند). `Redis` از
فهرست Dependencies حذف و ردیف Scale بازنویسی می‌شود.

### ۵. مرز مستأجر و مجوزدهی — سه نقش، نه یک نقش

`docs/04` § ۴٫۱۱ مرز امنیتی را «موجودی انبار مرکزی فقط برای `UNION_ADMIN`»
نوشته بود — یک انبار، یک مالک فرضی. این ADR سه نقش جدا تعریف می‌کند که هرکدام
ممکن است سازمان متفاوتی باشند:

| نقش                | ستون                                     | مثال                                                                                                       |
| ------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **مالک انبار**     | `warehouse.ownerOrganizationId`          | سازمانی که انبار را عملیاتی می‌کند — اتحادیه، شرکت، سازمان دولتی یا ملی؛ **هیچ‌کدام Hard-Code نیست**       |
| **دارندهٔ رزرو**   | `stock_reservation.holderOrganizationId` | سازمانی که به نامش رزرو شده — معمولاً سازمان خریدار یک `Order` یا سازمان درخواست‌کنندهٔ یک `PurchaseOrder` |
| **گیرندهٔ محموله** | `shipment.consigneeOrganizationId`       | سازمانی که محموله برایش ارسال می‌شود — می‌تواند با دارندهٔ رزرو یکی باشد یا نباشد                          |

**بررسی سطح Object، نه فقط نقش.**

- خواندن/نوشتن موجودی یک انبار: کاربر باید عضو `warehouse.ownerOrganizationId`
  باشد **و** نقشی داشته باشد که پیکربندی آن سازمان اجازه می‌دهد (نه صرفاً
  عضویت در نقش سراسری `UNION_ADMIN`). در استقرار پیش‌فرض اتحادیه‌محور،
  `UNION_ADMIN` همان نقش پلتفرمی است که امروز `ledger` و `audit-events` را هم
  می‌بیند (`docs/02` § ۲، الگوی موجود) — اما این یک **پیکربندی نقش روی یک
  مالک**، نه فرض ساختاری «همه انبارها مال اتحادیه‌اند».
- خواندن یک رزرو: `holderOrganizationId` **یا** `warehouse.ownerOrganizationId`
  — همان الگوی دوطرفهٔ `Order.organizationId`/`Order.supplierOrganizationId`
  در ADR-037 § ۸. عبور از مرز (مالک انبار که رزرو یک خریدار را می‌بیند)
  مجاز اما با دلیل ثبت‌شده است.
- خواندن یک `Shipment`/رهگیری: `consigneeOrganizationId` **یا**
  `originWarehouse.ownerOrganizationId`. سازمان سومی که در هیچ نقشی نیست
  `404` می‌گیرد.

**قاعدهٔ پاسخ.** مطابق ADR-011: منبع متعلق به مستأجر نامربوط →
**`404 NOT_FOUND`**، نه `403`.

**آزمون‌های جداسازی مستأجر الزامی (منفی):**

1. سازمان B نمی‌تواند موجودی انباری را که `ownerOrganizationId` آن سازمان A
   است فهرست یا تغییر دهد → `404`.
2. سازمان C که نه دارندهٔ رزرو است نه مالک انبار، نمی‌تواند یک `StockReservation`
   را بخواند، آزاد کند یا مصرف کند → `404`.
3. سازمان D که نه Consignee است نه مالک انبار مبدأ، نمی‌تواند یک `Shipment`
   را رهگیری کند → `404`.
4. دارندهٔ یک رزرو نمی‌تواند رزرو سازمان دیگری را در **همان** انبار آزاد یا
   مصرف کند، حتی اگر هر دو رزرو روی یک `stock_item` باشند → `404`، نه فقط رد
   منطق کسب‌وکار.
5. کاربر با نقش سازمانی معتبر اما بدون عضویت در `ownerOrganizationId` انبار،
   `CreateWarehouse` را برای آن سازمان دیگر تلاش می‌کند → `403` (نقض
   مجوزدهی سطح Endpoint، نه فقط Object، چون منبع هنوز وجود ندارد).

### ۶. رویداد و قرارداد — از زیرساخت موجود، نه از صفر

`inventory-service` مستقیماً از بستهٔ مشترک `@rasta/nest-common/outbox`
استفاده می‌کند — همان Claim بادوام ADR-050 (`claim_token`، Lease، Heartbeat)
و همان زیرساخت ترتیب معنایی ADR-051 (`streamSeq`، `streamKey`،
`outbox_stream_sequence`) که امروز در آن بسته پیاده‌اند. این سرویس چیزی
دوباره نمی‌سازد؛ **دو جریان** را طبقه‌بندی می‌کند، به همان شکلی که ADR-051 §
D-1 برای هر جریان جدید می‌خواهد (Mapped Type در `routing.ts`، مثل
`PARTITION_KEY_POLICY` در `marketplace-service`):

| جریان (`topic + partitionKey`)       | کلاس       | چرا                                                                                              |
| ------------------------------------ | ---------- | ------------------------------------------------------------------------------------------------ |
| `rasta.inventory.v1` + `stockItemId` | **STRICT** | `RESERVED` پیش از `ISSUED` معنا دارد؛ وارونگی یعنی خروج فیزیکی کالایی که هرگز به‌درستی رزرو نشده |
| `rasta.inventory.v1` + `shipmentId`  | **STRICT** | `DISPATCHED` پیش از `DELIVERED`؛ وارونگی یک محمولهٔ «تحویل‌شده پیش از ارسال» می‌سازد             |

هر دو روی **یک Topic** با `partitionKey` جداگانه (همان الگوی
`rasta.economic.v1`: چند جریان مستقل روی یک Topic، ADR-036). رویدادها:

- **جریان `stockItemId`:** `STOCK_RECEIVED` · `STOCK_RESERVED` ·
  `STOCK_RELEASED` · `STOCK_ISSUED` · `LOW_STOCK_DETECTED`.
- **جریان `shipmentId`:** `SHIPMENT_CREATED` · `SHIPMENT_DISPATCHED` ·
  `SHIPMENT_DELIVERED`.

**Idempotent Consumers.** هر Consumer آینده (وقتی marketplace/procurement
واقعاً منتشر کنند) از `processed_event` طبق الگوی ADR-032 استفاده می‌کند: علامت
«پردازش شد» فقط پس از اعمال واقعی اثر زده می‌شود، نه در ورودی Handler.

**Correlation ID.** هر Command و رویداد منتشرشده `correlationId` را از
درخواست محرک (سفارش، سفارش خرید، یا تراکنش عملیاتی داخلی) حمل می‌کند — همان
ستون که `Order` و `Transaction` دارند.

**بدون تضمین ترتیب میان‌Topic.** ضمانت ADR-051 محدود به `topic + partitionKey`
است. یک Consumer که `rasta.marketplace.v1` و `rasta.inventory.v1` را با هم
می‌خواند **هیچ فرضی** درباره ترتیب نسبی نمی‌تواند بکند — مثلاً `ORDER_CREATED`
و آیندهٔ `STOCK_RESERVED` (وقتی ساخته شود) روی دو Topic جدا هستند و ترتیب
میانشان تعریف‌نشده می‌ماند، دقیقاً همان مرزی که ADR-051 § C-7 برای
`fleet`/`maintenance` ثبت کرد.

### ۷. پورت‌های یکپارچگی — نام‌دار، نه ادعاشده

هیچ‌کدام از این سه یکپارچگی امروز وجود دارد. این ADR هرکدام را با یک Port
نام‌گذاری می‌کند، به همان الگوی `SupplierQualificationPort`
(ADR-041) و `WorkshopDirectory` (ADR-029):

| Port                           | مصرف‌کننده                  | وضعیت                                                                                                                                                                                                                   |
| ------------------------------ | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OrderReservationConsumer`     | `inventory` ← `marketplace` | **ساخته نمی‌شود در این فاز.** `ORDER_CREATED`/`ORDER_CANCELLED` امروز هیچ رزروی را فراخوانی نمی‌کنند (ADR-041 § ۲؛ گام `RESERVE_STOCK` در Saga `DEFERRED` است). فعال‌سازی این Port تصمیم **`marketplace-service`** است. |
| `PurchaseOrderReceiptConsumer` | `inventory` ← `procurement` | **ساخته نمی‌شود.** `procurement-service` وجود ندارد (`services/procurement-service` خالی است).                                                                                                                          |
| `PartConsumptionReference`     | `maintenance` → `inventory` | یک‌طرفه، فقط‌خواندنی. `PartUsage.sourceReference` از پیش مبهم نگه داشته می‌شود؛ اتصال واقعی، تصمیم **`maintenance-service`** است، نه اینجا.                                                                             |

**آنچه ادعا نمی‌شود.** `inventory-service`، در روز اول، **مصرف‌کنندهٔ فعالِ
هیچ رویداد سرویس دیگری نخواهد بود**. Command هایش (`ReceiveStock`،
`ReserveStock`، …) از راه REST فراخوانی می‌شوند — از یک عملیات مستقیم انباری
یا از یک Activity که `marketplace`/`procurement` بعداً و صریحاً اضافه
می‌کنند. این با درس ADR-032 یکسان است: Consumer خالی برای رویدادی که کسی
منتشر نمی‌کند، نساز.

### ۸. دامنه — فقط لجستیک رفت؛ COM-005 پیش‌نیاز واقعی نیست

`COM-006` طبق `docs/17` § ۱۷٫۲ پوشش می‌دهد: **انبار، موجودی، رزرو، حرکت
موجودی، محموله و رهگیری** — یعنی هفت جدولی که § ۱ فهرست کرد. لجستیک معکوس
(`ReturnRequest`، `WarrantyClaim`، `ReturnShipment`، `ReturnInspection`،
`Disposition`) **در این ADR نیست**؛ مرزش از پیش در ADR-048 بسته شده و آن
تصمیم دست‌نخورده می‌ماند. اگر بعداً `ReturnShipment` پیاده شود، ساختار
`Shipment`/`ShipmentLeg`/`TrackingEvent` همین سند را دوباره‌استفاده می‌کند
اما تصمیم تجاری مرجوعی همچنان نزد `marketplace`/`contract` می‌ماند (ADR-048 §
۲).

**یافتهٔ بررسی وابستگی.** `planning/backlog.json` `COM-006` را وابسته به
`COM-005` (Supplier Phase 2 — امتیاز عملکرد) فهرست کرده. بازرسی کد **هیچ
اتصال واقعی** میان امتیاز عملکرد تأمین‌کننده و مالکیت انبار، موجودی یا رهگیری
محموله پیدا نکرد: هیچ Command یا Query در § ۱ این ADR به `SupplierQualification`
یا `PerformanceScore` نیاز ندارد. این وابستگی، **مسدودکننده نیست** برای گام‌های
زیر، که می‌توانند مستقل از پیشرفت `COM-005` شروع شوند:

- تمام § ۳ (مدل موجودی، رزرو، حرکت، قفل، Idempotency) — بدون هیچ وابستگی به
  `supplier`.
- تمام § ۵ (انبار، مرز مستأجر) — فقط به `identity`/`organization` نیاز دارد.
- تمام § ۶ (Shipment/Leg/TrackingEvent و انتشار رویداد) — بدون وابستگی به
  `supplier`.

آنچه واقعاً به یکپارچگی‌های دیگر نیاز دارد — نه به `COM-005` — همان سه Port §
۷ است: فعال‌سازی `OrderReservationConsumer` منتظر تصمیم `marketplace` است و
`PurchaseOrderReceiptConsumer` منتظر ساخت `procurement-service` است.

این یافته `backlog.json` را **تغییر نمی‌دهد** — تغییر وابستگی یا امتیاز
Story نیازمند تأیید صاحب محصول است. برنامهٔ اجرا این تفکیک را به‌عنوان
**فاز A** (بدون‌وابستگی) و **فاز B** (منتظر یکپارچگی) دنبال می‌کند.

## Alternatives Considered

| گزینه                                                              | مزیت                                          | عیب                                                                            | چرا رد شد                                                            |
| ------------------------------------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Redis Redlock برای رزرو (طرح اصلی `docs/04`)                       | تجربهٔ آشنا برای تیم‌های Redis-محور           | حوزهٔ شکست دوم؛ بدون اتمیک بودن با نوشتن واقعی؛ نقض الگوی یکنواخت پلتفرم       | ADR-031 همین استدلال را برای تسویه رد کرده بود؛ اینجا تکرار نمی‌شود  |
| قفل بدبینانه سراسری (Advisory Lock) روی کل انبار                   | ساده                                          | یک انبار پرترافیک، همهٔ رزروها را سریالایز می‌کند حتی روی SKUهای متفاوت        | دانه‌بندی اشتباه — قفل باید روی `stock_item` باشد نه `warehouse`     |
| ادغام `Shipment` در `Fulfillment` مارکت‌پلیس                       | یک جدول کمتر                                  | مالکیت را مخلوط می‌کند؛ marketplace باید دربارهٔ انبار فیزیکی بداند (نقض A-01) | ADR-037 § ۲ از پیش این را رد کرده بود                                |
| مصرف‌کنندهٔ خالی `ORDER_CREATED` «برای آماده بودن»                 | وقتی marketplace گام را فعال کند، کاری نمانده | Handler ای که چیزی محاسبه نمی‌کند رد «پردازش شد» می‌گذارد (ADR-032)            | همان درسی که ADR-041 § ۲ برای `STOCK_RESERVED` ثبت کرد               |
| ساخت `procurement-service` هم‌زمان برای تکمیل Consumer دریافت کالا | یکپارچگی کامل‌تر                              | خارج از دامنهٔ `COM-006`؛ Scope Creep روی سرویسی که هیچ ADR ندارد              | هر سرویس ADR مستقل خودش را می‌خواهد؛ اینجا فقط Port نام‌گذاری می‌شود |
| مالکیت رزرو نزد `marketplace` (به‌جای `inventory`)                 | یک تراکنش کمتر برای Saga                      | نقض A-01 (marketplace باید جدول انبار را بخواند)؛ تقسیم مالکیت فیزیکی/تجاری    | همان استدلال ADR-037 § ۲ برای `Fulfillment`/`Shipment`               |

## Consequences

**مثبت**

- الگوی قفل، ترتیب Outbox و Idempotency یکسان با بقیهٔ پلتفرم می‌ماند — بدون
  Stack تازه، بدون مکانیزم دوم.
- انبار می‌تواند نزد هر نوع سازمانی باشد؛ مجوزدهی از ستون مالکیت می‌آید، نه از
  یک نقش سراسری فرضی.
- تمایز `Shipment`/`Fulfillment` از روز اول جلوی یک کلاس کامل باگ محصولی
  («سفارش می‌گوید محموله دارد ولی هرگز از انبار پلتفرم عبور نکرده») را می‌گیرد.
- بخش بزرگی از کار (§ ۳، § ۵، § ۶) می‌تواند بدون انتظار برای `COM-005` یا
  `procurement-service` شروع شود.

**منفی، پذیرفته‌شده**

- بدون Consumer فعال برای `ORDER_CREATED`، رزرو موجودی واقعی **در روز اول
  اتفاق نمی‌افتد** — سفارش‌های marketplace همچنان فقط `Offer.availableQuantity`
  را کم می‌کنند (ADR-041 § ۲)، نه موجودی انبار واقعی. این ADR این شکاف را
  می‌بندد که چه چیزی ادعا نمی‌شود، نه خودِ شکاف را.
- `stock_item.available_quantity` به‌عنوان ستون Generated، Migration را
  کمی سخت‌تر می‌کند (نیازمند `GENERATED ALWAYS ... STORED`، که در Rollback
  باید دقیقاً معکوس شود) — هزینه‌ای پذیرفته‌شده برای حذف یک کلاس باگ محاسبهٔ
  دستی.
- قاعدهٔ نمایش ترکیبی `Fulfillment`+`Shipment` باز می‌ماند (Q-44) — یک تصمیم
  UI که تا پاسخ صاحب محصول با نشان دادن دو منبع مستقل جای‌گزین می‌شود، نه با
  یک قاعدهٔ حدسی.
- تصحیح `docs/04` § ۴٫۱۱ (§ ۹ همین سند) یعنی سند پیشین تا این ADR ناسازگار
  با کد خواهد بود — پذیرفته‌شده تا زمان Merge.

**خنثی**

- هفت جدول مالکیت داده بدون تغییر نسبت به `docs/04` می‌ماند؛ این ADR فقط
  رفتار و مرزهایشان را دقیق می‌کند.

## ۹. تصحیح‌های لازم در اسناد دیگر

- **`docs/04-service-decomposition.md` § ۴٫۱۱.** ردیف Dependencies و Scale
  (Redis Redlock) و مأموریت/مرز امنیتی (فرض تک‌مالکی «اتحادیه») با این ADR
  اصلاح می‌شوند — تغییر مستقیم در همان فایل، با یادداشت ارجاع به ADR-056،
  به همان الگوی اصلاحیهٔ ۲۰۲۶-۰۹-۰۷ موجود در § ۴٫۱۵ همان سند.
- **`docs/24-open-questions.md`.** `Q-44` برای قاعدهٔ نمایش
  `Fulfillment`/`Shipment` ثبت شد.
- **`docs/21-adr-list.md`.** ردیف `056` و خلاصهٔ تصمیم افزوده شد.

## Compliance

- **A-01** — بدون جدول مشترک، بدون Foreign Key میان‌سرویسی؛ `product_id` و
  `sourceReference` مبهم می‌مانند.
- **A-04** — هر جدول مستأجرمحور (`warehouse`، `stock_reservation`،
  `shipment`) ستون مالکیت/دارندگی/گیرندگی دارد و در Tenant Guard است.
- **A-05 / ADR-012** — هیچ شناسه یا فرض ساختاری «اتحادیه»، «یزد» یا هیچ نوع
  سازمانی دیگر را کد نمی‌کند؛ `warehouse.ownerOrganizationId` عمومی است.
- **A-08 / A-09** — Outbox تراکنشی (ADR-050) و Consumer Idempotent
  (ADR-032) از بسته مشترک — بدون ساخت مجدد.
- **S-03** — مجوزدهی سطح Object از سه ستون مالکیت/دارندگی/گیرندگی می‌آید، نه
  از Endpoint یا یک نقش سراسری تنها.
- **AGENTS.md § تغییر Stack** — رد Redis Redlock و پذیرش قفل ردیف، **با ADR**
  ثبت شد، نه به‌صورت بی‌سند.
- **AGENTS.md § ۹** — ابهام نمایش `Fulfillment`/`Shipment` حدس زده نشد؛
  Q-44 ثبت و تصمیم موقت (استقلال دو رکورد) گرفته شد.
- تست جداسازی مستأجر (پنج مورد منفی § ۵) الزامی است پیش از پذیرش هر Endpoint.

## References

- `docs/04-service-decomposition.md` § ۴٫۱۱، § ۴٫۱
- `docs/17-mvp-scope.md` § ۱۷٫۲
- `docs/24-open-questions.md` Q-44 (این ADR)، Q-25، Q-33
- `docs/adr/ADR-031-settlement-orchestration.md`
- `docs/adr/ADR-037-marketplace-aggregate-ownership.md`
- `docs/adr/ADR-041-marketplace-missing-dependencies.md`
- `docs/adr/ADR-048-reverse-logistics-boundary.md`
- `docs/adr/ADR-050-outbox-durable-claim.md`
- `docs/adr/ADR-051-outbox-semantic-ordering.md`
- `planning/backlog.json` — `COM-005`، `COM-006`
- `docs/adr/ADR-056-implementation-plan.md`
