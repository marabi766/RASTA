# Runbook: به‌روزرسانی تصویر پایهٔ Node

**شدت:** ⚪ عملیاتی — 🟠 اگر اسکن تصویر روی `main` یا یک PR قرمز شده باشد
**محرک:** شکست گام `Scan image` (Trivy، `CRITICAL,HIGH`، `ignore-unfixed`) در Job `containers`؛ یا انتشار نسخهٔ تازهٔ
`node:22-alpine`
**زمان پاسخ هدف:** همان روز، وقتی اسکن قرمز است

## چرا Digest

هر `services/*/Dockerfile` تصویر پایه را با **Digest** می‌گیرد، نه با برچسب متحرک (L7-45):

```dockerfile
FROM node:22-alpine@sha256:<digest> AS deps
…
FROM node:22-alpine@sha256:<digest> AS runtime
```

و مرحلهٔ `runtime` دیگر `apk upgrade` اجرا نمی‌کند. پس Build دوبارهٔ یک Commit **همان تصویر** را می‌سازد: لایهٔ سیستم‌عامل
دقیقاً همانِ Digest است، نه هر چه مخزن Alpine آن روز داشت. برچسب `22-alpine` کنار Digest فقط برای خوانایی است؛ Docker
فقط Digest را می‌خواند.

بهای این انتخاب: وصلهٔ امنیتی دیگر خودبه‌خود نمی‌رسد. می‌رسد با **به‌روزرسانی آگاهانهٔ Digest** — و اسکن تصویر، که حالا روی هر PR
مؤثر و روی `main` اجرا می‌شود (L7-35)، همان جایی است که نیاز به آن دیده می‌شود.

## به‌روزرسانی

۱. Digest فهرست چندمعماری (Index) تازه را بگیرید — نه Digest یک معماری:

```bash
docker buildx imagetools inspect node:22-alpine | sed -n 's/^Digest: *//p'
```

۲. همان Digest را در **هر دوازده** Dockerfile و در **هر دو** `FROM` جایگزین کنید (یک Digest برای همه؛
`pnpm check:dockerfile-pins` تفاوت را رد می‌کند):

```bash
new=sha256:<digest>
sed -i -E "s#^FROM node:22-alpine@sha256:[0-9a-f]{64} #FROM node:22-alpine@${new} #" services/*/Dockerfile
pnpm check:dockerfile-pins
```

۳. پیش از Push، لایهٔ سیستم‌عامل Digest تازه را با همان تنظیمات CI اسکن کنید:

```bash
docker run --rm aquasec/trivy image --pkg-types os --severity CRITICAL,HIGH --ignore-unfixed \
  --exit-code 1 "node:22-alpine@${new}"
```

۴. PR را باز کنید. چون همهٔ Dockerfileها عوض شده‌اند، Job `containers` هر دوازده تصویر را Build و اسکن می‌کند.

## وقتی اسکن قرمز است و Digest تازه‌ای هم کمک نمی‌کند

گاهی CVE در Alpine رفع شده ولی تصویر رسمی Node هنوز بازسازی نشده است. آنگاه، **موقت و فقط برای همان بسته**:

```dockerfile
# موقت — تا بازسازی node:22-alpine پس از <CVE>؛ با Digest بعدی حذف شود.
RUN apk --no-cache upgrade <package>
```

در مرحلهٔ `runtime`، با شمارهٔ CVE در توضیح. این Build را تا حذف آن خط غیرقابل‌بازتولید می‌کند، پس همراه نخستین Digestی که
وصله را دارد برداشته می‌شود. **هرگز** `apk upgrade` بی‌نام بسته برنگردد، و هرگز `ignore-unfixed` یا شدت اسکن برای سبزکردن
Build شل نشود.

## آنچه این دروازه ادعا می‌کند

اسکن تصویر **یافته‌های HIGH و CRITICAL قابل‌وصله** را رد می‌کند، نه هر HIGH و CRITICAL را. `ignore-unfixed` یافته‌ای را
که هنوز در هیچ نسخه‌ای وصله نشده عبور می‌دهد — عمداً، چون ردکردنش هر PR را برای CVEای قرمز می‌کرد که کسی نمی‌تواند
کاری برایش بکند. چنین یافته‌ای امروز در هیچ جا دنبال نمی‌شود. **کار بعدی ثبت‌شده:** فهرست استثنای بازبینی‌شده و
تاریخ‌دار — یک ردیف `.trivyignore` برای هر CVE، با مالک و تاریخ انقضا — و اجرای دروازه بدون `ignore-unfixed`، تا
یافتهٔ وصله‌نشده دیده شود و استثنایش خودبه‌خود منقضی شود.

## آنچه این Runbook پوشش نمی‌دهد

- تصاویر `docker-compose.yml` (Postgres، Kafka و …) با برچسب نسخه Pin شده‌اند، نه Digest؛ محیط توسعه‌اند و در تصویر تولیدی
  نمی‌نشینند.
- `pnpm@11.22.0` در مرحلهٔ `deps` با نسخهٔ دقیق Pin است و Lockfile بقیهٔ وابستگی‌ها را قفل می‌کند.
