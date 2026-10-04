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

**Check فایل‌ها را همان‌طور می‌خواند که مصرف‌کننده‌شان (بازبینی Codex روی #215):**

- **Compose و Workflow با Parser واقعی YAML** (`yaml`، با `merge: true`): Anchor، Alias و کلید ادغام `<<` حل می‌شوند و کلید
  نقل‌قول‌دار (`'image':`) کلید است — همان چیزی که `docker compose config` و Runner می‌بینند. هر سرویس در **هر** Profile
  بررسی می‌شود؛ `extends` در همان فایل دنبال می‌شود؛ درون‌یابی Compose (`${VAR:-default}`) پیش‌فرض را می‌سنجد.
- **هر Script Shell** — هر `run:` Workflow و هر `.sh` زیر `infrastructure/` و `scripts/` — به فرمان‌هایش شکسته می‌شود: در
  `;`، `&&`، `||`، `|`، `&`، سطر تازه و پرانتز، با ادامهٔ `\` پیوسته، نقل‌قول و توضیح و Here-document محترم، و `$(…)` و
  Backtick و Here-documentی که به `bash`/`sh` داده شود همچون Script جدا. **هر** فرمان `docker` طبقه‌بندی می‌شود:
  `run`/`create`/`pull` (و `container run|create`، `image pull`) تصویرشان سنجیده می‌شود؛ `tag` برچسب محلی می‌سازد؛
  `compose` فقط با `docker-compose.yml`؛ فعل‌های بی‌تصویر (`exec`، `logs`، `rm`، …) آزادند.
- **بسته شکست می‌خورد:** `include:`، `build:` یا `extends: file:` در Compose؛ متغیر بی پیش‌فرض؛ عبارت GitHub جز
  `${{ env.X }}`؛ فعل، گزینه یا گزینهٔ سراسری ناشناختهٔ `docker` (مثلاً `docker build`)؛ Scriptی که قابل شکستن نیست.

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

همه در `scripts/check-dockerfile-pins-lib.mjs`، هرکدام **دقیق** و با دلیل؛ ورودی‌ای که دیگر به کار نمی‌آید خودش خطاست.

- **`DIGEST_VARIANTS`** — Repositoryای که عمداً با چند Digest Pin شده، با **فهرست دقیق** همان Digestها. امروز فقط
  `cgr.dev/chainguard/minio-client` با دو Digest: گونهٔ `-dev` برای `minio-init` در Compose (Shell اسکریپتش) و گونهٔ ساده
  برای CI (`mc` نقطهٔ ورود، `MC_IMAGE`). Digest سوم رد می‌شود؛ Digest فهرست‌شده‌ای که دیگر کسی به کار نمی‌برد هم.
- **`TAGLESS`** — ارجاع‌های دقیق `repository@sha256:…` که بی برچسب پذیرفته‌اند؛ هر تصویر دیگری که فقط Digest دارد رد می‌شود
  (`has no tag`). امروز سه تصویر Chainguard: `cgr.dev/chainguard/minio` و دو گونهٔ `minio-client`. **چرا:** از #88 فقط
  با Digest Pin شده‌اند، و اینکه Registry برای این Digestها برچسب نسخه منتشر می‌کند یا نه **راستی‌آزمایی نشد**: محیط نویسندهٔ
  #215 به `cgr.dev`، `images.chainguard.dev` و `edu.chainguard.dev` راه ندارد (Egress Proxy، ۴۰۳). هر کس دسترسی دارد:

  ```bash
  crane ls cgr.dev/chainguard/minio
  crane digest cgr.dev/chainguard/minio:<tag>   # همان Digest؟ پس برچسب را بیفزایید و ورودی را از TAGLESS بردارید
  ```

- **برچسب محلیِ تصویر Pin‌شده** — `docker tag <pinned> rasta/clamav-pinned:ci` و سپس `docker run rasta/clamav-pinned:ci`،
  حتی در Step بعدی همان Workflow، پذیرفته است، چون همان تصویر است؛ برچسب محلیِ تصویری بی Digest نه.
- **فرمانی که Check نمی‌تواند طبقه‌بندی کند ولی درست است** — توضیحی روی سطر همان فرمان یا سطر بالای آن:
  `# image-pin-exempt: <چرا>`. دلیل الزامی است؛ نشانهٔ بی دلیل خطاست. امروز هیچ فرمانی معاف نیست.
- **گزینهٔ ناشناختهٔ `docker run`** — آن را به `VALUE_FLAGS` یا `BOOL_FLAGS` همان فایل بیفزایید (با آزمون).

## آنچه این Runbook پوشش نمی‌دهد

- Dockerfileهای سرویس‌ها — [base-image-update](base-image-update.md).
- ابزارهای دستی بیرون از Compose و CI که هنوز با برچسب‌اند: `scripts/verify-grafana-dashboard-live.mjs` (`IMAGES`)،
  پیش‌فرض `EVIDENCE_PG_IMAGE` در `scripts/aggregation-evidence.mjs`، و پیش‌نویس Workflow کارزار ADR-055 در
  `docs/evidence/adr-055/` با اعتبارسنج آن (`CAMPAIGN_SERVICE_IMAGE`).
- برچسب خوانا برای دو تصویر Chainguard (`minio`، `minio-client`) — بالا، `TAGLESS`.
