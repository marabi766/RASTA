# ADR-074 implementation plan — Staging روی rasta-dev

- **ADR:** [ADR-074](ADR-074-staging-on-a-single-host.md) · **Backlog:** RUN-002 (سپس RUN-003، RUN-004)
- **وضعیت:** طرح؛ هیچ PR ـِ این فهرست جز S0 شروع نشده است
- **قاعده‌ی اندازه** (`~/pm-board/pre-review-checklist.md`، «Size and stacking»): آن قاعده برای صفحه و فرمان نوشته شده است؛
  اینجا به این معنا خوانده می‌شود: **هر PR یک دغدغه‌ی استقرار، با حداکثر دو فرمان یا Artifact ـِ تازه**. PRی که بیشتر بخواهد،
  پیش از شروع تقسیم می‌شود.
- **وابستگی بیرونی:** کار W#8 828 (ساخت و Scan ـِ تصویر روی Train و `main`) پیش از S3 ادغام شده باشد.

## ترتیب

```
S0 (این PR) ─┬─ S1 (کلاس NODE_ENV)
             ├─ S2a ─ S2b ─ S3 (انتشار) ─────────────┐
             ├─ S4 (Compose و سیاست) ─ S5a ─ S5b ─ S6 ┼─ S8 (فرمان‌های استقرار) ─ S9 (پذیرش و تمرین‌ها) ─ S10
             └─ S7 (نگهبان‌ها) ─────────────────────────┘
```

S1، S2a، S4 و S7 به هم وابسته نیستند و می‌توانند هم‌زمان جلو بروند. S8 نخستین PR ـِ است که روی میزبان چیزی **اجرا** می‌کند.

## PRها

| PR  | دامنه                                                                                                                                                                                                                                                                  | شاهد پذیرش                                                                                                                                                                                                                              | مالک؟ |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| S0  | همین ADR و برنامه؛ اشاره‌ی کوتاه در `docs/12` § ۱۲٫۱                                                                                                                                                                                                                   | Prettier، `git diff --check`، CI سبز                                                                                                                                                                                                    | —     |
| S1  | `isProductionShaped` در `@rasta/config`؛ Swagger، HSTS، ClamAV transport و قاعده‌ی کمیسیون به آن؛ آزمون مخزن که `NODE_ENV === 'production'` را بیرون از `@rasta/config` رد کند (ADR § ۱۱)                                                                              | Unit ـِ گزاره؛ آزمون مخزن با Fixture ـِ ممنوع؛ Int-spec: سرویس با `NODE_ENV=staging` ← بی `/docs` و با HSTS؛ Mutant: برگرداندن یک سطر ← آزمون مخزن قرمز                                                                                 | —     |
| S2a | Dockerfile ـِ `apps/web` (غیرریشه، `next start`، HEALTHCHECK)؛ `container-scope-lib` همه‌ی Dockerfileهای Deployable را بیابد؛ آزمون فهرست Deployable                                                                                                                   | Build و Trivy ـِ `web` در CI؛ آزمون: حذف یک Dockerfile از Matrix ← قرمز؛ `container-scope-proof` سبز                                                                                                                                    | —     |
| S2b | هدف `migrate` در Dockerfile هر سرویس (همان Stage ـِ `build`)؛ تصویر `staging-bootstrap` (init ـِ PostgreSQL، اسکریپت‌ها و ACL ـِ Kafka، `topics.txt`، Realm ـِ Staging)                                                                                                | CI: هر `migrate` روی پایگاه یک‌بارمصرف `migrate deploy` می‌کند و Container ـِ سرویس با همان پایگاه بالا می‌آید؛ `assertNoMigratorCredentials` همچنان روی تصویر اجرا                                                                     | —     |
| S3  | Job ـِ `publish` فقط روی Push به `main`: GHCR با Digest، Trivy روی همان Digest (JSON و SARIF)، `release-<sha>.json`، Attestation (اگر O-4 بگوید)                                                                                                                       | اجرای `main`: Manifest با Digest و Scan ـِ همه‌ی Deployableها؛ اجرای PR و Train: `publish` ـِ Skip با دلیل؛ آزمون Workflow که `if` را برای `pull_request` و `mq/train-*` رد کند؛ `gh attestation verify` روی میزبان (فقط کد خروج در PR) | O-4   |
| S4  | `infrastructure/staging/services.json`، سازنده‌ی `compose.yml`، و `staging-policy` (ADR §§ ۳، ۴، ۷: Bind، شبکه، سقف‌ها، Digest، بی `container_name`، برچسب، ماتریس از Env)؛ `check-dockerfile-pins` فایل Staging را هم بخواند                                          | آزمون سیاست با یک Fixture ـِ ناقض برای **هر** قاعده (رد)، و فایل واقعی (پذیرش)؛ آزمون برابری `services.json` با `compose.yml`؛ Mutant ـِ هر قاعده                                                                                       | O-7   |
| S5a | `scripts/staging/generate-secrets.mjs` (`0600`، بی بازنویسی، رد درون Worktree، رد مقدار توسعه، پیشوند `rstg_`)؛ قاعده‌ی Gitleaks و Semgrep برای پیشوند                                                                                                                 | Unit: هر رد؛ نمونه‌ی ساختگی `rstg_` را Gitleaks و Semgrep می‌گیرند؛ هیچ مقدار در stdout                                                                                                                                                 | —     |
| S5b | Bootstrap ـِ PostgreSQL ـِ Staging (`pg_hba` با Subnet هر سرویس، `hostssl`، مهاجر `NOLOGIN`، بی نشان یک‌بارمصرف، نقش جدا برای Keycloak و Temporal)؛ Broker با `deployment` و `CLUSTER_ID` ـِ `rasta-staging-*`                                                         | Int روی Cluster ـِ یک‌بارمصرف: سرویس A با گذرواژه‌ی درست از Subnet ـِ B رد؛ مهاجر بیرون از پنجره رد؛ `check:db-runtime-privileges` سبز؛ هیچ پایگاه نشان ندارد                                                                           | —     |
| S6  | Realm ـِ Staging (بی کاربر، بی ROPC، Secret ـِ Client تزریقی، `rasta.staging_stack`)؛ ACL ـِ Redis؛ کاربر MinIO ـِ سرویس؛ پیکربندی Edge (فهرست سفید مسیر)                                                                                                              | آزمون Realm: هیچ `users`، هیچ `directAccessGrantsEnabled: true`، بی `rasta.disposable_stack`؛ آزمون Edge: `/admin` و Realm ـِ دیگر ← ۴۰۴                                                                                                | O-2   |
| S7  | نگهبان‌های ADR § ۱۰ ردیف‌های ۱–۵ و ۱۰: `CLUSTER_ID` در نگهبان Broker، رد Realm ـِ Staging در E2E، `COMPOSE_PROJECT_NAME` در `infra-preflight`، Preflight ـِ نشان یک‌بارمصرف                                                                                            | یک آزمون منفی برای هر ردیف (رد پیش از هر اثر، با Recorder ـِ `docker` و Socket ـِ شنونده، الگوی `disposable-broker.test.mjs`)؛ Mutant ـِ هر نگهبان                                                                                      | —     |
| S8  | `scripts/staging/` با `up`، `deploy`، `rollback` و `stop` (حداکثر دو فرمان در هر PR؛ اگر لازم شد S8a و S8b): Preflight حافظه و دیسک، بررسی Manifest و Attestation، Migrate-then-deploy، دروازه‌ی Saga، Smoke؛ **نخستین بالا آمدن روی میزبان** و اندازه‌گیری M-1 تا M-3 | Unit و Int ـِ فرمان‌ها با Recorder؛ روی میزبان: شاهد خصوصی در `/home/rasta/staging/evidence/`، در PR فقط Hash و خلاصه؛ عددهای M-1 تا M-3 در STATUS                                                                                      | O-3   |
| S9  | Suite ـِ پذیرش (ADR § ۱۲: ماتریس شبکه، مستاجر و نقش، تایید مالک مالی، D-045، Kafka)؛ تمرین Rollback و تمرین Migration ـِ شکست‌خورده (ADR § ۸ بند ۵)                                                                                                                    | گزارش JSON ـِ پذیرش (هر Probe: انتظار، نتیجه)؛ شاهد بیرونی O-1                                                                                                                                                                          | O-1   |
| S10 | Runbookها: `staging-operations.md`، `secret-leak.md` و Restore ـِ Staging (ADR § ۹)؛ به‌روزرسانی `docs/12` §§ ۱۲٫۱، ۱۲٫۴–۱۲٫۸ و پیوندهای شکسته                                                                                                                         | Prettier؛ هر پیوند `docs/12` به فایل موجود؛ Evidence ـِ RUN-002 را PM در Backlog ثبت می‌کند                                                                                                                                             | O-6   |

## گام‌هایی که مالک باید بردارد

| گام                                                 | پیش از        | شکل                                                         |
| --------------------------------------------------- | ------------- | ----------------------------------------------------------- |
| O-4: دید GHCR، اجباری بودن Attestation، چرخش Secret | S3            | پاسخ در برگه‌ی PM                                           |
| O-7: Image ـِ Temporal                              | S4            | پاسخ                                                        |
| O-2: ورودی (تونل SSH یا Tunnel ـِ نام‌دار با دامنه) | S6            | اگر Tunnel: دامنه و DNS در Cloudflare ـِ مالک؛ TLS آنجا     |
| O-3: پنجره‌ای یا همیشه‌روشن، آستانه‌ها              | S8            | پس از M-1 و M-4                                             |
| O-1: پویش بیرونی و Firewall ـِ پنل                  | پذیرش S9      | `nmap -Pn -p 1-65535 <public-ip>` از ماشین مالک؛ فقط ۲۲ باز |
| O-6: پذیرش انحراف‌ها                                | پذیرش RUN-002 | پاسخ                                                        |
| O-5: کاربر جدا و Docker بی‌ریشه یا ماشین دوم        | RUN-004       | نیازمند root (`uidmap`)؛ برای RUN-002 لازم نیست             |

اگر کسی root یا پنل میزبانی دارد، فرمان‌های جدول «فرمان‌هایی که مالک … اجرا می‌کند» در ADR § ۴ شاهد اضافه‌اند؛ هیچ گامی به آن‌ها
وابسته نیست.

## آنچه این برنامه شامل نیست

- Kubernetes، Helm و Production (همچنان `docs/12`).
- اندازه‌گیری بار، Alert و Restore ـِ واقعی با تراز دفتر کل در مقیاس (RUN-003).
- هر داده‌ی واقعی یا کاربر Pilot (RUN-004؛ ADR § ۲).
- برآورد امتیاز: RUN-002 همان ۲۱ امتیاز Backlog را دارد؛ این برنامه عددی برایش جعل نمی‌کند.
