# ۲۶. رجیستری شاخه‌ها و هماهنگی کار موازی

> **این سند پیش از هر دستوری که وضعیت مشترک را تغییر می‌دهد خوانده می‌شود.**
> وضعیت مشترک یعنی: `main`، هر شاخهٔ راه‌دور، هر PR، و هر فایلی که در جدول
> § ۲۶٫۴ «سطح تداخل» آمده است. خواندن این سند جای اجرای `git fetch` را
> نمی‌گیرد — سند می‌گوید **چه کسی کجا کار می‌کند**، و git می‌گوید **همین
> لحظه چه چیزی در مخزن هست**. هر دو لازم‌اند.

**آخرین به‌روزرسانی:** ۱۴۰۵/۰۷/۲۳ (2026-10-15) · **`main` در آن لحظه:** `7f7c96b`

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

۳. **همگام‌سازی با Merge، نه Rebase.** شاخه با `origin/main` همگام می‌شود
(Merge Commit، نه Rebase). ادغام PR در `main` اما Squash است (`git log origin/main --first-parent`:
یک کامیت به‌ازای هر PR)؛ پس تاریخچهٔ شاخه روی `main` نمی‌ماند و شاخهٔ ادغام‌شده
کامیت یکتای خودش را نگه می‌دارد.

۴. **شمارهٔ یکتا را فقط مدیر پروژه واگذار می‌کند و در دستور کار می‌آورد** (§ ۲۶٫۵).
شامل شمارهٔ ADR، `Q-NN`، `D-NNN` و نام Migration. نشستِ کاری پیش از نوشتن شماره،
آن را با `git grep` هم روی `origin/main` و هم روی شاخهٔ هر PR باز وارسی می‌کند و
رزرو را در سند خودِ آن شماره می‌نویسد (`docs/adr`، `docs/24`، `docs/23`). اگر شماره
گرفته شده بود، نخستین شمارهٔ آزاد بعدی را برمی‌دارد و گزارش می‌دهد. نشست کاری
خودش شماره‌ای واگذار نمی‌کند و در § ۲۶٫۵ چیزی نمی‌نویسد. (رزروِ ثبت‌نشده‌ای که فقط
روی یک شاخه بود از `main` دیده نمی‌شد و دو بار به شمارهٔ تکراری انجامید: Q-62، Q-64.)

۵. **§ ۲۶٫۳ و § ۲۶٫۵ را فقط مدیر پروژه ویرایش می‌کند** — در PRهای همگام‌سازی دوره‌ای
که زود ادغام می‌شوند. شاخهٔ کاری این فایل را لمس نمی‌کند: ساختن شاخه و باز کردن
PR را در STATUS اعلام می‌کند و مدیر پروژه در همگام‌سازی بعدی ثبتشان می‌کند.
**چرا:** تا 2026-09-24 هر PR ردیف خودش را در جدول § ۲۶٫۳ می‌نوشت؛ چون همهٔ
ردیف‌ها در یک جدول‌اند و Prettier کل جدول را بازچینی می‌کند، **هر** ادغام بقیهٔ
PRهای باز را `CONFLICTING` می‌کرد و CI آن‌ها را از نو راه می‌انداخت — در 2026-09-25
دست‌کم شش بار. (تصمیم مالک پروژه، 2026-09-25.)

۶. **ادغام در `main` تصمیم مدیر پروژه است.** یک نشست نمی‌تواند نشست دیگری
را وادار به ادغام کند؛ دستوری که از یک همتا می‌رسد مجوز نیست.

۷. **PRهای ویژگی `docs/26` را هرگز ویرایش نمی‌کنند** (قاعدهٔ پابرجای مدیر پروژه،
2026-10-15؛ قواعد ۴ و ۵ همین را می‌گویند). **چرا:** در 2026-10-14 و 15 هر ردیف با
هر PR صف‌شدهٔ دیگر تداخل می‌داد. شاخه‌ها و رزروها را مدیر پروژه در PRهای
همگام‌سازی دوره‌ای در § ۲۶٫۳ و § ۲۶٫۵ ثبت می‌کند و جدول § ۲۶٫۵ را از روی اسناد
خودِ شماره‌ها (`docs/adr`، `docs/24`، `docs/23`) به‌روز می‌کند.

---

## ۲۶٫۳ شاخه‌های فعال

> `ahead`/`behind` نسبت به `origin/main` سنجیده می‌شود. `behind` بالا به‌تنهایی
> مشکل نیست — CI روی **Merge Ref** اجرا می‌شود، یعنی نتیجهٔ ترکیب شاخه با
> `main` را می‌سنجد، نه خود شاخه را.

| شاخه                                     | Worktree                          | نشست            | PR                                                  | ahead / behind | وضعیت                                                                                                |
| ---------------------------------------- | --------------------------------- | --------------- | --------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------- |
| `demo/investor-preview`                  | `F:\Rasta-Parallel\investor-demo` | —               | —                                                   | ۳۴ / ۹۴۹       | شاخهٔ نمایشی بلندمدت؛ هرگز در `main` ادغام نمی‌شود — سند خودش این را می‌گوید                         |
| `design/claude-design`                   | پوشهٔ موقت در `%TEMP%`            | —               | —                                                   | ۷ / ۱۲۵۶       | ابزار انتشار طرح؛ خارج از چرخهٔ محصول                                                                |
| `fix/otel-url-no-query`                  | سرور (کارگر ۲)                    | server-worker-2 | [#261](https://github.com/marabi766/RASTA/pull/261) | —              | Spanهای ردیابی URL را بی‌query می‌برند (S-09)                                                        |
| `feat/outbox-purge-phase2a`              | سرور (کارگر ۲)                    | server-worker-2 | [#276](https://github.com/marabi766/RASTA/pull/276) | —              | پاک‌سازی زمان‌بندی‌شدهٔ ردیف‌های منتشرشدهٔ outbox، فاز ۲a (D-052): notification، supplier، inventory |
| `feat/outbox-purge-phase2b`              | سرور (کارگر ۴)                    | server-worker-4 | [#277](https://github.com/marabi766/RASTA/pull/277) | —              | همان، فاز ۲b: construction، contract، economic، marketplace                                          |
| `feat/outbox-purge-identity`             | سرور (کارگر ۲)                    | server-worker-2 | [#280](https://github.com/marabi766/RASTA/pull/280) | —              | همان، identity-service (D-052، تصمیم مدیر پروژه گزینهٔ a)                                            |
| `fix/marketplace-saga-activity-replay`   | سرور (کارگر ۴)                    | server-worker-4 | [#283](https://github.com/marabi766/RASTA/pull/283) | —              | تلاش دوبارهٔ Activity در Saga سفارش همان پاسخ تلاش نخست را می‌دهد؛ D-053 و Q-118                     |
| `chore/ci-image-pull-retry`              | سرور (کارگر ۳)                    | server-worker-3 | [#284](https://github.com/marabi766/RASTA/pull/284) | —              | CI: Pull پیشاپیش ایمیج‌های سنجاق‌شده با تلاش مجدد محدود برای خطاهای گذرای رجیستری                    |
| `fix/audit-telemetry-order`              | سرور (کارگر ۴)                    | server-worker-4 | [#285](https://github.com/marabi766/RASTA/pull/285) | —              | audit-service: kafkajs پس از `initTelemetry()` بارگذاری می‌شود تا Consumerهای Kafka ردیابی شوند      |
| `fix/economic-idempotent-response-in-tx` | سرور (کارگر ۱)                    | server-worker   | [#287](https://github.com/marabi766/RASTA/pull/287) | —              | economic: پاسخ فرمان Idempotent با اثرش Commit می‌شود؛ D-054                                         |
| `chore/ci-split-guard-semantics`         | سرور (کارگر ۱)                    | server-worker   | [#288](https://github.com/marabi766/RASTA/pull/288) | —              | CI: نگهبان تقسیم Job یکپارچگی معنا را می‌سنجد، نه متن را                                             |
| `fix/logging-error-serializer-scrub`     | سرور (کارگر ۳)                    | server-worker-3 | [#290](https://github.com/marabi766/RASTA/pull/290) | —              | logging: خطاهای ساخت‌یافته پاک‌سازی و سقف‌دار می‌شوند (کار ۰۳۴)                                      |
| `fix/outbox-relay-late-claim-fence`      | سرور (کارگر ۲)                    | server-worker-2 | [#291](https://github.com/marabi766/RASTA/pull/291) | —              | outbox: ادامه‌های دیرهنگام Relay در برابر اجرای متوقف‌شده حصار می‌خورند (shutdown فاز ۴a)            |

## شاخه‌های بازنشسته

بازنشستگی با **PR ادغام‌شده و `sha`ِ ادغام روی `main`** تأیید می‌شود، نه با
تبارِ git: ادغام‌های Squash کامیت‌های شاخه را روی `main` نمی‌آورند، پس `ahead` شاخهٔ
بازنشسته می‌تواند صفر نباشد (مثلاً #256: ۱، #246: ۸، #257: ۱۸ کامیت یکتا). تا وقتی
حذف نشده‌اند در این جدول می‌مانند تا کسی دوباره رویشان کار نکند.

| شاخه                                                              | PR                                                  | ادغام شد در |
| ----------------------------------------------------------------- | --------------------------------------------------- | ----------- |
| `feat/audit-service-aud-004-contract`                             | [#44](https://github.com/marabi766/RASTA/pull/44)   | `9fa75cc`   |
| `docs/inventory-logistics-adr`                                    | [#45](https://github.com/marabi766/RASTA/pull/45)   | `f2eb8fa`   |
| `feat/notification-service`                                       | [#46](https://github.com/marabi766/RASTA/pull/46)   | `cc89660`   |
| `feat/notification-read-api`                                      | [#47](https://github.com/marabi766/RASTA/pull/47)   | `7389ffd`   |
| `feat/supplier-performance-phase2`                                | [#48](https://github.com/marabi766/RASTA/pull/48)   | `f7252d3`   |
| `docs/branch-registry`                                            | [#49](https://github.com/marabi766/RASTA/pull/49)   | `76feb8e`   |
| `fix/notification-dedupe-window-race`                             | [#50](https://github.com/marabi766/RASTA/pull/50)   | `78ac7b0`   |
| `docs/project-memory-2026-09-18`                                  | [#51](https://github.com/marabi766/RASTA/pull/51)   | `a84269a`   |
| `docs/ci-serialization-and-backlog`                               | [#52](https://github.com/marabi766/RASTA/pull/52)   | `76a1bf7`   |
| `docs/audit-immutable-archive`                                    | [#53](https://github.com/marabi766/RASTA/pull/53)   | `eea7d61`   |
| `feat/web-foundation`                                             | [#54](https://github.com/marabi766/RASTA/pull/54)   | `8c04477`   |
| `feat/web-design-tokens`                                          | [#55](https://github.com/marabi766/RASTA/pull/55)   | `4b15725`   |
| `feat/web-component-library`                                      | [#56](https://github.com/marabi766/RASTA/pull/56)   | `e7b0372`   |
| `feat/maintenance-schedule-audit-event`                           | [#57](https://github.com/marabi766/RASTA/pull/57)   | `18946a2`   |
| `feat/notification-outbox-audit`                                  | [#58](https://github.com/marabi766/RASTA/pull/58)   | `419afde`   |
| `docs/state-2026-09-19`                                           | [#59](https://github.com/marabi766/RASTA/pull/59)   | `8a80ce5`   |
| `feat/notification-preferences`                                   | [#60](https://github.com/marabi766/RASTA/pull/60)   | `e6d509e`   |
| `docs/state-2026-09-20`                                           | [#61](https://github.com/marabi766/RASTA/pull/61)   | `37c48c2`   |
| `chore/test-task-unit-only`                                       | [#62](https://github.com/marabi766/RASTA/pull/62)   | `f7755e0`   |
| `feat/notification-mail-channel`                                  | [#63](https://github.com/marabi766/RASTA/pull/63)   | `bcd3cd5`   |
| `feat/notification-email-delivery`                                | [#65](https://github.com/marabi766/RASTA/pull/65)   | `db39f30`   |
| `feat/web-session-and-shell`                                      | [#66](https://github.com/marabi766/RASTA/pull/66)   | `3cf79aa`   |
| `docs/frontend-gate-and-web-state`                                | [#64](https://github.com/marabi766/RASTA/pull/64)   | `df54a43`   |
| `feat/web-asset-surfaces`                                         | [#67](https://github.com/marabi766/RASTA/pull/67)   | `6ea1260`   |
| `chore/api-gateway-dockerfile`                                    | [#70](https://github.com/marabi766/RASTA/pull/70)   | `c4de97b`   |
| `feat/asset-insurance-claim-api`                                  | [#71](https://github.com/marabi766/RASTA/pull/71)   | `fa14ef4`   |
| `fix/document-service-allow-asset-read`                           | [#72](https://github.com/marabi766/RASTA/pull/72)   | `3f68d76`   |
| `fix/supply-chain-trust-policy`                                   | [#74](https://github.com/marabi766/RASTA/pull/74)   | `9e0b769`   |
| `feat/web-maintenance-surfaces`                                   | [#73](https://github.com/marabi766/RASTA/pull/73)   | `239ae23`   |
| `feat/web-write-path-and-usage`                                   | [#75](https://github.com/marabi766/RASTA/pull/75)   | `0b4a35a`   |
| `feat/web-drivers-surface`                                        | [#76](https://github.com/marabi766/RASTA/pull/76)   | `1a6ba45`   |
| `fix/identity-role-grant-ladder`                                  | [#77](https://github.com/marabi766/RASTA/pull/77)   | `9347b80`   |
| `feat/web-organizations-surface`                                  | [#79](https://github.com/marabi766/RASTA/pull/79)   | `0ac1a61`   |
| `feat/ci-portal-e2e-live-stack`                                   | [#78](https://github.com/marabi766/RASTA/pull/78)   | `39ac75c`   |
| `feat/web-asset-timeline`                                         | [#80](https://github.com/marabi766/RASTA/pull/80)   | `62186cf`   |
| `fix/identity-cross-tenant-provisioning`                          | [#81](https://github.com/marabi766/RASTA/pull/81)   | `cfdb7b0`   |
| `claude/upbeat-tesla-cenkph`                                      | [#82](https://github.com/marabi766/RASTA/pull/82)   | `d7500be`   |
| `feat/ci-portal-e2e-live-stack`                                   | [#78](https://github.com/marabi766/RASTA/pull/78)   | `39ac75c`   |
| `claude/quirky-curie-15d850`                                      | [#69](https://github.com/marabi766/RASTA/pull/69)   | `7488e73`   |
| `fix/minio-quay-registry`                                         | —                                                   | پیش‌تر      |
| `feat/web-orders-surface`                                         | [#83](https://github.com/marabi766/RASTA/pull/83)   | `1a331e1`   |
| `fix/identity-tenant-bound-roles`                                 | [#84](https://github.com/marabi766/RASTA/pull/84)   | `6b9b956`   |
| `feat/web-wallet-marketplace-surfaces`                            | [#85](https://github.com/marabi766/RASTA/pull/85)   | `8b41d18`   |
| `fix/identity-getuser-fail-closed-and-exp`                        | [#87](https://github.com/marabi766/RASTA/pull/87)   | `a058993`   |
| `fix/ci-minio-chainguard`                                         | [#88](https://github.com/marabi766/RASTA/pull/88)   | `25aa2ef`   |
| `fix/identity-registration-approval-oracle`                       | [#89](https://github.com/marabi766/RASTA/pull/89)   | `b103146`   |
| `fix/document-upload-immutability`                                | [#91](https://github.com/marabi766/RASTA/pull/91)   | `f2dd66d`   |
| `fix/marketplace-idempotent-replay-signal`                        | [#92](https://github.com/marabi766/RASTA/pull/92)   | `58c893f`   |
| `fix/marketplace-saga-failure-windows`                            | [#93](https://github.com/marabi766/RASTA/pull/93)   | `afac57d`   |
| `fix/identity-guard-tenant-bound-roles`                           | [#94](https://github.com/marabi766/RASTA/pull/94)   | `49559ef`   |
| `fix/marketplace-dispute-idempotency-key`                         | [#95](https://github.com/marabi766/RASTA/pull/95)   | `a3d5885`   |
| `docs/adr-061-event-provenance`                                   | [#96](https://github.com/marabi766/RASTA/pull/96)   | `3115f4d`   |
| `fix/marketplace-workflow-spec-determinism`                       | [#97](https://github.com/marabi766/RASTA/pull/97)   | `68d121e`   |
| `fix/identity-spec-no-org-claims`                                 | [#98](https://github.com/marabi766/RASTA/pull/98)   | `a673a57`   |
| `claude/adoring-cerf-nhq97e`                                      | [#101](https://github.com/marabi766/RASTA/pull/101) | `8b3136b`   |
| `docs/registry-cleanup-2026-09-25`                                | [#99](https://github.com/marabi766/RASTA/pull/99)   | `a6122de`   |
| `fix/ci-temporal-test-server-cache`                               | [#100](https://github.com/marabi766/RASTA/pull/100) | `b89e192`   |
| `claude/adoring-cerf-nhq97e-gateway`                              | [#102](https://github.com/marabi766/RASTA/pull/102) | `e3eba24`   |
| `fix/fleet-dispatch-and-usage-integrity`                          | [#103](https://github.com/marabi766/RASTA/pull/103) | `b55e4e9`   |
| `docs/close-q64-policy-setter`                                    | [#104](https://github.com/marabi766/RASTA/pull/104) | `771a491`   |
| `claude/adoring-cerf-nhq97e-platform-safety`                      | [#105](https://github.com/marabi766/RASTA/pull/105) | `3ea2439`   |
| `fix/web-hardening`                                               | [#106](https://github.com/marabi766/RASTA/pull/106) | `faae358`   |
| `claude/adoring-cerf-nhq97e-hardening`                            | [#107](https://github.com/marabi766/RASTA/pull/107) | `5384abe`   |
| `fix/asset-transfer-and-insurance-integrity`                      | [#108](https://github.com/marabi766/RASTA/pull/108) | `aa4efcc`   |
| `docs/registry-pm-owned`                                          | [#109](https://github.com/marabi766/RASTA/pull/109) | `303395c`   |
| `fix/economic-source-verification`                                | [#110](https://github.com/marabi766/RASTA/pull/110) | `5fd91c4`   |
| `claude/adoring-cerf-nhq97e-org-concurrency`                      | [#111](https://github.com/marabi766/RASTA/pull/111) | `333aa76`   |
| `fix/fleet-end-assignment-on-transfer`                            | [#112](https://github.com/marabi766/RASTA/pull/112) | `6df019b`   |
| `claude/adoring-cerf-nhq97e-web-followups`                        | [#113](https://github.com/marabi766/RASTA/pull/113) | `8d5f362`   |
| `claude/adoring-cerf-nhq97e-audit-gaps`                           | [#114](https://github.com/marabi766/RASTA/pull/114) | `2521c03`   |
| `claude/adoring-cerf-nhq97e-audit-gaps-marketplace`               | [#115](https://github.com/marabi766/RASTA/pull/115) | `77ce9ac`   |
| `fix/maintenance-audit-part-labour-cost`                          | [#116](https://github.com/marabi766/RASTA/pull/116) | `82c5684`   |
| `claude/adoring-cerf-nhq97e-safety-followups`                     | [#117](https://github.com/marabi766/RASTA/pull/117) | `51f2aaf`   |
| `claude/adoring-cerf-nhq97e-web-write-outcome`                    | [#118](https://github.com/marabi766/RASTA/pull/118) | `c48ac87`   |
| `claude/new-session-6ektto`                                       | [#119](https://github.com/marabi766/RASTA/pull/119) | `7a5233c`   |
| `claude/modest-carson-jl3e5v`                                     | [#120](https://github.com/marabi766/RASTA/pull/120) | `9e85472`   |
| `fix/economic-batch-2`                                            | [#121](https://github.com/marabi766/RASTA/pull/121) | `f55a116`   |
| `claude/new-session-6ektto-pr2`                                   | [#122](https://github.com/marabi766/RASTA/pull/122) | `f271096`   |
| `fix/economic-ledger-reversal-guard`                              | [#123](https://github.com/marabi766/RASTA/pull/123) | `0212ca5`   |
| `claude/modest-carson-jl3e5v`                                     | [#124](https://github.com/marabi766/RASTA/pull/124) | `d8326e4`   |
| `fix/economic-request-hash-check-online`                          | [#125](https://github.com/marabi766/RASTA/pull/125) | `cd0c39a`   |
| `feat/supplier-performance-consumer`                              | [#126](https://github.com/marabi766/RASTA/pull/126) | `f9d0b84`   |
| `fix/asset-transfer-clearance`                                    | [#127](https://github.com/marabi766/RASTA/pull/127) | `9bcc7dc`   |
| `chore/kafka-sasl-acl`                                            | [#128](https://github.com/marabi766/RASTA/pull/128) | `be4086c`   |
| `fix/keycloak-projector-race`                                     | [#129](https://github.com/marabi766/RASTA/pull/129) | `0c3067a`   |
| `docs/registry-sync-0928`                                         | [#130](https://github.com/marabi766/RASTA/pull/130) | `7cc6dd9`   |
| `chore/kafka-sasl-acl-broker`                                     | [#131](https://github.com/marabi766/RASTA/pull/131) | `a4afe72`   |
| `fix/organization-union-admin-scope`                              | [#132](https://github.com/marabi766/RASTA/pull/132) | `e686fb0`   |
| `fix/ci-scratch-db-drop-flake`                                    | [#133](https://github.com/marabi766/RASTA/pull/133) | `8dfb2c3`   |
| `fix/notification-dispatcher-log-sentinel`                        | [#134](https://github.com/marabi766/RASTA/pull/134) | `b691976`   |
| `fix/nest-common-s09-leaks`                                       | [#135](https://github.com/marabi766/RASTA/pull/135) | `05f4491`   |
| `fix/validation-echo-s09`                                         | [#136](https://github.com/marabi766/RASTA/pull/136) | `0ce6dbf`   |
| `fix/fast-uri-cve-2026-84292`                                     | [#137](https://github.com/marabi766/RASTA/pull/137) | `ff0a884`   |
| `fix/minio-init-race`                                             | [#138](https://github.com/marabi766/RASTA/pull/138) | `63e5bb5`   |
| `fix/compose-ci-parity-and-stale-env`                             | [#139](https://github.com/marabi766/RASTA/pull/139) | `acb17db`   |
| `fix/economic-payment-reconciler`                                 | [#140](https://github.com/marabi766/RASTA/pull/140) | `fd5a42e`   |
| `fix/retry-after-in-flight-409`                                   | [#141](https://github.com/marabi766/RASTA/pull/141) | `bb55396`   |
| `feat/supplier-gate-on-authenticated-broker`                      | [#142](https://github.com/marabi766/RASTA/pull/142) | `7db0bcb`   |
| `fix/economic-refund-safety`                                      | [#143](https://github.com/marabi766/RASTA/pull/143) | `a4b226a`   |
| `feat/dlq-replay-tool`                                            | [#144](https://github.com/marabi766/RASTA/pull/144) | `1958eda`   |
| `fix/event-consumer-retry-and-dlq-key`                            | [#145](https://github.com/marabi766/RASTA/pull/145) | `0bacb98`   |
| `fix/organization-coverage-config`                                | [#146](https://github.com/marabi766/RASTA/pull/146) | `b0ad109`   |
| `fix/marketplace-claim-token-and-gateway-headers`                 | [#147](https://github.com/marabi766/RASTA/pull/147) | `19ca586`   |
| `fix/construction-policy-on-org-moved`                            | [#148](https://github.com/marabi766/RASTA/pull/148) | `5091890`   |
| `fix/brace-expansion-advisories`                                  | [#149](https://github.com/marabi766/RASTA/pull/149) | `c993ed1`   |
| `chore/lint-root-scripts`                                         | [#151](https://github.com/marabi766/RASTA/pull/151) | `bb28891`   |
| `fix/construction-need-submit-vs-cancel`                          | [#152](https://github.com/marabi766/RASTA/pull/152) | `ea75756`   |
| `fix/graceful-shutdown-all-services`                              | [#153](https://github.com/marabi766/RASTA/pull/153) | `ee9f4c1`   |
| `fix/outbox-relay-stream-order`                                   | [#154](https://github.com/marabi766/RASTA/pull/154) | `2cdfb36`   |
| `feat/web-exp-002-remainder`                                      | [#155](https://github.com/marabi766/RASTA/pull/155) | `f6374b1`   |
| `feat/construction-tender-adr`                                    | [#156](https://github.com/marabi766/RASTA/pull/156) | `33935aa`   |
| `feat/web-exp-002-asset-writes`                                   | [#158](https://github.com/marabi766/RASTA/pull/158) | `c5b5292`   |
| `feat/web-e2e-live-and-mobile`                                    | [#159](https://github.com/marabi766/RASTA/pull/159) | `2ca7ec2`   |
| `feat/web-bound-submission-ids`                                   | [#160](https://github.com/marabi766/RASTA/pull/160) | `4ea9df1`   |
| `fix/economic-payment-reconciler-b`                               | [#161](https://github.com/marabi766/RASTA/pull/161) | `a585a66`   |
| `feat/construction-tender-core`                                   | [#162](https://github.com/marabi766/RASTA/pull/162) | `a75d92d`   |
| `feat/construction-tender-sealing`                                | [#163](https://github.com/marabi766/RASTA/pull/163) | `d145e69`   |
| `fix/economic-payment-reconciler-b2`                              | [#164](https://github.com/marabi766/RASTA/pull/164) | `1f57eb0`   |
| `feat/construction-tender-criteria`                               | [#165](https://github.com/marabi766/RASTA/pull/165) | `eb9045e`   |
| `feat/ops-replay-audit`                                           | [#166](https://github.com/marabi766/RASTA/pull/166) | `405efe4`   |
| `feat/construction-tender-publish`                                | [#167](https://github.com/marabi766/RASTA/pull/167) | `4159c06`   |
| `fix/grpc-js-advisory`                                            | [#168](https://github.com/marabi766/RASTA/pull/168) | `adca86e`   |
| `feat/construction-tender-standing`                               | [#170](https://github.com/marabi766/RASTA/pull/170) | `60b5477`   |
| `fix/maintenance-request-idempotency`                             | [#171](https://github.com/marabi766/RASTA/pull/171) | `1984174`   |
| `fix/outbox-grace-below-shutdown-timeout`                         | [#172](https://github.com/marabi766/RASTA/pull/172) | `d1977ad`   |
| `feat/construction-tender-bids`                                   | [#174](https://github.com/marabi766/RASTA/pull/174) | `7085a15`   |
| `fix/economic-payment-reconciler-b3`                              | [#175](https://github.com/marabi766/RASTA/pull/175) | `7660d99`   |
| `fix/d045-db-role-split`                                          | [#176](https://github.com/marabi766/RASTA/pull/176) | `a6adac6`   |
| `fix/d045-split-identity-notification`                            | [#177](https://github.com/marabi766/RASTA/pull/177) | `ef38818`   |
| `fix/d045-split-remaining`                                        | [#178](https://github.com/marabi766/RASTA/pull/178) | `71bac91`   |
| `fix/tenant-scoped-models-check`                                  | [#179](https://github.com/marabi766/RASTA/pull/179) | `647d1ef`   |
| `fix/d045-split-economic`                                         | [#180](https://github.com/marabi766/RASTA/pull/180) | `ac6fa60`   |
| `fix/clamav-pcre2`                                                | [#181](https://github.com/marabi766/RASTA/pull/181) | `7c3a48b`   |
| `feat/construction-tender-close`                                  | [#182](https://github.com/marabi766/RASTA/pull/182) | `254b1b5`   |
| `fix/e2e-cross-tenant-edit-version`                               | [#183](https://github.com/marabi766/RASTA/pull/183) | `8254bbc`   |
| `feat/construction-tender-open`                                   | [#184](https://github.com/marabi766/RASTA/pull/184) | `f79f100`   |
| `feat/web-exp-002-request-commands`                               | [#185](https://github.com/marabi766/RASTA/pull/185) | `ca1a497`   |
| `fix/fleet-dispatch-race-unhandled-rejection`                     | [#186](https://github.com/marabi766/RASTA/pull/186) | `6f97452`   |
| `feat/web-exp-002-repair-orders`                                  | [#187](https://github.com/marabi766/RASTA/pull/187) | `cb0d95b`   |
| `fix/construction-tender-open-price-markers`                      | [#189](https://github.com/marabi766/RASTA/pull/189) | `ca0b2c1`   |
| `feat/construction-tender-evaluation`                             | [#190](https://github.com/marabi766/RASTA/pull/190) | `afac1bc`   |
| `fix/d045-credentials-out-of-argv`                                | [#191](https://github.com/marabi766/RASTA/pull/191) | `8c88d2e`   |
| `fix/platform-stable-actor-identity`                              | [#192](https://github.com/marabi766/RASTA/pull/192) | `d8ceccf`   |
| `fix/asset-create-idempotency`                                    | [#193](https://github.com/marabi766/RASTA/pull/193) | `e3caf75`   |
| `feat/web-exp-002-asset-lifecycle`                                | [#195](https://github.com/marabi766/RASTA/pull/195) | `f400f1e`   |
| `fix/idempotency-hash-and-takeover-sweep`                         | [#196](https://github.com/marabi766/RASTA/pull/196) | `f4a9801`   |
| `fix/ci-integration-timeout`                                      | [#197](https://github.com/marabi766/RASTA/pull/197) | `4df1588`   |
| `feat/construction-tender-award`                                  | [#199](https://github.com/marabi766/RASTA/pull/199) | `982ef27`   |
| `fix/construction-stable-actor-identity`                          | [#200](https://github.com/marabi766/RASTA/pull/200) | `b724257`   |
| `fix/economic-stable-actor-identity`                              | [#201](https://github.com/marabi766/RASTA/pull/201) | `283410c`   |
| `ci/split-migration-reversibility`                                | [#202](https://github.com/marabi766/RASTA/pull/202) | `a6ec5aa`   |
| `chore/web-turbo-contract-inputs`                                 | [#203](https://github.com/marabi766/RASTA/pull/203) | `33789b3`   |
| `feat/audit-reconciliation-projection`                            | [#204](https://github.com/marabi766/RASTA/pull/204) | `c028ee5`   |
| `fix/consumers-poison-known-events-to-dlq`                        | [#205](https://github.com/marabi766/RASTA/pull/205) | `40ea95a`   |
| `fix/economic-reversal-aggregate-consistency`                     | [#207](https://github.com/marabi766/RASTA/pull/207) | `0b2b106`   |
| `fix/server-bidi-control-in-free-text`                            | [#209](https://github.com/marabi766/RASTA/pull/209) | `7781335`   |
| `feat/web-exp-002-insurance-inspection`                           | [#206](https://github.com/marabi766/RASTA/pull/206) | `74057dc`   |
| `feat/construction-tender-approval`                               | [#208](https://github.com/marabi766/RASTA/pull/208) | `299fe03`   |
| `fix/economic-payment-refund-events`                              | [#210](https://github.com/marabi766/RASTA/pull/210) | `27c5410`   |
| `docs/registry-sync-1003`                                         | [#211](https://github.com/marabi766/RASTA/pull/211) | `ad5e15a`   |
| `fix/construction-own-bid-flake`                                  | [#212](https://github.com/marabi766/RASTA/pull/212) | `32ff753`   |
| `fix/notification-quiet-window-midnight`                          | [#213](https://github.com/marabi766/RASTA/pull/213) | `816a49a`   |
| `chore/db-session-utc-and-tenant-index-check`                     | [#214](https://github.com/marabi766/RASTA/pull/214) | `0f461d0`   |
| `chore/pin-infra-images-by-digest`                                | [#215](https://github.com/marabi766/RASTA/pull/215) | `95afc3c`   |
| `fix/notification-lease-test-isolation`                           | [#216](https://github.com/marabi766/RASTA/pull/216) | `0bc3a50`   |
| `chore/tenant-index-order-fleet-identity-maintenance-marketplace` | [#217](https://github.com/marabi766/RASTA/pull/217) | `e92bd5a`   |
| `chore/tenant-index-order-economic`                               | [#218](https://github.com/marabi766/RASTA/pull/218) | `705ff48`   |
| `fix/identity-one-live-membership`                                | [#219](https://github.com/marabi766/RASTA/pull/219) | `92cd37f`   |
| `fix/bidi-control-web-pinned-fields`                              | [#220](https://github.com/marabi766/RASTA/pull/220) | `178dfd7`   |
| `chore/tenant-index-order-rest`                                   | [#221](https://github.com/marabi766/RASTA/pull/221) | `916d3be`   |
| `fix/asset-money-non-negative`                                    | [#222](https://github.com/marabi766/RASTA/pull/222) | `e2deac2`   |
| `test/construction-tender-e2e`                                    | [#223](https://github.com/marabi766/RASTA/pull/223) | `12588c8`   |
| `fix/economic-idempotency-terminal-refusals`                      | [#224](https://github.com/marabi766/RASTA/pull/224) | `a08122d`   |
| `fix/construction-tender-front-door`                              | [#226](https://github.com/marabi766/RASTA/pull/226) | `89402e4`   |
| `feat/contract-service-con003-pr1`                                | [#228](https://github.com/marabi766/RASTA/pull/228) | `25744c6`   |
| `fix/construction-award-read-project`                             | [#229](https://github.com/marabi766/RASTA/pull/229) | `ffe056d`   |
| `feat/web-exp-002-documents-availability`                         | [#225](https://github.com/marabi766/RASTA/pull/225) | `91009ad`   |
| `fix/construction-refusal-reason-field`                           | [#227](https://github.com/marabi766/RASTA/pull/227) | `eead32b`   |
| `docs/registry-sync-1005`                                         | [#230](https://github.com/marabi766/RASTA/pull/230) | `80474fc`   |
| `feat/contract-service-con003-pr2`                                | [#231](https://github.com/marabi766/RASTA/pull/231) | `ad1cfaa`   |
| `fix/web-select-reset-after-refusal`                              | [#232](https://github.com/marabi766/RASTA/pull/232) | `9974c36`   |
| `fix/deps-audit-1006`                                             | [#233](https://github.com/marabi766/RASTA/pull/233) | `418e7ac`   |
| `fix/asset-document-refs-on-transfer`                             | [#234](https://github.com/marabi766/RASTA/pull/234) | `85656d9`   |
| `feat/contract-service-con003-pr3`                                | [#235](https://github.com/marabi766/RASTA/pull/235) | `8125929`   |
| `fix/deps-sharp-1006`                                             | [#236](https://github.com/marabi766/RASTA/pull/236) | `c89971a`   |
| `chore/migration-verifier-psql-file`                              | [#237](https://github.com/marabi766/RASTA/pull/237) | `0fd6fe4`   |
| `fix/deps-source-map-js-pin`                                      | [#238](https://github.com/marabi766/RASTA/pull/238) | `ee10023`   |
| `fix/web-forged-baseline-flake`                                   | [#239](https://github.com/marabi766/RASTA/pull/239) | `9f07f9f`   |
| `fix/document-timestamptz`                                        | [#242](https://github.com/marabi766/RASTA/pull/242) | `f6ef73f`   |
| `fix/contract-signature-policy-gateway`                           | [#243](https://github.com/marabi766/RASTA/pull/243) | `128dbd9`   |
| `fix/contract-read-snapshot`                                      | [#244](https://github.com/marabi766/RASTA/pull/244) | `88b937e`   |
| `fix/contract-audit-findings`                                     | [#248](https://github.com/marabi766/RASTA/pull/248) | `27f0c22`   |
| `feat/web-exp-003-settlements`                                    | [#249](https://github.com/marabi766/RASTA/pull/249) | `e61a253`   |
| `fix/contract-audit-followups`                                    | [#251](https://github.com/marabi766/RASTA/pull/251) | `603dd05`   |
| `feat/web-exp-004-construction-read`                              | [#252](https://github.com/marabi766/RASTA/pull/252) | `ce5a534`   |
| `docs/contract-admin-refusal-oracle`                              | [#254](https://github.com/marabi766/RASTA/pull/254) | `1934750`   |
| `fix/construction-tender-close-plan-test`                         | [#255](https://github.com/marabi766/RASTA/pull/255) | `4ab9c01`   |
| `fix/economic-scoped-cursor`                                      | [#256](https://github.com/marabi766/RASTA/pull/256) | `c713913`   |
| `feat/inventory-service-skeleton`                                 | [#246](https://github.com/marabi766/RASTA/pull/246) | `6aef114`   |
| `docs/registry-sync-1013`                                         | [#258](https://github.com/marabi766/RASTA/pull/258) | `c73a55a`   |
| `test/contract-lifecycle-e2e`                                     | [#241](https://github.com/marabi766/RASTA/pull/241) | `d29ea84`   |
| `fix/web-settlements-auditor-nav`                                 | [#260](https://github.com/marabi766/RASTA/pull/260) | `5038367`   |
| `fix/marketplace-idempotency-gaps`                                | [#253](https://github.com/marabi766/RASTA/pull/253) | `efb5d70`   |
| `fix/marketplace-lease-takeover-test`                             | [#265](https://github.com/marabi766/RASTA/pull/265) | `b553322`   |
| `fix/inventory-pool-exhaustion-test`                              | [#264](https://github.com/marabi766/RASTA/pull/264) | `f571508`   |
| `feat/outbox-purge-phase1`                                        | [#247](https://github.com/marabi766/RASTA/pull/247) | `2883320`   |
| `fix/fleet-dispatch-insurance-in-force`                           | [#240](https://github.com/marabi766/RASTA/pull/240) | `9ec2f17`   |
| `feat/web-exp-004-tenders-read`                                   | [#262](https://github.com/marabi766/RASTA/pull/262) | `9013dea`   |
| `feat/web-exp-003-place-order`                                    | [#245](https://github.com/marabi766/RASTA/pull/245) | `a9dabad`   |
| `fix/construction-audit-findings`                                 | [#250](https://github.com/marabi766/RASTA/pull/250) | `03f2ffd`   |
| `fix/shutdown-followups`                                          | [#267](https://github.com/marabi766/RASTA/pull/267) | `39013a1`   |
| `ci/integration-timeout`                                          | [#273](https://github.com/marabi766/RASTA/pull/273) | `285a2dc`   |
| `fix/marketplace-receipt-note`                                    | [#263](https://github.com/marabi766/RASTA/pull/263) | `f33e613`   |
| `fix/web-nav-realm-admin`                                         | [#266](https://github.com/marabi766/RASTA/pull/266) | `69898d4`   |
| `feat/inventory-shipments`                                        | [#257](https://github.com/marabi766/RASTA/pull/257) | `dc88cac`   |
| `fix/error-path-no-query`                                         | [#259](https://github.com/marabi766/RASTA/pull/259) | `eb800cc`   |
| `fix/shutdown-phase2`                                             | [#270](https://github.com/marabi766/RASTA/pull/270) | `50f4596`   |
| `feat/web-exp-004-inventory-read`                                 | [#269](https://github.com/marabi766/RASTA/pull/269) | `c2f2ffc`   |
| `fix/audit-evidence-test-marker`                                  | [#272](https://github.com/marabi766/RASTA/pull/272) | `97e86b8`   |
| `fix/construction-award-tx-test`                                  | [#271](https://github.com/marabi766/RASTA/pull/271) | `413ba27`   |
| `chore/ci-split-integration`                                      | [#274](https://github.com/marabi766/RASTA/pull/274) | `ef43df9`   |
| `fix/document-outbox-shutdown-flake`                              | [#278](https://github.com/marabi766/RASTA/pull/278) | `40ce099`   |
| `docs/registry-sync-1014`                                         | [#275](https://github.com/marabi766/RASTA/pull/275) | `57b3220`   |
| `fix/organization-hierarchy-flake`                                | [#282](https://github.com/marabi766/RASTA/pull/282) | `7af3084`   |
| `fix/fleet-dev-start`                                             | [#281](https://github.com/marabi766/RASTA/pull/281) | `0f4bd10`   |
| `chore/prisma-pool-config`                                        | [#268](https://github.com/marabi766/RASTA/pull/268) | `2eccb9c`   |
| `fix/shutdown-phase3`                                             | [#279](https://github.com/marabi766/RASTA/pull/279) | `2e40643`   |
| `fix/organization-hierarchy-lock-order`                           | [#286](https://github.com/marabi766/RASTA/pull/286) | `b1552bc`   |
| `fix/logging-scrub-linear`                                        | [#289](https://github.com/marabi766/RASTA/pull/289) | `7f7c96b`   |

> **هشدار پابرجا:** ref محلی `main` در مخزن اصلی `F:\Rasta` صدها کامیت عقب
> است و می‌ماند. هیچ Worktreeای `main` را checkout نکرده، پس `git fetch` آن ref
> را جلو نمی‌برد. **همیشه `origin/main` را مبنا بگیرید، نه `main`** — وگرنه
> `git diff main` و `git merge-base main …` نتیجهٔ بی‌معنی می‌دهند.

---

## ۲۶٫۴ سطح تداخل — فایل‌هایی که چند شاخه لمس می‌کنند

پیش از ویرایش هرکدام از این‌ها، ستون «چه کسی الان لمسش می‌کند» را ببینید.
این فهرست از روی تداخل‌های واقعی این مخزن ساخته شده، نه از روی حدس.

| فایل                                                        | چرا پرتداخل است                                                                                             | الان چه کسی                                                                                                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `docs/24-open-questions.md`                                 | هر شاخه پرسش تازه‌اش را ته همین فایل می‌افزاید و جدول § ۲۴٫۱۰ را بازمی‌شمارد. **منبع هر سه حادثهٔ § ۲۶٫۱.** | #283 (server-worker-4)                                                                                               |
| `docs/21-adr-list.md`                                       | هر ADR تازه یک ردیف فهرست و یک بخش می‌خواهد؛ شمارهٔ تکراری اینجا آشکار می‌شود                               | —                                                                                                                    |
| `docs/23-risks-and-tradeoffs.md`                            | هر ریسک تازه (`D-NNN`) ته همین فایل افزوده می‌شود                                                           | #276 (server-worker-2)، #277 (server-worker-4)، #280 (server-worker-2)، #283 (server-worker-4)، #287 (server-worker) |
| `package.json` → زنجیرهٔ `test:migration`                   | هر سرویس تازه نامش را به **یک خط** اضافه می‌کند                                                             | #283 (server-worker-4)، #284 (server-worker-3)، #285 (server-worker-4)                                               |
| `.github/workflows/ci.yml`                                  | بلوک‌های توضیحی‌اش ادعای واقعی دارند؛ دو طرف می‌توانند بدون تداخل متنی **معناً متناقض** شوند                | #283 (server-worker-4)، #284 (server-worker-3)، #285 (server-worker-4)، #288 (server-worker)                         |
| `scripts/verify-migration-reversible-lib.mjs` و `.test.mjs` | هر سرویس یک بخش تازه می‌افزاید (معمولاً افزایشی و بی‌دردسر)                                                 | #283 (server-worker-4)، #287 (server-worker)                                                                         |
| `pnpm-lock.yaml`                                            | هر نصب بازتولیدش می‌کند                                                                                     | #261 (server-worker-2)؛ و هر شاخه‌ای که وابستگی اضافه کند                                                            |
| `PROJECT_MEMORY.md`                                         | همه بعد از ادغام می‌خواهند به‌روزش کنند                                                                     | —                                                                                                                    |
| `docs/26-branch-registry.md`                                | جدول فعال یک‌جا بازچینی می‌شود؛ ویرایش هم‌زمان = تداخل در همان جدول                                         | — (از 2026-10-15 فقط مدیر پروژه؛ قاعدهٔ ۷)                                                                           |
| `.env.example`                                              | هر کلید پیکربندی تازه اینجا اضافه می‌شود                                                                    | #276 (server-worker-2)، #277 (server-worker-4)، #280 (server-worker-2)                                               |

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

شماره را مدیر پروژه در دستور کار واگذار می‌کند (قاعدهٔ ۴). نشست کاری پیش از
برداشتن، آن را روی `origin/main` و شاخهٔ هر PR باز وارسی و در سند خودش رزرو
می‌کند؛ **این جدول را مدیر پروژه** در همگام‌سازی دوره‌ای از روی همان اسناد
به‌روز می‌کند و PR ویژگی آن را نمی‌نویسد (قاعدهٔ ۷).

### ADR

| شماره     | مالک                                      | وضعیت                                                                                            |
| --------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| ۰۵۴       | `feat/notification-service`               | روی `main` (`cc89660`)                                                                           |
| ۰۵۵       | `feat/audit-service-aud-004-contract`     | روی `main` (`9fa75cc`)                                                                           |
| ۰۵۶       | `docs/inventory-logistics-adr`            | روی `main` (`f2eb8fa`)                                                                           |
| ۰۵۷       | `docs/audit-immutable-archive`            | مصرف شد — بازشماری از ۰۵۵ انجام شد                                                               |
| ۰۵۸       | `feat/web-foundation`                     | مصرف شد — جای پورتال وب و مرز Design System                                                      |
| ۰۵۹       | `feat/web-session-and-shell`              | روی `main` (`3cf79aa`) — نگهداشت توکن در پورتال                                                  |
| ۰۶۰       | `fix/identity-tenant-bound-roles`         | روی `main` (`6b9b956`) — نقش‌های سراسری                                                          |
| ۰۶۱       | `docs/adr-061-event-provenance`           | روی `main` (`3115f4d`) — منشأ رویداد                                                             |
| ۰۶۲       | `fix/asset-transfer-clearance`            | روی `main` (`9bcc7dc`، #127) — پاک‌سازی انتقال دارایی در برابر کار باز                           |
| ۰۶۳       | `claude/new-session-6ektto`               | روی `main` (`7a5233c`، #119) — چرخهٔ عمر ساخت و مالکیت سیاست موافقت                              |
| ۰۶۴       | `fix/economic-payment-reconciler`         | روی `main` (`fd5a42e`، #140) — آشتی‌دهندهٔ پایدار پرداخت                                         |
| ۰۶۵ … ۰۶۷ | `feat/construction-tender-adr`            | روی `main` (`33935aa`، #156) — چرخهٔ عمر مناقصه، محرمانگی پیشنهاد، ارزیابی و تعارض منافع         |
| ۰۶۸       | `feat/contract-service-con003-pr1`        | روی `main` (`25744c6`، #228) — چرخهٔ عمر قرارداد و مرز `contract-service`                        |
| ۰۶۹       | `feat/web-exp-002-documents-availability` | روی `main` (`91009ad`، #225) — بارگذاری مدرک از راه سرور پورتال؛ مرورگر به ذخیره‌ساز وصل نمی‌شود |
| ۰۷۰+      | آزاد                                      | —                                                                                                |

### پرسش‌های باز `Q-NN`

| شماره         | مالک                                         | وضعیت                                                                                                                         |
| ------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Q-44          | تصمیم محصول MVP                              | **بسته** روی `main` و تثبیت‌شده با نقل‌قول کلمه‌به‌کلمه در `ADR-056 § ۲` — تغییرناپذیر                                        |
| Q-45 … Q-55   | `feat/audit-service-aud-004-contract`        | روی `main`                                                                                                                    |
| Q-56          | `feat/supplier-performance-phase2`           | روی `main` (`f7252d3`)                                                                                                        |
| Q-57          | `feat/audit-service-aud-004-contract`        | روی `main`                                                                                                                    |
| Q-58          | `docs/audit-immutable-archive`               | مصرف شد — بازشماری از `Q-44`؛ سیاست لنگرگذاری خارجی، همراه `ADR-057`                                                          |
| Q-59          | `feat/asset-insurance-claim-api`             | روی `main` (`fa14ef4`) — مرجع تأیید/رد ادعای خسارت بیمه و مالکیت اجرای تسویه                                                  |
| Q-60          | `fix/identity-role-grant-ladder`             | روی `main` (`9347b80`) — مرجع اعطای نقش: چه نقشی چه نقش‌هایی را می‌دهد، و چه عضویتی را اداره می‌کند                           |
| Q-61          | `fix/identity-cross-tenant-provisioning`     | روی `main` (`cfdb7b0`) — مرجع ساخت حساب در سازمانی جز سازمان خود. **پس از استفاده ثبت شد** — #81 بدون رزرو پیشین آن را برداشت |
| Q-62          | `claude/upbeat-tesla-cenkph`                 | روی `main` (#90) — مرجع استرداد (Refund) تراکنش: چه کسی، از کدام وضعیت                                                        |
| Q-63          | `fix/identity-tenant-bound-roles`            | روی `main` (`6b9b956`) — نقش‌های سراسری؛ همراه `ADR-060`                                                                      |
| Q-64          | `claude/adoring-cerf-nhq97e`                 | روی `main` (`8b3136b`)؛ بسته با تصمیم مالک پروژه در #104 (`771a491`) — چه نقشی سیاست حکمرانی را تنظیم می‌کند                  |
| Q-65          | `fix/fleet-dispatch-and-usage-integrity`     | روی `main` (`b55e4e9`) — کدام پوشش بیمه مانع اعزام است، و چه چیزی مانع معاینه را برمی‌دارد                                    |
| Q-66          | `fix/asset-transfer-and-insurance-integrity` | روی `main` (`aa4efcc`، #108) — آیا بیمهٔ مالک پیشین پس از انتقال پوشش مالک جدید است                                           |
| Q-67          | `claude/adoring-cerf-nhq97e-org-concurrency` | روی `main` (`333aa76`، #111) — آیا `/ancestors` برای غیراپراتور زنجیرهٔ بالاتر از ریشهٔ قابل‌دید را نشان دهد                  |
| Q-68 … Q-73   | `claude/new-session-6ektto`                  | روی `main` (`7a5233c`، #119) — پرسش‌های CON-001 (مدل پروژه، نقش‌ها، مرجع موافقت، اجرا، پیشرفت، مهلت)                          |
| Q-74          | `fix/asset-transfer-clearance`               | روی `main` (`9bcc7dc`، #127) — سرنوشت کار باز مالک پیشین پس از انتقال دارایی                                                  |
| Q-75          | `claude/modest-carson-jl3e5v`                | روی `main` (`9e85472`، #120)؛ **بسته** با تصمیم مالک پروژه — فرمول امتیاز تأمین‌کننده                                         |
| Q-76          | `fix/economic-ledger-reversal-guard`         | روی `main` (`0212ca5`، #123) — معنای برگرداندن تسویه، استرداد یا پاداش                                                        |
| Q-77 … Q-79   | `feat/supplier-performance-consumer`         | روی `main` (`f9d0b84`، #126) — قواعد موتور امتیاز؛ **منتظر پاسخ مالک**، گام ۶ مسدود                                           |
| Q-80          | `fix/organization-union-admin-scope`         | روی `main` (`e686fb0`، #132) — دامنهٔ `UNION_ADMIN` در ثبت سازمان‌ها                                                          |
| Q-81, Q-82    | `fix/economic-payment-reconciler`            | روی `main` (`fd5a42e`، #140) — Capture پرداخت Authorize‌شده؛ حل انسانی پرداخت تشدیدشده                                        |
| Q-83          | `fix/construction-policy-on-org-moved`       | روی `main` (`5091890`، #148) — سیاست موافقت پس از جابه‌جایی سازمان                                                            |
| Q-84 … Q-90   | `feat/construction-tender-adr`               | روی `main` (`33935aa`، #156) — پرسش‌های طراحی CON-002                                                                         |
| Q-91          | `feat/construction-tender-open`              | روی `main` (`f79f100`، #184) — بازگشایی پیشنهادها                                                                             |
| Q-92          | `feat/construction-tender-evaluation`        | روی `main` (`afac1bc`، #190) — ارزیابی پیشنهادها                                                                              |
| Q-93          | `feat/construction-tender-award`             | روی `main` (`982ef27`، #199) — انتخاب برنده                                                                                   |
| Q-94          | `feat/web-exp-002-asset-lifecycle`           | روی `main` (`f400f1e`، #195) — دارایی دارای کار باز و خروج از سرویس                                                           |
| Q-95 … Q-97   | `feat/contract-service-con003-pr1`           | روی `main` (`25744c6`، #228) — پرسش‌های CON-003 (امضا و ابطال، صورت‌وضعیت و تأیید، تسویه)                                     |
| Q-98          | `feat/web-exp-002-documents-availability`    | روی `main` (`91009ad`، #225) — نگاشت نوع مدرک به ردهٔ document-service، سقف بدنهٔ بارگذاری، اثر سهمیهٔ ساعتی                  |
| Q-99          | `fix/asset-document-refs-on-transfer`        | روی `main` (`85656d9`، #234) — ارجاع‌های مدرک مالک قبلی پس از انتقال دارایی                                                   |
| Q-100         | `feat/contract-service-con003-pr3`           | روی `main` (`8125929`، #235) — الحاقیه و Milestone                                                                            |
| Q-101         | `fix/fleet-dispatch-insurance-in-force`      | روی `main` (`9ec2f17`، #240)                                                                                                  |
| Q-102 … Q-109 | `feat/inventory-service-skeleton`            | روی `main` (`6aef114`، #246) — پرسش‌های COM-006 PR 1                                                                          |
| Q-110         | `fix/marketplace-idempotency-gaps`           | روی `main` (`efb5d70`، #253؛ تصمیم موقت در #263، `f33e613`) — یادداشت سفارش پذیرفته می‌شد ولی ذخیره نمی‌شد                    |
| Q-111, Q-112  | —                                            | بی‌استفاده — نخست با Q-110 برای #257 کنار گذاشته شد؛ Q-110 دوبار داده شده بود و رزرو #257 جابه‌جا شد                          |
| Q-113 … Q-115 | `feat/inventory-shipments`                   | روی `main` (`dc88cac`، #257)                                                                                                  |
| Q-116         | —                                            | بی‌استفاده — رزرو #253 (دور ۲) به‌کار نرفت؛ #253 بدون آن ادغام شد و روی `main` نیست                                           |
| Q-117         | `fix/construction-audit-findings`            | روی `main` (`03f2ffd`، #250) — سقف واقعی پیشنهادهای هر مناقصه                                                                 |
| Q-118         | `fix/marketplace-saga-activity-replay`       | روی شاخهٔ #283 (باز) — Saga سفارشی که با وجه در Hold متوقف شد: چه کسی و با چه ابزاری جبران کند                                |
| Q-119+        | آزاد                                         | —                                                                                                                             |

### ریسک‌های `D-NNN` (`docs/23`)

شماره‌های تازهٔ `docs/23` را هم مدیر پروژه در دستور کار تخصیص می‌دهد؛ کارگر پیش از نوشتن، آن را با `origin/main` و همهٔ شاخه‌های باز می‌سنجد و در خود `docs/23` رزرو می‌کند، و مدیر پروژه آن را در همگام‌سازی دوره‌ای همین‌جا ثبت می‌کند (شاخه‌ها شمارهٔ یکدیگر را نمی‌بینند).

| شماره         | مالک                                          | وضعیت                                                                                                        |
| ------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| D-033         | `fix/asset-transfer-clearance`                | روی `main` (`9bcc7dc`، #127)                                                                                 |
| D-036         | `feat/supplier-performance-consumer`          | روی `main` (`f9d0b84`، #126) — Consumer عملکرد تا احراز Broker خاموش                                         |
| D-037         | `fix/keycloak-projector-race`                 | روی `main` (`0c3067a`، #129) — پنجرهٔ باقی‌ماندهٔ ایمیل و نام در Projector کی‌کلاک                           |
| D-038 … D-045 | شاخه‌های 09-28 تا 10-01                       | روی `main` — عنوان هرکدام در `docs/23`                                                                       |
| D-046         | `fix/economic-payment-reconciler-b3`          | روی `main` (`7660d99`، #175)؛ پیگیری در #204 (`c028ee5`) — سابقهٔ حسابرسی حل انسانی آشتی                     |
| D-047         | `fix/d045-credentials-out-of-argv`            | روی `main` (`8c88d2e`، #191) — URL پایگاه داده در argv موتور Prisma                                          |
| D-048         | `chore/db-session-utc-and-tenant-index-check` | روی `main` (`0f461d0`، #214) — ستون‌های لحظهٔ بی منطقهٔ زمانی (`timestamp(3)`)                               |
| D-049         | `fix/identity-one-live-membership`            | روی `main` (`92cd37f`، #219) — غیرفعال‌سازی از کنسول Keycloak در پنجرهٔ نخستین فعال‌سازی                     |
| D-050, D-051  | `feat/contract-service-con003-pr2`            | روی `main` (`ad1cfaa`، #231) — امضا و `ORGANIZATION_MOVED` همزمان؛ علت تعلیق یا بازبینی امضا اثبات‌پذیر نیست |
| D-052         | `fix/document-timestamptz`                    | روی `main` (`f6ef73f`، #242) — ردیف‌های منتشرشدهٔ Outbox هرگز پاک نمی‌شوند؛ فاز ۱ پاک‌سازی: #247 (`2883320`) |
| D-053         | `fix/marketplace-saga-activity-replay`        | روی شاخهٔ #283 (باز) — Retry یک Activity در Saga سفارش پس از جلو رفتن سفارش                                  |
| D-054         | `fix/economic-idempotent-response-in-tx`      | روی شاخهٔ #287 (باز) — شکستِ پس از Commit یک فرمان Idempotent اقتصادی کلیدش را آزاد می‌کرد                   |
| D-055+        | آزاد                                          | —                                                                                                            |

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

ساختن شاخه را به مدیر پروژه اعلام کنید (نام شاخه، مسیر Worktree، نشست، و `sha`ِ
`origin/main` که از آن ساخته شد). ردیف § ۲۶٫۳ را او می‌نویسد (قاعدهٔ ۵).

و پیش از شروع کار، این چهار را وارسی کنید:

```bash
git fetch origin                                   # ۱. آخرین وضعیت را بگیر
git worktree list                                  # ۲. این شاخه جای دیگری checkout نیست؟
gh pr list --state open                            # ۳. PR فعال دیگری همین فایل‌ها را دست می‌زند؟
git merge-tree --write-tree <شاخه> origin/main     # ۴. تداخل متنی را پیش‌بینی کن
```

اگر به شمارهٔ ADR یا `Q-NN` نیاز دارید، **پیش از** نوشتن آن را از مدیر پروژه
بگیرید (قاعدهٔ ۴).

---

## ۲۶٫۸ تاریخچهٔ رویدادها

| تاریخ      | رویداد                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-17 | PR #45 ادغام شد (`f2eb8fa`). نوزده دقیقه بعد، کامیت `26ec7d9` روی شاخهٔ C3 همان فایل را عوض کرد و PR #48 را `CONFLICTING` کرد. C3 این را «قطعی GitHub Actions» تشخیص داد و یک کامیت retrigger زد که نمی‌توانست کمکی کند.                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2026-09-18 | PR #44 ادغام شد (`9fa75cc`). یادداشت «شکاف عمدی در شماره‌گذاری» از `docs/21-adr-list.md` برداشته شد و `ADR-055` سر جایش نشست.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-09-18 | شاخه‌های C2 و C3 از ماشین `10.20.30.6` به این سیستم منتقل شدند — آن ماشین پایگاه‌دادهٔ بقیهٔ سرویس‌ها را migrate نکرده بود و بخشی از زنجیرهٔ `test:migration` اصلاً اجرا نمی‌شد. بلافاصله پس از انتقال، C3 اشکالی پیدا کرد که فقط با پایگاه‌دادهٔ واقعی دیده می‌شد: constraint علت لغو بدون backfill (`0e4ab9f`).                                                                                                                                                                                                                                                                                                               |
| 2026-09-18 | PR #46 ادغام شد (`cc89660`). تداخل معنایی `@AllowService` که هیچ ابزار merge نشانش نمی‌داد، با `9c2ddc6` رفع شد.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-09-18 | PR #47 از پایهٔ `feat/notification-service` به `main` منتقل شد و با `close`/`reopen` اولین اجرای CI تاریخ آن شاخه ساخته شد.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 2026-09-25 | مالک پروژه پذیرفت: § ۲۶٫۳ و § ۲۶٫۵ را فقط مدیر پروژه ویرایش می‌کند (قاعدهٔ ۴ و ۵). در همان روز جدول شاخه‌های فعال دست‌کم شش بار PRهای باز را `CONFLICTING` کرده بود و CI هرکدام را از نو راه انداخته بود.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-09-28 | همگام‌سازی با `main` روی `f9d0b84`: #107 تا #126 بازنشسته شدند، #127 تا #129 فعال‌اند؛ دفتر `D-NNN` افزوده شد (D-037 برای #129). جدول فعال از 2026-09-25 به‌روز نشده بود.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 2026-10-03 | همگام‌سازی با `main` روی `7781335`: #127 تا #209 بازنشسته شدند؛ #206، #208 و #210 فعال‌اند؛ دفتر شماره‌ها تا ADR-067، Q-94 و D-047 به‌روز شد. جدول فعال از 2026-09-28 به‌روز نشده بود — یادآوری اینکه این سند جز با به‌روزرسانی منظم مدیر پروژه کهنه می‌شود.                                                                                                                                                                                                                                                                                                                                                                    |
| 2026-10-05 | همگام‌سازی با `main` روی `25744c6`: #206، #208 و #210 تا #229 (جز #225 و #227) بازنشسته شدند؛ #225 و #227 فعال‌اند و CON-003 PR 2 در راه است. ADR-068 و Q-95 تا Q-97 روی `main`؛ ADR-069 و Q-98 برای #225 رزرو شد — نخست درخواستِ پاسخ‌نگرفتهٔ #225 همان ADR-068 و Q-95 بود که برای #228 رزرو شده بود، و پیش از برخورد جابه‌جا شد. D-048 و D-049 روی `main`.                                                                                                                                                                                                                                                                    |
| 2026-10-13 | همگام‌سازی با `main` روی `ce5a534`: #208، #225، #227 و #230 تا #255 (جز PRهای باز) بازنشسته شدند؛ #240، #241، #245، #246، #247، #250، #253، #256 و #257 فعال‌اند. ADR-069، Q-98 تا Q-100 و D-050 تا D-052 روی `main`. Q-110 دوبار رزرو شده بود (#253 و #257)؛ رزرو #257 پیش از شروع کار به Q-113 تا Q-115 جابه‌جا شد و Q-111 و Q-112 بی‌استفاده ماندند.                                                                                                                                                                                                                                                                         |
| 2026-10-14 | همگام‌سازی با `main` روی `dc88cac`: #240، #241، #245، #246، #247، #250، #253، #256، #257 و #258 تا #273 (جز PRهای باز) بازنشسته شدند؛ #259، #261، #268، #269، #270، #271، #272 و #274 فعال‌اند. Q-101 تا Q-110، Q-113 تا Q-115 و Q-117 روی `main`؛ Q-111، Q-112 و Q-116 بی‌استفاده ماندند. آخرین شماره‌های `main`: ADR-069، Q-117، D-052؛ بعدی آزاد: ADR-070، Q-118، D-053 (روی `main` و شاخهٔ هر PR باز وارسی شد).                                                                                                                                                                                                             |
| 2026-10-15 | همگام‌سازی با `main` روی `7f7c96b`: #268، #269، #271، #272، #274، #275، #278، #279، #281، #282، #286 و #289 بازنشسته شدند (همه Squash)؛ #261، #276، #277، #280، #283 تا #285، #287، #288، #290 و #291 فعال‌اند؛ PR بسته‌شدهٔ بی‌ادغام نبود. مالک #290 کارگر ۳ و #291 کارگر ۲؛ مالک #280 از بدنهٔ #277 گرفته شد (کارگر ۲). D-053 و Q-118 (#283) و D-054 (#287) روی شاخهٔ PR باز؛ بعدی آزاد: ADR-070، Q-119، D-055 (روی `origin/main` و شاخهٔ هر PR باز با `git grep` وارسی شد). قاعدهٔ ۷ افزوده شد: PRهای ویژگی ردیف این سند را نمی‌نویسند. جدول § ۲۶٫۴ از روی diff زندهٔ شاخه‌ها تازه شد؛ هیچ PR بازی این سند را تغییر نمی‌دهد. |
