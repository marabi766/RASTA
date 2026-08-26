# ۱۲ — Deployment Architecture

> محیط‌ها، Docker، Kubernetes، CI/CD، Backup و بازیابی از فاجعه.
>
> **هدف: Production-Ready Architecture — نه Production Certification.**
> این کدبیس برای استقرار واقعی آماده‌سازی شده، اما گواهی بهره‌برداری ملی نگرفته و
> چنین ادعایی هم نمی‌شود.

---

## ۱۲٫۱ محیط‌ها

| محیط            | هدف                                   | داده                        | استقرار                  |
| --------------- | ------------------------------------- | --------------------------- | ------------------------ |
| **Development** | توسعه محلی                            | Seed نمایشی                 | Docker Compose + `pnpm dev` |
| **Test / CI**   | تست خودکار                            | Fixture یک‌بارمصرف          | Testcontainers، افمرال   |
| **Staging**     | تأیید پیش از انتشار، Demo             | داده مصنوعی شبیه Production | Kubernetes، خودکار از `main` |
| **Production**  | بهره‌برداری واقعی                     | داده واقعی                  | Kubernetes، دستی با تأیید |

| ویژگی               | Development | Staging       | Production            |
| ------------------- | ----------- | ------------- | --------------------- |
| Replica هر سرویس    | ۱           | ۱             | ۲–۳                   |
| TLS خارجی           | ❌          | ✅            | ✅                    |
| mTLS داخلی          | ❌          | ✅            | ✅                    |
| MFA                 | اختیاری     | اختیاری       | **اجباری برای نقش‌های حساس** |
| Rate Limit          | سست         | Production    | Production            |
| Backup              | ندارد       | روزانه        | PITR + روزانه         |
| پرداخت              | Mock        | Mock          | **OPEN QUESTION**     |
| Log Level           | debug       | info          | info                  |
| نمونه‌برداری Trace  | ۱۰۰٪        | ۱۰۰٪          | ۱۰٪ + ۱۰۰٪ خطاها      |

---

## ۱۲٫۲ توسعه محلی

```bash
pnpm install
cp .env.example .env
pnpm infra:up          # PostgreSQL, Redis, Kafka, Keycloak, MinIO, Temporal
pnpm db:migrate
pnpm db:seed
pnpm dev
```

`docker compose up` تا حد امکان محیط کامل را بالا می‌آورد. اجزای سنگین پشت پروفایل‌اند تا
لپ‌تاپ توسعه‌دهنده خفه نشود:

```bash
docker compose --profile tools up -d          # Kafka UI، Temporal UI، Mailpit
docker compose --profile search up -d         # OpenSearch
docker compose --profile observability up -d  # OTel، Prometheus، Grafana
docker compose --profile all up -d            # همه
```

---

## ۱۲٫۳ Docker

هر سرویس یک `Dockerfile` چندمرحله‌ای دارد:

```dockerfile
# ---- deps: فقط وابستگی‌ها، برای Cache بهتر لایه ----
FROM node:22-alpine AS deps
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/*/package.json ./packages/
COPY services/<name>/package.json ./services/<name>/
RUN pnpm install --frozen-lockfile

# ---- build ----
FROM deps AS build
COPY . .
RUN pnpm --filter @rasta/<name>... build

# ---- runtime: کوچک، بدون ریشه ----
FROM node:22-alpine AS runtime
RUN addgroup -S rasta && adduser -S rasta -G rasta
WORKDIR /app
COPY --from=build --chown=rasta:rasta /app/services/<name>/dist ./dist
COPY --from=build --chown=rasta:rasta /app/node_modules ./node_modules
USER rasta
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD node -e "require('http').get('http://localhost:'+process.env.PORT+'/health/live',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/main.js"]
```

**قواعد الزامی Image:**

```
✅ چندمرحله‌ای — ابزار Build در Image نهایی نیست
✅ اجرا با کاربر غیر ریشه
✅ Base تصویر Alpine یا Distroless
✅ HEALTHCHECK تعریف‌شده
✅ Tag با Commit SHA (نه فقط latest)
🚫 هیچ Secret در Image
🚫 هیچ `.env` در Image
🚫 هیچ `npm install` در زمان اجرا
```

---

## ۱۲٫۴ Kubernetes

### توپولوژی

```
Namespace: rasta-{env}
│
├── Ingress (nginx) ──► api-gateway Service   ◄── تنها ورودی بیرونی
│
├── Deployments
│   ├── api-gateway         (۳ Replica، HPA بر CPU + RPS)
│   ├── <domain>-service    (۲ Replica هرکدام)
│   ├── temporal-worker-*   (به‌ازای هر Task Queue، HPA مستقل)
│   └── web / admin         (۲ Replica)
│
├── StatefulSets (یا سرویس مدیریت‌شده بیرونی)
│   ├── postgresql
│   ├── redis
│   ├── kafka
│   └── opensearch
│
├── ConfigMaps       پیکربندی غیرحساس
├── Secrets          از External Secrets Operator
├── NetworkPolicies  Deny پیش‌فرض + فهرست سفید صریح
├── PVCs             برای اجزای Stateful
└── ServiceAccounts  یکی به‌ازای هر سرویس (بدون اشتراک هویت)
```

### الگوی Deployment

```yaml
spec:
  replicas: 2
  strategy:
    type: RollingUpdate
    rollingUpdate: { maxSurge: 1, maxUnavailable: 0 }   # بدون قطعی
  template:
    spec:
      serviceAccountName: asset-service
      securityContext:
        runAsNonRoot: true
        runAsUser: 1001
        fsGroup: 1001
      containers:
        - name: asset-service
          image: registry/rasta/asset-service:{{ .Values.imageTag }}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ['ALL'] }
          resources:
            requests: { cpu: 100m, memory: 256Mi }
            limits:   { cpu: 500m, memory: 512Mi }
          startupProbe:   { httpGet: { path: /health/startup, port: 3103 }, failureThreshold: 30, periodSeconds: 5 }
          livenessProbe:  { httpGet: { path: /health/live,    port: 3103 }, periodSeconds: 15 }
          readinessProbe: { httpGet: { path: /health/ready,   port: 3103 }, periodSeconds: 10 }
          envFrom:
            - configMapRef: { name: asset-service-config }
            - secretRef:    { name: asset-service-secrets }
```

**`maxUnavailable: 0`** تضمین می‌کند در حین به‌روزرسانی همیشه ظرفیت کامل در دسترس است.
**`readOnlyRootFilesystem: true`** یک کنترل واقعی است: اگر مهاجم کد اجرا کند، نمی‌تواند
چیزی روی دیسک بنویسد.

### NetworkPolicy (نمونه)

```yaml
# پایگاه داده economic فقط از خود سرویس economic
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: economic-db-access }
spec:
  podSelector: { matchLabels: { app: postgresql, db: economic } }
  policyTypes: [Ingress]
  ingress:
    - from:
        - podSelector: { matchLabels: { app: economic-service } }
      ports: [{ protocol: TCP, port: 5432 }]
```

Egress پیش‌فرض **بسته** است؛ هر خروجی نیازمند فهرست سفید صریح.

### Helm

```
infrastructure/k8s/
├── charts/rasta/
│   ├── Chart.yaml
│   ├── values.yaml              # پیش‌فرض‌های مشترک
│   ├── values-staging.yaml
│   ├── values-production.yaml
│   └── templates/
│       ├── _helpers.tpl
│       ├── deployment.yaml      # حلقه روی .Values.services
│       ├── service.yaml
│       ├── ingress.yaml
│       ├── hpa.yaml
│       ├── networkpolicy.yaml
│       ├── configmap.yaml
│       └── externalsecret.yaml
└── base/                        # Manifestهای خام برای بررسی
```

یک Chart با حلقه روی فهرست سرویس‌ها — نه ۱۷ Chart تکراری.

---

## ۱۲٫۵ CI/CD

### Pipeline

```
Push / Pull Request
   │
   ├─ ۱. Setup            نصب pnpm، بازیابی Cache Turbo
   ├─ ۲. Lint             eslint
   ├─ ۳. Format Check     prettier --check
   ├─ ۴. Type Check       tsc --noEmit
   ├─ ۵. Unit Tests       jest (موازی، با Cache Turbo)
   ├─ ۶. Build            turbo run build
   │
   ├─ ۷. Security
   │     ├─ Secret Scan       Gitleaks       ── هر یافته = شکست
   │     ├─ Dependency Audit  pnpm audit + OSV ── High/Critical = شکست
   │     ├─ SAST              Semgrep + ESLint security
   │     └─ IaC Scan          Trivy config
   │
   ├─ ۸. Integration Tests    Testcontainers (Postgres, Redis, Kafka)
   ├─ ۹. Contract Tests       اعتبارسنجی Schema رویداد و OpenAPI
   ├─ ۱۰. Security Tests      AuthZ · **Tenant Isolation** · Idempotency · Financial
   │
   └─ روی main فقط:
       ├─ ۱۱. Build Images     Docker Buildx، Tag با SHA
       ├─ ۱۲. Container Scan   Trivy ── Critical = شکست
       ├─ ۱۳. Push Registry
       ├─ ۱۴. Deploy Staging   helm upgrade --install
       ├─ ۱۵. Smoke Tests      مسیرهای بحرانی روی Staging
       └─ ۱۶. E2E Tests        Playwright روی Staging
```

**دروازه‌های سخت — بدون امکان دور زدن:**

| دروازه                        | سیاست                                              |
| ----------------------------- | -------------------------------------------------- |
| **تست Tenant Isolation**      | هر شکست = شکست Build. هرگز `--skip`.               |
| **تست مجوزدهی**               | هر شکست = شکست Build.                              |
| **تست یکپارچگی مالی**         | هر شکست = شکست Build.                              |
| **اسکن Secret**               | هر یافته = شکست.                                   |
| **آسیب‌پذیری Critical**       | شکست.                                              |
| **Coverage**                  | افت بیش از ۲٪ نسبت به `main` = هشدار؛ زیر آستانه سرویس = شکست |

### Deploy به Production

```
Tag روی main (v0.x.y)
   │
   ├─ تأیید دستی (محیط محافظت‌شده GitHub)
   ├─ helm upgrade --atomic --timeout 10m
   ├─ Migration پایگاه داده (Job جدا، پیش از Rollout)
   ├─ Rolling Update با Health Check
   ├─ Smoke Test
   └─ در صورت شکست: helm rollback خودکار (`--atomic`)
```

**ترتیب Migration.** Job Migration **پیش از** Rollout اجرا می‌شود و باید سازگار به عقب باشد
(نسخه قدیم و جدید هم‌زمان زنده‌اند). تغییر شکننده = الگوی Expand/Contract در سه استقرار.

---

## ۱۲٫۶ پیکربندی و Secret

| نوع                          | مکانیزم                       |
| ---------------------------- | ----------------------------- |
| غیرحساس (Feature Flag، URL)  | ConfigMap                     |
| حساس (رمز، کلید، توکن)       | Secret از External Secrets Operator |
| پویا در زمان اجرا            | جدول پیکربندی در پایگاه داده سرویس مالک |

**CONSTRAINT.** هیچ Secret واقعی در Repository، در Image، در Log یا در پیام Commit.
همه اعتبارنامه‌ها از محیط تزریق می‌شوند تا چرخش کلید بدون تغییر کد ممکن باشد.

---

## ۱۲٫۷ Backup و بازیابی از فاجعه

### هدف‌ها

| سرویس                        | RPO       | RTO      | دلیل                                      |
| ---------------------------- | --------- | -------- | ----------------------------------------- |
| `economic` · `audit`         | **۵ دقیقه** | **۱ ساعت** | داده مالی و حسابرسی — از دست رفتن غیرقابل قبول |
| `identity` · `organization`  | ۱۵ دقیقه  | ۲ ساعت   | بدون آن‌ها هیچ‌چیز کار نمی‌کند             |
| بقیه سرویس‌های دامنه         | ۱ ساعت    | ۴ ساعت   | قابل بازسازی جزئی از رویدادها             |
| Object Storage               | ۲۴ ساعت   | ۴ ساعت   | Versioning + Replication میان‌منطقه‌ای    |

### راهبرد

| مورد                | MVP                       | Production                                   |
| ------------------- | ------------------------- | -------------------------------------------- |
| Backup کامل         | `pg_dump` روزانه، محلی    | روزانه به Object Storage، رمزنگاری‌شده       |
| Point-in-Time       | ندارد                     | WAL Archiving مستمر                          |
| Kafka               | ندارد                     | RF=3 + Backup Topic حسابرسی                  |
| Object Storage      | ندارد                     | Versioning + Replication                     |
| **تست Restore**     | دستی                      | **ماهانه، خودکار، با گزارش**                 |

**CONSTRAINT.** یک Backup که Restore آن تست نشده، Backup نیست.
تست Restore ماهانه شامل: بازیابی کامل در محیط جدا، اجرای Migration، اجرای تست یکپارچگی
مالی، و **اثبات توازن دفتر کل**.

Runbookها: [`runbooks/restore-database.md`](runbooks/restore-database.md) ·
[`runbooks/disaster-recovery.md`](runbooks/disaster-recovery.md)

### سناریوهای فاجعه

| سناریو                            | پاسخ                                                                |
| --------------------------------- | ------------------------------------------------------------------- |
| از دست رفتن یک Pod                | Kubernetes بازسازی می‌کند؛ بدون اثر (چند Replica)                   |
| از دست رفتن یک گره                | زمان‌بند Podها را جابه‌جا می‌کند                                    |
| خرابی Primary پایگاه داده         | ارتقای Standby؛ RTO ≈ دقایق                                         |
| از دست رفتن کامل پایگاه داده      | Restore از PITR؛ RTO طبق جدول بالا                                  |
| از دست رفتن Cluster کافکا         | رویدادهای منتشرنشده در `outbox` می‌مانند و پس از بازیابی منتشر می‌شوند — **هیچ رویدادی گم نمی‌شود** |
| از دست رفتن کامل منطقه            | DR Site (**OPEN QUESTION** — تصمیم زیرساختی)                        |
| نشت Secret                        | چرخش فوری؛ [`runbooks/secret-leak.md`](runbooks/secret-leak.md)     |

**نکته مهم درباره Outbox.** چون رویدادها ابتدا در پایگاه داده (جدول `outbox_message`)
ثبت می‌شوند و بعد منتشر، از دست رفتن Kafka باعث از دست رفتن رویداد نمی‌شود — فقط تأخیر.
این یکی از دلایل اصلی انتخاب الگوی Outbox بود.

---

## ۱۲٫۸ راهبرد Rollback

| مورد                    | Rollback                                                          |
| ----------------------- | ----------------------------------------------------------------- |
| کد سرویس                | `helm rollback` — خودکار با `--atomic` در صورت شکست Health Check   |
| Migration پایگاه داده   | **همیشه سازگار به عقب** → Rollback کد بدون Rollback Schema کار می‌کند |
| Migration بازگشت‌ناپذیر | ممنوع در یک استقرار واحد؛ فقط با الگوی Expand/Contract             |
| Feature ناقص            | Feature Flag (خاموش کردن بدون استقرار)                             |
| Schema رویداد           | Producer هر دو نسخه را منتشر می‌کند تا همه Consumerها مهاجرت کنند  |

**CONSTRAINT.** یک استقرار که Rollback ندارد، استقرار نیست — یک قمار است.
هر Migration یا `Down` دارد یا صریحاً به‌عنوان بازگشت‌ناپذیر مستند و جداگانه تأیید شده است.
