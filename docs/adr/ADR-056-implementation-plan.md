# ADR-056 — برنامهٔ پیاده‌سازی (`inventory-service`، لجستیک رفت)

- **وضعیت:** برنامه — **هیچ گامی شروع نشده**
- **مرجع تصمیم:** [ADR-056](ADR-056-inventory-forward-logistics.md) (**Accepted** — 2026-09-17؛ پذیرش طراحی است، نه اجرا)
- **Story مرتبط:** `COM-006` — می‌ماند `READY`، بدون امتیاز Story تا همهٔ
  گام‌های زیر **و** شواهد پذیرش § ۱۲ پیاده و تأیید شوند. این سند امتیاز
  اعطا نمی‌کند و `backlog.json` را تغییر نمی‌دهد؛ حذف وابستگی
  `COM-006 → COM-005` نیازمند یک تغییر برنامه‌ریزی جداگانه و قابل ردیابی
  است (ADR-056 § ۸).

> این سند **برنامه** است، نه گزارش. هیچ جدول، Migration، Endpoint، Consumer یا
> پیکربندی CI که پایین آمده اجرا نشده است. هر ادعای «پیاده شد» فقط پس از اجرا
> و گذشتن از دروازه‌های آن گام معنا دارد.

---

## ۰. چرا ترتیب این‌طور است

ADR-056 § ۸ نشان داد وابستگی رسمی `COM-006 → COM-005` در `backlog.json` هیچ
اتصال کدی واقعی ندارد: فرمول امتیاز عملکرد تأمین‌کننده (Supplier Phase 2) به
هیچ Command یا Query موجودی/محموله نیاز ندارد. بنابراین **فاز A** (هستهٔ
موجودی و رزرو) و بیشتر **فاز B** (محموله و رهگیری) می‌توانند بدون انتظار برای
پیشرفت `COM-005` شروع شوند. آنچه واقعاً منتظر چیزی بیرون از این سرویس است،
صریحاً در هر گام نام برده می‌شود.

---

## فاز A — هستهٔ موجودی (بدون‌وابستگی به سرویس دیگر)

### گام ۱ — Scaffold سرویس

- `services/inventory-service` با همان اسکلت NestJS که `supplier-service`
  دارد: `app.module.ts`، `config`، `health`، `observability`، `openapi`،
  `outbox` (از `@rasta/nest-common`)، `prisma`، و همان اسکریپت‌های
  `package.json` (`dev`، `start`، `lint`، `typecheck`).
- **زیرساخت از پیش آماده است — بازرسی مستقیم، نه فرض:**
  `infrastructure/docker/postgres/00-init-databases.sh` از پیش `inventory`
  را در آرایهٔ `SERVICES` دارد، پس `pnpm infra:up` همین امروز نقش و پایگاه
  دادهٔ `rasta_inventory` را می‌سازد؛ و `.env.example` از پیش
  `DATABASE_URL_INVENTORY`، `PORT_INVENTORY` و `INVENTORY_SERVICE_URL` را
  دارد. هیچ‌کدام از این سه نیاز به تغییر ندارند.
- **الگوی اجرای محلی — مطابق واقعیت این Repository، نه فرض.**
  `docker-compose.yml` امروز **فقط زیرساخت مشترک** را تعریف می‌کند
  (`postgres`، `redis`، `kafka`، `keycloak`، `minio`، `temporal`، …) —
  **هیچ سرویس دامنه‌ای (`marketplace-service`، `supplier-service`، …) در
  آن Container جدا ندارد.** بنابراین `inventory-service` هم به یک Container
  Compose تبدیل **نمی‌شود**. اجرای محلی از همان مسیری است که هر سرویس دیگر
  دارد: `pnpm infra:up` (زیرساخت مشترک) و سپس
  `pnpm --filter @rasta/inventory-service dev` (که طبق الگوی
  `supplier-service`، `../../.env` را می‌خواند و به همان Postgres/Kafka
  مشترک وصل می‌شود).
- `services/api-gateway/src/config/routes.ts` → `serviceUrlEnvSchema` از
  پیش کلید `INVENTORY_SERVICE_URL` را دارد؛ چیزی برای افزودن نیست.
- **Dockerfile و ورودی CI Image Matrix در این گام ساخته نمی‌شوند.** وقتی
  Image واقعاً قابل Build شد، `services/inventory-service/Dockerfile` و
  ردیف متناظرش در Matrix Job `containers` (`.github/workflows/ci.yml`)
  باید **در یک Commit اتمیک** اضافه شوند — دروازهٔ موجود
  `scripts/ci-image-matrix.mjs` (بخشی از `pnpm verify`) از پیش هر Dockerfile
  بدون ردیف Matrix، یا هر ردیف Matrix بدون Dockerfile، را با شکست CI رد
  می‌کند؛ پس این هم‌زمانی به‌جای توافق تیمی، یک دروازهٔ خودکار موجود دارد.

**دروازهٔ گام ۱:** `pnpm --filter @rasta/inventory-service dev` (روی
زیرساخت بالاآمده با `pnpm infra:up`) سرویس را روی `PORT_INVENTORY` بالا
می‌آورد؛ `/health/live`، `/health/ready`، `/metrics` پاسخ می‌دهند.
`pnpm --filter @rasta/inventory-service build` جدا سبز است.

### گام ۲ — Schema پایگاه داده: `warehouse` و `stock_item`

- `warehouse(id WHS_<ULID>, owner_organization_id, name, location geography(Point,4326) NULL, status, created_at, created_by)`.
- `stock_item` طبق ADR-056 § ۳: `on_hand_quantity`، `reserved_quantity`،
  `available_quantity GENERATED ALWAYS AS (on_hand_quantity - reserved_quantity) STORED`،
  سه `CHECK` (نان‌نگتیو هر دو ستون + `reserved <= on_hand`)،
  `UNIQUE(warehouse_id, product_id)`.
- `down.sql` برای هر Migration؛ ثبت در `EXPECTED.inventory` در
  `scripts/verify-migration-reversible.mjs`.
- `outbox_message`، `processed_event`، `idempotency_record`،
  `outbox_stream_sequence` — چهار جدول زیرساخت از `@rasta/nest-common`، همان
  الگوی `marketplace`/`supplier`.

**دروازهٔ گام ۲:** `pnpm --filter @rasta/inventory-service exec prisma migrate dev`
و سپس `down` و دوباره `up` بدون خطا (`test:migration`).

### گام ۳ — `stock_movement` (دفتر الحاقی) + Trigger تغییرناپذیری

- جدول با ستون‌های ADR-056 § ۳؛ `idempotency_key UNIQUE`.
- Trigger پایگاه داده `BEFORE UPDATE OR DELETE RAISE EXCEPTION` — همان الگوی
  Trigger تغییرناپذیری `ledger_entry`.
- تست یکپارچگی مستقیم SQL: `UPDATE`/`DELETE` روی `stock_movement` باید رد
  شود، نه فقط از راه API.

**دروازهٔ گام ۳:** تست SQL خام رد شدن `UPDATE`/`DELETE` سبز.

### گام ۴ — Commandهای موجودی: `ReceiveStock` / `AdjustStock`

- تراکنش واحد: درج `stock_movement` + به‌روزرسانی `stock_item.on_hand_quantity`.
- `Idempotency-Key` اجباری (هدر)؛ تکرار → همان پاسخ، بدون اثر دوم.
- تست همروندی: ده `ReceiveStock` موازی روی یک `stock_item` → مجموع درست،
  بدون Lost Update.

**دروازهٔ گام ۴:** تست یکپارچگی روی PostgreSQL واقعی (Testcontainers)، نه Mock.

### گام ۵ — `ReserveStock` / `ReleaseReservation` / `IssueStock`

- ماشین حالت `StockReservation` (ADR-056 § ۳): `ACTIVE → CONSUMED` یا
  `ACTIVE → RELEASED/EXPIRED`.
- ترتیب قفل قطعی وقتی یک Command چند `stock_item` را لمس می‌کند: صعودی
  `stock_item.id`.
- **الزام پذیرش (از ADR-056):** N رزرو موازی روی ظرفیت M واحدی → دقیقاً M
  موفق، `available_quantity` هرگز منفی. با PostgreSQL واقعی.
- انقضای رزرو: Job دوره‌ای یا بررسی در خواندن (تصمیم مثل ADR-027: مشتق در
  خواندن، نه Cron ساکت) — انتخاب نهایی در همین گام مستند می‌شود، نه از پیش
  فرض.

**دروازهٔ گام ۵:** تست همروندی با عدد قطعی (نه «تقریباً درست») + تست Deadlock
(چند Command با ترتیب SKU متفاوت، صفر Deadlock در N تکرار).

### گام ۶ — API خواندنی + OpenAPI + Gateway

- `GET /v1/warehouses`، `GET /v1/stock`، `POST /v1/stock/reservations` و
  مسیرهای هم‌خانواده — Prefixهای `warehouses`/`stock` از پیش در
  `routes.ts` به `inventory` مسیریابی شده‌اند.
- **تصحیح لازم در `routes.ts`:** افزودن `requiresIdempotencyKey: true` به
  Prefixهای `stock` و `shipments` — بازرسی ADR-056 نشان داد این پرچم امروز
  غایب است در حالی که این Commandها اثر غیرقابل‌برگشت می‌سازند (همان کلاس
  `orders`/`wallets`/`purchase-orders`). این تغییر کد سرویس است و **در این
  فاز برنامه‌ریزی اجرا نمی‌شود** — فقط این‌جا نام‌گذاری شده تا وقتی
  پیاده‌سازی شروع شد فراموش نشود.
- OpenAPI از اپلیکیشن واقعی ساخته و با Router مقایسه شود — همان الگوی
  `supplier-service` Phase 1.

**دروازهٔ گام ۶:** تست HTTP نبود Idempotency-Key روی `POST /v1/stock/reservations`
→ `400`؛ OpenAPI Diff تست خالی.

### گام ۷ — جداسازی مستأجر و مجوزدهی

- پنج آزمون منفی ADR-056 § ۵ عیناً به‌عنوان Integration Test.
- `404` برای هر عبور مرز، `403` فقط برای نبود نقش روی Endpoint که منبعش هنوز
  ساخته نشده (مثل `CreateWarehouse` برای سازمان دیگر).

**دروازهٔ گام ۷:** هر پنج آزمون منفی سبز؛ آزمون مثبت (مالک واقعی) هم سبز.

---

## فاز B — محموله و رهگیری (بدون‌وابستگی به `COM-005`)

### گام ۸ — `shipment` / `shipment_leg` / `tracking_event`

- Schema طبق ADR-056 § ۲ و § ۶؛ `shipment.consigneeOrganizationId` و
  `originWarehouseId` جداگانه از `owner_organization_id` (که از انبار
  استنتاج می‌شود، نه ستون تکراری).
- ماشین حالت: `CREATED → DISPATCHED → DELIVERED` (یا `FAILED`).
- `tracking_event` فقط‌الحاقی، مرتب بر `occurred_at`؛ ترتیب انتشار از
  `streamSeq` جریان `shipmentId` می‌آید (گام ۹).

**دروازهٔ گام ۸:** Migration رفت‌وبرگشت سبز؛ گذار نامعتبر (`DELIVERED` قبل از
`DISPATCHED`) → `409`.

### گام ۹ — انتشار رویداد با دو جریان STRICT

- `routing.ts` با `PARTITION_KEY_POLICY` مثل `marketplace-service`: جریان
  `stockItemId` و جریان `shipmentId`، هرکدام `STRICT` (ADR-056 § ۶).
- استفاده مستقیم از `streamSeq`/`streamKey` که در
  `packages/nest-common/src/outbox/outbox.ts` از پیش پیاده است — بدون ساخت
  مکانیزم دوم.
- تست ترتیب: انتشار هم‌زمان از دو Relay روی یک جریان → صفر وارونگی (همان
  آزمون ADR-051 § R3، تکرارشده برای `inventory`).

**دروازهٔ گام ۹:** تست ترتیب با Kafka واقعی (Testcontainers)، صفر وارونگی در
N تکرار؛ Contract Test (Zod) برای هر رویداد هفت‌گانه.

### گام ۱۰ — API رهگیری + مجوزدهی گیرنده

- `GET /v1/shipments/{id}/tracking`: `consigneeOrganizationId` **یا**
  `originWarehouse.ownerOrganizationId` — سومی `404`.
- `POST /v1/shipments/{id}/deliver`: فقط با نقش معتبر روی
  `ownerOrganizationId` انبار مبدأ.

**دروازهٔ گام ۱۰:** آزمون منفی #۳ از ADR-056 § ۵ (سازمان نامربوط) سبز.

### گام ۱۱ — پورت‌های یکپارچگی (نام‌گذاری، نه فعال‌سازی)

- `OrderReservationConsumer` و `PurchaseOrderReceiptConsumer` به‌صورت
  Interface + پیاده‌سازی `Unavailable*` (الگوی `SupplierQualificationPort`)
  ساخته می‌شوند تا مسیر آینده مشخص باشد — **بدون ثبت Consumer واقعی برای
  `ORDER_CREATED`** (ADR-032: بدون Handler خالی).
- تست: فراخوانی این پورت‌ها همیشه `{ status: 'UNAVAILABLE' }` برمی‌گرداند،
  هرگز `false`/`true`.

**دروازهٔ گام ۱۱:** تست HTTP نبود Consumer فعال (فراخوانی مصرف رویداد از یک
Test Harness باید ثابت کند `processed_event` برای `ORDER_CREATED` خالی
می‌ماند).

**این گام به‌تنهایی `COM-006` را کامل نمی‌کند.** تعریف Port و اثبات
`UNAVAILABLE` فقط یعنی «هیچ ادعای کاذبی دربارهٔ یکپارچگی نیست» — شواهد
واقعی پذیرش `COM-006` در گام ۱۲ آمده. فعال‌سازی واقعی
`OrderReservationConsumer` یک تیکت جدا در `marketplace-service` است (خارج
از این ADR)، و `PurchaseOrderReceiptConsumer` منتظر ADR/ساخت
`procurement-service` می‌ماند — این دو **آشکارا افشا می‌شوند، نه تلویحاً
فرض**.

---

## گام ۱۲ — شواهد پذیرش `COM-006` (الزامی؛ تعریف Port کافی نیست)

`docs/17-mvp-scope.md` § ۱۷٫۲ دو معیار پذیرش برای `COM-006` نوشته: «رزرو با
قفل؛ حرکت موجودی» و «کاربر وضعیت تحویل را می‌بیند». هیچ‌کدام با نام‌گذاری
Port (گام ۱۱) برآورده نمی‌شود؛ این گام شواهد **قابل‌راستی‌آزمایی** هر دو
معیار را مشخص می‌کند — نه یک API یا یک Placeholder که به‌جای تجربهٔ واقعی
کاربر گزارش شود.

| معیار پذیرش (`docs/17`)        | شاهد الزامی                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| «رزرو با قفل؛ حرکت موجودی»     | تست همروندی گام ۵ (N رزرو موازی روی ظرفیت M، دقیقاً M موفق) **روی PostgreSQL واقعی**، به‌علاوه پنج آزمون منفی جداسازی مستأجر گام ۷ — همه سبز، نه فقط نوشته‌شده.                                                                                                                                                                                                                                                                                                                                                            |
| «کاربر وضعیت تحویل را می‌بیند» | یک تست E2E/API با **توکن واقعی Keycloak** برای نقشی که واقعاً مجاز است (Consignee یا مالک انبار مبدأ) که `GET /v1/shipments/{id}/tracking` را از راه Gateway واقعی فرا می‌خواند و رشتهٔ واقعی `TrackingEvent`ها را (نه یک مقدار ثابت) برمی‌گرداند. همان الگویی که `PROJECT_MEMORY.md` بخش ۷ برای «E2E زنده» بقیهٔ پلتفرم به کار برده — چون `apps/web` هنوز برای **هیچ** سرویسی ساخته نشده (NOT_STARTED)، این همان سطحِ «کاربر می‌بیند» است که تا امروز در این پلتفرم پذیرفته شده، نه یک استثنای پایین‌تر برای `inventory`. |

**آنچه شاهد کافی نیست.** یک تست Unit که Handler را ایزوله صدا می‌زند؛ تست
HTTP گام ۱۱ که فقط `UNAVAILABLE` بودن Port را اثبات می‌کند؛ یا وجود صرف
Route در `routes.ts`. هیچ‌کدام معادل «کاربر مجاز واقعی، وضعیت واقعی را
می‌بیند» نیست و نباید به‌عنوان چنین چیزی گزارش شود.

**آنچه `COM-006` نیاز ندارد.** اتصال خودکار سفارش marketplace به رزرو
واقعی موجودی — یعنی فعال‌سازی `OrderReservationConsumer` (گام ۱۱) — **جزو
این شواهد نیست**. آن یکپارچگی جداگانه، افشاشده و منتظر تصمیم
`marketplace-service` می‌ماند (ADR-056 § ۷)؛ نبودش پذیرش `COM-006` را
مسدود نمی‌کند، اما باید در گزارش پذیرش **صریحاً افشا** شود، نه پنهان یا
تلویحاً «انجام‌شده» جا زده شود.

**نتیجه.** `COM-006` تنها وقتی می‌تواند پیشنهاد Accepted شدن را بگیرد که
هر دو ردیف جدول بالا شاهد واقعی داشته باشند — و حتی آن‌وقت، Accepted شدن
تصمیم صاحب محصول روی خودِ Story است، نه یک اثر خودکار عبور از این دروازه.

## گام ۱۳ — دروازه‌های نهایی

Unit · Integration روی PostgreSQL واقعی · Kafka با Broker واقعی · ترتیب
(دو جریان STRICT) · Tenant Isolation (پنج آزمون منفی) · Idempotency (هر
Command) · OpenAPI · Gateway · Coverage (دروازهٔ ۷۵٪ بدون کاهش) · Docker
(گام ۱، وقتی Image قابل Build شد) · CI (افزودن `inventory-service` به
Matrix Image در همان Commit، طبق دروازهٔ خودکار `ci-image-matrix.mjs`). E2E
فقط اگر `inventory-service` وارد یکی از سه دامنهٔ بحرانی (`economic`،
`identity`، `construction`) شود — که نمی‌شود؛ اما سناریوی E2E حداقلی گام
۱۲ («کاربر مجاز وضعیت محموله را می‌بیند») **جدا از این دروازه الزامی است**،
چون شرط پذیرش `COM-006` است، نه یک بهبود اختیاری.

## گام ۱۴ — Backfill و استقرار

- سرویس تازه است؛ Backfill معنا ندارد (برخلاف ADR-052 که روی رویدادهای
  گذشته کار می‌کرد).
- استقرار مرحله‌ای: Schema → Command نوشتنی → API خواندنی → انتشار رویداد →
  (در آینده، جدا) فعال‌سازی Consumerهای § گام ۱۱.

---

## ریسک‌های باز

| ریسک                                                                                          | اثر                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| بدون `OrderReservationConsumer` فعال، رزرو موجودی واقعی هنوز به سفارش marketplace وصل نمی‌شود | سفارش‌های marketplace همچنان فقط `Offer.availableQuantity` را کم می‌کنند؛ این نبود باید در گزارش پذیرش `COM-006` **صریحاً افشا** شود، نه پنهان — اما طبق گام ۱۲ مانع پذیرش خودِ `COM-006` نیست |
| `routes.ts` نیازمند تصحیح `requiresIdempotencyKey` است (گام ۶)                                | تا آن تصحیح، تکرار یک Request شبکه‌ای می‌تواند دو `stock_movement` بسازد اگر کلاینت کلید هم‌سان نفرستد                                                                                         |
| ستون `GENERATED ALWAYS ... STORED` روی `available_quantity`                                   | برخی نگارش‌های ابزار Migration با ستون‌های Generated رفتار متفاوت دارند؛ نیازمند تست صریح `down.sql`                                                                                           |
| قاعدهٔ نمایش Q-44 (`Fulfillment` در برابر `Shipment`) پاسخ گرفت ولی UI‌اش نه                  | `marketplace-service` باید ستون اتصال، Consumer و صفحهٔ نمایش را جدا بسازد؛ تا آن زمان دو منبع مستقل‌اند و ادغام زودهنگام یک ادعای کاذب می‌سازد                                                |
| `procurement-service` وجود ندارد                                                              | `PurchaseOrderReceiptConsumer` برای این فاز فقط تعریف می‌شود، فعال نمی‌شود                                                                                                                     |
| انقضای رزرو (Cron در برابر مشتق در خواندن) در گام ۵ هنوز انتخاب نشده                          | انتخاب باید قبل از پذیرش گام ۵ مستند شود، نه به‌صورت پیش‌فرض ساکت                                                                                                                              |
| Dockerfile/CI Matrix (گام ۱) در این برنامه نساخته شده                                         | تا آن Commit اتمیک، `inventory-service` قابل استقرار در Container نیست؛ دروازهٔ `ci-image-matrix.mjs` این را خودکار اجرا می‌کند، نه یک یادآوری دستی                                            |
