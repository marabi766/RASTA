# ADR-074: Staging روی یک میزبان (rasta-dev) و امنیت هم‌شکل Production

- **وضعیت:** **Proposed** — فقط طراحی (RUN-002 گام ۰)؛ هیچ استقرار، هیچ تغییر زیرساخت میزبان و هیچ کدی در این PR نیست
- **تاریخ:** 2026-10-25
- **تصمیم‌گیرنده:** معماری پلتفرم؛ تصمیم‌های مالک در § ۱۵ (O-1 تا O-7) باز می‌مانند تا مالک پاسخ دهد. شماره‌ی ADR طبق
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

دو معیار RUN-002 (`planning/backlog.json:1510-1513`):

1. «A reproducible staging deployment uses default-deny network policy»
2. «Secrets, migrations, image provenance and rollback are operationally verified»

یادداشت Evidence همان ردیف (`planning/backlog.json:1545`) می‌گوید معیار نخست **شروع نشده** است (هیچ Manifest یا
`values-staging.yaml` در مخزن نیست) و از معیار دوم فقط بخش Secret و Migration (D-045، #176، #177، #178، #180 و #191)
پیش رفته است. RUN-003 به RUN-002 وابسته است (`:1561`) و RUN-004 به RUN-003 و EXP-004 (`:1577`).

تصمیم‌های مالک، 2026-10-24: (۱) Staging فعلاً روی **همین** میزبان (`rasta-dev`) اجرا می‌شود و ماشین دومی نیست؛ (۲) مخزن
GitHub فعلاً **عمومی** می‌ماند.

### آنچه `docs/12` فرض کرده و این میزبان ندارد

| `docs/12`          | فرض                                                               | روی rasta-dev                                                                  |
| ------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `:17`              | Staging روی Kubernetes، «خودکار از `main`»                        | بی Kubernetes؛ بی دسترسی root (پایین)                                          |
| `:23-24`           | TLS بیرونی و **mTLS داخلی** در Staging                            | mTLS در کد نیست؛ توکن مشترک HS256 (S-03، `packages/config/src/env.ts:510-517`) |
| `:134-135`         | Secret از External Secrets Operator؛ NetworkPolicy                | هیچ‌کدام در مخزن نیست                                                          |
| `:180-193`         | پایگاه داده‌ی هر سرویس فقط از خودش؛ Egress بسته                   | Compose امروز یک شبکه‌ی پیش‌فرض مشترک دارد (پایین)                             |
| `:244-250`         | روی `main`: Build، Scan، **Push Registry**، Deploy                | Push نمی‌شود (`ci.yml:4255` `push: false`)؛ Deploy نیست                        |
| `:270-274`         | `helm upgrade --atomic` و Rollback خودکار                         | بی Helm؛ Rollback باید با Digest قبلی ساخته شود (§ ۸)                          |
| `:338-340`، `:352` | Runbookهای `restore-database`، `disaster-recovery`، `secret-leak` | **این سه فایل در `docs/runbooks/` وجود ندارند** (پیوند شکسته)                  |

### آنچه امروز در مخزن هست

| موضوع              | واقعیت امروز                                                                                                                                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ساخت و Scan تصویر  | Job `containers` تصویر را می‌سازد، با SHA برچسب می‌زند و با Trivy (فقط HIGH/CRITICAL **قابل‌رفع**، `ignore-unfixed`) می‌سنجد؛ Push ندارد (`.github/workflows/ci.yml:4247-4284`)                                                                                      |
| دامنه‌ی تصویرها    | روی PR فقط تصویرهای متاثر، روی Push به `main` همه (`ci.yml:4205-4219`)؛ مالک 2026-10-24 تصویب کرد که ساخت و Scan به Train (`mq/train-*`) و `main` برود (کار W#8 828)                                                                                                 |
| فهرست تصویرها      | فقط هر پوشه‌ی `services/*` با `Dockerfile` (`scripts/container-scope-lib.mjs:24-26`) — ۱۷ تصویر، `api-gateway` هم؛ **`apps/web` هیچ Dockerfile ندارد**                                                                                                               |
| Migration در تصویر | تصویر اجرا `pnpm deploy --prod` است (`services/economic-service/Dockerfile:66`) و `prisma` فقط `devDependency` است؛ پس **هیچ تصویری Migration را اجرا نمی‌تواند** و `db:migrate` از ریشه‌ی مخزن اجرا می‌شود (`package.json:19` همان سرویس)                           |
| نقش اجرا و مالک    | D-045 کامل: مهاجر مالک، نقش اجرا فقط DML (`docs/runbooks/db-role-split.md:19-27`)؛ سرویس با اعتبار مهاجر بالا نمی‌آید (`:151-165`)؛ بررسی Catalogue پس از هر استقرار (`:259`)                                                                                        |
| Kafka              | پروفایل `deployment` با ۱۶ سرویس و `ops-replay`، بی Principalهای آزمون و ابزار (`infrastructure/docker/kafka/principals.deployment.txt`؛ `scripts/kafka-acl.mjs:5`، `:51`)؛ سرویس بی SASL و TLS بالا نمی‌آید (`packages/nest-common/src/kafka/connection.ts:97-103`) |
| Keycloak           | فقط Realm توسعه، که کاربران با گذرواژه‌ی عمومی دارد و فقط در `start-dev` بار می‌شود (`infrastructure/docker/keycloak/dev-realm-gate.sh:3-27`)؛ **Realm بی‌کاربر برای محیط واقعی در مخزن نیست**                                                                       |
| Compose توسعه      | یک پروژه `rasta` (`docker-compose.yml:13`)، `container_name` ثابت (`:63` و …)، بی بخش `networks` (همه روی شبکه‌ی پیش‌فرض)، بی هیچ سقف حافظه یا CPU (`:60-108`)، Retention ـِ Kafka فقط زمانی (`:177`)، و `COMPOSE_BIND_ADDRESS` که Bind را عوض‌پذیر می‌کند (`:99`)   |
| تمرین Restore      | فقط PostgreSQL، روی خوشه‌ی یک‌بارمصرف، با نقش‌های توسعه (`docs/runbooks/backup-restore-drill.md:3-9`، `:87-94`)                                                                                                                                                      |
| دروازه‌ی Saga      | دستی؛ «هر خط استقراری که ساخته شود باید همین اسکریپت را میان گام ۲ و ۴ اجرا کند» (`docs/runbooks/marketplace-saga-deploy.md:92-95`)                                                                                                                                  |

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
| Listenerها                       | فقط SSH (`0.0.0.0:22`، `[::]:22`) بیرونی است؛ بقیه روی `127.0.0.1` (تایید مستقل گزارش PM، 21:40 UTC)                                                           | `ss -tlnH`                                  |
| CI                               | هر ۱۸ Job روی `ubuntu-latest` (GitHub-hosted)؛ هیچ Runner روی این میزبان نیست                                                                                  | `grep runs-on .github/workflows/*.yml`      |

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

Staging یک پروژه‌ی Compose جداست: `rasta-staging`، از فایل `infrastructure/staging/compose.yml` (PR S4 برنامه). k3s تک‌گره رد شد:

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

**تصمیم:**

1. **هر Container ـِ Staging سقف سخت دارد**؛ `staging-policy` (PR S4) فایلی را که یکی از این‌ها را نداشته باشد رد می‌کند:
   `mem_limit` و `memswap_limit` **برابر** آن (Staging هرگز Swap نمی‌گیرد و فشارش را به Workerها نمی‌دهد)، `cpus`،
   `pids_limit`، `cpu_shares` کمتر از پیش‌فرض ۱۰۲۴ (در رقابت CPU، Workerها مقدم‌اند)، `oom_score_adj` مثبت (در OOM ـِ کل
   میزبان، Kernel اول Staging را می‌کشد، نه Worker را)، `restart: unless-stopped`، `healthcheck`، و `logging` با `max-size` و
   `max-file` صریح.
2. **سقف کل Staging = جمع `mem_limit`ها**، و فرمان شروع/استقرار (PR S8) پیش از هر کار، `MemAvailable` ـِ `/proc/meminfo` را با
   «سقف کل + ذخیره» می‌سنجد و اگر کمتر بود **رد می‌کند** (Fail Closed؛ خوانا نبودن هم رد).
3. **کار پنجره‌ای، پیش‌فرض.** Staging برای تایید یک انتشار یا Demo روشن و پس از آن با `docker compose stop` خاموش می‌شود —
   **هرگز** `down` (§ ۱۰ بند ۸: `docker volume prune` ـِ Volume ـِ Containerهای حذف‌شده را پاک می‌کند). همیشه‌روشن شدن تصمیم
   O-3 است و فقط پس از اندازه‌گیری M-1.
4. **دیسک.** Volume روی ext4 سهمیه ندارد، پس سقف از راه پیکربندی است: Kafka با `retention.bytes` برای هر Topic (کران =
   ۴۶ Topic × ۳ Partition پیش‌فرض (`infrastructure/docker/kafka/topics.txt`، `create-topics.sh:70`) × `retention.bytes`، به‌اضافه‌ی
   Segment فعال)؛ MinIO با سهمیه‌ی سخت Bucket؛ Backup با نگهداری شمارشی؛ Log با `max-size × max-file` هر Container. استقرار
   رد می‌شود اگر پس از Pull، فضای آزاد ریشه زیر آستانه‌ی O-3 بیفتد؛ و پیشنهاد آستانه: **Staging بالای ۸۵٪ مصرف ریشه اجرا
   نمی‌شود** — یعنی در وضعیت 2026-10-24 (حدود ۸۷٪) رد می‌شد.

**BLOCKED pending measurement** — عددهایی که هنوز نیستند و روش دقیق گرفتنشان (همه خواندنی یا روی Stack ـِ خود Staging):

| شناسه | چه                                                 | روش                                                                                                                                                                                                                     |
| ----- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M-1   | حافظه‌ی هر Container ـِ Staging در بار Smoke و E2E | نخستین بالا آمدن با سقف موقت بزرگ؛ هر ۱۰ ثانیه `memory.current` و در پایان `memory.peak` و `memory.stat` (`anon` جدا از `file`) از `/sys/fs/cgroup/system.slice/docker-<id>.scope/`؛ سقف = Peak ـِ `anon` + حاشیه‌ی O-3 |
| M-2   | اندازه‌ی مجموعه‌ی تصویرهای یک انتشار               | پس از نخستین انتشار (PR S3): `docker image inspect --format '{{.Size}}'` برای هر Digest؛ دیسک لازم در استقرار = ۲ × این (انتشار قبلی تا Rollback می‌ماند)                                                               |
| M-3   | رشد Volumeها در یک پنجره‌ی کار                     | `docker system df -v` پیش و پس از هر پنجره، برای Volumeهای `rasta-staging_*`                                                                                                                                            |
| M-4   | سهم هر Worker در اوج                               | PM در یک روز پرکار هر ۶۰ ثانیه `memory.current` و `memory.peak` ـِ Containerهای هر Worker (نام‌های `wN-*`) و Slice کاربر را ثبت کند؛ `sysstat` فقط کل میزبان را دارد                                                    |

**پاک‌سازی یا سقف — فقط پیشنهاد، هیچ چیز پاک نشد:**

| مورد                                                               | اندازه (اکنون)                              | پیشنهاد و چه کسی                                                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Containerهای آزمون باقی‌مانده (`rl-pg`، `w4-r051-pg`، `w6-014-pg`) | سه Postgres زنده، بی سقف                    | صاحب هرکدام پس از تایید PM حذفش کند؛ قاعده‌ی PM: هر پایگاه یک‌بارمصرف با `--memory` و برچسب Worker و پایان کار حذف |
| تصویرهای بی‌استفاده                                                | ۴٫۷۳ GB قابل‌بازپس‌گیری                     | `docker image prune` فقط با فیلتر برچسب/زمان، با تایید PM؛ هرگز `--all` بی فیلتر روی میزبان مشترک                  |
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

| شبکه                           | اعضا                                                                        | چرا                                                                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ingress` (نه internal)        | فقط `edge`                                                                  | Publish روی شبکه‌ی internal کار نمی‌کند؛ فقط Edge این شبکه را دارد                                                                                   |
| `edge`                         | `edge`، `web`، `keycloak`                                                   | مرورگر ← Edge ← پورتال یا مسیرهای عمومی Keycloak                                                                                                     |
| `to-<svc>` (یکی برای هر سرویس) | سرویس `<svc>`، `api-gateway`، و فقط سرویس‌هایی که `<SVC>_SERVICE_URL` دارند | تماس سرویس‌به‌سرویس فقط به مقصدهای اعلام‌شده                                                                                                         |
| `to-gateway`                   | `api-gateway`، `web`                                                        | پورتال فقط از سمت سرور Gateway را صدا می‌زند (`API_GATEWAY_URL`)                                                                                     |
| `db-<svc>` (یکی برای هر سرویس) | سرویس `<svc>`، مهاجر یک‌بارمصرف همان سرویس، `postgres`                      | پایگاه داده فقط از سرویس خودش؛ `pg_hba` پایین                                                                                                        |
| `db-platform`                  | `postgres`، `keycloak`، `temporal`                                          | پایگاه‌های زیرساختی، هرکدام با نقش خودش (نه Superuser، برخلاف `docker-compose.yml:242-243`، `:450-451`)                                              |
| `kafka`                        | `kafka`، هر سرویس دارای `KAFKA_BROKERS`، ابزار یک‌بارمصرف Topic/ACL         | ACL هر Principal را محدود می‌کند (پایین)                                                                                                             |
| `idp`                          | `keycloak`، همه‌ی سرویس‌ها (`OIDC_JWKS_URI`)، `web`                         | دریافت JWKS؛ API ادمین Keycloak فقط با اعتبار `identity-service` (`KEYCLOAK_URL`)                                                                    |
| `cache`                        | `redis`، `api-gateway`، `fleet-service`، `web`                              | فقط سه مصرف‌کننده‌ی `REDIS_URL`/`WEB_REDIS_URL`؛ کاربر ACL ـِ Redis هرکدام با الگوی کلید خودش (`REDIS_KEY_PREFIX`، `packages/config/src/env.ts:502`) |
| `workflow`                     | `temporal`، `marketplace-service`، ابزار دروازه‌ی Saga                      | فقط مالک `TEMPORAL_ADDRESS`                                                                                                                          |
| `objects`، `scan`              | `document-service` با `minio`؛ `document-service` با `clamav`               | کاربر MinIO ـِ سرویس با Policy همان Bucket، نه Root                                                                                                  |
| `mail`                         | `notification-service`، Mailpit ـِ Staging                                  | SMTP به گیرنده‌ی محلی؛ هیچ ایمیل واقعی                                                                                                               |
| `updates` (نه internal)        | فقط `clamav-freshclam`                                                      | تنها Egress ـِ اینترنتی: Signatureها؛ Volume مشترک با `clamav` که خودش internal است                                                                  |

ماتریس تماس سرویس‌ها امروز (از کلیدهای Env هر `services/*/src/config/env.ts`): asset ← document، fleet، maintenance؛
construction ← audit، identity، organization، supplier؛ contract ← construction، economic، organization؛ economic ← contract،
fleet، maintenance، organization؛ fleet ← asset، maintenance؛ identity ← audit و Keycloak؛ inventory ← marketplace؛
maintenance ← asset؛ marketplace ← economic، inventory، organization و Temporal؛ notification ← identity؛ procurement ←
supplier؛ Gateway ← همه. analytics، audit، document، organization و supplier هیچ تماس HTTP بیرونی ندارند.

**پایگاه داده.** یک Cluster ـِ PostgreSQL، ۱۶ پایگاه (ADR-005). شبکه‌ی `db-<svc>` هر سرویس Subnet خودش را دارد و
`pg_hba.conf` ـِ Staging فقط سطرهای `hostssl rasta_<svc> rasta_<svc>,rasta_<svc>_migrator <subnet db-<svc>> scram-sha-256` را
دارد و در پایان `host all all 0.0.0.0/0 reject`. پس سرویس دیگر حتی با گذرواژه‌ی درست از Subnet خودش به پایگاه دیگر وصل
نمی‌شود؛ `CONNECT` ـِ نقش‌ها هم از پیش محدود است (`docs/runbooks/database-bootstrap.md:67-69`). مهاجر فقط در پنجره‌ی Migration
`LOGIN` دارد (§ ۶).

**Kafka (RUN-006، ADR-061 § ۳).** Broker ـِ Staging همان `broker-entrypoint.sh` ـِ مشترک CI است، با `KAFKA_ACL_PROFILE=deployment`
و ACLهای `scripts/kafka-acl.mjs apply --profile deployment` (`scripts/kafka-acl.mjs:5`، `:30`)؛ Principalهای آزمون، Kafka UI و
Exporter در این پروفایل نیستند. CA ـِ Staging جدا و روی میزبان ساخته می‌شود (مثل `tls.sh`، هرگز Commit نمی‌شود). سرویس بی SASL
و TLS رد می‌کند (`connection.ts:97-103`)؛ PLAINTEXT فقط در `development`/`test` مجاز است (`packages/config/src/env.ts:528-541`) و
Staging با `NODE_ENV=staging` اجرا می‌شود. Listener ـِ Broker فقط روی شبکه‌ی `kafka` است و **هیچ پورتی Publish نمی‌شود** (برخلاف
`docker-compose.yml:183-184`).

**تماس سرویس‌به‌سرویس.** امروز توکن داخلی HS256 با راز مشترک (`INTERNAL_TOKEN_SECRET`، `packages/config/src/env.ts:510-519`؛ S-03؛ ADR-020) —
Staging راز یکتای خودش را دارد. mTLS داخلی که `docs/12:24` برای Staging می‌خواهد **نیست**؛ انحراف ثبت‌شده، تا ADR-020 پیاده
شود (O-6). شبکه‌ی `to-<svc>` دسترسی لایه‌ی ۴ را به مقصدهای اعلام‌شده محدود می‌کند و توکن، هویت را؛ هیچ‌کدام جای دیگری را
نمی‌گیرد (`AGENTS.md:110` S-08).

**مرورگر ← Keycloak و TLS.** پورتال **یک** نشانی برای Issuer دارد و از آن هم Redirect ـِ مرورگر را می‌سازد
(`apps/web/src/app/auth/login/route.ts:34-42`، `apps/web/src/server/oidc.ts:31-38`) و هم در سمت سرور Token می‌گیرد
(`apps/web/src/app/auth/callback/route.ts:60`، `apps/web/src/server/session-refresh.ts:156`). پس:

- `edge` (Reverse Proxy با Image سنجاق‌شده) TLS را خاتمه می‌دهد و مسیرها را با فهرست سفید می‌فرستد: فقط
  `/realms/rasta/protocol/openid-connect/*`، `/realms/rasta/login-actions/*` و `/resources/*` به Keycloak؛ `/admin`، Realmهای
  دیگر، `/metrics` و `/health` ← ۴۰۴؛ بقیه به `web`. Gateway **Publish نمی‌شود** — مرورگر هرگز مستقیم آن را صدا نمی‌زند.
  (همین الگو در Demo ـِ محلی کار کرده است: `~/demo/README.md:18-27`.)
- نام میزبان Staging داخل شبکه‌ی `edge` به خود Edge Resolve می‌شود (`extra_hosts` با IP ثابت Edge)، و `web` گواهی Edge را با
  `NODE_EXTRA_CA_CERTS` می‌پذیرد؛ سرویس‌ها Issuer را فقط به‌عنوان رشته مقایسه می‌کنند و JWKS را از شبکه‌ی `idp` می‌گیرند
  (`OIDC_ISSUER_URL`/`OIDC_JWKS_URI`، `packages/config/src/env.ts:507-508`).
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

**تایید بی sudo:**

1. ایستا، در CI (PR S4): `staging-policy` فایل Compose را Parse می‌کند و رد می‌کند اگر: هر `ports` با `host_ip` جز
   `127.0.0.1` یا بی آن؛ بیش از یک سرویس با `ports`؛ `network_mode: host`؛ `privileged`؛ `cap_add`؛ هر Interpolation در
   `ports`؛ شبکه‌ای جز دو استثنا که `internal: true` نباشد.
2. زنده، روی میزبان، پس از هر استقرار: `docker inspect` همه‌ی Containerهای برچسب `com.rasta.environment=staging` ← هر
   `HostConfig.PortBindings[*].HostIp == "127.0.0.1"`؛ و `ss -tlnH` ← هیچ Listener ـِ جدید روی `0.0.0.0` یا `[::]`.
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
4. **چرخش:** هر نوع با سازوکاری که از پیش هست: نقش‌های PostgreSQL با `rotate-role-passwords.bash` (اجرای بیرون از Compose
   توسعه گذرواژه‌ی صریح می‌خواهد، `db-role-split.md:205-208`)؛ Kafka با `docs/runbooks/kafka-credential-rotation.md`؛
   `INTERNAL_TOKEN_SECRET` با ری‌استارت هم‌زمان همه‌ی سرویس‌ها (توکن حداکثر ۹۰۰ ثانیه زنده است، `packages/config/src/env.ts:519`)؛ Secret ـِ
   Clientهای Keycloak با API ادمین. **محرک:** گمان نشت، رفتن عضو تیم، یا هر بار که فایل Secret در Log/خروجی دیده شد؛ دوره‌ی
   زمانی تصمیم O-4 است (عددی جعل نمی‌شود).
5. **CI هرگز Secret ـِ Staging نمی‌بیند:** هیچ GitHub Secret برای Staging، هیچ Job ـِ Deploy، هیچ کلید SSH در GitHub، و **هیچ
   Self-hosted Runner روی این میزبان** (روی مخزن عمومی، Runner ـِ میزبان کد PRهای Fork را روی همین ماشین اجرا می‌کرد).
   استقرار **Pull** است: اپراتور روی میزبان فرمان استقرار را با Manifest ـِ انتشار اجرا می‌کند (§ ۷). Job ـِ انتشار فقط
   `GITHUB_TOKEN` با `packages: write` دارد. این انحراف از «خودکار از `main`» ـِ `docs/12:17`، `:248` است و ثبت می‌شود.
6. **نگهبان‌ها:** Gitleaks روی PR (`ci.yml:387-390`) و Semgrep با `p/secrets` (`ci.yml:421-426`) **پس از Push** می‌بینند؛ روی
   مخزن عمومی، Push یعنی انتشار. پس کنترل اصلی پیشگیرانه است (بند ۲: فایل بیرون از Worktree)، و نگهبان‌ها لایه‌ی دوم‌اند: PR S5a
   یک قاعده‌ی `.gitleaks.toml` (Extend ـِ پیش‌فرض) و یک قاعده‌ی Semgrep برای `rstg_[A-Za-z0-9_-]{43}` اضافه می‌کند، به‌اضافه‌ی
   آزمونی که نمونه‌ی ساختگی را تشخیص دهد. **نشت = چرخش فوری**؛ بازنویسی تاریخچه جایگزین چرخش نیست. Runbook ـِ
   `secret-leak.md` که `docs/12:352` به آن پیوند می‌دهد وجود ندارد؛ PR S10 آن را می‌نویسد.
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
   اعتبار نشت‌کرده را کوتاه می‌کند.)
4. **ترتیب: Migrate، سپس Deploy، برای هر سرویس:** (الف) Preflight (§ ۳: حافظه و دیسک)؛ (ب) `pg_dump -Fc` پایگاه همان سرویس
   (Backup روزانه‌ی Staging، `docs/12:27`، و پیش از هر Migration)؛ (ج) Migration با Container ـِ `migrate`؛ (د)
   `check:db-runtime-privileges` با نقش فقط‌خواندنی Catalogue (`db-role-split.md:259`) — یافته = توقف؛ (هـ) Recreate ـِ
   Container ـِ سرویس با Digest ـِ تازه؛ (و) Readiness و Smoke. Migration باید سازگار به عقب باشد؛ تغییر شکننده فقط
   Expand/Contract در سه انتشار (`docs/12:277-278`، `:365-366`). Migrationهای سرویس‌ها مستقل‌اند (پایگاه جدا، ADR-005)؛ انتشار
   سرویس به سرویس جلو می‌رود و **با نخستین شکست کل انتشار می‌ایستد**.
5. **Migration ـِ شکست‌خورده:** سرویس روی Image ـِ قبلی می‌ماند (Recreate هنوز نشده؛ کد قبلی با Schema ـِ قبلی کار می‌کند).
   Prisma ردیف ناتمام را نگه می‌دارد و هر `migrate deploy` بعدی با `P3009` رد می‌شود (`database-bootstrap.md:169-171`). بازیابی
   فقط طبق Runbook ـِ همان Migration، یا روند عمومی `db-role-split.md:57-77`: سرویس متوقف یا روی نسخه‌ی قبلی، بررسی ردیف
   (`finished_at IS NULL AND rolled_back_at IS NULL`)، اثبات Rollback ـِ تراکنش با مقایسه‌ی ACL با Snapshot ـِ پیش از استقرار، سپس
   `migrate resolve --rolled-back` و اجرای دوباره. **هرگز `--applied`** و هرگز `migrate reset` (`database-bootstrap.md:115`).
   Snapshot ـِ ACL (`scripts/db-acl-snapshot.sql`) پیش از هر Migration گرفته و بیرون از مخزن نگه داشته می‌شود.

### ۷. منشا تصویر (بند ۵)

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
تصویری در Matrix داشته باشد — همان درسی که سه سرویس جاافتاده دادند (`ci.yml:4235-4239`).

**انتشار فقط از `main`:**

1. Train (`mq/train-*`) و PR تصویر متاثر را می‌سازند و می‌سنجند (W#8 828) ولی **هرگز Publish نمی‌کنند**: اجرای Train یک رویداد
   `pull_request` است و ممکن است رد شود.
2. Job ـِ تازه‌ی `publish` (PR S3) فقط با `github.event_name == 'push' && github.ref == 'refs/heads/main'`، پس از همه‌ی دروازه‌ها
   (همان `needs` ـِ Job `containers`، `ci.yml:4229`)، برای **همه‌ی** Deployableها (`--all`)؛ هر شرط دیگری = بی Publish.
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
   حصاردار را اجرا می‌کند (`marketplace-saga-deploy.md:25-35`): Migration؛ توقف **همه‌ی** نمونه‌ها (`docker compose stop`، نه
   Recreate ـِ تدریجی؛ نه `MARKETPLACE_TEMPORAL_ENABLED=false`)؛ `scripts/marketplace-saga-drain-check.mjs` از Container ـِ
   یک‌بارمصرف روی شبکه‌ی `workflow`؛ فقط کد `0` ادامه می‌دهد. کد `1` (Poller یا Activity ـِ در انتظار) و کد `2` (بررسی ناممکن،
   پاسخ ناشناخته) **استقرار را می‌بندند**؛ استثنا ندارد. هرگز `terminate` یا `reset` ـِ Workflow: وجه در Hold می‌ماند (`:83-88`).
4. **آنچه برنمی‌گردد:** رویدادی که نسخه‌ی تازه منتشر کرده و Consumerها پردازش کرده‌اند؛ تغییر Config ـِ Topic (اسکریپت فقط سقف
   را بالا می‌برد، `docs/12:285-291`) و ACL؛ تغییر Realm ـِ Keycloak؛ Migrationی که `down` ـِ آن رد می‌کند یا بازگشت‌ناپذیر
   مستند شده (`docs/12:366-371`)؛ تعمیر ACL ـِ D-045 (`db-role-split.md:122-123`)؛ Workflowی که نسخه‌ی تازه آغاز کرده (بند ۳).
   اثر بیرونی ندارد: پرداخت Mock و ایمیل محلی است.
5. **اثبات در Staging (PR S9):** تمرین Rollback ـِ ثبت‌شده: انتشار N ← انتشار N+1 با دست‌کم یک Migration ← Smoke ← Rollback به
   Digestهای N ← Smoke، `check:db-runtime-privileges`، ردیف‌های `_prisma_migrations` همان پس از N+1 (Rollback ـِ کد به Schema دست نمی‌زند و کد N با آن کار می‌کند)، و تراز دفتر کل با پرس‌وجوهای
   `scripts/backup-restore-drill-lib.mjs`. و تمرین Migration ـِ شکست‌خورده، روی نخستین Bootstrap یا پایگاه Scratch ـِ Staging، با امتناعی که از پیش در کد هست: Migration ـِ
   `20261024130000_analytics_runtime_privileges` با اتصالی جز مهاجر `42501` می‌گیرد (`db-role-split.md:57-58`) ← `P3009` ←
   بازیابی همان Runbook.

### ۹. دامنه‌ی بازیابی: PostgreSQL به‌تنهایی بازیابی توزیع‌شده نیست

تمرین موجود فقط PostgreSQL را، بی نویسنده‌ی فعال، ثابت می‌کند و Offsetهای Kafka، سازگاری Snapshot ـِ توزیع‌شده و بازیابی کل
سامانه را صریحاً بیرون می‌گذارد (`backup-restore-drill.md:87-94`، `:171-174`). Restore ـِ Staging (Runbook در PR S10؛ اثبات کامل در
RUN-003):

1. پیش از Restore: **همه‌ی** سرویس‌ها متوقف — Publisherهای Outbox، Consumerها، Workerها و زمان‌بندها؛ Saga طبق § ۸ بند ۳.
2. پس از Restore، Publisherها **متوقف می‌مانند** تا تصمیم آشتی (همان `backup-restore-drill.md:79-80`: «restored outboxes never
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

**نگهبان‌ها — همه‌ی هم‌خانواده‌ها وارسی شد** (هرکدام که بی‌تغییر از Staging دفاع نمی‌کند، PR S7 آن را می‌بندد و آزمون منفی می‌گذارد):

| #   | نگهبان / مسیر                                                                                                       | وضعیت در برابر Staging روی همین میزبان                                                                          | اقدام                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Seed (`packages/config/src/seed-guard.ts:10-22`)                                                                    | `staging` را رد می‌کند و نشان پایگاه را می‌خواهد؛ پایگاه Staging نشان ندارد                                     | آزمون منفی: Seed با `NODE_ENV=test` و `RASTA_ALLOW_DEMO_SEED=true` روی پایگاه شکل Staging ← رد                                           |
| 2   | نشان یک‌بارمصرف پس از Restore (`disposable-marker.bash:24-27`؛ `docs/deployment/README.md:293-297`)                 | Dump ـِ توسعه نشان را به Cluster ـِ Staging می‌برد                                                              | Preflight ـِ استقرار و Restore ـِ Staging: هر پایگاه با `rasta.disposable_database` ← توقف؛ Restore آن را `RESET` می‌کند                 |
| 3   | Broker (`scripts/disposable-broker.mjs:25-35`)                                                                      | فقط به Flag ـِ فراخواننده اعتماد می‌کند                                                                         | Broker ـِ Staging از میزبان در دسترس نیست (بی Publish)؛ نگهبان پیش از هر تغییر `CLUSTER_ID` را می‌خواند و `rasta-staging-*` را رد می‌کند |
| 4   | E2E (`tests/e2e/src/target-guard.ts:13-25`، `:29-41`)                                                               | «Loopback = یک‌بارمصرف» روی این میزبان نادرست است: Edge ـِ Staging روی `127.0.0.1` است؛ دفاع فقط نشان Realm است | آزمون منفی: Realm ـِ بی نشان رد می‌شود؛ رد صریح Realm با `rasta.staging_stack`                                                           |
| 5   | `infra:reset` (`package.json:109`: `docker compose down -v`) و `db:*` (`:114-117`، `scripts/postgres-exec.bash:25`) | `COMPOSE_PROJECT_NAME` در Shell بر `name: rasta` غلبه می‌کند ← `down -v` روی Staging                            | `infra-preflight` با `COMPOSE_PROJECT_NAME`/`COMPOSE_FILE` ـِ غیر `rasta` رد می‌کند؛ فرمان‌های Staging هرگز آن را Export نمی‌کنند        |
| 6   | تمرین Backup (`backup-restore-drill.md:18-20`، `:150-151`)                                                          | پروژه‌ی یکتا، `.env` را رد می‌کند، Stack ـِ مشترک را Reset نمی‌کند                                              | بی تغییر؛ Backup ـِ Staging ابزار جداست                                                                                                  |
| 7   | Kafka ACL (`scripts/kafka-acl.mjs`)                                                                                 | `--profile development` روی Broker ـِ Staging Principalهای آزمون را باز می‌کرد                                  | admin ـِ Staging فقط در فایل Secret ـِ Staging؛ Broker ـِ Staging از میزبان در دسترس نیست                                                |
| 8   | `docker system prune --volumes` / `docker volume prune` (عادت اپراتور، نه در مخزن)                                  | Volume ـِ Containerهای حذف‌شده پاک می‌شود                                                                       | Staging با `stop` خاموش می‌شود نه `down`؛ قاعده‌ی برگه‌ی PM: Prune فقط با `--filter label!=com.rasta.environment=staging`                |
| 9   | آزمون‌های محلی Worker (Testcontainers، `wN-*`)                                                                      | نام و پورت جدا؛ هیچ‌کدام Staging را نمی‌شناسد                                                                   | قاعده‌ی PM: هیچ `docker rm`/`stop` با الگو؛ فقط نام خود Worker                                                                           |
| 10  | **وارونه:** فرمان‌های Staging روی توسعه                                                                             | —                                                                                                               | هر فرمان Staging با `-p rasta-staging` و پیش از هر تغییر، برچسب `com.rasta.environment=staging` ـِ هدف را می‌خواهد؛ نبودش = رد           |

### ۱۱. پیکربندی هم‌شکل Production (کلاس `NODE_ENV`)

Staging با `NODE_ENV=staging` اجرا می‌شود (`packages/config/src/env.ts:14`)، تا Seed (`packages/config/src/seed-guard.ts:12-16`) و PLAINTEXT ـِ Kafka
رد شوند. ولی چند کنترل امروز فقط `production` را می‌شناسد و Staging رفتار توسعه می‌گیرد:

- `allowsDeveloperTooling` = `NODE_ENV !== 'production'` (`packages/config/src/env.ts:893-901`) ← Swagger UI ـِ `/docs` در هر ۱۷ سرویس (مثلاً
  `services/economic-service/src/main.ts:103`)؛
- HSTS فقط در `production` (`services/economic-service/src/main.ts:77`، و همان عبارت در `src/main.ts` ـِ هر سرویس)؛
- Transport ـِ ClamAV (`services/document-service/src/config/env.ts:237`)؛ و قاعده‌ی کمیسیون (`economic` ـِ
  `services/economic-service/src/commission/rule-engine.ts:16`).

تصمیم: یک گزاره، `isProductionShaped(env)` = `staging` یا `production`، در `@rasta/config`؛ همه‌ی مقایسه‌های `=== 'production'`
که امنیت یا درستی را تعیین می‌کنند به آن می‌روند، و آزمون مخزن مقایسه‌ی مستقیم `NODE_ENV` با `'production'` را بیرون از
`@rasta/config` در `services/*` و `packages/*` رد می‌کند (PR S1). نمونه‌برداری Trace هم به تابعی نام‌دار در همان بسته می‌رود
**بی تغییر رفتار** (`docs/12:30`: Staging ۱۰۰٪)، تا ممنوعیت استثنا نداشته باشد. پورتال بیرون از این قاعده است: `next start`
همیشه `NODE_ENV=production` دارد.

### ۱۲. پذیرش امنیت زمان اجرا زیر همان سیاست شبکه

RUN-002 فقط وقتی پذیرفته است که این‌ها **روی Stack ـِ مستقرشده** سنجیده شوند (PR S9)، نه فقط در CI:

1. **ماتریس شبکه:** از درون هر Container (`docker compose exec` با Node ـِ همان Image) اتصال TCP به هر مقصد مجاز ← موفق، و به
   نمونه‌ای از هر مقصد ممنوع (پایگاه سرویس دیگر، Broker از شبکه‌ی بی Kafka، Redis از سرویس بی Cache، یک IP عمومی) ← شکست.
2. **مستاجر و نقش:** از راه Edge و Gateway با دو مستاجر مصنوعی: A داده‌ی B را نمی‌خواند و تغییر نمی‌دهد (`AGENTS.md:118-119`)؛
   نقش‌های فقط‌خواندنی (مثلاً `AUDITOR`) نمی‌نویسند. Suite ـِ پذیرش Staging نگهبان وارونه‌ی E2E را دارد: فقط Realm با
   `rasta.staging_stack` و هرگز با `rasta.disposable_stack`.
3. **تایید مالک برای Consumerهای مالی:** economic بی `MAINTENANCE_SERVICE_URL`، `FLEET_SERVICE_URL` و `CONTRACT_SERVICE_URL` بالا
   نمی‌آید (`services/economic-service/src/config/env.ts:217-227`)؛ زیر شبکه‌ی `to-<svc>`: تایید با توکن داخلی موفق است؛ پاسخ «نه»
   ـِ مالک ← `SOURCE_UNCONFIRMED` و هیچ پاداشی (`reward-trigger.consumer.ts:79-83`)؛ مسیر بسته ← `UPSTREAM_UNAVAILABLE`، باز هیچ.
4. **D-045:** `check:db-runtime-privileges` پس از هر استقرار سبز.
5. **Kafka:** با اعتبار سرویس A، نوشتن در Topic ـِ سرویس B، خواندن بیرون از گروه خودش، اعتبار غلط و PLAINTEXT ← رد (معیارهای
   RUN-006، `planning/backlog.json:1630-1637`). فقط Probeهایی که در صورت رد چیزی نمی‌نویسند؛ آزمون‌های تغییردهنده‌ی Broker هرگز
   روی Staging (§ ۱۰ بند ۳).

### ۱۳. شاهد عمومی

مخزن و PRها عمومی‌اند. **مجاز در PR، STATUS و Artifact:** SHA، Digest، خلاصه‌ی Scan و شناسه‌ی CVE، نام Container و Check، کد خروج،
عددهای منابع، و Hash ـِ SHA-256 ـِ فایل شاهد خصوصی. **هرگز:** مقدار Secret، خروجی `docker inspect` یا `env` (Environment دارد)،
URL ـِ اتصال، Dump، Payload ـِ رویداد، Export ـِ Realm، Log ـِ پالایش‌نشده، نشانی Tunnel. شاهد کامل در
`/home/rasta/staging/evidence/` (`0700`/`0600`) می‌ماند و PR فقط Hash و خلاصه را می‌آورد — همان قاعده‌ی تمرین Restore
(`backup-restore-drill.md:77-78`، `:118`).

## Consequences

- RUN-002 روی rasta-dev **پذیرفتنی است** با دو قید صریح: Staging با داده‌ی مصنوعی و پنجره‌ای (§§ ۲–۳)، و انحراف‌های ثبت‌شده از
  `docs/12`: Compose به‌جای Kubernetes، بی mTLS، بی NetworkPolicy ـِ Object، استقرار Pull به‌جای خودکار.
- RUN-004 روی همین میزبان بسته است تا O-5 یا ماشین دوم.
- کار عامل‌ها بر Staging مقدم است: Staging Swap نمی‌گیرد، CPU ـِ کمتر و OOM ـِ زودتر دارد، و بی حافظه‌ی کافی شروع نمی‌شود.
- سه پیوند شکسته‌ی `docs/12` (§ Context) با PR S10 بسته می‌شوند.

## Alternatives rejected

- **k3s تک‌گره:** root، حافظه‌ی Control Plane و Runtime ـِ دوم (§ ۱).
- **Bind به `0.0.0.0` با قاعده‌ی `DOCKER-USER`:** root می‌خواهد، و قاعده‌ای که خواندنی نیست تایید نمی‌شود.
- **Self-hosted Runner برای Deploy:** کد PR ـِ Fork روی میزبان، و Secret در دسترس CI.
- **Registry محلی:** CI باید به میزبان Push کند.
- **Quick Tunnel:** Issuer ـِ ناپایدار.
- **یک PostgreSQL برای هر سرویس:** ۱۶ فرایند Postgres در حافظه‌ای که اوجش از پیش پر است؛ `pg_hba` با Subnet ـِ هر سرویس همان
  «فقط از سرویس خودش» را می‌دهد.

## Open — تصمیم‌های مالک (شماره‌ی Q را PM واگذار می‌کند)

| شناسه | تصمیم                                                                                                    | پیش‌فرض این ADR تا پاسخ                     |
| ----- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| O-1   | پویش بیرونی پورت‌ها و Firewall ـِ پنل (§ ۴)                                                              | بی آن، معیار «default-deny» پذیرفته نمی‌شود |
| O-2   | ورودی: فقط تونل SSH، یا Tunnel ـِ نام‌دار با دامنه‌ی مالک (DNS و TLS)                                    | فقط تونل SSH؛ CA ـِ Staging                 |
| O-3   | پنجره‌ای یا همیشه‌روشن؛ ذخیره‌ی حافظه؛ آستانه‌ی دیسک؛ سقف هم‌زمانی کار Workerها                          | پنجره‌ای؛ ۸۵٪ دیسک؛ بقیه پس از M-1 و M-4    |
| O-4   | دید GHCR (عمومی/خصوصی)؛ اجباری بودن Attestation؛ دوره‌ی چرخش Secret                                      | عمومی؛ اجباری؛ فقط با محرک                  |
| O-5   | جداسازی واقعی: کاربر جدا و Docker بی‌ریشه (نصب `uidmap` با root) یا ماشین دوم — پیش‌شرط RUN-004          | نیست؛ § ۲                                   |
| O-6   | پذیرش انحراف‌ها: بی mTLS (S-03)، بی NetworkPolicy ـِ Object، بی HA، Pull به‌جای خودکار                   | پذیرفته برای Staging، نه Production         |
| O-7   | Temporal: همان `temporalio/auto-setup` ـِ سنجاق‌شده (`docker-compose.yml:444`) یا Server و Schema ـِ جدا | همان Image؛ انحراف ثبت‌شده                  |

## آنچه ادعا نمی‌شود

- هیچ چیز ساخته یا مستقر نشده است؛ هیچ معیار RUN-002 با این PR برآورده نمی‌شود.
- عددهای بودجه‌ای که M-1 تا M-4 می‌خواهند **حدس زده نشده‌اند**؛ ۸۵٪ و `14443` پیشنهادند، نه اندازه‌گیری.
- Staging روی این میزبان در برابر عامل‌هایی که همین کاربر را دارند امن نیست (§ ۲) و ادعای آن هم نمی‌شود.
- تمرین Restore ـِ موجود بازیابی توزیع‌شده را ثابت نمی‌کند (§ ۹).
