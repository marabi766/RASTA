# ADR-072 — برنامهٔ اجرا (Q-80 (پ)، Q-61)

> برش PR به PR برای [ADR-072](ADR-072-union-membership-and-governed-set.md). **فقط PR 0 (همین، فقط سند) در جریان است**
> (2026-10-23)؛ این سند وضعیت نیست، نقشه است. هر PR یک سرویس است، جداگانه با CI سبز ادغام می‌شود، و آزمون‌هایی را که رفتار
> امروزِ همان سرویس را سنجاق کرده‌اند در **همان** PR عوض می‌کند (ADR-072 § ۷) — نه زودتر، چون پاسخ فقط‌زیردرختی تا PR آن سرویس
> دست نمی‌خورد.

**اندازه:** `S` ≈ تا ۳۰۰ خط تغییر با آزمون؛ `M` ≈ ۳۰۰ تا ۹۰۰؛ `L` ≈ ۹۰۰ تا ۲۰۰۰ (همان مقیاس برنامهٔ ADR-071). امتیاز برآوردی
کنار هر برش است؛ جمع (۳۶) برای هیچ قلم Backlogی نیست — **ساختن قلم و برآورد با مدیر پروژه است**؛ این سند `backlog.json` را تغییر
نمی‌دهد.

## نقشه

| PR  | سرویس / عنوان                                                                                                     | اندازه | امتیاز | وابسته به |
| --- | ----------------------------------------------------------------------------------------------------------------- | ------ | ------ | --------- |
| 0   | طراحی: ADR-072، Q-144 تا Q-147، D-061 (همین)                                                                      | S      | ۱      | —         |
| 1   | `organization-service`: جدول عضویت، API، رویدادها، دید و نوشتن در `G`، پرسش درونی تکی و دسته‌ای، Seed             | L      | ۸      | 0         |
| 2   | `economic-service` — **نخست از چهار** (دادهٔ مالی)                                                                | M      | ۳      | 1         |
| 3   | `document-service`                                                                                                | S      | ۲      | 2         |
| 4   | `supplier-service`                                                                                                | M      | ۳      | 2         |
| 5   | `marketplace-service`                                                                                             | M      | ۳      | 2         |
| 6   | `identity-service` (Q-61)                                                                                         | M      | ۵      | 1         |
| 7   | `audit-service` (ADR-053 § ۱۰)                                                                                    | M      | ۳      | 1         |
| 8   | `construction-service` (Q-70 (۷)، Q-83)                                                                           | M      | ۳      | 1         |
| 9   | `contract-service` (ADR-068 § ۵، Q-83)                                                                            | M      | ۳      | 1         |
| 10  | پاک‌سازی: برداشتن پاسخ فقط‌زیردرختی، Replica حسابرسی از مسیر اختیار، اسناد (`docs/09`، ADR-053 § ۱۰، ADR-060 § ۲) | S      | ۲      | 2 تا 9    |

PR 3، 4 و 5 پس از ادغام PR 2 و موازی؛ PR 6 تا 9 پس از PR 1 و موازی با بقیه. **ترتیب استقرار** همان ترتیب ادغام است، با یک گام
عملیاتی میان PR 1 و PR 2 (پایین).

### گام عملیاتی تولید (نه PR): ثبت عضویت‌های واقعی

PR 2، 3، 4 و 5 دید اتحادیه را **همان لحظهٔ استقرار** به `G` می‌رسانند. اگر در تولید هنوز عضویتی ثبت نشده باشد، `G = subtree`
و اتحادیه دید دهیاری‌ها را در آن چهار سرویس از دست می‌دهد تا ثبت انجام شود. پس پس از استقرار PR 1 و **پیش از** استقرار PR 2:
`SYSTEM_ADMIN` فهرست اعضای هر اتحادیه را — که واقعیت مالک است، نه Seed — با `POST /v1/organizations/{unionId}/members` ثبت
می‌کند و با `GET .../members` وارسی. این گام در جدول «گام‌های یک‌باره پس از استقرار» `docs/deployment/README.md` (اگر تا آن
موقع روی `main` باشد) یا در توضیح PR 1 می‌آید. در محیط توسعه و CI، Seed PR 1 همین را می‌کند.

## برش‌ها

### PR 1 — `organization-service` (`L`)

- **Migration** `union_membership` دقیقاً مانند ADR-072 § ۲: ستون‌ها، سه `CHECK`، Partial Unique Index
  `ux_union_membership_active_member`، دو نمایه، Trigger `trg_union_membership_append_only`؛ `down.sql` و
  `verify-migration-reversible` روی پایگاه دادهٔ ناخالی؛ `check:tenant-index-order` (جدول ستون `organization_id` ندارد؛ اگر
  نگهبان آن را مستأجری بشمارد، دلیل در همان PR نوشته می‌شود). `ID_PREFIXES.unionMembership = 'UMB'` در `packages/contracts`.
- **مخزن:** `withinGovernance(scopeId, id, db)` — یک Statement که `SELF`/`SUBTREE`/`MEMBER` و `hierarchy_version` را از یک
  Snapshot برمی‌گرداند؛ نسخهٔ دسته‌ای با `id = ANY($ids)`؛ ثبت و پایان زیر `lockHierarchy` با `nextHierarchyVersion` و
  به‌روزکردن `hierarchy_version` ردیف عضو.
- **دید و نوشتن** (ADR-072 § ۴): `visibleRoot` جای خود را به «دامنهٔ خواننده» می‌دهد (زیردرخت؛ به‌علاوهٔ اعضا فقط برای
  `UNION_ADMIN`)؛ `list`، `nearby`، `get`، `children`، `subtree`، `ancestors`، `policies`، `update`، `addLocation`، `addContact`،
  `setPolicy` — هرکدام با آزمون عضو / فرزند عضو / عضو اتحادیهٔ دیگر / `ORG-DEH-0003`. `create` زیر عضو رد. `changeStatus` به
  `DEACTIVATED` عضویت‌های زیردرخت را در همان تراکنش پایان می‌دهد.
- **API بیرونی** (ثبت، پایان، فهرست اعضا، عضویت یک سازمان) و **درونی** (`GET /v1/internal/organizations/{id}/governance`،
  `POST /v1/internal/organizations/governance`) با Allow-list **خالی** — هر مصرف‌کننده نام خودش را در PR خودش می‌افزاید.
  OpenAPI و آزمون OpenAPI.
- **رویدادها:** دو نام در `events.ts` با Schema، `PARTITION_SCOPE_OF` (نوع‌سنج نبودشان را نمی‌پذیرد)، ردیف‌ها در
  `docs/events/README.md` (§ Organization) به‌جای یادداشت «برنامه‌ریزی‌شده».
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
- `OrganizationHierarchy` (`src/organization/organization-hierarchy.ts`) ← `governance`؛ پاسخ `{ hierarchyVersion, basis }`؛ بدنهٔ
  بی `basis` شناخته‌شده ← `503`. Allow-list در organization-service.
- `assertTransactionVisible` و `assertWalletVisible` ناهمگام: `UNION_ADMIN` با پرسش `G` روی پرداخت‌کننده سپس دریافت‌کننده؛ بیرون ←
  همان `404`.
- `canActFinanciallyFor` و `reconfirmFinancialAuthority`: `UNION_SUBTREE` ← `UNION_GOVERNED`، `basis` در `recordFinancialCommand`
  و ستون‌های ثبت (اگر ستون `basis`ی هست؛ وگرنه فقط Log، مانند امروز برای پنج فرمان — S-06).
- تراز آزمایشی (`ledger.controller.ts:139`، `:148`) و برگشت سند (`:121`، `journal-reversal.service.ts:77`): `@Roles('SYSTEM_ADMIN')`؛
  `routes.ts:207` (`ledger`) بی‌تغییر.
- **آزمون‌ها:** `src/access/access.spec.ts`، `test/union-admin-financial-authority.int-spec.ts` و هر فایل `test/` که `UNION_ADMIN`
  را با دامنهٔ پلتفرمی فرض کرده؛ E2E: `economic/02-critical-path.e2e-spec.ts:295`، `economic/03-authorization.e2e-spec.ts:84`
  (به‌علاوهٔ مورد `ORG.outside`)، `marketplace/01-order-critical-path.e2e-spec.ts:306`، `:318` (ADR-072 § ۷).
- **اسناد:** `docs/10` (هرجا اتحادیه تراز را می‌خواند)، `docs/09` § ۹٫۳ پانویس ¹ برای economic.

### PR 3 — `document-service` (`S`)

- `hasPlatformScope` فقط `SYSTEM_ADMIN` (`src/access/access.ts:43`، `:63`)؛ `assertDocumentReadable`/`Writable` (`:100`، `:120`)
  ناهمگام با پرسش `G` روی مالک سند برای `UNION_ADMIN`؛ بیرون ← `404`.
- Client تازهٔ organization (همان قرارداد economic)؛ `ORGANIZATION_SERVICE_URL`، `DOCUMENT_ORGANIZATION_REQUEST_TIMEOUT_MS`؛
  `turbo.json`/Compose/CI env (همان نگهبان‌های `test:service-env-turbo`).
- **آزمون‌ها:** Helperهای `test/api-helpers.ts` و یکپارچگی خواندن/حذف سند عضو، `ORG-DEH-0003` و ناتوانی.

### PR 4 — `supplier-service` (`M`)

- `PLATFORM_ROLES` (`src/access/access.ts:75`) و `@Roles(...PLATFORM_ROLES)` در `supplier.controller.ts`: `SYSTEM_ADMIN` و
  `UNION_ADMIN` روی Route می‌مانند (گارد نقش)، ولی تصمیم در `access.ts`: `assertCanDecideAbout` (`:386`)، `assertSupplierReadable`
  (`:291`) — `UNION_ADMIN` فقط با تأمین‌کنندهٔ درون `G`؛ صف (`assertCanReviewQualifications`، `:245`) با پرسش دسته‌ای صافی می‌شود.
- Client تازه، env، Allow-list.
- **آزمون‌ها:** `src/access/access.spec.ts` و یکپارچگی صف (صفحهٔ صافی‌شده، Cursor پایدار)؛ تأیید تأمین‌کنندهٔ بیرون از `G` ←
  `403` (همان پیام امروز «Only a platform operator…»).
- **اسناد:** ADR-052 § ۱۶ یادداشت («خواندن همه» برای `UNION_ADMIN` ← درون دامنه)؛ `docs/24` Q-146 «پیاده با تصمیم موقت».

### PR 5 — `marketplace-service` (`M`)

- `hasPlatformScope` فقط `SYSTEM_ADMIN` (`src/access/access.ts:62`، `:81`)؛ `assertOrderVisible` (`:109`) و `assertReturnVisible`
  (`returns/return-access.ts:32`) ناهمگام: `UNION_ADMIN` با خریدار یا فروشندهٔ درون `G`؛ `assertOfferOwner` (`:160`) و
  `catalogue.service.ts:357` با مالک درون `G`. `assertDisputeResolver` (`:225`): نقش‌سنجی امروز (`hasPlatformScope`) به
  `SYSTEM_ADMIN` یا `UNION_ADMIN` صریح می‌رسد، و پایهٔ اتحادیه `UNION_GOVERNED` با `basis`. `viewerParties` نقش‌محور می‌ماند.
- **آزمون‌ها:** `src/access/access.spec.ts`؛ یکپارچگی: اختلاف سفارش خریدار عضو ← دیدنی و قابل حل؛ خریدار `ORG-DEH-0003` ← `404`
  برای `UNION_ADMIN`، دیدنی برای `SYSTEM_ADMIN`.
- **اسناد:** یادداشت ADR-060 § ۲ («دست نمی‌خورد» برای marketplace جایگزین شد).

### PR 6 — `identity-service` (`M`)

- Client تازه (نخستین تماس identity با organization؛ `ORGANIZATION_SERVICE_URL`، `IDENTITY_ORGANIZATION_REQUEST_TIMEOUT_MS`،
  `InternalTokenService` از `nest-common`) و Allow-list.
- `isWithinProvisioningScope`/`assertMayProvisionInto` ناهمگام (`provisioning-scope.ts:96`، `:122`)؛ چهار فراخوان
  (`identity.service.ts:249`، `:422`، `:760`، `:1017`) با قاعدهٔ پاسخ ADR-072 § ۶ (`503` برای دو مسیر بدنه‌محور، `404` یکسان برای
  دو مسیر ثبت‌نام).
- Boot: `USER_PROVISIONING_CROSS_ORG_ROLES` جز `SYSTEM_ADMIN` ← خطای پیکربندی.
- **آزمون‌ها:** `provisioning-scope.spec.ts`، یکپارچگی چهار مسیر با عضو، فرزند عضو، `ORG-DEH-0003`، ناموجود و ناتوانی؛ آزمون
  Oracle (`approve` روی ثبت‌نام بیرون از `G`، ناموجود و هنگام ناتوانی ← بدنهٔ یکسان).
- **اسناد:** `docs/24` Q-61 «پیاده»، `docs/09` (identity).

### PR 7 — `audit-service` (`M`)

- `resolveSubtreeTarget` (`src/audit/audit.scope.ts:40`) پرسش همزمان `G` را جای `isWithinProjectedSubtree` می‌گذارد؛ متریک
  `SUBTREE_DECISIONS` به `DESCENDANT` / `MEMBER` / `REFUSED` / `UNAVAILABLE`. Consumer `organization_ref` می‌ماند (برداشتنش در
  PR 10).
- Client تازه، env، Allow-list.
- **آزمون‌ها:** `audit.scope.spec.ts`، `test/kafka-projector.int-spec.ts` (Replica دیگر اختیار نمی‌دهد)؛ E2E
  `audit/01-query-authorization.e2e-spec.ts:165`–`:196` (ADR-072 § ۷).
- **اسناد:** ADR-053 § ۱۰ جدول نقش‌ها و پاراگراف Replica.

### PR 8 — `construction-service` (`M`)

- `src/organization/organization-directory.ts` ← `governance`؛ `basis` و نسخه جایی ثبت می‌شوند که نسخه امروز ثبت می‌شود.
- Consumer موجود (`src/events/organization-moved.consumer.ts`) `ORGANIZATION_UNION_MEMBERSHIP_ENDED` را هم می‌خواند — فقط
  `memberOrganizationId`، به‌عنوان محرک همان بازپرسی `policy-suspension.service.ts`؛ متریک‌ها برچسب رویداد می‌گیرند.
- **آزمون‌ها:** `test/organization-directory.int-spec.ts`، `test/policy-governance.int-spec.ts`؛ پایان عضویت ← تعلیق؛ ثبت دوباره ←
  بی بازفعال‌سازی؛ تحویل دوباره و `.retry` بی‌اثر؛ E2E `construction/02-approval-lifecycle.e2e-spec.ts:143`–`:149`.
- **اسناد:** `docs/24` Q-83 (پایان عضویت هم محرک است)، `docs/23` D-041 (همان هزینه).

### PR 9 — `contract-service` (`M`)

- همان PR 8 برای `src/organization/organization-directory.ts`، `src/events/organization-moved.consumer.ts` و
  `src/policy/policy-suspension.service.ts`.
- **آزمون‌ها:** `test/organization-directory.int-spec.ts`، `test/organization-moved.int-spec.ts`، `test/approval-policy.int-spec.ts`.
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
- **ترتیب استقرار نادرست امن است:** مصرف‌کننده‌ای که پیش از organization-service مستقر شود، `404` مسیر بی بدنهٔ سرویس می‌گیرد ←
  `503`؛ هیچ چیز گسترده نمی‌شود.

## بیرون از این برنامه (نام‌دار، ساخته نمی‌شوند)

- پاسخ‌های Q-144 تا Q-147 و تصمیم‌های موقت مدیر پروژه در Q-80 — هرکدام اگر عوض شود، برش کوچک جدای سرویس مالکش است.
- Cache پرسش `governance` (ADR-072 § ۵) — فقط با سنجش بار و بازنگری همان بند.
- صفحه‌های پورتال (`apps/web`) برای ثبت و دیدن عضویت — برش مالک پورتال؛ تا `apps/admin` نیست، ثبت از API است (ADR-058 § ۲).
- اعلان به عضو یا اتحادیه هنگام ثبت/پایان — نگاشت `notification-service`، مانند Q-83 (پ).
