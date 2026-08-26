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
