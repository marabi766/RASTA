# Runbook — جداسازی نقش اجرا از نقش مالک در پایگاه داده (D-045)

> **مالک:** Platform · **مرتبط:** `docs/23` D-045، RUN-002، ADR-005، ADR-053 § 6 ·
> **پیاده‌سازی:** `infrastructure/docker/postgres/lib/service-privilege-split.bash`،
> `scripts/check-db-runtime-privileges.mjs`

## ۱. چرا

Trigger، CHECK و Privilege لغوشده فقط در برابر نقشی سد است که نتواند آن را بردارد. **مالک جدول** می‌تواند:
`ALTER TABLE … DISABLE TRIGGER`، `DROP CONSTRAINT`، `DROP TABLE`، یا دادن دوبارهٔ حق به خودش؛ **مالک پایگاه داده** حتی
`DROP DATABASE`. تا پیش از D-045 هر سرویس با همان نقشی وصل می‌شد که مالک جدول‌هایش بود، پس هر SQLی که از نقش اجرا بگذرد
(تزریق، یا مسیر نوشتنی در آینده) می‌توانست نگهبان‌های تمامیت را خاموش کند: انجماد معیارهای مناقصه و نگهبان کلید آن در
construction، تغییرناپذیری دفتر کل در economic، فقط‌افزودنی audit و …

## ۲. مدل نقش‌ها

برای هر سرویس `<svc>` در `PRIVILEGE_SPLIT_SERVICES` (`lib/role-passwords.bash`):

| نقش                    | کیست                                    | چه دارد                                                                                                                                                                      |
| ---------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rasta_<svc>_migrator` | مالک؛ فقط Migration و پاک‌سازی آزمون‌ها | مالک پایگاه داده `rasta_<svc>`، Schema `public` و **همهٔ** جدول‌ها، Sequenceها، توابع و `_prisma_migrations`. `CREATEDB` فقط برای Shadow Database محلی `prisma migrate dev`. |
| `rasta_<svc>`          | نقش اجرا؛ سرویس با این وصل می‌شود       | `CONNECT` روی پایگاه داده، `USAGE` روی `public`، و `SELECT, INSERT, UPDATE, DELETE` روی جدول‌ها و `USAGE, SELECT` روی Sequenceها — نه بیشتر.                                 |

نقش اجرا **ندارد**: مالکیت هیچ چیز؛ `CREATE` روی پایگاه داده یا Schema (پس نمی‌تواند چیزی بسازد که مالکش شود)؛
`TRUNCATE`، `REFERENCES`، `TRIGGER`؛ هیچ حقی روی `_prisma_migrations`؛ `CREATEDB`، `CREATEROLE`، `BYPASSRLS`، `SUPERUSER`.
`EXECUTE` روی توابع مهاجر از `PUBLIC` گرفته شده (Triggerها همچنان اجرا می‌شوند: حق EXECUTE هنگام **ساختن** Trigger بررسی
می‌شود، نه هنگام اجرا). دو نقش عضو یکدیگر نیستند — عضویت همان قدرت‌ها را پس می‌دهد.

**حق جدول‌ها، دو حالت** (`privilege_split_grants_mode`):

- `default` — DML روی همهٔ جدول‌های فعلی، و با `ALTER DEFAULT PRIVILEGES FOR ROLE rasta_<svc>_migrator IN SCHEMA public`
  روی هر جدول و Sequenceی که مهاجر بعداً بسازد. `scripts/prisma.mjs` پس از هر Migration موفق، حق نقش اجرا را روی
  `_prisma_migrations` دوباره می‌گیرد (در پایگاه دادهٔ تازه، دفتر Migration پس از Bootstrap ساخته می‌شود و Default
  Privileges را به ارث می‌برد؛ نقشی که بتواند دفتر را بنویسد می‌تواند Migrationِ سازندهٔ یک نگهبان را «اجراشده» جا بزند).
- `migration` — هیچ حقی در اسکریپت؛ هر جدول حقش را از Migration خود سرویس می‌گیرد. فقط supplier: روی جدول‌های
  فقط‌افزودنی کمتر از DML می‌دهد.

**audit** متفاوت است (ADR-053 § 6): جدول‌ها در Schema `audit` و مالکشان `rasta_audit_migrator`؛ از D-045 خود پایگاه داده
هم مال مهاجر است و نقش اجرا فقط `CONNECT` و `USAGE` روی `audit` دارد.

## ۳. خوشهٔ تازه

هیچ کاری لازم نیست. `00-init-databases.sh` (Compose و CI) برای هر سرویس در `PRIVILEGE_SPLIT_SERVICES` تقسیم را انجام
می‌دهد؛ سپس `pnpm db:migrate` با `DATABASE_URL_<SVC>_MIGRATOR` اجرا می‌شود (`.env.example` هر دو URL را دارد).

## ۴. ارتقای خوشهٔ موجود — ترتیب مهم است

برای یک سرویس `<svc>` که تازه به `PRIVILEGE_SPLIT_SERVICES` اضافه شده:

1. **گذرواژهٔ مهاجر** را در `.env` بگذار: `POSTGRES_PASSWORD_<SVC>_MIGRATOR` (توسعه: مقدار `.env.example`؛ هر محیط
   واقعی: مقدار خودش، یکتا — `resolve_role_passwords` تکرار را رد می‌کند) و `DATABASE_URL_<SVC>_MIGRATOR` با همان.
2. **تقسیم، به‌عنوان Superuser:**

   ```bash
   pnpm db:privilege-split <svc>        # محلی (docker compose exec)
   # یا روی هر خوشه:
   POSTGRES_USER=<superuser> bash infrastructure/docker/postgres/lib/service-privilege-split.bash <svc>
   ```

   هیچ داده‌ای جابه‌جا نمی‌شود؛ مالکیت با `REASSIGN OWNED` منتقل می‌شود. Idempotent است. در حالت `default` نقش اجرا
   بلافاصله DML روی جدول‌های موجود دارد، پس سرویس قطع نمی‌شود. (supplier، حالت `migration`: تا گام ۳ حق جدول ندارد.)

3. **Migration با مهاجر:** `pnpm --filter @rasta/<svc>-service db:migrate` (اسکریپت `DATABASE_URL_<SVC>_MIGRATOR` را
   ترجیح می‌دهد و حق نقش اجرا روی `_prisma_migrations` را می‌گیرد).
4. **بررسی:** `pnpm check:db-runtime-privileges` (Superuser در `PG*`) — باید برای `<svc>` بگوید
   `runtime role owns nothing`.

audit (یک بار، برای خوشه‌ای که پیش از D-045 ساخته شده): `bash …/service-privilege-split.bash audit`.

## ۵. Production

Repository هیچ IaC پایگاه داده ندارد؛ DBA باید همین مدل را بسازد:

- هر سرویس **دو** اعتبار: مهاجر فقط برای Pipeline استقرار (`prisma migrate deploy`)، نقش اجرا فقط برای سرویس. اعتبار
  مهاجر هرگز در محیط اجرای سرویس نیست.
- مهاجر در Production `CREATEDB` لازم ندارد (`migrate deploy` Shadow Database نمی‌سازد)؛ آن را ندهید.
- همان دستورهای `service-privilege-split.bash` (با Superuser یا نقش ادمین مدیریت‌شده) یک بار، سپس Migrationها با مهاجر.
- `scripts/check-db-runtime-privileges.mjs` را پس از هر استقرار با یک نقش فقط‌خواندنیِ Catalogue اجرا کنید.

## ۶. افزودن سرویس تازه

از پایان D-045 هر سرویس تقسیم‌شده است و `check:db-runtime-privileges` سرویسی را که در `RASTA_SERVICES` هست ولی در
`PRIVILEGE_SPLIT_SERVICES` نیست رد می‌کند؛ پس سرویس تازه از نخستین Migration تقسیم‌شده به دنیا می‌آید:

1. سرویس را به `PRIVILEGE_SPLIT_SERVICES` (`lib/role-passwords.bash`) اضافه کن.
2. `POSTGRES_PASSWORD_<SVC>_MIGRATOR` در `.env.example` و `docker-compose.yml`؛ `DATABASE_URL_<SVC>_MIGRATOR` در
   `.env.example` و در **هر** `env:` CI که Migration آن سرویس را اجرا می‌کند.
3. `connectAs: 'migrator'` در `scripts/verify-migration-reversible-lib.mjs` (نقش اجرا نه Schema می‌سازد نه Database).
4. هر پاک‌سازی آزمون که Trigger برمی‌دارد یا `TRUNCATE` می‌کند → اتصال مهاجر، **بی بازگشت** به URL اجرا.
5. آزمون زنده `test/runtime-privileges.int-spec.ts` (الگو: construction): نقش اجرا برای `DISABLE TRIGGER`، `ALTER`،
   `DROP` و `TRUNCATE` خطای `42501` می‌گیرد و حقش روی هر جدول دقیقاً DML است.

## ۷. اگر بررسی شکست خورد

`check:db-runtime-privileges` هر یافته را با نام می‌گوید، مثلاً `owns table public.tender` یا `TRIGGER on public.tender`.

- **سرویس تقسیم‌شده با یافته:** Migrationی جدولی را با نقش اجرا ساخته (URL مهاجر تنظیم نبوده) یا کسی دستی Grant داده
  است. گام‌های ۴٫۲ تا ۴٫۴ را دوباره اجرا کن؛ اسکریپت Idempotent است.
- **«in RASTA_SERVICES but not in PRIVILEGE_SPLIT_SERVICES»:** سرویس تازه‌ای بی تقسیم اضافه شده — گام‌های § ۶.
