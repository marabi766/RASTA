# ADR-074: Staging روی یک میزبان (rasta-dev) و امنیت هم‌شکل Production

- **وضعیت:** **Proposed** — فقط طراحی (RUN-002 گام ۰)؛ هیچ استقرار، هیچ تغییر زیرساخت میزبان و هیچ کدی در این PR نیست
- **تاریخ:** 2026-10-25؛ دور ۲ (بازبینی Codex r1، F1–F7): 2026-10-27 — نگاشت در § «تغییرات r2»
- **تصمیم‌گیرنده:** معماری پلتفرم؛ تصمیم‌های مالک در § «Open» (O-1 تا O-7) باز می‌مانند تا مالک پاسخ دهد. شماره‌ی ADR طبق
  `docs/26` قاعده‌ی ۴ وارسی شد: `ADR-072` روی شاخه‌ی #362 و `ADR-073` روی شاخه‌ی #368 گرفته شده‌اند؛ `ADR-074` روی `origin/main`
  و همه‌ی شاخه‌های باز آزاد بود. هیچ `Q-NN` یا `D-NNN` در این سند واگذار نمی‌شود.
- **مرتبط:** ADR-005 (مالکیت پایگاه داده)، ADR-020 (احراز هویت سرویس‌به‌سرویس)، ADR-061 § ۳ (Kafka SASL/SCRAM و ACL)،
  D-045 (جداسازی نقش اجرا از مالک)، D-047 (URL در argv موتور Schema)، D-053 (تخلیه‌ی Saga)، D-068 (Restore مرجع)، S-03
  (توکن مشترک سرویس‌ها)؛ `docs/12` §§ ۱۲٫۱–۱۲٫۸
- **Backlog:** RUN-002 — «Staging deployment and production-shaped security» (MVP، P2، ۲۱ امتیاز، `IN_PROGRESS`؛ وابسته به
  PLAT-004 که `ACCEPTED` است)؛ RUN-003 به آن وابسته است و RUN-004 (Pilot) به RUN-003 و EXP-004
- **برنامه‌ی اجرا:** [ADR-074 implementation plan](ADR-074-implementation-plan.md)

## Context

### معیارهای پذیرش و تصمیم‌های مالک

دو معیار RUN-002 (`planning/backlog.json:1557-1560`):

1. «A reproducible staging deployment uses default-deny network policy»
2. «Secrets, migrations, image provenance and rollback are operationally verified»

یادداشت Evidence همان ردیف (`planning/backlog.json:1592`) می‌گوید معیار نخست **شروع نشده** است (هیچ Manifest یا
`values-staging.yaml` در مخزن نیست) و از معیار دوم فقط بخش Secret و Migration (D-045، #176، #177، #178، #180 و #191)
پیش رفته است. RUN-003 به RUN-002 وابسته است (`:1608`) و RUN-004 به RUN-003 و EXP-004 (`:1624`).

تصمیم‌های مالک، 2026-10-24: (۱) Staging فعلاً روی **همین** میزبان (`rasta-dev`) اجرا می‌شود و ماشین دومی نیست؛ (۲) مخزن
GitHub فعلاً **عمومی** می‌ماند.

### آنچه `docs/12` فرض کرده و این میزبان ندارد

| `docs/12`          | فرض                                                               | روی rasta-dev                                                                  |
| ------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `:17`              | Staging روی Kubernetes، «خودکار از `main`»                        | بی Kubernetes؛ بی دسترسی root (پایین)                                          |
| `:23-24`           | TLS بیرونی و **mTLS داخلی** در Staging                            | mTLS در کد نیست؛ توکن مشترک HS256 (S-03، `packages/config/src/env.ts:555-562`) |
| `:134-135`         | Secret از External Secrets Operator؛ NetworkPolicy                | هیچ‌کدام در مخزن نیست                                                          |
| `:180-193`         | پایگاه داده‌ی هر سرویس فقط از خودش؛ Egress بسته                   | Compose امروز یک شبکه‌ی پیش‌فرض مشترک دارد (پایین)                             |
| `:244-250`         | روی `main`: Build، Scan، **Push Registry**، Deploy                | Push نمی‌شود (`ci.yml:4663` `push: false`)؛ Deploy نیست                        |
| `:270-274`         | `helm upgrade --atomic` و Rollback خودکار                         | بی Helm؛ Rollback باید با Digest قبلی ساخته شود (§ ۸)                          |
| `:338-340`، `:352` | Runbookهای `restore-database`، `disaster-recovery`، `secret-leak` | **این سه فایل در `docs/runbooks/` وجود ندارند** (پیوند شکسته)                  |

### آنچه امروز در مخزن هست

| موضوع              | واقعیت امروز                                                                                                                                                                                                                                                          |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ساخت و Scan تصویر  | Job `containers` تصویر را می‌سازد، با SHA برچسب می‌زند و با Trivy (فقط HIGH/CRITICAL **قابل‌رفع**، `ignore-unfixed`) می‌سنجد؛ Push ندارد (`.github/workflows/ci.yml:4608`، `:4663`، `:4713-4715`)                                                                     |
| دامنه‌ی تصویرها    | روی PR فقط تصویرهای متأثر، روی Push به `main` همه (`ci.yml:4592-4606`)؛ مالک 2026-10-24 تصویب کرد که ساخت و Scan به Train (`mq/train-*`) و `main` برود (کار W#8 828)                                                                                                  |
| فهرست تصویرها      | فقط هر پوشه‌ی `services/*` با `Dockerfile` (`scripts/container-scope-lib.mjs:24-26`) — ۱۷ تصویر، `api-gateway` هم؛ **`apps/web` هیچ Dockerfile ندارد**                                                                                                                |
| Migration در تصویر | تصویر اجرا `pnpm deploy --prod` است (`services/economic-service/Dockerfile:66`) و `prisma` فقط `devDependency` است؛ پس **هیچ تصویری Migration را اجرا نمی‌تواند** و `db:migrate` از ریشه‌ی مخزن اجرا می‌شود (`package.json:19` همان سرویس)                            |
| نقش اجرا و مالک    | D-045 کامل: مهاجر مالک، نقش اجرا فقط DML (`docs/runbooks/db-role-split.md:19-27`)؛ سرویس با اعتبار مهاجر بالا نمی‌آید (`:151-165`)؛ بررسی Catalogue پس از هر استقرار (`:259`)                                                                                         |
| Kafka              | پروفایل `deployment` با ۱۶ سرویس و `ops-replay`، بی Principalهای آزمون و ابزار (`infrastructure/docker/kafka/principals.deployment.txt`؛ `scripts/kafka-acl.mjs:5`، `:52`)؛ سرویس بی SASL و TLS بالا نمی‌آید (`packages/nest-common/src/kafka/connection.ts:113-120`) |
| Keycloak           | فقط Realm توسعه، که کاربران با گذرواژه‌ی عمومی دارد و فقط در `start-dev` بار می‌شود (`infrastructure/docker/keycloak/dev-realm-gate.sh:3-27`)؛ **Realm بی‌کاربر برای محیط واقعی در مخزن نیست**                                                                        |
| Compose توسعه      | یک پروژه `rasta` (`docker-compose.yml:13`)، `container_name` ثابت (`:63` و …)، بی بخش `networks` (همه روی شبکه‌ی پیش‌فرض)، بی هیچ سقف حافظه یا CPU (`:60-108`)، Retention ـِ Kafka فقط زمانی (`:177`)، و `COMPOSE_BIND_ADDRESS` که Bind را عوض‌پذیر می‌کند (`:99`)    |
| تمرین Restore      | فقط PostgreSQL، روی خوشه‌ی یک‌بارمصرف، با نقش‌های توسعه (`docs/runbooks/backup-restore-drill.md:3-9`، `:95-102`)                                                                                                                                                      |
| دروازه‌ی Saga      | دستی؛ «هر خط استقراری که ساخته شود باید همین اسکریپت را میان گام ۲ و ۴ اجرا کند» (`docs/runbooks/marketplace-saga-deploy.md:92-95`)                                                                                                                                   |

### اندازه‌گیری میزبان (فقط فرمان‌های خواندنی)

زمان: 2026-10-25 00:55 UTC. منبع تاریخچه: `sysstat` همین میزبان، نمونه‌ی ده‌دقیقه‌ای، از 2026-10-17 00:10 UTC تا 2026-10-25،
۱٬۱۵۰ نمونه (`sadf -d /var/log/sysstat/saNN -- -r|-u|-q|-S`). میانگین ده‌دقیقه‌ای اوج کوتاه‌تر را نرم می‌کند؛ پس اوج
واقعی **دست‌کم** این است.

| اندازه                           | مقدار                                                                                                                                                          | فرمان                                       |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| CPU                              | ۸ هسته (یک Thread در هر هسته)، ماشین مجازی                                                                                                                     | `nproc`، `lscpu`                            |
| حافظه / Swap                     | ۱۵٬۶۱۳ MiB / ۸٬۱۹۱ MiB                                                                                                                                         | `free -m`                                   |
| دیسک ریشه                        | ۱۵۰G کل، ۸۲G مصرف، ۶۳G آزاد (۵۷٪)؛ Inode ۱۸٪. برگه‌ی کار 2026-10-24 «حدود ۸۷٪» گزارش کرده بود: دیسک در یک روز حدود ۳۰ واحد درصد جابه‌جا شد                     | `df -h /`، `df -i /`                        |
| Docker                           | تصویرها ۸٫۶۳ GB (۴٫۷۳ قابل‌بازپس‌گیری)، Volumeها ۹٫۶۸ GB (۱٫۸۲)، Build Cache ۵٫۱۲ GB (۱٫۳۲)، Containerها ۰٫۳۰ GB (۰٫۱۵)                                        | `docker system df`                          |
| بزرگ‌ترین مسیرها                 | `~/work` ۱۶G (۲۹ Worktree)، `~/rasta` ۹٫۰G، `/tmp` ۷٫۶G، `~/.cache` ۴٫۴G، `~/demo` ۳٫۷G                                                                        | `du -xsh`                                   |
| بیشترین حافظه‌ی مصرفی (بی Cache) | **۱۲٬۸۹۲ MiB** در 2026-10-24 15:20 UTC؛ همان نمونه: Available ۱٬۹۷۷ MiB و Swap ۷۳٫۷۸٪ (حدود ۶ GiB)                                                             | `sadf … -r`، `-S`                           |
| توزیع Available در ۹ روز         | کمینه ۱٬۹۷۷؛ صدک ۱: ۶٬۳۹۲؛ صدک ۵: ۹٬۶۵۷؛ میانه: ۱۱٬۹۲۲ MiB؛ ۳۰ نمونه (۲٫۶٪) زیر ۸٬۱۹۲ MiB                                                                      | همان                                        |
| Commit                           | بیشینه ۹۶٫۵۷٪ (2026-10-24 06:50 UTC)                                                                                                                           | `sadf … -r` (`%commit`)                     |
| CPU                              | کمینه‌ی Idle ۰٫۲۹٪ (2026-10-24 08:50 UTC)؛ Load5: میانه ۰٫۶۷، صدک ۹۵: ۷٫۸۱، صدک ۹۹: ۲۰٫۰۷، بیشینه ۴۰٫۹۷؛ Steal همیشه صفر                                       | `sadf … -u`، `-q`                           |
| Containerهای باقی‌مانده‌ی آزمون  | `rl-pg` (۹ روز)، `w4-r051-pg` (۷ روز)، `w6-014-pg` (۱۴ ساعت)؛ Peak هرکدام (cgroup `memory.peak`، با Page Cache) حدود ۰٫۸۶–۰٫۹۱ GB                              | `docker ps`، `/sys/fs/cgroup/…/memory.peak` |
| Stack توسعه (`rasta`)            | Peak با Page Cache: kafka ۱٫۴۶ GB، keycloak ۱٫۱۹، clamav ۱٫۱۸، freshclam ۰٫۹۶، temporal ۰٫۲۳، postgres ۰٫۲۰ GB؛ **هیچ‌کدام سقف ندارد** (`HostConfig.Memory=0`) | `docker inspect`، `memory.peak`             |
| تنظیم Docker                     | Engine 29.8.1، cgroup v2 با `systemd`؛ `/etc/docker/daemon.json` = `{"ip": "127.0.0.1", "log-driver": "local"}`                                                | `docker info`، `cat`                        |
| Listenerها                       | فقط SSH (`0.0.0.0:22`، `[::]:22`) بیرونی است؛ بقیه روی `127.0.0.1` (تأیید مستقل گزارش PM، 21:40 UTC)                                                           | `ss -tlnH`                                  |
| CI                               | هر ۱۸ Job روی `ubuntu-latest` (GitHub-hosted)؛ هیچ Runner روی این میزبان نیست                                                                                  | `grep runs-on .github/workflows/*.yml`      |
| دیسک ریشه، 2026-10-27 15:10 UTC  | ۷۱٪ (حدود ۴۲G آزاد): در دو روز ۱۴ واحد درصد بالا رفت — دلیل اینکه دیسک در طول اجرا پایش می‌شود، نه فقط در شروع (§ ۳)                                           | `df /`                                      |
| cgroup ـِ کاربر (2026-10-27)     | `user@1000.service` کنترلرهای `cpu memory pids` را Delegate دارد؛ ولی فرایندهای عامل‌ها در `session-N.scope` اند که Delegate ندارد                             | `cgroup.controllers`، `/proc/self/cgroup`   |
| PSI (2026-10-27)                 | `/proc/pressure/memory` بی root خواناست                                                                                                                        | `cat`                                       |
| شبکه‌های Docker (2026-10-27)     | `daemon.json` بی `default-address-pools`؛ پنج شبکه؛ مسیر پیش‌فرض خود میزبان در `172.31.0.0/16` است، یعنی درون Pool ـِ پیش‌فرض Docker                           | `docker network ls`، `ip -4 route`          |

اوج‌های بالا مال کار عامل‌ها (Workerها، PM، آزمون‌های محلی با Testcontainers و پایگاه‌های یک‌بارمصرف) است؛ CI روی این میزبان
اجرا نمی‌شود. سهم هر Worker جدا در تاریخچه نیست؛ فقط کل میزبان هست.

### محدودیت‌های میزبان که طراحی را شکل می‌دهند

- **هیچ‌کس root ندارد.** این نشست `sudo` ندارد و طبق گزارش PM (2026-10-24 21:40 UTC) مالک هم ندارد؛ `ufw` فعال است
  (`/etc/ufw/ufw.conf` `ENABLED=yes`) ولی `/etc/ufw/user.rules` فقط برای root خواناست. پس طراحی نه به خواندن قواعد ufw تکیه
  می‌کند، نه به تغییر `daemon.json`، `DOCKER-USER`، Slice ـِ systemd یا نصب بسته.
- **عضویت گروه `docker` هم‌ارز root است.** همه‌ی عامل‌ها با کاربر `rasta` (عضو `docker`) اجرا می‌شوند. هر فرایندی با این
  کاربر می‌تواند `docker exec` و `docker inspect` (که Environment را نشان می‌دهد) بزند یا Volume را پاک کند.
- **Rootless Docker ممکن نیست**: `newuidmap`/`newgidmap` نصب نیستند (`which` چیزی نمی‌یابد)، با آنکه `/etc/subuid` برای
  `rasta` بازه دارد؛ نصب آن‌ها root می‌خواهد.

## Decision

### ۱. Runtime: Docker Compose با سقف سخت، نه k3s

Staging یک پروژه‌ی Compose جداست: `rasta-staging`، از فایل `infrastructure/staging/compose.yml` (PR S4a برنامه). k3s تک‌گره رد شد:

| معیار                       | Compose با سقف                                                       | k3s تک‌گره                                                                                        |
| --------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| نصب                         | Docker همین حالا هست                                                 | **root لازم دارد** (سرویس systemd، containerd خودش، iptables) — روی این میزبان کسی root ندارد     |
| حافظه                       | فقط خود Containerها                                                  | یک Control Plane (API Server، Datastore، kubelet) که از همان ۱۵ GiB کم می‌شود؛ اوج امروز جا ندارد |
| Runtime دوم                 | ندارد                                                                | containerd دوم کنار Docker؛ دو زمان‌بند روی یک حافظه                                              |
| NetworkPolicy               | Object ندارد؛ با شبکه‌های `internal` و احراز هویت ساخته می‌شود (§ ۴) | دارد                                                                                              |
| هم‌شکلی با `docs/12` § ۱۲٫۴ | کمتر                                                                 | بیشتر                                                                                             |

پیامد: Staging از `docs/12` § ۱۲٫۴ **انحراف ثبت‌شده** دارد. برای اینکه Compose و Chart آینده از هم جدا نیفتند، فهرست سرویس‌ها،
پورت، شبکه، سقف و Secret هر سرویس در **یک** فایل داده (`infrastructure/staging/services.json`) است؛ `compose.yml` از آن ساخته
می‌شود و آزمون مخزن آن دو را برابر نگه می‌دارد. Chart ـِ Kubernetes روزی که ساخته شود از همان داده می‌خواند. استقرار Production
همچنان طبق `docs/12` روی Kubernetes است؛ این ADR آن را عوض نمی‌کند.

### ۲. مرز اعتماد روی این میزبان — صریح

روی rasta-dev، Staging در برابر **خطا و تصادف** جداست، نه در برابر فرایندی که با کاربر `rasta` یا گروه `docker` اجرا می‌شود
(§ Context). نتیجه‌ها:

1. Staging فقط **داده‌ی مصنوعی** دارد (همان `docs/12:17`). هیچ داده‌ی واقعی مستاجر، هیچ کاربر واقعی Pilot و هیچ اعتبار
   سرویس بیرونی واقعی (درگاه پرداخت، SMTP واقعی) به آن نمی‌رسد. پرداخت `Mock` می‌ماند (`docs/12:28`).
2. **RUN-004 (Pilot با کاربر واقعی) روی این میزبان، با این پیکربندی، ممکن نیست.** شرط لازم: میزبانی که در آن هیچ عامل
   توسعه‌ای عضو `docker` یا root نیست — ماشین دوم، یا کاربر جدا با Docker بی‌ریشه پس از نصب `uidmap` توسط کسی که root دارد
   (O-5). این را RUN-003 و RUN-004 به ارث می‌برند.
3. رمزهای Staging «Secret» به معنای «نه در Git، نه در CI، نه در Log» هستند (§ ۵)، نه به معنای «پنهان از عامل‌های همین میزبان».
4. D-047 (URL مهاجر برای چند میلی‌ثانیه در argv موتور Schema؛ `db-role-split.md:189-192`) می‌گوید Migration «هرگز روی ماشین
   مشترک چندکاربره». rasta-dev مشترک است، ولی همه‌ی عامل‌ها **یک** کاربرند و فایل Secret را مستقیم هم می‌خوانند؛ پس argv
   چیزی به دسترسی آن‌ها نمی‌افزاید. این استدلال فقط با بند ۱ معتبر است و با داده‌ی واقعی از بین می‌رود.

### ۳. بودجه‌ی منابع (بند ۱ دستور کار)

**حکم اندازه‌گیری‌ها.** در اوج ۹ روز گذشته کار عامل‌ها به‌تنهایی از RAM گذشت (۱۲٬۸۹۲ MiB مصرف + حدود ۶ GiB Swap؛ Commit
۹۶٫۵۷٪). در صدک ۱، Available فقط ۶٬۳۹۲ MiB بود. سقف‌های حافظه‌ی زیرساخت Demo ـِ محلی (بیرون از مخزن، همان شش بخش
PostgreSQL/Redis/Kafka/Keycloak/MinIO/Temporal) جمعاً ۴٬۷۸۴ MiB است (`~/demo/docker-compose.demo.yml:56`، `:71`، `:117`،
`:171`، `:185`، `:233`) — **بی** ۱۸ فرایند Node (۱۶ سرویس دامنه، Gateway و پورتال). پس اندازه‌گیری‌ها از Staging ـِ کامل و
**همیشه‌روشن** در کنار اوج کار عامل‌ها پشتیبانی نمی‌کنند.

**تصمیم (r2: محافظت در **تمام مدت** اجرا، نه فقط هنگام پذیرش):**

1. **سقف هر Container — سخت، از Kernel.** هر Container ـِ Staging، Containerهای یک‌بارمصرف هم (مهاجر، Bootstrap، Probe،
   Backup، دروازه‌ی Saga)، این‌ها را دارد و `staging-policy` (PR S4b) فایلی را که یکی را نداشته باشد رد می‌کند: `mem_limit`
   و `memswap_limit` **برابر** آن (Staging هرگز Swap نمی‌گیرد)، `cpus`، `pids_limit`، `cpu_shares` کمتر از ۱۰۲۴، `read_only: true`
   با `tmpfs` ـِ `size`دار (که در سقف حافظه‌ی همان Container شمرده می‌شود)، `cap_drop: [ALL]` و `no-new-privileges` (§ ۴)،
   `healthcheck`، `stop_grace_period` (§ ۱۵)، و `logging` با `max-size` و `max-file` صریح. هر استثنا (مثلاً Image ـِ زیرساختی که
   بی لایه‌ی نوشتنی یا بی یک Capability بالا نمی‌آید) با نام و دلیل در `services.json` است، نه در Compose. `oom_score_adj` ـِ
   مثبت فقط **ترجیح** است (Kernel با آن قربانی را وزن می‌دهد) و **تضمین نیست**؛ هیچ ادعای این ADR به آن تکیه نمی‌کند.
2. **پاکت کل (Envelope) = جمع سقف‌ها، که Kernel تک‌تک نگه می‌دارد.** `E_mem` = جمع `mem_limit` ـِ Containerهای ماندگار +
   **یک** جای یک‌بارمصرف (بزرگ‌ترین سقف یک‌بارمصرف). هر فرمانی که Container ـِ یک‌بارمصرف می‌سازد زیر قفل § ۱۴ است، پس
   هم‌زمان بیش از یکی نیست. Slice ـِ والد با `MemoryMax` (پاکت در یک cgroup) بی root ساختنی نیست: Containerها زیر `system.slice`
   ـِ Daemon اند و تنظیم آن root می‌خواهد. پس پاکت جمع سقف‌هایی است که هرکدام را Kernel نگه می‌دارد، و فرمان‌ها و Watchdog
   (بند ۵) پیش از هر اثر و در هر نمونه می‌سنجند که Containerهای پروژه (الف) فقط نام‌های `services.json` اند، (ب) هرکدام
   `HostConfig.Memory` و `MemorySwap` ـِ همان فایل را دارد و (ج) جمعشان از `E_mem` بیشتر نیست. هر اختلاف یا خطای خواندن ←
   رد یا توقف.
3. **سقف Staging به‌تنهایی برای Workerها چیزی رزرو نمی‌کند**: فرایندهای عامل در `session-N.scope` اند و Containerهای
   آزمونشان `--memory` ـِ اختیاری دارند؛ هیچ‌کدام سقف ندارد. پس **پیش‌فرض: پنجره‌ی انحصاری.** Staging — و هر اجرای اندازه‌گیری
   M-1 تا M-6 — فقط در پنجره‌ای اجرا می‌شود که PM کار Workerها را در آن نگه داشته است:
   - **ورود** (`up`، زیر قفل § ۱۴) رد می‌کند اگر: Container ـِ در حال اجرایی بیرون از پروژه‌ی `rasta-staging` باشد که در فهرست
     مجاز پنجره (`/home/rasta/staging/state/window-allow`: نام دقیق، نه الگو؛ نوشته‌ی PM) نیست؛ `MemAvailable` کمتر از
     `E_mem + R_host` باشد (`R_host` = ذخیره‌ی میزبان، O-3)؛ `/proc/pressure/memory` در `full avg60` صفر نباشد؛ یا هر خواندنی
     شکست بخورد.
   - **در طول پنجره**، Watchdog (بند ۵) با نخستین نشانه‌ی کار دیگر — Container ـِ تازه بیرون از فهرست، `MemAvailable` زیر
     `R_host`، یا PSI ـِ `full` ـِ ناصفر در دو نمونه‌ی پیاپی — Staging را **متوقف می‌کند**. Staging کنار می‌رود، نه Worker.
   - پس هم‌پوشانی Staging با کار تازه حداکثر `T_poll + T_stop` است (`T_stop` = بزرگ‌ترین `stop_grace_period`، § ۱۵) و در آن
     بازه Staging از `E_mem` بیشتر نمی‌گیرد. **ادعا نمی‌شود** که Worker در این بازه هرگز Swap نمی‌گیرد؛ ادعا این است که
     Staging آن را طولانی نمی‌کند.
   - **گزینه‌ی هم‌زمان (O-3) فقط با بودجه‌ی Worker ـِ اجباری:** فرایندهای عامل زیر
     `systemd-run --user --slice=rasta-workers.slice -p MemoryMax=W_a` اجرا شوند — بی root شدنی است، چون `user@1000.service`
     کنترلر `memory` را Delegate دارد (اندازه‌گیری 2026-10-27) — و هر Container ـِ Worker `--memory` داشته باشد، با جمع ≤
     `W_c`؛ شرط: `W_a + W_c + E_mem + R_host ≤ MemTotal`. بخش Container را Kernel جمع نمی‌زند (زیر `system.slice` است)؛
     نگهبانش Watchdog است: Container ـِ در حال اجرای بی `HostConfig.Memory`، یا جمعی بالای `W_c` ← توقف Staging. تا PM
     Launcher ـِ Workerها را زیر آن Slice نبرده و M-4 عددهای `W_a` و `W_c` را نداده است، این گزینه **BLOCKED** است.
4. **دیسک: هر نویسنده یا سقف سخت دارد، یا Monitor ای که نویسنده‌ی فعال را متوقف می‌کند.** Volume روی ext4 سهمیه ندارد، و
   `/var/lib/docker` و `/home` روی همان فایل‌سیستم ریشه‌اند (`findmnt` Mount ـِ جدایی نشان نمی‌دهد). فهرست همه‌ی نویسنده‌ها:

   | نویسنده                     | کران                                                                                                                                                                                     | نوع                                                  |
   | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
   | Log ـِ Container            | `max-size × max-file` (Driver ـِ `local`)                                                                                                                                                | سخت                                                  |
   | لایه‌ی نوشتنی Container     | `read_only: true`؛ `tmpfs` در سقف حافظه                                                                                                                                                  | سخت؛ استثناهای `services.json` زیر Monitor           |
   | Pull ـِ تصویر               | **رزرو پیش از Pull**: `P` = جمع اندازه‌ی لایه‌های فشرده از Manifest ـِ Registry (`docker manifest inspect -v`، بی Pull) × `k` ـِ باز شدن (M-2)؛ ورود رد اگر آزاد < `F_admit + P`         | رزرو + Monitor (Pull فرزند فرمان است و متوقف می‌شود) |
   | تصویرهای انتشار             | فقط N و N−1؛ N−2 پس از استقرار موفق، با Digest و فقط اگر هیچ Container به آن ارجاع ندهد، حذف                                                                                             | سخت با شمار؛ کران ۲ × M-2                            |
   | PostgreSQL: داده            | بی سهمیه                                                                                                                                                                                 | Monitor + توقف (رشد: M-3)                            |
   | PostgreSQL: WAL و Temp      | `max_wal_size` (نرم)؛ Bootstrap هر Replication Slot را رد می‌کند و `max_slot_wal_keep_size` صریح است؛ `archive_mode=off`؛ `temp_file_limit` برای هر جلسه (سخت)                           | نیمه‌سخت + Monitor                                   |
   | Temporal                    | درون PostgreSQL؛ Retention ـِ Namespace                                                                                                                                                  | زیر سطر PostgreSQL                                   |
   | Kafka                       | `retention.bytes` و `segment.bytes` هر Topic؛ کران = جمع Partitionها × (`retention.bytes` + `segment.bytes`) + Index؛ `__consumer_offsets` و Log ـِ Metadata ـِ KRaft با سقف صریح خودشان | محاسبه‌شده + Monitor (حذف Segment تأخیر دارد)        |
   | Redis                       | Persistence خاموش (`save ""`، `appendonly no`)، مگر PR S6b برای خانواده‌ای از کلید دوام بخواهد؛ آنگاه AOF با کران `2 × maxmemory`                                                        | سخت / Monitor                                        |
   | MinIO                       | سهمیه‌ی سخت Bucket                                                                                                                                                                       | سخت                                                  |
   | ClamAV (Signatureها)        | اندازه‌ی Upstream                                                                                                                                                                        | Monitor                                              |
   | Mailpit                     | `MP_MAX_MESSAGES`                                                                                                                                                                        | سخت با شمار                                          |
   | Backup (`pg_dump -Fc`)      | **رزرو پیش از Backup**: دو برابر Dump ـِ قبلی همان پایگاه، یا `pg_database_size` اگر نیست؛ بودجه‌ی کل `B_total` (O-3)؛ قدیمی‌ترین فقط پس از Dump ـِ موفقِ تازه حذف می‌شود                | رزرو + بودجه                                         |
   | شاهد (`staging/evidence/`)  | بودجه‌ی بایتی؛ نوشتن بالای آن رد                                                                                                                                                         | سخت                                                  |
   | Build                       | Staging نمی‌سازد، فقط Pull                                                                                                                                                               | صفر                                                  |
   | قفل، Journal و وضعیت (§ ۱۴) | چند کیلوبایت                                                                                                                                                                             | ناچیز                                                |

   **دو آستانه، به بایت:** `F_stop` = `R_max × (T_poll + T_stop) × 2 + max_wal_size + D_meta` — از تشخیص تا توقف آخرین
   نویسنده، نویسنده‌ها حداکثر با `R_max` (بیشینه‌ی نرخ نوشتن کل، M-3) می‌نویسند؛ ضریب ۲ حاشیه است؛ Checkpoint ـِ خاموشی
   PostgreSQL و فراداده‌ی Docker (`D_meta`) هم جا می‌خواهند. `F_admit` = `F_stop + P + B + G_window` (`P` و `B` فقط اگر
   همان فرمان Pull یا Backup می‌کند؛ `G_window` = رشد یک پنجره، M-3). آزاد < `F_admit` ← هیچ فرمان تازه‌ای (استقرار، Pull،
   Backup) پذیرفته نمی‌شود و آنچه در حال اجراست می‌ماند. آزاد < `F_stop` ← Watchdog **نویسنده‌های فعال را متوقف می‌کند**: نشان
   «Abort» را برای دارنده‌ی قفل می‌نویسد (§ ۱۴)، سپس به ترتیب Edge، سرویس‌های دامنه، Kafka و Temporal و Redis و MinIO، و در آخر
   PostgreSQL را با همان مهلت § ۱۵ متوقف می‌کند (بی `kill`، بی کوتاه کردن مهلت). Staging خاموش می‌ماند تا `up` بعدی از ورود
   بگذرد. پیشنهاد ۸۵٪ ـِ دور ۱ فقط کرانی پایین برای `F_admit` است: هرکدام بزرگ‌تر باشد.

5. **Watchdog.** `up` آن را با `systemd-run --user --unit=rasta-staging-watchdog` بالا می‌آورد (بی root؛ با بسته شدن نشست
   نمی‌میرد؛ `systemctl --user status` خواناست) و اگر نتواند، `up` رد می‌کند. هر `T_poll` (پیشنهاد ۱۰ ثانیه، O-3) فضای آزاد
   ریشه (`statvfs`)، `MemAvailable`، PSI ـِ حافظه، Containerهای در حال اجرا و پاکت بند ۲ را می‌خواند؛ هر خواندن ناموفق = نشانه‌ی
   توقف. Unit با `ExecStopPost` ـِ «توقف اضطراری Staging» اجرا می‌شود، پس **Staging از Watchdog ـِ خود بیشتر زنده نمی‌ماند**:
   مرگ Watchdog به هر دلیل، Staging را متوقف می‌کند (Fail Closed). Watchdog قفل § ۱۴ را نمی‌گیرد (وگرنه هیچ استقراری در
   پنجره ممکن نبود) و قرارداد Abort همان بخش را دارد.
6. **کار پنجره‌ای و `stop`، نه `down`.** Staging برای تأیید یک انتشار یا Demo روشن و پس از آن با `stop` ـِ Staging خاموش
   می‌شود — **هرگز** `down` (§ ۱۰ بند ۸: `docker volume prune` ـِ Volume ـِ Containerهای حذف‌شده را پاک می‌کند). همیشه‌روشن
   شدن تصمیم O-3 است و فقط با گزینه‌ی هم‌زمان بند ۳.

**BLOCKED pending measurement** — عددهایی که هنوز نیستند و روش دقیق گرفتنشان. همه در **مرحله‌ی اندازه‌گیری** (برنامه، فاز
M): در پنجره‌ی انحصاری، زیر قفل و Watchdog، با سقف‌های **موقت محافظه‌کارانه**: جمع سقف‌های موقت ≤ `MemTotal − R_host −`
Peak ـِ نشست PM؛ Containerی که به سقف موقتش بخورد (`memory.events` ـِ `max` یا `oom_kill` ناصفر) اندازه‌اش **نامعتبر** است و
دوباره، با سقفی بالاتر ولی همچنان زیر همان جمع، اندازه گرفته می‌شود یا BLOCKED می‌ماند.

| شناسه | چه                                                   | روش                                                                                                                                                                                                                   |
| ----- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M-1   | حافظه‌ی هر Container ـِ Staging در بار Smoke و E2E   | هر ۱۰ ثانیه `memory.current` و در پایان `memory.peak`، `memory.stat` (`anon` جدا از `file`) و `memory.events` از `/sys/fs/cgroup/system.slice/docker-<id>.scope/`؛ سقف = Peak ـِ `anon` + حاشیه‌ی O-3                 |
| M-2   | اندازه‌ی مجموعه‌ی تصویرهای یک انتشار؛ ضریب `k`       | اندازه‌ی فشرده از Manifest ـِ Registry پیش از Pull و فضای مصرف‌شده‌ی واقعی پس از آن (`df` پیش و پس، و `docker system df`)؛ `k` = نسبت این دو؛ دیسک لازم در استقرار = ۲ × مجموعه (انتشار قبلی تا Rollback می‌ماند)     |
| M-3   | رشد Volumeها در یک پنجره؛ بیشینه‌ی نرخ نوشتن `R_max` | `docker system df -v` پیش و پس از هر پنجره برای Volumeهای `rasta-staging_*`؛ و هر ۱۰ ثانیه `wbytes` ـِ `io.stat` ـِ cgroup هر Container، جمع روی همه، بیشینه‌ی نرخ                                                    |
| M-4   | سهم Workerها در اوج — فقط برای گزینه‌ی هم‌زمان       | PM در یک روز پرکار هر ۶۰ ثانیه `memory.current` و `memory.peak` ـِ Containerهای هر Worker (نام‌های `wN-*`) و Scopeهای نشست را ثبت کند؛ `sysstat` فقط کل میزبان را دارد                                                |
| M-5   | فهرست Listenerهای هر Image                           | از فضای نام شبکه‌ی هر Container (Probe با `--network container:<id>`) خواندن `/proc/net/tcp`، `tcp6`، `udp`، `udp6`؛ هر Listener ـِ بیرون از `services.json` یا با پیکربندی بسته می‌شود یا باقی‌مانده‌ی O-6 است (§ ۴) |
| M-6   | زمان خاموشی هر Container                             | `stop` ـِ Staging با مهلت § ۱۵؛ زمان SIGTERM تا خروج و کد خروج هر Container؛ ۱۳۷ (SIGKILL) = شکست                                                                                                                     |

**پاک‌سازی یا سقف — فقط پیشنهاد، هیچ چیز پاک نشد:**

| مورد                                                               | اندازه (اکنون)                              | پیشنهاد و چه کسی                                                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Containerهای آزمون باقی‌مانده (`rl-pg`، `w4-r051-pg`، `w6-014-pg`) | سه Postgres زنده، بی سقف                    | صاحب هرکدام پس از تأیید PM حذفش کند؛ قاعده‌ی PM: هر پایگاه یک‌بارمصرف با `--memory` و برچسب Worker و پایان کار حذف |
| تصویرهای بی‌استفاده                                                | ۴٫۷۳ GB قابل‌بازپس‌گیری                     | `docker image prune` فقط با فیلتر برچسب/زمان، با تأیید PM؛ هرگز `--all` بی فیلتر روی میزبان مشترک                  |
| Build Cache                                                        | ۵٫۱۲ GB (۱٫۳۲ قابل‌بازپس‌گیری)              | `docker builder prune --keep-storage` با سقف تصمیم PM                                                              |
| Worktreeهای `~/work`                                               | ۱۶G، ۲۹ Worktree                            | Worktree ـِ PR ادغام‌شده را صاحبش با `git worktree remove` بردارد (PM فهرست را بدهد)                               |
| `/tmp`                                                             | ۷٫۶G                                        | صاحب هر پوشه‌ی موقت پاکش کند؛ مسیر Staging هرگز زیر `/tmp` نیست                                                    |
| Kafka ـِ توسعه (`rasta_kafka-data`)                                | ۳٫۴۹ GB؛ Retention فقط ۱۶۸ ساعت             | در PR جدا `KAFKA_LOG_RETENTION_BYTES` برای Compose توسعه (`docker-compose.yml:177`)                                |
| Containerهای Stack توسعه                                           | بی سقف (`docker-compose.yml:60-108` و بقیه) | سقف `mem_limit` در Compose توسعه — PR جدا، بیرون از RUN-002، با تصمیم PM                                           |
| Stack ـِ Demo (`rasta-demo`)                                       | Containerها خاموش، Volume Postgres ۰٫۶۲ GB  | تصمیم PM: Demo و Staging هم‌زمان روشن نمی‌شوند مگر M-1 جا را نشان دهد                                              |

### ۴. شبکه‌ی Deny پیش‌فرض روی یک میزبان (بند ۲)

**توپولوژی.** همه‌ی شبکه‌های Staging `internal: true` اند (بی Gateway، پس بی مسیر به بیرون)، جز دو استثنای نام‌برده. هر
Container فقط به شبکه‌هایی می‌پیوندد که جدول پایین برایش می‌گوید؛ این جدول از `services.json` (§ ۱) ساخته می‌شود و
`staging-policy` آن را با کلیدهای `*_SERVICE_URL` ـِ Env هر سرویس مقایسه می‌کند (منبع واحد: Env خود سرویس‌ها).

| شبکه                           | اعضا                                                                        | چرا                                                                                                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ingress` (نه internal)        | فقط `edge`                                                                  | Publish روی شبکه‌ی internal کار نمی‌کند؛ فقط Edge این شبکه را دارد                                                                                                                                        |
| `edge-web`، `edge-keycloak`    | `edge` با `web`؛ `edge` با `keycloak`                                       | مرورگر ← Edge ← پورتال یا مسیرهای عمومی Keycloak؛ پورتال ← Edge برای Issuer. دور ۱ این سه را روی یک شبکه می‌گذاشت و `web` بی Edge به `/admin` ـِ Keycloak می‌رسید                                         |
| `to-<svc>` (یکی برای هر سرویس) | سرویس `<svc>`، `api-gateway`، و فقط سرویس‌هایی که `<SVC>_SERVICE_URL` دارند | تماس سرویس‌به‌سرویس فقط به مقصدهای اعلام‌شده                                                                                                                                                              |
| `to-gateway`                   | `api-gateway`، `web`                                                        | پورتال فقط از سمت سرور Gateway را صدا می‌زند (`API_GATEWAY_URL`)                                                                                                                                          |
| `db-<svc>` (یکی برای هر سرویس) | سرویس `<svc>`، مهاجر یک‌بارمصرف همان سرویس، `postgres`                      | پایگاه داده فقط از سرویس خودش؛ `pg_hba` پایین                                                                                                                                                             |
| `db-keycloak`، `db-temporal`   | `postgres` با `keycloak`؛ `postgres` با `temporal`                          | پایگاه‌های زیرساختی، هرکدام با نقش خودش (نه Superuser، برخلاف `docker-compose.yml:242-243`، `:450-451`). دور ۱ هر دو را در یک `db-platform` داشت و Keycloak به `7233` ـِ Temporal (بی احراز هویت) می‌رسید |
| `kafka`                        | `kafka`، هر سرویس دارای `KAFKA_BROKERS`، ابزار یک‌بارمصرف Topic/ACL         | ACL هر Principal را محدود می‌کند (پایین)؛ تنها Listener ـِ این شبکه Broker است و Listener ـِ `EXTERNAL` (`:9092`) در Staging خاموش است (PR S5b)                                                           |
| `idp`                          | `keycloak`، همه‌ی سرویس‌ها (`OIDC_JWKS_URI`)، `web`                         | دریافت JWKS؛ API ادمین Keycloak فقط با اعتبار `identity-service` (`KEYCLOAK_URL`)                                                                                                                         |
| `cache`                        | `redis`، `api-gateway`، `fleet-service`، `web`                              | فقط سه مصرف‌کننده‌ی `REDIS_URL`/`WEB_REDIS_URL`؛ کاربر ACL ـِ Redis هرکدام با الگوی کلید خودش (`REDIS_KEY_PREFIX`، `packages/config/src/env.ts:547`)                                                      |
| `workflow`                     | `temporal`، `marketplace-service`، ابزار دروازه‌ی Saga                      | فقط مالک `TEMPORAL_ADDRESS`                                                                                                                                                                               |
| `objects`، `scan`              | `document-service` با `minio`؛ `document-service` با `clamav`               | کاربر MinIO ـِ سرویس با Policy همان Bucket، نه Root                                                                                                                                                       |
| `mail`                         | `notification-service`، Mailpit ـِ Staging                                  | SMTP به گیرنده‌ی محلی؛ هیچ ایمیل واقعی                                                                                                                                                                    |
| `updates` (نه internal)        | فقط `clamav-freshclam`                                                      | تنها Egress ـِ اینترنتی: Signatureها؛ Volume مشترک با `clamav` که خودش internal است                                                                                                                       |

ماتریس تماس سرویس‌ها امروز (از کلیدهای Env هر `services/*/src/config/env.ts`): asset ← document، fleet، maintenance؛
construction ← audit، identity، organization، supplier؛ contract ← construction، economic، organization؛ economic ← contract،
fleet، maintenance، organization؛ fleet ← asset، maintenance؛ identity ← audit و Keycloak؛ inventory ← marketplace؛
maintenance ← asset؛ marketplace ← economic، inventory، organization و Temporal؛ notification ← identity؛ procurement ←
supplier؛ Gateway ← همه. analytics، audit، document، organization و supplier هیچ تماس HTTP بیرونی ندارند.

**اجبار، نه فقط عضویت (r2).** عضویت در یک شبکه جهت ندارد: هر عضو به هر Listener ـِ عضو دیگر TCP باز می‌کند، و امروز هر ۱۷
سرویس روی همه‌ی Interfaceها گوش می‌دهد (`services/asset-service/src/main.ts:129`، `services/audit-service/src/main.ts:114`، و
همان `app.listen(env.PORT, '0.0.0.0')` در `main.ts` ـِ بقیه). پس ماتریس با چهار لایه اجبار می‌شود، که هر چهار بی root
ساختنی و وارسی‌پذیرند:

1. **جداسازی میان شبکه‌ها (Daemon).** دو Container بی شبکه‌ی مشترک هیچ مسیری به هم ندارند: شبکه‌ی internal Gateway ندارد و
   قواعد Docker هر بسته‌ی میان Bridgeها را می‌اندازد.
2. **درون شبکه‌ی مشترک فقط یک Listener.** هر سرویس فقط روی نشانی **خودش در `to-<svc>`** گوش می‌دهد: متغیر تازه‌ی
   `LISTEN_ADDRESS` جای `'0.0.0.0'` را در `main.ts` می‌گیرد (PR S1b)، با `NODE_ENV=staging` نبودنش = رد در بوت، و مقدارش نشانی
   ثابت (`ipv4_address`) همان Container در `services.json` است؛ `healthcheck` هم همان نشانی را می‌زند. `web` با
   `next start -H <نشانی در edge-web>`؛ Edge فقط روی نشانی‌هایش در `ingress` و `edge-web`؛ ابزارهای یک‌بارمصرف هیچ Listener
   ندارند. پس در `to-<svc>` تنها Listener خود `<svc>` است (فراخواننده‌ها به هم نمی‌رسند)، و در `idp`، `kafka`، `cache`،
   `workflow` و `db-<svc>` تنها Listener همان Hub.
3. **بی بسته‌ی خام.** `cap_drop: [ALL]` (§ ۳ بند ۱): بی `NET_RAW` و `NET_ADMIN`، عضو نه بسته‌ای به نشانی عضو دیگر در Subnet
   ـِ دیگرش می‌سازد (Linux آن را با مدل «Weak Host» می‌پذیرفت) و نه Route اضافه می‌کند. Image ـِ زیرساختی که Capability لازم
   دارد فقط همان‌ها را با نام می‌گیرد؛ `NET_RAW` و `NET_ADMIN` هرگز.
4. **Hub فقط پورت اعلام‌شده.** هر Listener ـِ دیگر Image ـِ زیرساختی — نمونه‌های شناخته: `EXTERNAL` ـِ Kafka (`:9092`؛
   Controller از پیش روی `127.0.0.1` است، `infrastructure/docker/kafka/broker-entrypoint.sh:75`)، Management ـِ Keycloak، پورت‌های
   داخلی Temporal (History، Matching، Membership)، Console ـِ MinIO، UI ـِ Mailpit — یا با پیکربندی بسته می‌شود، یا پس از M-5
   باقی‌مانده‌ی نام‌دار O-6 است.

**Subnet ـِ صریح.** این طرح ۴۶ شبکه دارد (۱۷ `to-*`، ۱۶ `db-<svc>`، ۲ `db-*` ـِ زیرساخت، `idp`، `kafka`، `cache`،
`workflow`، `edge-web`، `edge-keycloak`، `ingress`، `objects`، `scan`، `mail`، `updates`)؛ Pool ـِ پیش‌فرض Docker حدود ۳۰ شبکه
می‌دهد و مسیر خود میزبان بخشی از آن را گرفته است (§ Context). `pg_hba` هم Subnet ـِ ثابت می‌خواهد. پس هر شبکه
`ipam.config.subnet` ـِ صریح از یک بازه‌ی جدا دارد (پیشنهاد: `10.74.0.0/16`، هر شبکه `/27`)، و Preflight رد می‌کند اگر هر
Route ـِ میزبان (`ip -4 route`، بی root خوانا) یا شبکه‌ی Docker ـِ موجود با آن هم‌پوشانی داشته باشد.

**باقی‌مانده‌ی دسترسی هم‌تا — صریح، و چرا پذیرفتنی است:**

- **PostgreSQL ← Keycloak یا Temporal** روی `db-keycloak`/`db-temporal`: این دو روی همه‌ی Interfaceها گوش می‌دهند. فرایند
  PostgreSQL اتصال بیرون‌رونده نمی‌سازد مگر با Extensionی مثل `dblink` یا `postgres_fdw`؛ Bootstrap ـِ Staging نصب آن‌ها را رد
  می‌کند و Preflight `pg_extension` را می‌سنجد. پس این راه فقط با PostgreSQL ـِ به‌خطررفته باز است، که همه‌ی پایگاه‌ها را هم
  دارد.
- **سطح مسیر در Keycloak:** اعضای `idp` به پورت اعلام‌شده‌ی Keycloak می‌رسند، و این پورت API ادمین را هم دارد. احراز هویت
  لازم است و اعتبار ادمین فقط نزد `identity-service` است؛ Edge `/admin` را از بیرون می‌بندد.
- **هرچه M-5 بیابد** و با پیکربندی بسته نشود: فقط با تأیید مالک (O-6).

هر باقی‌مانده در `services.json` (`residuals`) با دلیل نوشته می‌شود و Probeهای § ۱۲ برای آن «دسترس‌پذیر» انتظار دارند؛ پس
باقی‌مانده‌ای که ناپدید شود یا تازه‌ای که پیدا شود، هر دو اختلاف‌اند و پذیرش را می‌شکنند.

**پایگاه داده.** یک Cluster ـِ PostgreSQL، ۱۶ پایگاه (ADR-005). شبکه‌ی `db-<svc>` هر سرویس Subnet خودش را دارد و
`pg_hba.conf` ـِ Staging فقط سطرهای `hostssl rasta_<svc> rasta_<svc>,rasta_<svc>_migrator <subnet db-<svc>> scram-sha-256` را
دارد و در پایان `host all all 0.0.0.0/0 reject`. پس سرویس دیگر حتی با گذرواژه‌ی درست از Subnet خودش به پایگاه دیگر وصل
نمی‌شود؛ `CONNECT` ـِ نقش‌ها هم از پیش محدود است (`docs/runbooks/database-bootstrap.md:67-69`). مهاجر فقط در پنجره‌ی Migration
`LOGIN` دارد (§ ۶).

**Kafka (RUN-006، ADR-061 § ۳).** Broker ـِ Staging همان `broker-entrypoint.sh` ـِ مشترک CI است، با `KAFKA_ACL_PROFILE=deployment`
و ACLهای `scripts/kafka-acl.mjs apply --profile deployment` (`scripts/kafka-acl.mjs:5`، `:30`)؛ Principalهای آزمون، Kafka UI و
Exporter در این پروفایل نیستند. CA ـِ Staging جدا و روی میزبان ساخته می‌شود (مثل `tls.sh`، هرگز Commit نمی‌شود). سرویس بی SASL
و TLS رد می‌کند (`connection.ts:113-120`)؛ PLAINTEXT فقط در `development`/`test` مجاز است (`packages/config/src/env.ts:573-586`) و
Staging با `NODE_ENV=staging` اجرا می‌شود. Listener ـِ Broker فقط روی شبکه‌ی `kafka` است و **هیچ پورتی Publish نمی‌شود** (برخلاف
`docker-compose.yml:183-184`).

**تماس سرویس‌به‌سرویس.** امروز توکن داخلی HS256 با راز مشترک (`INTERNAL_TOKEN_SECRET`، `packages/config/src/env.ts:562-564`؛ S-03؛ ADR-020) —
Staging راز یکتای خودش را دارد. mTLS داخلی که `docs/12:24` برای Staging می‌خواهد **نیست**؛ انحراف ثبت‌شده، تا ADR-020 پیاده
شود (O-6). شبکه و Listener ـِ مقید (بند «اجبار») دسترسی لایه‌ی ۴ را به مقصدهای اعلام‌شده محدود می‌کنند و توکن، هویت را؛ هیچ‌کدام جای دیگری را
نمی‌گیرد (`AGENTS.md:110` S-08).

**مرورگر ← Keycloak و TLS.** پورتال **یک** نشانی برای Issuer دارد و از آن هم Redirect ـِ مرورگر را می‌سازد
(`apps/web/src/app/auth/login/route.ts:34-42`، `apps/web/src/server/oidc.ts:32-39`) و هم در سمت سرور Token می‌گیرد
(`apps/web/src/app/auth/callback/route.ts:60`، `apps/web/src/server/session-refresh.ts:156`). پس:

- `edge` (Reverse Proxy با Image سنجاق‌شده) TLS را خاتمه می‌دهد و مسیرها را با فهرست سفید می‌فرستد: فقط
  `/realms/rasta/protocol/openid-connect/*`، `/realms/rasta/login-actions/*` و `/resources/*` به Keycloak؛ `/admin`، Realmهای
  دیگر، `/metrics` و `/health` ← ۴۰۴؛ بقیه به `web`. Gateway **Publish نمی‌شود** — مرورگر هرگز مستقیم آن را صدا نمی‌زند.
  (همین الگو در Demo ـِ محلی کار کرده است: `~/demo/README.md:18-27`.)
- نام میزبان Staging داخل شبکه‌ی `edge` به خود Edge Resolve می‌شود (`extra_hosts` با IP ثابت Edge)، و `web` گواهی Edge را با
  `NODE_EXTRA_CA_CERTS` می‌پذیرد؛ سرویس‌ها Issuer را فقط به‌عنوان رشته مقایسه می‌کنند و JWKS را از شبکه‌ی `idp` می‌گیرند
  (`OIDC_ISSUER_URL`/`OIDC_JWKS_URI`، `packages/config/src/env.ts:552-553`).
- Keycloak ـِ Staging با `start` (حالت Production) و Hostname ثابت اجرا می‌شود؛ Realm ـِ توسعه هرگز (`dev-realm-gate.sh`)؛
  `X-Forwarded-*` را Edge بازنویسی می‌کند.
- TLS: بیرونی در Edge (CA ـِ Staging یا گواهی O-2)؛ Kafka با SASL_SSL؛ PostgreSQL با `hostssl`؛ HTTP ـِ سرویس‌به‌سرویس درون
  شبکه‌ی internal بی TLS (همان انحراف mTLS).
- **ورودی پیش‌فرض بی DNS:** فقط تونل SSH ـِ خود آزماینده (`ssh -L <port>:127.0.0.1:<port> rasta-dev`) و یک سطر `hosts` روی
  ماشین آزماینده. Quick Tunnel ـِ Cloudflare برای Staging رد شد: نشانی‌اش با هر ری‌استارت عوض می‌شود و Issuer با آن
  (`~/demo/README.md:99-100`، `:108-110`). Tunnel نام‌دار با دامنه‌ی مالک گزینه‌ی O-2 است.

**DNS.** روی شبکه‌ی internal فقط نام Containerها معنا دارد؛ طراحی به Resolve نشدن نام بیرونی تکیه نمی‌کند — حتی اگر Resolve
شود، شبکه مسیری به بیرون ندارد. آزمون پذیرش (§ ۱۲) این را با اتصال TCP از درون هر Container به یک IP عمومی می‌سنجد.

**Egress — خلاصه.** بیرون‌رونده فقط: `clamav-freshclam` (شبکه‌ی `updates`) و `edge` (شبکه‌ی `ingress`، که بی Root نمی‌توان
Egress آن را بست؛ باقی‌مانده‌ی ثبت‌شده — Edge هیچ Secret جز کلید TLS ندارد). پرداخت Mock است و SMTP محلی؛ هیچ سرویس دامنه‌ای
Egress ندارد.

**پورت Publish‌شده و ufw.** Docker پورت Publish‌شده را با DNAT در `nat`/`PREROUTING` و زنجیره‌ی `DOCKER` ـِ `FORWARD`
می‌فرستد؛ بسته‌ی آن هرگز از `INPUT` ـِ ufw نمی‌گذرد، پس **ufw از پورت Publish‌شده‌ی Docker محافظت نمی‌کند**. تصمیم: **Bind به
`127.0.0.1`**، نه قاعده‌ی `DOCKER-USER` (که root می‌خواهد). Staging دقیقاً **یک** پورت Publish می‌کند: `127.0.0.1:14443` برای
`edge` (آزاد از پورت‌های توسعه، Demo و پایگاه‌های Worker که `ss -tlnH` نشان داد). `daemon.json` همین حالا `"ip": "127.0.0.1"`
دارد (پیش‌فرض Bind)، ولی `HostIp` ـِ صریح در Compose بر آن غلبه می‌کند؛ پس قاعده در خود فایل است و متغیری مثل
`COMPOSE_BIND_ADDRESS` (`docker-compose.yml:99`) در Staging **ممنوع** است.

**تأیید بی sudo:**

1. ایستا، در CI (PR S4b): `staging-policy` فایل Compose را Parse می‌کند و رد می‌کند اگر: هر `ports` با `host_ip` جز
   `127.0.0.1` یا بی آن؛ بیش از یک سرویس با `ports`؛ `network_mode: host` یا `container:`؛ `privileged`؛ نبود
   `cap_drop: [ALL]`؛ `cap_add` بیرون از فهرست همان Image در `services.json` (`NET_RAW`، `NET_ADMIN` و `SYS_ADMIN` هرگز)؛ هر
   Interpolation در `ports`؛ شبکه‌ای جز دو استثنا که `internal: true` نباشد؛ شبکه‌ی بی `ipam.config.subnet`؛ سرویسی که
   `LISTEN_ADDRESS` ـِ آن با `ipv4_address` ـِ خودش در `to-<svc>` برابر نیست؛ شبکه‌ی مشترکی که جز Hub ـِ خودش Listener ـِ
   اعلام‌شده‌ی دیگری داشته باشد.
2. زنده، روی میزبان، پس از هر استقرار: `docker inspect` همه‌ی Containerهای برچسب `com.rasta.environment=staging` ← هر
   `HostConfig.PortBindings[*].HostIp == "127.0.0.1"`؛ `docker network inspect` ← Subnet و نشانی هر Container برابر
   `services.json`؛ `ss -tlnH` ← هیچ Listener ـِ جدید روی `0.0.0.0` یا `[::]`؛ و Probeهای تولیدشده‌ی § ۱۲ بند ۱.
3. بیرونی، از ماشین مالک (بی root روی rasta-dev): پویش همه‌ی پورت‌های TCP نشانی عمومی میزبان؛ انتظار: فقط ۲۲.

**فرمان‌هایی که مالک (یا هر کسی که root یا پنل میزبانی دارد) اجرا می‌کند — هیچ‌کدام پیش‌نیاز گام‌های بی‌ریشه نیست:**

| فرمان                                                                        | کجا                | آنچه برنامه از خروجی لازم دارد                                                            |
| ---------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------- |
| `nmap -Pn -p 1-65535 <public-ip>` (یا `nc -vz -w3 <public-ip> 14443`)        | ماشین مالک         | فقط `22/tcp open`؛ هر پورت دیگر (به‌ویژه 14443) `closed`/`filtered` — **شاهد اصلی پذیرش** |
| بازبینی Firewall ـِ پنل میزبانی VM                                           | پنل میزبانی        | ورودی فقط 22 (و 443 فقط اگر O-2 Listener عمومی بخواهد)                                    |
| `sudo ufw status verbose`                                                    | rasta-dev، با root | `Default: deny (incoming)`؛ هیچ `ALLOW` جز `22/tcp`                                       |
| `sudo iptables -S DOCKER-USER` و `sudo iptables -t nat -S DOCKER`            | rasta-dev، با root | زنجیره هست؛ هیچ DNAT به `0.0.0.0` برای پروژه‌ی `rasta-staging`                            |
| `sudo apt-get install uidmap` و کاربر جدا برای Docker بی‌ریشه (اختیاری، O-5) | rasta-dev، با root | پیش‌شرط جداسازی واقعی (§ ۲ بند ۲)                                                         |

### ۵. Secret با مخزن عمومی (بند ۳)

1. **هیچ Secret ـِ Staging هرگز در Git نیست** (`docs/12:308-309`). مخزن فقط **نام** متغیرها و الگوی فایل‌ها را دارد
   (`services.json`)؛ هیچ مقدار پیش‌فرض، حتی «توسعه»، برای Staging نیست. فرمان‌های Staging با دیدن هر مقدار پیش‌فرض توسعه
   (`rasta_*_dev_password`، `admin_dev_password`، … — `docker-compose.yml:30-47`، `:72-96`، `:238-243`) **رد می‌کنند**.
2. **کجا:** `/home/rasta/staging/secrets/` (بیرون از هر Worktree؛ فرمان رد می‌کند اگر مسیر درون یک مخزن Git باشد)، پوشه `0700`، هر فایل `0600`، مالک `rasta`. یک فایل Env برای هر سرویس فقط با اعتبار **همان** سرویس
   (`env_file` ـِ همان سرویس)، و فایل‌های جدا برای مهاجرها، Superuser ـِ PostgreSQL، admin و `ops-replay` ـِ Kafka، ادمین
   Keycloak، Root ـِ MinIO و کلید TLS ـِ Edge — که فقط به Container ـِ یک‌بارمصرفی می‌رسند که لازمشان دارد (الگوی
   `x-kafka-bootstrap-env`، `docker-compose.yml:49-56`؛ اعتبار مهاجر هرگز در محیط سرویس، `db-role-split.md:151-158`).
3. **ساختن:** `scripts/staging/generate-secrets.mjs` (PR S5a) با `crypto.randomBytes(32)`، Base64url، با پیشوند ثابت
   `rstg_`؛ هرگز فایل موجود را بازنویسی نمی‌کند؛ هیچ مقدار را چاپ نمی‌کند (فقط نام). پیشوند، Secret ـِ نشت‌کرده را برای Gitleaks
   و Semgrep شناختنی می‌کند (بند ۶).
4. **چرخش (r2): یک فرمان Staging برای هر نوع، با Journal و بازگشت اثبات‌شده.** `rotate-role-passwords.bash` در Staging به کار
   نمی‌رود: همه‌ی گذرواژه‌ها را **پیش** از هر وارسی عوض می‌کند (`infrastructure/docker/postgres/lib/rotate-role-passwords.bash:61-68`)
   و سپس هر نقش را از `127.0.0.1` با TCP وارد می‌کند (`:89-96`)؛ `pg_hba` ـِ Staging فقط Subnet ـِ هر سرویس را می‌پذیرد و مهاجر
   `NOLOGIN` است، پس پس از نوشتن، با گذرواژه‌ی درست هم شکست می‌خورد (`:104-106`) و چیزی را برنمی‌گرداند. فرمان
   `rotate` ـِ Staging (PR S8d)، زیر قفل § ۱۴، **یک نقش در هر گام**:
   1. **آماده:** مقدار تازه در `<role>.next` (`0600`؛ هرگز روی فایل موجود)؛ Journal: `PREPARED`. فایل جاری دست نمی‌خورد.
   2. **نوشتن:** Superuser از Socket ـِ محلی درون Container ـِ `postgres` (`pg_hba` ـِ Staging فقط `local all <superuser> peer`
      دارد و پس از آن `local all all reject`)، SQL روی stdin مثل امروز (`:40-46`)؛ Journal: `CHANGED`، پیش از هر گام بعد.
   3. **وارسی، از همان مسیری که hba اجازه می‌دهد:** نقش اجرا با Container ـِ یک‌بارمصرف روی `db-<svc>` (Subnet ـِ همان سرویس)،
      `hostssl` و `SELECT 1` با مقدار تازه، و شکست مقدار قبلی. مهاجر **بی تغییر `LOGIN`**: Verifier ـِ ذخیره‌شده
      (`pg_authid.rolpassword`، `SCRAM-SHA-256$<iter>:<salt>$<StoredKey>:<ServerKey>`) با مقدار تازه، با همان Salt و Iteration،
      در خود فرمان محاسبه و دقیق مقایسه می‌شود؛ و `rolcanlogin` پیش و پس خوانده می‌شود و باید بی تغییر باشد. چرخش هرگز
      `LOGIN` ـِ مهاجر را عوض نمی‌کند؛ اگر مهاجری را بیرون از پنجره‌ی ثبت‌شده‌ی Migration با `LOGIN` بیابد، رد می‌کند (حالت
      ناشناخته، § ۱۴).
   4. **آشتی:** `cur` ← `<role>.prev` و `next` ← `cur` (Rename ـِ اتمی)؛ Journal: `FILES`؛ Recreate ـِ Container ـِ همان سرویس تا
      `env_file` دوباره خوانده شود، با مهلت § ۱۵ و Readiness؛ Journal: `ROTATED`. میان گام ۲ و این گام، اتصال‌های موجود Pool
      کار می‌کنند ولی اتصال تازه‌ی سرویس رد می‌شود؛ پس گام ۴ بی‌درنگ پس از وارسی است.
   5. **شکست پس از گام ۲ و پیش از `FILES`:** فایل جاری هنوز مقدار قبلی است؛ فرمان همان را دوباره می‌نویسد و با همان روش گام ۳
      **اثبات** می‌کند که مقدار قبلی کار می‌کند ← Journal: `ROLLED_BACK`، خروج ناصفر با «شکست؛ بازگشت اثبات‌شده». اگر نوشتن
      دوباره یا اثباتش شکست بخورد ← `UNRESOLVED`، خروج ناصفر با کد جدا، و § ۱۴ آن را عملیات ناتمام می‌بیند: هر فرمان دیگر رد
      می‌شود تا `rotate --resume`، که Verifier ـِ واقعی نقش را با `cur` و `next` مقایسه می‌کند، فایل منطبق را برمی‌گزیند و جلو یا
      عقب کامل می‌کند. پس گزارش چهار حالت جدا دارد: «چیزی عوض نشد» (شکست پیش از گام ۲)، «بازگشت اثبات‌شده»، `UNRESOLVED`، و
      `ROTATED`.
   6. **شکست پس از `FILES`** (Recreate یا Readiness): پایگاه و فایل هر دو مقدار تازه‌اند؛ فقط رو به جلو: Recreate ـِ دوباره.

   **همه‌ی هم‌خانواده‌ها همین قرارداد را دارند** (Journal، فایل `next`/`prev`، آشتی فایل و Env ـِ Container، و تمایز شکست از بازگشت
   اثبات‌شده): Kafka (`docs/runbooks/kafka-credential-rotation.md` امروز `docker compose exec kafka` ـِ پروژه‌ی توسعه را می‌زند،
   `:65-80`؛ در Staging از راه مرز § ۱۰ و روی شبکه‌ی `kafka`)؛ `INTERNAL_TOKEN_SECRET` (توکن حداکثر ۹۰۰ ثانیه زنده است،
   `packages/config/src/env.ts:564`؛ همه‌ی سرویس‌ها با مهلت § ۱۵ Recreate می‌شوند)؛ و Secret ـِ Clientهای Keycloak (API ادمین،
   سپس Recreate ـِ مصرف‌کننده). **آزمون (PR S8d):** روی Cluster ـِ یک‌بارمصرف با hba و `NOLOGIN` ـِ شکل Staging: مسیر کامل؛
   شکست تزریقی پس از نوشتن ← بازگشت اثبات‌شده؛ شکست تزریقی بازگشت ← `UNRESOLVED` و `--resume`؛ `kill -9` پس از `CHANGED` ←
   فرمان بعدی عملیات ناتمام را می‌بیند؛ در **هر** خروج `rolcanlogin` ـِ مهاجر برابر پیش از شروع؛ و هیچ مقدار در stdout، stderr یا
   argv (Recorder). **محرک:** گمان نشت، رفتن عضو تیم، یا هر بار که فایل Secret در Log/خروجی دیده شد؛ دوره‌ی زمانی تصمیم O-4
   است (عددی جعل نمی‌شود).

5. **CI هرگز Secret ـِ Staging نمی‌بیند:** هیچ GitHub Secret برای Staging، هیچ Job ـِ Deploy، هیچ کلید SSH در GitHub، و **هیچ
   Self-hosted Runner روی این میزبان** (روی مخزن عمومی، Runner ـِ میزبان کد PRهای Fork را روی همین ماشین اجرا می‌کرد).
   استقرار **Pull** است: اپراتور روی میزبان فرمان استقرار را با Manifest ـِ انتشار اجرا می‌کند (§ ۷). Job ـِ انتشار فقط
   `GITHUB_TOKEN` با `packages: write` دارد. این انحراف از «خودکار از `main`» ـِ `docs/12:17`، `:248` است و ثبت می‌شود.
6. **نگهبان‌ها:** Gitleaks روی PR (`ci.yml:441-444`) و Semgrep با `p/secrets` (`ci.yml:475-480`) **پس از Push** می‌بینند؛ روی
   مخزن عمومی، Push یعنی انتشار. پس کنترل اصلی پیشگیرانه است (بند ۲: فایل بیرون از Worktree)، و نگهبان‌ها لایه‌ی دوم‌اند: PR S5a
   یک قاعده‌ی `.gitleaks.toml` (Extend ـِ پیش‌فرض) و یک قاعده‌ی Semgrep برای `rstg_[A-Za-z0-9_-]{43}` اضافه می‌کند، به‌اضافه‌ی
   آزمونی که نمونه‌ی ساختگی را تشخیص دهد. **نشت = چرخش فوری**؛ بازنویسی تاریخچه جایگزین چرخش نیست. Runbook ـِ
   `secret-leak.md` که `docs/12:352` به آن پیوند می‌دهد وجود ندارد؛ PR S10a آن را می‌نویسد.
7. **باقی‌مانده:** `docker inspect` Env ـِ Container را به هر عضو `docker` نشان می‌دهد؛ طبق § ۲ پذیرفته است و دلیل دیگری
   است که داده‌ی واقعی اینجا نمی‌آید.

### ۶. Migration: نقش اجرا و مالک در Staging (بند ۴)

1. **دو اعتبار برای هر سرویس** (D-045، `db-role-split.md:250-259`): مهاجر فقط برای Job ـِ Migration، نقش اجرا فقط برای سرویس.
   Bootstrap ـِ Staging همان `service-privilege-split.bash` را با گذرواژه‌های صریح اجرا می‌کند؛ `RASTA_DB_BOOTSTRAP=compose` و
   پیش‌فرض‌های توسعه در Staging نیستند (`docker-compose.yml:75-79`). مهاجر `CREATEDB` ندارد (`:257`).
2. **Artifact ـِ Migration.** هدف تازه‌ی `migrate` در Dockerfile هر سرویس (PR S2b)، از **همان** Stage ـِ `build` و همان Commit:
   Prisma CLI، `prisma/` و `scripts/prisma.mjs`؛ Digest جدا در همان Manifest (§ ۷). Container ـِ مهاجر فقط به `db-<svc>` می‌پیوندد
   و فقط `DATABASE_URL_<SVC>_MIGRATOR` را دارد.
3. **پنجره‌ی مهاجر.** بیرون از Migration، نقش مهاجر `NOLOGIN` است؛ فرمان استقرار با Superuser ـِ Staging آن را برای همان
   سرویس `LOGIN` می‌کند، Migration را اجرا می‌کند، و در هر نتیجه دوباره `NOLOGIN` می‌کند. (D-047 را نمی‌بندد؛ زمانِ کارایی
   اعتبار نشت‌کرده را کوتاه می‌کند.) **در هر خروج:** Journal ـِ § ۱۴ پیش از `LOGIN` حالت `MIGRATOR_OPEN <svc>` را ثبت می‌کند؛
   خروج عادی، شکست و سیگنال `NOLOGIN` را برمی‌گردانند و `rolcanlogin = false` را دوباره می‌خوانند؛ و اگر فرایند بی فرصت بمیرد
   (`kill -9`، قطع برق)، نخستین فرمانی که قفل را می‌گیرد پیش از هر کار دیگر همان مهاجر را `NOLOGIN` می‌کند و می‌خواند.
4. **ترتیب: Migrate، سپس Deploy، برای هر سرویس، همه زیر یک قفل (§ ۱۴) که پیش از Preflight گرفته می‌شود:** (الف) Preflight (§ ۳: حافظه، دیسک و رزرو Pull/Backup)؛ (ب) `pg_dump -Fc` پایگاه همان سرویس
   (Backup روزانه‌ی Staging، `docs/12:27`، و پیش از هر Migration)؛ (ج) Migration با Container ـِ `migrate`؛ (د)
   `check:db-runtime-privileges` با نقش فقط‌خواندنی Catalogue (`db-role-split.md:259`) — یافته = توقف؛ (هـ) Recreate ـِ
   Container ـِ سرویس با Digest ـِ تازه؛ (و) Readiness و Smoke. Migration باید سازگار به عقب باشد؛ تغییر شکننده فقط
   Expand/Contract در سه انتشار (`docs/12:277-278`، `:365-366`). Migrationهای سرویس‌ها مستقل‌اند (پایگاه جدا، ADR-005)؛ انتشار
   سرویس به سرویس جلو می‌رود و **با نخستین شکست کل انتشار می‌ایستد**. این ترتیب دو انتشار هم‌زمان را رد **نمی‌کند**؛ قفل § ۱۴ می‌کند.
5. **Migration ـِ شکست‌خورده:** سرویس روی Image ـِ قبلی می‌ماند (Recreate هنوز نشده؛ کد قبلی با Schema ـِ قبلی کار می‌کند).
   Prisma ردیف ناتمام را نگه می‌دارد و هر `migrate deploy` بعدی با `P3009` رد می‌شود (`database-bootstrap.md:169-171`). بازیابی
   فقط طبق Runbook ـِ همان Migration، یا روند عمومی `db-role-split.md:57-77`: سرویس متوقف یا روی نسخه‌ی قبلی، بررسی ردیف
   (`finished_at IS NULL AND rolled_back_at IS NULL`)، اثبات Rollback ـِ تراکنش با مقایسه‌ی ACL با Snapshot ـِ پیش از استقرار، سپس
   `migrate resolve --rolled-back` و اجرای دوباره. **هرگز `--applied`** و هرگز `migrate reset` (`database-bootstrap.md:115`).
   Snapshot ـِ ACL (`scripts/db-acl-snapshot.sql`) پیش از هر Migration گرفته و بیرون از مخزن نگه داشته می‌شود.

### ۷. منشأ تصویر (بند ۵)

**فهرست Deployableها — همه، با یک Commit:**

| Deployable                                                                           | امروز                                                             | در Staging                                                                                                                                         |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| ۱۷ سرویس، `api-gateway` هم                                                           | Dockerfile دارند؛ Build و Scan بی Push                            | Publish با Digest                                                                                                                                  |
| `apps/web` (پورتال)                                                                  | **Dockerfile ندارد**؛ در فهرست تصویرها نیست                       | Dockerfile تازه (`next build` و `next start`، کاربر غیرریشه) — PR S2a                                                                              |
| Migration هر سرویس                                                                   | فقط از ریشه‌ی مخزن                                                | هدف `migrate` (§ ۶)                                                                                                                                |
| Bootstrap (init ـِ PostgreSQL، اسکریپت‌ها و ACL ـِ Kafka، Topicها، Realm ـِ Staging) | فایل‌های مخزن که Mount می‌شوند (`docker-compose.yml:102`، `:143`) | تصویر `staging-bootstrap` از همان Commit — بی Mount ـِ مخزن، پس Staging به Worktree ـِ هیچ‌کس وابسته نیست                                          |
| زیرساخت (postgis، redis، kafka، keycloak، minio، temporal، clamav، Edge، Mailpit)    | با Digest سنجاق‌اند (`docs/12:66-67`)                             | همان Digestها؛ `check-dockerfile-pins` باید فایل Staging را هم بخواند (`scripts/check-dockerfile-pins-lib.mjs:122` امروز فقط `docker-compose.yml`) |

`container-scope-lib.mjs` امروز فقط `services/*/Dockerfile` را می‌یابد (`:24-26`)؛ PR S2a فهرست را از **همه‌ی** Dockerfileهای
Deployable (`services/*`، `apps/web`، `infrastructure/staging/bootstrap`) می‌سازد و آزمونی می‌گذارد که هر ورودی `services.json`
تصویری در Matrix داشته باشد — همان درسی که سه سرویس جاافتاده دادند (`ci.yml:4635-4639`).

**انتشار فقط از `main`:**

1. Train (`mq/train-*`) و PR تصویر متأثر را می‌سازند و می‌سنجند (W#8 828) ولی **هرگز Publish نمی‌کنند**: اجرای Train یک رویداد
   `pull_request` است و ممکن است رد شود.
2. Job ـِ تازه‌ی `publish` (PR S3) فقط با `github.event_name == 'push' && github.ref == 'refs/heads/main'`، پس از همه‌ی دروازه‌ها
   (همان `needs` ـِ Job `containers`، `ci.yml:4621`)، برای **همه‌ی** Deployableها (`--all`)؛ هر شرط دیگری = بی Publish.
3. Registry: **GHCR** (`ghcr.io/<owner>/rasta-<name>`)، **عمومی** (کد عمومی است؛ هیچ Secret در Image نیست، `docs/12:105-106`)،
   پس میزبان بی اعتبار Registry Pull می‌کند. Docker Hub (حساب و توکن جدا) و Registry ـِ محلی روی میزبان (CI باید به میزبان Push
   کند ← دسترسی ورودی و اعتبار در CI) رد شدند. Package خصوصی GHCR گزینه‌ی O-4 است و آنگاه میزبان یک توکن فقط‌خواندنی می‌خواهد.
4. **Push با Digest، Scan همان Digest:** تصویر بی Tag ـِ متحرک Push می‌شود؛ Trivy همان `ghcr.io/…@sha256:<digest>` را از Registry
   می‌سنجد (نه تصویر محلی دیگری) و خروجی JSON و SARIF را نگه می‌دارد. برچسب OCI ـِ `org.opencontainers.image.revision` = SHA.
5. **Manifest ـِ انتشار** (`release-<sha>.json`، Artifact ـِ همان اجرا): SHA ـِ Commit، شماره‌ی اجرای CI، و برای هر Deployable نام،
   Digest، خلاصه‌ی Scan (شمار بر شدت و شناسه‌ی CVEهای پذیرفته با `.trivyignore.services` و انقضایشان) و Digest ـِ Attestation.
   Publish، Digest و Scan به **یک** Commit گره خورده‌اند؛ Manifestی که یکی را نداشته باشد ناقص و غیرقابل‌استقرار است.
6. **Staging فقط با Digest Pull می‌کند:** `compose.yml` ـِ Staging Image را فقط به شکل `…@sha256:` می‌پذیرد (`staging-policy`)؛
   فرمان استقرار Manifest را می‌خواند و Digestی را که در Manifest ـِ موفق نیست، یا Scan ـِ ناموفق دارد، رد می‌کند.

**امضا/Attestation — گزینه و هزینه:** GitHub Artifact Attestations (`actions/attest-build-provenance`، Provenance ـِ SLSA، بی
مدیریت کلید)؛ هزینه: یک گام برای هر تصویر در `publish`، مجوزهای `id-token: write` و `attestations: write` فقط در همان Job، و
بررسی در هر استقرار (`gh attestation verify oci://…@sha256:… --repo <owner>/RASTA`، یا آفلاین با `--bundle` ـِ ذخیره در
Manifest). ورودی Transparency Log عمومی است — برای مخزن عمومی چیزی بیش از Commit و Workflow فاش نمی‌کند. cosign با کلید خودمان رد
شد (مدیریت کلید روی همین میزبان مشترک). پیشنهاد: **اجباری** برای معیار «image provenance operationally verified»؛ تصمیم O-4.

### ۸. Rollback (بند ۶)

1. **کد:** `staging-rollback <release-manifest قبلی>` همان Digestهای قبلی را Recreate می‌کند؛ Schema می‌ماند (سازگار به عقب،
   `docs/12:365`). Image ـِ انتشار قبلی تا انتشار بعدی روی دیسک می‌ماند (M-2).
2. **Down-migration** فقط وقتی کد قبلی با Schema ـِ تازه کار نکند — که Expand/Contract آن را منع می‌کند؛ پس در عمل فقط برای
   بازگرداندن یک Expand ـِ معیوب. فقط با مسیر پشتیبانی‌شده: مهاجر، `psql -X -v ON_ERROR_STOP=1 --single-transaction --file …/down.sql`،
   از جدیدترین به قدیمی‌ترین، توقف با نخستین شکست (`database-bootstrap.md:119-159`). `down.sql`ی که با وجود داده رد می‌کند
   (مثلاً baseline ـِ analytics، `db-role-split.md:43`) **رد می‌ماند**؛ دور زدن ندارد.
3. **Saga ـِ marketplace (D-053):** هر انتشار یا Rollback که Image ـِ `marketplace-service` را عوض کند — در **هر** جهت — توالی
   حصاردار را اجرا می‌کند (`marketplace-saga-deploy.md:25-35`): Migration؛ توقف **همه‌ی** نمونه‌ها (`stop` با مهلت کامل § ۱۵، نه
   Recreate ـِ تدریجی؛ نه `MARKETPLACE_TEMPORAL_ENABLED=false`)؛ `scripts/marketplace-saga-drain-check.mjs` از Container ـِ
   یک‌بارمصرف روی شبکه‌ی `workflow`؛ فقط کد `0` ادامه می‌دهد. کد `1` (Poller یا Activity ـِ در انتظار) و کد `2` (بررسی ناممکن،
   پاسخ ناشناخته) **استقرار را می‌بندند**؛ استثنا ندارد. هرگز `terminate` یا `reset` ـِ Workflow: وجه در Hold می‌ماند (`:83-88`).
4. **آنچه برنمی‌گردد:** رویدادی که نسخه‌ی تازه منتشر کرده و Consumerها پردازش کرده‌اند؛ تغییر Config ـِ Topic (اسکریپت فقط سقف
   را بالا می‌برد، `docs/12:285-291`) و ACL؛ تغییر Realm ـِ Keycloak؛ Migrationی که `down` ـِ آن رد می‌کند یا بازگشت‌ناپذیر
   مستند شده (`docs/12:366-371`)؛ تعمیر ACL ـِ D-045 (`db-role-split.md:122-123`)؛ Workflowی که نسخه‌ی تازه آغاز کرده (بند ۳).
   اثر بیرونی ندارد: پرداخت Mock و ایمیل محلی است.
5. **اثبات در Staging (PR S9c):** تمرین Rollback ـِ ثبت‌شده: انتشار N ← انتشار N+1 با دست‌کم یک Migration ← Smoke ← Rollback به
   Digestهای N ← Smoke، `check:db-runtime-privileges`، ردیف‌های `_prisma_migrations` همان پس از N+1 (Rollback ـِ کد به Schema دست نمی‌زند و کد N با آن کار می‌کند)، و تراز دفتر کل با پرس‌وجوهای
   `scripts/backup-restore-drill-lib.mjs`. و تمرین Migration ـِ شکست‌خورده، روی نخستین Bootstrap یا پایگاه Scratch ـِ Staging، با امتناعی که از پیش در کد هست: Migration ـِ
   `20261024130000_analytics_runtime_privileges` با اتصالی جز مهاجر `42501` می‌گیرد (`db-role-split.md:57-58`) ← `P3009` ←
   بازیابی همان Runbook.

### ۹. دامنه‌ی بازیابی: PostgreSQL به‌تنهایی بازیابی توزیع‌شده نیست

تمرین موجود فقط PostgreSQL را، بی نویسنده‌ی فعال، ثابت می‌کند و Offsetهای Kafka، سازگاری Snapshot ـِ توزیع‌شده و بازیابی کل
سامانه را صریحاً بیرون می‌گذارد (`backup-restore-drill.md:95-102`، `:182-185`). Restore ـِ Staging (Runbook در PR S10b؛ اثبات کامل در
RUN-003):

1. پیش از Restore: **همه‌ی** سرویس‌ها متوقف — Publisherهای Outbox، Consumerها، Workerها و زمان‌بندها؛ Saga طبق § ۸ بند ۳.
2. پس از Restore، Publisherها **متوقف می‌مانند** تا تصمیم آشتی (همان `backup-restore-drill.md:86-87`: «restored outboxes never
   publish»).
3. **Kafka سالم، پایگاه به عقب رفته:** Offset ـِ گروه‌ها جلوتر از وضعیت بازیابی‌شده است؛ رویدادهای پنجره‌ی از دست رفته دوباره
   تحویل نمی‌شوند مگر Offset به زمانی پیش از Backup برگردد (`kafka-consumer-groups --reset-offsets --to-datetime` با `ops-replay`
   یا admin). تکرار تحویل را `processed_event` ـِ هر Consumer (نگهداری ۳۰ روز) می‌گیرد؛ Topic فقط ۷ روز می‌ماند
   (`docker-compose.yml:177`؛ `docs/07` §§ ۷٫۲، ۷٫۵) — Backup ـِ قدیمی‌تر از Retention یعنی رویدادی که دیگر نیست.
4. **Outbox ـِ بازیابی‌شده** ردیف‌هایی دارد که پیش از Backup منتشر شده ولی «ارسال‌شده» ثبت نشده بودند ← انتشار دوباره ← تحویل
   تکراری که Consumerها با شناسه‌ی رویداد کنار می‌گذارند.
5. **Kafka از دست رفته:** Outbox فقط رویداد منتشرنشده را دارد؛ رکوردی که Broker پذیرفته و Consumer نخوانده بود گم است
   (`docker-compose.yml:194-196`).
6. پس از آشتی: تراز دفتر کل (پرس‌وجوهای تمرین) و `check:db-runtime-privileges`، سپس Publisherها.

### ۱۰. جداسازی از توسعه و آزمون روی همین میزبان (بند ۷)

| سطح           | Staging                                                                             | Stack ـِ توسعه / آزمون                                                                   |
| ------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| پروژه         | `rasta-staging`، همیشه با `-p` و `--file` صریح                                      | `rasta` (`docker-compose.yml:13`)؛ Demo `rasta-demo`                                     |
| نام Container | **بی `container_name`**؛ Prefix ـِ پروژه                                            | `rasta-*` ثابت                                                                           |
| Volume/شبکه   | `rasta-staging_*`، با برچسب `com.rasta.environment=staging`                         | `rasta_*`، `rasta-demo_*`، Testcontainers                                                |
| پورت          | فقط `127.0.0.1:14443`                                                               | 5432، 6379، 9092، 7233، 8080، 9000-9003، 3310، 1025، 8025؛ Demo 13xxx-19xxx؛ Worker 55xx |
| Kafka         | `CLUSTER_ID` با پیشوند `rasta-staging-`؛ پروفایل `deployment`                       | `rasta-local-cluster-000001`؛ پروفایل `development`                                      |
| Keycloak      | Realm ـِ Staging، **بی** `rasta.disposable_stack`؛ برچسب `rasta.staging_stack=true` | Realm ـِ توسعه با `rasta.disposable_stack=true`                                          |
| PostgreSQL    | **بی** `rasta.disposable_database`؛ `NODE_ENV=staging`                              | نشان یک‌بارمصرف از Bootstrap                                                             |
| Secret        | `/home/rasta/staging/secrets/`                                                      | `.env`، `.env.migrator` در Worktree                                                      |
| کاربر/Daemon  | **همان** `rasta` و همان Daemon — محدودیت § ۲                                        | همان                                                                                     |

**نگهبان‌ها — همه‌ی هم‌خانواده‌ها وارسی شد** (هرکدام که بی‌تغییر از Staging دفاع نمی‌کند، PR S7a یا S7b آن را می‌بندد و آزمون منفی می‌گذارد):

| #   | نگهبان / مسیر                                                                                       | وضعیت در برابر Staging روی همین میزبان                                                                                                     | اقدام                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Seed (`packages/config/src/seed-guard.ts:10-22`)                                                    | `staging` را رد می‌کند و نشان پایگاه را می‌خواهد؛ پایگاه Staging نشان ندارد                                                                | آزمون منفی: Seed با `NODE_ENV=test` و `RASTA_ALLOW_DEMO_SEED=true` روی پایگاه شکل Staging ← رد                                           |
| 2   | نشان یک‌بارمصرف پس از Restore (`disposable-marker.bash:24-27`؛ `docs/deployment/README.md:293-297`) | Dump ـِ توسعه نشان را به Cluster ـِ Staging می‌برد                                                                                         | Preflight ـِ استقرار و Restore ـِ Staging: هر پایگاه با `rasta.disposable_database` ← توقف؛ Restore آن را `RESET` می‌کند                 |
| 3   | Broker (`scripts/disposable-broker.mjs:25-35`)                                                      | فقط به Flag ـِ فراخواننده اعتماد می‌کند                                                                                                    | Broker ـِ Staging از میزبان در دسترس نیست (بی Publish)؛ نگهبان پیش از هر تغییر `CLUSTER_ID` را می‌خواند و `rasta-staging-*` را رد می‌کند |
| 4   | E2E (`tests/e2e/src/target-guard.ts:13-25`، `:29-41`)                                               | «Loopback = یک‌بارمصرف» روی این میزبان نادرست است: Edge ـِ Staging روی `127.0.0.1` است؛ دفاع فقط نشان Realm است                            | آزمون منفی: Realm ـِ بی نشان رد می‌شود؛ رد صریح Realm با `rasta.staging_stack`                                                           |
| 5   | هر Launcher ـِ Docker ـِ مخزن (فهرست کامل پایین)                                                    | `COMPOSE_PROJECT_NAME`/`COMPOSE_FILE`/`DOCKER_CONTEXT` در Shell هدف را عوض می‌کند ← `down`، `down -v`، نوشتن در پایگاه، یا Log روی Staging | مرز واحد انتخاب هدف (پایین) برای **همه**، نه فقط `infra-preflight`                                                                       |
| 6   | تمرین Backup (`backup-restore-drill.md:18-20`، `:160-161`)                                          | پروژه‌ی یکتا، `.env` را رد می‌کند، Stack ـِ مشترک را Reset نمی‌کند                                                                         | بی تغییر؛ Backup ـِ Staging ابزار جداست                                                                                                  |
| 7   | Kafka ACL (`scripts/kafka-acl.mjs`)                                                                 | `--profile development` روی Broker ـِ Staging Principalهای آزمون را باز می‌کرد                                                             | admin ـِ Staging فقط در فایل Secret ـِ Staging؛ Broker ـِ Staging از میزبان در دسترس نیست                                                |
| 8   | `docker system prune --volumes` / `docker volume prune` (عادت اپراتور، نه در مخزن)                  | Volume ـِ Containerهای حذف‌شده پاک می‌شود                                                                                                  | Staging با `stop` خاموش می‌شود نه `down`؛ قاعده‌ی برگه‌ی PM: Prune فقط با `--filter label!=com.rasta.environment=staging`                |
| 9   | آزمون‌های محلی Worker (Testcontainers، `wN-*`)                                                      | نام و پورت جدا؛ هیچ‌کدام Staging را نمی‌شناسد                                                                                              | قاعده‌ی PM: هیچ `docker rm`/`stop` با الگو؛ فقط نام خود Worker                                                                           |
| 10  | **وارونه:** فرمان‌های Staging روی توسعه                                                             | —                                                                                                                                          | همان مرز، با محیط مورد انتظار `staging`                                                                                                  |
| 11  | `infrastructure/docker/kafka/ci-up.sh:36`، `:112`                                                   | `KAFKA_CONTAINER_NAME` هر نامی را می‌پذیرد و `docker rm -f` ـِ بی‌شرط آن را حذف می‌کند                                                     | همان مرز: نام فقط `rasta-ci-kafka` یا با پسوند، و Container ـِ موجود فقط با برچسب `com.rasta.environment=ci` که خود اسکریپت می‌گذارد     |

**مرز واحد انتخاب هدف (r2).** دور ۱ فقط `infra-preflight` را سخت می‌کرد، که فقط پیش از `infra:up` و `infra:reset` اجرا می‌شود
(`package.json:112`، `:114`) و امروز هیچ متغیر `COMPOSE_*` را نمی‌سنجد؛ `infra:down` (`:113`)، `infra:logs` (`:115`)، سه
فرمان `db:*` (`package.json:119-121`، از راه `scripts/postgres-exec.bash:25`)، `db:mark-disposable` (`package.json:122`) و `ci-up.sh` (که
`KAFKA_CONTAINER_NAME` را بی هیچ شرطی می‌پذیرد و `docker rm -f` می‌کند، `infrastructure/docker/kafka/ci-up.sh:36`، `:112`) از آن
نمی‌گذشتند. تصمیم: **یک** ماژول، `scripts/docker-target.mjs` (PR S7a)، تنها راه هر Launcher ـِ مخزن به اثر Docker است:
اسکریپت‌های `package.json` به شکل `node scripts/docker-target.mjs <launcher> -- …` درمی‌آیند و اسکریپت‌های Bash (`ci-up.sh`،
`postgres-exec.bash`) پیش از نخستین اثر، `docker-target.mjs check <launcher>` را می‌زنند. هر Launcher یک «محیط مورد انتظار»
دارد (`development`، `ci`، `staging`، یا «مال همین اجرا») و ماژول **پیش از هر اثر**، فقط با خواندن، می‌سنجد:

1. **محیط فراخوان:** `DOCKER_HOST` یا `DOCKER_CONTEXT` ـِ غیرپیش‌فرض ← رد. Launcher ـِ توسعه با `COMPOSE_PROJECT_NAME` یا
   `COMPOSE_FILE` ← رد. فرمان‌های Staging `-p`، `--file` و `--env-file` را صریح می‌دهند و فرزند Docker را با Env ـِ پاک‌شده (فقط
   `PATH` و `HOME`) اجرا می‌کنند، تا هیچ `COMPOSE_*` ـِ ارثی اثر نکند.
2. **پیکربندی مؤثر:** `docker compose config --format json` با **همان** Flagها و Env ـِ اثر، فقط در حافظه Parse می‌شود: `name`
   برابر پروژه‌ی مورد انتظار (`rasta` یا `rasta-staging`)، فایل‌ها برابر مسیرهای مورد انتظار، و در Staging هر سرویس، شبکه و
   Volume با برچسب `com.rasta.environment=staging`.
3. **برچسب زنده:** هر Container، شبکه و Volume که پیکربندی مؤثر نام می‌برد — و برای `down`/`rm` هر منبعی با
   `com.docker.compose.project=<name>` — باید `com.rasta.environment=<محیط مورد انتظار>` داشته باشد. Launcher ـِ توسعه منبع با
   برچسب `staging` را هرگز لمس نمی‌کند؛ منبع ـِ بی‌برچسب پروژه‌ی `rasta` (قدیمی‌تر از S7a) برای توسعه پذیرفته است و Compose ـِ
   توسعه از S7a به بعد برچسب `development` می‌گذارد.
4. **Bind Mount:** هر مسیر میزبان در پیکربندی مؤثر: برای Staging فقط زیر `/home/rasta/staging/`، با مالک همین کاربر، `0700`، و
   نشان `.rasta-environment` با محتوای `staging`؛ برای توسعه، هرگز زیر `/home/rasta/staging/`.

**نخستین ساختن.** `up` ـِ Staging روی منبع **غایب** پیش می‌رود: Compose شبکه، Volume و Container را با برچسب‌های فایل می‌سازد
(که `staging-policy` بودنشان را تضمین کرده است) و پوشه‌ی Bind ـِ غایب را `up` با `0700` و نشان می‌سازد. منبع **موجود** با همان
نام ولی بی برچسب، با برچسب دیگر، با پروژه‌ی Compose ـِ دیگر، یا شبکه‌ی هم‌نام با Subnet ـِ دیگر ← رد («تعارض»)؛ هیچ منبعی
«پذیرفته» (Adopt) نمی‌شود. پس از ساختن، همان چهار وارسی دوباره اجرا می‌شود و تنها پس از آن نخستین اثر بعدی (Bootstrap،
Migration).

**Launcherهای «مال همین اجرا»** نام‌ها را خودشان با تصادف یا PID می‌سازند: تمرین Backup (پروژه‌ی `restore-drill-<random>` با
`--file` ـِ صریح، `scripts/backup-restore-drill.mjs:203`، `:347`)، شاهد Aggregation (`scripts/aggregation-evidence.mjs:190`،
`:420`) و Grafana ـِ زنده (`scripts/verify-grafana-dashboard-live.mjs:292`، `:351`). نامشان با Staging برابر نمی‌شود؛ فقط وارسی
۱ را می‌گیرند و ماژول نامی را که با `rasta-staging` آغاز شود رد می‌کند.

**افشا:** ماژول فقط کد دلیل ثابت و **نام** منبع را چاپ می‌کند؛ هرگز پیکربندی مؤثر، مقدار Env، خروجی خام `inspect`، یا stderr
ـِ `docker`/`compose` را (گرفته و دور ریخته می‌شود و یک کد جایش می‌نشیند) — § ۱۳.

**فهرست کامل Launcherها** (`git grep` ـِ فراخوانی `docker`/`docker compose` در همه‌ی مخزن جز `docs/`، Workflowهای CI که روی
Runner ـِ GitHub اجرا می‌شوند، و `docker` ـِ ساختگی آزمون‌ها مثل `scripts/session-statement-timeout.test.mjs:183-190`):

| Launcher                                                                           | جا                                                                     | اثر                    | محیط مورد انتظار                            |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------- | ------------------------------------------- |
| `infra:up`، `infra:reset`                                                          | `package.json:112`، `:114`                                             | ساختن، حذف، حذف Volume | `development`                               |
| `infra:down`                                                                       | `package.json:113`                                                     | حذف Container و شبکه   | `development`                               |
| `infra:logs`                                                                       | `package.json:115`                                                     | افشای Log              | `development`                               |
| `db:rotate-role-passwords`، `db:supplier-privilege-split`، `db:privilege-split`    | `package.json:119-121` ← `scripts/postgres-exec.bash:25`               | نوشتن در پایگاه        | `development`                               |
| `db:mark-disposable`                                                               | `package.json:122`                                                     | نوشتن نشان در پایگاه   | `development`                               |
| `ci-up.sh`                                                                         | `infrastructure/docker/kafka/ci-up.sh:107`، `:112-113`، `:124`، `:139` | `rm -f`، `run`، `exec` | `ci`                                        |
| تمرین Backup، شاهد Aggregation، Grafana ـِ زنده                                    | بالا                                                                   | منابع خودشان           | مال همین اجرا                               |
| فرمان‌های Staging (`up`، `stop`، `deploy`، `rollback`، `rotate`، `restore`، Probe) | PR S8a–S8d، S9a                                                        | همه                    | `staging`                                   |
| فرمان‌های چاپی Runbookها (مثلاً `kafka-credential-rotation.md:65-80`، `:119`)      | `docs/runbooks/`                                                       | دستی                   | فقط توسعه؛ Staging فقط با فرمان‌های Staging |

PR S7a برای **هر** سطر آزمون منفی دارد: Env رو به Staging (`COMPOSE_PROJECT_NAME=rasta-staging`، `COMPOSE_FILE` ـِ Staging،
`DOCKER_CONTEXT` ـِ دیگر، `KAFKA_CONTAINER_NAME` = نام Broker ـِ Staging، و Container ـِ با برچسب `staging` به نام توسعه) ← رد پیش
از هر اثر، با `docker` ـِ ضبط‌کننده‌ای که فقط خواندن (`compose config`، `inspect`، `ps`) را می‌پذیرد؛ و یک آزمون جاروب: همان
`git grep` باید دقیقاً با فهرست ثبت‌شده در ماژول برابر باشد، پس Launcher ـِ تازه‌ای که از مرز نگذرد CI را قرمز می‌کند.

### ۱۱. پیکربندی هم‌شکل Production (کلاس `NODE_ENV`)

Staging با `NODE_ENV=staging` اجرا می‌شود (`packages/config/src/env.ts:24`)، تا Seed (`packages/config/src/seed-guard.ts:12-16`) و PLAINTEXT ـِ Kafka
رد شوند. ولی چند کنترل امروز فقط `production` را می‌شناسد و Staging رفتار توسعه می‌گیرد:

- `allowsDeveloperTooling` = `NODE_ENV !== 'production'` (`packages/config/src/env.ts:966-968`) ← Swagger UI ـِ `/docs` در هر ۱۷ سرویس (مثلاً
  `services/economic-service/src/main.ts:103`)؛
- HSTS فقط در `production` (`services/economic-service/src/main.ts:77`، و همان عبارت در `src/main.ts` ـِ هر سرویس)؛
- Transport ـِ ClamAV (`services/document-service/src/config/env.ts:264`).

قاعده‌ی کمیسیون در این فهرست **نیست** (اصلاح r2): دور ۱ آن را از روی یک توضیح (`services/economic-service/src/commission/rule-engine.ts:16`)
«فقط Production» خوانده بود؛ ولی بیرون از `development`/`test` پیش‌فرض روشن است و خاموش کردنش در بوت رد می‌شود — `staging` هم
(`services/economic-service/src/config/env.ts:420-439`؛ آزمون `services/economic-service/src/config/env.spec.ts:293-325`). پس
S1 به آن دست نمی‌زند.

تصمیم: یک گزاره، `isProductionShaped(env)` = `staging` یا `production`، در `@rasta/config`؛ همه‌ی مقایسه‌های `=== 'production'`
که امنیت یا درستی را تعیین می‌کنند به آن می‌روند، و آزمون مخزن مقایسه‌ی مستقیم `NODE_ENV` با `'production'` را بیرون از
`@rasta/config` در `services/*` و `packages/*` رد می‌کند (PR S1). نمونه‌برداری Trace هم به تابعی نام‌دار در همان بسته می‌رود
**بی تغییر رفتار** (`docs/12:30`: Staging ۱۰۰٪)، تا ممنوعیت استثنا نداشته باشد. پورتال بیرون از این قاعده است: `next start`
همیشه `NODE_ENV=production` دارد.

### ۱۲. پذیرش امنیت زمان اجرا زیر همان سیاست شبکه

RUN-002 فقط وقتی پذیرفته است که این‌ها **روی Stack ـِ مستقرشده** سنجیده شوند (PRهای S9a و S9b)، نه فقط در CI:

1. **ماتریس شبکه — تولیدشده، نه نمونه (r2):** Probe ها با `docker run --rm --network container:<id>` و Image ـِ سنجاق‌شده‌ی
   `staging-bootstrap` اجرا می‌شوند، پس از **فضای نام شبکه‌ی همان Container** می‌سنجند و به ابزار درون Image ـِ زیرساختی
   نیاز ندارند. مجموعه‌ی آزمون حاصل‌ضرب کامل است: **مبدأ** = هر Container ـِ پروژه، یک‌بارمصرف‌ها هم؛ **مقصد** = هر نشانی هر
   Container ـِ دیگر در هر شبکه‌اش (از `docker network inspect` ـِ زنده، که باید با `services.json` برابر باشد)، به‌اضافه‌ی
   نشانی Gateway ـِ هر شبکه (یعنی خود میزبان) و یک IP عمومی؛ **پورت** = هر Listener ـِ واقعی مقصد (`/proc/net/tcp` و `tcp6` ـِ
   فضای نام مقصد، M-5) و برای میزبان، Listenerهای `ss -tlnH`. انتظار هر سه‌تایی از `services.json` می‌آید: «باز» فقط برای
   یال اعلام‌شده یا باقی‌مانده‌ی ثبت‌شده‌ی § ۴، و «بسته» برای **همه‌ی** بقیه — هم‌تاهای یک شبکه‌ی زیرساختی هم.
   **کنترل مثبت** (تا Listener ـِ مرده یا نشانی غلط «اجبار» شمرده نشود): در همان دور، (الف) هر سه‌تایی «بسته» یک کنترل از
   **درون فضای نام خود مقصد** به همان نشانی و پورت دارد که باید باز باشد — اگر نباشد، آن سه‌تایی «نامعتبر» است، نه «قبول»؛
   (ب) هر مبدأ دست‌کم یک یال اعلام‌شده‌ی موفق در همان دور دارد (Probe ـِ آن مبدأ کار می‌کند)؛ (ج) «بسته» فقط با
   `ECONNREFUSED`، `EHOSTUNREACH`/`ENETUNREACH` یا مهلت پذیرفته است و نوعش ثبت می‌شود؛ هر خطای دیگر (`EMFILE`، DNS، …) =
   نامعتبر؛ (د) گزارش شمار سه‌تایی‌ها را با حاصل‌ضرب مورد انتظار مقایسه می‌کند و هر سه‌تایی بی نتیجه = شکست. UDP: هر Listener
   ـِ UDP جز DNS ـِ داخلی Docker (`127.0.0.11`) = شکست.
2. **مستاجر و نقش:** از راه Edge و Gateway با دو مستاجر مصنوعی: A داده‌ی B را نمی‌خواند و تغییر نمی‌دهد (`AGENTS.md:118-119`)؛
   نقش‌های فقط‌خواندنی (مثلاً `AUDITOR`) نمی‌نویسند. Suite ـِ پذیرش Staging نگهبان وارونه‌ی E2E را دارد: فقط Realm با
   `rasta.staging_stack` و هرگز با `rasta.disposable_stack`.
3. **تأیید مالک برای Consumerهای مالی:** economic بی `MAINTENANCE_SERVICE_URL`، `FLEET_SERVICE_URL` و `CONTRACT_SERVICE_URL` بالا
   نمی‌آید (`services/economic-service/src/config/env.ts:234-245`)؛ زیر شبکه‌ی `to-<svc>`: تأیید با توکن داخلی موفق است؛ پاسخ «نه»
   ـِ مالک ← `SOURCE_UNCONFIRMED` و هیچ پاداشی (`reward-trigger.consumer.ts:79-83`)؛ مسیر بسته ← `UPSTREAM_UNAVAILABLE`، باز هیچ.
4. **D-045:** `check:db-runtime-privileges` پس از هر استقرار سبز.
5. **Kafka:** با اعتبار سرویس A، نوشتن در Topic ـِ سرویس B، خواندن بیرون از گروه خودش، اعتبار غلط و PLAINTEXT ← رد (معیارهای
   RUN-006، `planning/backlog.json:1677-1684`). فقط Probeهایی که در صورت رد چیزی نمی‌نویسند؛ آزمون‌های تغییردهنده‌ی Broker هرگز
   روی Staging (§ ۱۰ بند ۳).
6. **مهلت توقف (§ ۱۵):** در `stop`، `deploy`، `rollback`، Restore و Recreate ـِ چرخش، کد خروج هر Container ثبت می‌شود؛ ۱۳۷
   (SIGKILL) در هر کدام = شکست پذیرش.
7. **چرخش (§ ۵ بند ۴):** روی Stack ـِ مستقرشده، یک نقش اجرا و یک مهاجر چرخانده می‌شوند؛ پس از آن سرویس Ready است،
   مهاجر همچنان `NOLOGIN` است و Journal `ROTATED` دارد.

### ۱۳. شاهد عمومی

مخزن و PRها عمومی‌اند. **مجاز در PR، STATUS و Artifact:** SHA، Digest، خلاصه‌ی Scan و شناسه‌ی CVE، نام Container و Check، کد خروج،
عددهای منابع، و Hash ـِ SHA-256 ـِ فایل شاهد خصوصی. **هرگز:** مقدار Secret، خروجی `docker inspect` یا `env` (Environment دارد)،
URL ـِ اتصال، Dump، Payload ـِ رویداد، Export ـِ Realm، Log ـِ پالایش‌نشده، نشانی Tunnel. شاهد کامل در
`/home/rasta/staging/evidence/` (`0700`/`0600`) می‌ماند و PR فقط Hash و خلاصه را می‌آورد — همان قاعده‌ی تمرین Restore
(`backup-restore-drill.md:82-83`، `:126`).

**این قاعده شامل ابزارها هم هست (r2):** هیچ فرمان Staging، Probe، Watchdog یا وارسی مرز (§ ۱۰) پیکربندی مؤثر Compose
(`docker compose config`، که Env ـِ درون‌یابی‌شده دارد)، مقدار Env، خروجی خام `docker inspect`، یا stdout/stderr ـِ زیرفرایند
(`docker`، `psql`، `kafka-*`) را چاپ یا در Artifact ـِ عمومی نمی‌گذارد؛ پیام‌ها فقط کد دلیل ثابت، نام منبع و عدد دارند، و
خروجی خام فقط در شاهد خصوصی می‌ماند.

### ۱۴. قفل مشترک عملیات (r2)

ترتیب سرویس‌به‌سرویس (§ ۶ بند ۴) دو اپراتور را از هم جدا نمی‌کند: هر دو از Preflight می‌گذرند و Containerهای همدیگر را
بازمی‌سازند (انتشار مخلوط)، یا یکی مهاجری را `NOLOGIN` می‌کند که دیگری هنوز لازم دارد. پس:

1. **یک قفل:** `flock` روی `/home/rasta/staging/state/lock` (پوشه `0700`، فایل `0600`، مالک `rasta`؛ همان فایل‌سیستم ریشه).
   **همه‌ی** فرمان‌هایی که Staging را تغییر می‌دهند یا Container ـِ یک‌بارمصرف در آن می‌سازند آن را می‌گیرند: `up`، `deploy`،
   `rollback`، `stop`، Migration (درون `deploy` و بازیابی P3009)، `rotate` (همه‌ی انواع § ۵)، Backup، Restore، اندازه‌گیری‌های
   M-1 تا M-6، و Probeهای پذیرش. فقط `status` (خواندنی) بی قفل است.
2. **پیش از Preflight، تا پایان:** قفل نخستین کار فرمان است — پیش از خواندن Manifest، حافظه، دیسک یا Docker — و تا خروج
   آخرین فرزند نگه داشته می‌شود: فرمان زیر `flock(1)` **بی** `-o` اجرا می‌شود، پس Descriptor ـِ قفل به هر فرزند (`docker`،
   `psql`، Probe) ارث می‌رسد و قفل فقط وقتی آزاد است که **همه‌ی** فرایندهای عملیات تمام شده باشند (همان درس #420 r4: مالک
   = گروه فرایند، نه فقط والد). گرفتن **بی انتظار** است (`-n`): فرمان دوم بی‌درنگ رد می‌کند و فقط نام فرمان دارنده و زمان
   شروعش را می‌گوید (نه Argument، نه Env).
3. **مالک:** پس از گرفتن، `lock.owner` نوشته می‌شود: PID، `starttime` ـِ `/proc/<pid>/stat`، نام فرمان، شناسه‌ی انتشار، زمان
   UTC. Journal ـِ همان پوشه گام‌های اثردار را پیش از انجامشان ثبت می‌کند (`MIGRATOR_OPEN`، `CHANGED`، `RECREATE <svc>`،
   …).
4. **قفل کهنه:** خود `flock` کهنه نمی‌شود: Kernel آن را با بسته شدن آخرین Descriptor آزاد می‌کند؛ **هیچ** قاعده‌ی سنی یا
   «شکستن قفل» نیست. آنچه کهنه می‌شود **رکورد مالک** است: اگر گیرنده‌ی تازه رکوردی بیابد که (PID، `starttime`) آن دیگر زنده
   نیست، عملیات قبلی **ناتمام** بوده است. آنگاه فرمان کار عادی‌اش را نمی‌کند: نخست مهاجرهای باز را می‌بندد (§ ۶ بند ۳)،
   سپس هر فرمانی جز `status` و بازیابی همان عملیات (`rotate --resume`، `deploy --resume` یا `rollback`) را رد می‌کند تا Journal
   بسته شود. Containerهای نیمه‌کاره (`created`، `restarting`، `removing`) هم همین حالت را می‌سازند، چون Daemon ممکن است
   درخواستی را پس از مرگ CLI تمام کند.
5. **Watchdog و قفل:** Watchdog (§ ۳ بند ۵) قفل نمی‌گیرد. توقف اضطراری‌اش نخست نشان `abort` را در همان پوشه می‌نویسد؛ هر
   فرمان دارنده‌ی قفل آن را میان هر دو گام و در هر انتظار طولانی می‌خواند، می‌ایستد و Journal را `INTERRUPTED` می‌کند؛ سپس
   Watchdog Containerها را متوقف می‌کند. استقرار بعدی از حالت ناتمام بند ۴ می‌گذرد.

### ۱۵. مهلت توقف (r2)

پیش‌فرض Docker برای `stop` ده ثانیه است، ولی خاموشی هر سرویس تا `SHUTDOWN_TIMEOUT_MS` برای `app.close()` و سپس تا ۳ ثانیه
برای Flush ـِ Telemetry طول می‌کشد (`packages/nest-common/src/lifecycle/graceful-shutdown.ts:173`، `:181`، `:91`). پیش‌فرض
`SHUTDOWN_TIMEOUT_MS` ۲۵ ثانیه است، ولی هر سرویس می‌تواند آن را از ۱ تا ۱۲۰ ثانیه تنظیم کند (`packages/config/src/env.ts:223`،
`:242-246`)؛ هر ۱۷ سرویس `env.SHUTDOWN_TIMEOUT_MS` را می‌دهند و هیچ‌کدام `afterCloseTimeoutMs` را عوض نمی‌کند (`git grep`،
2026-10-27). پس:

1. **قاعده:** برای هر سرویس، `stop_grace_period` ≥ `SHUTDOWN_TIMEOUT_MS ـِ مؤثر همان سرویس` + `afterCloseTimeoutMs ـِ مؤثر`
   (امروز ۳ ثانیه، `graceful-shutdown.ts:71-72`) + حاشیه (پیشنهاد ۵ ثانیه، O-3). «مؤثر» یعنی مقداری که خود سرویس در Staging
   می‌خواند — از فایل Env ـِ غیرمحرمانه‌ی همان سرویس در `services.json`، یا پیش‌فرض اگر نیست — نه عدد ثابت ۲۵. با پیش‌فرض‌ها:
   ۳۳ ثانیه.
2. **Containerهای دیگر:** `web` (Next، بی مرز خاموشی در مخزن)، Edge، PostgreSQL، Kafka، Keycloak، Temporal، Redis، MinIO و
   ClamAV هرکدام `stop_grace_period` ـِ صریح با دلیل در `services.json` دارند؛ پیش‌فرض ندارد و M-6 آن را می‌سنجد.
3. **اجبار:** `staging-policy` (PR S4b) Compose ـِ بی `stop_grace_period` یا کمتر از قاعده‌ی بند ۱ را رد می‌کند. فرمان‌های
   Staging هرگز `-t`/`--timeout` به `stop`، `up`، `down`، `restart` یا `rm` نمی‌دهند، و هرگز `docker kill` یا `rm -f` روی
   Container ـِ در حال اجرا ندارند؛ آزمون Recorder ـِ PR S8a تا S8d این را برای هر فرمان می‌سنجد. توقف اضطراری Watchdog هم
   همین مهلت را دارد (`T_stop` ـِ § ۳ از همین می‌آید).
4. **آزمون:** Image ـِ آزمونی که روی SIGTERM `SHUTDOWN_TIMEOUT_MS + 3000 − 1000` میلی‌ثانیه صبر می‌کند و با ۰ بیرون می‌آید، در
   هر مسیر `deploy`، `rollback`، `stop`، Restore و Recreate ـِ چرخش: کد خروج ۰، نه ۱۳۷. همان در پذیرش (§ ۱۲ بند ۶).
5. **باقی‌مانده:** خاموشی خود میزبان یا Daemon از `shutdown-timeout` ـِ `daemon.json` پیروی می‌کند که بی root عوض نمی‌شود؛
   پس Reboot ممکن است SIGKILL بدهد. Staging پنجره‌ای است و پیش از Reboot با `stop` خاموش می‌شود (Runbook ـِ S10a).

## Consequences

- RUN-002 روی rasta-dev **پذیرفتنی است** با دو قید صریح: Staging با داده‌ی مصنوعی و پنجره‌ای (§§ ۲–۳)، و انحراف‌های ثبت‌شده از
  `docs/12`: Compose به‌جای Kubernetes، بی mTLS، بی NetworkPolicy ـِ Object، استقرار Pull به‌جای خودکار.
- RUN-004 روی همین میزبان بسته است تا O-5 یا ماشین دوم.
- کار عامل‌ها بر Staging مقدم است: Staging Swap نمی‌گیرد، CPU ـِ کمتر دارد، بی حافظه و دیسک کافی شروع نمی‌شود، و با نخستین
  نشانه‌ی کار دیگر یا کمبود دیسک **در طول اجرا** متوقف می‌شود (§ ۳ بندهای ۳–۵). محافظت Workerها در برابر یکدیگر در این ADR نیست.
- هر عملیات Staging زیر یک قفل است (§ ۱۴) و هر Launcher ـِ Docker ـِ مخزن از یک مرز انتخاب هدف می‌گذرد (§ ۱۰).
- سه پیوند شکسته‌ی `docs/12` (§ Context) با PRهای S10a و S10b بسته می‌شوند.

## Alternatives rejected

- **k3s تک‌گره:** root، حافظه‌ی Control Plane و Runtime ـِ دوم (§ ۱).
- **Bind به `0.0.0.0` با قاعده‌ی `DOCKER-USER`:** root می‌خواهد، و قاعده‌ای که خواندنی نیست تأیید نمی‌شود.
- **Self-hosted Runner برای Deploy:** کد PR ـِ Fork روی میزبان، و Secret در دسترس CI.
- **Registry محلی:** CI باید به میزبان Push کند.
- **Quick Tunnel:** Issuer ـِ ناپایدار.
- **یک PostgreSQL برای هر سرویس:** ۱۶ فرایند Postgres در حافظه‌ای که اوجش از پیش پر است؛ `pg_hba` با Subnet ـِ هر سرویس همان
  «فقط از سرویس خودش» را می‌دهد.

## Open — تصمیم‌های مالک (شماره‌ی Q را PM واگذار می‌کند)

| شناسه | تصمیم                                                                                                                                                                                                                                                                                                                | پیش‌فرض این ADR تا پاسخ                                                                                    |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| O-1   | پویش بیرونی پورت‌ها و Firewall ـِ پنل (§ ۴)                                                                                                                                                                                                                                                                          | بی آن، معیار «default-deny» پذیرفته نمی‌شود                                                                |
| O-2   | ورودی: فقط تونل SSH، یا Tunnel ـِ نام‌دار با دامنه‌ی مالک (DNS و TLS)                                                                                                                                                                                                                                                | فقط تونل SSH؛ CA ـِ Staging                                                                                |
| O-3   | **پنجره‌ی انحصاری** (Workerها در پنجره نگه داشته می‌شوند) یا **هم‌زمان با بودجه‌ی Worker ـِ اجباری** (`rasta-workers.slice` با `MemoryMax` و Containerهای Worker با `--memory`، § ۳ بند ۳)؛ `R_host`؛ حاشیه‌ی سقف‌ها؛ `T_poll`؛ حاشیه‌ی مهلت توقف؛ بودجه‌ی Backup و شاهد؛ آستانه‌ی ۸۵٪ به‌عنوان کران پایین `F_admit` | پنجره‌ی انحصاری؛ اندازه‌گیری‌ها هم در پنجره؛ هم‌زمان BLOCKED تا Slice ـِ Workerها و M-4؛ عددها پس از فاز M |
| O-4   | دید GHCR (عمومی/خصوصی)؛ اجباری بودن Attestation؛ دوره‌ی چرخش Secret                                                                                                                                                                                                                                                  | عمومی؛ اجباری؛ فقط با محرک                                                                                 |
| O-5   | جداسازی واقعی: کاربر جدا و Docker بی‌ریشه (نصب `uidmap` با root) یا ماشین دوم — پیش‌شرط RUN-004                                                                                                                                                                                                                      | نیست؛ § ۲                                                                                                  |
| O-6   | پذیرش انحراف‌ها: بی mTLS (S-03)، بی NetworkPolicy ـِ Object (جایش چهار لایه‌ی § ۴)، بی HA، Pull به‌جای خودکار؛ و **باقی‌مانده‌ی دسترسی هم‌تا** ـِ § ۴ (PostgreSQL ← Keycloak/Temporal بی Extension ـِ اتصال؛ سطح مسیر Keycloak برای اعضای `idp`؛ هر Listener ـِ M-5 که بسته نشود)                                    | پذیرفته برای Staging، نه Production؛ باقی‌مانده‌ی تازه‌ی M-5 بی تأیید مالک = پذیرش شکست                    |
| O-7   | Temporal: همان `temporalio/auto-setup` ـِ سنجاق‌شده (`docker-compose.yml:444`) یا Server و Schema ـِ جدا؛ و (r2) اگر پورت‌های داخلی Temporal با پیکربندی auto-setup به Loopback نروند، Image ـِ جدا یا باقی‌مانده‌ی O-6                                                                                              | همان Image؛ انحراف ثبت‌شده؛ پورت‌های داخلی پس از M-5                                                       |

## آنچه ادعا نمی‌شود

- هیچ چیز ساخته یا مستقر نشده است؛ هیچ معیار RUN-002 با این PR برآورده نمی‌شود.
- عددهای بودجه‌ای که M-1 تا M-6 می‌خواهند **حدس زده نشده‌اند**؛ ۸۵٪، `14443`، `10.74.0.0/16`، حاشیه‌ی ۵ ثانیه و `T_poll` ـِ ۱۰
  ثانیه پیشنهادند، نه اندازه‌گیری.
- ادعا نمی‌شود که Worker هرگز Swap نمی‌گیرد: در پنجره‌ی انحصاری Workerی نیست، و در هم‌پوشانی کوتاه پیش از توقف Watchdog،
  Staging فقط از `E_mem` بیشتر نمی‌گیرد (§ ۳ بند ۳). `oom_score_adj` تضمین نیست.
- ادعا نمی‌شود که دیسک هرگز پر نمی‌شود اگر `R_max` ـِ واقعی از اندازه‌گیری M-3 بیشتر شود؛ `F_stop` از همان عدد ساخته می‌شود.
- Staging روی این میزبان در برابر عامل‌هایی که همین کاربر را دارند امن نیست (§ ۲) و ادعای آن هم نمی‌شود.
- تمرین Restore ـِ موجود بازیابی توزیع‌شده را ثابت نمی‌کند (§ ۹).

## تغییرات r2 (بازبینی Codex r1 بر #428)

سطرها، سطرهای همین Commit اند. هر یافته پیش از اصلاح با کد و میزبان (فقط خواندن) وارسی شد و **هر هفت درست بودند**؛ اصلاح اضافه‌ی کمیسیون هم درست بود.

| یافته                                      | کجا (ADR / برنامه)                                                                                                                                                                                      |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 شبکه‌ی مشترک جهت ندارد                  | § ۴: جدول شبکه (`edge-*`، `db-*` ـِ زیرساخت)، «اجبار، نه فقط عضویت»، Subnet ـِ صریح، باقی‌مانده؛ § ۱۲ بند ۱؛ O-6؛ برنامه S1b، S9a — ADR `:251-308`، `:363-373`، `:661-676`، `:781`؛ برنامه `:37`، `:55` |
| F2 منابع در تمام مدت اجرا                  | § ۳ بندهای ۱–۶، جدول نویسنده‌ها، `F_stop`/`F_admit`، Watchdog، M-1 تا M-6؛ O-3؛ برنامه فاز M و S8a، S8b — ADR `:140-228`، `:778`، `:784-794`؛ برنامه `:11-29`، `:49-53`                                 |
| F3 مرز واحد انتخاب هدف                     | § ۱۰ سطرهای ۵، ۱۰، ۱۱ و «مرز واحد انتخاب هدف»، «نخستین ساختن»، فهرست کامل Launcherها؛ برنامه S7a — ADR `:572-634`؛ برنامه `:47`                                                                         |
| F4 قفل مشترک                               | § ۱۴؛ § ۶ بندهای ۳–۴؛ § ۳ بند ۲ (یک جای یک‌بارمصرف) — ADR `:702-728`، `:451-461`                                                                                                                        |
| F5 گراف برنامه                             | برنامه: «ترتیب»، «وارسی گراف»، شکستن S4، S6، S7، S8، S9، S10؛ S1 پیش‌نیاز فاز M — برنامه `:11-29`، `:31-60`، `:62-71`                                                                                   |
| F6 چرخش سازگار با Staging                  | § ۵ بند ۴ (گام‌های ۱–۶ و هم‌خانواده‌ها)؛ § ۱۲ بند ۷؛ برنامه S8d — ADR `:396-430`، `:686-688`؛ برنامه `:54`                                                                                              |
| F7 مهلت توقف                               | § ۱۵؛ § ۸ بند ۳؛ § ۱۲ بند ۶ — ADR `:729-751`، `:516`، `:684-685`                                                                                                                                        |
| اضافه: کمیسیون از پیش Staging را می‌پوشاند | § ۱۱ (کمیسیون از فهرست بیرون رفت)؛ برنامه S1 — ADR `:636-650`؛ برنامه `:36`                                                                                                                             |
| افزوده‌های PM: A مهلت مؤثر                 | § ۱۵ بندهای ۱ و ۳                                                                                                                                                                                       |
| B نخستین ساختن                             | § ۱۰ «نخستین ساختن»                                                                                                                                                                                     |
| C بودجه‌ی Worker                           | § ۳ بند ۳                                                                                                                                                                                               |
| D توقف نویسنده‌ی فعال                      | § ۳ بندهای ۴–۵                                                                                                                                                                                          |
| E چرخش پس از نوشتن ناقص                    | § ۵ بند ۴ گام‌های ۱، ۵ و ۶                                                                                                                                                                              |
| F کنترل مثبت Probe                         | § ۱۲ بند ۱                                                                                                                                                                                              |
| G افشا در ابزارها                          | § ۱۰ «افشا»؛ § ۱۳                                                                                                                                                                                       |
| H نشانی درست کمیسیون                       | § ۱۱: `services/economic-service/src/config/env.ts:420-439` روی `main` ـِ کنونی (بازه‌ی `424-436` ـِ بازبینی مال `c4e2a482` بود)                                                                        |

همچنین: همه‌ی نشانی‌های `file:line` روی `main` ـِ کنونی دوباره وارسی و جابه‌جاشده‌ها اصلاح شدند؛ و املای معیار (قاعده‌ی ۱۹
ـِ چک‌لیست، تصمیم مالک B) در متن افزوده‌شده اعمال شد (`تأیید`، `متأثر`، `منشأ`).
