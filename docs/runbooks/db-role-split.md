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

**نقشی که واقعاً وصل شده.** `DATABASE_URL`ی که خودش مهاجر را نام ببرد هیچ متغیر `*_MIGRATOR`ی ندارد. پس هر سرویس تقسیم‌شده
(و audit) نخستین کارِ `AppModule.onModuleInit` را `PrismaService.assertRuntimeRole()` می‌کند — بررسی مشترک
`@rasta/nest-common` (`runtime-role.ts`) که از Catalogue می‌پرسد و بالا نمی‌آید اگر نقش وصل‌شده (مستقیم یا با عضویت)
Superuser باشد، نامش (`current_user` یا `session_user`) به `_migrator` ختم شود، مالک پایگاه داده، Schemaی غیرسیستمی یا
هر Relationی باشد، روی پایگاه داده یا Schemaی `CREATE` داشته باشد، یا `CREATEDB`/`CREATEROLE`/`BYPASSRLS` داشته باشد.
آزمون زنده: `test/startup-role.int-spec.ts` هر سرویس (URL مهاجر در جای `DATABASE_URL` → رد).

**پیش از Nest.** Nest هوک `onModuleInit` هر Provider را پیش از `AppModule` اجرا می‌کند و Consumer یا Timer در هوک خودش
شروع می‌شود؛ پس بررسی در `AppModule` به‌تنهایی دیر است — Consumer می‌توانست با اتصال مالک به گروهش بپیوندد و کار Commit
کند (Codex روی #178). از این رو `main.ts` هر سرویس تقسیم‌شده نخستین کارِ `bootstrap()` را، پیش از `NestFactory.create`،
`preflightRuntimeRole` (`@rasta/nest-common`) می‌کند: اتصالی کوتاه‌عمر با URL اجرای سرویس، همان بررسی‌ها، و در رد شدن خروج
با کد ناصفر. بررسی `AppModule` هم می‌ماند. آزمون زنده در کار E2E CI: `scripts/runtime-preflight.e2e.mjs` — audit با URL
مهاجر و رویدادی در صف: فرایند می‌میرد، رویداد مصرف و Commit نمی‌شود و گروه هرگز شکل نمی‌گیرد؛ identity با URL مهاجر: Consumer
بازتاب Keycloak (که در هوک خودش شروع می‌شود) هرگز به گروهش نمی‌پیوندد؛ در کار مرورگر، asset و maintenance (Consumerهای timeline و usage، هر دو در هوک خودشان) با URL مهاجر و `USAGE_RECORDED`ی در صف؛ و کنترل مثبت پس از راه‌اندازی درست.

**هر راه ورود دیگر هم.** CLI، Worker یا Seedی که خودش PrismaClient، PrismaService یا Context Nest از `AppModule` می‌سازد از
هر دو دروازه می‌گذرد، پس خودش `preflightRuntimeRole` را نخستین `await` تابع ورودش می‌کند (Codex روی #177): CLIهای
`keycloak:backfill`/`keycloak:reconcile` در identity (آزمون زنده: `test/projection-cli.int-spec.ts` — با URL مهاجر خروج 2
بی هیچ درخواستی به Keycloak) و Seedهای نمایشی، که فقط DML لازم دارند و بیرون از development/test هم رد می‌شوند.
`scripts/service-boot-guard.test.mjs` چنین فایل‌هایی را می‌یابد و دروازه را از هر کدام می‌خواهد.

**عضویت هم مالکیت است.** نقش اجرایی که عضو مهاجر باشد — حتی `WITH INHERIT FALSE`، که چیزی به ارث نمی‌برد — با
`SET ROLE` مهاجر می‌شود و هر نگهبان را برمی‌دارد. پس هر دو بررسی (`assertRuntimeRole` و `check:db-runtime-privileges`)
مالکیت را با `pg_has_role … 'MEMBER'` می‌سنجند و هر عضویتی در نقشی که اینجا مالک چیزی است، نامش `*_migrator` است یا
`SUPERUSER`/`CREATEDB`/`CREATEROLE`/`BYPASSRLS` دارد را رد می‌کنند؛ و اسکریپت تقسیم هر عضویت مستقیم نقش اجرا در چنین
نقشی (یا در نقشی که به آن می‌رسد) را، هر که داده باشد، `REVOKE … GRANTED BY … CASCADE` می‌کند.

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
   روی هر خوشه، `POSTGRES_PASSWORD_<SVC>` (نقش اجرا) و `POSTGRES_PASSWORD_<SVC>_MIGRATOR` هر دو باید **Export** شده باشند —
   بی آن‌ها اسکریپت رد می‌کند — و اگر گذرواژهٔ مهاجر با گذرواژهٔ نقش اجرا، یا با هر گذرواژهٔ نقش دیگری که در محیط هست،
   یکی باشد هم رد می‌کند (آن اعتبار اجرا می‌توانست با نام مهاجر وارد شود). گذرواژهٔ Export‌شدهٔ نقش اجرا ممکن است کهنه باشد،
   پس اجرای مستقل همان را **روی نقش اجرا می‌گذارد** (گذرواژهٔ قبلی دیگر کار نمی‌کند) و سپس با هر دو اعتبار از راه TCP وارد
   می‌شود؛ اگر یکی وارد نشود اجرا شکست می‌خورد. پس از گام ۲، `DATABASE_URL_<SVC>` سرویس باید همین گذرواژهٔ تازه را داشته
   باشد.
2. **تقسیم، به‌عنوان Superuser:**

   ```bash
   pnpm db:privilege-split <svc>        # محلی (docker compose exec)
   # یا روی هر خوشه:
   POSTGRES_USER=<superuser> POSTGRES_PASSWORD_<SVC>=<runtime-secret> \
     POSTGRES_PASSWORD_<SVC>_MIGRATOR=<owner-secret> \
     bash infrastructure/docker/postgres/lib/service-privilege-split.bash <svc>
   ```

   هیچ داده‌ای جابه‌جا نمی‌شود؛ مالکیت با `REASSIGN OWNED` منتقل می‌شود و دفتر Migration موجود حق نقش اجرا را از دست
   می‌دهد. Idempotent است. در حالت `default` نقش اجرا
   بلافاصله DML روی جدول‌های موجود دارد، پس سرویس قطع نمی‌شود. (supplier، حالت `migration`: تا گام ۳ حق جدول ندارد.)

3. **Migration با مهاجر:** `pnpm --filter @rasta/<svc>-service db:migrate` (اسکریپت `DATABASE_URL_<SVC>_MIGRATOR` را
   ترجیح می‌دهد و حق نقش اجرا روی `_prisma_migrations` را می‌گیرد).
4. **بررسی:** `pnpm check:db-runtime-privileges` (Superuser در `PG*`) — باید برای `<svc>` بگوید
   `runtime role owns nothing`.

audit (یک بار، برای خوشه‌ای که پیش از D-045 ساخته شده): `bash …/service-privilege-split.bash audit` — با همان گام اعتبار
هر سرویس: `POSTGRES_PASSWORD_AUDIT` و `POSTGRES_PASSWORD_AUDIT_MIGRATOR` هر دو Export‌شده و متمایز؛ هر دو روی نقش‌ها گذاشته
و ورودشان ثابت می‌شود، پس خوشه‌ای که دو نقش audit یک گذرواژه داشتند با آن نمی‌ماند.

Schema `public` هر که مالکش باشد — نقش اجرا، `pg_database_owner`، یا Superuser روی خوشه‌ای که از PostgreSQL 14 ارتقا یافته
(که `REASSIGN OWNED` به آن نمی‌رسد) — پیش از Revokeها و ساخت دفتر به مهاجر داده می‌شود؛ وگرنه مهاجر در آن `CREATE`
نداشت و نه دفتر ساخته می‌شد نه Migration. `pnpm db:rotate-role-passwords` هر `rasta_<svc>_migrator` را با پایگاه دادهٔ
`rasta_<svc>` می‌آزماید.

## ۶. Production

Repository هیچ IaC پایگاه داده ندارد؛ DBA باید همین مدل را بسازد:

- هر سرویس **دو** اعتبار: مهاجر فقط برای Pipeline استقرار (`prisma migrate deploy`)، نقش اجرا فقط برای سرویس. اعتبار
  مهاجر هرگز در محیط اجرای سرویس نیست — و اگر باشد، یا `DATABASE_URL` سرویس به مهاجر یا هر مالکی اشاره کند، سرویس بالا
  نمی‌آید (`assertNoMigratorCredentials`، `assertRuntimeRole`).
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
