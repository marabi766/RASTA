# تمرین پشتیبان و بازیابی PostgreSQL — RUN-003

این تمرین برای محیط محلی یا یک میزبان آزمایشی هم‌شکل با staging است. به پایگاه داده
زنده وصل نمی‌شود. فهرست پایگاه‌ها از `RASTA_SERVICES` در
`infrastructure/docker/postgres/lib/role-passwords.bash` خوانده می‌شود؛ اکنون ۱۶ پایگاه
سرویس داریم. پیش از هر راه‌اندازی یا نوشتن داده، فهرست مستقل فایل‌های
`services/*-service/prisma/schema.prisma` با آن و کلیدهای `DATABASE_URL_<X>` در `.env.example` در هر دو جهت مقایسه می‌شود (کلیدهای `_MIGRATOR` کنار گذاشته می‌شوند)؛
فهرست خالی یا ناخوانا تمرین را رد می‌کند. فهرست واقعی `pg_database` نیز بررسی می‌شود؛ فقط `keycloak`، `temporal` و
`temporal_visibility` با دلیل مشخص خارج از دامنه هستند و هر پایگاه ناشناخته تمرین را رد می‌کند. فقط بخش PostgreSQL از Compose موجود اجرا می‌شود.

## اجرا

پیش‌نیاز: Linux، Bash، Node.js 22 یا بالاتر، pnpm طبق `packageManager` مخزن، Docker
و Compose با پشتیبانی `--wait`. تصویر PostgreSQL همان نسخه و digest در
`docker-compose.yml` است. دسترسی شبکه برای دریافت تصویر و وابستگی‌ها لازم است.

برای اجرای طولانی از `tmux` استفاده کنید. Docker به context پیش‌فرض و سوکت محلی
`unix:///var/run/docker.sock` محدود است. در یک worktree تمیز اجرا کنید. فایل‌های `.env` و `.env.migrator` محلی نباید در ریشه
یا مسیر سرویس‌ها وجود داشته باشند؛ تمرین با دیدن آن‌ها متوقف می‌شود. فقط مقدارهای
توسعه در فایل‌های `.example` خوانده می‌شوند. مسیر گزارش باید تازه و پوشه آن موجود باشد.

```bash
pnpm install --frozen-lockfile
scripts/backup-restore-drill --report /tmp/restore-drill-$(date -u +%Y%m%dT%H%M%SZ).json
```

وابستگی‌های seed به ترتیب ساخته می‌شوند. سپس برای هر سرویس migration موجود اجرا
می‌شود و اگر `db:seed` دارد همان مسیر seed اجرا می‌شود. گیت‌های seed شامل محیط
development، اجازه صریح و نشان disposable پایگاه همچنان فعال‌اند. سرویس برنامه،
Keycloak و Kafka اجرا نمی‌شوند.

seed اقتصادی عمدا کیف پول و موجودی نمی‌سازد
(`services/economic-service/prisma/seed.ts:30`). تمرین بعد از seed فقط در خوشه تازه خود
یک داده ساختگی مشخص می‌سازد: یک کیف پول، دو journal، چهار posting و یک hold فعال.
مبلغ ساختگی `9007199254740993` ریال از حد صحیح امن JavaScript بزرگ‌تر است؛ هیچ پرداخت،
نرخ یا تصمیم محصولی از آن ساخته نمی‌شود. این داده از API پرداخت عبور نمی‌کند.

برای هر پایگاه یک `pg_dump -Fc` مستقل در پوشه موقت خصوصی ذخیره می‌شود. منبع پس از
dump متوقف می‌شود و PostgreSQL تازه با volume جدا شروع می‌شود. نقش‌ها با bootstrap
موجود ساخته می‌شوند، پایگاه مقصد حذف می‌شود و `pg_restore --create --exit-on-error -d postgres`
خود پایگاه، مالکیت، ACL و تنظیم‌های آن را از آرشیو می‌سازد. `--create` با
`--single-transaction` سازگار نیست؛ هر خطای restore کل تمرین را رد می‌کند. خطای restore نادیده
گرفته نمی‌شود. در هر لحظه فقط یک سرور PostgreSQL با سقف حافظه ۵۱۲ MiB فعال است؛
فرایندهای ساخت و seed نیز یکی‌یکی اجرا می‌شوند.

### Reference restore — PM decision D-068

For every discovered database (currently all 16), collect a separate schema-only
SOURCE dump with the same pinned `pg_dump` and flags. Restore it into a fresh
scratch database, then dump that database to obtain REF. Do not modify SOURCE.
Compare the real archive's restored schema with REF using strict byte equality;
strip only the two generated version header lines at their exact header position.
No SQL, whitespace or expression normalization is allowed.

Between SOURCE and REF only, equal line counts and an identical multiset of CHECK
identities (database, schema, table, constraint name) are required. Every differing
line must be a whole `CONSTRAINT "name" CHECK (...)` line in actual CREATE TABLE
SQL context. Function bodies, comments and COMMENT strings never qualify. A
non-CHECK difference, dropped/extra object or renamed constraint refuses. Report
only the observed number of differing CHECK lines per database; do not hard-code
exceptions or print expressions. Rows/MD5 digests, migration records, sequences,
ACLs, ledger and wallet remain compared against SOURCE; REF contains schema only.

PostgreSQL CHECK deparse is not idempotent on the first round trip. For example,
`= ANY ((ARRAY['USER'::character varying, ...])::"text"[])` can return as
`= ANY (ARRAY[('USER'::character varying)::"text", ...])`.

REF equality proves the backup under test restores to exactly what PostgreSQL itself produces from the source schema. The SOURCE-vs-REF allowance TRUSTS PostgreSQL's own schema dump/restore for CHECK text: it does not prove semantic equivalence of those lines (a same-name CHECK with a different bound would also pass that structural guard — e.g. economic init migration :648-649). The fixed point proves stability for one more round trip only.

Restore REF into a second fresh scratch database and dump it: these bytes must
also equal REF. Missing REF, missing fixed-point evidence, a skipped allowance
guard, or any failed reference restore/dump refuses operator acceptance. The drill
creates both databases with its random suffix inside its existing single active
PostgreSQL server (512 MiB, one CPU). It drops them after collection, and removes
the owned cluster/volume on success, failure and signals. Ownership comes from
names created by this invocation, never from a restored disposable marker.
All new SQL files are private 0600 inside the 0700 directory. Plain-SQL restore
stdout/stderr are captured and never printed, including on failure. Writers,
services, consumers and publishers stay stopped throughout SOURCE, REF and archive
collection; restored outboxes never publish.

Version 5 JSON includes mandatory `referenceChecked`, `allowanceChecked` and
`fixedPointEqual` gates plus per-database `before.reference.checkLinesDifferent`
and `before.reference.milliseconds` (extra reference collection/restore/dump and
fixed-point time). The PG suite prints that extra time separately in local and CI
logs. CI budgets remain **10 minutes per job / 5 minutes for the PG test step**;
main integration job/step budgets are unchanged. Runtime tenant isolation is not
proved. This drill does not prove PITR, WAL archiving, operational RPO/RTO,
large-data recovery time, direct equality of every column value (rows use MD5
rather than collision-free proof), production-role recovery (bootstrap supplies
development roles), runtime role access or runtime tenant isolation, API or real
payment flows, Keycloak/Temporal storage, object-storage file contents, backup
encryption/off-host transfer and retention, Kafka offsets, distributed snapshot
consistency with active writers, or full-system recovery.

## گزارش و معیار قبولی

گزارش JSON با مجوز `0600` و نسخه قالب `5` نوشته می‌شود. `passed: true` و کد خروج
صفر فقط وقتی رخ می‌دهد که همه مقایسه‌ها و پاکسازی موفق باشند. `databases` برای هر
پایگاه `before`، `after`، `tablesEqual`، `migrationsEqual`، `databaseStateEqual`، `objectStateEqual` و `schemaDumpEqual` دارد. تعداد سطرها و مبالغ
به صورت رشته دهدهی هستند؛ تبدیل به Number انجام نمی‌شود.

- فهرست همه جدول‌های غیرسیستمی در همه schemaها و تعداد دقیق سطرها برابر است؛
  جدول خالی، جدول‌های افزونه و schema حسابرسی نیز در مقایسه هستند. برای هر جدول digest از
  متن JSON همه سطرها با ترتیب ثابت محاسبه و مقایسه می‌شود (MD5، نه اثبات بدون احتمال برخورد).
- برای هر پایگاه، خروجی `pg_dump --schema-only --format=plain --encoding=UTF8 --quote-all-identifiers`
  با همان باینری در تصویر ثابت، بدون trim و به صورت بایت به بایت با REF برابر است (قاعده D-068 پایین).
  در نسخه دارای `--restrict-key`، کلید ثابت `RastaRestoreDrill` داده می‌شود.
  فقط دو خط تولیدشده `-- Dumped from database version ...` و `-- Dumped by pg_dump version ...`
  در جای دقیق ابتدای header حذف می‌شوند؛ هیچ خط دیگر، فاصله، `COMMENT ON` یا بدنه تابع حذف نمی‌شود.
  header و نشان پایان باید کامل باشند؛ خروجی گمشده، خالی، بریده یا فرمان ناموفق رد می‌شود.
  برابری شامل اشیایی است که dump منطقی schema صادر می‌کند: مالکیت، مجوزهای schema، تابع، type و ستون،
  `SECURITY DEFINER`، trigger و وضعیت فعال بودن، RLS policy، constraint و index.
  اشیای داخلی افزونه‌ها را خود افزونه می‌سازد؛ dump منطقی همه کاتالوگ‌های داخلی سرور یا نقش‌های خوشه نیست.
  ACL پایگاه جداگانه با `acldefault` نرمال و مقایسه می‌شود.
  گزارش فقط نسخه باینری، تعداد بایت، SHA-256 و زمان جمع‌آوری `milliseconds` را نگه می‌دارد؛
  تصمیم برابری از خود بایت‌هاست. اختلاف فقط نام پایگاه، شناسه شی و خلاصه تعداد بایت و محل اختلاف را چاپ می‌کند.
  dump کامل فقط در فایل محلی خصوصی `0600` در پوشه موقت `0700` است؛ در log یا artifact عمومی CI نیست.
- مالک schemaها (`nspowner`) و اشیا (`relowner`)، ACL جدول‌ها و sequenceها
  (`relacl`) و مجوزهای پیش‌فرض (`pg_default_acl`) با نام نقش و ترتیب ثابت برابرند.
  ACL ضمنی `NULL` با `acldefault` به مجوزهای واقعی پیش‌فرض تبدیل می‌شود؛
  مجوز صریح معادل آن اختلاف بازیابی نیست. مقدار `last_value` به صورت متن و `is_called` برای همه sequenceها برابرند.
- مالک پایگاه، ACL و همه تنظیم‌های `pg_db_role_setting` همان پایگاه در منبع و مقصد برابرند.
- `summary` برای هر پایگاه، جدول‌ها، جدول‌های غیرخالی و سطرهای application، migration و
  extension را جدا نشان می‌دهد. عضویت افزونه از `pg_depend` خوانده می‌شود؛ سطرهای
  `spatial_ref_sys` داده کاربردی بازیابی‌شده نیستند.
- همه میدان‌های `_prisma_migrations`، از جمله نام، checksum، زمان‌ها و وضعیت، برابرند؛
  ledger خالی یا migration ناتمام یا برگشت‌خورده رد می‌شود.
- نتیجه دفتر کل منبع و مقصد، جمع مبلغ به تفکیک ارز و مقدار ساختگی
  `9007199254740993` به صورت متن برابرند.
- در منبع و مقصد، برای هر journal و هر ارز مجموع بدهکار و بستانکار برابر است.
- موجودی available کیف پول از postingهای حساب WALLET و pending از حساب ESCROW
  بازحساب می‌شود؛ ledger برابر مجموع این دو و pending برابر holdهای ACTIVE است.
  نبود داده مالی به عنوان موفقیت پذیرفته نمی‌شود.
- همه containerها، volumeها و networkهای پروژه یکتای تمرین حذف شده‌اند.

مرجع فرمول‌های موجود، بدون import کد سرویس:
`services/economic-service/src/wallet/wallet.repository.ts:115` تا ۱۳۹،
`services/economic-service/src/wallet/balance-audit.ts:235` تا ۲۷۳ و
`services/economic-service/prisma/migrations/20260828202043_init_economic/migration.sql:596` تا ۶۲۷.
پرس‌وجوهای خواندنی در `scripts/backup-restore-drill-lib.mjs` همان رابطه‌ها را با
`numeric SUM` پیاده می‌کنند تا جمع مبلغ‌ها سرریز نکند. بررسی سراسری فقط روی داده
ساختگی و seed در خوشه متعلق به تمرین انجام می‌شود؛ مسیر خواندن داده مستاجر زنده نیست.

در خطا، `error.stage` مرحله شکست را نشان می‌دهد؛ خروجی خطای فرمان با حذف URL پایگاه
ثبت می‌شود؛ آخرین ۴ کیلوبایت هر جریان خروجی ممکن است داده ساختگی seed داشته باشد. `cleanup.passed: false` همراه نام پروژه و مسیر موقت یعنی پاکسازی کامل
نشده و باید همان منابع بررسی شوند. SIGHUP، SIGINT و SIGTERM فرایند در حال اجرا را متوقف و
پاکسازی را شروع می‌کنند؛ سیگنال‌های بعدی ثبت می‌شوند و فرمان پاکسازی را نمی‌کشند.
خطای نوشتن stderr پس از قطع پایپ مانع پاکسازی نمی‌شود. برای هر فرمان سقف زمان داریم. SIGKILL، قطع برق یا از دست
رفتن Docker daemon می‌تواند منابع را باقی بگذارد. فقط با نام پروژه ثبت‌شده در گزارش
و فایل Compose همان پوشه موقت پاکسازی کنید؛ هرگز stack مشترک را reset نکنید.

فایل‌های dump موقت، شامل schema و بدنه تابع، پس از موفقیت پاکسازی حذف می‌شوند؛ گزارش JSON باقی می‌ماند.
این فرمان سرویس‌های دیگر یا containerهای موجود را متوقف نمی‌کند. فایل گزارش را
بدون بررسی در مخزن commit نکنید؛ گزارش نام جدول و فراداده migration دارد.

## دامنه اثبات و محدودیت‌ها

این تمرین ثابت می‌کند ابزارهای همین نسخه می‌توانند snapshot منطقی داده seed و
داده مالی ساختگی را در یک خوشه تازه بازیابی کنند، تعداد سطرها و ledger مهاجرت را
نگه دارند و رابطه‌های مالی بالا را پس از بازیابی برقرار ببینند.

این تمرین PITR، WAL archiving، RPO/RTO عملیاتی، زمان بازیابی داده حجیم،
مقایسه مستقیم همه مقدارهای ستون‌ها (فقط digest و مبلغ‌های مشخص مقایسه می‌شوند)،
بازیابی نقش‌ها از backup، دسترسی سرویس با نقش runtime،
اجرای API یا جریان واقعی پرداخت را اثبات نمی‌کند. برابری مالکیت schema و اشیا، مجوزهای
جدول و sequence، مجوزهای پیش‌فرض، خروجی کامل schema-only و هر دو میدان وضعیت sequence به صورت مستقیم گیت می‌شود.
خوشه مقصد نقش‌های توسعه را از bootstrap می‌گیرد؛ این backup نقش‌های production نیست.
برابری با دسترسی superuser اثبات جداسازی مستاجران با نقش runtime نیست.

پایگاه‌های زیرساختی Keycloak و Temporal، object storage و محتوای فایل‌ها، رمزنگاری
backup، انتقال و نگهداری خارج از میزبان، Kafka و offsetها، سازگاری snapshot میان
سرویس‌های در حال نوشتن و بازیابی سامانه کامل در دامنه این تمرین نیستند. منبع هیچ
نویسنده فعال ندارد؛ dumpهای جدا تضمین snapshot توزیع‌شده production نیستند.

برای خودکارسازی ماهانه باید مالک زیرساخت یک job زمان‌بندی‌شده جدا با نگهداری گزارش
تصویب کند. تست‌های مقایسه و SQL منفی در CI اجرا می‌شوند؛ job مستقل
`integration-backup-drill` با سقف ۱۰ دقیقه عضو گیت `Integration and security tests` است؛ اجرای کامل تمرین
زمان‌بندی نشده است. سقف گام آزمون PostgreSQL پنج دقیقه است و افزایش نیافته؛ زمان این job در CI و زمان کامل فرمان ۱۶ پایگاه باید جدا گزارش شوند. جمع `before.schemaDump.milliseconds` و `after.schemaDump.milliseconds` هزینه جمع‌آوری schema را نشان می‌دهد.

## آزمون منطق مقایسه

```bash
pnpm test:backup-restore-drill-lib
# PGHOST/PGPORT/PGUSER/PGPASSWORD: فقط خوشه یک‌بارمصرف
pnpm test:backup-restore-drill-pg
```

آزمون‌ها اختلاف یک سطر بالاتر از حد امن Number، جدول کم یا زیاد، تغییر هر میدان
migration، مدرک ناقص، اختلاف مالی و موفقیت تهی را رد می‌کنند. برای mutant، نتیجه
`tablesEqual` را موقتا `true` کنید؛ آزمون اختلاف سطر و آزمون جدول کم یا زیاد باید
شکست بخورند. سپس فایل را دقیقا به حالت اصلی برگردانید و آزمون‌ها را دوباره اجرا کنید.

داده نمایشی کوچک است: اجرای نخست ۲۶۲ سطر کاربردی در ۳۷ جدول غیرخالی، ۱۸۵ سطر
migration و ۱۳۶۰۰۰ سطر افزونه در ۱۶ پایگاه داشت. تعداد کل جدول‌ها ۲۵۸ بود؛
این حجم آزمون کارایی یا بازیابی داده حجیم نیست. اجرای تازه در گزارش JSON جدا ثبت می‌شود.
