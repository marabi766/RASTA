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
  روی هر جدول و Sequenceی که مهاجر بعداً بسازد.
- `migration` — هیچ حقی در اسکریپت؛ هر جدول حقش را از Migration خود سرویس می‌گیرد. فقط supplier: روی جدول‌های
  فقط‌افزودنی کمتر از DML می‌دهد.

**دفتر Migration** (`_prisma_migrations`) را خود اسکریپت تقسیم، **پیش از هر Migration**، با DDL دقیق Prisma می‌سازد:
مالکش مهاجر است و به هیچ نقشی (نه `PUBLIC`، نه نقش اجرا) حقی ندارد (بازبینی Codex روی #176). اگر Prisma آن را بسازد، از
Default Privileges حق DML نقش اجرا را به ارث می‌برد — در تمام مدت اجرای Migration، و برای همیشه اگر Migration شکست بخورد —
و نقشی که بتواند دفتر را بنویسد می‌تواند Migrationِ سازندهٔ یک نگهبان را «اجراشده» جا بزند. Prisma دفتری را که پیدا کند
به‌کار می‌گیرد. `scripts/prisma.mjs` پس از **هر** اجرا، موفق یا ناموفق، حق نقش اجرا را روی دفتر دوباره می‌گیرد (کمربند
و بند — مثلاً پس از `migrate reset` که دفتر را Prisma از نو می‌سازد).

**audit** متفاوت است (ADR-053 § 6): جدول‌ها در Schema `audit` و مالکشان `rasta_audit_migrator`؛ از D-045 خود پایگاه داده
هم مال مهاجر است و نقش اجرا فقط `CONNECT` و `USAGE` روی `audit` دارد.

## ۳. اعتبار مهاجر کجاست — هرگز در محیط سرویس

اعتبار مهاجر (`DATABASE_URL_<SVC>_MIGRATOR`، `POSTGRES_PASSWORD_<SVC>_MIGRATOR`) **در `.env` نیست**: در
`.env.migrator.example` است (کپی محلی: `.env.migrator`، git-ignored). `.env` را `start` و `dev` همهٔ سرویس‌ها بار
می‌کنند؛ `.env.migrator` را فقط ابزار Migration (`db:migrate`/`db:migrate:dev` → `scripts/prisma.mjs`)، کانتینر postgres
در Compose (`env_file`) و Suiteهای یکپارچگی (برای پاک‌سازی با اتصال مالک) می‌خوانند. هر سرویس در `main.ts`، پیش از بارکردن
هر چیز، `assertNoMigratorCredentials` (`@rasta/config`) را صدا می‌زند و اگر **هر** متغیر `*_MIGRATOR` در محیطش باشد بالا
نمی‌آید (فقط نام متغیر را می‌گوید، هرگز مقدار را؛ آزمون: `pnpm test:boot-guard` روی `dist/main.js` هر سرویس).
`scripts/prisma.mjs` برای سرویس تقسیم‌شده بی URL مهاجر رد می‌کند و به URL اجرا برنمی‌گردد. `pnpm infra:up` اگر `.env`ِ
قدیمی هنوز اعتبار مهاجر داشته باشد هشدار می‌دهد: آن‌ها را به `.env.migrator` ببر و از `.env` پاک کن.

## ۴. خوشهٔ تازه

`cp .env.migrator.example .env.migrator`، سپس هیچ کار دیگری. `00-init-databases.sh` (Compose و CI) برای هر سرویس در
`PRIVILEGE_SPLIT_SERVICES` تقسیم را انجام می‌دهد؛ سپس `pnpm db:migrate` با URL مهاجر اجرا می‌شود.

**گذرواژهٔ پیش‌فرض توسعه** (`rasta_<role>_dev_password`) منتشرشده است، پس فقط در Bootstrap یک‌بارمصرف پذیرفته می‌شود:
کانتینر postgres در Compose و سرویس CI، که صریحاً `RASTA_DB_BOOTSTRAP=compose` دارند. هر اجرای دیگر
(`service-privilege-split.bash` روی هر خوشه، `rotate-role-passwords.bash` بیرون از Compose، …) بی گذرواژهٔ صریح **رد
می‌کند**، پیش از نخستین دستور psql.

## ۵. ارتقای خوشهٔ موجود — ترتیب مهم است

برای یک سرویس `<svc>` که تازه به `PRIVILEGE_SPLIT_SERVICES` اضافه شده:

1. **گذرواژهٔ مهاجر** را در `.env.migrator` بگذار (نه `.env`): `POSTGRES_PASSWORD_<SVC>_MIGRATOR` (توسعه: مقدار
   `.env.migrator.example`؛ هر محیط واقعی: مقدار خودش، یکتا) و `DATABASE_URL_<SVC>_MIGRATOR` با همان. برای اجرای مستقیم
   روی هر خوشه، `POSTGRES_PASSWORD_<SVC>_MIGRATOR` باید **Export** شده باشد — بی آن اسکریپت رد می‌کند؛ فقط همین یک گذرواژه
   لازم است.
2. **تقسیم، به‌عنوان Superuser:**

   ```bash
   pnpm db:privilege-split <svc>        # محلی (docker compose exec)
   # یا روی هر خوشه:
   POSTGRES_USER=<superuser> POSTGRES_PASSWORD_<SVC>_MIGRATOR=<secret> \
     bash infrastructure/docker/postgres/lib/service-privilege-split.bash <svc>
   ```

   هیچ داده‌ای جابه‌جا نمی‌شود؛ مالکیت با `REASSIGN OWNED` منتقل می‌شود و دفتر Migration موجود حق نقش اجرا را از دست
   می‌دهد. Idempotent است. در حالت `default` نقش اجرا
   بلافاصله DML روی جدول‌های موجود دارد، پس سرویس قطع نمی‌شود. (supplier، حالت `migration`: تا گام ۳ حق جدول ندارد.)

3. **Migration با مهاجر:** `pnpm --filter @rasta/<svc>-service db:migrate` (اسکریپت `DATABASE_URL_<SVC>_MIGRATOR` را
   ترجیح می‌دهد و حق نقش اجرا روی `_prisma_migrations` را می‌گیرد).
4. **بررسی:** `pnpm check:db-runtime-privileges` (Superuser در `PG*`) — باید برای `<svc>` بگوید
   `runtime role owns nothing`.

audit (یک بار، برای خوشه‌ای که پیش از D-045 ساخته شده): `bash …/service-privilege-split.bash audit`.

## ۶. Production

Repository هیچ IaC پایگاه داده ندارد؛ DBA باید همین مدل را بسازد:

- هر سرویس **دو** اعتبار: مهاجر فقط برای Pipeline استقرار (`prisma migrate deploy`)، نقش اجرا فقط برای سرویس. اعتبار
  مهاجر هرگز در محیط اجرای سرویس نیست — و اگر باشد، سرویس بالا نمی‌آید (`assertNoMigratorCredentials`).
- مهاجر در Production `CREATEDB` لازم ندارد (`migrate deploy` Shadow Database نمی‌سازد)؛ آن را ندهید.
- همان دستورهای `service-privilege-split.bash` (با Superuser یا نقش ادمین مدیریت‌شده) یک بار، سپس Migrationها با مهاجر.
- `scripts/check-db-runtime-privileges.mjs` را پس از هر استقرار با یک نقش فقط‌خواندنیِ Catalogue اجرا کنید.

## ۷. افزودن سرویس به تقسیم (هر PR بعدی D-045)

1. سرویس را از `PENDING_SPLIT` (`scripts/check-db-runtime-privileges-lib.mjs`) به `PRIVILEGE_SPLIT_SERVICES` ببر.
2. `POSTGRES_PASSWORD_<SVC>_MIGRATOR` و `DATABASE_URL_<SVC>_MIGRATOR` در `.env.migrator.example` (**نه** `.env.example`؛
   Compose آن را با `env_file` به postgres می‌دهد)، و URL در **هر** `env:` CI که Migration آن سرویس یا Suite آن را اجرا
   می‌کند — هرگز در گامی که سرویس را بالا می‌آورد.
3. `connectAs: 'migrator'` در `scripts/verify-migration-reversible-lib.mjs` (نقش اجرا نه Schema می‌سازد نه Database).
4. هر پاک‌سازی آزمون که Trigger برمی‌دارد یا `TRUNCATE` می‌کند → اتصال مهاجر، **بی بازگشت** به URL اجرا.
5. آزمون زنده `test/runtime-privileges.int-spec.ts` (الگو: construction): نقش اجرا برای `DISABLE TRIGGER`، `ALTER`،
   `DROP` و `TRUNCATE` خطای `42501` می‌گیرد و حقش روی هر جدول دقیقاً DML است.

## ۸. اگر بررسی شکست خورد

`check:db-runtime-privileges` هر یافته را با نام می‌گوید، مثلاً `owns table public.tender` یا `TRIGGER on public.tender`.

- **سرویس تقسیم‌شده با یافته:** Migrationی جدولی را با نقش اجرا ساخته (URL مهاجر تنظیم نبوده) یا کسی دستی Grant داده
  است. گام‌های ۵٫۲ تا ۵٫۴ را دوباره اجرا کن؛ اسکریپت Idempotent است.
- **سرویس `PENDING_SPLIT` بی یافته:** تقسیم انجام شده ولی ثبت نشده — سرویس را به `PRIVILEGE_SPLIT_SERVICES` ببر.
