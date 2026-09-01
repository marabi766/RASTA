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
      image: clamav/clamav@sha256:f0954d679017eb6d48221e2b2be3ac5457bf278a844f39b672376f55a085f591
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
      image: clamav/clamav@sha256:f0954d679017eb6d48221e2b2be3ac5457bf278a844f39b672376f55a085f591
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

## اهداف RPO و RTO

| سرویس                       | RPO         | RTO        |
| --------------------------- | ----------- | ---------- |
| `economic` · `audit`        | **۵ دقیقه** | **۱ ساعت** |
| `identity` · `organization` | ۱۵ دقیقه    | ۲ ساعت     |
| بقیه                        | ۱ ساعت      | ۴ ساعت     |

## نکته مهم درباره Outbox

چون رویدادها ابتدا در جدول `outbox_message` ثبت می‌شوند و بعد منتشر، **از دست رفتن Kafka
باعث از دست رفتن رویداد نمی‌شود** — فقط تأخیر. این یکی از دلایل اصلی انتخاب الگوی Outbox بود.
