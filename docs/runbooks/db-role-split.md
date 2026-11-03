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

| نقش                    | کیست                                    | چه دارد                                                                                                                                                                                                                          |
| ---------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rasta_<svc>_migrator` | مالک؛ فقط Migration و پاک‌سازی آزمون‌ها | مالک پایگاه داده `rasta_<svc>`، Schema `public` و **همهٔ** جدول‌ها، Sequenceها، توابع و `_prisma_migrations`. `CREATEDB` فقط برای Shadow Database محلی `prisma migrate dev`.                                                     |
| `rasta_<svc>`          | نقش اجرا؛ سرویس با این وصل می‌شود       | دقیقاً آنچه سیاستش در `lib/runtime-allowlist.sql` مجاز می‌داند — در حالت `default`: `CONNECT` روی پایگاه داده، `USAGE` روی `public`، و `SELECT, INSERT, UPDATE, DELETE` روی جدول‌ها و `USAGE, SELECT` روی Sequenceها — نه بیشتر. |

نقش اجرا **ندارد**: مالکیت هیچ چیز؛ `CREATE` روی پایگاه داده یا Schema (پس نمی‌تواند چیزی بسازد که مالکش شود)؛
`TRUNCATE`، `REFERENCES`، `TRIGGER`؛ هیچ حقی روی `_prisma_migrations`؛ `CREATEDB`، `CREATEROLE`، `BYPASSRLS`، `REPLICATION`، `SUPERUSER`.
`EXECUTE` روی توابع مهاجر از `PUBLIC` گرفته شده (Triggerها همچنان اجرا می‌شوند: حق EXECUTE هنگام **ساختن** Trigger بررسی
می‌شود، نه هنگام اجرا). دو نقش عضو یکدیگر نیستند — عضویت همان قدرت‌ها را پس می‌دهد.

**حق جدول‌ها، دو حالت** (`privilege_split_grants_mode`):

- `default` — DML روی همهٔ جدول‌های فعلی، و با `ALTER DEFAULT PRIVILEGES FOR ROLE rasta_<svc>_migrator IN SCHEMA public`
  روی هر جدول و Sequenceی که مهاجر بعداً بسازد.
- `migration` — هیچ حقی در اسکریپت؛ هر جدول حقش را از Migration خود سرویس می‌گیرد. supplier و analytics: روی جدول‌های
  فقط‌افزودنی کمتر از DML می‌دهد. هر حق باید سطری هم در سیاست خود سرویس در `lib/runtime-allowlist.sql` داشته باشد؛
  اسکریپت هر حقی را که سیاست نام نبرده است پس می‌گیرد (پایین‌تر: «One allowlist»).

Analytics (RUN-001 PR 2) uses migration-managed grants. Apply the split script first.
B (`20261024120000_baseline_metric`) grants baseline `SELECT` and revokes baseline/sequence writes
inside its transaction. P (`20261024130000_analytics_runtime_privileges`) removes legacy table/sequence
defaults and existing named grants, then grants only `SELECT, INSERT` on `fact_maintenance` and
`processed_event` and restores baseline `SELECT` (P migration.sql:17 revokes it, :24 re-grants it). No baseline writer is enabled. A split
rerun cannot restore blanket DML for analytics, even if an older caller requests `default`.
P's down revokes only the fact/marker grants; it keeps B's baseline `SELECT` and never restores unsafe
defaults. B's down takes an exclusive lock and refuses if any baseline row exists; there is no bypass.

Before deploying P, stop analytics and capture an explicit ACL snapshot using the DBA connection
in `PG*` (no password or URL in argv):

```bash
PGDATABASE=rasta_analytics psql -X -qAt -v ON_ERROR_STOP=1 --file scripts/db-acl-snapshot.sql > /secure/operator-path/analytics-pre-deploy-acls.txt
```

Keep that file outside the repository. If deployment fails, capture the same query again and compare
with `diff -u` before resolving the failed migration row. This includes relation, column, function,
schema, database and default ACLs. No pre-deploy snapshot means recovery step 1 cannot be confirmed;
investigate rather than guessing that nothing changed.

P requires **`current_user = rasta_analytics_migrator`**. A DBA/superuser connection is also refused
with SQLSTATE `42501`. A failed Prisma ledger row blocks later deploys with **P3009**. Recovery:

1. Keep the service stopped. Inspect the failed row for exactly
   `20261024130000_analytics_runtime_privileges` (`finished_at IS NULL AND rolled_back_at IS NULL`).
   Confirm the error is the migrator-role refusal and that the migration transaction rolled back:
   compare relation, column and default ACLs with the pre-deploy snapshot. Do not resolve if any ACL
   changed or the failure has another cause; investigate first. The guard precedes every ACL statement.
2. Correct `DATABASE_URL_ANALYTICS_MIGRATOR` in the migration environment so its connected
   `current_user` is exactly `rasta_analytics_migrator`; confirm it with `SELECT current_user`.
   Credentials stay in the environment or `.env.migrator`, never command arguments.
3. Mark only that rolled-back attempt through the migrator wrapper (same procedure as
   [docs/23 recovery](../23-risks-and-tradeoffs.md)):

   ```bash
   pnpm --dir services/analytics-service exec node --env-file-if-exists=../../.env --env-file-if-exists=../../.env.migrator ../../scripts/prisma.mjs migrate resolve --rolled-back 20261024130000_analytics_runtime_privileges
   pnpm --dir services/analytics-service db:migrate
   ```

4. Run `pnpm check:db-runtime-privileges` and verify baseline read-only plus fact/marker `SELECT, INSERT`
   before restarting. Never mark the failed migration `--applied` to bypass its guard.

**Reachability, all services including audit.** Both splitter and checker read
`infrastructure/docker/postgres/lib/runtime-reachable.sql`: `pg_has_role(runtime, r, 'MEMBER')`
plus PUBLIC. MEMBER is an intentionally **conservative superset**, including INHERIT FALSE and
SET FALSE memberships; it is not a claim that every member can SET ROLE on PG16. Every forbidden
right in the checker uses this closure: schema/database CREATE, ledger rights, dangerous table
privileges, extension writes and function EXECUTE. Ownership and dangerous-role membership use
MEMBER too. Every predefined `pg_*` role is refused (#540 r1 F1: not only the read/write-all,
server-file and program-execution ones). Their implicit rights cannot be removed by object REVOKE,
so the split revokes the runtime role's membership that reaches one, whoever granted it.

**One allowlist (#421 r1 F3, F3b = #520 r1 R1).** What a runtime role may hold is one declarative
file, `lib/runtime-allowlist.sql`: per policy — `default` (every split service in grants mode
`default`), the service's own name (mode `migration`: `supplier`, `analytics`) and `audit` — the
schema it may use, each relation (`schema.name`, or `schema.*` for every relation of the schema) and
sequence with its privileges, and the migrator's default privileges; `*` rows hold for every policy
(`CONNECT` on the database, `SELECT` on extension relations and sequences). Functions are
`lib/runtime-function-grants.txt`. `lib/runtime-forbidden.sql` turns it round: every privilege of
every ACL-bearing object — the database, each schema, relation (each partition too: an
`audit_event` partition is allowed nothing), column grant, sequence, non-extension routine and
default ACL — that the policy does not allow, plus any grant option, held by the closure (the role,
every role it is a MEMBER of, PUBLIC). Each class has a ceiling the allowlist cannot raise: never
`TRUNCATE`, `REFERENCES` or `TRIGGER`; never `UPDATE` (`setval`) on a sequence; nothing on the
ledger; nothing on a definer or trigger function, nor PUBLIC `EXECUTE` on a migrator function; no
default for functions or schemas; no `CREATE` or `TEMPORARY`. The split revokes every ACL entry that
file lists and fails unless nothing is held; in grants mode `default` it also grants exactly the
`default` policy's `schema.*` and default-privilege rows. The checker reports every forbidden right
held **and** every allowed right on an existing object, schema or the database that the role does
not hold (`allowed but not held: …`), so the allowlist and the migrations must agree; a unit test
reads each migration-managed policy against its migrations' `GRANT`/`REVOKE` statements, row for
row. A broken policy — none for the name, a service with its own policy held to `default`, a row
above its ceiling — fails both. Role attributes, ownership, membership, predefined roles and the
required runtime EXECUTE list stay the checker's own: no ACL REVOKE repairs them.

**The whole inventory and the whole matrix (#540 r1 F1, F2; D-097, D-100).** The rules above judge
`lib/runtime-acl-entries.sql`: every ACL entry of every PostgreSQL 16 ACL column — database, schema,
relation, column, routine, type and domain, language, large object, foreign-data wrapper, server,
tablespace, parameter (`pg_parameter_acl`: `SET`, `ALTER SYSTEM`) and default ACL (types too) —
compared with the object's built-in privileges (`pg_init_privs`, else `acldefault`). On system
catalogues (`pg_catalog`, `information_schema`, their columns), extension routines and every class
the allowlist has no row for, any entry beyond the built-in privileges held by the closure is
forbidden (a grant on `pg_authid` is). A catalogue ACL column the file does not model — a later
PostgreSQL's — is a finding nothing can revoke: the check and the split fail closed until it is
modeled. `lib/runtime-dangerous-roles.sql` is the one list of roles no runtime role may be a member
of: `SUPERUSER`, `CREATEDB`, `CREATEROLE`, `BYPASSRLS`, `REPLICATION`; any migrator; any service's
runtime role; every predefined role; the owner of anything of any class in any database
(`pg_shdepend`: publications, subscriptions, event triggers, large objects, FDWs, servers,
tablespaces, …). Both reset statements add `NOREPLICATION`, and no role may be a member of a runtime
role. **Stored settings** (`lib/runtime-settings.sql`): a setting stored for the runtime role, for
it in its database, for its database or for every role (`ALTER ROLE ALL`) is applied at each login
with no privilege check, so `session_replication_role = replica` stored there would switch the
triggers off like the parameter grant. Only `TimeZone`, `statement_timeout` and
`rasta.disposable_database` may be stored. The split resets every other one and fails if one is left;
the check reports it. **Across services,** `lib/runtime-foreign.sql`: in each service's database no other service's
runtime role — directly, through PUBLIC or through a role it is a member of — holds `CONNECT`,
`TEMPORARY`, any right on any object (the database's built-in PUBLIC entries and a user routine's
default PUBLIC `EXECUTE` included) or owns anything. The split revokes that in its own database and
gives what another runtime role owned there to its migrator. The checker runs the rule in **every**
database that accepts connections, so every (database, runtime role) pair is checked. A service
database that is missing or refuses connections fails. The only exceptions are in
`lib/runtime-foreign-exceptions.sql`, each with its reason: PostgreSQL's default PUBLIC `CONNECT`
(and `TEMPORARY`) on `postgres`, `template1` and `template_postgis`. `keycloak`, `temporal` and
`temporal_visibility` are there too, because the bootstrap superuser owns them and Keycloak and
Temporal connect as that superuser (D-100). A unit test fails if one of them gets a dedicated owner;
PUBLIC is then revoked at bootstrap instead. No service database may be listed.

**A new table** in `default` needs nothing. In `supplier`, `analytics` or `audit` it needs its `GRANT`
in the migration **and** its row in `runtime-allowlist.sql`: without the row the split revokes the
grant on its next run and the check fails on a fresh bootstrap. An `EXECUTE` a service needs goes in
`runtime-function-grants.txt`; one granted elsewhere is revoked (`EXECUTE on function …, not in
runtime-function-grants.txt`).

The split revokes each actual ACL entry while temporarily acting as its recorded grantor
(`SET LOCAL ROLE <grantor>; REVOKE ... CASCADE; RESET ROLE`). PG16 object `GRANTED BY` cannot
name another current user. This covers table, column, sequence and routine (`ROUTINE`: functions,
procedures, aggregates) grants from third-party grant-option holders, across the same MEMBER/PUBLIC
holder set. Extension functions remain excluded. **It runs to a fixed point (#421 r1 F1):** a CASCADE
can remove an entry a later REVOKE names, whose grantor then holds nothing and is refused. So the
live ACL is read again before every REVOKE, one entry at a time, leaves of a grant chain first. PG16
keeps a column grant made under a table-level grant option when that option is revoked; its grantor
can no longer revoke it, so the object's owner lends the option for that one REVOKE and takes it back
in the same transaction. Each REVOKE must remove its own entry, so the loop is bounded by the entries
found; it fails closed otherwise. Done means the closure holds nothing the file lists, not merely that
the loop ended: a right only a predefined role gives fails the split, naming it, as it fails the check.

**Extension relations, all services.** The privileged splitter removes writes after application
grants, including column, PUBLIC and MEMBER-holder grants. Existing SELECT stays for PostGIS reads.
No service needs runtime extension DML. Audit also runs function cleanup: its non-extension trigger
functions need no direct runtime EXECUTE (PostgreSQL checks EXECUTE when creating triggers).
The checker rejects PUBLIC EXECUTE on migrator functions, and reachable EXECUTE on any non-extension
user definer/trigger/event-trigger function, even if a CREATE OR REPLACE introduced it after a split.

**Repair clusters split before #407.** Stop economic/procurement. Deploy the splitter together with
`runtime-reachable.sql` and `runtime-function-grants.txt` from the same revision, then rerun
`pnpm db:privilege-split economic` and `pnpm db:privilege-split procurement` with the DBA credentials
and distinct exported runtime/migrator passwords described in § 5. Already-applied migrations do not
repair lost ACLs by themselves. The declared source of truth is `lib/runtime-function-grants.txt`:

- Economic: `commission_rule_scope_key(text,public."BusinessLine",public."TransactionType")`,
  `commission_rule_scope_change(…)`, `commission_pricing_scope_lock(…)`, same types
  (migration `20261016120000_commission_business_lines`, lines 208-210).
- Procurement: `demand_aggregation_digest_range(text,text,text,text,integer)`
  (migration `20261017120000_aggregation_window_sweep`, line 120).

All are in `public`; each line names its creating migration, and types are schema-qualified so the
DBA's `search_path` decides nothing. The splitter reads every line (the last one too) and refuses a
malformed one — the same grammar as the checker (#520 r1 R2): an empty line or one starting with `#`
is skipped, every other line is exactly three non-empty `|`-separated fields matched whole (no
trailing `|`, no empty service, no blank or carriage return), and a NUL byte anywhere refuses the
file; it idempotently restores these existing migration grants on every run (`GRANT EXECUTE
ON ROUTINE`), only after verifying migrator ownership and SECURITY INVOKER/non-trigger/non-extension
definition. A missing signature is skipped only while its creating migration is not recorded as
applied in `public._prisma_migrations` (pre-migration bootstrap, or a pending, failed or rolled-back
one: the migration grants EXECUTE itself). Recorded as applied, it refuses repair (#421 r1 F5);
the post-migration checker requires every signature and effective runtime EXECUTE. Unsafe
definitions refuse repair and require operator investigation. Run the checker before/after repair, then exercise commission pricing **and rule changes**
and procurement trigger-driven digest work with the real runtime logins before restarting services.

Why the allowed declared-list path instead of a new grant migration: docs/23 D-045 already uses a
splitter for cluster ACL repairs. Repair must also converge after a later split on an upgraded database,
whose original migrations are recorded as applied. One list serves repair and detection without
maintaining duplicate GRANT lists. No new migration/down exists; rolling back the tooling does not
revoke these original application grants or restore forbidden ACLs. Definitions, data and original
migration files are unchanged. A healthy cluster and an old-splitter-damaged cluster converge to the
same helper EXECUTE ACLs. This hardens database privileges only; it makes no app authorization or
tenant-isolation claim.

| Mode        | Services                                                                                                                                         | Expected extension rights after split                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `migration` | supplier, analytics                                                                                                                              | At most existing `SELECT`; application grants come from migrations.                                                              |
| `default`   | construction, identity, notification, organization, asset, fleet, maintenance, marketplace, document, procurement, inventory, contract, economic | At most `SELECT`; ordinary application tables keep DML, sequences keep USAGE/SELECT.                                             |
| `audit`     | audit (separate split path)                                                                                                                      | No public schema USAGE; at most existing extension `SELECT`, never extension writes. Audit append grants stay in its migrations. |

Fresh bootstrap splits **before** installing extensions as superuser, so no legacy extension DML
exists yet. Upgrades and reruns with extensions present remove legacy writes after application grants
are set; running the split twice converges to the same privileges. The catalogue checker also rejects
effective extension INSERT/UPDATE/DELETE, including column-only and MEMBER/PUBLIC grants.

**دفتر Migration** (`_prisma_migrations`) را خود اسکریپت تقسیم، **پیش از هر Migration**، با DDL دقیق Prisma می‌سازد:
مالکش مهاجر است و به هیچ نقشی (نه `PUBLIC`، نه نقش اجرا) حقی ندارد (بازبینی Codex روی #176). اگر Prisma آن را بسازد، از
Default Privileges حق DML نقش اجرا را به ارث می‌برد — در تمام مدت اجرای Migration، و برای همیشه اگر Migration شکست بخورد —
و نقشی که بتواند دفتر را بنویسد می‌تواند Migrationِ سازندهٔ یک نگهبان را «اجراشده» جا بزند. Prisma دفتری را که پیدا کند
به‌کار می‌گیرد. `scripts/prisma.mjs` پس از **هر** اجرا، موفق یا ناموفق، حق نقش اجرا را روی دفتر دوباره می‌گیرد (کمربند
و بند — مثلاً پس از `migrate reset` که دفتر را Prisma از نو می‌سازد).

**audit** متفاوت است (ADR-053 § 6): جدول‌ها در Schema `audit` و مالکشان `rasta_audit_migrator`؛ از D-045 خود پایگاه داده
هم مال مهاجر است و نقش اجرا فقط `CONNECT` و `USAGE` روی `audit` دارد.

## ۳. اعتبار مهاجر کجاست — هرگز در محیط سرویس

اعتبار مهاجر (`DATABASE_URL_<SVC>_MIGRATOR`، `POSTGRES_PASSWORD_<SVC>_MIGRATOR`) و رمز Superuser
(`POSTGRES_SUPERUSER_PASSWORD`؛ پیش‌فرضش در `docker-compose.yml` است و مقدار دیگر را در Shellِ `pnpm infra:up`
export کن) **در `.env` نیستند**؛ اعتبار مهاجر در
`.env.migrator.example` است (کپی محلی: `.env.migrator`، git-ignored). `.env` را `start` و `dev` همهٔ سرویس‌ها بار
می‌کنند؛ `.env.migrator` را فقط ابزار Migration (`db:migrate`/`db:migrate:dev` → `scripts/prisma.mjs`)، کانتینر postgres
در Compose (`env_file`) و Suiteهای یکپارچگی (برای پاک‌سازی با اتصال مالک) می‌خوانند. هر سرویس در `main.ts`، پیش از بارکردن
هر چیز، `assertNoMigratorCredentials` (`@rasta/config`) را صدا می‌زند و بالا نمی‌آید اگر در محیطش (۱) **مقدار** هر
متغیری، با هر نامی، یک URL ‏`postgres://`/`postgresql://` باشد که کاربرش یکی از نقش‌های اجرای سرویس‌ها (`rasta_<svc>`) نیست —
URL مهاجر، Superuser، `TEST_ANALYTICS_ADMIN_URL` و حتی `DATABASE_URL`ی که مهاجر را نام ببرد؛ URL ناخوانا یا بی‌کاربر هم رد
می‌شود — یا (۲) **نام** متغیر اعتباری بی‌URL را برساند: `*_MIGRATOR`، `POSTGRES_SUPERUSER_PASSWORD`، `POSTGRES_PASSWORD`،
`PGPASSWORD`، `TEST_*_ADMIN_URL`، `DATABASE_URL_*_{ADMIN,OWNER,DBA,ROOT,SUPERUSER}` (#421 r1 F2). فقط نام‌های فهرست‌شده را
می‌گوید و بقیه را می‌شمارد، هرگز مقدار را؛ آزمون: `pnpm test:boot-guard` روی `dist/main.js` هر سرویس، که `.env.example` و
محیط هر گام CI که سرویسی را بالا می‌آورد را هم می‌پذیرد.
`scripts/prisma.mjs` برای سرویس تقسیم‌شده بی URL مهاجر رد می‌کند و به URL اجرا برنمی‌گردد. `pnpm infra:up` اگر `.env`ِ
قدیمی هنوز اعتبار مهاجر داشته باشد هشدار می‌دهد: آن‌ها را به `.env.migrator` ببر و از `.env` پاک کن.

**نقشی که واقعاً وصل شده.** نقشی که نامش نقش اجراست ولی مالک است یا `CREATE` دارد در هیچ URLی پیدا نیست. پس هر سرویس تقسیم‌شده
(و audit) نخستین کارِ `AppModule.onModuleInit` را `PrismaService.assertRuntimeRole()` می‌کند — بررسی مشترک
`@rasta/nest-common` (`runtime-role.ts`) که از Catalogue می‌پرسد و بالا نمی‌آید اگر نقش وصل‌شده (مستقیم یا با عضویت)
Superuser باشد، نامش (`current_user` یا `session_user`) به `_migrator` ختم شود، مالک پایگاه داده، Schemaی غیرسیستمی یا
هر Relationی باشد، روی پایگاه داده یا Schemaی `CREATE` داشته باشد، یا `CREATEDB`/`CREATEROLE`/`BYPASSRLS`/`REPLICATION` داشته باشد.
آزمون زنده: `test/startup-role.int-spec.ts` هر سرویس (URL مهاجر در جای `DATABASE_URL` → رد)، و در CI
`scripts/runtime-preflight.e2e.mjs`: URL مهاجر → ردِ نگهبان محیط؛ نقش اجرا با `CREATE` روی Schemaاش → ردِ Preflight.

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

**کد ما هرگز اعتبار را در argv نمی‌گذارد؛ موتور Schema پریزما هنوز URL را در argv خودش می‌گیرد (D-047).** آرگومان‌های
هر فرایند را هر کاربر محلی، تا وقتی فرایند زنده است، می‌خواند (`ps`، `/proc/<pid>/cmdline`). پس در کد ما: Prisma
`db execute` با `--schema prisma/schema.prisma` اجرا می‌شود و URL را از `DATABASE_URL` در محیط فرزند می‌خواند (نه `--url`)؛
psql URL بی گذرواژه می‌گیرد و گذرواژه را از `PGPASSWORD` (`libpqInvocation` در `scripts/verify-migration-reversible-lib.mjs`)؛
اسکریپت‌های پوسته (Bootstrap، چرخش گذرواژه، تقسیم) SQL — از جمله `ALTER ROLE … PASSWORD` — را از stdin (`psql -f -`) می‌دهند،
نه `-c`؛ و در Workflowها URL دارای گذرواژه فقط در انتساب محیط (`KEY: value`) می‌آید. آزمون‌های
`scripts/verify-migration-reversible-lib.test.mjs` (اسکریپت‌ها، کد و آزمون سرویس‌ها، Workflowها و هر فراخوانی psql/pg\_\*
در اسکریپت‌های پوسته) و `scripts/infra-preflight.test.mjs` (هیچ گذرواژهٔ نقشی به argv نمی‌رسد) بازگشت آن را رد می‌کنند.
**باقی‌مانده، بیرون از کد ما (D-047):** خود Prisma (6.19.3) در `migrate deploy`/`dev`/`reset`/`resolve`/`status` و `db push`
پیش از کار، موتور Schema را با `schema-engine cli --datasource <url> can-connect-to-database` اجرا می‌کند؛ پس URL مهاجر
برای چند میلی‌ثانیه در argv آن فرایند فرزند هست. **کنترل:** Migration فقط روی میزبان مطمئن یا کار CI اختصاصی اجرا
می‌شود — هرگز روی ماشین مشترک چندکاربره. ارتقای Prisma که URL را از محیط/stdin بدهد (یا Driver Adapter) آن را می‌بندد.

**عضویت هم مالکیت است.** نقش اجرایی که عضو مهاجر باشد — حتی `WITH INHERIT FALSE`، که چیزی به ارث نمی‌برد — با
`SET ROLE` مهاجر می‌شود و هر نگهبان را برمی‌دارد. پس هر دو بررسی (`assertRuntimeRole` و `check:db-runtime-privileges`)
مالکیت را با `pg_has_role … 'MEMBER'` می‌سنجند و هر عضویتی در نقشی که اینجا مالک چیزی است، نامش `*_migrator` است یا
`SUPERUSER`/`CREATEDB`/`CREATEROLE`/`BYPASSRLS`/`REPLICATION` دارد را رد می‌کنند؛ و اسکریپت تقسیم هر عضویت مستقیم نقش اجرا در چنین
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
   بلافاصله DML روی جدول‌های موجود دارد، پس سرویس قطع نمی‌شود: CONNECT نقش اجرا در همان تراکنشی داده می‌شود که
   مالکیت پایگاه داده را منتقل می‌کند، و USAGE و Grantهای جدول در همان تراکنش `REASSIGN OWNED` و انتقال Schema (#540 r3
   R3-1)؛ پس اگر تقسیم پس از آن بایستد هم نقش اجرا بی‌دسترسی نمی‌ماند. (supplier و analytics، حالت `migration`: تا گام ۳ حق جدول ندارند.)

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
- **سقف زمان Statement پشت PgBouncer (اختیاری، #268 r4):** آنجا `DATABASE_STATEMENT_TIMEOUT_MS` سرویس دور انداخته می‌شود،
  پس اگر سقفی می‌خواهید روی **نقش اجرا** بگذارید — `ALTER ROLE rasta_<svc> IN DATABASE rasta_<svc> SET
statement_timeout = '<ms>ms'`، هرگز روی مهاجر. همان اسکریپت‌ها با `POSTGRES_STATEMENT_TIMEOUT_MS_<SVC>` آن را
  می‌گذارند (تقسیم، Bootstrap و `db:rotate-role-passwords`؛ تنظیم‌نشده هیچ کاری نمی‌کنند). در Compose محلی مقدارِ Export‌شده
  فقط به فرمان‌های `pnpm db:*privilege-split` و `db:rotate-role-passwords` می‌رسد (`scripts/postgres-exec.bash`)؛ Bootstrap
  فقط `.env.migrator` را می‌بیند. مقدار باید از بزرگ‌ترین بودجهٔ عملیاتی همان سرویس بیشتر باشد (جدول `docs/11` § ۱۱٫۲) —
  اینجا هیچ بررسی‌ای آن را نمی‌سنجد.

## ۷. افزودن سرویس تازه

از پایان D-045 هر سرویس تقسیم‌شده است و `check:db-runtime-privileges` سرویسی را که در `RASTA_SERVICES` هست ولی در
`PRIVILEGE_SPLIT_SERVICES` نیست رد می‌کند؛ پس سرویس تازه از نخستین Migration تقسیم‌شده به دنیا می‌آید:

1. سرویس را به `PRIVILEGE_SPLIT_SERVICES` (`lib/role-passwords.bash`) اضافه کن.
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
- **«in RASTA_SERVICES but not in PRIVILEGE_SPLIT_SERVICES»:** سرویس تازه‌ای بی تقسیم اضافه شده — گام‌های § ۷.
- **`<db>: another service's runtime role holds: …`** (#540 r1 F2): in a service database, rerun
  that service's split (§ 5.2); it revokes the foreign entries and takes foreign-owned objects. In a
  database no service owns, revoke the named grant there by hand (`REVOKE … FROM <role>`; for PUBLIC's
  default on a database of your own, `REVOKE ALL ON DATABASE <db> FROM PUBLIC`). Only if it is truly
  infrastructure, declare it in `lib/runtime-foreign-exceptions.sql` with its reason.
- **`… on system table …` / `… on parameter …` / `… beyond the built-in privileges`** (#540 r1 F1): a
  grant beyond PostgreSQL's built-in privileges on a catalogue, parameter, tablespace, large object,
  FDW, server, type, language or extension routine. The split revokes it (a parameter or tablespace
  grant is cluster-wide: any service's split does).
- **`a stored setting reaches its sessions: <parameter> (<scope>)`:** rerun the split (it resets it), or
  `ALTER ROLE … RESET <parameter>` / `ALTER DATABASE … RESET <parameter>` by hand. Only the parameter
  and its scope are printed, never the stored value, which may be a secret (#540 r2 R2-3); read it in
  `pg_db_role_setting` if you need it.
- **`the split did not reach its end state: …`** (#540 r2 R2-1): the split's last step read the
  catalogue back and something it promises is missing — an attribute still held, an object the runtime
  role still owns, a schema or the database not the migrator's, CONNECT/USAGE or a default-mode grant
  missing, the migrator without USAGE or CREATE on its schema, lent schema access not returned, the
  ledger missing or granted, UTC or the configured `statement_timeout` not set, a stored
  setting or a membership left. Each is named. Every statement's failure also stops the split where it
  happened (psql's error is the line above), so fix that cause and rerun; the split is idempotent.
- **Schema `rasta_split_lent` in a service database / `schema access the split lent is not all returned`**
  (#540 r3 R3-1): the split acts as other roles — each grantor revokes its own grants, the migrator
  repairs function grants — and a role names an object only through a schema it has USAGE on. When the
  split itself took that USAGE (a membership it revoked, a schema it handed to the migrator or took from
  another service's runtime role), it lends USAGE on that schema to that exact role just before it acts,
  records the loan in `rasta_split_lent.namespace_usage`, and revokes exactly that entry at its very
  end, then drops the schema. A run that stopped in between leaves the schema and its loans: rerun the
  split; it returns them. Do not drop the schema by hand while it lists loans. The split refuses a
  `rasta_split_lent` that is not a superuser's or holds anything else (`… is not a superuser's` /
  `… holds something besides the split's own ledger`): inspect and remove it, then rerun.
- **`the split cannot tell which schemas … names`** (#540 r3 R3-1): a grant on an object kind the loan
  does not model. Model it in `rasta_split_lent.lend` (lib/service-privilege-split.bash) first; the
  split refuses rather than act without the access it needs.
- **`unsupported database name …` / `unsupported service name …`** (split) and **`unsupported database
name`, `unreadable database record`, `connected to database …, not the one asked for`** (check) (#540
  r2 R2-2): the split takes plain lower-case names only (`[a-z_][a-z0-9_]*`), and refuses any other
  rather than let libpq read it as a connection string. The check connects to every database by its
  literal name and stops if the session is not in it.
- **`the ACL column … is not modeled`:** this PostgreSQL has an ACL the inventory does not know. Model it
  in `lib/runtime-acl-entries.sql` (and its unit test) before running the split again; it refuses
  until then.

**Privileged URL names at boot.** The existing guard's scope is credential variable names, not all
foreign runtime URLs: `DATABASE_URL_*_MIGRATOR` and `POSTGRES_PASSWORD_*_MIGRATOR` were refused.
It now also refuses non-empty `DATABASE_URL_*_ADMIN`, `*_TEST_ADMIN`, `*_SUPERUSER` (and unprefixed
`DATABASE_URL_ADMIN` etc.). The shared `.env.example` contains foreign service runtime URLs and no
such privileged names, so normal `start`/`dev` stays valid. Analytics's disposable fixture uses
`TEST_ANALYTICS_ADMIN_URL` only in its separate `test:db-privileges` integration project and coverage
run; never in the shared all-service integration environment or runtime `.env`. See
`services/analytics-service/test/README.md` and `.env.migrator.example`.
