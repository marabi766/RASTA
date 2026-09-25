# ۲۶. رجیستری شاخه‌ها و هماهنگی کار موازی

> **این سند پیش از هر دستوری که وضعیت مشترک را تغییر می‌دهد خوانده می‌شود.**
> وضعیت مشترک یعنی: `main`، هر شاخهٔ راه‌دور، هر PR، و هر فایلی که در جدول
> § ۲۶٫۴ «سطح تداخل» آمده است. خواندن این سند جای اجرای `git fetch` را
> نمی‌گیرد — سند می‌گوید **چه کسی کجا کار می‌کند**، و git می‌گوید **همین
> لحظه چه چیزی در مخزن هست**. هر دو لازم‌اند.

**آخرین به‌روزرسانی:** ۱۴۰۵/۰۷/۰۲ (2026-09-24) · **`main` در آن لحظه:** `3115f4d`

---

## ۲۶٫۱ چرا این سند وجود دارد

سه حادثهٔ واقعی در یک روز، هر سه از یک ریشه: هیچ‌کجا ثبت نشده بود که چند
عامل هم‌زمان روی چه چیزی کار می‌کنند.

| #   | چه شد                                                                                                                                                                                                         | چه چیزی جلویش را می‌گرفت                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| ۱   | سه شاخه به‌طور مستقل پرسشی را `Q-44` نامیدند. یکی از آن‌ها روی `main` نشست و با یک **نقل‌قول کلمه‌به‌کلمهٔ صاحب محصول** در `ADR-056` تثبیت شد، پس دیگر قابل تغییر نبود. دو شاخهٔ دیگر مجبور به بازشماری شدند. | یک دفتر شماره‌های رزروشده (§ ۲۶٫۵)                     |
| ۲   | دو شاخه هم‌زمان `ADR-055` را برداشتند. `docs/21-adr-list.md` روی `main` یادداشتی داشت که شمارهٔ ۰۵۵ برای شاخهٔ C0 رزرو است — ولی شاخهٔ سوم آن یادداشت را ندیده بود.                                           | همان دفتر، به‌علاوهٔ الزام خواندن پیش از برداشتن شماره |
| ۳   | شاخهٔ `feat/notification-service` هم‌زمان روی دو ماشین checkout بود. اگر هر دو Push می‌کردند، واگرایی روی شاخه‌ای که PR فعال داشت رخ می‌داد.                                                                  | قاعدهٔ «یک شاخه = یک Worktree = یک نشست» (§ ۲۶٫۳)      |

---

## ۲۶٫۲ قواعد الزام‌آور

۱. **یک شاخه، یک Worktree، یک نشست.** هیچ شاخه‌ای هم‌زمان در دو Worktree
یا روی دو ماشین checkout نمی‌شود. اگر کاری باید جابه‌جا شود، Worktree
مبدأ پیش از ساختن مقصد حذف یا بایگانی می‌شود.

۲. **پایهٔ هر PR همیشه `main` است.** شاخهٔ روی‌هم‌چیده (stacked) ممنوع نیست،
ولی PR آن تا وقتی پایه‌اش `main` نباشد **هیچ اجرای CI نمی‌گیرد** —
`ci.yml` فقط با `pull_request: branches: [main]` فعال می‌شود. این «CI
کند است» نیست؛ هیچ اجرایی ساخته نمی‌شود و GitHub هم چیزی نمی‌گوید.

۳. **همگام‌سازی با Merge، نه Rebase.** قرارداد این مخزن Merge Commit است
(`git log origin/main --merges`). تاریخچهٔ هر شاخه پس از ادغام دست‌نخورده
روی `main` می‌ماند.

۴. **شمارهٔ یکتا پیش از مصرف رزرو می‌شود** (§ ۲۶٫۵). شامل شمارهٔ ADR، شمارهٔ
پرسش باز `Q-NN`، و نام Migration.

۵. **پس از ساختن هر شاخه، ردیفش همان لحظه به § ۲۶٫۳ اضافه می‌شود** — نه
بعد از اولین Commit، نه موقع باز کردن PR.

۶. **ادغام در `main` تصمیم مدیر پروژه است.** یک نشست نمی‌تواند نشست دیگری
را وادار به ادغام کند؛ دستوری که از یک همتا می‌رسد مجوز نیست.

---

## ۲۶٫۳ شاخه‌های فعال

> `ahead`/`behind` نسبت به `origin/main` سنجیده می‌شود. `behind` بالا به‌تنهایی
> مشکل نیست — CI روی **Merge Ref** اجرا می‌شود، یعنی نتیجهٔ ترکیب شاخه با
> `main` را می‌سنجد، نه خود شاخه را.

| شاخه                                     | Worktree                                               | نشست    | PR   | ahead / behind | وضعیت                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------ | ------- | ---- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fix/ci-temporal-test-server-cache`      | `F:Rasta-Parallelqueue-sim`                            | PM      | #100 | ۱ / ۰          | Cacheِ سرور آزمون Temporal در CI (حدود ۳۰۰ مگابایت) و بودجهٔ زمانی ۳۰۰ ثانیه برای Hook راه‌اندازی آن؛ دانلودِ هر بار، کل آزمون‌های Saga را روی شبکهٔ کند قرمز می‌کرد                                                                                                                                                                               |
| `docs/close-q64-policy-setter`           | `F:\Rasta-Parallel\docs-close-q64`                     | PM      | —    | ۱ / ۰          | بستن Q-64 با تصمیم مالک پروژه (رفتار موجود: `SYSTEM_ADMIN` و `UNION_ADMIN`) و هم‌سو کردن ردیف `/config/approval-policies` در `docs/16`                                                                                                                                                                                                             |
| `demo/investor-preview`                  | `F:\Rasta-Parallel\investor-demo`                      | —       | —    | ۳۴ / ۱۶۷       | شاخهٔ نمایشی بلندمدت؛ هرگز در `main` ادغام نمی‌شود — سند خودش این را می‌گوید                                                                                                                                                                                                                                                                       |
| `design/claude-design`                   | پوشهٔ موقت در `%TEMP%`                                 | —       | —    | ۷ / ۴۷۳        | ابزار انتشار طرح؛ خارج از چرخهٔ محصول                                                                                                                                                                                                                                                                                                              |
| `claude/adoring-cerf-nhq97e-gateway`     | نشست ابری (Cloud)                                      | Cloud   | #102 | ۳ / ۰          | تازه ساخته شد از `origin/main` @ `b89e192` — سخت‌سازی `api-gateway`: کلید حد ناشناس پشت Proxy (L1-03)، رد مسیر نقطه‌ای پیش از انتخاب Route (L1-04)، Gate Realm توسعهٔ Keycloak (L1-05)، عدم بازتاب بدنهٔ خام ۵xx (L1-06)                                                                                                                           |
| `fix/fleet-dispatch-and-usage-integrity` | `F:\Rasta-Parallel\fleet-dispatch-and-usage-integrity` | Opus #2 | #103 | ۹ / ۰          | دستهٔ یکپارچگی دامنه (`F:\Rasta-audit\L3-domain.md`)، PR ۱ از ۲: `L3-02` (مانع اعزام به‌ازای هر Cause و بیمه به‌ازای هر پوشش؛ `coverage` در `INSURANCE_EXPIRED`؛ **Q-65**)، `L3-05` (بازه‌های مصرف هم‌پوشان رد می‌شوند)، `L3-11` (`DRIVER_UPDATED` و `REPAIR_CANCELLED`). از Sonnet تحویل گرفته شد. `fleet`، `maintenance` و `asset` را لمس می‌کند |

## شاخه‌های بازنشسته

این‌ها `ahead=0` هستند، یعنی محتوایشان کاملاً روی `main` است و می‌توان حذفشان
کرد. تا وقتی حذف نشده‌اند در این جدول می‌مانند تا کسی دوباره رویشان کار نکند.

| شاخه                                        | PR                                                  | ادغام شد در |
| ------------------------------------------- | --------------------------------------------------- | ----------- |
| `feat/audit-service-aud-004-contract`       | [#44](https://github.com/marabi766/RASTA/pull/44)   | `9fa75cc`   |
| `docs/inventory-logistics-adr`              | [#45](https://github.com/marabi766/RASTA/pull/45)   | `f2eb8fa`   |
| `feat/notification-service`                 | [#46](https://github.com/marabi766/RASTA/pull/46)   | `cc89660`   |
| `feat/notification-read-api`                | [#47](https://github.com/marabi766/RASTA/pull/47)   | `7389ffd`   |
| `feat/supplier-performance-phase2`          | [#48](https://github.com/marabi766/RASTA/pull/48)   | `f7252d3`   |
| `docs/branch-registry`                      | [#49](https://github.com/marabi766/RASTA/pull/49)   | `76feb8e`   |
| `fix/notification-dedupe-window-race`       | [#50](https://github.com/marabi766/RASTA/pull/50)   | `78ac7b0`   |
| `docs/project-memory-2026-09-18`            | [#51](https://github.com/marabi766/RASTA/pull/51)   | `a84269a`   |
| `docs/ci-serialization-and-backlog`         | [#52](https://github.com/marabi766/RASTA/pull/52)   | `76a1bf7`   |
| `docs/audit-immutable-archive`              | [#53](https://github.com/marabi766/RASTA/pull/53)   | `eea7d61`   |
| `feat/web-foundation`                       | [#54](https://github.com/marabi766/RASTA/pull/54)   | `8c04477`   |
| `feat/web-design-tokens`                    | [#55](https://github.com/marabi766/RASTA/pull/55)   | `4b15725`   |
| `feat/web-component-library`                | [#56](https://github.com/marabi766/RASTA/pull/56)   | `e7b0372`   |
| `feat/maintenance-schedule-audit-event`     | [#57](https://github.com/marabi766/RASTA/pull/57)   | `18946a2`   |
| `feat/notification-outbox-audit`            | [#58](https://github.com/marabi766/RASTA/pull/58)   | `419afde`   |
| `docs/state-2026-09-19`                     | [#59](https://github.com/marabi766/RASTA/pull/59)   | `8a80ce5`   |
| `feat/notification-preferences`             | [#60](https://github.com/marabi766/RASTA/pull/60)   | `e6d509e`   |
| `docs/state-2026-09-20`                     | [#61](https://github.com/marabi766/RASTA/pull/61)   | `37c48c2`   |
| `chore/test-task-unit-only`                 | [#62](https://github.com/marabi766/RASTA/pull/62)   | `f7755e0`   |
| `feat/notification-mail-channel`            | [#63](https://github.com/marabi766/RASTA/pull/63)   | `bcd3cd5`   |
| `feat/notification-email-delivery`          | [#65](https://github.com/marabi766/RASTA/pull/65)   | `db39f30`   |
| `feat/web-session-and-shell`                | [#66](https://github.com/marabi766/RASTA/pull/66)   | `3cf79aa`   |
| `docs/frontend-gate-and-web-state`          | [#64](https://github.com/marabi766/RASTA/pull/64)   | `df54a43`   |
| `feat/web-asset-surfaces`                   | [#67](https://github.com/marabi766/RASTA/pull/67)   | `6ea1260`   |
| `chore/api-gateway-dockerfile`              | [#70](https://github.com/marabi766/RASTA/pull/70)   | `c4de97b`   |
| `feat/asset-insurance-claim-api`            | [#71](https://github.com/marabi766/RASTA/pull/71)   | `fa14ef4`   |
| `fix/document-service-allow-asset-read`     | [#72](https://github.com/marabi766/RASTA/pull/72)   | `3f68d76`   |
| `fix/supply-chain-trust-policy`             | [#74](https://github.com/marabi766/RASTA/pull/74)   | `9e0b769`   |
| `feat/web-maintenance-surfaces`             | [#73](https://github.com/marabi766/RASTA/pull/73)   | `239ae23`   |
| `feat/web-write-path-and-usage`             | [#75](https://github.com/marabi766/RASTA/pull/75)   | `0b4a35a`   |
| `feat/web-drivers-surface`                  | [#76](https://github.com/marabi766/RASTA/pull/76)   | `1a6ba45`   |
| `fix/identity-role-grant-ladder`            | [#77](https://github.com/marabi766/RASTA/pull/77)   | `9347b80`   |
| `feat/web-organizations-surface`            | [#79](https://github.com/marabi766/RASTA/pull/79)   | `0ac1a61`   |
| `feat/ci-portal-e2e-live-stack`             | [#78](https://github.com/marabi766/RASTA/pull/78)   | `39ac75c`   |
| `feat/web-asset-timeline`                   | [#80](https://github.com/marabi766/RASTA/pull/80)   | `62186cf`   |
| `fix/identity-cross-tenant-provisioning`    | [#81](https://github.com/marabi766/RASTA/pull/81)   | `cfdb7b0`   |
| `claude/upbeat-tesla-cenkph`                | [#82](https://github.com/marabi766/RASTA/pull/82)   | `d7500be`   |
| `feat/ci-portal-e2e-live-stack`             | [#78](https://github.com/marabi766/RASTA/pull/78)   | `39ac75c`   |
| `claude/quirky-curie-15d850`                | [#69](https://github.com/marabi766/RASTA/pull/69)   | `7488e73`   |
| `fix/minio-quay-registry`                   | —                                                   | پیش‌تر      |
| `feat/web-orders-surface`                   | [#83](https://github.com/marabi766/RASTA/pull/83)   | `1a331e1`   |
| `fix/identity-tenant-bound-roles`           | [#84](https://github.com/marabi766/RASTA/pull/84)   | `6b9b956`   |
| `feat/web-wallet-marketplace-surfaces`      | [#85](https://github.com/marabi766/RASTA/pull/85)   | `8b41d18`   |
| `fix/identity-getuser-fail-closed-and-exp`  | [#87](https://github.com/marabi766/RASTA/pull/87)   | `a058993`   |
| `fix/ci-minio-chainguard`                   | [#88](https://github.com/marabi766/RASTA/pull/88)   | `25aa2ef`   |
| `fix/identity-registration-approval-oracle` | [#89](https://github.com/marabi766/RASTA/pull/89)   | `b103146`   |
| `fix/document-upload-immutability`          | [#91](https://github.com/marabi766/RASTA/pull/91)   | `f2dd66d`   |
| `fix/marketplace-idempotent-replay-signal`  | [#92](https://github.com/marabi766/RASTA/pull/92)   | `58c893f`   |
| `fix/marketplace-saga-failure-windows`      | [#93](https://github.com/marabi766/RASTA/pull/93)   | `afac57d`   |
| `fix/identity-guard-tenant-bound-roles`     | [#94](https://github.com/marabi766/RASTA/pull/94)   | `49559ef`   |
| `fix/marketplace-dispute-idempotency-key`   | [#95](https://github.com/marabi766/RASTA/pull/95)   | `a3d5885`   |
| `docs/adr-061-event-provenance`             | [#96](https://github.com/marabi766/RASTA/pull/96)   | `3115f4d`   |
| `fix/marketplace-workflow-spec-determinism` | [#97](https://github.com/marabi766/RASTA/pull/97)   | `68d121e`   |
| `fix/identity-spec-no-org-claims`           | [#98](https://github.com/marabi766/RASTA/pull/98)   | `a673a57`   |
| `claude/adoring-cerf-nhq97e`                | [#101](https://github.com/marabi766/RASTA/pull/101) | `8b3136b`   |

> **هشدار پابرجا:** ref محلی `main` در مخزن اصلی `F:\Rasta` صدها کامیت عقب
> است و می‌ماند. هیچ Worktreeای `main` را checkout نکرده، پس `git fetch` آن ref
> را جلو نمی‌برد. **همیشه `origin/main` را مبنا بگیرید، نه `main`** — وگرنه
> `git diff main` و `git merge-base main …` نتیجهٔ بی‌معنی می‌دهند.

---

## ۲۶٫۴ سطح تداخل — فایل‌هایی که چند شاخه لمس می‌کنند

پیش از ویرایش هرکدام از این‌ها، ستون «چه کسی الان لمسش می‌کند» را ببینید.
این فهرست از روی تداخل‌های واقعی این مخزن ساخته شده، نه از روی حدس.

| فایل                                                        | چرا پرتداخل است                                                                                             | الان چه کسی                     |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `docs/24-open-questions.md`                                 | هر شاخه پرسش تازه‌اش را ته همین فایل می‌افزاید و جدول § ۲۴٫۱۰ را بازمی‌شمارد. **منبع هر سه حادثهٔ § ۲۶٫۱.** | —                               |
| `docs/21-adr-list.md`                                       | هر ADR تازه یک ردیف فهرست و یک بخش می‌خواهد؛ شمارهٔ تکراری اینجا آشکار می‌شود                               | —                               |
| `package.json` → زنجیرهٔ `test:migration`                   | هر سرویس تازه نامش را به **یک خط** اضافه می‌کند                                                             | —                               |
| `.github/workflows/ci.yml`                                  | بلوک‌های توضیحی‌اش ادعای واقعی دارند؛ دو طرف می‌توانند بدون تداخل متنی **معناً متناقض** شوند                | —                               |
| `scripts/verify-migration-reversible-lib.mjs` و `.test.mjs` | هر سرویس یک بخش تازه می‌افزاید (معمولاً افزایشی و بی‌دردسر)                                                 | —                               |
| `pnpm-lock.yaml`                                            | هر نصب بازتولیدش می‌کند                                                                                     | هر شاخه‌ای که وابستگی اضافه کند |
| `PROJECT_MEMORY.md`                                         | همه بعد از ادغام می‌خواهند به‌روزش کنند                                                                     | `claude/quirky-curie-15d850`    |

### تداخلی که `git merge-tree` نشان نمی‌دهد

`git merge-tree --write-tree` فقط تداخل **متنی** را می‌بیند. دو تغییر در دو
فایل جدا می‌توانند بدون هیچ تداخلی merge شوند و با هم **غلط** باشند.

نمونهٔ واقعی (2026-09-18، PR #46): `NTF-001` دکوراتور
`@AllowService('notification-service')` را روی `GET /v1/users` گذاشت؛ Specهای
فاز C11 از `AUD-004` روی `main` ادعا می‌کردند این مسیر هیچ `@AllowService`
ندارد. دو فایل متفاوت، صفر تداخل، و یک CI قرمز روی یک تست از نود و پنج تا.

**قاعده:** پس از هر merge، حتی وقتی merge تمیز بوده، تست‌ها اجرا می‌شوند.

### شکستِ اول، دومی را پنهان می‌کند

در همان روز و در همان سرویس، دو نقص پشت سر هم نشسته بودند. مرحلهٔ
`Notification coverage gate` که یک Suite را بار دوم اجرا می‌کند، **پس از**
`Integration tests` در همان Job است. تا وقتی `concurrency.int-spec.ts` می‌افتاد،
Job پیش از رسیدن به آن مرحله متوقف می‌شد — پس نقص دوم اصلاً اجرا نمی‌شد.

رفعِ نقص اول، همان چیزی بود که نقص دوم را آشکار کرد. این را «تست ناپایدار» یا
«رگرسیون رفع» نخوانید؛ یک ترتیب مرحله‌ای است.

**قاعده:** وقتی یک Job روی اولین شکستش متوقف می‌شود، سبزشدن آن شکست خبر
نمی‌دهد که بقیه سبزند — فقط خبر می‌دهد که حالا اجرا می‌شوند.

---

## ۲۶٫۵ دفتر شماره‌های رزروشده

پیش از برداشتن هر شمارهٔ تازه، اینجا ثبتش کنید. ثبت **پیش از** کار انجام
می‌شود، نه بعدش.

### ADR

| شماره | مالک                                  | وضعیت                                           |
| ----- | ------------------------------------- | ----------------------------------------------- |
| ۰۵۴   | `feat/notification-service`           | روی `main` (`cc89660`)                          |
| ۰۵۵   | `feat/audit-service-aud-004-contract` | روی `main` (`9fa75cc`)                          |
| ۰۵۶   | `docs/inventory-logistics-adr`        | روی `main` (`f2eb8fa`)                          |
| ۰۵۷   | `docs/audit-immutable-archive`        | مصرف شد — بازشماری از ۰۵۵ انجام شد              |
| ۰۵۸   | `feat/web-foundation`                 | مصرف شد — جای پورتال وب و مرز Design System     |
| ۰۵۹   | `feat/web-session-and-shell`          | روی `main` (`3cf79aa`) — نگهداشت توکن در پورتال |
| ۰۶۰+  | آزاد                                  | —                                               |

### پرسش‌های باز `Q-NN`

| شماره       | مالک                                     | وضعیت                                                                                                                         |
| ----------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Q-44        | تصمیم محصول MVP                          | **بسته** روی `main` و تثبیت‌شده با نقل‌قول کلمه‌به‌کلمه در `ADR-056 § ۲` — تغییرناپذیر                                        |
| Q-45 … Q-55 | `feat/audit-service-aud-004-contract`    | روی `main`                                                                                                                    |
| Q-56        | `feat/supplier-performance-phase2`       | روی `main` (`f7252d3`)                                                                                                        |
| Q-57        | `feat/audit-service-aud-004-contract`    | روی `main`                                                                                                                    |
| Q-58        | `docs/audit-immutable-archive`           | مصرف شد — بازشماری از `Q-44`؛ سیاست لنگرگذاری خارجی، همراه `ADR-057`                                                          |
| Q-59        | `feat/asset-insurance-claim-api`         | روی `main` (`fa14ef4`) — مرجع تأیید/رد ادعای خسارت بیمه و مالکیت اجرای تسویه                                                  |
| Q-60        | `fix/identity-role-grant-ladder`         | روی `main` (`9347b80`) — مرجع اعطای نقش: چه نقشی چه نقش‌هایی را می‌دهد، و چه عضویتی را اداره می‌کند                           |
| Q-61        | `fix/identity-cross-tenant-provisioning` | روی `main` (`cfdb7b0`) — مرجع ساخت حساب در سازمانی جز سازمان خود. **پس از استفاده ثبت شد** — #81 بدون رزرو پیشین آن را برداشت |
| Q-62        | `claude/upbeat-tesla-cenkph`             | رزرو — مرجع استرداد (Refund) تراکنش: چه کسی، از کدام وضعیت؛ سیاست موقت `fix/economic-refund-authority-and-idempotency`        |
| Q-63        | `fix/identity-tenant-bound-roles`        | روی `main` (`6b9b956`) — نقش‌های سراسری؛ همراه `ADR-060`                                                                      |
| Q-64        | `claude/adoring-cerf-nhq97e`             | روی `main` (`8b3136b`)؛ بسته با تصمیم مالک پروژه در #104 (`771a491`) — چه نقشی سیاست حکمرانی را تنظیم می‌کند                  |
| Q-65        | `fix/fleet-dispatch-and-usage-integrity` | رزرو (#103) — کدام پوشش بیمه مانع اعزام است، و چه چیزی مانع معاینهٔ مردود را برمی‌دارد                                        |
| Q-66+       | آزاد                                     | —                                                                                                                             |

> **چرا Q-44 قابل جابه‌جایی نیست:** یک ADR ادغام‌شده آن را به‌عنوان مرجع
> پذیرش نقل کرده. نقل‌قول را نمی‌شود ویرایش کرد بی‌آنکه سند دروغ شود. هر
> شاخهٔ دیگری که `Q-44` را برداشته باشد، باید خودش بازشماری کند.

---

## ۲۶٫۶ واقعیت‌های CI که باید بدانید

این‌ها بارها وقت تلف کرده‌اند چون رفتار GitHub در آن‌ها **سکوت** است، نه خطا.

| اگر                            | آنگاه                                                                                                                                                                                   |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PR در وضعیت `CONFLICTING` باشد | GitHub **هیچ** اجرای `pull_request` نمی‌سازد. Merge Ref قابل محاسبه نیست و هیچ پیامی هم داده نمی‌شود. کامیت «retrigger» بی‌فایده است.                                                   |
| پایهٔ PR چیزی جز `main` باشد   | `ci.yml` اصلاً فعال نمی‌شود. `gh run list --branch <شاخه>` خروجی خالی می‌دهد.                                                                                                           |
| فقط پایهٔ PR عوض شود           | رویداد `edited` ساخته می‌شود که در انواع پیش‌فرض (`opened`، `synchronize`، `reopened`) نیست ⇒ باز هم اجرایی ساخته نمی‌شود. برای گرفتن اجرا: یک Push، یا `gh pr close` و `gh pr reopen`. |
| دو Push پشت سر هم              | `concurrency: cancel-in-progress: true` اجرای قبلی را لغو می‌کند. اجرای سبزِ یک کامیت قدیمی‌تر، دربارهٔ کامیت فعلی هیچ نمی‌گوید.                                                        |

**همیشه بررسی کنید اجرا روی کدام `headSha` بوده:**

```bash
gh run view <run-id> --json headSha,conclusion
```

### ادغام‌ها سریالی‌اند — پس از هر Merge، منتظر بمانید

**قاعده.** پس از ادغام یک PR در `main`، تا **سبزشدن اجرای push همان کامیت**، PR
بعدی ادغام نمی‌شود.

`concurrency.group` برابر `ci-${{ github.ref }}` است و برای هر ادغام، `github.ref`
همان `refs/heads/main` است. پس دو ادغام پشت سر هم یک گروه مشترک دارند و
`cancel-in-progress: true` اجرای اولی را وسط کار می‌کشد.

دو هزینه دارد، و دومی گران است:

1. کامیت ادغام اول برای همیشه `cancelled` می‌ماند. GitHub برای `cancelled` همان
   ضربدر قرمزِ `failure` را نشان می‌دهد، پس تاریخچه شکست‌هایی نشان می‌دهد که رخ
   نداده‌اند.
2. **قرمزشدن `main` دیر کشف می‌شود.** روی 2026-09-18، `#49` و `#47` پشت سر هم
   ادغام شدند؛ اجرای `76feb8e` لغو شد و اجرای `7389ffd` قرمز شد. اگر منتظر
   اولی می‌ماندیم، قرمزی در همان دقیقه دیده می‌شد.

**همین قاعده روی شاخه هم صدق می‌کند:** کامیت‌های یک واحد منطقی در **یک** Push
فرستاده می‌شوند. هر Push یک اجرا می‌سازد و Push پیاپی، اجرای قبلی را لغو می‌کند.

### شناسه‌های ساختگی در تست، باید ساختگی به‌نظر برسند

گام «Secret scan» در Job امنیت با Gitleaks اجرا می‌شود و قاعدهٔ `generic-api-key`
آن روی **آنتروپی** کار می‌کند، نه روی معنا. یک شناسهٔ همبستگی واقع‌نما — مثلاً
پیشوند `req_` و یک ULID — کنار نامی که شبیه شناسه است، دقیقاً الگوی یک کلید
نشت‌کرده را دارد؛ روی PR #56 همین اتفاق افتاد و Build را شکست.

**این سند هم خودِ آن رشته را نقل نمی‌کند.** اسکنر یک سند Markdown را همان‌طور
می‌خواند که کد را؛ نوشتنِ «مقدار بد» در توضیحِ اینکه چرا بد است، همان مقدار را
دوباره به شاخه برمی‌گرداند. این اشتباه یک بار در همین PR رخ داد.

**قاعده:** داده آزمون برای هر چیزی که در دنیای واقعی Token پرآنتروپی است —
شناسهٔ همبستگی، شناسهٔ ردیابی، کلید Idempotency — با کلمه‌های آشکارا ساختگی
نوشته می‌شود (`req-sample-correlation`)، نه با نمونهٔ واقع‌نما. اسکنر دربارهٔ
**شکل** درست می‌گوید؛ استثنا تراشیدن در `.gitleaks.toml` یعنی خاموش‌کردن همان
قاعده‌ای که روزی یک نشت واقعی را می‌گیرد.

**و توجه کنید که این گام، گام‌های بعدی را پنهان می‌کند.** Job «Security scans»
به‌ترتیب Secret scan → Dependency audit → Static analysis اجرا می‌کند. وقتی
Gitleaks می‌افتد، دو گام بعدی **اصلاً اجرا نمی‌شوند**؛ پس سبزشدن دوبارهٔ Job
پس از اصلاح، اولین باری است که Semgrep واقعاً کد جدید را دیده است.

**حذف در کامیت بعدی کافی نیست.** Gitleaks روی `pull_request` **همهٔ کامیت‌های
PR** را می‌بیند، نه فقط نوک را. رشته‌ای که در کامیت اول آمده و در کامیت دوم
حذف شده، هنوز در Diff کامیت اول هست و یافته دوباره گزارش می‌شود. این باگ
نیست؛ یک کلید نشت‌کرده با حذف‌شدن، نشت‌نکرده نمی‌شود.

پس درمانش **بازنویسی تاریخچهٔ همان شاخه** است: کامیت‌ها با `git reset --soft
origin/main` در یکی ادغام و شاخه با `--force-with-lease` دوباره Push می‌شود.
روی `main` هرگز (`CLAUDE.md` § Git Rules)، ولی روی شاخهٔ کاری‌ای که طبق
قاعدهٔ ۱ همین سند فقط یک نشست آن را در اختیار دارد، بی‌خطر است. اگر رشته
واقعاً یک راز بوده باشد، بازنویسی تاریخچه **جای ابطال آن را نمی‌گیرد**؛ اول
باید باطل شود.

### «لغو» شکست نیست، و سبز هم نیست

یک اجرای `cancelled` دربارهٔ آن کامیت **هیچ** نمی‌گوید. در گزارش‌ها هرگز
`cancelled` را `failure` ننویسید و هرگز آن را به‌عنوان شاهد سبز هم نیاورید.
تفکیکشان با یک دستور ممکن است:

```bash
gh api repos/<owner>/<repo>/commits/<sha>/check-runs \
  --jq '[.check_runs[].conclusion] | group_by(.) | map("\(.[0])=\(length)")'
```

**یک ضربدر تاریخی روی کامیت میانی، نقص کیفیت نیست.** CI وضعیت **درخت** را در آن
کامیت می‌سنجد، نه فقط تغییرات آن کامیت را؛ پس وقتی همان محتوا در یک اجرای سبزِ
بعدی روی `main` دیده شد، آزموده شده است. چیزی که باید سبز باشد **نوک `main`**
است. اجرای دوبارهٔ کامیت‌های قدیمی `main` برای پاک‌کردن ظاهر آن ضربدرها **ممنوع
است**: به‌خاطر همان `concurrency`، اجرای فعلی `main` را لغو می‌کند و یک ضربدر
تازه می‌سازد.

---

## ۲۶٫۷ ثبت شاخهٔ تازه

هنگام ساختن شاخه، این ردیف را به § ۲۶٫۳ اضافه کنید:

```markdown
| `<نام شاخه>` | `<مسیر worktree>` | `<نشست>` | `—` | ۰ / ۰ | تازه ساخته شد از `origin/main` @ `<sha>` |
```

و پیش از شروع کار، این چهار را وارسی کنید:

```bash
git fetch origin                                   # ۱. آخرین وضعیت را بگیر
git worktree list                                  # ۲. این شاخه جای دیگری checkout نیست؟
gh pr list --state open                            # ۳. PR فعال دیگری همین فایل‌ها را دست می‌زند؟
git merge-tree --write-tree <شاخه> origin/main     # ۴. تداخل متنی را پیش‌بینی کن
```

اگر قرار است شمارهٔ ADR یا `Q-NN` بردارید، **اول** § ۲۶٫۵ را به‌روز کنید و
همان را Commit کنید.

---

## ۲۶٫۸ تاریخچهٔ رویدادها

| تاریخ      | رویداد                                                                                                                                                                                                                                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-17 | PR #45 ادغام شد (`f2eb8fa`). نوزده دقیقه بعد، کامیت `26ec7d9` روی شاخهٔ C3 همان فایل را عوض کرد و PR #48 را `CONFLICTING` کرد. C3 این را «قطعی GitHub Actions» تشخیص داد و یک کامیت retrigger زد که نمی‌توانست کمکی کند.                                                                                          |
| 2026-09-18 | PR #44 ادغام شد (`9fa75cc`). یادداشت «شکاف عمدی در شماره‌گذاری» از `docs/21-adr-list.md` برداشته شد و `ADR-055` سر جایش نشست.                                                                                                                                                                                     |
| 2026-09-18 | شاخه‌های C2 و C3 از ماشین `10.20.30.6` به این سیستم منتقل شدند — آن ماشین پایگاه‌دادهٔ بقیهٔ سرویس‌ها را migrate نکرده بود و بخشی از زنجیرهٔ `test:migration` اصلاً اجرا نمی‌شد. بلافاصله پس از انتقال، C3 اشکالی پیدا کرد که فقط با پایگاه‌دادهٔ واقعی دیده می‌شد: constraint علت لغو بدون backfill (`0e4ab9f`). |
| 2026-09-18 | PR #46 ادغام شد (`cc89660`). تداخل معنایی `@AllowService` که هیچ ابزار merge نشانش نمی‌داد، با `9c2ddc6` رفع شد.                                                                                                                                                                                                  |
| 2026-09-18 | PR #47 از پایهٔ `feat/notification-service` به `main` منتقل شد و با `close`/`reopen` اولین اجرای CI تاریخ آن شاخه ساخته شد.                                                                                                                                                                                       |
