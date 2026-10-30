# استقرار

> معماری کامل در [`../12-deployment-architecture.md`](../12-deployment-architecture.md).
>
> **هدف: Production-Ready Architecture — نه Production Certification.**

---

## محیط‌ها

| محیط        | استقرار                     | داده               | Trigger           |
| ----------- | --------------------------- | ------------------ | ----------------- |
| Development | Docker Compose + `pnpm dev` | Seed نمایشی        | دستی              |
| Test / CI   | Testcontainers (افمرال)     | Fixture یک‌بارمصرف | هر Push           |
| Staging     | Kubernetes + Helm           | داده مصنوعی        | خودکار از `main`  |
| Production  | Kubernetes + Helm           | داده واقعی         | **دستی با تأیید** |

## توسعه محلی

```bash
pnpm install
cp .env.example .env
pnpm infra:up
pnpm db:migrate && pnpm db:seed
pnpm dev
```

پروفایل‌های اختیاری:

```bash
docker compose --profile tools up -d           # Kafka UI، Temporal UI، Mailpit
docker compose --profile search up -d          # OpenSearch
docker compose --profile observability up -d   # OTel، Prometheus، Grafana
docker compose --profile all up -d
```

**داشبورد محلی شواهد حسابرسی.** با Profile ‏`observability` (یا `all`)، Grafana در `http://localhost:3001` است و داشبورد
Provision‌شدهٔ **`Rasta Audit Evidence`** در پوشهٔ `Rasta` در `http://localhost:3001/d/rasta-audit-evidence` باز می‌شود (ورود با
Credential محلی Compose). داشبورد و Datasource (UID ‏`rasta-prometheus`) از فایل‌های مخزن بار می‌شوند: حذف یا ذخیره از UI پذیرفته
نمی‌شود و تغییر JSON در `infrastructure/docker/grafana/dashboards/` ظرف حدود ۱۰ ثانیه دیده می‌شود. **فقط محلی:** مخزن
Alertmanager و تحویل اعلان ندارد، پیکربندی Scrape محیط واقعی بیرون از مخزن است، و نبودن هشدار در داشبورد اثبات کامل بودن شواهد
حسابرسی نیست ([`../13-observability.md`](../13-observability.md) § ۱۳٫۷). Panelهای سرویس فقط وقتی داده دارند که سرویس‌ها روی
میزبان در حال اجرا باشند. Grafana محلی Compose گزارش استفاده، بررسی به‌روزرسانی Grafana و Plugin، خبرنامه، دانلود Pluginهای
Preinstall و دانلود کلیدهای امضای Plugin را با متغیرهای `GF_*` خاموش دارد و فایل‌های بی‌اثر `provisioning/plugins/rasta.yml` و
`provisioning/alerting/rasta.yml` را بار می‌کند که هیچ Plugin، قاعدهٔ هشدار، Contact Point یا Policy فراهم نمی‌کنند؛ پس نخستین
راه‌اندازی به grafana.com وابسته نیست و Log آن خطای Provisioning ندارد. `pnpm run verify:grafana-dashboard-live` همین را روی یک
Stack یک‌بارمصرف در شبکهٔ Docker ‏`--internal` بی Port منتشرشده (Assertionها از یک Container ‏`node:22-alpine` روی همان شبکه) اثبات
می‌کند؛ این شبکهٔ Compose توسعه را محدود نمی‌کند و سیاست شبکهٔ Production نیست. این هم Alertmanager یا تحویل اعلان **نیست**.

## Build تصاویر

```bash
docker build -f services/asset-service/Dockerfile -t rasta/asset-service:$(git rev-parse --short HEAD) .
```

قواعد الزامی هر Image:

```
✅ چندمرحله‌ای — ابزار Build در Image نهایی نیست
✅ اجرا با کاربر غیر ریشه
✅ Base تصویر Alpine یا Distroless
✅ HEALTHCHECK تعریف‌شده
✅ Tag با Commit SHA
🚫 هیچ Secret در Image
🚫 هیچ `.env` در Image
```

## Kubernetes

```bash
# Staging
helm upgrade --install rasta infrastructure/k8s/charts/rasta \
  --namespace rasta-staging --create-namespace \
  --values infrastructure/k8s/charts/rasta/values-staging.yaml \
  --set imageTag=$(git rev-parse --short HEAD) \
  --atomic --timeout 10m

# Production — پس از تأیید دستی
helm upgrade --install rasta infrastructure/k8s/charts/rasta \
  --namespace rasta-prod \
  --values infrastructure/k8s/charts/rasta/values-production.yaml \
  --set imageTag=$TAG \
  --atomic --timeout 15m
```

**`--atomic`** در صورت شکست Health Check، خودکار Rollback می‌کند.

### Sidecar اسکنر بدافزار برای `document-service` — ADR-049

`document-service` **تنها Pod پلتفرم با یک Container دوم** است. ClamAV درون Image
سرویس جاسازی نشده: پایگاه امضا چند بار در روز به‌روز می‌شود و کد سرویس در هر Release،
پس جاسازی هر به‌روزرسانی امضا را به یک Build و Deploy تبدیل می‌کرد.

```yaml
# طرح Pod — مقادیر واقعی در Chart
spec:
  securityContext:
    # هر دو Container باید مالک Socket مشترک باشند. اگر این عوض شود،
    # document-service با EACCES مواجه می‌شود و اسکن Fail-Closed می‌کند.
    fsGroup: 101

  volumes:
    - name: clamav-socket
      emptyDir: {} # عمر یک Pod، دیده‌نشدنی از بیرون آن
    - name: clamav-signatures
      persistentVolumeClaim:
        claimName: clamav-signatures # وگرنه هر Restart ۱۱۰ مگابایت دانلود می‌کند

  containers:
    - name: document-service
      env:
        # مرز Production. هیچ DOCUMENT_CLAMAV_HOST ای اینجا نیست و اگر بود،
        # فرآیند در بوت خارج می‌شد (S-08).
        - name: DOCUMENT_CLAMAV_SOCKET_PATH
          value: /run/clamav/clamd.sock
      volumeMounts:
        - { name: clamav-socket, mountPath: /run/clamav }

    - name: clamav
      image: clamav/clamav@sha256:bda39705e291105049c3936e2803ac90b955172af8030f94f05dce1252df6c6d
      command: ['clamd'] # نه /init، که برای ساخت /run/clamav به root نیاز دارد
      securityContext:
        runAsUser: 100
        runAsGroup: 101
        runAsNonRoot: true
        readOnlyRootFilesystem: true
        allowPrivilegeEscalation: false
        capabilities: { drop: ['ALL'] }
      resources:
        requests: { memory: 1200Mi, cpu: 200m }
        limits: { memory: 1800Mi, cpu: '1' } # پایگاه امضا در حافظه بارگذاری می‌شود
      startupProbe:
        # شروع سرد ده‌ها ثانیه طول می‌کشد و Socket پیش از آمادگی موتور وجود دارد.
        # بررسی پورت یا وجود فایل، Pod را زودتر از موعد آماده اعلام می‌کند.
        exec: { command: ['clamdscan', '--ping', '1'] }
        failureThreshold: 30
        periodSeconds: 10
      volumeMounts:
        - { name: clamav-socket, mountPath: /run/clamav }
        - { name: clamav-signatures, mountPath: /var/lib/clamav, readOnly: true }
        - { name: clamd-config, mountPath: /etc/clamav/clamd.conf, subPath: clamd.conf }

    - name: clamav-freshclam
      image: clamav/clamav@sha256:bda39705e291105049c3936e2803ac90b955172af8030f94f05dce1252df6c6d
      command: ['freshclam', '--daemon', '--foreground']
      securityContext: { runAsUser: 100, runAsGroup: 101, runAsNonRoot: true }
      volumeMounts:
        - { name: clamav-signatures, mountPath: /var/lib/clamav } # نوشتنی
```

**نکته‌های استقرار، هرکدام یک دلیل دارند:**

- **`clamd.conf` تولیدی هیچ `TCPSocket` ندارد.** فایل `clamd.local.conf` که TCP دارد
  فقط برای توسعه و CI است و **نباید** در Production Mount شود. اگر شد، هیچ اتفاقی
  نمی‌افتد جز اینکه یک کانال فرمان بدون احراز هویت باز می‌شود — و NetworkPolicy تنها
  چیزی است که جلویش را می‌گیرد، که همان اتکایی است که S-08 ممنوع می‌کند.
- **`clamd` پایگاه امضا را فقط می‌خواند؛ freshclam می‌نویسد.** Mount یکی
  `readOnly: true` است.
- **بدون `NotifyClamd`.** `SelfCheck` خود clamd تغییر روی دیسک را می‌بیند، به قیمت
  حداکثر ده دقیقه تأخیر و به سود یک وابستگی میان‌کانتینری کمتر.
- **NetworkPolicy خروجی برای freshclam** به `database.clamav.net` لازم است. بدون آن
  به‌روزرسانی بی‌صدا شکست می‌خورد و تنها نشانه‌اش بالا رفتن
  `rasta_document_scan_signature_age_seconds` است.
- **Rollout ترتیب دارد.** `readinessProbe` سرویس، اسکنر را در `checks` گزارش می‌کند اما
  به‌خاطر آن `503` نمی‌دهد: قطعی اسکنر آپلود، فراداده و حذف را نمی‌شکند و دانلود از پیش
  Fail-Closed است. خارج کردن کل سرویس از Rotation سه چیز سالم را بی‌دلیل می‌شکست.

## ترتیب استقرار

```
۱. Job Migration پایگاه داده  ← پیش از Rollout، باید سازگار به عقب باشد
۲. Rolling Update سرویس‌ها     ← maxUnavailable: 0
۳. Smoke Test
۴. در صورت شکست: helm rollback خودکار
```

### گام‌های یک‌باره پس از استقرار

بعضی Migrationها فقط Schema را عوض می‌کنند و نوشتن داده را به دستوری جدا می‌سپارند تا قفل جدول کوتاه بماند. چنین دستوری
خودکار اجرا نمی‌شود و جزو همان انتشار است: پس از Smoke Test اجرا کن و نتیجه را در Change Record ثبت کن.

| انتشار                                                                             | دستور                                                                                                                                                           | Runbook                                                                 |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| economic-service با Migration `20261022120000_transaction_resolved_dispute` (#352) | اول Dry Run: `pnpm --dir services/economic-service db:backfill:resolved-dispute`؛ سپس همان با `--apply`. قابل ادامه با `--after <lastId>`؛ اجرای دوباره امن است | [`resolved-dispute-backfill`](../runbooks/resolved-dispute-backfill.md) |

تا اجرا نشده، حل اعتراض ردیف‌هایی که به آن‌ها نرسیده در پورتال «نامعلوم» نشان داده می‌شود (به اعتراض نمایش‌داده‌شده نسبت
داده نمی‌شود)؛ نسبت غلطی پیش نمی‌آید، ولی این ردیف‌ها تا اجرا اطلاعات کمتری نشان می‌دهند.

### استثنا: نخستین استقرار هماهنگی تمدید نشست پورتال (`apps/web`، PR #113)

نسخه‌های پورتال پیش از این تغییر، وقتی یک Refresh Token دو بار خرج شود و Keycloak دومی را رد کند
(`refreshTokenMaxReuse: 0`)، Cookie نشست را **پاک می‌کنند**؛ و هماهنگی میان Replica ها را ندارند. اگر نخستین استقرارِ
این تغییر با Rolling Update انجام شود، Replica قدیم و جدید همزمان پشت Load Balancer می‌مانند: Replica جدید توکن را
می‌چرخاند و Cookie تازه را برمی‌گرداند، Replica قدیم همان توکن را بی‌قفل خرج می‌کند، رد می‌شود و Cookie را پاک می‌کند —
و ترتیب رسیدن پاسخ‌ها تعیین می‌کند کاربر وارد بماند یا نه.

پس **نخستین استقرار این تغییر نباید با نسخهٔ قدیم پورتال هم‌پوشانی داشته باشد**:

- `strategy: Recreate` برای Deployment پورتال در همین یک استقرار، **یا**
- پیش از بالا آمدن Replica های جدید، Replica های قدیم را از Rotation خارج و Drain کنید.

همین قاعده برای **Rollback** به نسخهٔ پیش از این تغییر هم برقرار است. پورتال تاکنون در هیچ محیط ماندگاری مستقر نشده،
پس «رقص دو انتشار» لازم نیست؛ از استقرار دوم به بعد Rolling Update عادی درست است (بازبینی Codex #113 R2-5، ADR-059).
`WEB_REDIS_URL` هم در production الزامی است و بی آن پورتال بالا نمی‌آید.

### پیش از انتشار economic-service با تسویهٔ بسته در خطا: قواعد صفر درصد پایلوت (docs/24 Q-29، Q-08)

از این انتشار، بیرون از `development` و `test` تسویهٔ تراکنشی که خط کسب‌وکار دارد و هیچ قاعدهٔ کارمزد فعالی خطش را
نمی‌پوشاند با `422 NO_ACTIVE_RULE` رد می‌شود (`ECONOMIC_SETTLEMENT_REQUIRE_COMMISSION_RULE`؛ `false` آنجا هنگام راه‌اندازی رد
می‌شود). پایلوت با یک قاعدهٔ **صفر درصدِ صریح** برای هر خط اجرا می‌شود، پس **پیش از** این انتشار در هر محیط ماندگار:

1. **فهرست خشک:** برای هر هفت خط `GET /v1/commissions/rules?businessLine=<LINE>` با `SYSTEM_ADMIN` سکو؛ هنوز چیزی نساز.
2. برای هر خطی که قاعدهٔ سراسری نافذ ندارد یک `POST /v1/commissions/rules` با `rateBasisPoints: 0` و برچسب پایلوت.
3. فهرست را دوباره بگیر: هر خط دقیقاً یک قاعدهٔ سراسری نافذ؛ نتیجه را در Change Record ثبت کن.

جزئیات، بدنهٔ درخواست و پاسخ به `409`: Runbook [`settlement-no-active-rule`](../runbooks/settlement-no-active-rule.md). اگر انتشار
زودتر برسد پولی جابه‌جا نمی‌شود، ولی تسویهٔ خطوط بی‌قاعده تا ساخت قاعده رد می‌شود و هشدار `RastaSettlementNoActiveRule` می‌آید.
از همین انتشار تعهد **تازه** بی `businessLine` در `POST /v1/transactions` با `422 BUSINESS_LINE_REQUIRED` رد می‌شود، جز سفارش
Marketplace که خود marketplace-service ثبت می‌کند؛ هر فراخوان دیگری که امروز بی خط می‌فرستد پیش از انتشار باید خط را بفرستد.
ردیف‌های بی‌خطِ پیشین، سفارش Marketplace و صورت‌وضعیت (تا پاسخ Q-130) رد نمی‌شوند و مانند پیش با صفر تسویه می‌شوند.

## Rollback

```bash
helm rollback rasta -n rasta-prod              # به نسخه قبل
helm history rasta -n rasta-prod               # مشاهده تاریخچه
```

**قاعده.** چون Migration همیشه سازگار به عقب است، Rollback کد بدون Rollback Schema کار
می‌کند. Migration بازگشت‌ناپذیر در یک استقرار واحد **ممنوع** است.

## دام رایج: `OIDC_ISSUER_URL` در برابر `OIDC_JWKS_URI`

این دو متغیر عمداً جدا هستند و **معمولاً مقدار یکسانی ندارند**:

| متغیر             | ماهیت                          | مقدار در Container                                        |
| ----------------- | ------------------------------ | --------------------------------------------------------- |
| `OIDC_ISSUER_URL` | **شناسه** برای مقایسه با `iss` | همان چیزی که Keycloak در توکن می‌گذارد (نام میزبان عمومی) |
| `OIDC_JWKS_URI`   | **نشانی** برای دریافت کلید     | نشانی قابل دسترس از شبکه داخلی                            |

اگر هر دو را برابر بگذارید، سرویس داخل Docker با این خطا هر توکن معتبری را رد می‌کند:

```json
{ "code": "TOKEN_INVALID", "message": "Token is not valid" }
```

**علت:** توکن با `iss = http://localhost:8080/realms/rasta` صادر شده (نشانی‌ای که
مرورگر می‌بیند)، اما Container انتظار `http://keycloak:8080/realms/rasta` را دارد.
اعتبارنامه‌ها درست‌اند؛ مقایسه `iss` شکست می‌خورد.

**راه درست:** `OIDC_ISSUER_URL` را برابر نشانی عمومی Keycloak بگذارید و
`OIDC_JWKS_URI` را برابر نشانی داخلی. در Production هر دو یکسان می‌شوند، چون
`KC_HOSTNAME` یک نشانی پایدار برای همه است.

## پیکربندی

| نوع                         | مکانیزم                                 |
| --------------------------- | --------------------------------------- |
| غیرحساس (Feature Flag، URL) | ConfigMap                               |
| حساس (رمز، کلید، توکن)      | Secret از External Secrets Operator     |
| پویا در زمان اجرا           | جدول پیکربندی در پایگاه داده سرویس مالک |

## Health Check

| Probe     | Endpoint          | بررسی                                |
| --------- | ----------------- | ------------------------------------ |
| Startup   | `/health/startup` | Migration اجرا شده، Consumerها متصل  |
| Liveness  | `/health/live`    | فرایند پاسخ می‌دهد                   |
| Readiness | `/health/ready`   | پایگاه داده + Kafka + Redis در دسترس |

**قاعده.** `ready` فقط وابستگی‌های **ضروری** را بررسی می‌کند. بررسی بیش از حد باعث
آبشار قطعی می‌شود.

## Backup

| مورد            | Staging | Production                              |
| --------------- | ------- | --------------------------------------- |
| Backup کامل     | روزانه  | روزانه، رمزنگاری‌شده، به Object Storage |
| Point-in-Time   | ندارد   | WAL Archiving — RPO ≤ ۵ دقیقه           |
| **تست Restore** | دستی    | **ماهانه، خودکار، با گزارش**            |

**CONSTRAINT.** یک Backup که Restore آن تست نشده، Backup نیست. تست ماهانه شامل بازیابی
کامل، اجرای Migration، و **اثبات توازن دفتر کل** پس از بازیابی است.

## Demo seeds

Seedهای نمایشی (`services/*/prisma/seed.ts`) فقط در پایگاه داده‌ای می‌نویسند که نشانِ
`rasta.disposable_database=true` را در تنظیمات سطح پایگاه داده داشته باشد (`packages/config`، `assertDemoSeedDatabase`).
این نشان را فقط Bootstrap توسعه/CI (`infrastructure/docker/postgres/00-init-databases.sh`) و **فقط روی پایگاه داده‌ای
که خودش در همان اجرا ساخته** می‌گذارد؛ پایگاه دادهٔ ازپیش‌موجود هرگز نشان نمی‌خورد. برای Volume توسعهٔ قدیمی،
`pnpm db:mark-disposable` (فقط داخل Container محلی `postgres`).

**ریسک باقی‌مانده — Restore.** نشان جزء خود پایگاه داده است: Dumpی از پایگاه دادهٔ توسعه که تنظیمات پایگاه داده را
با خود می‌برد (`pg_dump --create` یا `pg_dumpall`) نشان را هم می‌برد، و Restore آن در Cluster دیگر آن پایگاه داده را
برای Seed پذیرفتنی می‌کند. پس **Dump توسعه را هرگز در Cluster غیریک‌بارمصرف Restore نکن**؛ و اگر لازم شد، پس از
Restore بلافاصله `ALTER DATABASE <db> RESET rasta.disposable_database` را با Superuser اجرا کن. طرح هویت Stack
(نشانی که به Cluster گره بخورد) عمداً ساخته نشده است.

## اهداف RPO و RTO

| سرویس                       | RPO         | RTO        |
| --------------------------- | ----------- | ---------- |
| `economic` · `audit`        | **۵ دقیقه** | **۱ ساعت** |
| `identity` · `organization` | ۱۵ دقیقه    | ۲ ساعت     |
| بقیه                        | ۱ ساعت      | ۴ ساعت     |

## نکته مهم درباره Outbox

چون رویدادها ابتدا در جدول `outbox_message` ثبت می‌شوند و بعد منتشر، **از دست رفتن Kafka
باعث از دست رفتن رویداد نمی‌شود** — فقط تأخیر. این یکی از دلایل اصلی انتخاب الگوی Outbox بود.
