# Runbook: به‌روزرسانی تصویرهای زیرساخت (Compose و CI)

**شدت:** ⚪ عملیاتی
**محرک:** وصلهٔ امنیتی یا بازسازی تازهٔ یکی از تصویرهای `docker-compose.yml` یا CI (Postgres، Redis، Kafka، Keycloak،
Temporal، …)؛ یا شکست `pnpm check:dockerfile-pins` با `is not pinned by digest` یا `is pinned at N digests`
**زمان پاسخ هدف:** همان روز، وقتی CI قرمز است

## چرا Digest

هر تصویری که `docker-compose.yml` (همهٔ Profileها) یا CI بالا می‌آورد با **برچسب و Digest** Pin است (L7-45):

```yaml
image: postgis/postgis:16-3.4@sha256:<digest>
```

برچسب اشاره‌گری متحرک است: `16-3.4` با هر بازسازی تصویر پایه یا وصلهٔ بالادستی به لایه‌های دیگری اشاره می‌کند، پس دو
اجرای یک Commit می‌توانستند Postgres یا Kafka یا Keycloak متفاوتی بالا بیاورند و هیچ چیز در بازبینی دیده نمی‌شد. Docker
وقتی Digest هست برچسب را **نادیده می‌گیرد**؛ برچسب فقط برای خواننده است. همان قاعدهٔ Dockerfileهای سرویس‌ها
([base-image-update](base-image-update.md)).

بهای آن: وصلهٔ تازه خودبه‌خود نمی‌رسد؛ با به‌روزرسانی آگاهانهٔ Digest می‌رسد، با همین Runbook.

## کجا Pin شده‌اند

| جا                                     | چه                                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `docker-compose.yml`                   | هر `image:`، در هر Profile (`all`، `observability`، `search`، `tools`)                                    |
| `.github/workflows/*.yml`              | `image:` هر `services:`/`container:`؛ متغیرهای `*_IMAGE` در `env:`؛ تصویر هر `docker run`/`create`/`pull` |
| `infrastructure/docker/kafka/ci-up.sh` | پیش‌فرض `KAFKA_IMAGE` — Brokerی که CI بالا می‌آورد                                                        |

**یک Repository، یک Digest، هر جا که باشد:** Compose و CI همان Postgres، همان Keycloak و همان Broker را اجرا می‌کنند.
`pnpm check:dockerfile-pins` (در `pnpm verify` و Job `quality`) هم تصویر بی Digest را رد می‌کند و هم Repositoryای را که در
دو جا با دو Digest آمده است — و هر دو جا را نام می‌برد.

## به‌روزرسانی

۱. Digest **فهرست چندمعماری (Index)** همان برچسب را بگیرید — نه Digest یک معماری، تا Mac با Apple Silicon و Runner
`amd64` یک تصویر را بخوانند:

```bash
docker buildx imagetools inspect postgis/postgis:16-3.4 | sed -n 's/^Digest: *//p'
docker buildx imagetools inspect postgis/postgis:16-3.4 | sed -n 's/^MediaType: *//p'   # index یا manifest list
```

اگر MediaType یک Manifest تکی است (`postgis/postgis` و `clamav/clamav` فقط `amd64` منتشر می‌کنند)، همان Manifest تنها
چیزی است که می‌شود Pin کرد؛ Index وجود ندارد.

۲. Digest را در **همهٔ** جاهای جدول بالا با هم جایگزین کنید — یک Commit، نه یکی‌یکی:

```bash
old=sha256:<قبلی>; new=sha256:<تازه>
grep -rln "postgis/postgis:16-3.4@${old}" docker-compose.yml .github/workflows infrastructure/docker |
  xargs sed -i "s#postgis/postgis:16-3.4@${old}#postgis/postgis:16-3.4@${new}#g"
pnpm check:dockerfile-pins
docker compose --profile all --profile observability --profile search --profile tools config -q
```

۳. PR را باز کنید. Jobهایی که این Containerها را بالا می‌آورند — `integration`، `migration-reversibility`، `e2e`،
`web-browser`، `broker-authorisation`، `prometheus-rules`، `security`، `clamav-signatures` — تصویر را با همان Digest Pull
می‌کنند؛ Digest اشتباه همان‌جا با `manifest unknown` شکست می‌خورد.

**تغییر نسخه (برچسب)** — مثلاً `16-3.4` به نسخهٔ دیگر — به‌روزرسانی Digest نیست: ارتقای نسخه است و در PR خودش، با
آزمون‌ها و یادداشت‌های ارتقای همان محصول، بازبینی می‌شود.

## استثناها

- **`DIGEST_VARIANTS`** (`scripts/check-dockerfile-pins-lib.mjs`) — Repositoryهایی که عمداً با دو Digest Pin شده‌اند،
  هرکدام با دلیل. امروز فقط `cgr.dev/chainguard/minio-client`: `minio-init` در Compose گونهٔ `-dev` را برای Shell اسکریپتش
  می‌خواهد و CI گونهٔ ساده را که `mc` نقطهٔ ورودش است. ورودی‌ای که دیگر دو Digest ندارد رد می‌شود، تا فهرست کهنه نماند.
- **برچسب محلیِ تصویر Pin‌شده** — `docker tag <pinned> rasta/clamav-pinned:ci` و سپس `docker run rasta/clamav-pinned:ci`
  پذیرفته است، چون همان تصویر است؛ برچسب محلیِ تصویری بی Digest نه.
- **تصویر از متغیر** — فقط `*_IMAGE` در `env:` Workflow و پیش‌فرض `${VAR:-…}` در اسکریپت Shell خوانده می‌شوند. عبارت
  GitHub (`${{ … }}`) یا متغیری که Check نمی‌شناسد رد می‌شود: Check بسته شکست می‌خورد، نه باز.
- **گزینهٔ ناشناختهٔ `docker run`** — رد می‌شود (`cannot tell whether docker option … takes a value`)؛ آن را به
  `VALUE_FLAGS` یا `BOOL_FLAGS` همان فایل بیفزایید.

هیچ تصویری امروز از Pin معاف نیست.

## آنچه این Runbook پوشش نمی‌دهد

- Dockerfileهای سرویس‌ها — [base-image-update](base-image-update.md).
- ابزارهای دستی بیرون از Compose و CI که هنوز با برچسب‌اند: `scripts/verify-grafana-dashboard-live.mjs` (`IMAGES`)،
  پیش‌فرض `EVIDENCE_PG_IMAGE` در `scripts/aggregation-evidence.mjs`، و پیش‌نویس Workflow کارزار ADR-055 در
  `docs/evidence/adr-055/` با اعتبارسنج آن (`CAMPAIGN_SERVICE_IMAGE`).
- برچسب خوانا برای دو تصویر Chainguard (`minio`، `minio-client`): از زمان #88 فقط با Digest Pin شده‌اند.
