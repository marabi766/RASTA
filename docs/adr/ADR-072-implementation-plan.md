# ADR-072 — برنامهٔ اجرا (Q-80 (پ)، Q-61)

> برش PR به PR برای [ADR-072](ADR-072-union-membership-and-governed-set.md). **فقط PR 0 (همین، فقط سند) در جریان است**
> (2026-10-23)؛ این سند وضعیت نیست، نقشه است. هر PR یک سرویس است، جداگانه با CI سبز ادغام می‌شود، و آزمون‌هایی را که رفتار
> امروزِ همان سرویس را سنجاق کرده‌اند در **همان** PR عوض می‌کند (ADR-072 § ۷) — نه زودتر، چون پاسخ فقط‌زیردرختی تا PR آن سرویس
> دست نمی‌خورد.
>
> **دور ۲ (2026-11-03):** هفت یافته‌ی Codex دور ۱ (`~/rasta-audit/reviews/PR-362.md`) و افزوده‌های A تا H مدیر پروژه:
> PR 1a و 1b تازه، و PR 1، 2، 4، 6، 8 و 9 بازنویسی شدند.

**اندازه:** `S` ≈ تا ۳۰۰ خط تغییر با آزمون؛ `M` ≈ ۳۰۰ تا ۹۰۰؛ `L` ≈ ۹۰۰ تا ۲۰۰۰ (همان مقیاس برنامهٔ ADR-071). امتیاز برآوردی
کنار هر برش است؛ جمع (۴۵؛ دور ۱: ۳۶) برای هیچ قلم Backlogی نیست — **ساختن قلم و برآورد با مدیر پروژه است**؛ این سند `backlog.json` را تغییر
نمی‌دهد.

## نقشه

| PR  | سرویس / عنوان                                                                                                                                                    | اندازه | امتیاز | وابسته به |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ------ | --------- |
| 0   | طراحی: ADR-072، Q-144 تا Q-147، D-061 (همین؛ دور ۲)                                                                                                              | S      | ۱      | —         |
| 1a  | `nest-common` و `contracts`: `@AllowService` بی نام = خطا و رد (نه Wildcard)، `GovernanceClient` مشترک، نام و Schema ـِ دو رویداد، `ID_PREFIXES.unionMembership` | M      | ۳      | 0         |
| 1b  | `audit-service`: Projection ـِ رویداد عضویت (`UnionMembership/{membershipId}`)؛ **پیش از PR 1 مستقر می‌شود**                                                     | S      | ۱      | 1a        |
| 1   | `organization-service`: جدول عضویت، API، رویدادها، دید و نوشتن در `G`، پرسش درونی تکی و دسته‌ای، Seed                                                            | L      | ۸      | 1a، 1b    |
| 2   | `economic-service` — **نخست از چهار** (داده‌ی مالی)                                                                                                              | M      | ۵      | 1         |
| 3   | `document-service`                                                                                                                                               | S      | ۲      | 2         |
| 4   | `supplier-service`                                                                                                                                               | M      | ۴      | 2         |
| 5   | `marketplace-service`                                                                                                                                            | M      | ۳      | 2         |
| 6   | `identity-service` (Q-61)                                                                                                                                        | M      | ۵      | 1         |
| 7   | `audit-service` (ADR-053 § ۱۰)                                                                                                                                   | M      | ۳      | 1         |
| 8   | `construction-service` (Q-70 (۷)، Q-83)                                                                                                                          | M      | ۴      | 1         |
| 9   | `contract-service` (ADR-068 § ۵، Q-83)                                                                                                                           | M      | ۴      | 1         |
| 10  | پاک‌سازی: برداشتن پاسخ فقط‌زیردرختی، Replica حسابرسی از مسیر اختیار، اسناد (`docs/09`، ADR-053 § ۱۰، ADR-060 § ۲)                                                | S      | ۲      | 2 تا 9    |

PR 1a نخست؛ PR 1b و PR 1 پس از آن، و **PR 1b پیش از PR 1 مستقر می‌شود** (رویداد عضویت پیش از Projection آن تولید نمی‌شود،
ADR-072 § ۳). PR 3، 4 و 5 پس از ادغام PR 2 و موازی؛ PR 6 تا 9 پس از PR 1 و موازی با بقیه. **ترتیب استقرار** همان ترتیب ادغام
است، با یک گام عملیاتی میان PR 1 و PR 2 (پایین). امتیازهای دور ۲: PR 1a و 1b تازه (۳ + ۱)، PR 2 از ۳ به ۵ (شش فرمان مثبت، شش
بازپخش، حصار)، PR 4 از ۳ به ۴ (تکه‌بندی صف، `404` یکسان، یادداشت به‌ازای ردیف)، PR 8 و 9 هرکدام از ۳ به ۴ (پرسش سیاست به درون
تراکنش اثر).

**قاعده‌های مشترک هر PR مصرف‌کننده (2 تا 9؛ ADR-072 § ۴، § ۵):** `GovernanceClient` از PR 1a و نام سرویس در
`GOVERNANCE_CALLERS`؛ امضای مستأجر فقط از سازمان فعال (واگذاری مستقیم) یا نویسنده‌ی ذخیره‌شده‌ی سیاست؛ پرسش پیش از تراکنش فقط رد
زودهنگام، و پرسش تعیین‌کننده درون تراکنش اثر پس از قفل‌ها با `fence(tx)` به‌عنوان آخرین Statement؛ خواندن با سنجش سن پاسخ؛
ناتوانی روی هدف ذخیره‌شده ← همان `404` ـِ ناموجود؛ هر کدام با آزمون در همان PR.

### گام عملیاتی تولید (نه PR): ثبت عضویت‌های واقعی

PR 2، 3، 4 و 5 دید اتحادیه را **همان لحظهٔ استقرار** به `G` می‌رسانند. اگر در تولید هنوز عضویتی ثبت نشده باشد، `G = subtree`
و اتحادیه دید دهیاری‌ها را در آن چهار سرویس از دست می‌دهد تا ثبت انجام شود. پس پس از استقرار PR 1 و **پیش از** استقرار PR 2:
`SYSTEM_ADMIN` فهرست اعضای هر اتحادیه را — که واقعیت مالک است، نه Seed — با `POST /v1/organizations/{unionId}/members`
(`expectedLatestMembershipId: null` برای عضوی که هرگز دوره‌ای نداشته) ثبت
می‌کند و با `GET .../members` وارسی. این گام در جدول «گام‌های یک‌باره پس از استقرار» `docs/deployment/README.md` (اگر تا آن
موقع روی `main` باشد) یا در توضیح PR 1 می‌آید. در محیط توسعه و CI، Seed PR 1 همین را می‌کند.

## برش‌ها

### PR 1a — `nest-common` و `contracts` (`M`)

- **`@AllowService` بی Wildcard** (ADR-072 § ۴، یافته‌ی ۳): امضای `AllowService(first, ...rest)` با نوع `[string, ...string[]]`،
  خطا هنگام بارگذاری Module برای فهرست تهی (هفت کاربرد Spread امروز: `STANDING_OF_CALLERS`، `MEMBERSHIP_READ_CALLERS`،
  `LIVE_MEMBERSHIP_CALLERS`، `POLICY_STANDING_CALLERS`، `SNAPSHOT_CALLERS`، `TRANSFER_RECORD_CALLERS`، `WORK_STATE_CALLERS`)، و در
  `auth.guard.ts:364` فهرست تهی = رد، نه Wildcard. آزمون گارد: فهرست تهی ← `403`؛ نام بیرون از فهرست ← `403`.
- **`GovernanceClient`** (ADR-072 § ۵): تکی و دسته‌ای؛ بسته در خطا با همان قرارداد `organization-hierarchy.ts` ـِ economic؛ کران
  پاسخ تکی ۱ KiB و هر تکه ۸ KiB؛ یکتاسازی و تکه‌های ۵۰ تایی، حداکثر ۵ هم‌زمان، **یک ددلاین کل**؛ سنجش هر `id` در برابر تکه‌ی
  درخواستی، بی تکرار؛ هر شکست ← کل `503`/`504`، هرگز نتیجه‌ی جزئی. امضای مستأجر فقط از ورودی صریح `scopeOrganizationId` (سازمان
  فعال یا نویسنده‌ی سیاست)، هم برای Claim و هم برای سرآیند. حصار سن پاسخ: `askedAt` با `clock_timestamp()` پیش از فرستادن، و
  `fence(tx)` ـِ آخرین Statement (خطا اگر `clock_timestamp() > askedAt + MAX_AGE`، و `set_config` ـِ `statement_timeout` و
  `idle_in_transaction_session_timeout` به `GOVERNANCE_COMMIT_GRACE_MS`)؛ برای خواندن، سن با ساعت Monotonic. متریک
  `..._governance_client_total{outcome}`.
- **`contracts`:** دو نام رویداد با Schema ـِ Payload (ADR-072 § ۳)، `PARTITION_SCOPE_OF`، `ID_PREFIXES.unionMembership = 'UMB'`،
  و Schema ـِ دو پاسخ درونی. هیچ تولیدکننده‌ای هنوز نیست.
- **آزمون‌ها:** Unit ـِ گارد و Client در برابر سرور جعلی (۵۰۳، ۵۰۴، `404` بی بدنه، بدنه‌ی بزرگ، `basis` ناشناخته، `id` ناخواسته یا
  تکراری، یک تکه‌ی کند، ۲۰۰ شناسه با تکرار ← ۴ تکه)؛ یکپارچگی حصار روی PostgreSQL (پاسخ کهنه ← Rollback، `EXPIRED`).
- **برگشت:** Revert؛ هیچ مصرف‌کننده‌ای هنوز به Client وابسته نیست. Revert ـِ بخش گارد فقط اگر هیچ سرویسی فهرست تهی نداشته باشد.

### PR 1b — `audit-service`: Projection ـِ رویداد عضویت (`S`)

- `src/audit/union-membership-projection.ts` هم‌شکل `settlement-refusal-projection.ts` (ADR-072 § ۳): فقط
  `ORGANIZATION_UNION_MEMBERSHIP_STARTED` و `..._ENDED` روی `rasta.organization.v1`؛ Payload با Schema ـِ `contracts` (PR 1a)؛
  `resourceType = 'UnionMembership'`، `resourceId = membershipId`؛ ناسازگار، پیشوند نادرست یا `memberOrganizationId ≠ aggregateId`
  ← DLQ. نشستن در `audit.mapper.ts` کنار سه Projection موجود.
- **آزمون‌ها:** Unit هر دو رویداد، دو دوره‌ی یک عضو ← دو منبع جدا، هر حالت DLQ؛ یکپارچگی Kafka در CI.
- **استقرار:** پیش از PR 1. **برگشت:** Revert فقط پیش از استقرار PR 1، یا همراه Revert آن.

### PR 1 — `organization-service` (`L`)

- **Migration** `union_membership` دقیقاً مانند ADR-072 § ۲: ستون‌ها، سه `CHECK`، Partial Unique Index
  `ux_union_membership_active_member`، دو نمایه، Trigger `trg_union_membership_append_only`؛ `down.sql` و
  `verify-migration-reversible` روی پایگاه دادهٔ ناخالی؛ `check:tenant-index-order` (جدول ستون `organization_id` ندارد؛ اگر
  نگهبان آن را مستأجری بشمارد، دلیل در همان PR نوشته می‌شود). `ID_PREFIXES.unionMembership` از PR 1a.
- **مخزن:** `withinGovernance(scopeId, id, db)` — یک Statement که `SELF`/`SUBTREE`/`MEMBER` و `hierarchy_version` را از یک
  Snapshot برمی‌گرداند؛ نسخهٔ دسته‌ای با `id = ANY($ids)`؛ ثبت و پایان زیر `lockHierarchy` با `nextHierarchyVersion` و
  به‌روزکردن `hierarchy_version` ردیف عضو.
- **دید و نوشتن** (ADR-072 § ۴): `visibleRoot` جای خود را به «دامنهٔ خواننده» می‌دهد (زیردرخت؛ به‌علاوهٔ اعضا فقط برای
  `UNION_ADMIN`)؛ `list`، `nearby`، `get`، `children`، `subtree`، `ancestors`، `policies`، `update`، `addLocation`، `addContact`،
  `setPolicy` — هرکدام با آزمون عضو / فرزند عضو / عضو اتحادیهٔ دیگر / `ORG-DEH-0003`. `create` زیر عضو رد. `changeStatus` به
  `DEACTIVATED` عضویت‌های زیردرخت را در همان تراکنش پایان می‌دهد.
- **API بیرونی** (ADR-072 § ۴): ثبت با `expectedLatestMembershipId` (`409 OPTIMISTIC_LOCK_FAILED` برای کهنه)، پایان با شناسه‌ی دوره
  در مسیر (`POST .../memberships/{membershipId}/end`؛ دوره‌ی پایان‌یافته ← `409`)، فهرست اعضا و سابقه‌ی عضویت یک سازمان
  (`.../union-memberships`) با Cursor و کران قرارداد (پیش‌فرض ۲۵، بیشینه ۲۰۰)، نمای دوره‌ی پایان‌یافته برای اتحادیه بی `reason` و
  بی داده‌ی دیگر عضو، ستون‌های اپراتور فقط برای `SYSTEM_ADMIN`. **درونی** (`GET /v1/internal/organizations/{id}/governance`،
  `POST /v1/internal/organizations/governance` با ۱ تا ۵۰ شناسه) **بی هیچ `@AllowService`**، و Handler فقط `SERVICE` با
  `callerService` در `GOVERNANCE_CALLERS` (نخست تهی) را می‌پذیرد — هر مصرف‌کننده نام خودش را در PR خودش به هر دو می‌افزاید. پرسش
  روی Client ـِ `DATABASE_URL` (Primary) و `readSnapshot`. OpenAPI و آزمون OpenAPI.
- **آزمون‌های دور ۲:** وضعیت نخستین استقرار — `fleet-service` (نامرتبط) با توکن معتبر امضاشده برای `ORG-UNION-YAZD` و توکن کاربر
  روی هر دو مسیر درونی ← `403`؛ پایان، ثبت جانشین، بازتلاش پایان اول ← `409` و جانشین فعال؛ ثبت با انتظار کهنه ← `409`؛ سابقه با
  `limit` ۲۵ و ۲۰۰ تا پایان Cursor؛ دسته‌ای با ۵۱ شناسه یا تکراری ← `400`؛ پرسش `governance` از Client ـِ Primary.
- **رویدادها:** دو نام از `contracts` (PR 1a) در Outbox همان تراکنش؛ ردیف‌ها در `docs/events/README.md` (§ Organization) به‌جای
  یادداشت «برنامه‌ریزی‌شده». **پیش‌شرط استقرار:** PR 1b روی audit مستقر شده باشد.
- **Seed:** عضویت `ORG-DEH-0001` و `ORG-DEH-0002` در `ORG-UNION-YAZD`؛ `ORG-DEH-0003` زیر `ORG-COUNTY-YAZD`، عضو نه (ADR-072 § ۷)؛
  `ORG.outside` در `tests/e2e/src/env.ts`. اگر Seed سرویس دیگری فهرست سازمان‌ها را تکرار می‌کند (identity، asset، marketplace)،
  `ORG-DEH-0003` فقط جایی افزوده می‌شود که آزمونی آن را لازم دارد.
- **آزمون‌هایی که عوض می‌شوند:** `organization.service.spec.ts` (بخش Q-80، `:286`) و `test/union-admin-scope.int-spec.ts`؛ بخش
  «pinned, pre-existing (D-038)» همان‌جا بی‌تغییر.
- **اسناد:** `docs/04` (organization-service: جدول و Endpointها)، `docs/events`، بخش Q-80 در `docs/24` («پیاده در PR 1»).
- **برگشت:** Revert؛ هیچ مصرف‌کننده‌ای هنوز به آن وابسته نیست.

### PR 2 — `economic-service` (`M`)

- `PLATFORM_ROLES = ['SYSTEM_ADMIN']` در `src/access/access.ts:49` (نام ثابت بماند یا به `GLOBAL_ROLES` از `nest-common` برسد —
  هر کدام، یک منبع)؛ `hasPlatformScope` فقط `SYSTEM_ADMIN`.
- **«اجازه‌ی تلاش» جدا از دامنه‌ی سراسری** (یافته‌ی ۱): `CROSS_ORGANIZATION_CANDIDATE_ROLES = ['SYSTEM_ADMIN', 'UNION_ADMIN']` و
  `assertMayAttemptFinancialCommand(books)` (Auditor، نقش مالی، سرویس فقط برای طرف توکنش، و برای سازمان دیگر فقط شخص با این دو
  نقش — بی هیچ اختیار). `canActFinanciallyFor` (`:213`) آن را به‌جای `canCommitOrganization` (`:218`، که `:144` را دارد) صدا
  می‌زند و سپس تصمیم: `SYSTEM_ADMIN`، یا پرسش `G` برای `UNION_ADMIN` ← `UNION_GOVERNED` با `basis`، وگرنه `403`.
  `assertMayRefund` (`:500`) شاخه‌ی میان‌سازمانی را با همین گزاره می‌گیرد، نه `hasPlatformScope`. `canCommitOrganization` برای
  `journal-reversal.service.ts:80` فقط `SYSTEM_ADMIN`.
- `OrganizationHierarchy` (`src/organization/organization-hierarchy.ts`) ← `GovernanceClient` (PR 1a)؛ `economic-service` در
  `GOVERNANCE_CALLERS` و Allow-list ـِ organization-service.
- `assertTransactionVisible` و `assertWalletVisible` ناهمگام: `UNION_ADMIN` با پرسش دسته‌ای روی پرداخت‌کننده و دریافت‌کننده؛
  بیرون ← همان `404`.
- `canActFinanciallyFor` و `reconfirmFinancialAuthority`: `UNION_SUBTREE` ← `UNION_GOVERNED`، `basis` و `askedAt` در
  `recordFinancialCommand` و ستون‌های ثبت (اگر ستون `basis`ی هست؛ وگرنه فقط Log، مانند امروز برای پنج فرمان — S-06). حصار
  (`fence(tx)`) آخرین Statement تراکنش هر شش فرمان؛ `GOVERNANCE_ANSWER_MAX_AGE_MS` در `operation-budgets.ts`.
- **بی‌تغییر، با آزمون** (افزوده‌ی A): `refuseStatementWithdrawal` (`transaction.service.ts:742`، `:894`) و
  `assertMayDisputeDirectly` (`access.ts:535`–`:543`) در همان ترتیب `authorizeAct`.
- تراز آزمایشی (`ledger.controller.ts:139`، `:148`) و برگشت سند (`:121`، `journal-reversal.service.ts:77`): `@Roles('SYSTEM_ADMIN')`؛
  `routes.ts:207` (`ledger`) بی‌تغییر.
- **آزمون‌ها:** `src/access/access.spec.ts`، `test/union-admin-financial-authority.int-spec.ts` و هر فایل `test/` که `UNION_ADMIN`
  را با دامنه‌ی پلتفرمی فرض کرده. **یکپارچگی مثبت، هر شش فرمان** (`SETTLE`، `AUTHORISE_SETTLEMENT`، `DISPUTE`، `RESOLVE_DISPUTE`،
  `CANCEL`، `REFUND`) با `U ≠ M`: یک بار `M` عضو (`MEMBER`)، یک بار `M` در زیردرخت (`SUBTREE`)، رکورد با `basis` و نسخه؛ نوع
  تراکنشی که هر فرمان برایش مجاز است (نه تعهد سفارش برای اعتراض، نه تعهد صورت‌وضعیت برای لغو و بازپرداخت). **منفی:** بیرون از
  `G` ← `403`؛ درون `G` ولی تعهد صورت‌وضعیت ← رد `refuseStatementWithdrawal`، تعهد سفارش ← رد `assertMayDisputeDirectly`.
  **بازپخش** (افزوده‌ی B): هر شش فرمان با `Idempotency-Key`، پایان عضویت، بازپخش ← `403` با بدنه‌ی رد تازه؛ شمار ردیف‌های دفتر،
  موجودی کیف پول‌ها و ردیف‌های Outbox پیش و پس برابر. **کران:** پایان عضویت میان پرسش و حصار، و تأخیر بیش از `MAX_AGE` ←
  Rollback. E2E: `economic/02-critical-path.e2e-spec.ts:295`، `economic/03-authorization.e2e-spec.ts:84` (به‌علاوه‌ی مورد
  `ORG.outside`)، `marketplace/01-order-critical-path.e2e-spec.ts:306`، `:318` (ADR-072 § ۷).
- **اسناد:** `docs/10` (هرجا اتحادیه تراز را می‌خواند)، `docs/09` § ۹٫۳ پانویس ¹ برای economic.

### PR 3 — `document-service` (`S`)

- `hasPlatformScope` فقط `SYSTEM_ADMIN` (`src/access/access.ts:43`، `:63`)؛ `assertDocumentReadable`/`Writable` (`:100`، `:120`)
  ناهمگام با پرسش `G` روی مالک سند برای `UNION_ADMIN`؛ بیرون ← `404`.
- Client تازهٔ organization (همان قرارداد economic)؛ `ORGANIZATION_SERVICE_URL`، `DOCUMENT_ORGANIZATION_REQUEST_TIMEOUT_MS`؛
  `turbo.json`/Compose/CI env (همان نگهبان‌های `test:service-env-turbo`).
- **آزمون‌ها:** Helperهای `test/api-helpers.ts` و یکپارچگی خواندن/حذف سند عضو، `ORG-DEH-0003` و ناتوانی.
- تغییر و حذف سند: پرسش دوباره درون تراکنش پس از قفل ردیف سند، با `fence(tx)`؛ خواندن: پرسش پس از خواندن ردیف و سنجش سن پاسخ
  پیش از فرستادن (ADR-072 § ۵ (۳)، (۴)).

### PR 4 — `supplier-service` (`M`)

- `PLATFORM_ROLES` (`src/access/access.ts:75`) و `@Roles(...PLATFORM_ROLES)` در `supplier.controller.ts`: `SYSTEM_ADMIN` و
  `UNION_ADMIN` روی Route می‌مانند (گارد نقش، پیش از Lookup)، ولی تصمیم در `access.ts`: `assertCanDecideAbout` (`:406`)،
  `assertSupplierReadable` (`:291`) — `UNION_ADMIN` فقط با تأمین‌کننده‌ی درون `G`. **`404` یکسان** (یافته‌ی ۷): در `decide`
  (`qualification.service.ts:169`–`:175`)، `suspend` و `reinstate` (`suspension.service.ts:91`–`:94`، `:157`–`:160`)، بیرون از
  `G` برای `UNION_ADMIN` همان `RastaError.notFound('Supplier', id)` ـِ ناموجود است. پرسش تعیین‌کننده دوباره درون تراکنش تصمیم،
  پس از قفل ردیف تأمین‌کننده، با `fence(tx)`.
- **افشا** (افزوده‌ی F): `assertNotDecidingOwnCase` (`:352`) بی‌تغییر و پس از دامنه؛ `mayReadReviewerNote` (`:394`) ناهمگام یا با
  پاسخ دسته‌ای از پیش گرفته، **به‌ازای هر ردیف**: (`SYSTEM_ADMIN`، یا `UNION_ADMIN` با تأمین‌کننده‌ی درون `G`) و نه عضو
  تأمین‌کننده (`qualification.service.ts:295`–`:301`، `suspension.service.ts:210`، `supplier.service.ts:123`، `:144`).
- **صف** (`assertCanReviewQualifications`، `:245`؛ `listForReview`، `supplier.repository.ts:619`–`:637`): برای `UNION_ADMIN`
  سازمان‌های `limit` ردیف نخست یکتا و با `GovernanceClient` دسته‌ای صافی (حداکثر ۴ تکه برای ۲۰۰)؛ ردیف Lookahead نه پرسیده نه
  برگردانده؛ `nextCursor` = آخرین ردیف پیمایش‌شده. هر شکست پرسش ← `503`/`504` برای کل صفحه.
- `GovernanceClient`، env، `supplier-service` در `GOVERNANCE_CALLERS`.
- **آزمون‌ها:** `src/access/access.spec.ts`؛ یکپارچگی صف: صفحه‌ی پیش‌فرض (۲۵) و بیشینه (۲۰۰، ۲۰۱ ردیف خوانده) با سازمان‌های یکتا
  و تکراری؛ پیمایش Cursor از میان صفحه‌های کاملاً صافی‌شده (`items: []`، Cursor ـِ پیش‌رونده) تا پایان، بی ردیف گم یا تکراری؛ یک
  تکه‌ی شکست‌خورده ← کل صفحه `503`؛ تصمیم روی تأمین‌کننده‌ی ناموجود و بیرون از `G` ← بدنه‌ی `404` یکسان؛ داوری در کار خود با
  عضویت دوم ← `403`؛ یادداشت بازبین به‌ازای ردیف.
- **اسناد:** ADR-052 § ۱۶ یادداشت («خواندن همه» برای `UNION_ADMIN` ← درون دامنه)؛ `docs/24` Q-146 «پیاده با تصمیم موقت».

### PR 5 — `marketplace-service` (`M`)

- `hasPlatformScope` فقط `SYSTEM_ADMIN` (`src/access/access.ts:62`، `:81`)؛ `assertOrderVisible` (`:109`) و `assertReturnVisible`
  (`returns/return-access.ts:32`) ناهمگام: `UNION_ADMIN` با خریدار یا فروشندهٔ درون `G`؛ `assertOfferOwner` (`:160`) و
  `catalogue.service.ts:357` با مالک درون `G`. `assertDisputeResolver` (`:225`): نقش‌سنجی امروز (`hasPlatformScope`) به
  `SYSTEM_ADMIN` یا `UNION_ADMIN` صریح می‌رسد، و پایهٔ اتحادیه `UNION_GOVERNED` با `basis`. `viewerParties` نقش‌محور می‌ماند.
- **آزمون‌ها:** `src/access/access.spec.ts`؛ یکپارچگی: اختلاف سفارش خریدار عضو ← دیدنی و قابل حل؛ خریدار `ORG-DEH-0003` ← `404`
  برای `UNION_ADMIN`، دیدنی برای `SYSTEM_ADMIN`.
- `assertDisputeResolver` (`:247`) پس از قفل‌ها و ویرایش پیشنهاد درون تراکنش ویرایش، هر دو با `fence(tx)`؛ `marketplace-service`
  در `GOVERNANCE_CALLERS`.
- **اسناد:** یادداشت ADR-060 § ۲ («دست نمی‌خورد» برای marketplace جایگزین شد).

### PR 6 — `identity-service` (`M`)

- Client تازه (نخستین تماس identity با organization؛ `ORGANIZATION_SERVICE_URL`، `IDENTITY_ORGANIZATION_REQUEST_TIMEOUT_MS`،
  `InternalTokenService` از `nest-common`) و Allow-list.
- `isWithinProvisioningScope`/`assertMayProvisionInto` ناهمگام (`provisioning-scope.ts:96`، `:126`)؛ چهار فراخوان
  (`identity.service.ts:318`، `:664`، `:1305`، `:1621`) فقط رد زودهنگام‌اند؛ تصمیم در `authorizeLive`/`authorizeUnderLock` درون
  تراکنش Commit (`:331`، `:686`، `:1378`، `:1645`) با `fence(tx)`، با قاعده‌ی پاسخ ADR-072 § ۶ (`503` برای دو مسیر بدنه‌محور، `404`
  یکسان برای دو مسیر ثبت‌نام).
- **Keycloak** (ADR-072 § ۵ (۵)): ترتیب موجود بی‌تغییر — حساب غیرفعال و بی‌اعطا پیش از Commit، اعطا و فعال‌سازی فقط پس از Commit
  (`projectAfterCommit`). رد در تراکنش Commit ← Rollback و حساب غیرفعال بی‌اعطا؛ جبران همان مسیر تلاش ناموفق (Adoption فقط با
  همان کلید، که دوباره می‌پرسد).
- Boot: `USER_PROVISIONING_CROSS_ORG_ROLES` جز `SYSTEM_ADMIN` ← خطای پیکربندی.
- **آزمون‌ها:** `provisioning-scope.spec.ts`، یکپارچگی چهار مسیر با عضو، فرزند عضو، `ORG-DEH-0003`، ناموجود و ناتوانی؛ آزمون
  Oracle (`approve` روی ثبت‌نام بیرون از `G`، ناموجود و هنگام ناتوانی ← بدنه‌ی یکسان)؛ پایان عضویت میان پرسش زودهنگام و تراکنش
  Commit ← Rollback، حساب غیرفعال، هیچ اعطا، بازتلاش همان کلید ← رد.
- **اسناد:** `docs/24` Q-61 «پیاده»، `docs/09` (identity).

### PR 7 — `audit-service` (`M`)

- `resolveSubtreeTarget` (`src/audit/audit.scope.ts:40`) پرسش همزمان `G` (`GovernanceClient`) را جای `isWithinProjectedSubtree`
  می‌گذارد؛ متریک `SUBTREE_DECISIONS` به `DESCENDANT` / `MEMBER` / `REFUSED` / `UNAVAILABLE`. Consumer `organization_ref` می‌ماند
  (برداشتنش در PR 10). Projection ـِ رویداد عضویت از پیش در PR 1b است.
- `audit-service` در `GOVERNANCE_CALLERS`، env.
- **آزمون‌ها:** `audit.scope.spec.ts`، `test/kafka-projector.int-spec.ts` (Replica دیگر اختیار نمی‌دهد)؛ E2E
  `audit/01-query-authorization.e2e-spec.ts:165`–`:196` (ADR-072 § ۷).
- **اسناد:** ADR-053 § ۱۰ جدول نقش‌ها و پاراگراف Replica.

### PR 8 — `construction-service` (`M`)

- `src/organization/organization-directory.ts` ← `GovernanceClient`؛ `basis`، نسخه و `askedAt` جایی ثبت می‌شوند که نسخه امروز ثبت
  می‌شود. امضای مستأجر: واگذاری مستقیم با سازمان فعال، اعتبار سیاست با `policy.authorOrganizationId` (ADR-072 § ۴).
- **پرسش اعتبار نویسنده‌ی سیاست برای هر فراخوان** (یافته‌ی ۴): `confirmGoverningPolicy` (`approval.service.ts:319`–`:330`) از
  `prisma.client` به درون تراکنش گشودن دور، پس از قفل سیاست، با `fence(tx)`؛ ساختن و تغییر سیاست (`policy.service.ts:127`، `:212`،
  `:268`) دوباره درون تراکنش پس از قفل جایگاه سیاست.
- Consumer موجود (`src/events/organization-moved.consumer.ts`) `ORGANIZATION_UNION_MEMBERSHIP_ENDED` را هم می‌خواند — فقط
  `memberOrganizationId`، به‌عنوان محرک همان بازپرسی `policy-suspension.service.ts`؛ متریک‌ها برچسب رویداد می‌گیرند.
- **آزمون‌ها:** `test/organization-directory.int-spec.ts`، `test/policy-governance.int-spec.ts`؛ پایان عضویت ← تعلیق؛ ثبت دوباره ←
  بی بازفعال‌سازی؛ تحویل دوباره و `.retry` بی‌اثر؛ کاربر عادی سازمان عضو گشودن دور زیر سیاست اتحادیه: پرسش انجام می‌شود، پایان
  عضویت ← رد بی انتظار Consumer، organization-service در دسترس نیست ← `503`؛ E2E
  `construction/02-approval-lifecycle.e2e-spec.ts:143`–`:149`.
- **اسناد:** `docs/24` Q-83 (پایان عضویت هم محرک است)، `docs/23` D-041 (همان هزینه).

### PR 9 — `contract-service` (`M`)

- همان PR 8 برای `src/organization/organization-directory.ts`، `src/events/organization-moved.consumer.ts` و
  `src/policy/policy-suspension.service.ts`. امضا (`signing-authority.ts:96`–`:113`) از پیش درون تراکنش است و `fence(tx)` می‌گیرد؛
  ارسال صورت‌وضعیت (`statement.service.ts:475`–`:481`) و ساختن/تغییر سیاست (`policy.service.ts:123`، `:237`، `:297`) پرسش
  تعیین‌کننده را به درون تراکنش اثر می‌برند.
- **آزمون‌ها:** `test/organization-directory.int-spec.ts`، `test/organization-moved.int-spec.ts`، `test/approval-policy.int-spec.ts`؛
  مدیر سازمان عضو، امضای قرارداد خودش و ارسال صورت‌وضعیت زیر سیاست اتحادیه: پرسش انجام می‌شود، پایان عضویت ← رد، ناتوانی ← `503`.
- **اسناد:** ADR-068 § ۵ یادداشت.

### PR 10 — پاک‌سازی (`S`)

- شاخهٔ سرویسِ `GET /v1/organizations/:id` (`confirmWithinCaller`) و `@AllowService` آن برداشته می‌شود؛ پرسش سرویس فقط از
  `governance`.
- `isWithinProjectedSubtree` و هر کد اختیار روی `organization_ref` در audit برداشته می‌شود؛ تصمیم دربارهٔ خود Consumer و جدول
  (نگهداری برای نمایش یا حذف با Migration) در همان PR.
- `docs/09` § ۹٫۳ (پانویس ¹ «Platform» برای `UNION_ADMIN` ← «دامنهٔ اتحادیه، ADR-072»)، ADR-060 § ۲، ADR-053 § ۱۰، `docs/04`.

## پرچم و برگشت

- **بی پرچم ویژگی** (ADR-072 § ۸). گسترش با داده روشن و خاموش می‌شود (ثبت/پایان عضویت، فوری و حسابرسی‌شده)؛ باریک‌شدن کلید
  خاموش ندارد، عمداً.
- **برگشت هر PR = Revert همان PR.** برای PR 2 تا 5 یعنی بازگشت دید سراسری اتحادیه — فقط اضطراری، با حکم مدیر پروژه، و با ثبت
  در `docs/23`. Revert PR 1 فقط پس از Revert همهٔ مصرف‌کنندگان؛ تا آن موقع مصرف‌کنندهٔ بی پاسخ `503` می‌گیرد (بسته در خطا).
- **ترتیب استقرار نادرست امن است:** مصرف‌کننده‌ای که پیش از organization-service مستقر شود، `404` مسیر بی بدنه‌ی سرویس، یا
  پیش از افزوده شدن نامش به `GOVERNANCE_CALLERS` ـِ organization-service `403`، می‌گیرد ← `503`؛ هیچ چیز گسترده نمی‌شود. تنها
  ترتیبی که باید رعایت شود: PR 1b (audit) پیش از PR 1، وگرنه رویدادهای عضویت تا استقرار 1b با منبع `Organization/{memberId}`
  ثبت می‌شدند (ADR-072 § ۳).

## بیرون از این برنامه (نام‌دار، ساخته نمی‌شوند)

- پاسخ‌های Q-144 تا Q-147 و تصمیم‌های موقت مدیر پروژه در Q-80 — هرکدام اگر عوض شود، برش کوچک جدای سرویس مالکش است.
- Cache پرسش `governance` (ADR-072 § ۵) — فقط با سنجش بار و بازنگری همان بند.
- صفحه‌های پورتال (`apps/web`) برای ثبت و دیدن عضویت — برش مالک پورتال؛ تا `apps/admin` نیست، ثبت از API است (ADR-058 § ۲).
- اعلان به عضو یا اتحادیه هنگام ثبت/پایان — نگاشت `notification-service`، مانند Q-83 (پ).
