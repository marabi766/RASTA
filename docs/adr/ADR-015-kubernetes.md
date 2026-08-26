# ADR-015: Kubernetes + Helm برای استقرار Production

- **وضعیت:** Accepted
- **تاریخ:** 2026-08-26

## Context

۱۷ سرویس Backend، ۲ Frontend و چند Worker باید در محیط‌های Staging و Production مستقر
شوند — با مقیاس مستقل، Rolling Update بدون قطعی، Health Check، مدیریت Secret و
جداسازی شبکه.

مسیر رشد از استان یزد به مقیاس ملی یعنی نیاز به مقیاس افقی بدون بازطراحی استقرار.

## Decision

**Kubernetes** برای Staging و Production، با **یک Helm Chart واحد** که روی فهرست
سرویس‌ها حلقه می‌زند — نه ۱۷ Chart تکراری.

**Docker Compose** فقط برای توسعه محلی.

**قاعده مهم:** هدف **Production-Ready Architecture** است، نه **Production Certification**.
این کدبیس برای استقرار واقعی آماده‌سازی شده اما گواهی بهره‌برداری نگرفته و چنین ادعایی
هم نمی‌شود.

## Alternatives Considered

| گزینه                        | مزیت                    | عیب                                                     | چرا رد شد                        |
| ---------------------------- | ----------------------- | ------------------------------------------------------- | -------------------------------- |
| Docker Compose در Production | ساده‌ترین               | بدون Self-Healing، بدون Rolling Update، بدون مقیاس افقی | برای ۱۷ سرویس ناکافی             |
| Docker Swarm                 | ساده‌تر از K8s          | اکوسیستم در حال افول                                    | ریسک بلندمدت                     |
| Nomad                        | سبک‌تر، یادگیری آسان‌تر | اکوسیستم کوچک‌تر؛ NetworkPolicy ضعیف‌تر                 | جداسازی شبکه یک الزام امنیتی است |
| PaaS مدیریت‌شده              | بدون سربار عملیاتی      | وابستگی به فروشنده؛ ملاحظات میزبانی داده                | داده باید تحت کنترل باشد         |
| Kustomize به‌جای Helm        | بدون Template           | مدیریت ۱۷ سرویس با Overlay پیچیده می‌شود                | حلقه Helm ساده‌تر است            |

## Consequences

**مثبت**

- Self-Healing، Rolling Update بدون قطعی، HPA
- **NetworkPolicy** جداسازی شبکه را تحمیل می‌کند — یک کنترل امنیتی واقعی
- SecurityContext: کاربر غیر ریشه، فایل‌سیستم فقط‌خواندنی، حذف Capability
- یک Chart برای همه سرویس‌ها؛ افزودن سرویس جدید = یک ورودی در `values.yaml`

**منفی**

- پیچیدگی عملیاتی بالا؛ نیازمند دانش Kubernetes در تیم انسانی
- تفاوت میان محیط توسعه (Compose) و Production (K8s) می‌تواند باگ محیطی بسازد
- Helm Template اشکال‌زدایی‌اش دشوارتر از YAML خام است
- هزینه زیرساخت بالاتر از استقرار ساده

## Compliance

**قواعد اجباری هر Deployment:**

- `runAsNonRoot: true` · `readOnlyRootFilesystem: true` · `capabilities.drop: [ALL]`
- `maxUnavailable: 0` در Rolling Update — همیشه ظرفیت کامل
- سه Probe: `startup`، `liveness`، `readiness`
- `requests` و `limits` برای CPU و حافظه
- ServiceAccount اختصاصی به‌ازای هر سرویس — بدون اشتراک هویت

**NetworkPolicy:**

- Deny پیش‌فرض برای Ingress و Egress
- **تنها `api-gateway` از Ingress عمومی ترافیک می‌گیرد**
- هر پایگاه داده فقط از Pod سرویس مالک خودش قابل دسترسی است
- `/metrics` و `/health` فقط از Namespace پایش

**Migration** در یک Job جدا و **پیش از** Rollout اجرا می‌شود و باید سازگار به عقب باشد.

**Rollback** با `helm rollback`؛ `--atomic` در صورت شکست Health Check خودکار برمی‌گرداند.
