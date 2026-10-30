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
the observed number of differing CHECK lines and their constraint names (with schema
and table) per database in `checkConstraints`; do not hard-code exceptions or print expressions. Rows/MD5 digests, migration records, sequences,
ACLs, ledger and wallet remain compared against SOURCE; REF contains schema only.

PostgreSQL CHECK deparse is not idempotent on the first round trip. For example,
`= ANY ((ARRAY['USER'::character varying, ...])::"text"[])` can return as
`= ANY (ARRAY[('USER'::character varying)::"text", ...])`.

REF equality proves the backup under test restores to exactly what PostgreSQL itself produces from the source schema. The SOURCE-vs-REF allowance TRUSTS PostgreSQL's own schema dump/restore for CHECK text: it does not prove semantic equivalence of those lines (a same-name CHECK with a different bound would also pass that structural guard — e.g. economic init migration :648-649). The fixed point proves stability for one more round trip only.

Restore REF into a second fresh scratch database and dump it: these bytes must
also equal REF. Private WeakMap provenance, issued only by schema dump collection,
requires four distinct dumps: SOURCE from the service database with label `source`,
the separate SOURCE dump that gets restored (`reference-input`, same database, same
`pg_dump` version, bytes equal to SOURCE), REF from `drill_ref_<suffix>` with label
`reference`, and the fixed point from `drill_fixed_<suffix>` with label `fixed-point`.
Both scratch names must share the same invocation suffix.

The restore INPUTS are bound as well as the dump outputs. `restore` receives the input
evidence object (never a caller-chosen path: the private file is looked up through the
provenance), and the dump that follows records `restoredFrom: <input dumpId>`, taken from
the evidence actually restored. REF must name the reference-input dump, the fixed point
must name REF, and a dump callback that drops or changes the lineage refuses. Restoring
SOURCE a second time instead of REF therefore cannot produce a pass, even though PostgreSQL's
deparse is deterministic and the bytes would match. On the restored side, `compareSnapshots`
requires the post-restore dump to carry the `restored` label for the same database, and
SOURCE must be the very dump REF was built from (object identity, not equal bytes), so
`compareSnapshots(before, before)` refuses.

Limit: the database name in a provenance record is the caller's claim. It is tied to
`pg_dump -d` only by construction: `scripts/backup-restore-drill.mjs` passes one variable to
both. A dump claimed for another database or label refuses even if its bytes match; a dump
whose claim lies about its own `-d` argument cannot be detected by this library.
The same holds for the archive file given to `pg_restore` (`<temporary>/<service>.dump`) and for
the SOURCE/restored ledger objects: they are named by construction in the CLI, not by evidence;
the library refuses only the same ledger object on both sides.
Missing REF, missing fixed-point evidence, a skipped allowance
guard, or any failed reference restore/dump refuses operator acceptance. The drill
creates both databases with its random suffix inside its existing single active
PostgreSQL server (512 MiB, one CPU). It drops them after collection, and removes
the owned cluster/volume on success, failure and signals. Ownership comes from
names created by this invocation, never from a restored disposable marker.
All new SQL files are private 0600 inside the 0700 directory. Plain-SQL restore
stdout/stderr are captured and never printed, including on failure. The same rule
covers archive restore, dump and migration children: private failures report only
`{stage, database, exitCode}`, without SQL or subprocess diagnostics. Writers,
services, consumers and publishers stay stopped throughout SOURCE, REF and archive
collection; restored outboxes never publish.

Version 5 JSON includes mandatory `referenceChecked`, `allowanceChecked` and
`fixedPointEqual` gates plus per-database `before.reference.checkLinesDifferent`
and `before.reference.checkConstraints` (schema, table and constraint name; no SQL)
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

در خطا، `error.stage` مرحله شکست را نشان می‌دهد؛ برای فرمان خصوصی فقط مرحله، نام پایگاه و کد خروج ثبت می‌شود. خروجی خطای دیگر فرمان‌ها با حذف URL پایگاه
ثبت می‌شود؛ آخرین ۴ کیلوبایت هر جریان خروجی ممکن است داده ساختگی seed داشته باشد. `cleanup.passed: false` همراه نام پروژه و مسیر موقت یعنی پاکسازی کامل
نشده و باید همان منابع بررسی شوند. SIGHUP، SIGINT و SIGTERM فرایند در حال اجرا را متوقف و
پاکسازی را شروع می‌کنند؛ سیگنال‌های بعدی ثبت می‌شوند و فرمان پاکسازی را نمی‌کشند.
خطای نوشتن stderr پس از قطع پایپ مانع پاکسازی نمی‌شود. برای هر فرمان سقف زمان داریم. SIGKILL، قطع برق یا از دست
رفتن Docker daemon می‌تواند منابع را باقی بگذارد. بلافاصله پس از ساخت نام پروژه، گزارش اولیه با
`project` و `temporary` و `recoveryId` و `passed: false` نوشته می‌شود (نشانگر `recovery.json` پیش از آن در
پوشه موقت نوشته شده است) و `project` و `temporary` همیشه نخستین کلیدهای گزارش‌اند؛
نبود `finishedAt` یعنی اجرا کامل نشده است. هر گزارش ناتمام `passed: false` دارد.

هر نوشتن گزارش اتمی است: فایل خواهر تصادفی (`<report>.<hex>.tmp`) با ساخت انحصاری و مجوز `0600`
(بدون دنبال‌کردن symlink) نوشته، fsync و روی گزارش rename می‌شود. پس قطع در هر لحظه گزارش
اولیه یا گزارش کامل را باقی می‌گذارد؛ هر دو JSON معتبر با `project` و `temporary`‌اند. شکست نوشتن،
fsync یا rename گزارش قبلی را نگه می‌دارد، فایل خواهر را حذف می‌کند و فقط روی stderr (بدون مسیر)
اعلام می‌شود؛ تمرین هرگز با چنین شکستی موفق گزارش نمی‌شود و کد خروج غیرصفر است. شکست نوشتن در
حین پاکسازی هم فراموش نمی‌شود: پاکسازی ادامه می‌یابد، مرحله شکست (بدون مسیر) در `reportWriteFailures`
می‌ماند و در نوشتن بعدی گزارش (از جمله نوشتن پایانی) ثبت می‌شود و `passed: false` و کد خروج ۱ می‌دهد. نوشتن‌های میانی فقط
در برابر مرگ فرایند ایمن‌اند؛ تنها نوشتن اولیه و پایانی پوشه والد را هم fsync می‌کنند و تنها برای آن‌ها
می‌توان ماندگاری پس از قطع برق را ادعا کرد؛ اگر fsync پوشه شکست بخورد، گزارش کامل در جای خود می‌ماند و
هشدار روی stderr چاپ می‌شود. اگر قطع یا شکست میانه نوشتن رخ دهد، فایل خواهر
`<report>.<hex>.tmp` با مجوز `0600` ممکن است بماند؛ پس از بررسی حذفش کنید.

هر فرزند در گروه فرایند جدا (`detached`) اجرا می‌شود، پس SIGKILL تمرین فرزندان را نمی‌کشد:
`docker compose up --wait`، `pg_dump` یا `pnpm db:migrate` ممکن است همچنان منابع بگیرند.
شناسه گروه (PGID) هر فرزند پیش از انتظار برای آن در `processGroups` گزارش نوشته می‌شود (گروه‌های
در حال اجرا؛ ورودی تازه‌تمام‌شده ممکن است بماند، پس عضویت را بررسی کنید). پنجره چند میلی‌ثانیه‌ای
بین ساخت فرزند و نوشتن گزارش ثبت‌نشده می‌ماند. جست‌وجوی `pgrep -f <project>` به‌تنهایی کافی نیست:
فرزندان migration و build نام پروژه را در argv ندارند. پس از SIGKILL به این ترتیب عمل کنید:

1. فهرست گروه‌ها اجتماع `processGroups` و `orphanProcessGroups` است (گروه بازمانده همیشه در هر دو
   می‌ماند). برای هر PGID اجرا کنید `ps -o pid,pgid,args -g <PGID>`. خروجی خالی یعنی گروه رفته است.
   فقط گروهی که فرایندهای همین تمرین را نشان می‌دهد (نه PGID بازمصرف‌شده کاربر یا فرمان دیگر) با
   `kill -KILL -- -<PGID>` متوقف شود؛ پیش از هر kill همین بررسی را دوباره انجام دهید. هرگز بر پایه الگو
   (`pkill -f`، `killall`) نکشید.
2. صبر کنید تا `ps -g` برای همه PGIDها خالی شود و `pgrep -f <project>` هم چیزی نشان ندهد.
3. فقط سپس `docker compose --project-name <project> --file <temporary>/compose.json down --volumes`.
4. سپس پوشه `temporary` (فایل‌های SQL و آرشیوهای dump با مجوز `0600`) و فایل‌های خواهر `.tmp` گزارش را حذف کنید.

در اجرای عادی، پایان رهبر گروه (رویداد `exit`، نه بسته‌شدن پایپ‌ها) ملاک است: اگر فرزندی پایپ
stdout/stderr را نگه دارد، پس از انتظار کوتاه و محدود (۲ ثانیه) گروه کشته می‌شود و تا سقف زمان فرمان
(تا ۱۰ دقیقه) باقی نمی‌ماند. عضوی که پس از خروج رهبر بماند کشته و در `reapedProcessGroups` ثبت می‌شود.
گروهی که پس از انتظار محدود باز هم بماند در `processGroups` و `orphanProcessGroups` می‌ماند، سیگنال‌های
بعدی (حتی در حین پاکسازی) دوباره آن را می‌کشند، پیش از نتیجه پاکسازی یک بار دیگر بررسی می‌شود و
`cleanup.passed: false` همراه `project` و `temporary` می‌ماند. گروه فقط وقتی از مالکیت خارج می‌شود
که ناپدیدشدنش تأیید شده باشد. سقف زمان فرمان همیشه شکست است، حتی اگر کد خروج پس از kill صفر باشد
(`timedOut: true` در شکست خصوصی). اگر نوشتن PGID در گزارش شکست بخورد، فرمان غیر پاکسازی متوقف
می‌شود، گروهش کشته و ناپدیدشدنش تأیید می‌شود و خطا `Could not record process group` است؛ فرمان پاکسازی
ادامه می‌یابد. در هر دو حالت `reportWriteFailures` ثبت و نتیجه ناموفق است.
پاکسازی همیشه به همین ترتیب پایان می‌یابد: ابتدا همه فرمان‌های در حال اجرا (از جمله همتایان فرمانی که
شکست خورده، مثل بررسی هم‌زمان container، volume و network) تمام و گروه‌هایشان بررسی می‌شود؛ بعد
`compose down` و فهرست منابع؛ سپس یک بار دیگر هر گروه بازمانده بررسی می‌شود، حتی اگر `down` یا فهرست
منابع شکست خورده باشد؛ و فقط پس از آن گزارش نهایی نوشته می‌شود. نتیجه این بررسی در
`cleanup.orphanRetry` (`retried` و `remaining`) و منابع باقی‌مانده یا بررسی‌نشده (فقط نوع منبع، بدون
شناسه) در `cleanup.leftovers` و `cleanup.unverified` ثبت می‌شود.
انتظار برای پایان فرمانی که کشته شده به رویدادهای خود فرزند وابسته نیست. هر توقف (سقف زمان، سرریز
خروجی، ثبت‌نشدن PGID، سیگنال) از یک مسیر می‌گذرد: گروه با SIGKILL کشته می‌شود و مهلت تأیید کشتن
(`KILL_CONFIRMATION_DEADLINE_MS`، در `scripts/backup-restore-drill-lib.mjs`، ۱۰ ثانیه) شروع می‌شود. فرزندی
که در I/O غیرقابل‌وقفه گیر کرده ممکن است پس از SIGKILL هیچ‌گاه `exit`، `close` یا `error` نفرستد. اگر
مهلت تمام شود و رهبر گروه خارج نشده باشد، فرمان با کد `KILL_UNCONFIRMED` رد می‌شود و در انتظار پایان
همه فرمان‌ها تمام‌شده حساب می‌شود، پس پاکسازی و گزارش نهایی منتظر آن نمی‌مانند. PGID آن بدون تأیید می‌ماند: در
`unconfirmedProcessGroups` (`pgid`، `stage`، `reason`)، در `processGroups` و `orphanProcessGroups` ثبت
می‌شود و بررسی دوباره پیش از نتیجه پاکسازی آن را می‌آزماید؛ تا وقتی ناپدیدشدنش تأیید نشود
`cleanup.passed` برابر `false` است. برای چنین گروهی همان مراحل بازیابی بالا (`ps -g`، سپس `kill -KILL`)
را دنبال کنید؛ اگر فرایند در حالت `D` بماند فقط راه‌اندازی مجدد میزبان آن را آزاد می‌کند.
بازیابی خودکار: `scripts/backup-restore-drill --cleanup-from /path/to/report.json` فقط وقتی عمل می‌کند که
گزارش را با وضعیت واقعی ماشین اثبات کند و در غیر این صورت با کد خروج ۲ رد می‌کند (گزارش گم‌شده، ناخوانا،
JSON ناقص یا بدون مالکیت «کاری نیست» نیست). گزارش باید فایل عادی خصوصی همین کاربر باشد (`0600`، بدون
دنبال‌کردن symlink) و `project`، `temporary` و `recoveryId` را با همان شکل‌هایی داشته باشد که تمرین می‌سازد.
پوشه `temporary` باید مستقیماً زیر `TMPDIR`، دایرکتوری واقعی و خصوصی باشد (symlink رد می‌شود) و
نشانگر `recovery.json` در آن، که تمرین پیش از هر چیز دیگر می‌نویسد، باید همان پروژه، شناسه و نام پوشه را
بگوید؛ پس گزارش پروژه A با پوشه پروژه B رد می‌شود. `compose.json` باید فایل عادی (نه symlink) باشد و تعریفش
دقیقاً تعریف همین پروژه: دو سرویس `source` و `restored` با نام container پروژه، حجم‌های نام‌دار، پورت
loopback و mount فقط‌خواندنی init؛ هر کلید یا mount دیگر (privileged، bind به میزبان، include) پیش از آنکه
Compose فایل را بخواند رد می‌شود. همین بررسی پیش از `compose down` در پایان اجرای عادی هم انجام می‌شود، پس
پاکسازی عادی و بازیابی یک مرز مشترک دارند. گروه‌های فرایند ثبت‌شده (`processGroups`،
`orphanProcessGroups`، `unconfirmedProcessGroups`) فقط وقتی کشته می‌شوند که محیط هر عضو زنده آن‌ها (از
`/proc`، فقط لینوکس) `RASTA_DRILL_RECOVERY_ID` همین اجرا را داشته باشد؛ هرگز بر پایه نام یا خط فرمان. گروهی
که اثبات نشود سیگنال نمی‌گیرد و بازیابی با کد ۱ ناموفق می‌شود. کد خروج ۰ یعنی چیزی باقی نیست، ۱ یعنی منبعی
یا گروهی ماند یا بررسی نشد (پوشه و گزارش برای تلاش دوباره می‌مانند) و ۲ یعنی گزارش رد شد. استثنا: پوشه
`temporary` وجود ندارد و خود گزارش `cleanup.passed: true` را دارد؛ آن‌گاه فقط برچسب منابع پروژه بررسی می‌شود.
بازیابی هیچ‌گاه گزارش را بازنویسی نمی‌کند و پیام‌هایش مسیر، نام یا شناسه‌ای از گزارش را تکرار نمی‌کنند.
فرزندهای خود بازیابی هم ثبت می‌شوند، در هر بار اجرا و حتی وقتی پوشه `temporary` دیگر وجود ندارد: بلافاصله پس از هر
spawn شناسه گروهشان در دفترچه جداگانه `<report>.recovery-journal.json` می‌آید و همان `RASTA_DRILL_RECOVERY_ID` را
دارند. این دفترچه کنار گزارش است و بیرون از پوشه‌ای که بازیابی حذف می‌کند (نوشتن اتمی با فایل موقت، `fsync` فایل و
پوشه، و `rename`). اگر خود بازیابی با SIGKILL کشته شود، بازیابی بعدی پیش از هر کار دیگر گروه‌های دفترچه را با
همان اثبات می‌کشد و تا وقتی گروهی زنده باشد موفقیت گزارش نمی‌کند؛ گزارش اصلی تغییر نمی‌کند. نقطه‌های بازرسی هم در
همین دفترچه‌اند: `recovered` پیش از حذف پوشه و `removed` پس از آن. پس تلاش دوباره پس از قطع در هر مرحله حذف (نشانگر
یا خود پوشه رفته، یا خروج به فراخواننده نرسیده) به‌جای رد شدن کار را تمام می‌کند و بدون پرسیدن از Docker موفق می‌شود.
شکست نوشتن دفترچه یا گزارش، از جمله شکست `fsync` فایل یا پوشه، چسبنده است: آن بازیابی دیگر هرگز با کد ۰ تمام نمی‌شود و
چیزی را بیشتر حذف نمی‌کند، حتی اگر نوشتن‌های بعدی موفق باشند. هر اجرا و هر بازیابی یک گزارش قفل انحصاری
(فایل‌های `<report>.lock.<hex>` کنار گزارش) را تا پایان عمرش نگه می‌دارد؛ بازیابی دوم، یا بازیابی هم‌زمان با اجرای
زنده، تا ۳۰ ثانیه منتظر می‌ماند و سپس با کد ۲ و یک پیام ثابت رد می‌شود. قفل بازمانده از فرایند کشته‌شده فقط وقتی
برداشته می‌شود که نبودن صاحبش اثبات شود (شناسه فرایند و زمان شروع آن، بوت و فضای نام)؛ حالت نامشخص هرگز برداشته
نمی‌شود. محدودیت اعلام‌شده (مدیر پروژه آن را پذیرفته است و راه‌حل مهندسی‌شده‌ای برایش نیست): SIGKILL بین spawn و نوشتن
همان لحظه دفترچه (یا گزارش) می‌تواند یک گروه را ثبت‌نشده بگذارد. پنجره، یک نوشتن کوچک با دو `fsync` است: چند
میلی‌ثانیه و روی دیسک کند بیشتر. رزرو پیش از spawn ممکن نیست، چون شناسه گروه همان pid فرزند است و پیش از ساخته‌شدن
فرزند وجود ندارد؛ یافتن بعدی آن فقط با پیمایش `/proc` بر پایه محیط ممکن می‌شد که با اثبات ضعیف‌تری سیگنال می‌دهد و
فرایندهای پنهان‌شده با `hidepid` را نمی‌بیند. قفل و دفترچه به مسیر گزارش وابسته‌اند: نسخه کپی‌شده گزارش در مسیر
دیگر هویت دیگری است و با اصلی هم‌زمان‌سازی نمی‌شود، پس از یک گزارش فقط یک نسخه را به بازیابی بدهید. همه نام‌های کنار گزارش پیش از ساخت هر منبعی رزرو می‌شود: هر فایلی که تمرین یا بازیابی می‌نویسد خود مسیر
گزارش به‌علاوه یکی از سه پسوند `.recovery-journal.json`، `.lock.<hex>` و `.<hex>.tmp` است، پس مسیر گزارش نباید خودش به
یکی از این پسوندها ختم شود (مثلاً `R.recovery-journal.json` وقتی `R` در کار است): `--report` و `--cleanup-from` هر دو، پیش
از ساخت قفل یا هر فایل دیگری، با کد ۲ و یک خط ثابت رد می‌کنند. تمرین عادی گزارش را انحصاری می‌سازد و بلافاصله دفترچه را هم
انحصاری و با یک «رزرو» می‌سازد (فقط شناسه همین اجرا، بدون گروه و بدون نقطه بازرسی؛ بازیابی آن را «چیزی ثبت نشده» می‌خواند).
اگر مسیر دفترچه از پیش وجود داشته باشد، چه دفترچه اجرای پایان‌یافته یا ناتمام قبلی، چه فایل ناقص یا بی‌ربط، شروع با کد ۲ و
یک خط ثابت رد می‌شود و چیزی ساخته یا دست‌خورده نمی‌شود. سیاست انتخاب‌شده: دفترچه باقی‌مانده خودکار بایگانی **نمی‌شود**،
رد می‌شود؛ برای استفاده دوباره از یک مسیر گزارش، گزارش و دفترچه‌اش را با هم بایگانی یا حذف کنید (گردش‌کار CI هر بار پوشه
خصوصی تازه می‌سازد، پس به آن برنمی‌خورد). نتیجه: دفترچه اجرای A هیچ‌گاه در بازیابی اجرای B خوانده نمی‌شود و دو گزارش با
نام‌های هم‌پوشان هیچ فایلی را مشترک ندارند. وضعیت هر گروه سه‌حالته
است: ناپدیدشده (`kill(-pgid, 0)` ثابت می‌کند)، اثبات‌شده (همه اعضا خوانده و با شناسه مطابق شده‌اند) یا
نامشخص (هر خطای خواندن `/proc`، فیلد ناقص، عضو بدون شناسه، یا گروه زنده‌ای که هیچ عضوی از آن دیده نمی‌شود).
گروه نامشخص هرگز سیگنال نمی‌گیرد و هرگز موفقیت حساب نمی‌شود: بازیابی با کد ۱ و پیام ثابتی که فقط شناسه گروه
را می‌گوید تمام می‌شود. ورودی‌های قابل جایگزینی (گزارش، نشانگر، دفترچه، `compose.json` و دو ورودی خلاصه)
بدون مسدودشدن باز می‌شوند، فقط اگر فایل عادی باشند خوانده می‌شوند و اندازه‌شان سقف دارد؛ FIFO رد می‌شود.
هرگز stack مشترک را reset نکنید. شکست حذف پایگاه scratch در `scratchDropFailed` ثبت می‌شود؛
خطای اصلی جمع‌آوری مدرک حفظ می‌شود و پاکسازی خوشه متعلق به تمرین همچنان انجام می‌شود.

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

خودکارسازی ماهانه: approved 2026-10-24 (owner), scheduled monthly by
`backup-drill-monthly.yml` (بخش «Monthly scheduled drill» پایین). تست‌های مقایسه و SQL
منفی در CI اجرا می‌شوند؛ job مستقل `integration-backup-drill` با سقف ۱۰ دقیقه عضو گیت
`Integration and security tests` است و فقط این تست‌ها را اجرا می‌کند، نه فرمان کامل
۱۶ پایگاه. سقف گام آزمون PostgreSQL پنج دقیقه است و افزایش نیافته؛ زمان این job در CI و
زمان کامل فرمان ۱۶ پایگاه باید جدا گزارش شوند. جمع `before.schemaDump.milliseconds` و
`after.schemaDump.milliseconds` هزینه جمع‌آوری schema را نشان می‌دهد.

## Monthly scheduled drill

**When.** `.github/workflows/backup-drill-monthly.yml` runs at 03:17 UTC on the 1st of every
month (`17 3 1 * *`), on demand (Actions → "Backup restore drill (monthly)" → Run workflow,
or `gh workflow run backup-drill-monthly.yml`), and on a pull request that changes that file
or `scripts/backup-restore-drill*` (so the change itself proves the job still runs).
Runs of one ref do not overlap and a running drill is never cancelled (GitHub keeps one pending
run per group, so a newer pending run replaces an older pending one).

**What it runs.** The same command as an operator, `scripts/backup-restore-drill --report <new
file>`, on an `ubuntu-latest` runner after `pnpm install --frozen-lockfile`. The CLI owns its two
PostgreSQL servers (the image pinned in `docker-compose.yml`, the same digest `ci.yml` pins);
the workflow declares no service container and no database URL. It builds, migrates and seeds all
databases, adds the synthetic ledger fixture, dumps, restores into a fresh server, and applies
every gate of this runbook: database coverage, row counts and digests, migrations, database and
object state, reference allowance, schema fixed point, ledger equality including the
per-currency totals, wallets/escrow/active holds, the `9007199254740993` amount above the safe
integer range, and cleanup of the CLI's own containers, networks and volumes.

**Measured duration.** On a GitHub-hosted `ubuntu-latest` runner the drill step took 219 s (run
40800884574, 2026-10-29: install 28 s, the drill 3 min 39 s; 16 databases, 260 tables, 262
application rows, 193 migration rows; 7.4 s of schema-dump collection and 31.8 s of reference and
fixed-point work in total). On the dev host the same command took 703 s. The workflow's limits come
from those, separately from the 5-minute PostgreSQL test step of `ci.yml`: 20 minutes for the drill
step (about five times the runner's measurement, under twice the slower host's) and 30 for the job.
Read the real duration from each run's summary ("total seconds") and move the limits if it
approaches them.

**What the job shows.** The CLI's stdout (it carries synthetic ledger amounts), stderr and the
JSON report stay in a private directory under `RUNNER_TEMP` (`backup-drill`, mode 0700); nothing is
uploaded. Its path is never exported through `GITHUB_ENV` or a step `env:` (GitHub prints those in
the header of every later step); each step derives it from `RUNNER_TEMP` and the runner masks it
(`::add-mask::`) before its first use, so it does not reach the log even in a command's error
message. The log and the job summary come from `scripts/backup-restore-drill-summary.mjs`, which
builds them from an allowlist (pass/fail per gate, counts, durations, the failing stage and
database names, the CLI's exit code) and never copies a field from the report by key. Database and
stage names are accepted only if they are in the service registry
(`infrastructure/docker/postgres/lib/role-passwords.bash`, the list the drill iterates), and the
coverage gate compares the databases in the report with that registry, not with a list the report
carries. A failure of the summary script itself (unreadable registry, a malformed report) prints
one fixed message and exits 1, never a stack trace. A failing
run is red: the drill step exits with the CLI's status, the summary step exits non-zero unless
every gate passed and the CLI status is 0, and the summary names the failing gates. The workflow
has `permissions: contents: read`, references no secret (the repository is public) and sends no
alert itself. Its last step runs `scripts/backup-restore-drill --cleanup-from <report>` (also
after a cancellation or a timeout; see the recovery paragraph above for what it proves before it
removes or kills anything). A missing, unreadable or unprovable record fails the step (exit 2), and
so does anything it could not remove (exit 1); the private directory, the recovery record included,
is deleted only after a cleanup that succeeded.
One run or recovery of a report at a time: each holds an exclusive lock (`<report>.lock.<hex>` files
beside the report) for its whole lifetime; a second one waits up to 30 s for a live owner and then
exits 2 with a fixed line, and a claim left by a killed process is taken over only after its owner is
proven gone (pid, start time, boot, pid namespace; an unprovable owner is never taken over). Recovery's
own journal (`<report>.recovery-journal.json`, beside the report, outside the directory it deletes)
exists for every invocation, also when the directory is already gone, and carries the completion
checkpoints (`recovered` before the removal, `removed` after), so a retry after any interruption
finishes or succeeds without asking Docker. A journal or report write that fails, a failed directory
fsync included, is sticky for that invocation: it never exits 0 and removes nothing more.
The report's whole artifact namespace is reserved before anything is allocated. Everything a run or
recovery writes is the report path plus `.recovery-journal.json`, `.lock.<hex>` or `.<hex>.tmp`, so a
report path that itself ends in one of these (for example `R.recovery-journal.json` while `R` is in
use) is refused by `--report` and `--cleanup-from` alike with one fixed line and exit 2, before any
file is created. A normal run then creates the report exclusively and the journal exclusively as a
reservation (its recovery id only; recovery reads it as "nothing recorded"). If the journal path
already exists (a journal left by a finished run on that path, an unreadable or unrelated file) the
start is refused with one fixed line and exit 2, nothing is created and the existing file is not
touched: **a stale journal is refused, never archived or adopted.** To reuse a report path, archive or
delete the report together with its journal.
**Residual, accepted by the project manager:** a SIGKILL between a child's spawn and the synchronous
write that names its process group (one small write plus two fsyncs: milliseconds, more on a slow
disk) can leave that one group unrecorded, for the original run's children and recovery's alike. A
reservation before the spawn is not done: the group id is the child's pid and does not exist yet, and
finding it again would need a `/proc` sweep by environment alone, which signals on weaker proof than
the per-group check and misses processes a `hidepid` mount hides. The lock and the journal are keyed
by the report's path: a copy of a report at another path is another identity.
Every invocation of the CLI goes through a guarded entry without static imports: a module that cannot
be loaded (for example a checkout without `pnpm install`) ends in one fixed line and exit 1, never a
stack trace with source paths; `--cleanup-from` itself needs only Node's built-in modules.

**Who reacts to a red run.** The host's bot watches this workflow's runs and reports a red one to
the project manager; the infrastructure owner of RUN-003 triages it. Open the run, read the
summary (failing gates, failed stage, database, exit code), reproduce with the command above in a
clean worktree, and fix or file the cause. One re-run is fair when the failing stage is an image
or package download; a second red run is not noise. A red drill is never left until the next
month: restore capability is unproven while it is red. A month with no run at all is also a
failure to react to: GitHub disables scheduled workflows of a public repository after 60 days
without repository activity, so check that the workflow is still enabled when a run is missing.

**What a green run proves.** The tools of this commit restore a logical dump of the seeded
databases plus a synthetic ledger into a fresh cluster, and every gate above holds there.

**What it does not prove.** Synthetic data only: this is not a production restore, nor a
restore of production-sized data or roles. Restored writers, services, consumers and publishers
stay stopped (restored outboxes never publish), so it does not prove runtime tenant isolation,
event replay or consumer idempotency after a restore, or that a service works against the
restored databases. The limits in "دامنه اثبات و محدودیت‌ها" above (PITR, WAL archiving, RPO/RTO,
off-host backup storage and retention, encryption, Keycloak/Temporal, object storage, Kafka
offsets) apply unchanged to the scheduled run.

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
