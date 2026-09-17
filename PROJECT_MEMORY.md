# RASTA — Project Memory

> **این فایل حافظه مهندسی رستا است.** نوشته‌شده تا یک Developer یا AI Agent جدید،
> بدون تکیه بر Context مکالمه قبلی، بفهمد رستا الان دقیقاً کجاست.
>
> **قاعده این فایل:** واقعیت کد/Git/Runtime بر ادعای سند اولویت دارد. هرجا وضعیتی
> Verify نشده، همین‌طور علامت خورده — نه «کامل».
>
> **آخرین Audit کامل:** 2026-08-27 — با اجرای واقعی `pnpm verify`، بالا آوردن ۴
> سرویس از حالت تمیز، تست زنده Auth/Tenant Isolation/Event Flow، و بررسی مستقیم
> GitHub Actions.
>
> **آخرین به‌روزرسانی:** 2026-09-07 — **بستهٔ تصمیم اعلان و حسابرسی: ADR-053 و ADR-054 نوشته شدند، هر دو `Proposed`.**
>
> شاخهٔ `docs/notification-audit-adrs` از `main` (`93b1873`). **هیچ کدی نوشته نشد؛ Diff فقط سند است.**
> بازرسی مستقیم مخزن سه واقعیت را تثبیت کرد که برنامه‌ریزی بعدی باید بر آن‌ها بنشیند:
>
> ۱. **هیچ رکورد حسابرسی قابل Queryای در پلتفرم تولید نمی‌شود.** `AUDIT_TRAIL_TOPIC` در کل مخزن دقیقاً دو رخداد دارد
> (تعریف در `envelope.ts:166` و صادرشدن در `index.ts:65`). **به‌روزرسانی 2026-09-08:** `services/audit-service/prisma/schema.prisma`
> اکنون `audit_event` را دارد و AUD-001 آن را پر می‌کند؛ جملهٔ زیر وضعیت پیش از آن را توصیف می‌کند. `services/audit-service/`
> وجود ندارد. یعنی **`AGENTS.md` S-06 امروز توسط هر نُه سرویس Merge‌شده نقض می‌شود.** ADR-053 مسیر بستنش را تعیین می‌کند.
> **به‌روزرسانی 2026-09-10:** `services/audit-service/` وجود دارد و AUD-001، AUD-002 و نیمهٔ شواهد دست‌نخوردگی AUD-003
> (زنجیرهٔ Hash، `audit_chain_head`، `GET /v1/audit-events/verify`) در آن پیاده‌اند. جملهٔ «وجود ندارد» بالا وضعیت 2026-08-27
> را توصیف می‌کند و عمداً دست‌نخورده مانده. S-06 هنوز **کاملاً** برآورده نیست: نه رکورد جبرانی هست، نه مسیر B (AUD-004).
> **به‌روزرسانی 2026-09-11:** از AUD-004 فقط **Phase A** پیاده شد —
> `packages/contracts/src/events/audit-trail.ts` رویداد `AUDIT_EVENT_RECORDED` (نسخهٔ ۱) را با Zod Schema فقط‌Contract
> (A-03) تعریف می‌کند، دیگر «دقیقاً دو رخداد در کل مخزن» بالا وضعیت پیش از این تاریخ را توصیف می‌کند. **بدون هیچ رفتار
> زمان اجرا**: نه Producer، نه Consumer، نه `security_event_outbox`، نه Endpoint فرمان اصلاح. مالکیت هر دو Producer
> آینده (مرجع ردها § ۴، نیتِ اصلاح § ۷) به `identity-service` تصمیم گرفته شد — شواهد در
> [ADR-053 implementation plan](docs/adr/ADR-053-implementation-plan.md) § ۵. `COM-009` همچنان `READY` با ۱۳ امتیاز
> است و امتیازی داده نشد.
> **به‌روزرسانی 2026-09-11 (Phase B):** `audit-service` اکنون **Consumer مسیر B** دارد — `AuditTrailConsumer` با گروه
> ثابت `audit-service.trail` روی `rasta.audit.trail.v1`؛ Envelope، نام/نسخه، Payload و توافق مستأجر پیش از نوشتن بررسی
> می‌شوند، پیام ردشده نه ردیف می‌سازد نه نشانگر، و Idempotency روی `(eventId, audit-service.trail)` در همان تراکنشِ ردیف و
> زنجیره است. جملهٔ «نه Consumer» بالا وضعیت پیش از این به‌روزرسانی است. هنوز **هیچ Producer، `security_event_outbox`،
> تجمیع ردها یا فرمان اصلاح** وجود ندارد، پس در عمل هیچ ردیف مسیر B تولید نمی‌شود و S-06 همچنان کامل نیست. `COM-009`
> همچنان `READY` با ۱۳ امتیاز است.
> **به‌روزرسانی 2026-09-11 (Phase C1):** نخستین Producer مسیر B — `identity-service` — برای **یک** رد: `POST
/v1/users/me/active-organization` با `403 TENANT_MISMATCH` از `switchActiveOrganization()`. جدول محلی و جدای
> `security_event_outbox` (Migration قابل بازگشت `20260911120000_security_event_outbox`)، `RefusalAuditExceptionFilter`
> که پاسخ پلتفرم را بدون تغییر برمی‌گرداند و ثبت را best-effort با Timeout کراندار انجام می‌دهد، و Relay دوم ADR-050 که
> پس از اعتبارسنجی Contract روی `rasta.audit.trail.v1` منتشر می‌کند. سرتاسری روی PostgreSQL و Kafka واقعی تا
> `audit_event` آزموده شد. جملهٔ «هنوز هیچ Producer» بالا وضعیت پیش از این به‌روزرسانی است. **هنوز نیست:** تجمیع
> پنجره‌ای، `403`های دیگر، رول‌اوت به سرویس‌های دیگر، فرمان اصلاح، صادرات — پس S-06 همچنان کامل نیست. `COM-009` همچنان
> `READY` با ۱۳ امتیاز و ADR-053 `Proposed` است.
> **به‌روزرسانی 2026-09-11 (Phase C1 سخت‌سازی معماری):** نسخهٔ نخستِ آزمون Kafka این فاز
> (`identity-service/test/refusal-audit-flow.int-spec.ts`) شش مسیر از `services/audit-service/src/**` و `test/**` را
> مستقیم Import می‌کرد تا `AuditTrailConsumer` را در همان فایل identity برپا کند — نقض صریح `AGENTS.md` A-02، که
> استثنایی برای فایل آزمون قائل نیست. آن فایل حذف شد و با `identity-service/test/security-event-kafka.int-spec.ts`
> جایگزین شد که مسیر را با `EventConsumer` عمومی `@rasta/nest-common` و Schema عمومی `@rasta/contracts` — نه کد
> `audit-service` — به‌عنوان ناظر بیرونی می‌بیند؛ ادعای مصرف‌کننده (پایداری، تحویل دوباره، توافق مستأجر) جای خودش را در
> `audit-service/test/trail-ingestion.int-spec.ts` دست‌نخورده دارد. اثبات سرتاسری اکنون فقط
> `tests/e2e/specs/identity/01-refusal-audit-trail.e2e-spec.ts` است — Black-Box واقعی روی دو فرایند جدا، از راه
> Gateway، بدون هیچ Importی میان‌سرویسی — و `scripts/check-service-boundaries.mjs` (تازه، در `pnpm verify` و CI) از
> تکرار این نقض در هر سرویس دیگری جلوگیری می‌کند. هیچ رفتار Production تغییر نکرد؛ فقط توپولوژی آزمون اصلاح شد.
> **به‌روزرسانی 2026-09-11 (Phase C2 — تجمیع پنجره‌ای ردها):** برای همان یک محل رد، ردهای یکسان (مستأجر، Actor، فعل،
> Resource، کد خطا) در یک پنجرهٔ UTC هم‌تراز با Epoch (`SECURITY_EVENT_AGGREGATION_WINDOW_SECONDS`، پیش‌فرض ۶۰، ۱..۳۶۰۰)
> **یک** ردیف `security_event_outbox` با `occurrence_count` می‌شوند و فقط پس از بسته‌شدن پنجره با ساعت پایگاه داده منتشر
> می‌شوند. ثبت یک `INSERT … ON CONFLICT` روی Index یکتای جزئی ردیف‌های هرگز Claim‌نشده است؛ Claim ردیف را از آن Index
> بیرون می‌برد، پس ردی که با Claim مسابقه دهد جانشین تازه می‌سازد و Trigger `tg_security_event_outbox_guard` تغییر ردیف
> Claim‌شده را رد می‌کند (Migration افزایشی `20260911130000_security_event_outbox_aggregation`). شمارش در Envelope از ستون
> خوانده می‌شود؛ Contract v1 و `audit-service` دست نخوردند. ip/User-Agent/نقش‌ها عمداً در شناسه نیستند — **Q-44**.
> `turbo.json` اکنون `KAFKA_BROKERS` را به وظیفهٔ `test` می‌دهد، پس `pnpm test`/`pnpm verify` آزمون‌های Kafka identity را
> دیگر بی‌صدا Skip نمی‌کنند. **یافتهٔ عملیاتی:** همهٔ ردهای یک کاوش روی یک ردیف قفل می‌گیرند و گذردهی آن ردیف با تأخیر Commit
> محدود است — روی Volume توسعهٔ Docker Desktop با pgbench حدود ۲۳ تا ۲۹ ثبت در ثانیه (۱۱۴۲ با `synchronous_commit=off`)؛ ثبت
> فراتر از Timeout `timeout` شمرده می‌شود و `403` همان است. **هنوز نیست:** `403`های دیگر، رول‌اوت به سرویس‌های دیگر، فرمان
> اصلاح، صادرات، Purge. `COM-009` همچنان `READY` با ۱۳ امتیاز و ADR-053 `Proposed` است.
>
> **به‌روزرسانی 2026-09-12 (Phase C3 — محل رد دوم):** `identity-service` اکنون **دقیقاً دو** محل رد دارد. محل تازه:
> `GET /v1/users` که `RolesGuard` پلتفرم با `403 INSUFFICIENT_ROLE` رد می‌کند (`action = identity.users.list`،
> `resourceType = User`، `resourceId` = شناسهٔ خودِ فراخوان — تصمیم موقت **Q-45**). Guard محلی `IdentityRolesGuard` جای
> `RolesGuard` سراسری را گرفت، همهٔ تصمیم‌ها را به همان Guard مشترک می‌سپارد و فقط `INSUFFICIENT_ROLE`ِ همان Route
> دقیق را روی همان شیء خطا علامت می‌زند؛ `packages/nest-common` تغییری نکرد. همان تجمیع، Relay و Contract؛ بدون Migration.
> **هنوز نیست:** شش Route دیگرِ `INSUFFICIENT_ROLE` در identity، `TENANT_MISMATCH`/`SERVICE_TENANT_CONTEXT_INVALID`/`FORBIDDEN`
> خودِ AuthGuard، رول‌اوت به سرویس‌های دیگر، فرمان اصلاح، صادرات، Purge، هشدار Prometheus. `COM-009` همچنان `READY` با ۱۳
> امتیاز و ADR-053 `Proposed` است.
>
> **به‌روزرسانی 2026-09-12 (Phase C4 — محل رد سوم):** `identity-service` اکنون **دقیقاً سه** محل رد دارد. محل تازه:
> `POST /v1/users` که `RolesGuard` پلتفرم با `403 INSUFFICIENT_ROLE` رد می‌کند (`action = identity.users.create`،
> `resourceType = User`، `resourceId` = شناسهٔ خودِ فراخوان، چون ردِ ساختن کاربر ساخته‌شده‌ای ندارد — تصمیم موقت **Q-46**).
> فقط یک ورودی ثابت تازه (`CREATE_USER`)؛ `IdentityRolesGuard`، `rolesGuardSiteFor`، تجمیع، Relay، Contract و
> `audit-service` بی‌تغییرند؛ بدون Migration. هیچ میدانی از بدنه، نقش لازم Endpoint، Context خطا، Token، Cookie یا متن خطا
> ثبت نمی‌شود. **هنوز نیست:** پنج Route دیگرِ `INSUFFICIENT_ROLE` در identity (`POST /v1/users/:id/memberships`،
> `POST /v1/memberships/:id/roles` و `/revoke`، `POST /v1/registration-requests/:id/approve` و `/reject`)،
> `TENANT_MISMATCH`/`SERVICE_TENANT_CONTEXT_INVALID`/`FORBIDDEN` خودِ AuthGuard، رول‌اوت به سرویس‌های دیگر، فرمان اصلاح،
> صادرات، Purge، هشدار Prometheus. `COM-009` همچنان `READY` با ۱۳ امتیاز و ADR-053 `Proposed` است.
>
> **به‌روزرسانی 2026-09-12 (Phase C5 — محل رد چهارم):** `identity-service` اکنون **دقیقاً چهار** محل رد دارد. محل تازه:
> `POST /v1/users/:id/memberships` که `RolesGuard` پلتفرم با `403 INSUFFICIENT_ROLE` رد می‌کند
> (`action = identity.memberships.create`، `resourceType = Membership`، `resourceId` = شناسهٔ خودِ فراخوان، **نه** کاربر هدفِ
> مسیر — تصمیم موقت **Q-47**؛ مخزن معنای رسمی ندارد). فقط یک ورودی ثابت تازه (`ADD_MEMBERSHIP`)؛ `IdentityRolesGuard`،
> `rolesGuardSiteFor`، تجمیع، Relay، Contract و `audit-service` بی‌تغییرند؛ بدون Migration. شناسهٔ مسیر، بدنه، نقش‌ها، Context
> خطا، URL، Token، Cookie و متن خطا ثبت نمی‌شوند، پس کاوش با هدف‌های متفاوت یک ردیف به‌ازای Actor است. **هنوز نیست:** چهار
> Route دیگرِ `INSUFFICIENT_ROLE` در identity (`POST /v1/memberships/:id/roles` و `/revoke`،
> `POST /v1/registration-requests/:id/approve` و `/reject`)، `TENANT_MISMATCH`/`SERVICE_TENANT_CONTEXT_INVALID`/`FORBIDDEN`
> خودِ AuthGuard، رول‌اوت به سرویس‌های دیگر، فرمان اصلاح، صادرات، Purge، هشدار Prometheus. `COM-009` همچنان `READY` با ۱۳
> امتیاز و ADR-053 `Proposed` است.
>
> **به‌روزرسانی 2026-09-12 (Phase C6 — محل رد پنجم):** `identity-service` اکنون **دقیقاً پنج** محل رد دارد. محل تازه:
> `POST /v1/memberships/:id/roles` که `RolesGuard` پلتفرم با `403 INSUFFICIENT_ROLE` رد می‌کند
> (`action = identity.memberships.roles.replace`، `resourceType = Membership`، `resourceId` = شناسهٔ خودِ فراخوان، **نه**
> عضویتِ مسیر — تصمیم موقت **Q-48**؛ مخزن معنای رسمی ندارد). فقط یک ورودی ثابت تازه (`UPDATE_MEMBERSHIP_ROLES`)؛
> `IdentityRolesGuard`، `rolesGuardSiteFor`، `RolesGuard` مشترک، تجمیع، Relay، Contract و `audit-service` بی‌تغییرند؛ بدون
> Migration. شناسهٔ مسیر، بدنه (نقش‌ها و دلیل)، نقش‌های لازم، Context خطا، URL، Token، Cookie و متن خطا ثبت نمی‌شوند.
> مقایسه‌گرِ «پاسخ بی‌تغییر» در آزمون‌ها اکنون `POST /v1/memberships/:id/revoke` است. **هنوز نیست:** سه Route دیگرِ
> `INSUFFICIENT_ROLE` در identity (`POST /v1/memberships/:id/revoke`، `POST /v1/registration-requests/:id/approve` و
> `/reject`)، `TENANT_MISMATCH`/`SERVICE_TENANT_CONTEXT_INVALID`/`FORBIDDEN` خودِ AuthGuard، رول‌اوت به سرویس‌های دیگر، فرمان
> اصلاح، صادرات، Purge، هشدار Prometheus. `COM-009` همچنان `READY` با ۱۳ امتیاز و ADR-053 `Proposed` است.
>
> **به‌روزرسانی 2026-09-12 (Phase C7 — محل رد ششم):** `identity-service` اکنون **دقیقاً شش** محل رد دارد. محل تازه:
> `POST /v1/memberships/:id/revoke` که `RolesGuard` پلتفرم با `403 INSUFFICIENT_ROLE` رد می‌کند
> (`action = identity.memberships.revoke`، `resourceType = Membership`، `resourceId` = شناسهٔ خودِ فراخوان، **نه** عضویتِ مسیر —
> تصمیم موقت **Q-49**؛ رویداد موفقِ `MEMBERSHIP_REVOKED` فعلِ یک فرمانِ ردشده را تعریف نمی‌کند). فقط یک ورودی ثابت تازه
> (`REVOKE_MEMBERSHIP`)؛ `IdentityRolesGuard`، `rolesGuardSiteFor`، `RolesGuard` مشترک، تجمیع، Relay، Contract و
> `audit-service` بی‌تغییرند؛ بدون Migration. شناسهٔ مسیر، بدنه (دلیل)، نقش‌های لازم، Context خطا، URL، Token، Cookie و متن خطا
> ثبت نمی‌شوند. مقایسه‌گرِ «پاسخ بی‌تغییر» در آزمون‌ها اکنون `POST /v1/registration-requests/:id/approve` است. **هنوز نیست:** دو
> Route دیگرِ `INSUFFICIENT_ROLE` در identity (`POST /v1/registration-requests/:id/approve` و `/reject`)،
> `TENANT_MISMATCH`/`SERVICE_TENANT_CONTEXT_INVALID`/`FORBIDDEN` خودِ AuthGuard، رول‌اوت به سرویس‌های دیگر، فرمان اصلاح،
> صادرات، Purge، هشدار Prometheus. `COM-009` همچنان `READY` با ۱۳ امتیاز و ADR-053 `Proposed` است.
>
> **به‌روزرسانی 2026-09-12 (Phase C8 — محل رد هفتم):** `identity-service` اکنون **دقیقاً هفت** محل رد دارد. محل تازه:
> `POST /v1/registration-requests/:id/approve` که `RolesGuard` پلتفرم با `403 INSUFFICIENT_ROLE` رد می‌کند
> (`@Roles('UNION_ADMIN')` به‌تنهایی، پس `ORGANIZATION_ADMIN` هم رد و ثبت می‌شود؛
> `action = identity.registration_requests.approve`، `resourceType = RegistrationRequest`، `resourceId` = شناسهٔ خودِ فراخوان،
> **نه** درخواستِ مسیر — تصمیم موقت **Q-50**؛ فرمان `ApproveRegistration` و رویداد موفقِ `REGISTRATION_APPROVED` فعلِ یک فرمانِ
> ردشده را تعریف نمی‌کنند). فقط یک ورودی ثابت تازه (`APPROVE_REGISTRATION_REQUEST`)؛ `IdentityRolesGuard`، `rolesGuardSiteFor`،
> `RolesGuard` مشترک، تجمیع، Relay، Contract و `audit-service` بی‌تغییرند؛ بدون Migration. شناسهٔ مسیر، بدنه، نقش لازم، Context
> خطا، URL، Token، Cookie و متن خطا ثبت نمی‌شوند. مقایسه‌گر و تنها کاوشِ منفی اکنون `POST /v1/registration-requests/:id/reject`
> است. نکتهٔ آزمون: Gateway پیشوند `registration-requests` را برای هر کاربر به ۵ فراخوان در ساعت محدود می‌کند؛ سناریوی
> Black-Box دقیقاً یک بودجه را خرج می‌کند و مقایسهٔ `/reject` را با Actor دوم انجام می‌دهد. **هنوز نیست:** Route باقی‌ماندهٔ
> `INSUFFICIENT_ROLE` در identity (`POST /v1/registration-requests/:id/reject`)،
> `TENANT_MISMATCH`/`SERVICE_TENANT_CONTEXT_INVALID`/`FORBIDDEN` خودِ AuthGuard، رول‌اوت به سرویس‌های دیگر، فرمان اصلاح،
> صادرات، Purge، هشدار Prometheus. `COM-009` همچنان `READY` با ۱۳ امتیاز و ADR-053 `Proposed` است.
>
> **به‌روزرسانی 2026-09-12 (نیمهٔ اصلاحِ AUD-003 — فرمان `audit.correction`، سرتاسر):** اصلاح رکورد حسابرسی پیاده شد و
> AUD-003 کامل است. `POST /v1/audit-corrections` در `identity-service` (فقط `SYSTEM_ADMIN` در Gateway، در Controller و در
> خودِ سرویس؛ `Idempotency-Key` الزامی؛ شکل HTTP تصمیم موقت **Q-53**) هدف را از راه Endpoint داخلی و باریک
> `GET /v1/internal/audit-events/{id}` در `audit-service` (فقط Token سرویسِ identity؛ سه میدان؛ بی‌هیچ شاهد؛ `occurredAt`
> الزامی و تطابق دقیق) اثبات می‌کند، سپس **یک** `AUDIT_EVENT_RECORDED` v1 در `outbox_message` **استاندارد** خودش می‌نویسد —
> در همان تراکنشِ ردیف `audit_correction_command` — و Relay استاندارد آن را با کلید Partition = شناسهٔ هدف منتشر می‌کند.
> `audit-service` آن را رکورد **تازهٔ** زنجیرشده با `correctionOf` می‌نویسد؛ اصل و Hashاش بایت‌به‌بایت دست‌نخورده می‌مانند و
> `verify` همچنان معتبر است. خواندن اکنون `correctionOf` و `correctedBy[]` را با همان دامنهٔ مستأجرِ خودِ رکورد منتشر می‌کند.
> مستأجرِ اصلاح فقط از پاسخ Lookup کپی می‌شود، هرگز از درخواست؛ برای هدف پلتفرمی هیچ مستأجری نوشته نمی‌شود (تغییر عمومی و
> کوچک `buildOutboxRow`: `organizationId: null` یعنی «بی‌مستأجر»). دو Migration افزایشی و قابل بازگشت:
> `audit_correction_command` در identity و `audit_event_correction_idx` در audit. **هنوز نیست:** صادرات، Purge، امضا، هشدار،
> رول‌اوت به سرویس‌های دیگر (R-2) و ردهای متوقف‌شده در Gateway. `COM-009` همچنان `READY` با ۱۳ امتیاز و ADR-053 `Proposed`
> است. **Invariant هم‌زمانی (2026-09-14):** تصمیم «بنویس یا Replay کن» زیر Advisory Lock تراکنشیِ `(actorId, key)` و با بازخوانی
> درون همان تراکنش، **پیش از** تخصیص Sequence جریان Outbox گرفته می‌شود؛ `P2002` فقط خط دفاع آخر است (جزئیات و شواهد در
> به‌روزرسانی 2026-09-14 «تشخیص آن ناپایداری»).
>
> **به‌روزرسانی 2026-09-12 (برگشت‌پذیری آن دو Migration — تصحیح ادعای بالا):** جملهٔ «دو Migration افزایشی و **قابل
> بازگشت**» در به‌روزرسانی پیشین، `down.sql` نوشته‌شده را با Rollback اثبات‌شده یکی گرفته بود. هیچ‌کدام از آن دو در هیچ
> Harnessی ثبت نبود، پس هیچ‌گاه اجرا نشده بود، و هر دو `down.sql` ردیف `_prisma_migrations` خود را هم جا می‌گذاشتند — یعنی
> Rollbackی که دیگر هرگز رو به جلو اعمال نمی‌شد. اکنون: Verifier مستقل تازه
> `scripts/verify-audit-correction-command-migration.mjs` برای جدول identity (Schema یک‌بارمصرف، امضای دقیق هر هفت ستون،
> کلید مرکب با `pg_get_constraintdef`، Ledgerِ خودش و Ledgerِ هر Migration دیگر، ده جدول و پنج شیء پیش‌موجود که باید سرپا
> بمانند، و آزمودن یکتایی/`NOT NULL`/طول/Default/JSONB)، `audit_event_correction_idx` افزوده به نگاشت `EXPECTED`ِ
> `verify-migration-reversible.mjs` (Migrationی که فقط یک Index می‌سازد و نامش آنجا نباشد به‌کلی نامرئی است)، هر دو
> `down.sql` اکنون ردیف Ledger خودشان — و فقط خودشان — را پاک می‌کنند، و ثبت در `test:migration` و `verify` ریشه.
> **تکمیل همان روز (اجرای واقعی هر دو Rollback):** Docker Desktop همچنان بالا نمی‌آید، پس هر دو اثبات روی یک Cluster
> یک‌بارمصرفِ **PostgreSQL 16.14 بومی** (`initdb` با UTF-8 و `trust` در پوشهٔ Temp، فقط `127.0.0.1:5399` — پورت 5433 در
> بازهٔ Excluded Port ویندوز بود — بی‌دست‌زدن به سرویس 5432) اجرا شد، با نقش‌ها/پایگاه‌ها/Schemaِ `audit` مطابق
> `00-init-databases.sh` و `DATABASE_URL` عمداً Unset. نخستین اجرا یک نقص واقعی در **خودِ Verifier** نشان داد: Probeهای رد،
> متنِ خروجی `prisma db execute` را می‌جستند، و Prisma 6.19.3 خطای PostgreSQL را چاپ نمی‌کند (برای `NOT NULL` فقط
> `Failing row contains`، و برای طولِ زیاد جملهٔ یکسان `P2000 … Column: (not available)` برای `CHAR(64)` و `VARCHAR(26)`).
> Commit `5808941` هر Probe را در بلوکی می‌پیچد که با `GET STACKED DIAGNOSTICS`، SQLSTATE/جدول/ستون/Constraint/پیام خودِ
> PostgreSQL را برمی‌گرداند (با ۵ تست واحد تازه؛ مجموع دو مجموعهٔ Verifier اکنون ۳۷ تست، ۳۷ سبز). سپس:
> `DATABASE_URL_IDENTITY=… node scripts/verify-audit-correction-command-migration.mjs` — **سبز**، up → down → up در
> 39250ms، با خروجی `re-applied 20260912120000_audit_correction_command`؛ و
> `DATABASE_URL_AUDIT=…/rasta_audit?schema=audit node scripts/verify-migration-reversible.mjs audit` (همان شکل CI، نه
> `_MIGRATOR`) — **سبز**، کل زنجیرهٔ چهار Migration در 20406ms، با `audit_event_correction_idx` در اثبات بودن/نبودن/بازگشت.
> پرس‌وجوی صریح پس از هر اجرا: Schemaهای `audit_correction_command_check` و `migration_check` باقی نماندند. **آنچه همچنان
> اجرا نشده:** `pnpm test:migration` کامل ریشه (پایگاه و نقشِ هر نُه سرویس را می‌خواهد و در این نشست تلاش نشد) و `pnpm verify` کامل روی این ماشین.
>
> **به‌روزرسانی 2026-09-12 (هم‌خوانی مستندات جاری AUD-003/AUD-004 و Runbook شکاف شواهد):** توصیف‌های جاری که هنوز «بدون
> Producer» و «بدون فرمان اصلاح» می‌گفتند اصلاح شدند — `description` در `services/audit-service/package.json`، خط شروع
> `main.ts`، سرآیند `app.module.ts`، `audit.controller.ts`، توضیح Readiness، توضیح OpenAPI و یک توضیح `kafka-projector.int-spec.ts`
> — بی هیچ تغییر رفتاری؛ سطرهای AUD-003 (اکنون ✅) و AUD-004 جدول وضعیت ADR-053 plan با § ۴/۵ هم‌خوان شدند و نگاشت نام فایل‌های
> پذیرش برنامه (`refusal-flow.int-spec.ts`، `changes-redaction.spec.ts`) به آزمون‌های واقعی در § ۷ آن سند آمد.
> [`docs/runbooks/audit-gap-detected.md`](docs/runbooks/audit-gap-detected.md) تازه است و فقط بر قابلیت‌های موجود تکیه دارد.
> **دو شکاف رصدپذیری هنگام نوشتنش پیدا شد و ثبت شد، نه رفع:** `audit-service` متریک‌های ورودی و زنجیره را در فرایند ثبت
> می‌کند ولی **هیچ Route `/metrics` ندارد** و هدف Scrape Prometheus محلی نیست؛ و `rasta_dlq_messages_total` تعریف شده ولی
> `EventConsumer` مشترک آن را افزایش نمی‌دهد. `COM-009` همچنان `READY`/۱۳ و ADR-053 `Proposed`.
>
> **به‌روزرسانی 2026-09-12 (Route `/metrics` در `audit-service` و هدف Scrape محلی — شکاف رصدپذیری اول بسته شد):**
> `MetricsController` تازه (`src/observability/metrics.controller.ts`) — `GET /metrics` بی‌نسخه با `metricsText()` و
> `metricsContentType` از `@rasta/observability`، `@Public` با دلیل صریح، `@ApiExcludeController()` — به‌صراحت در
> `AppModule` ثبت شد؛ Guardهای سراسری دست نخوردند و قرارداد OpenAPI همچنان دقیقاً چهار مسیر خواندنی است. Exposition همان
> متریک‌های ورودی، پرس‌وجو، ظرفیت و زنجیره است که از پیش ثبت می‌شدند و هیچ Label شناسه‌ای ندارند (ADR-053 § 13).
> `host.docker.internal:3115` به Job `rasta-services` در `infrastructure/docker/prometheus/prometheus.yml` افزوده شد (2026-09-13
> به Job اختصاصی `audit-service` منتقل شد — ورودی رصدپذیری پایین) — این فقط
> پیکربندی **محلی** است؛ Scrape محیط واقعی وابسته به استقرار و بیرون از مخزن است. آزمون‌ها: Supertest واحد پشت
> `AuthGuard`/`RolesGuard` واقعی (بی Token → `200`، Content-Type متنی Prometheus، `# HELP/# TYPE rasta_audit_*`، Route بستهٔ
> کناری → `401`)، فهرست دقیق Controllerها به‌علاوهٔ اثبات ساختاری «فقط GET، بی Route صادرات»، و در `openapi.int-spec.ts`
> درخواست واقعی `/metrics` روی `AppModule` واقعی و اثبات نبودن آن در Document. Integration روی Cluster یک‌بارمصرف
> PostgreSQL 16 بومی (`127.0.0.1:5399`) اجرا شد چون Container `rasta-postgres` پورت میزبان ندارد. `promtool check config`
> (Image `prom/prometheus:v3.1.0`) سبز؛ Scrape زندهٔ یک فرایند در حال اجرا انجام **نشد**. **هنوز نیست:** هیچ قاعدهٔ هشدار
> Prometheus یا داشبورد؛ و `rasta_dlq_messages_total` هنوز در `EventConsumer` مشترک **افزایش نمی‌یابد** (گام بعدی جدا).
> `COM-009` همچنان `READY`/۱۳ و ADR-053 `Proposed`.
>
> **به‌روزرسانی 2026-09-13 (`rasta_dlq_messages_total` اکنون شمرده می‌شود):** `EventConsumer` مشترک
> (`packages/nest-common/src/consumer/event-consumer.ts`) همان Counter موجود `dlqMessagesTotal` از `@rasta/observability` را
> — بی Registry یا Counter دوم — در `deadLetter()` و **فقط پس از resolve شدن `producer.send`** یک واحد افزایش می‌دهد، با
> Labelهای دقیق `{ service: clientId, topic: <Topic مبدأ>, reason: DlqReason }`. `send` ردشده (خطا همچنان بیرون پرتاب
> می‌شود و Partition می‌ایستد)، تلاش‌های مجدد و پیامِ Drop‌شده بی `deadLetterTopic` شمرده نمی‌شوند؛ بایت‌ها، Headerها،
> Idempotence، Retry و Offset بی‌تغییرند. `@rasta/nest-common` اکنون `@rasta/observability: workspace:*` را مستقیم دارد
> (بی چرخه؛ فقط Importer خودش در `pnpm-lock.yaml`). شش آزمون واحد بی Broker در `event-consumer.spec.ts` (Malformed →
> `VALIDATION_FAILED`، Retry تمام‌شده → `MAX_RETRIES_EXCEEDED`، `send` ردشده → صفر و همان خطا، بی DLQ → صفر، دو انتشار با
> شش تلاش → دو، و نبودن شناسه/متن خطا/Partition در Label)؛ nest-common اکنون ۸ مجموعه / ۱۴۰ آزمون. **هنوز نیست:** هیچ
> قاعدهٔ هشدار Prometheus یا داشبورد، Script بازپخش DLQ و Scrape محیط واقعی. `COM-009` همچنان `READY`/۱۳ و ADR-053 `Proposed`.
>
> **به‌روزرسانی 2026-09-13 (Lag کافکای دو گروه حسابرسی و عمق نگه‌داشتهٔ `rasta.audit.v1.dlq` — فقط محلی):** سرویس Compose
> `kafka-exporter` (`danielqsj/kafka-exporter:v1.9.0`، `--kafka.server=kafka:9094`، `--offset.show-all`، Profile
> `observability`/`all`، وابسته به سلامت `kafka`، **بی Port میزبان**) و Job `kafka-exporter` در `prometheus.yml`
> (`scrape_interval: 30s`، `scrape_timeout: 25s` — پاسخ Exporter روی Broker محلی با صدها گروه `*-itest-*` ۲ تا ۹ ثانیه بود).
> متریک/Labelهای تأییدشده از `/metrics` زنده: `kafka_consumergroup_lag{consumergroup,partition,topic}` (**`-1`** برای Partition بی
> Commit)، `kafka_consumergroup_lag_sum{consumergroup,topic}` (بی `-1`)، `kafka_consumergroup_members{consumergroup}`،
> `kafka_topic_partition_current_offset`/`_oldest_offset{partition,topic}`. گروه تازهٔ `rasta-audit-kafka` در
> `rasta-audit-alerts.yml`: هشدار `RastaAuditConsumerLag` (`warning`، `for: 5m`،
> `sum by (consumergroup, topic) (clamp_min(kafka_consumergroup_lag{consumergroup=~"audit-service\\.(domain-projector|trail)"}, 0)) > 0`،
> Runbook تازهٔ `docs/runbooks/audit-ingestion-lag.md`) و Recording Rule `topic:kafka_topic_retained_records:sum`
> (`sum by (topic) (clamp_min(current_offset - oldest_offset, 0))` فقط برای `rasta.audit.v1.dlq`، فقط Label `topic`). عمق
> نگه‌داشته **پیام حل‌نشده نیست** (وضعیت Triage برای DLQ وجود ندارد)، پس عمداً هشداری روی آن نیست. **شواهد:** `promtool check
config` → `SUCCESS: 8 rules found`، `promtool test rules` → `SUCCESS` (دو گروه Lag: هر دو گروه در ۴m نه و ۵m با Label/Annotation
> دقیق، `-1` کم نمی‌کند، رفع با صفر شدن، صفر/گذرا/صفرِ میانی/گروه غیرحسابرسی بی هشدار؛ دو گروه `promql_expr_test` برای ۱۰۵ → ۱۱۵
> → ۳۵ و Clamp ۰ → ۵)؛ چهار جهش (`for: 3m`، حذف فیلتر گروه، حذف دو `clamp_min`) هر چهار را شکست داد. زنده: Target
> `kafka-exporter` برابر `up`، `scrape_samples_scraped` ۱۰۱۲۰، Recording Rule `{topic="rasta.audit.v1.dlq"} 18162`، و چون
> `audit-service` اجرا نمی‌شد (`members` = ۰) هر ۱۱ ترکیب (ده Topic دامنه + Trail با Lag ۳۶) از `pending` به `firing` رسیدند.
> **نقطهٔ کور بسته‌شده (همان روز، بعدتر):** سکوت `RastaAuditConsumerLag` بی ورودی دیگر با «بی‌Lag» یکی نیست. دو هشدار
> `warning` در همان گروه: `RastaKafkaExporterUnavailable` (`for: 2m`،
> `min by (job) (up{job="kafka-exporter"}) == 0 or absent(up{job="kafka-exporter"})`، Label فقط `job`) و
> `RastaAuditConsumerGroupMetricsMissing` (`for: 5m`،
> `(absent(kafka_consumergroup_lag{consumergroup="audit-service.domain-projector"}) or absent(kafka_consumergroup_lag{consumergroup="audit-service.trail"})) and on () (min(up{job="kafka-exporter"}) == 1)`،
> Label فقط `consumergroup`؛ هنگام خرابی Exporter خاموش). اکنون ۱۰ قاعده (۹ هشدار + ۱ Recording). **شواهد:** `check config` →
> `SUCCESS: 10 rules found`؛ `test rules` → `SUCCESS` با نُه گروه آزمون تازه (`pending` در ۱m از راه `ALERTS`، `firing` در ۲m،
> نبودن کامل `up`، خرابی گذرا، گروه غایب با Label دقیق، صفر/`-1` موجود، گروه‌های `audit-itest-*`، سرکوب هنگام خرابی Exporter،
> ناپدید شدن گذرا با `stale` و Reset تایمر)؛ نُه جهش (حذف `absent(up)`، حذف/ضعیف کردن Gate، سه Regex، حذف `min by`، کوتاه کردن
> دو `for`) همه شکست خوردند. زنده روی Broker موجود: توقف فقط `kafka-exporter` → `up=0`، `pending` از 09:57:36 و `firing` از
> 09:59:36 UTC با `{job="kafka-exporter",severity="warning"}`، رفع پس از Start دوباره؛ هشدار گروه غایب هیچ‌گاه فعال نشد. شاخهٔ
> «Exporter سالم/گروه غایب» عمداً زنده بازتولید نشد، چون هر دو گروه Offset Commit‌شده دارند و ساختنش حذف Metadata گروه یا
> جابه‌جایی Offset می‌خواست؛ فقط `promtool` آن را اثبات می‌کند.
> **تناقض با ADR-053 § ۱۳ رفع شد (همان روز، بعدتر):** `rasta_audit_ingestion_lag_seconds{source_topic}` دیگر Gauge نیست؛
> **Histogram** با `AUDIT_INGESTION_LAG_BUCKETS` = `1, 5, 15, 30, 60, 120, 300, 900, 3600` (+`+Inf`) است و هر دو مصرف‌کننده
> فقط پس از `WRITTEN` با `observe(max(0, now - occurredAt))` ثبت می‌کنند (نه `DUPLICATE`، رد یا شکست پایگاه داده). هر ۱۱
> `source_topic` (`[...DOMAIN_TOPICS, AUDIT_TRAIL_TOPIC]`) هنگام بار شدن ماژول با `zero()` — بی مشاهدهٔ ساختگی — صادر می‌شوند:
> ۱۳۲ Series. هشدار تازهٔ `RastaAuditIngestionLagHigh` (`warning`، `for: 5m`، گروه `rasta-audit-evidence`،
> `histogram_quantile(0.95, sum by (le, source_topic) (rate(rasta_audit_ingestion_lag_seconds_bucket[5m]))) > 60`، Label فقط
> `source_topic`). اکنون ۱۱ قاعده (۱۰ هشدار + ۱ Recording). **شواهد:** audit-service ۲۲ مجموعه / ۶۳۲ آزمون (Exposition دقیق،
> `zero()` بی `observe`، مسیر A و B با `Date.now()` ثابت، Clamp، Duplicate/خطا بی مشاهده) و ۹ جهش TypeScript همه گرفته شدند؛
> `check config` → `SUCCESS: 11 rules found`؛ `test rules` → `SUCCESS` (pending در ۵m، firing در ۶m، یک هشدار برای دو Instance،
> Topic مستقل در ۹m، مرز دقیق ۶۰، Instance کندِ اقلیت، `NaN`، Reset `for` تا ۱۳m) و ۹ جهش PromQL همه شکست خوردند. زنده:
> `/metrics` روی Backlog واقعی محلی (بی رویداد ساختگی) ۱۳۲ Series و `_count` برابر ردیف‌های نوشته‌شده نشان داد و Prometheus قاعده
> را `health=ok` ارزیابی کرد؛ هشدار **زنده نسوخت**، چون کل Backlog پیش از نمونهٔ دوم Scrape نوشته شد و `rate` صفر (p95 = `NaN`) بود.
> **سکوت تولیدکنندهٔ مورد انتظار — Opt-in (همان روز، بعدتر):** نخست یک نقص Cardinality رفع شد: `source_service` در
> `rasta_audit_records_ingested_total` مستقیماً `envelope.producer` بود (رشتهٔ تولیدکننده، فقط تا ۱۲۸ نویسه) و ادعای «کراندار» در
> ADR-053 § ۱۳ درست نبود. اکنون `services/audit-service/src/audit/audit-producer-topology.ts` تنها منبع Frozen توپولوژی است: ده
> Topic مسیر A با مالک (نُه مالک؛ `asset-service` مالک `rasta.asset.v1` و `rasta.insurance.v1`)، `AUDIT_TRAIL_PRODUCERS` =
> `identity-service`، و Fallback ‏`unknown`؛ `DOMAIN_TOPICS` از آن مشتق است. Label مسیر A نام مالک است فقط اگر Producer با
> مالک Topic تحویل بخواند، مسیر B فقط تولیدکنندهٔ شناخته‌شدهٔ Trail، وگرنه `unknown` (۱۰ مقدار). ستون ذخیره‌شدهٔ `source_service`
> بی‌تغییر همان ادعای تولیدکننده است. پیکربندی `AUDIT_EXPECTED_ACTIVE_PRODUCERS` (CSV، پیش‌فرض **خالی**، Trim/Dedupe، رد نام
> ناشناخته و عنصر خالی بی بازگویی متن، آرایهٔ Frozen). `AppModule.onModuleInit` پیش از شروع Consumerها
> `initializeExpectedProducerSeries` را صدا می‌زند: `rasta_audit_expected_active_producer{source_service} 1` فقط برای اعضا و
> Tupleهای شمارندهٔ آن‌ها با `inc(…, 0)`. هشدار `RastaAuditProducerSilent` (`warning`، `for: 30m`، Label فقط `source_service`،
> Runbook `audit-gap-detected`):
> `(max by (source_service) (rasta_audit_expected_active_producer == 1) and on (source_service) max by (source_service) (rasta_audit_expected_active_producer offset 6h == 1)) unless on (source_service) (sum by (source_service) (increase(rasta_audit_records_ingested_total[6h])) > 0)`
> — آستانهٔ مؤثر ۶ ساعت و ۳۰ دقیقه بی ردیف؛ نخستین Firing ممکن ۶h30m پس از نخستین Scrape Gate. پرسش باز **Q-54** (کدام سرویس
> آهنگ تضمین‌شده دارد و چه سکوتی اقدام‌پذیر است؛ 🟡، ۱۷ قابل تعویق، ۴۷ باز). اکنون ۱۲ قاعده (۱۱ هشدار + ۱ Recording).
> **شواهد:** audit-service ۲۳ مجموعه / ۷۱۷ آزمون و ۱۰ جهش TypeScript همه گرفته شدند؛ `check config` → `SUCCESS: 12 rules found`؛
> `test rules` → `SUCCESS` با ۲۹ گروه (۴ تازه: Startup تا ۳۵۹m ساکت، pending ۳۶۰m، firing دقیقاً ۳۹۰m با یک هشدار برای دو Instance؛
> سرویس پیکربندی‌نشده/`unknown`/تازه‌پیکربندی‌شده ساکت؛ دو تولیدکنندهٔ مستقل؛ رفع با ردیف و Reset ‏pending؛ Reset شمارنده ۷→۰
> ساکت و ۷→۱ شمرده؛ بی Series شمارنده می‌سوزد؛ بی Gate ساکت) و ۹ جهش PromQL همه شکست خوردند. شواهد زنده در
> `ClaudeResultReport.md` همین گام. **مرز:** فقط نبودِ ردیف از تولیدکنندهٔ اعلام‌شده را ثابت می‌کند، نه انتشار رویداد برای هر عملیات.
> **از دست رفتن متریک‌های خود `audit-service` صریح شد (همان روز، بعدتر):** همهٔ هشدارهای `rasta_audit_*` بی Scrape همین
> فرایند بی‌صدا غیرفعال می‌شدند و Target ‏`host.docker.internal:3115` در Job مشترک `rasta-services` فقط با `instance` قابل
> تشخیص بود. اکنون در `prometheus.yml` Job اختصاصی `audit-service` (`metrics_path: /metrics`، `environment: local`) تنها جای
> ۳۱۱۵ است و ۳۰۰۰/۳۱۰۱/۳۱۰۲ در آن گام در `rasta-services` ماندند (۳۱۰۱ بعدتر رفت، پایین). هشدار `RastaAuditServiceMetricsUnavailable` (`warning`، `for: 2m`،
> گروه `rasta-audit-evidence`، Runbook `audit-gap-detected` § ۸ تشخیص،
> `min by (job) (up{job="audit-service"}) == 0 or absent(up{job="audit-service"})`، Label فقط `job`): شکست Scrape **هر**
> Replica (`min`، چون شمارنده‌ها محلی فرایندند) یا نبودن کامل Target؛ چند Replica یک هشدار. در آن گام ۱۳ قاعده (۱۲ هشدار +
> ۱ Recording). **شواهد:** `check config` → `SUCCESS: 13 rules found`؛ `test rules` → `SUCCESS` با ۳۵ گروه (۶ تازه: pending
> ۲–۳m و firing دقیقاً ۴m، رفع و قطع دوم با `for` تازه، `rasta-services`/Exporter خاموش یا سالم بی اثر، `absent` در ۲m،
> `stale` در ۴m، یک Replica از دو، شکست کوتاه بی هشدار) و ۸ جهش PromQL (حذف `absent`، حذف `== 0`، Selector ‏`rasta-services`
> یا بی Selector، `by (job, instance)`، `max`، حذف `for`، `for: 1m`) همه شکست خوردند؛ شواهد زنده در `ClaudeResultReport.md`
> همین گام. **مرز:** فقط از دست رفتن تله‌متری audit-service را ثابت می‌کند، نه انتشار رویداد برای هر عملیات.
> **از دست رفتن متریک‌های `identity-service` صریح شد (همان روز، پس از آن):** سه هشدار شواهد رد مسیر B
> (`RastaSecurityEventCaptureGap`، `RastaSecurityEventClosedBacklogStale`، `RastaSecurityEventPublishFailure`) بی Scrape همین
> فرایند بی‌صدا ورودی از دست می‌دادند. اکنون در `prometheus.yml` Job اختصاصی `identity-service` (`metrics_path: /metrics`،
> `environment: local`) تنها جای ۳۱۰۱ است، ۳۱۱۵ فقط در `audit-service` و `rasta-services` فقط ۳۰۰۰/۳۱۰۲. هشدار
> `RastaIdentityServiceMetricsUnavailable` (`warning`، `for: 2m`، گروه `rasta-audit-evidence` کنار سه هشدار صف ردها، Runbook
> `security-event-outbox` § ۶ تشخیص، `min by (job) (up{job="identity-service"}) == 0 or absent(up{job="identity-service"})`،
> Label فقط `job`): شکست Scrape **هر** Replica (`min`، چون شمارنده‌های ثبت/انتشار و Gaugeهای پشته محلی فرایندند) یا نبودن
> کامل Target؛ چند Replica یک هشدار؛ یک Scrape موفق تایمر را Reset می‌کند. رفتار ۱۲ هشدار و Recording Rule پیشین دست نخورد.
> **اکنون ۱۴ قاعده (۱۳ هشدار + ۱ Recording).** Seriesهای Fixture سه هشدار صف ردها (و Seriesهای `up` نشانی ۳۱۰۱ در گروه‌های
> audit-service/Exporter) اکنون `job="identity-service"` دارند، با همان مقدار و انتظار. **شواهد:** `check config` →
> `SUCCESS: 14 rules found`؛ `test rules` → `SUCCESS` با ۴۱ گروه (۶ تازه: pending ۲–۳m و firing دقیقاً ۴m، رفع در ۶m و قطع دوم
> با `for` تازه تا ۱۰m، `rasta-services`/audit-service/Exporter خاموش یا سالم بی اثر، `absent` در ۲m حتی با ۳۱۰۱ زیر پیکربندی
> قدیمی `rasta-services`، `stale` در ۴m، یک Replica از دو در ۴m و یک هشدار با شکست هر دو، شکست کوتاه بی هشدار) و ۸ جهش PromQL
> (حذف `absent`، حذف `== 0`، Selector ‏`rasta-services` یا بی Selector، `by (job, instance)`، `max`، حذف `for`، `for: 1m`) همه
> شکست خوردند؛ دروازه‌های سرویس، E2E و شواهد زنده در `ClaudeResultReport.md` همین گام. **مرز:** فقط از دست رفتن تله‌متری
> identity-service را ثابت می‌کند، نه اینکه هر رد یا تغییر وضعیت شواهد ساخته است.
> **هنوز نیست:** Alertmanager و تحویل اعلان، Scrape محیط واقعی، داشبورد، Lag گروه‌های دیگر و عمق Topicهای DLQ دیگر، تشخیص
> Offset غایبِ هر Topic، ابزار بازپخش، Heartbeat تولیدکننده و تشخیص رکورد غایب (تطبیق شکاف رکورد به رکورد).
> `COM-009` همچنان `READY`/۱۳ و ADR-053 `Proposed`.
>
> **به‌روزرسانی 2026-09-13 (داشبورد محلی Grafana ‏`Rasta Audit Evidence` — فقط شکاف داشبورد محلی):** Datasource موجود
> `Prometheus` UID ثابت `rasta-prometheus` گرفت (نام، نوع، URL، `proxy`، پیش‌فرض و `editable: true` دست نخوردند). Provider فایل
> `infrastructure/docker/grafana/provisioning/dashboards/rasta.yml` (`type: file`، پوشهٔ `Rasta`/`folderUid: rasta`،
> `disableDeletion: true`، `allowUiUpdates: false`، `updateIntervalSeconds: 10`، مسیر `/etc/grafana/dashboards`) و JSON بیرون از
> `provisioning/` در `infrastructure/docker/grafana/dashboards/rasta-audit-evidence.json` که `docker-compose.yml` فقط‌خواندنی
> Mount می‌کند. داشبورد: UID `rasta-audit-evidence`، Tagهای `rasta`/`audit`/`local`، ۶h، Refresh ۳۰s، UTC، بی متغیر؛ **۱۱ Panel،
> ۱۴ Query**: متن مرز، `ALERTS` برای هر ۱۳ هشدار، `up` سه Job (با `absent`)، Throughput، p95 تأخیر، Lag دو گروه، span نگه‌داشتهٔ
> DLQ از Recording Rule، وضعیت `RastaAuditProducerSilent` فقط برای تولیدکنندگان پیکربندی‌شده، شکست ورود/زنجیره/DLQ، شکاف ثبت و
> انتشار ردها، سن پشتهٔ بسته. هیچ قاعده، عبارت، زمان‌بندی یا متریک Prometheus و هیچ کد سرویس تغییر نکرد. **دروازه:**
> `scripts/check-grafana-dashboard-lib.mjs` + CLI (`pnpm run check:grafana-dashboard`) و ۲۱ آزمون جهش‌محور
> (`pnpm run test:grafana-dashboard-lib`) در `pnpm verify` و Job ‏`quality`؛ نام هشدارها از خود فایل Rules خوانده می‌شود.
> **شواهد زنده** (`pnpm run verify:grafana-dashboard-live`، Prometheus v3.1.0 + Grafana 11.5.1 ایزوله با نام/شبکه/Port یکتا):
> ۱۳ هشدار + ۱ Recording بار شد؛ Datasource با UID/URL درست و Health `OK`؛ داشبورد در پوشهٔ `Rasta` با `provisioned=true` و
> ۱۱/۱۴؛ `DELETE` → `400 provisioned dashboard cannot be deleted`؛ هر ۱۴ Query در Prometheus و `/api/ds/query` موفق؛
> `/d/rasta-audit-evidence` → `200`؛ صفر خطای Provisioning داشبورد/Datasource؛ پاک‌سازی بی Container/شبکهٔ باقی. دو خطای
> از پیش موجود Grafana برای نبودن پوشه‌های `provisioning/plugins` و `provisioning/alerting` گزارش و رفع **نشد**. Grafana 11.5.1
> در Compose پیش‌فرض Pluginهای Preinstall را از اینترنت دانلود می‌کند (Harness آن را خاموش کرد؛ Compose دست نخورد). **مرز:**
> فقط تله‌متری محلی؛ Alertmanager/تحویل اعلان، Scrape محیط واقعی، Heartbeat تولیدکننده و تطبیق رکورد به رکورد همچنان نیستند و
> نبودن هشدار اثبات کامل بودن شواهد نیست. AUD-004 بسته نشد؛ `COM-009` همچنان `READY`/۱۳ و ADR-053 `Proposed`.
>
> **به‌روزرسانی 2026-09-13 (راه‌اندازی Grafana محلی خودبسنده و بی خطا):** دو ایراد گزارش‌شدهٔ ورودی بالا رفع شد. سرویس
> `grafana` در Compose اکنون `GF_ANALYTICS_REPORTING_ENABLED`، `GF_ANALYTICS_CHECK_FOR_UPDATES`، `GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES`،
> `GF_NEWS_NEWS_FEED_ENABLED` (`'false'`) و `GF_PLUGINS_PREINSTALL_DISABLED` (`'true'`) را دارد؛ Image، Port، Credential، Profile و
> Volumeها دست نخوردند. فایل‌های بی‌اثر `provisioning/plugins/rasta.yml` (`apiVersion: 1`، `apps: []`) و
> `provisioning/alerting/rasta.yml` (فقط `apiVersion: 1`) هیچ Plugin، Alert Rule، Contact Point یا Policy فراهم نمی‌کنند.
> `checkGrafanaStartup` در `scripts/check-grafana-dashboard-lib.mjs` هر دو را در `pnpm verify`/CI پاس می‌دارد (۲۸ آزمون، ۷ تازه).
> `verify-grafana-dashboard-live.mjs` اکنون **صفر** خط `level=error|crit` و صفر خط نصب Plugin می‌خواهد، به‌علاوهٔ شاهد مثبت
> Provisioning Datasource/داشبورد/Alerting و API (۰ App غیرهسته‌ای، ۰ Alert Rule، ۰ Contact Point/Policy Provision‌شده). **شواهد:**
> Harness روی Grafana 11.5.1 سه بار سبز (۱۳۸۳ خط Log، ۰ خطا، ۱۴/۱۴ Query، `DELETE` → ۴۰۰، پاک‌سازی کامل)؛ کنترل منفی بی دو پوشه
> با همان دو خطا شکست خورد. هیچ Alertmanager، تحویل اعلان، قاعده، Plugin، داشبورد یا کد سرویسی افزوده نشد. `COM-009` همچنان
> `READY`/۱۳ و ADR-053 `Proposed`.
>
> **به‌روزرسانی 2026-09-14 (Harness زندهٔ داشبورد روی شبکهٔ بی مسیر بیرونی):** آزمایش 2026-09-13 نشان داد Docker Desktop
> 29.7.2/WSL2 برای Containerی که فقط روی شبکهٔ `--internal` است Port میزبان منتشر نمی‌کند. پس `verify-grafana-dashboard-live.mjs`
> اکنون Orchestrator است: Prometheus و Grafana روی `docker network create --internal` یکتا، بی `-p`، با Aliasهای `prometheus` و
> `grafana`؛ Assertionهای HTTP به `verify-grafana-dashboard-probe.mjs` در Container کوتاه‌عمر `node:22-alpine` (فقط همان شبکه، مخزن
> فقط‌خواندنی، `--user node`، `--read-only`، `--cap-drop ALL`، بی Socket ‏Docker) منتقل شد؛ Log Grafana در میزبان بررسی می‌شود.
> `verify-grafana-dashboard-isolation-lib.mjs` (Docker تزریقی) با `network inspect` (دقیقاً یک شبکه، همان نام، `Internal` بولی
> `true`) و `container inspect` (هر سه Container فقط روی همان شبکه، بی Binding) پیش و پس از Probe شکست بسته دارد؛ ۱۰ آزمون با Docker
> جعلی (`pnpm run test:grafana-live-isolation-lib`) در `pnpm verify` و CI. **یافته:** نخستین اجرای ایزوله با یک خط `level=error`
> از `plugin.signature.key_retriever` (دانلود کلید امضای Plugin از grafana.com) شکست خورد؛ `GF_PLUGINS_PUBLIC_KEY_RETRIEVAL_DISABLED:
'true'` به سرویس `grafana` در Compose و `EXPECTED.grafanaNoOutboundEnv` افزوده شد (شش متغیر). **شواهد:** اجرای بعدی سبز —
> `internal=true`، `publishedPorts=0` پیش و پس از Probe، Probe با `0`، ۱۴+۱۴ Query، ۰ خطا/۰ نصب Plugin، پاک‌سازی کامل؛ کنترل‌های منفی
> (حذف `--internal`، دور زدن Inspect، Binding ساختگی، دور زدن بررسی Port یا Helper) آزمون‌ها را شکستند. **مرز:** فقط همین Stack
> یک‌بارمصرف؛ شبکهٔ Compose توسعه محدود نیست و سیاست شبکهٔ Production نیست. `COM-009` همچنان `READY`/۱۳ و ADR-053 `Proposed`.
> **Known Issue آن روز — اکنون تشخیص داده و بسته شد (به‌روزرسانی بعدی را ببین):** در همین اجرا آزمون‌های `identity-service`
> از Cache خارج شدند و `audit-correction.int-spec.ts › collapses concurrent duplicate submissions into one command and one outbox
row` ناپایدار بود — در سه `pnpm verify` هر سه بار و در اجرای تنهای همان Spec دو از سه بار، ۲ یا ۳ از ۶ درخواست هم‌زمان
> `500 INTERNAL_ERROR` («could not be recorded») گرفتند؛ یک بار هم `windowed refusal aggregation › exactly 500 concurrent captures` با
> `57014 statement timeout` شکست خورد. آن زمان خطای زیرین پایگاه داده (غیر Unique Violation) تشخیص داده نشده بود.
>
> **به‌روزرسانی 2026-09-14 (تشخیص آن ناپایداری و سریال‌سازی تصمیم Idempotency فرمان اصلاح):** **خطای زیرین:** با Classifier
> موقت (فقط کلاس خطا، کد `P####`، `meta.code` و یک برچسب ثابت؛ بی پیام/Query/شناسه؛ سپس حذف و بازگردانی بایت‌به‌بایت) هر ۵۰۰ از
> نوع `PrismaClientKnownRequestError` **`P2028`** با `meta.code` تهی و متن «Unable to start a transaction in the given time»
> (برچسب `START_TIMEOUT`، ~۲۰۰۰ms = `maxWait` پیش‌فرض Prisma) بود — ۱۷ رخداد در ۶ اجرای پشت‌سرهم (۶ از ۶ شکست) و ۹ در ۴ اجرای
> بعدی. **علت ریشه‌ای Lock نبود:** در اجرای زمان‌دار، برنده در ۶۰ms Commit شد و دو تراکنش دیگر اصلاً شروع نشدند. Probe مستقل
> Pool نشان داد باز کردن **هر اتصال تازه** از راه `localhost:25433` حدود ۲۰۶۹ms طول می‌کشد (ویندوز اول `::1` را امتحان می‌کند و
> Forwarder موقت فقط روی `127.0.0.1` Publish شده بود) و ۳/۶/۹ تراکنش موازیِ بدیهی همه `P2028` می‌گیرند؛ با `127.0.0.1` اتصال ۳۵ms
> و ۹ اتصال در ۱۳۴ms. پس Pool تنبل Prisma + تأخیر اتصال بیش از `maxWait` = ۵۰۰. همان کد پیش از اصلاح روی `127.0.0.1` پنج از پنج
> سبز بود (۲۵ Loser از مسیر `P2002` بازیابی شدند). مسیر مستقیم میزبان در دسترس نیست: `rasta-postgres` هیچ Port منتشرشده‌ای ندارد و
> بازهٔ 5433–5532 در Excluded Port ویندوز است. **درس Harness:** Forwarder موقت PostgreSQL باید هر دو `127.0.0.1` و `[::1]` را
> Publish کند (یا URL با `127.0.0.1` باشد)، وگرنه هر آزمون هم‌زمانی تراکنشی با `P2028` شکست می‌خورد. **اصلاح محصول (همان مسابقهٔ
> ساختاری که Prompt نام برد، مستقل از علت بالا):** Loserهای هم‌کلید پیش‌تر پشت Row Lockِ `outbox_stream_sequence` صف می‌کشیدند،
> Sequence و ردیف Outbox تخصیص می‌دادند و فقط در `commands.create` با `P2002` برمی‌گشتند. اکنون در
> `AuditCorrectionService.submit` پس از Lookup مورد اعتماد (هیچ تراکنشی روی REST باز نمی‌ماند): تراکنش →
> `AuditCorrectionCommandRepository.lockCommandKey(tx, actorId, key)` = `SELECT pg_advisory_xact_lock($1)` پارامتری (Tagged
> `$executeRaw`) روی کلید `commandLockKey` = هشت بایت اولِ SHA-256ِ `JSON.stringify(['identity-service:audit_correction_command:v1',
actorId, key])` به‌صورت `int64` علامت‌دار (کدگذاری بی‌ابهام، نسخه‌دار، Collision فقط سریال‌سازی محافظه‌کارانه) → بازخوانی
> `find(actorId, key, tx)` زیر READ COMMITTED → اگر برنده هست `replayOrRefuse` بی هیچ تخصیص/درج؛ وگرنه `enqueueEvent` و
> `commands.create` در همان تراکنش. بازیابی `P2002` به‌عنوان خط دفاع آخر ماند؛ Migration/Schema، قرارداد، Route، Timeout و
> هم‌زمانی آزمون‌ها دست نخوردند. **شواهد:** ۴۲ تست واحد در دو فایل (ترتیب lock → re-read → outbox، Replay بایت‌به‌بایت و ۴۰۹ زیر
> Lock بی نوشتن، شکست Lock/Re-read → همان `INTERNAL_ERROR` کراندار، `P2002`، و Seam SQL: فقط `tx.$executeRaw` با رشته‌های دقیق
> `['SELECT pg_advisory_xact_lock(', ')']`، کلید Pinشده و تفکیک Tupleهای مبهم)؛ Integration از ۱۹ به ۲۳ تست: شش Duplicate با
> Barrier که اولین نویسنده را تا دیده‌شدن ۵ منتظرِ `pg_locks` نگه می‌دارد (دقیقاً ۱ `enqueueEvent`)، ۳+۳ درخواست هم‌کلید/متفاوت
> (یک گروه ۲۰۲، دیگری ۴۰۹، یک ردیف Outbox)، ۶ کلید متمایز با `streamSeq` پیوستهٔ ۱..۶، و آزاد شدن Lock با Commit و Rollback.
> کنترل‌های منفی (پشتیبان/بازگردانی با sha256 یکسان): حذف Lock (واحد ۱ و Integration ۳ شکست، `enqueueEvent` = ۶)، حذف Re-read
> (واحد ۵، Integration ۲، = ۶)، Session Lock (واحد ۱؛ Integration گیر کرد و Kill شد، ردیف‌های همان TAG دستی پاک شدند)، Lock پس از
> Outbox (واحد ۶، Integration ۳). پایداری پس از اصلاح: ۱۲/۱۲ اجرای پشت‌سرهم روی Forwarder با `127.0.0.1`، ۱۰/۱۰ روی Forwarder دوپشته
> با همان `localhost`؛ روی Forwarder فقط-IPv4 با `localhost` همچنان `P2028` (محیطی، نه محصول). کل `identity-service` ۲۷ Suite و
> ۸۴۰ تست سبز؛ `pnpm verify` روی Forwarder دوپشته سبز (identity بی Cache، ۸۴۰/۸۴۰)؛ E2E هویت (`specs/identity/`، Stack محلی شش
> سرویس از `dist`) ۱۲/۱۲ سبز، از جمله `02-audit-correction`. `COM-009` همچنان `READY`/۱۳ و ADR-053 `Proposed`؛ AUD-004 بسته نشد.
> **پیگیری همان روز (درس Harness اکنون اجباری است):** `.env.example` اکنون `POSTGRES_HOST` و هر ۱۷ `DATABASE_URL_*`ِ PostgreSQL
> (Runtime و `DATABASE_URL_AUDIT_MIGRATOR`) را روی `127.0.0.1:5433` می‌گذارد (Port، نام DB، Schema، نقش و گذرواژهٔ نمونه
> دست‌نخورده؛ Endpointهای غیر PostgreSQL همان `localhost`). دروازهٔ متنی `scripts/check-local-postgres-config{-lib,}.mjs` (بی
> Probe شبکه، بی خواندن `.env`، بی چاپ مقدار) Host دقیق، Port برابر `POSTGRES_PORT`، URL بدشکل و انتساب تکراری را Fail-Closed
> رد می‌کند؛ ۱۷ تست `node:test` (`pnpm test:local-postgres-config`) و `pnpm check:local-postgres-config` در `pnpm verify` و Job
> `quality` در CI. `.env` محلی کاربر عمداً بازنویسی نشد؛ README و `docs/14` § ۱۴٫۳ قاعده و نشانهٔ `P2028` را ثبت می‌کنند. تغییری
> در کد برنامه، Schema، Timeout یا URLهای CI نیست. **یافتهٔ جانبی:** با URL صریح `127.0.0.1` (Forwarder فقط-IPv4، بی تأخیر IPv6)
> `pnpm verify` دو بار در `security-event-aggregation.int-spec.ts` قرمز شد — یک بار `57014 statement timeout` در «۵۰۰ Capture از
> چهار Client» و یک بار دو ردیف به‌جای یک در «۵۰۰ رد از Endpoint» (Burst از مرز پنجرهٔ ۶۰ ثانیه‌ای گذشت) — و بار سوم سبز شد
> (۸۴۰/۸۴۰)؛ همان Spec به‌تنها سه از سه سبز بود. پس آن ناپایداری زیر بار موازی `pnpm test` از تأخیر IPv6 نیست و هنوز باز است.
>
> **پیگیری همان روز (علت آن ناپایداری: زمان‌بندی Harness، نه محصول):** با Instrumentation موقت (فقط آمار تجمیعی؛ سپس حذف) و
> نمونه‌برداری `pg_stat_activity`/`pg_locks`/`pg_stat_wal` هر ۲۵۰ms روی Forwarder `127.0.0.1:25433 → rasta-postgres:5432`:
> **به‌تنها** (۳ اجرا، سبز) هر Burst ۵۰۰تایی ۲۱٫۴–۲۳٫۶ ثانیه، ~۲۲ ‏WAL Sync/s، p95 Capture ۰٫۶۳–۰٫۶۵s (Endpoint) و ۱٫۲۶–۱٫۳۴s (چهار
> Client)، بیشینه ۴٫۹۶s، صفر خطا؛ **کنار Suiteهای Integration سرویس‌های دیگر** (۲ اجرا): ۴۲٫۴–۱۲۳٫۶ ثانیه، WAL Sync تا ۷٫۱/s، و در
> یک اجرا ۶ Capture بالای ۵s با ۴ خطای `57014` (Burst از مرز پنجره گذشت؛ Jest در ۱۲۰s قطع کرد). هیچ `P2024`/`P2028` (گرفتن اتصال) دیده
> نشد و Backendهای identity بیکار در دسترس بودند؛ انتظارها `Lock:transactionid`/`tuple` پشت نگه‌دارنده‌ای روی `IO:WALSync`/`LWLock:WALWrite`
> و I/O سرویس‌های دیگر (`DataFileImmediateSync`) بود. پس نقص محصول نیست. **مرز تازه:** Project ‏Jest ‏`aggregation-stress` فقط همین Spec؛
> `integration` آن را کنار می‌گذارد؛ `pnpm test`/`pnpm test:integration` از `scripts/run-test-phases.mjs` می‌گذرند (فاز موازی، سپس پس از
> پایان آن — حتی ناموفق — `turbo run test:aggregation-stress --filter=@rasta/identity-service`، بی Cache)؛ CI همان مسیر را دارد و گام
> `Test phase contract` (`pnpm test:test-phases` ۱۷ تست + `pnpm check:test-phases`، ایستا) در `pnpm verify` و Job ‏`quality`. پنجرهٔ ۶۰s،
> مرز ۵s، Pool، SQL و Assertionهای ۵۰۰ دست نخوردند؛ توضیح `atFreshWindow` به «حاشیهٔ شروع، نه تضمین پایان» اصلاح شد. **شواهد پایداری:**
> فاز انحصاری با Instrumentation: Burstها ۱۸٫۹/۱۹٫۴s، p95 ۰٫۵۵/۱٫۲۷s، بیشینه ۳٫۰۱s، ~۲۶ ‏WAL Sync/s؛ ۵/۵ اجرای پشت‌سرهم
> `pnpm test:aggregation-stress` سبز (۲۲/۲۲)؛ ۴ اجرای Orchestrator (`test:integration` ×۳، `test` ×۱) — اثبات فشار ۴/۴ سبز و هر بار پس از
> خروج فاز موازی آغاز شد، با صفر Backend فعال سرویس دیگر در سه اجرای سبز؛ کل identity ‏۲۷ Suite / ۸۴۰ تست. **Known Issue باز (نامرتبط):**
> فاز موازی خودش زیر بار این ماشین ناپایدار ماند — `maintenance-service › cost atomicity` (۷ یا ۰ از ۱۰)، ۵۰۰ در supplier/marketplace،
> `Can't reach database server` در fleet و `P2028` در audit در اجراهای جداگانه؛ اوج ~۹۲ Backend در برابر `max_connections=100`. پنج اجرای
> ناموفق `audit-service › tenant-isolation` که هم‌زمان در زنجیرهٔ ثابت `PLATFORM/2026-10` نوشته بودند، ۶۰ ردیف برچسب‌دار به‌جا گذاشتند و
> پاک‌سازی هر اجرای بعدی را رد می‌کردند؛ با همان منطق `cleanupRun` (ردیف بیگانه = ۰، Triggerها بازگردانده) دستی از پایگاه محلی پاک شدند.
> `COM-009` همچنان `READY`/۱۳ و ADR-053 `Proposed`؛ AUD-004 بسته نشد.
>
> **پیگیری همان روز (زنجیرهٔ Platform اختصاصی برای `tenant-isolation` در audit):** **نقص:** `tenant-isolation.int-spec.ts` تنها Suite
> audit بود که ردیف `organizationId: null` را با `at()`/`queryWindow()` ثابت `fixtures.ts` در ماه `2026-10` می‌نوشت؛ کلید زنجیرهٔ
> Platform (`PLATFORM/(platform)/2026-10-01`) هیچ Tag اجرایی ندارد، پس هر دو اجرای هم‌پوشان یا نیمه‌کاره ردیف «بیگانه» در زنجیرهٔ
> یکدیگر می‌گذاشتند و `cleanupRun` (به‌درستی) هر دو را رد می‌کرد. **اصلاح (فقط Fixture آزمون):** Slot نام‌دار
> `TENANT_ISOLATION_MONTH_SLOT = 8` → `RUN_MONTH = runMonth(8)`؛ همهٔ ردیف‌های این فایل با `instantIn(RUN_MONTH, دقیقه)`، پنجرهٔ
> Query روز اول همان ماه و پنجرهٔ «بیرون از پنجره» روز سوم همان ماه (به‌جای تاریخ‌های ثابت نوامبر ۲۰۲۶)؛ کلید زنجیرهٔ Platform اکنون
> `PLATFORM/(platform)/<runMonth(8)>`. `fixtures.ts`، `helpers.ts` و رد `cleanupRun` دست نخوردند؛ همهٔ Assertionهای جداسازی ماندند.
> آزمون تازه (۱۸ → ۱۹) ثابت می‌کند ماه Platform همان ماه اجرا با ۱ ردیف برچسب‌دار و ۰ بیگانه است، و `afterAll` روی `CleanupReport`
> ثابت می‌کند هر زنجیره در `RUN_MONTH`، ۰ ردیف بیگانه، زنجیرهٔ Platform دقیقاً `{taggedRows: 1, foreignRows: 0}`، و پس از پاک‌سازی ۰
> ردیف/۰ Head در آن ماه و ۰ Trigger غیرفعال. جهش موقت (برگرداندن زمان و پنجره به `2026-10`) همان آزمون و `afterAll` را شکست داد و
> بایت‌به‌بایت بازگردانده شد. **شواهد (Forwarder موقت `127.0.0.1:25433 → rasta-postgres:5432`):** ۵ اجرای پشت‌سرهم و ۴ اجرای تکی دیگر همه ۱۹/۱۹ سبز، دو جفت
> فرایند Jest هم‌پوشان مستقل (۲ ثانیه و هم‌زمان) هر چهار ۱/۱ Suite و ۱۹/۱۹، هر کدام Tag و ماه یکتا (مثلاً `2743-11` و `2694-12`)؛ Probe
> تجمیعی هر اجرا: در حین ۹ ردیف برچسب‌دار، ۸ `organization_ref`، ۱ ردیف در ماه Platform خودش؛ پس از آن ۰/۰/۰، ۰ Head، ۰ ردیف Platform
> در `2026-10` و ۰ Trigger غیرفعال. کل Project ‏integration در audit ‏۱۱/۱۱ Suite و ۱۷۷/۱۷۷ تست. `pnpm test:integration` دو بار با کد ۱
> بسته شد، در Suiteهای نامرتبط فاز موازی (`organization-service › b3 stream sequencing` با تراکنش منقضی ۵۰۰۰ms؛ `maintenance › cost
atomicity` ۷ از ۱۰ و `economic › wallet concurrency` ۵۶ از ۱۰۰) که Turbo به‌خاطرشان audit را پیش از پایان لغو کرد؛ فاز انحصاری هر دو بار
> ۲۲/۲۲ سبز. یک `turbo run test:integration --continue`: `tenant-isolation` زیر بار موازی PASS، ولی `audit › kafka-projector` (۸ تست) با
> `Can't reach database server` روی Forwarder، به‌همراه همان ناپایداری‌های نامرتبط شناخته‌شده. `format:check`، `progress:check`، `lint`،
> `typecheck` و `build` سبز؛ `pnpm verify` با کد ۱ فقط در فاز انحصاری identity بسته شد (`windowed refusal aggregation › exactly 500
concurrent captures from four independent database clients` با `57014`، ۲۱/۲۲؛ فاز Workspace ‏۳۴/۳۴ سبز) — همان ناپایداری فشار که
> پیش‌تر به زمان‌بندی نسبت داده شد، این بار بی بار موازی هم‌زمان؛ باز است. `COM-009` همچنان `READY`/۱۳ و ADR-053 `Proposed`؛ AUD-004 بسته
> نشد.
>
> **پیگیری همان روز (شواهد Linux بومی برای اثبات فشار تجمیع):** **آزمایش محلی جفت‌شده (بی Commit):** پنج اجرای اثبات «۵۰۰ Capture
> از چهار Client» روی Volume موجود `rasta-postgres` و پنج اجرا روی PostgreSQL یک‌بارمصرف، هر ده سبز. Probe تک‌Committer روی Volume
> موجود ۱۴٫۶–۲۳٫۰ ‏tps بود و روی Volume یک‌بارمصرف ۲۶٫۰–۲۶٫۶. این آزمایش Volume را از مسیر ذخیره‌سازی میزبان جدا نکرد. **CI:** Draft
> PR #44 فقط برای اجرای CI باز شد و Merge نمی‌شود. آن PR با `main` در `README.md` تعارض دارد، پس GitHub هیچ `pull_request` ای اجرا
> نمی‌کند؛ از این رو Commitهای موقت `460d4c6` و `e639261` یک Workflow شواهد و Trigger ‏`push` همین شاخه را افزودند. اجرای نخست
> (`34865601557`) به‌خاطر نقص Harness نامعتبر شد (`jest/bin/jest.js` مسیر Export‌شده نیست) و هیچ Jest ای اجرا نشد. اجرای معتبر
> [`34866093019`](https://github.com/marabi766/RASTA/actions/runs/34866093019) روی `e6392610`، با Ubuntu 24.04.5 (Image ‏`ubuntu24/20260907.300.1`، ۴ CPU، ۱۵٫۶GiB، overlay2) و
> Service ‏`postgis/postgis:16-3.4`، ‏PostgreSQL 16.4 (`fsync=on`، `synchronous_commit=on`، `fdatasync`، ‏`shared_buffers=128MB`)، تنها
> روی پایگاه داده: Control ‏`SELECT 1` ‏۹۲٬۹۴۹ تراکنش با ۰٫۰۰۰۳ ‏`wal_sync` در هر تراکنش؛ Probe پیش ۲۷۳٬۸۲۲ تراکنش، ۴٬۵۶۴ ‏tps،
> تأخیر ۰٫۲۱۹ms، ‏`wal_sync` ۱٫۰۰۰۴ در هر تراکنش، کمینهٔ بازه ۳٬۷۹۴ ‏tps، صفر بازهٔ بی Commit؛ Probe پس ۲۷۷٬۲۸۱، ۴٬۶۲۲ ‏tps، ۰٫۲۱۶ms،
> ۱٫۰۰۰۰، کمینه ۳٬۹۷۴، صفر بازه. پنج اجرای نام‌دار هر پنج سبز (۱ اجرا، ۲۱ فیلترشده؛ آزمون ۵۳۵–۵۴۸ms؛ ۵۰۱–۵۰۳ ‏`wal_sync`؛ صفر `57014`،
> خطای دیگر پایگاه داده، Timeout ‏Jest، ردیف دوم یا شکاف شمارش). اجرای کامل ‏۲۲/۲۲ سبز در ۵۳٫۸ ثانیه. Burst کوتاه‌تر از تفکیک
> نمونه‌بردار یک‌ثانیه‌ای بود، پس ارقام Burst ‏`n/a` ماندند. Artifact آن (۱٬۴۹۷ بایت) تا 2026-09-21 نگه داشته می‌شود. در همان Commit، CI
> معمول Quality، Security، Prometheus و ClamAV را سبز داشت؛ Integration و E2E پیش از هر آزمون در `Start MinIO` شکست خوردند
> (`pull access denied for minio/minio`)، که `main` در `18497e5` با Quay رفع کرده و این شاخه هنوز ندارد. **نتیجه:** شکست‌های محلی
> محیطی‌اند (Docker Desktop/بار میزبان)، نه نقص اثبات. اطمینان بالا برای Runner؛ ولی Runner حدود ۲۰۰ برابر سریع‌تر است و مرز اثبات را
> نمی‌آزماید. **پاک‌سازی:** Workflow و Trigger موقت حذف شدند؛ `scripts/aggregation-evidence{,-lib,.test}.mjs` به‌صورت اندازه‌گیری
> دستی ماند (§ ۱۴٫۳ در `docs/14`) با ۱۲ آزمون `pnpm test:aggregation-evidence-lib` در `pnpm verify` و Job ‏`quality`. کد محصول، Spec،
> Timeout، Pool، SQL و پنجره تغییر نکردند. آستانهٔ پیش‌شرط هنوز تعیین نشده است. `COM-009` همچنان `READY`/۱۳ و ADR-053 `Proposed`؛
> AUD-004 بسته نشد.
>
> **پیگیری همان روز (ادغام `main` و نخستین CI معمول PR #44):** `origin/main` (`20a6bbe`، شامل Quay برای MinIO در `18497e5` و
> README انگلیسی #42) با Merge Commit عادی `18c5b93` وارد شاخه شد. تنها تعارض `README.md` بود: README ‏`main` نگه داشته شد و یادداشت
> Local development اکنون `127.0.0.1:5433`، بازنویسی‌نشدن `.env`، `pnpm check:local-postgres-config` و شواهد `localhost`/IPv6 و `P2028`
> در `docs/14` § ۱۴٫۳ را می‌گوید. PR #44 از `CONFLICTING` به `MERGEABLE` رسید (همچنان Draft). **نخستین اجرای `pull_request`**
> ([`34871530347`](https://github.com/marabi766/RASTA/actions/runs/34871530347)): MinIO و mc از Quay در Integration و E2E موفق، E2E سبز؛ ولی
> `identity-service › audit-correction.int-spec.ts` دو تست از ۹۰ شکست خورد (هر شش ارسال `500`): «صف تکراری‌ها روی قفل فرمان» و «۴۰۹
> هم‌زمان». این دو اثبات از `0110573` هرگز در CI اجرا نشده بودند. **علت (قطعی، مال Harness):** نویسندهٔ برنده درون تراکنش تعاملی (مهلت
> ۵s) منتظر می‌ماند تا پنج ارسال دیگر روی Advisory Lock صف بکشند؛ این هفت اتصال هم‌زمان از Pool سرویس می‌خواهد (برنده، پنج منتظر،
> Probe ‏`pg_locks` روی همان Pool)، ولی پیش‌فرض Prisma دو برابر هستهٔ فیزیکی به‌علاوهٔ یک است: پنج روی Runner چهار vCPU و نه روی ماشین
> چهارهسته‌ای محلی. بازتولید محلی با `connection_limit=5` (Forwarder موقت، `rasta-postgres` دست‌نخورده): همان دو تست، دو بار؛ پیش‌فرض
> ۲۳/۲۳. **اصلاح `afe2403` (فقط Harness):** گزینهٔ `connectionLimit` در `startIdentityApi` و `RACE_SIZE + 2 = 8` در این Suite؛ با URL
> محدود به ۵، سه اجرا ۲۳/۲۳؛ جهش به ۶ همان دو تست را شکست داد. کد محصول، Pool Production، Timeout، پروتکل قفل و Assertionها تغییر
> نکردند. **CI روی `afe2403`** ([`34874246924`](https://github.com/marabi766/RASTA/actions/runs/34874246924)): هر شش Job سبز (Build and scan
> images فقط روی `main`)، از جمله Integration با همهٔ Coverage Gateها، Tenant isolation، Migration reversibility، B3 و فاز انحصاری فشار؛ E2E
> ۹۵ سبز. `pnpm verify` محلی اجرا نشد: `rasta-postgres` Port منتشرشده ندارد و `.env` به `localhost:5433` بسته اشاره می‌کند. `COM-009`
> همچنان `READY`/۱۳ و ADR-053 `Proposed`؛ AUD-004 بسته نشد.
>
> **پیگیری همان روز (ADR-055 — طراحی پیش‌شرط توانایی محیط؛ فقط مستندات، بی هیچ تغییر رفتاری):** تنها خروجی این گام یک تصمیم
> مکتوب است. `docs/adr/ADR-055-aggregation-stress-environment-capability.md` با وضعیت **`Proposed`** ساخته شد و
> `docs/21-adr-list.md` (سطر جدول + خلاصه)، `docs/14` § ۱۴٫۳ (ارجاع کوتاه بلافاصله پس از زیربخش شواهد دستی نرخ Commit) و
> ریسک تازهٔ **R-12** در `ADR-053-implementation-plan.md` به آن اشاره می‌کنند. **آنچه تصمیم گرفته شد:** **اعتبار Probe** از
> **توانایی محیط** جدا می‌شود — اعتبار همان چیزی است که `CONTROL_SQL`، `WAL_PROBE_SQL`، `PROBE_VALIDITY`، `validateProbeSql` و
> `summarizeProbe` امروز می‌سنجند (یک تراکنش ضمنی WAL-نویس، تقریباً یک `wal_sync` در هر Commit، Control فقط‌خواندنی نزدیک صفر،
> بی تراکنش شکست‌خورده، با نمونهٔ پیشرفت کافی)، و Probe **معتبر** به‌خودی‌خود «محیط توانا» نیست؛ Probe **نامعتبر** هم هرگز «کند»
> برچسب نمی‌خورد. سه حالت خروج: `VALID_CAPABLE` (Suite دست‌نخورده اجرا می‌شود)، `VALID_INCAPABLE` (Fail-Fast به‌عنوان شکست
> محیط، نه شکست تست محصول) و `INVALID`/`INCONCLUSIVE` (خطای Probe/زیرساخت با فهرست دلایل اعتبار) — و **هیچ حالتی حق ندارد
> Suite را Skip کند و دروازه را سبز بگرداند**. نقطهٔ یکپارچگی آینده: `scripts/run-test-phases.mjs`، پس از پایان کامل فاز
> Workspace و بلافاصله پیش از فاز انحصاری، روی همان PostgreSQL ‏`identity-service`، انحصاری و بی چاپ URL. گزارش، همان فیلدهای
> تجمیعی و همان `redact`/`classifyFailures` امروزی. **آنچه عمداً تصمیم گرفته نشد:** عدد آستانه. ۱۴٫۶–۲۹٫۲ توزیعی است که اثبات
> در آن هم گذشته و هم شکسته، و ۴٬۵۶۴/۴٬۶۲۲ (اجرای `34866093019`) حدود ۲۰۰ برابر سریع‌تر است و مرز را نمی‌آزماید؛ پس ADR شواهد
> **کالیبراسیون جفت‌شده** را الزام می‌کند (Preflight + اجرای دست‌نخوردهٔ Suite، همان پایگاه داده، پشت‌سرهم، شامل هر دو سمت
> گذشتن و شکستنِ محیطی) و آستانه را پس از آن نسخه‌دار در ADR و کد با آزمون مرزی و جهش می‌خواهد. **یک ناهم‌خوانی ثبت‌شده:** کران
> بالای ۲۹٫۲ فقط در `docs/14` § ۱۴٫۳ آمده؛ این فایل برای همان آزمایش جفت‌شده ۱۴٫۶–۲۳٫۰ (Volume موجود) و ۲۶٫۰–۲۶٫۶ (یک‌بارمصرف)
> را ثبت کرده و اجرای متناظر ۲۹٫۲ را ندارد — ADR-055 این را به‌عنوان نبودِ Provenance می‌نویسد، نه به‌عنوان داده. **هنوز پیاده
> نیست:** Preflight، Classifier، طبقه‌بندی Fail-Closed § ۴، عدد آستانه و آزمون‌های مرزی/قرارداد Orchestration — **هیچ‌کدام**.
> هیچ تغییری در `package.json`، Workflow، Script، سرویس، تست، ثابت تست یا پیکربندی پایگاه داده انجام نشد. `COM-009` همچنان
> `READY`/۱۳، ADR-053 همچنان `Proposed`، PR #44 همچنان Draft و Merge‌نشده؛ AUD-004 بسته نشد.
>
> **پیگیری همان روز (Mode کالیبراسیون جفت‌شده — دستی، فقط‌گزارش، بی آستانه):** ابزارِ **جمع‌آوری شواهدِ** ADR-055 § ۶ ساخته شد،
> نه Preflight و نه دروازه. Harness موجود Mode دومی گرفت، **بی Probe دوم و بی کپی SQL/Parser/قواعد اعتبار/Redaction/منطق
> زیرفرایند**؛ Mode قدیمی (`node scripts/aggregation-evidence.mjs <گزارش>`) بایت‌به‌بایت همان رفتار را دارد.
> **فراخوانی:** `pnpm run calibrate:aggregation-stress -- --pairs <۱..۲۰> <گزارش>`. **یک نمونه** = یک Probe ‏WAL شصت‌ثانیه‌ای
> اعتبارسنجی‌شده + **بلافاصله** یک اجرای تازهٔ کل Project دست‌نخوردهٔ `aggregation-stress` از راه `pnpm test:aggregation-stress`؛
> یک Control فقط‌خواندنی پیش از جفت‌ها، و **هیچ گامی میان Probe یک جفت و Suite همان جفت** — چون اندازه‌گیریِ فاصله‌دار شرایطی را
> توصیف می‌کند که آن اجرا ندیده. `validateCalibrationContract` مجاورت، فیلترنشدن Project، نبود Retry، نبود `--passWithNoTests` و
> ثابت‌های فشار را ایستا می‌پاید. **تعداد جفت فقط از خط فرمان** (بی Override محیطی)؛ مقدار غایب/غیرصحیح/صفر/منفی/بیرون از بازه با
> کد ۲ **پیش از هر زیرفرایند و هر تماس با پایگاه داده** رد می‌شود. **خروجی:** فقط تجمیعی — به‌ازای هر جفت اعتبار و ارقام Probe
> کنار تجمیع‌های Suite، و توزیع (تعداد/کمینه/میانه/بیشینه) برای TPS ‏Probe، کمینهٔ TPS بازه، بلندترین وقفه و زمان دیوار Suite؛
> **جفت شکست‌خورده یا اجرانشده از مخرج حذف نمی‌شود** و مقدار ناموجود قطعی `n/a` است. **برچسب‌ها فقط `VALID`/`INVALID`/
> `INCONCLUSIVE`** — هیچ `VALID_CAPABLE`/`VALID_INCAPABLE`، هیچ «کند»، هیچ آستانه/حاشیه/Heuristic؛ جفتی با Probe معتبر و Suite
> شکست‌خورده همچنان `VALID` است. **ایمنی:** طبقه‌بندی محدود خطای زیرساخت (۱۴ دسته + `other`)، و امکان پیشینِ چاپ دنبالهٔ خام
> خروجی `pgbench`/Jest **حذف شد** بی ضعیف کردن `redact`. **«فقط‌گزارش»** یعنی به هیچ دروازه‌ای وصل نیست (`pnpm check:test-phases`
> اکنون این را اجبار می‌کند: `verify`، هر دو Task ‏Workspace، مسیر مستقیم فشار و CI)، **نه** اینکه شکست سبز شود — Probe نامعتبر،
> Suite شکست‌خورده، زیرفرایندِ بالا نیامده یا گزارشِ نوشته‌نشده همگی خروج غیرصفر می‌دهند. **شواهد:**
> `test:aggregation-evidence-lib` ۲۴/۲۴ (۱۲ تازه)، `test:test-phases` ۲۰/۲۰ (۳ تازه)، `check:test-phases` خروج ۰،
> `progress:check` جاری، `format:check` و `git diff --check` تمیز. **کمپین زنده اجرا نشد:** `rasta-postgres` هیچ Port میزبانی
> منتشر نمی‌کند (`5432/tcp` فقط داخل Docker) و `.env` به `localhost:5433` بسته اشاره دارد؛ اجرای Suite روی میزبان به Forwarder
> یا بازپیکربندی نیاز داشت و این Iteration اجازهٔ دست‌زدن به زیرساخت کاربر را نداشت. **هنوز نیست:** مجموعه‌دادهٔ دوطرفه، عدد
> آستانه، حاشیهٔ ایمنی، Classifier توانایی، دروازهٔ Fail-Fast و یکپارچه‌سازی CI. کران ۲۹٫۲ همچنان بی Provenance است و جایگزین
> نشد. `COM-009` همچنان `READY`/۱۳، ADR-053 و ADR-055 همچنان `Proposed`؛ AUD-004 بسته نشد.
>
> **پیگیری 2026-09-15 (انتقال ساخت‌یافتهٔ تشخیص — تعمیر مسیر اجرای واقعی پیش از جمع‌آوری شواهد):** آزمون‌های دستهٔ زیرساخت در
> گام قبل فقط **خالص** بودند و مسیر اجرای واقعی را پوشش نمی‌دادند؛ خودِ Runner دسته‌ای را که ساخته بود از دست می‌داد.
> **بازتولید روی `b3355c4` (پیش از تغییر):** `classifyInfrastructureProblems(['psql exited 1 (connectionFailure)'])` →
> `connectionFailure=0، harnessError=1`؛ همان با `permissionDenied` → `permissionDenied=0، harnessError=1`؛ و
> `['psql exited 127 (other)']` → `dockerUnavailable=0، harnessError=1`. علت: `psql()` دسته را داخل جمله می‌نوشت،
> `summarizeCalibration()` جمله را دوباره طبقه‌بندی می‌کرد، و طبقه‌بندِ نثرمحور نام‌های خودش را نمی‌شناخت ولی `exited 1` را
> می‌شناخت. **پس از تغییر (همان سه مورد، از راه مسیر کامل `psql` → Probe → Summary):** `connectionFailure=1`،
> `permissionDenied=1`، `dockerUnavailable=1` و در هر سه `harnessError=0`، `other=0`. **راه‌حل:** یک واژگان یکتای صادرشده
> (`INFRASTRUCTURE_CATEGORY`) و یک مسیر یکتای نرمال‌سازی/شمارش (`normalizeCategories`/`countCategories`)؛ تثبیت دسته **یک بار**
> همان‌جا که خروجی خام فرزند در دست است (`processDiagnostic`)؛ حذف کاملِ طبقه‌بندِ نثرمحور
> (`classifyInfrastructureProblems` و جدول Regexش). `runBounded` سه پایان را تفکیک می‌کند
> (`launcherFailed`/`completed`/`timedOut`) و `launcher` ثابت (`docker`/`pnpm`/`jest`/`git`) و `tool` درون‌تصویری
> (`psql`/`pgbench`) را نگه می‌دارد **بی** آرگومان، محیط، داده اتصال یا متن خطای سیستم‌عامل؛ کدام ابزار غایب است از **درخواست**
> می‌آید نه از متن. `measureProbe`/`summarizeJestRun` تشخیص‌ها را روی نتیجه می‌چسبانند و `summarizeCalibration` همان‌ها را جمع
> می‌زند. **مرزی که حفظ شد:** Suiteای با گزارش Jest و تستِ شکسته دستهٔ زیرساختی نمی‌گیرد (وگرنه اثبات شکست‌خورده «خطای Harness»
> برچسب می‌خورد). **Control** در یک جمع صریح جداگانه (`controlInfrastructure`) می‌آید، و هر جفتِ تلاش‌شده در مخرج می‌ماند.
> **نشتی‌های بسته‌شده:** مسیر مطلق Launcher ‏Jest در پیام خطا (نام کاربر/ماشین)، پیام خام `topology()` در Artifact، و خروجی خام
> `docker info` در گزارش (اکنون فقط توکن با شکل ثابت)؛ پرتابِ بی‌دسته دسته‌اش را نگه می‌دارد و پیامش را از دست می‌دهد.
> `redact` ضعیف نشد. **قرارداد مجاور:** حذف Script ریشهٔ `calibrate:aggregation-stress` پیش از این **هیچ** مشکلی تولید
> نمی‌کرد (`[]`)؛ حالا رد می‌شود. **شواهد:** `node --test scripts/aggregation-evidence.test.mjs` ۳۲/۳۲ (۹ تازه، خالص ‎+۸ پس از
> جایگزینی آزمون نثرمحور)، `pnpm run test:test-phases` ۲۱/۲۱ (۱ تازه)، `pnpm run check:test-phases` خروج ۰،
> `pnpm run progress:check` خروج ۰، `pnpm lint` و `pnpm typecheck` سبز، `pnpm format:check` تمیز، ESLint مستقیم روی هر
> `scripts/*.mjs` تغییریافته بی رگرسیون (همان ۳۷ خطای `no-undef` پیش‌زمینه‌ای برای Globalهای Node، پیش و پس از تغییر یکسان)،
> `git diff --check` تمیز. **کمپین زنده اجرا نشد** (طبق دستور این Iteration): مسیر تشخیص باید پیش از جمع‌آوری شواهد
> قابل‌اعتماد می‌شد. **هنوز نیست:** مجموعه‌دادهٔ دوطرفه، عدد آستانه، حاشیهٔ ایمنی، Classifier توانایی، دروازهٔ Fail-Fast و
> یکپارچه‌سازی CI؛ کران ۲۹٫۲ همچنان بی Provenance. `COM-009` همچنان `READY`/۱۳، ADR-053 و ADR-055 همچنان `Proposed`؛
> AUD-004 بسته نشد.
>
> **پیگیری همان روز (حالت صریح اعتبار — تفکیک `INCONCLUSIVE` از `INVALID` پیش از هر نمونه):** گام قبلی **دسته** را درست کرد
> ولی **حکم اعتبار** را نه، و آزمونش جملهٔ نادرست «Probeای که نتوانست اندازه بگیرد همچنان `INVALID` است» را تثبیت کرده بود.
> **بازتولید روی `b0cf196` (پیش از تغییر)، از راه `measureProbe()` → `summarizeCalibration()`:** با `result.error` غایب،
> `result.probe.valid = false` و تشخیص `connectionFailure`، نتیجهٔ جفت `INVALID` می‌شد (`{VALID:0, INVALID:1,
INCONCLUSIVE:0}`) — یعنی «سنجیدم و رد شد» برای سروری که هرگز در دسترس نبود. **پس از تغییر:** `probe.outcome` و نتیجهٔ جفت
> `INCONCLUSIVE` (`{VALID:0, INVALID:0, INCONCLUSIVE:1}`). علت: `emptyProbe` فقط `valid: false` می‌داد و
> `summarizeCalibration()` هر `valid === false` را `INVALID` می‌نامید. **راه‌حل:** خودِ نتیجهٔ Probe یک حالت صریح متناهی حمل
> می‌کند (`probe.outcome`، از همان سه برچسب موجود؛ هیچ برچسب توانایی اضافه نشد)، `summarizeCalibration()` آن را **می‌خواند**
> (`probeOutcomeOf`) و دیگر از `problems` یا `valid: false` استنتاج نمی‌کند، و `probe.valid` مشتق است (`true` تنها برای
> `VALID`). نگاشت از یک جدول یکتا می‌آید (`CATEGORY_VALIDITY`، بی هیچ Regex) با تقدم قطعی: **`INCONCLUSIVE`** برای
> `missingEnvironment`، `dockerUnavailable`، `pgbenchUnavailable`، `psqlUnavailable`، `connectionFailure`،
> `statsUnreadable`، `timeout`، `harnessError` و `other`؛ **`INVALID`** برای `permissionDenied`، `statsReset`،
> `failedTransactions`، `controlContamination`، `backgroundWalContamination` و `noProgress`؛ **`VALID`** تنها با نبودِ هر
> تشخیص. **اگر هر دو نوع هم‌زمان باشند `INCONCLUSIVE` برنده است** و ترتیب ورود پاسخ را عوض نمی‌کند. **نقص دومی که در همین
> گام پیدا شد:** وقتی فرایند `pgbench` کامل نمی‌شد، خروجی ناقصش باز هم تجزیه می‌شد و `longest_zero_commit_s = 0` را
> به‌عنوان مشاهده وارد توزیع می‌کرد؛ اکنون در آن حالت دسته‌ها نگه داشته و ارقام دور ریخته می‌شوند. Probeِ اندازه‌نگرفته
> **هیچ عدد ساختگی** ندارد (همه `null`، نه `0`) ولی جفت با `available=0` در مخرج می‌ماند. Control هم حالت صریح گرفت
> (`summary.controlOutcome`)؛ Controlِ اجرانشده `INCONCLUSIVE` است، نه `valid=no`. **حفظ شد:** چسبندگی ساخت‌یافتهٔ دسته‌ها و
> نبودِ بازخوانی نثر (`classifyInfrastructureProblems` بازنگشت)، کران‌های عددی اعتبار، SQL ‏Probe، ثابت‌ها و Selectorهای فشار،
> مجاورت جفت، نبود Retry، دستی‌بودن، قرارداد ایستا و معنای خروج غیرصفر. **شواهد:**
> `node --test scripts/aggregation-evidence.test.mjs` ۳۶/۳۶ (۴ تازه)، `pnpm run test:aggregation-evidence-lib` ۳۶/۳۶،
> `pnpm run test:test-phases` ۲۱/۲۱، `pnpm run check:test-phases` خروج ۰، `pnpm run progress:check` خروج ۰،
> `pnpm lint` و `pnpm typecheck` سبز، `pnpm format:check` تمیز، ESLint مستقیم روی دو فایل تغییریافته بی رگرسیون (همان ۱۳
> خطای `no-undef` پیش‌زمینه‌ای برای `structuredClone`، پیش و پس یکسان)، `git diff --check` تمیز. **کمپین زنده اجرا نشد**
> (طبق دستور). **هنوز نیست:** مجموعه‌دادهٔ دوطرفه، عدد آستانه، حاشیهٔ ایمنی، Classifier توانایی، دروازهٔ Fail-Fast و
> یکپارچه‌سازی CI؛ کران ۲۹٫۲ همچنان بی Provenance. `COM-009` همچنان `READY`/۱۳، ADR-053 و ADR-055 همچنان `Proposed`؛
> AUD-004 بسته نشد.
>
> **پیگیری همان روز (رد پیش‌شرط در سطح کمپین — Artifact برای درخواست معتبر می‌ماند):** گام قبلی معنای `INCONCLUSIVE` را در
> Helperها درست کرد ولی **مسیر واقعی CLI** هرگز به آن نمی‌رسید. **بازتولید روی `5e51889` (پیش از تغییر):**
> `node scripts/aggregation-evidence.mjs --calibrate --pairs 2 <مسیر>` با محیط ناقص → `[evidence] environment:
missingEnvironment=1`، **`exit=2` و هیچ Artifactی** — پس مسیر گزارشِ درخواست‌شده نوشته نمی‌شد، Control و جفت‌ها نتیجهٔ صریح
> نمی‌گرفتند و Artifact واقعی نه مخرج داشت نه جمع دسته. شکست پیش از اجرا در `jestBin()` هم همین‌طور. **پس از تغییر، همان
> فراخوانی:** `exit=2` (همچنان غیرصفر) و Artifact **نوشته می‌شود** با `control: not run, outcome=INCONCLUSIVE`،
> `pair-1`/`pair-2: outcome=INCONCLUSIVE` با `probe: not run` و `stress: not run`، `outcomes: VALID=0 INVALID=0
INCONCLUSIVE=2`، `probe_tps: n=2 available=0 unavailable=2 min=n/a median=n/a max=n/a` (هر چهار توزیع)،
> `topology: measured=no`، `preflight infrastructure totals (campaign scope, denominator=1 campaign): missingEnvironment=1`
> و `infrastructure totals across pairs: missingEnvironment=0`. **راه‌حل:** رد پیش‌شرط رویدادی در **سطح کمپین** است و صریح
> مدل می‌شود — `campaignPreflight()` هر دو پیش‌شرط را جمع می‌کند (نام‌های غایب محیط از `missingCampaignEnv()`، و Launcher
> ‏jest) و هیچ **مقدار** محیطی نمی‌خواند؛ جمع دسته‌اش دامنهٔ یک کمپین دارد و در سطر جفت‌ها کپی نمی‌شود (کپی کردنش شکست‌هایی
> می‌ساخت که رخ نداده‌اند). گزارش چهار دامنهٔ متمایز نگه می‌دارد: Preflight کمپین، Control، جمع جفت‌ها و Suite فشار.
> **مرز آزمون‌پذیری:** `runEvidenceCli({ argv, env, deps })` صادر شد و نقطهٔ ورود **محافظت‌شده** است، پس Import کردن ماژول
> چیزی را علیه زیرساخت اجرا نمی‌کند؛ وابستگی‌های تزریق‌شده `resolveJestBin`/`writeReport`/`readCommit`/`now`/`log`/
> `measureCampaign` و آزمون‌ها ثابت می‌کنند نیمهٔ اندازه‌گیر در مسیر رد **صدا زده نمی‌شود**. **حفظ شد:** واژگان یکتای دسته،
> مسیر یکتای نرمال‌سازی/شمارش، حالت صریح Probe، تقدم `INCONCLUSIVE`، `null` بودن ارقام غایب، خروجی فقط‌تجمیعی و بی‌راز،
> نبود Retry، مجاورت جفت، ثابت‌ها و SQL فشار، قرارداد ایستا و دستی‌ماندن کمپین؛ آرگومان بدشکل یا نبودِ مسیر گزارش همچنان
> Usage و خروج ۲ بی Artifact است، و حالت `evidence` قدیمی و Schema گزارشش دست نخورد. شکست نوشتن گزارش غیرصفر می‌ماند و فقط
> یک `code` با شکل ثابت چاپ می‌کند (هر چیز دیگر → `error`). **شواهد:**
> `node --test scripts/aggregation-evidence-cli.test.mjs` ۶/۶، `node --test scripts/aggregation-evidence.test.mjs` ۳۶/۳۶
> (بی تغییر)، `pnpm run test:aggregation-evidence-lib` ۴۲/۴۲، `pnpm run test:test-phases` ۲۱/۲۱،
> `pnpm run check:test-phases` خروج ۰، `pnpm run progress:check` خروج ۰، `pnpm lint` و `pnpm typecheck` سبز،
> `pnpm format:check` تمیز، ESLint مستقیم روی Scriptهای ریشهٔ تغییریافته بی رگرسیون نسبت به `5e51889` (همان
> `no-undef` پیش‌زمینه‌ای `structuredClone`)، `git diff --check` تمیز. **کمپین زنده اجرا نشد** و هیچ نمونه‌ای جمع نشد.
> **هنوز نیست:** مجموعه‌دادهٔ دوطرفه، عدد آستانه، حاشیهٔ ایمنی، Classifier توانایی، Preflight در `run-test-phases.mjs`،
> دروازهٔ Fail-Fast و یکپارچه‌سازی CI؛ کران ۲۹٫۲ همچنان بی Provenance. `COM-009` همچنان `READY`/۱۳، ADR-053 و ADR-055
> همچنان `Proposed`؛ AUD-004 بسته نشد.
>
> **پیگیری همان روز (کامل شدن مرز رد پیش از اندازه‌گیری — و تصحیح ادعای بند بالا):** بند بالا نوشت «هر درخواست
> کالیبراسیونِ معتبر با مسیر نوشتنی همیشه پاسخ می‌گیرد»؛ آن **ادعا بزرگ‌تر از کار بود**. فقط دو علت پوشش داده شده بود
> (نام‌های غایب محیط، Launcher ‏jest). سه مسیر دیگر هنوز پیش از هر اندازه‌گیری و **بی Artifact** رد می‌کردند: خواندن
> Spec فشار و ساخت Plan (پرتاب به `catch` بالایی)، قرارداد ایستا (`return 1` بی `saveReport()`) و ساخت پوشهٔ موقت.
> **بازتولید روی `5e949a3`** (Runner همان Commit در کپی خارج از Repository، محیط کامل، `resolveJestBin` تزریق‌شده تا
> علت فقط خواندن Spec باشد): `THREW=yes`، `EXIT=1`، `ARTIFACT=none`. **پس از تغییر، همان ورودی:** `EXIT=2`،
> `ARTIFACT=written`، `pairs: 2 requested, 0 attempted`، `control: not run, outcome=INCONCLUSIVE`،
> `pair-1`/`pair-2: outcome=INCONCLUSIVE`، `outcomes: VALID=0 INVALID=0 INCONCLUSIVE=2`،
> `probe_tps: n=2 available=0 unavailable=2 min=n/a median=n/a max=n/a`، و `harnessError` برابر **۱** در جمع
> سطح‌کمپین و **۰** در جمع جفت‌ها و Control. **رد قرارداد ایستا** هم همین‌طور: `EXIT=1` (همان کدی که بررسی قرارداد
> همیشه برمی‌گرداند)، Artifact نوشته می‌شود، `harnessError` کمپین ۱ و جفت/Control ۰. **راه‌حل:** `prepareCampaign()`
> در یک گذر محیط، Launcher، Spec، Plan، قرارداد و در **آخر** پوشهٔ موقت را می‌سنجد و یا **Planِ اعتبارسنجی‌شده** را
> برمی‌گرداند یا تشخیص‌های سطح‌کمپین را؛ `runMeasuredCampaign()` همان Plan را می‌گیرد و **قرارداد را دوباره نمی‌سنجد**
> (دقیقاً یک بار)، و نخستین دستورش نخستین اندازه‌گیری است — پس نیمهٔ اندازه‌گیر پس از هر رد **دست‌نیافتنی** است و
> `catch` بالایی فقط شکستِ حین اندازه‌گیری را می‌پوشاند. پوشهٔ موقت آخر ساخته و در `finally` پس از موفقیت و شکست آزاد
> می‌شود. **یک کمپینِ رد شده یک رویداد است:** چند Finding قرارداد **یک** `harnessError` می‌شود، با نقل‌قول کراندار
> (≤۵ Finding، ≤۲۰۰ نویسه) از جمله‌های ثابت خود Repository و عبور از `redact` — بی محتوای Spec، بی مسیر، بی متن
> استثنا. **حفظ شد:** معنای آرگومان بدشکل (Usage + ۲ بی Artifact)، حالت `evidence` قدیمی و Schema گزارشش، واژگان یکتای
> دسته، مسیر یکتای نرمال‌سازی/شمارش، `INCONCLUSIVE` برای هر علت آماده‌سازی، مجاورت دقیق جفت‌ها، نبود Retry، SQL و
> ثابت‌های فشار و دستی‌ماندن کمپین. **شواهد:** `node --test scripts/aggregation-evidence-cli.test.mjs` ۱۳/۱۳،
> `node --test scripts/aggregation-evidence.test.mjs` ۳۶/۳۶ (بی تغییر)، `pnpm run test:aggregation-evidence-lib`
> ۴۹/۴۹، `pnpm run test:test-phases` ۲۱/۲۱، `pnpm run check:test-phases` خروج ۰، `pnpm run progress:check` خروج ۰،
> `pnpm lint` و `pnpm typecheck` سبز، `pnpm format:check` تمیز، ESLint مستقیم روی Scriptهای تغییریافته بی رگرسیون
> نسبت به `5e949a3` (همان `no-undef` پیش‌زمینه‌ای روی Globalهای Node)، `git diff --check` تمیز. **کمپین زنده اجرا نشد
> و هیچ نمونه‌ای جمع نشد.** **هنوز نیست:** مجموعه‌دادهٔ دوطرفه، عدد آستانه، حاشیهٔ ایمنی، Classifier توانایی،
> Preflight فاز، دروازهٔ Fail-Fast و یکپارچه‌سازی CI؛ کران ۲۹٫۲ همچنان بی Provenance. `COM-009` همچنان `READY`/۱۳،
> ADR-053 و ADR-055 همچنان `Proposed`؛ AUD-004 بسته نشد.
>
> **پیگیری همان روز (نخستین مجموعهٔ جفت‌شدهٔ آرام — ۲۰ نمونه، و هنوز یک‌طرفه):** همهٔ گام‌های بالا ابزار ساختند؛ این
> نخستین گامی است که **نمونه جمع کرد**. **محلی جمع نشد و نباید می‌شد:** Daemon ‏Docker این میزبان خاموش است و Stack
> ‏Compose موجود `rasta` شانزده سرویس با `restart: unless-stopped` دارد، پس روشن کردن Daemon `rasta-postgres` و
> همسایه‌هایش را دوباره راه می‌انداخت؛ و اندازه‌گیری نرخ Commit کنار Kafka/Keycloak/Temporalِ زنده روی یک VM و یک دیسک
> مجازی آرام نیست (۱۴٫۶–۲۳٫۰ روی Volume مشترک در برابر ۲۶٫۰–۲۶٫۶ روی نمونهٔ یک‌بارمصرف، همان Probe). **Docker محلی،
> PostgreSQL بومی میزبان و هیچ Container/Network/Volume کاربر لمس نشد.** به‌جایش یک **Workflow موقت و فقط‌شاخه‌ای**
> (`aggregation-stress-calibration.yml`، Trigger فقط `push` روی همین شاخه، `contents: read`،
> `cancel-in-progress: false`، SHAهای Pinشدهٔ همان CI، Node 22 / pnpm 11.22.0) روی Runner **بومی Ubuntu** با **دقیقاً
> یک** Service Container ‏(`postgis/postgis:16-3.4`، بی Kafka، Redis، Keycloak، Temporal، MinIO یا هر سرویس برنامه،
> Credential یک‌بارمصرف CI-only) یک کمپین ۲۰ جفتی گرفت و **در همان تکرار حذف شد** — درخت شاخه هیچ Trigger کالیبراسیونی
> ندارد و `ci.yml`، فازهای تست، `pnpm verify` و Harness دست نخوردند. **مبدأ:** Commit
> ‏`89ebe9943ba9a29d6a7e67beadec8192d14060d5`، اجرای `34989897833` (تلاش ۱، `success`)، گام کمپین
> ‏`2026-09-15T15:40:36Z`→`16:20:14Z` یعنی **۳۹ دقیقه و ۳۸ ثانیه**، خروج **۰**. **محیط:** `Ubuntu 24.04.5 LTS`،
> ‏`ubuntu24/20260907.300.1`، Kernel `6.17.0-1022-azure`، ۴ CPU، ۱۵٫۶GiB، `overlay2`، PostgreSQL ۱۶٫۴، `fsync=on`،
> ‏`synchronous_commit=on`، `wal_level=replica`، `wal_sync_method=fdatasync`، `full_page_writes=on`،
> ‏`shared_buffers=128MB`، `max_connections=100`، `max_wal_size=1GB`، `checkpoint_timeout=5min`. **نتیجه**
> (`docs/evidence/adr-055/quiet-calibration-github-2026-09-15.txt`، بایت‌به‌بایت و دست‌نخورده): `VALID=20`،
> `INVALID=0`، `INCONCLUSIVE=0`؛ Control ‏`VALID`؛ Suite فشار **۲۰/۲۰ گذشته** با ۱/۱ Suite و ۲۲/۲۲ تست و خروج ۰ در هر
> جفت؛ `probe_tps` کمینه **۲٬۴۹۴٫۸** میانه **۳٬۲۶۸٫۲۳** بیشینه **۳٬۷۹۷٫۵۱**؛ `probe_min_interval_tps` **۴۰۵** /
> **۱٬۰۱۳٫۹۵** / **۲٬۱۷۴٫۳**؛ `probe_longest_stall_s` کمینه و میانه و بیشینه همگی **۰**؛ `stress_wall_s` **۲۰٫۴۱** /
> **۵۷٫۶۴** / **۵۹٫۷۸**؛ و **۰** تشخیص زیرساختی در هر چهار دامنه (Preflight کمپین، Control، جفت‌ها، Suite). **پیش از
> ورود به Git، ۴۸ بررسی مستقل:** واژگان فقط سه‌تایی، دقیقاً ۲۰ سطر با شناسهٔ ۱..۲۰ هرکدام یک بار، مجاورت Probe→Stress،
> تطابق جمع نتیجه‌ها و جمع Suite و هر چهار توزیعِ **بازمحاسبه‌شده از سطرها**، جدایی چهار دامنه، و نبود
> URL/Credential/Token/مسیر مطلق/نام کاربر یا میزبان/IP/متن خام استثنا/ردیف/شناسهٔ تست. **یک محدودیت که پنهان نمی‌شود:**
> شبکهٔ این میزبان `*.blob.core.windows.net` را مسدود می‌کند (DNS به `10.10.34.35` و Timeout؛ اتصال مستقیم به IP عمومی
> با شکست TLS)، پس `gh run download` ممکن نشد و متن از **Log همان اجرا** استخراج شد — همان رشته‌ای که Harness پیش از
> نوشتن فایل چاپ می‌کند (`log('\n' + text)` و سپس `saveReport(..., text)`) — تنها با حذف پیشوند زمانی GitHub؛ فایل بی
> CR، بی فضای انتهایی، با یک `\n` پایانی و **بی هیچ دست‌کاری عددی**. **چرا هنوز آستانه نمی‌دهد:** این توزیع محیطی را
> نشان می‌دهد که اثبات در آن همیشه و با فاصله گذشته — کمترین `probe_tps` هنوز ۲٬۴۹۴٫۸ و هیچ جفت هیچ وقفه‌ای نداشته — پس
> فقط می‌گوید مرز «خیلی پایین‌تر» است، همان‌طور که § ۶ دربارهٔ ۴٬۵۶۴–۴٬۶۲۲ گفته بود. **هنوز نیست:** نمونهٔ شکستِ ناشی از
> محیط (نیمهٔ دوم و تعیین‌کننده)، عدد آستانه، حاشیهٔ ایمنی، Classifier توانایی، Preflight فاز، دروازهٔ Fail-Fast و
> یکپارچه‌سازی CI؛ کران ۲۹٫۲ همچنان بی Provenance. `COM-009` همچنان `READY`/۱۳، ADR-053 و ADR-055 همچنان `Proposed`؛
> AUD-004 بسته نشد.
>
> **پیگیری همان روز (نخستین تلاش القایی برای سمت شکست — ناتمام، با مسدودکنندهٔ مشخص):** نیمهٔ دومِ تعیین‌کنندهٔ
> مجموعه‌دادهٔ ADR-055 § ۶ تلاش شد و **جمع نشد**؛ این ورودی، تلاش و مسدودکننده‌اش را ثبت می‌کند، نه داده. یک Workflow
> موقت و فقط‌شاخه‌ای (`aggregation-stress-induced-calibration.yml`، Trigger فقط `push` روی همین شاخه، `contents: read`،
> `cancel-in-progress: false`، SHAهای Pinشدهٔ همان CI، Node 22 / pnpm 11.22.0، مهلت Job ‏۱۸۰ دقیقه) روی Commit
> ‏`9b03ac0ddcaa7e16f442e3cad6e679e601a9af5d` همان توپولوژی کمپین آرام را برداشت: Runner **بومی Ubuntu** یک‌بارمصرف،
> **دقیقاً یک** Service Container ‏`postgis/postgis:16-3.4`، بی Kafka/Redis/Keycloak/Temporal/MinIO و بی سرویس برنامه،
> Credential یک‌بارمصرف Job-local. **شرط القایی:** پس از Provisioning و Migration، همان یک Container با فیلتر دقیق
> تصویر پیدا شد (تعداد ≠ ۱ یعنی رد پیش از هر اندازه‌گیری) و یک **سهمیهٔ CFS ثابت و بیرونی** با `docker update` روی آن
> اعمال شد: `CPU_PERIOD_US=1000000`، `CPU_QUOTA_US=5000` — **۰٫۰۰۵ CPU** — و با یک `docker inspect --format`
> دو‌فیلدی بازخوانده و **دقیقاً** تأیید شد (`applied_cpu_period_us=1000000`، `applied_cpu_quota_us=5000`؛ شناسهٔ
> Container هرگز چاپ نشد). نه بار SQL، نه بار جانبی دوم، نه WAL پس‌زمینه، نه Pause/Kill، نه تغییر تنظیم PostgreSQL، و
> بدون هیچ تغییری در Spec فشار، SQL ‏Probe، `PROBE_VALIDITY`، Selectorها، Timeoutها، تعداد Lane/نوشتن یا Harness.
> **Docker محلی، PostgreSQL بومی میزبان و هیچ Container/Network/Volume کاربر لمس نشد** — هم Runner و هم Container
> محدودشده با همان یک اجرا ساخته و نابود شدند. **نتیجه:** اجرای `34997524401` (تلاش ۱، نتیجه `cancelled`) — گام‌های
> ۱..۱۲ همگی `success` (از جمله اعمال و تأیید سهمیه)، گام کمپین `2026-09-15T16:51:55Z` → `2026-09-15T19:51:01Z` یعنی
> **۲ ساعت و ۵۹ دقیقه و ۶ ثانیه** و کشته‌شده با **مهلت ۱۸۰ دقیقه‌ای Job**؛ گام Upload سپس با
> `if-no-files-found: error` شکست خورد چون **فایلی نوشته نشده بود**. `campaign_exit` هرگز چاپ نشد. **هیچ Artifact‌ی
> تولید، دانلود، اعتبارسنجی یا Commit نشد.** **تا کجا رسید:** Control ‏`PASS` (۱۴ ثانیه) و `pair-1-probe` ‏**`PASS`**
> (‏`16:52:11Z`→`16:53:18Z`، ۶۷ ثانیه) — یعنی **Probe زیر ۰٫۰۰۵ CPU همچنان معتبر ماند** — سپس `pair-1-stress` از
> ‏`16:53:18Z` **۲ ساعت و ۵۷ دقیقه و ۴۳ ثانیه هیچ خروجی نداد**. **دو مسدودکنندهٔ مستقل:** (۱) یک اجرای دست‌نخوردهٔ
> Suite زیر این سهمیه از کران ۳۰ دقیقه‌ای خودِ Harness می‌گذرد — ۲۲ تست با `testTimeout` پیش‌فرض ۶۰ ثانیه و
> Overrideهای ۱۵s تا ۱۲۰s، روی پایگاه داده‌ای که ۵ms CPU در هر ثانیه می‌گیرد — پس ۲۰ جفت در ۱۸۰ دقیقه جا نمی‌شود؛ و (۲) آن کران در عمل خاتمه **نمی‌دهد**:
> `runBounded` در `scripts/aggregation-evidence.mjs` فقط `child.kill('SIGKILL')` روی خودِ `pnpm` می‌زند، نوه‌ها
> (`turbo`، `jest` و Workerهایش) همان `stdout`/`stderr` را به ارث برده و زنده می‌مانند، و رویداد `close` — که Promise
> فقط با آن حل می‌شود — هرگز نمی‌آید؛ پس کران **بی‌صدا** از کار می‌افتد. این نقص در کمپین آرام پنهان بود چون بیشینهٔ
> ‏`stress_wall_s` آنجا ۵۹٫۷۸ ثانیه بود. **Harness در این گام عمداً درست نشد** (دامنهٔ این گام فقط جمع‌آوری شواهد بود)؛
> اصلاح کران — خاتمهٔ کل Process Group و نبستن Promise به `close` — گامی **جدا** و **پیش‌شرط هر کمپین القایی بعدی**
> است. **شمار جفت‌های `VALID` با Suite شکست‌خورده: صفر.** Workflow موقت **در همان تکرار حذف شد** و درخت شاخه فقط
> `ci.yml` دارد. **هنوز نیست:** نمونهٔ شکستِ ناشی از محیط (الزام سمت شکستِ § ۶ **برآورده نشد**)، عدد آستانه، حاشیهٔ
> ایمنی، Classifier توانایی، Preflight فاز، دروازهٔ Fail-Fast و یکپارچه‌سازی CI؛ کران ۲۹٫۲ همچنان بی Provenance.
> `COM-009` همچنان `READY`/۱۳، ADR-053 و ADR-055 همچنان `Proposed`؛ AUD-004 بسته نشد.
>
> **پیگیری همان روز — کران فرایندِ Harness رفع و Regression-Test شد:** فقط مسدودکنندهٔ (۲) بالا بسته شد و تنها
> `runBounded` و مسیر Cleanup در `scripts/aggregation-evidence.mjs` عوض شدند. (الف) **کران درخت را می‌کشد، نه فرزند
> را:** هر Launcher روی POSIX با `detached: true` آغاز می‌شود و کران/Cleanup با `process.kill(-pid, 'SIGKILL')` کل
> Process Group را سیگنال می‌دهند؛ PID پیش از سیگنالِ گروه باید عدد صحیح **مثبت** باشد، و در شکست سیگنالِ گروه — یا
> روی Windows که Process Group قابل‌سیگنال ندارد — همان `child.kill('SIGKILL')` Fallback می‌ماند. خاتمه Idempotent و
> Race-Safe است: گروهِ پیش‌تر تمام‌شده حالت عادی است، چیزی Throw نمی‌شود، نتیجهٔ ثبت‌شده بازنویسی نمی‌شود و هیچ
> errno/PID/آرگومان/خروجی‌ای در Log یا گزارش نمی‌آید. (ب) **پایان کار به `exit` بسته است، نه `close`:** پس از `exit`
> حداکثر یک مهلت نام‌دار `PIPE_DRAIN_MS = 2000` به خروجیِ در راه داده می‌شود؛ `close` داخل آن مهلت نتیجه را بی‌درنگ و
> با کل دنباله نهایی می‌کند و در نبودش Pipeها تخریب و نتیجه به‌هرحال نهایی می‌شود. Timeout همان `outcome: timedOut`،
> `timedOut: true`، کد خروج ناموفق در نبود کد عددی و زمان‌های دقیق را می‌دهد؛ `launcherFailed` و خروج عادی معنای
> قبلی‌شان را دارند و **قالب گزارش تغییر نکرد**. (ج) **دقیقاً یک‌بار Settle** — `close` پس از Timeout یا پس از خطای
> Launcher چیزی را عوض نمی‌کند؛ همهٔ Timer/Listenerها هنگام نهایی‌شدن پاک می‌شوند. Cleanup سیگنالی
> (`SIGINT`/`SIGTERM`) و پایانی از همان Helper استفاده می‌کنند، پس `turbo`/Jest/Worker/`psql`/`pgbench` پشت سر
> نمی‌مانند؛ حذف Container و دایرکتوری موقت دست نخورد. **اثبات:** سه Regression در
> `scripts/aggregation-evidence-cli.test.mjs` با **درخت فرایند واقعی** Node (نه Mock) و نوهٔ وارثِ `stdout`/`stderr`،
> بدون Docker/PostgreSQL/شبکه/`.env`/Credential و بدون چاپ PID یا خروجی. Assertion خاتمهٔ Process Group روی Windows
> صریحاً رد می‌شود؛ اعتبارش از اجرای CI معمول روی Ubuntu بومی می‌آید. **هیچ کمپینی اجرا نشد، هیچ Workflow موقتی ساخته
> نشد، هیچ Artifact شواهدی لمس نشد.** مسدودکنندهٔ (۱) — شدت سهمیهٔ ۰٫۰۰۵ CPU برای ۲۰ جفت — **همچنان باز** است، سمت
> شکست § ۶ همچنان **برآورده نشده**، و هیچ آستانه/حاشیه/Classifier/Preflight/دروازه/Bypass/Retry/Skip-Green یا
> یکپارچه‌سازی CI اضافه نشد. `COM-009` همچنان `READY`/۱۳، ADR-053 و ADR-055 همچنان `Proposed`؛ AUD-004 باز است.
>
> **پیگیری همان روز — یک مشاهدهٔ هزینه زیر ۰٫۰۵ CPU؛ Suite گذشت، پس شرط بی‌فایده بود:** برای بستن مسدودکنندهٔ
> (۱) هزینهٔ **یک** اجرای دست‌نخوردهٔ Suite زیر یک شرط محدودکننده برای نخستین بار اندازه گرفته شد. **این شواهد
> § ۶ نیست** — نه نمونه، نه جفت، نه توزیع، نه سمت شکست؛ و Artifact در نخستین سطرش همین را می‌گوید. Workflow موقت
> و فقط‌شاخه‌ای `aggregation-stress-cost-observation.yml` (Trigger فقط `push` روی همین شاخه، `contents: read`،
> `cancel-in-progress: false`، SHAهای Pinشدهٔ همان CI، Node 22 / pnpm 11.22.0، مهلت Job ‏۶۰ دقیقه) روی Commit
> ‏`62062f3e861ab63408e1766251d153d51ecb7761`؛ اجرای `35026098062` (تلاش ۱، Workflow و Job هر دو `success`،
> ‏`21:31:28Z`→`21:34:28Z`). توپولوژی همان کمپین آرام: Runner **بومی Ubuntu** یک‌بارمصرف، **دقیقاً یک** Service
> Container ‏`postgis/postgis:16-3.4`، بی Kafka/Redis/Keycloak/Temporal/MinIO و بی سرویس برنامه، Credential
> یک‌بارمصرف Job-local. **شرط:** پس از Provisioning، Build و Migration همان یک Container با فیلتر دقیق تصویر پیدا
> شد (تعداد ≠ ۱ یعنی رد پیش از هر اندازه‌گیری) و سهمیهٔ CFS ثابت `CPU_PERIOD_US=1000000` /
> `CPU_QUOTA_US=50000` — **۰٫۰۵ CPU**، عمداً **ده برابر سست‌تر** از شرط ناکارآمد ۰٫۰۰۵ — با `docker update`
> (خروجی ساکت) اعمال و با `docker inspect --format` دو‌فیلدی **دقیقاً** تأیید شد
> (`applied_cpu_period_us=1000000`، `applied_cpu_quota_us=50000`؛ شناسهٔ Container هرگز چاپ نشد). نه بار SQL، نه
> بار جانبی، نه WAL پس‌زمینه، نه Pause/Kill، نه تغییر تنظیم PostgreSQL، و بدون تغییر شرط در طول مشاهده. **هیچ
> Docker، PostgreSQL، Container، Network یا Volume محلی/کاربر لمس نشد.** **چه اجرا شد:** پیش از سهمیه
> `test:aggregation-evidence-lib` (**۵۲ گذشته / ۰ شکست** روی Ubuntu بومی — یعنی نیمهٔ POSIX سه Regression کران
> فرایند اینجا واقعاً اجرا شد) و `check:test-phases`؛ پس از تأیید سهمیه **دقیقاً یک** فرایند تازهٔ بی‌فیلتر
> `pnpm run test:aggregation-stress` از راه همان `runBounded` صادرشدهٔ رفع‌شده با `LAUNCHER.pnpm` و کران سخت ۳۰
> دقیقه‌ای روی **کل درخت فرایند** — بی Probe، بی Control، بی جفت، بی Retry، بی سهمیهٔ دوم و بدون تکرار یا تضعیف
> منطق Process Group در Shell؛ Wrapper کوچکِ صداکنندهٔ `runBounded` در دایرکتوری موقت Runner ساخته شد و هیچ
> باقی‌مانده‌ای در Repository نگذاشت. **نتیجه
> ([`docs/evidence/adr-055/aggregation-stress-cost-observation-github-2026-09-16.txt`](docs/evidence/adr-055/aggregation-stress-cost-observation-github-2026-09-16.txt)،
> ۱۶ سطر، ۱۸۴۴ بایت، بی CR، با یک `
` پایانی):** `outcome=completed`، `timed_out=no`، `exit_status=0`، زمان دیوار
> `21:32:54.790Z`→`21:34:22.765Z` = **۸۸٫۰ ثانیه** (کران ۱۸۰۰ ثانیه)، **۱/۰/۰/۱** Suite و **۲۲/۰/۰/۲۲** تست، و
> هر هفت دستهٔ شکست و هر پانزده دستهٔ تشخیص زیرساختی **صفر**. **یعنی ۰٫۰۵ CPU شرط مفیدی برای سمت شکست نیست:**
> اثبات دست‌نخورده زیر آن **کامل گذشت**. مقایسهٔ محتاطانهٔ **یک نمونه** با توزیع بیست‌نمونه‌ایِ کمپین آرام — ۸۸٫۰
> در برابر میانهٔ ۵۷٫۶۴ (کمینه ۲۰٫۴۱، بیشینه ۵۹٫۷۸) روی چهار CPU بی‌قید — یعنی حدود **۱٫۵ برابر** کندتر در ازای
> سهمیه‌ای ~**۱/۸۰** آن CPU؛ برداشت محتمل، کران‌داری با **تأخیر و سریال‌شدن** (یک ردیف داغ، `--runInBand`،
> `fsync=on`/`synchronous_commit=on`) است نه توان CPU پایگاه داده — ولی این برداشت از **یک** نقطه است و به‌عنوان
> داده پذیرفته نمی‌شود. **تنها دستاورد قابل استناد: جست‌وجو کراندار شد** — شرطی که هم شکست بدهد و هم داخل کران
> تمام شود میان ۰٫۰۰۵ (در ۱۷۷ دقیقه تمام نشد) و ۰٫۰۵ (در ۸۸ ثانیه گذشت) است. **گام بعدی پیشنهادی باز هم یک
> مشاهدهٔ تکی است، نه کمپین:** همان طراحی، همان یک فرایند، همان کران ۳۰ دقیقه و مهلت ۶۰ دقیقه، با
> `CPU_PERIOD_US=1000000` و **`CPU_QUOTA_US=15000`** (**۰٫۰۱۵ CPU**) — نصف‌سازی لگاریتمی بازه، چون میانگین هندسی
> ۰٫۰۰۵ و ۰٫۰۵ برابر ۰٫۰۱۵۸ است و رفتار میان دو سر آشکارا خطی نیست. سقف زمانی یک اجرای کاملاً Timeout-خورده،
> بازمحاسبه از خودِ Spec: ۲۲ تست = ۱۵ `it` + ۷ ردیف `it.each`، `testTimeout` پیش‌فرض ۶۰ ثانیه با چهار Override
> صریح (سه × ۱۲۰، یک × ۹۰)، یعنی ۱۸×۶۰ + ۳×۱۲۰ + ۱×۹۰ = ۱۵۳۰ ثانیه، به‌علاوهٔ `beforeAll`/`afterAll` هرکدام ۶۰
> ثانیه = **۱۶۵۰ ثانیه (۲۷ دقیقه و ۳۰ ثانیه)** — زیر کران ۳۰ دقیقه ولی تنها با ۱۵۰ ثانیه حاشیه و بدون حساب کار
> معلقی که پس از شلیک Timeout زنده می‌ماند. **هیچ پارامتر کمپینی (سهمیهٔ نهایی، تعداد جفت، کران گام، مهلت Job)
> انتخاب نشد** و هیچ کمپین جفت‌شده‌ای اجرا نشد. **یادداشت نام فایل:** نام Artifact را Prompt با تاریخ `2026-09-16`
> تعیین کرد و همان ماند؛ زمان دقیق اجرا `2026-09-15T21:34Z` (UTC) است و **داخل خودِ فایل** ثبت شده. **محدودیت
> شناخته‌شده که پنهان نمی‌شود:** این میزبان `*.blob.core.windows.net` را مسدود می‌کند (DNS به `10.10.34.35`
> می‌رسد و Timeout می‌شود)، پس نه `gh run download` و نه دانلود Log از راه API ممکن نبود؛ متن **از Log همان اجرا**
> با `gh run view --job … --log` استخراج شد — دقیقاً همان رشته‌ای که Wrapper پیش از نوشتن فایل چاپ می‌کند (یک
> متغیر، `writeFileSync` سپس `process.stdout.write`) — تنها با حذف پیشوند Job/Step/زمان خودِ GitHub. **هیچ عددی
> دست‌کاری نشد**؛ Upload با `if-no-files-found: error` موفق شد، پس فایل روی Runner واقعاً وجود داشت. Artifact
> اعتبارسنجی شد: بی CR، بی فضای انتهایی، یک `
` پایانی، واژگان ثابت، بازمحاسبهٔ ۸۷٫۹۷۵ ثانیه ← ۸۸٫۰، جمع
> Suite/تست سازگار، سهمیهٔ درخواستی = تأییدشده، و بی URL، Credential، رشتهٔ اتصال، Token، مسیر مطلق، شناسه/نام
> Container، PID، عنوان تست، استثنای خام یا خروجی خام زیرفرایند. **Workflow موقت بلافاصله پس از همان یک اجرا حذف
> شد؛ درخت شاخه دوباره فقط `.github/workflows/ci.yml` دارد.** **هنوز نیست:** نمونهٔ شکستِ ناشی از محیط (الزام سمت
> شکستِ § ۶ **برآورده نشد**)، عدد آستانه، حاشیهٔ ایمنی، Classifier توانایی، Preflight فاز، دروازهٔ Fail-Fast و
> یکپارچه‌سازی CI؛ کران ۲۹٫۲ همچنان بی Provenance. `COM-009` همچنان `READY`/۱۳، ADR-053 و ADR-055 همچنان
> `Proposed`؛ AUD-004 باز است.
>
> **به‌روزرسانی 2026-09-16 — مشاهدهٔ دوم و تنگ‌تر زیر ۰٫۰۱۵ CPU؛ Suite شکست خورد و داخل کران تمام شد:** بازه
> با دو سر بی‌استفاده باز مانده بود (۰٫۰۰۵ در ۱۷۷ دقیقه تمام نشد، ۰٫۰۵ کامل گذشت)، پس یک‌بار **لگاریتمی** نصف
> شد: √(۰٫۰۰۵ × ۰٫۰۵) = ۰٫۰۱۵۸ ← `CPU_PERIOD_US=1000000` / `CPU_QUOTA_US=15000`، یعنی **۰٫۰۱۵ CPU**.
> نصف‌سازی خطی عمداً رد شد، چون دو سر بازه در سهمیه ده برابر فاصله دارند ولی در نتیجه بیش از دو مرتبهٔ بزرگی.
> **این هم شواهد § ۶ نیست** — یک نمونه، بی Probe، بی Control، بی جفت، بی توزیع؛ و **Artifact آن مسیر جداگانه
> دارد، پس Artifact ۰٫۰۵ بازنویسی نشد**. Workflow موقت و فقط‌شاخه‌ای `aggregation-stress-cost-observation.yml`،
> **مشتق از همان Workflow بازبینی‌شدهٔ `62062f3`** با تنها چهار تفاوت (سهمیه، نام Artifact، گروه Concurrency، نام
> Job) — همان SHAهای Pinشده، Node 22 / pnpm 11.22.0، Runner **بومی Ubuntu** یک‌بارمصرف، **دقیقاً یک** Service
> Container ‏`postgis/postgis:16-3.4`، Credential یک‌بارمصرف Job-local، همان Provisioning/Build/Migration، همان
> تفکیک دقیق تصویر با رد پیش از اندازه‌گیری، همان Provenance باریک پیش از سهمیه، همان کران ۳۰ دقیقه‌ای روی کل
> درخت فرایند از راه `runBounded` صادرشده با `LAUNCHER.pnpm`، همان مهلت Job ۶۰ دقیقه، همان پالایش Artifact و
> Allow-List که به‌جای حذف بی‌صدا **رد** می‌کند، و همان Upload با `always()` و `if-no-files-found: error`. روی
> Commit ‏`59419439fe486ddabd4a2199365d573db98a9eea`؛ اجرای `35045042687` (تلاش ۱، رویداد `push`، Workflow و Job
> هر دو `failure` — **که همان نتیجهٔ اندازه‌گیری است، نه خطای Setup**)، `01:41:01Z`→`01:44:41Z`. **گام‌ها:**
> ۱..۱۳ همگی `success`، شامل `test:aggregation-evidence-lib` (**۵۲ گذشته / ۰ شکست** روی Ubuntu بومی) و
> `check:test-phases` **پیش از** سهمیه، و اعمال/تأیید دقیق سهمیه (`applied_cpu_period_us=1000000`،
> `applied_cpu_quota_us=15000`؛ شناسهٔ Container هرگز چاپ نشد)؛ گام ۱۴ (اندازه‌گیری) `failure`
> `01:42:02Z`→`01:44:35Z`؛ گام ۱۵ (Upload) `success`. **نتیجه
> ([`docs/evidence/adr-055/aggregation-stress-cost-observation-0015cpu-github-2026-09-16.txt`](docs/evidence/adr-055/aggregation-stress-cost-observation-0015cpu-github-2026-09-16.txt)،
> ۱۶ سطر، ۱۸۴۶ بایت، بی CR، با یک `
` پایانی):** `outcome=completed`، `timed_out=no`، `exit_status=1`، زمان
> دیوار `01:42:02.701Z`→`01:44:35.905Z` = **۱۵۳٫۲ ثانیه** در برابر کران ۱۸۰۰ — یعنی **داخل کران و نه
> سانسورشده** — **۰/۱/۰/۱** Suite و **۲۱/۱/۰/۲۲** تست، و طبقه‌بندی شکست **`sqlstate57014=1`** با شش دستهٔ دیگر
> صفر. **`other=3` تشخیص محیطی نیست:** `summarizeJestReport` برای گزارشی که وجود دارد و می‌گوید تست شکست خورده
> عمداً هیچ دستهٔ زیرساختی ثبت نمی‌کند (سه `record([], …)` برای «۱ تست شکست خورد»، «یک Suite شکست خورد» و «Jest
> موفقیت گزارش نکرد») و `countCategories` هر سه را در `other` می‌شمارد — پس Harness این شکست را به‌عنوان زیرساخت
> جا نزده است. **چه چیزی یاد گرفتیم:** ۰٫۰۱۵ CPU **نخستین شرطی است که هم شکست می‌دهد و هم داخل کران تمام
> می‌شود**، و شکل شکست همان است که § ۶ از «شکستِ ناشی از محیط» می‌خواهد — `57014` یعنی
> `canceling statement due to statement timeout`، نه نقض Assertion محصول. **ولی شکست حاشیه‌ای است (۱ از ۲۲ تست)
> و این یک نقطه است**، پس نسبت گذشته/شکست‌خورده در بیست جفت از آن پیش‌بینی نمی‌شود. **بازهٔ به‌روزشده:** ۰٫۰۰۵ ←
> تمام نشد (بی هزینه) · **۰٫۰۱۵ ← شکست در ۱۵۳٫۲ ثانیه، داخل کران** · ۰٫۰۵ ← گذشت در ۸۸٫۰ ثانیه. **پیشنهاد کمپین
> جفت‌شده — فقط پیشنهاد؛ در این تکرار اجرا نشد و جداگانه بازبینی می‌شود:** ۱۵۳٫۲ ثانیه × **ضریب ایمنی نام‌دار
> ۲٫۰** = ۳۱۰ ثانیه (گرد به بالا، چون n=۱ و پراکندگی زیر شرط ناشناخته است)، به‌علاوهٔ **سهمیهٔ نام‌دار Probe ۷۵
> ثانیه** (Probe شصت‌ثانیه‌ای که در اجرای ۰٫۰۰۵ ‏۶۷ ثانیه دیوار برد) = **۳۸۵ ثانیه بر جفت**؛ ۲۰ جفت = ۷۷۰۰
> ثانیه؛ به‌علاوهٔ Control یک‌بار ۳۰ ثانیه + Setup ۳۰۰ ثانیه (اندازه‌گیری‌شده ۶۱ ثانیه اینجا و ۸۶ ثانیه در
> `35026098062`) + حاشیهٔ پایانی ۶۰۰ ثانیه = **۸۶۳۰ ثانیه، یعنی ۲ ساعت و ۲۳ دقیقه و ۵۰ ثانیه**. پس: **سهمیهٔ
> ثابت ۰٫۰۱۵ CPU، ۲۰ جفت، کران گام همان ۳۰ دقیقهٔ دست‌نخوردهٔ Harness** (۱۱٫۷ برابر ۱۵۳٫۲ ثانیه، پس Runner دائمی
> نیازی به تغییر ندارد) **و مهلت Job ۱۸۰ دقیقه** — همان عدد کمپین القایی پیشین، با ۳۶ دقیقه سرِ آزاد و کاملاً
> داخل سقف ۳۶۰ دقیقه‌ای Job در GitHub. **هیچ آستانهٔ توانایی پیشنهاد نشد**؛ § ۶ پیش از آستانه مجموعهٔ دوطرفه
> می‌خواهد و این فقط راهِ جمع‌آوری آن است. **محدودیت شناخته‌شده، باز هم بی پنهان‌کاری:** این میزبان
> `*.blob.core.windows.net` را مسدود می‌کند (DNS به `10.10.34.35` می‌رسد و Timeout می‌شود)، پس `gh run download`
> شکست خورد؛ متن با `gh run view --job … --log` از Log همان اجرا استخراج شد — همان رشته‌ای که Wrapper از یک
> متغیر هم در فایل می‌نویسد و هم چاپ می‌کند — تنها با حذف پیشوند Job/Step/زمان خودِ GitHub؛ **هیچ عددی دست‌کاری
> نشد** و Upload با `if-no-files-found: error` موفق شد، پس فایل روی Runner واقعاً وجود داشت. Artifact
> اعتبارسنجی شد: بی CR، بی فضای انتهایی، یک `
` پایانی، واژگان ثابت، بازمحاسبهٔ ۱۵۳٫۲۰۴ ← ۱۵۳٫۲، جمع Suite
> (۰+۱+۰=۱) و تست (۲۱+۱+۰=۲۲) سازگار، سهمیهٔ درخواستی = تأییدشده، `cpus=0.015` = ۱۵۰۰۰/۱۰۰۰۰۰۰، و بی URL،
> Credential، رشتهٔ اتصال، Token، مسیر مطلق، شناسه/نام Container، PID، عنوان تست، استثنای خام یا خروجی خام
> زیرفرایند. **Workflow موقت بلافاصله پس از همان یک اجرا حذف شد؛ درخت شاخه دوباره فقط
> `.github/workflows/ci.yml` دارد.** **هنوز نیست:** مجموعهٔ دوطرفهٔ جفت‌شده (الزام سمت شکستِ § ۶ **برآورده
> نشد** — یک شکستِ تکیِ بی‌جفت، شواهد جفت‌شده نیست)، عدد آستانه، حاشیهٔ ایمنیِ آستانه، Classifier توانایی،
> Preflight فاز، دروازهٔ Fail-Fast و یکپارچه‌سازی CI؛ کران ۲۹٫۲ همچنان بی Provenance. `COM-009` همچنان
> `READY`/۱۳، ADR-053 و ADR-055 همچنان `Proposed`؛ AUD-004 باز است.
>
> **به‌روزرسانی 2026-09-16 — نخستین مجموعهٔ جفت‌شدهٔ دوطرفهٔ § ۶ زیر ۰٫۰۱۵ CPU:** شرطی که تکرار پیش هزینه‌اش
> اندازه‌گیری شده بود، این بار به یک **کمپین جفت‌شدهٔ کامل** تبدیل شد. سهمیهٔ CFS **ثابت**
> `CPU_PERIOD_US=1000000` / `CPU_QUOTA_US=15000` (**۰٫۰۱۵ CPU**) فقط روی Container سرویس PostgreSQL، **۲۰
> جفت**، کران گام همان ۳۰ دقیقهٔ **دست‌نخوردهٔ** Harness، مهلت Job ۱۸۰ دقیقه، **یک** اجرا و **بدون Retry**؛
> شرط بین جفت‌ها تغییر نکرد، بار SQL یا کار جانبی اضافه نشد، پایگاه داده Pause/Kill نشد و هیچ تنظیم PostgreSQL
> عوض نشد. Workflow موقت و فقط‌شاخه‌ای `aggregation-stress-induced-calibration.yml`، **مشتق از همان Workflow
> بازبینی‌شدهٔ `9b03ac0`** با تفاوت‌های کارکردی تنها: نام Workflow، گروه Concurrency، ثابت سهمیه، شناسه و نام
> Job، سه نام گام، نام فایل گزارش و نام/مسیر Artifact — همان SHAهای Pinشده، Node 22 / pnpm 11.22.0، Runner
> **بومی Ubuntu** یک‌بارمصرف، **دقیقاً یک** Service Container ‏`postgis/postgis:16-3.4`
> (`containers_running=1`)، Credential یک‌بارمصرف Job-local، همان Provisioning/Build/Migration **پیش از**
> سهمیه، همان تفکیک دقیق تصویر با رد پیش از اندازه‌گیری، همان `docker update` خاموش‌شده و بازخوانی دوفیلدی
> `HostConfig.CpuPeriod`/`HostConfig.CpuQuota`، همان Provenance باریک، همان یک فرمان بی‌Retry
> `calibrate:aggregation-stress -- --pairs 20`، همان گرفتن و **دوباره برافراشتن** کد خروج، و همان Upload با
> `always()` و `if-no-files-found: error`. روی Commit ‏`a0db6386f6d027cfdd0fbf2c250a70eb4c90bb4c`؛ اجرای
> `35048202361` (تلاش ۱، رویداد `push`، Workflow و Job هر دو `failure` — **که همان نتیجهٔ یک جفتِ شکست‌خورده
> است، نه خطای Setup**)، `02:29:53Z`→`03:36:50Z`. **گام‌ها:** ۱..۱۲ همگی `success`، شامل
> `test:aggregation-evidence-lib` و `check:test-phases` **پیش از** سهمیه و تأیید دقیق
> `applied_cpu_period_us=1000000` / `applied_cpu_quota_us=15000` (شناسهٔ Container هرگز چاپ نشد)؛ گام ۱۳
> (کمپین) `failure` `02:31:05Z`→`03:36:45Z` = **۶۵ دقیقه و ۴۰ ثانیه** با `campaign_exit=1`؛ گام ۱۴ (Upload)
> `success`. **پس هیچ خطای Setup، قرارداد، سهمیه، Harness، مهلت Job یا Artifact رخ نداد.** زمان واقعی ۶۵۴۰
> ثانیه در برابر ۸۶۳۰ ثانیهٔ پیش‌بینی‌شده و ۱۰۸۰۰ ثانیهٔ مهلت — پیش‌بینی محافظه‌کارانه بود چون از یک نمونهٔ سرد
> ساخته شده بود. **نتیجه
> ([`docs/evidence/adr-055/induced-calibration-0015cpu-github-2026-09-16.txt`](docs/evidence/adr-055/induced-calibration-0015cpu-github-2026-09-16.txt)،
> ۱۷۰ سطر، ۱۳٬۷۴۶ بایت، بی CR، بی BOM، با یک خط جدید پایانی):** `VALID=20`، `INVALID=0`، `INCONCLUSIVE=0`؛
> Control ‏(۱۰s، فقط‌خواندنی) `VALID`؛ **Suite فشار ۱۹ گذشته / ۱ شکست‌خورده از ۲۰** و هر ۲۰ جفت `ran=yes`؛
> تنها جفت شکست‌خورده **`pair-1`** است (خروج ۱، ۲۷۱٫۳ ثانیه، ۰/۱/۰/۱ Suite و ۲۰/۲/۰/۲۲ تست) با طبقه‌بندی
> **`sqlstate57014=1`** و **`jestTimeout=1`** و پنج دستهٔ دیگر صفر؛ توزیع‌ها (کمینه/میانه/بیشینه):
> `probe_tps` **۳۹٫۸۲ / ۲۰۴٫۶ / ۲۱۲٫۰۲**، `probe_min_interval_tps` **۱ / ۲۶ / ۴۱**، `probe_longest_stall_s`
> **۰ / ۰ / ۰**، `stress_wall_s` **۱۱۰٫۵۶ / ۱۱۶٫۱۲ / ۲۷۱٫۲۷**؛ چهارده دستهٔ زیرساختی جفت‌ها صفر با `other=3`،
> و دامنه‌های Control و Preflight هر پانزده دسته صفر. **`other=3` خطای محیط نیست:** `summarizeJestReport` برای
> گزارشی که وجود دارد و می‌گوید تست شکست خورده عمداً هیچ دستهٔ زیرساختی ثبت نمی‌کند (سه `record([], …)` برای «۲
> تست شکست خورد»، «یک Suite شکست خورد» و «Jest موفقیت گزارش نکرد») و `countCategories` هر سه را در `other`
> می‌شمارد. **هیچ ردیف `INVALID`، `INCONCLUSIVE`، تلاش‌نشده، بی‌گزارش یا ردشده به‌دلیل زیرساخت وجود ندارد.**
> **چرا مجموعه دوطرفه است:** نوزده جفت `VALID` با Suite گذشته **و** یک جفت `VALID` با Suite شکست‌خوردهٔ ناشی
> از محیط — آن جفت واجد شرایط است چون Probe اش `VALID` است و Suite دست‌نخورده واقعاً اجرا شد، و شکل شکستش
> `57014` (`canceling statement due to statement timeout`) و گذشتن از Timeout تست است، نه نقض Assertion محصول
> (هر سه دستهٔ `secondRowOrWindowCrossing`/`countSequence`/`finalRow` صفرند). طبق ADR-055 §§ ۱–۴ این جفت
> همچنان **`VALID`** است و **`VALID_INCAPABLE` نام‌گذاری نشد**. **محدودیت شناخته‌شده، بی پنهان‌کاری:** این
> میزبان `*.blob.core.windows.net` را مسدود می‌کند (DNS به `10.10.34.35` می‌رسد و Timeout می‌شود)، پس
> `gh run download` باز هم شکست خورد و **مقایسهٔ بایت‌به‌بایت با Artifact دانلودشده ممکن نشد**؛ متن از Log همان
> اجرا استخراج شد — همان رشته‌ای که Harness از **یک متغیر** هم چاپ می‌کند و هم در فایل می‌نویسد — تنها با حذف
> پیشوند Job/Step/زمان خودِ GitHub، و **هیچ عددی دست‌کاری نشد**؛ Upload با `if-no-files-found: error` موفق شد،
> پس فایل روی Runner واقعاً وجود داشت. **۴۱ بررسی اعتبارسنجی** پیش از ورود به Git گذشت: Commit مطابق `headSha`
> همان اجرا، ۲۰ سطر جفت با شناسهٔ ۱..۲۰ هرکدام یک بار و مجاورت Probe→Stress، واژگان فقط
> `VALID`/`INVALID`/`INCONCLUSIVE`، سازگاری `exit` با `PASS`/`FAIL`، جمع‌های Suite/تست و دسته‌های شکست، هر
> چهار توزیع **بازمحاسبه‌شده از سطرها**، و بی URL/رشتهٔ اتصال/Credential/Token/مسیر مطلق/IP/PID/شناسه یا نام
> Container/استثنای خام/خروجی خام/عنوان تست. سه سطر `problem:` روی `pair-1` واژگان ثابت خودِ Harness اند و فقط
> شمارش‌اند. **Workflow موقت بلافاصله پس از همان یک اجرا حذف شد؛ درخت شاخه دوباره فقط
> `.github/workflows/ci.yml` دارد.** **هیچ آستانه، حاشیهٔ ایمنیِ آستانه، `VALID_CAPABLE`/`VALID_INCAPABLE`،
> Classifier توانایی، Preflight فاز، دروازهٔ Fail-Fast، Bypass، Retry، Skip-Green، سیاست زمان اجرا یا
> یکپارچه‌سازی با CI معمول اضافه نشد**؛ Spec فشار، SQL ‏Probe، `PROBE_VALIDITY`، Selectorها، Timeoutها، تعداد
> Lane/نوشتن، کد تست، Scriptهای Package، `ci.yml`، فازهای تست، Runner دائمی و **هر سه Artifact پیشین** دست
> نخوردند؛ کران ۲۹٫۲ همچنان بی Provenance. **پیش‌نیاز جمع‌آوریِ § ۶ برآورده شد** و **گام بعدی پیشنهادی یک
> بازبینی جداگانه برای تحلیل توزیع و حکمرانی آستانه است — در این تکرار انتخاب یا اجرا نشد.** `COM-009` همچنان
> `READY`/۱۳، ADR-053 و ADR-055 همچنان `Proposed`؛ AUD-004 باز است.
>
> **به‌روزرسانی 2026-09-16 — بازبینی حکمرانی آستانهٔ § ۶: تصمیم NO-GO، هیچ عددی انتخاب نشد:** همان بازبینی
> جداگانه‌ای که تکرار پیش پیشنهاد کرده بود انجام شد، و نتیجه‌اش **انتخاب نکردن** آستانه است. این گام یک
> **تحلیل و تصمیم مستندسازی** بود: هیچ کمپینی اجرا نشد، هیچ Workflowی ساخته نشد، هیچ اندازه‌گیری تازه‌ای گرفته
> نشد، Docker/PostgreSQL محلی روشن یا دست‌کاری نشد و **هیچ Artifact شواهدِ موجودی تغییر نکرد**. سند تازه:
> [`docs/evidence/adr-055/threshold-governance-review-2026-09-16.md`](docs/evidence/adr-055/threshold-governance-review-2026-09-16.md)
> — یک تحلیل مهندسی (نه Artifact تولیدشدهٔ Harness) که **همهٔ اعدادش از سطرهای خودِ Artifactها با یک Script
> موقتِ Commit‌نشده بازمحاسبه شده‌اند**، نه از متن روایی گزارش‌ها؛ خطوط تجمیعی خودِ Artifactها به‌عنوان بررسی
> مستقل استفاده شدند و **مطابق درآمدند** (`passed=19 failed=1 of 20`، و هر سه توزیع `probe_tps`
> ۳۹٫۸۲/۲۰۴٫۶/۲۱۲٫۰۲، `probe_min_interval_tps` ۱/۲۶/۴۱ و `probe_longest_stall_s` ۰/۰/۰ دقیقاً یکسان).
> **چرا NO-GO.** پیش‌شرط **جمع‌آوری** § ۶ برآورده است ولی پیش‌شرط **حکمرانی** نه: کل سمت شکست **یک** سطر است و
> آن سطر کاملاً با ترتیب اجرا **هم‌آمیخته** است — `pair-1` هم‌زمان تنها `FAIL`، کندترین `probe_tps` (۳۹٫۸۲ در
> برابر بعدی ۱۹۲٫۷۵ روی `pair-10`)، کمترین `probe_min_interval_tps` (۱ در برابر بعدی ۳ روی `pair-5`) و
> بلندترین `stress_wall_s` (۲۷۱٫۳ در برابر بعدی ۱۵۰٫۴) است. **ممیزی جداپذیری:** روی `probe_tps` هر `T` با
> `39.82 < T <= 192.75` این بیست مشاهده را **کاملاً یکسان** جدا می‌کند — بازهٔ باز به پهنای **۱۵۲٫۹۳**، پس داده
> هیچ راه اصولی برای ترجیح یک عدد یا استخراج حاشیه‌اش نمی‌دهد؛ روی `probe_min_interval_tps` هر `T` با
> `1 < T <= 3` جدا می‌کند ولی فاصلهٔ مشاهده‌شده فقط **۲ واحد** و بی هیچ تکرار است (سطرهای گذشته:
> ۳، ۹، ۱۱، ۲۱، ۲۱، ۲۵، ۲۶×۴، ۲۷، ۲۸، ۳۰، ۳۰، ۳۱، ۳۱، ۳۴، ۳۷، ۴۱)؛ `probe_longest_stall_s` در **هر چهل سطر**
> هر دو کمپین صفر است و هیچ قدرت تفکیکی ندارد؛ ترتیب جفت هم این نمونه را کامل جدا می‌کند و آشکارا Predictor
> توانایی نیست — که خودش همان هشدار است. کمپین آرام بیست جفت گذشتهٔ دیگر می‌افزاید (`probe_tps`
> ۲۴۹۴٫۸…۳۷۹۷٫۵۱، `probe_min_interval_tps` ۴۰۵…۲۱۷۴٫۳) ولی کندترین Probe آن ≈ **۱۱٫۸ برابر** تندترین Probe
> مجموعهٔ القایی است، پس بسیار دور از مرز است و **انتخاب درون هیچ‌یک از دو بازه را حل نمی‌کند**. **آمار توصیفی
> (n=۲۰ هر کمپین، چارک Hyndman–Fan Type 7، بی هیچ فرض نرمال بودن):** القایی `probe_tps` کمینه ۳۹٫۸۲، Q1
> ۲۰۱٫۵۹۲۵، میانه ۲۰۴٫۶، Q3 ۲۰۸٫۹۹، IQR ۷٫۳۹۷۵، بیشینه ۲۱۲٫۰۲، میانگین ۱۹۶٫۹۵۲۵ (میانگینِ **زیر** Q1 یعنی
> چولگی شدید از یک مقدار پرت)؛ القایی `probe_min_interval_tps` ۱ / ۲۱ / ۲۶ / ۳۰٫۲۵ / IQR ۹٫۲۵ / ۴۱ / میانگین
> ۲۴٫۲؛ القایی `stress_wall_s` (بازمحاسبه از سطرها) ۱۱۰٫۶ / ۱۱۴٫۸۲۵ / ۱۱۶٫۱ / ۱۳۸٫۸۷۵ / IQR ۲۴٫۰۵ / ۲۷۱٫۳ /
> میانگین ۱۳۰٫۷۴؛ آرام `probe_tps` ۲۴۹۴٫۸ / ۲۹۵۶٫۳۰۷۵ / ۳۲۶۸٫۲۳ / ۳۴۰۶٫۷۴۷۵ / IQR ۴۵۰٫۴۴ / ۳۷۹۷٫۵۱ / میانگین
> ۳۱۸۴٫۶۲۹۵؛ آرام `probe_min_interval_tps` ۴۰۵ / ۷۸۲٫۶۷۵ / ۱۰۱۳٫۹۵ / ۱۳۲۱٫۸۲۵ / IQR ۵۳۹٫۱۵ / ۲۱۷۴٫۳ / میانگین
> ۱۰۹۰٫۵۸۵. بازه‌های به تفکیک نتیجه: ۱۹ سطر `PASS` با `probe_tps` ۱۹۲٫۷۵…۲۱۲٫۰۲ و `min_interval` ۳…۴۱ و
> `wall_s` ۱۱۰٫۶…۱۵۰٫۴، در برابر **یک** سطر `FAIL` که یک **نقطه** است (۳۹٫۸۲ / ۱ / ۲۷۱٫۳)، نه یک بازه.
> **بازهٔ Clopper–Pearson ۹۵٪ برای ۱ از ۲۰ = [۰٫۱۳٪ ، ۲۴٫۸۷٪]، صریحاً غیرتصمیمی** — بیست جفت سریال روی یک
> پایگاه داده و یک Job استقلال اثبات‌شده ندارند، پس این بازه مجاز به توجیه یا کران‌گذاری هیچ آستانه‌ای نیست و
> فقط نشان می‌دهد نرخ شکستِ سازگار با این نمونه بیش از **دو مرتبهٔ بزرگی** پهنا دارد. **Confoundها و
> محدودیت‌ها:** اثرهای «اجرای نخست» (Cache سرد پایگاه داده و فایل‌سیستم، نخستین Compile و بارگذاری ماژول، گذارِ
> بلافاصله پس از اعمال سهمیه) **با این طراحی از توانایی تفکیک‌پذیر نیستند** — و این **Confound حل‌نشده ثبت
> می‌شود، نه ادعای علّی دربارهٔ Cold Start**؛ هیچ نمونهٔ مستقلِ تکرارشدهٔ سمت شکست، هیچ دادهٔ Holdout و هیچ
> تخمینی از نرخ False-Capable/False-Incapable وجود ندارد؛ انتخاب Predictor و انتخاب عدد هر دو روی همان بیست
> مشاهده انجام می‌شد؛ و **حاشیهٔ ایمنی مشتق نمی‌شود** چون هیچ مشاهده‌ای نزدیک هیچ‌یک از دو مرز نامزد نیست.
> **قابلیت مقایسه، با هشدار صریح:** خط `topology:` هر دو Artifact **بایت‌به‌بایت یکسان** است؛ دو کمپین روی دو
> Commit متفاوت اجرا شدند و `scripts/aggregation-evidence.mjs` بینشان با `f2406f4` عوض شد، ولی
> `git diff 89ebe99 a0db638` برای **`scripts/aggregation-evidence-lib.mjs`** و برای **Spec فشار** **تهی** است و
> هیچ سطری در هیچ کمپین `timedOut` نیست (دستهٔ `timeout` در همهٔ دامنه‌های هر دو Artifact صفر). **یک نکتهٔ دقت،
> نه ناسازگاری:** زمان دیوار در سطر با یک رقم و در خط توزیع با دو رقم از همان مقدار گرد‌نشده چاپ می‌شود، پس
> ۱۱۰٫۶/۱۱۶٫۱/۲۷۱٫۳ و ۱۱۰٫۵۶/۱۱۶٫۱۲/۲۷۱٫۲۷ یکدیگر را نقض نمی‌کنند (همین الگو در Artifact آرام هم هست).
> **جدول تصمیم § ۶ — برآورده:** مجاورت جفت‌ها، دست‌نخوردگی Suite، صراحت اعتبار، توزیع کامل، حضور هر دو سمت،
> ثبت کمینهٔ TPS بازه/وقفه/طبقه‌بندی شکست، و گزارش تجمیعیِ بی‌راز. **برای انتخاب آستانه کافی نیست:** انتخاب
> Predictor، عدد مرز، حاشیهٔ ایمنی، آزمون مرزی/جهش روی آن عدد، تکرار مستقل سمت شکست، و تخمین‌پذیری نرخ خطا.
> **نیمه‌برآورده:** جایگزینی کران بی‌Provenance ۲۹٫۲ — هر دو کمپین Provenance دارند ولی هیچ‌کدام میزبان محلی
> Docker Desktop را اندازه نمی‌گیرند. **تصمیم صریح:** هیچ آستانه، حاشیهٔ ایمنی، `VALID_CAPABLE`/`VALID_INCAPABLE`،
> Classifier توانایی، Preflight فاز، Orchestration در `run-test-phases.mjs`، دروازهٔ Fail-Fast، Bypass، Retry،
> Skip-Green، سیاست زمان اجرا یا تغییر CI معمول اضافه نشد؛ `pair-1` همچنان **`VALID`** است و برچسب
> `VALID_INCAPABLE` نگرفت؛ `planning/backlog.json`، امتیازها، وضعیت‌ها، کد، Scriptها، تست‌ها، Package،
> Workflowها و مولدهای شواهد دست نخوردند؛ و این تصمیم **عمداً در `docs/24-open-questions.md` ثبت نشد**، چون
> خودِ ADR-055 می‌گوید یک تصمیم کالیبراسیون مهندسی است، نه قاعدهٔ کسب‌وکاری. **پیشنهاد ثبت‌شدهٔ گام بعد — فقط
> Pre-Register شد، اجرا نشد:** کمپین آیندهٔ **جداگانه بازبینی‌شده** از **تکرارهای مستقلِ جفتِ نخست** روی همان
> شرط اندازه‌گیری‌شدهٔ `CPU_PERIOD_US=1000000` / `CPU_QUOTA_US=15000`، با **یک جفت در هر Job و پایگاه دادهٔ
> یک‌بارمصرفِ تازه** (`--pairs 1`؛ از قبل مجاز است چون `MIN_CALIBRATION_PAIRS = 1`) و همان قرارداد دست‌نخوردهٔ
> Probe→Suite کامل — تا معلوم شود شکستِ `pair-1` و Probe پایینش در اجراهای تازه **تکرار می‌شود یا Artifact
> ترتیب سریال بوده است**؛ با تأیید دقیق تصویر/توپولوژی/سهمیه پیش از هر اندازه‌گیری، ثابت‌ها و Timeoutهای فشار
> دست‌نخورده، بی Retry، Artifactهای تجمیعیِ Redactشده روی مسیرهای جدا، حفظ خروج غیرصفر، و بی هیچ یکپارچه‌سازی
> با CI معمول. **تعداد تکرار در این تکرار اختراع نشد:** تعیین حجم نمونه **پیش‌نیاز صریح** آن بازبینی است و باید
> از یک هدف دقت/خطای بیان‌شده مشتق شود. و اگر تکرارِ اجرای تازه به اندازهٔ کافی شکستِ معتبرِ ناشی از محیط ندهد،
> یک طراحی **Steady-State/نزدیکِ مرز** همچنان لازم خواهد بود. **قاعدهٔ Fallback نصف‌سازی لگاریتمی کاربرد ندارد
> و استفاده نشد** — برای مجموعهٔ یک‌طرفه نوشته شده بود و این مجموعه دوطرفه است. **هنوز نیست:** عدد آستانه،
> حاشیهٔ ایمنی، Classifier توانایی، Preflight فاز، دروازهٔ Fail-Fast و یکپارچه‌سازی CI؛ کران ۲۹٫۲ همچنان بی
> Provenance. `COM-009` همچنان `READY`/۱۳، ADR-053 و ADR-055 همچنان `Proposed`؛ AUD-004 باز است.
>
> **به‌روزرسانی 2026-09-16 (ADR-055 — طراحی Pre-Register شدهٔ تکرار جفتِ نخست در اجرای تازه؛ فقط مستندات،
> کمپین اجرا نشد):** بازبینی NO-GO یک **پیش‌نیاز صریح** گذاشته بود — پیش از هر کمپین تکرار باید هدف آماری
> قابل دفاع بیان و تعداد تکرار از آن **مشتق** شود. این گام دقیقاً همان را انجام داد و **هیچ کار دیگری**:
> **هیچ کمپینی اجرا نشد، هیچ اندازه‌گیری تازه‌ای گرفته نشد، هیچ Workflowی ساخته یا اضافه نشد، هیچ Artifact
> شواهدِ موجودی تغییر نکرد، و هیچ Docker/PostgreSQL محلی روشن یا دست‌کاری نشد.** سند تازه:
> [`docs/evidence/adr-055/fresh-run-first-pair-replication-design-2026-09-16.md`](docs/evidence/adr-055/fresh-run-first-pair-replication-design-2026-09-16.md)
> — یک **Preregistration**، نه Artifact تولیدشدهٔ Harness. **پرسش و کمیت هدف:** آیا شکستِ ناشی از محیطِ
> مشاهده‌شده روی `pair-1` سریال، میان **جفت‌های نخستِ اجراهای تازهٔ مستقل** روی همان شرط اندازه‌گیری‌شدهٔ
> `CPU_PERIOD_US=1000000` / `CPU_QUOTA_US=15000` تکرار می‌شود؟ کمیت هدف = احتمال شکستِ واجد شرایطِ ناشی از
> محیط برای نخستین جفت Probe→Suite دست‌نخورده در یک Job و پایگاه دادهٔ یک‌بارمصرفِ تازه. **این کمپین فقط
> Confound ترتیب را هدف می‌گیرد و کمپین انتخاب آستانه یا حاشیهٔ ایمنی نیست.** **هدف قابل دفاع، لنگرانداخته به
> شواهد Commit‌شده:** کوچک‌ترین احتمال تکرارِ قابل تشخیص **۵٪**، **تنها** به این دلیل که `1/20 = 5%` یگانه
> فراوانی شکستِ مشاهده‌شده در کمپین القایی است — و صریحاً **نه** تخمین مستقلی از نرخ واقعی (بیست جفت سریال
> روی یک Job و یک پایگاه داده استقلال اثبات‌شده ندارند)، **نه** تحمل محصولی/کسب‌وکاری، و **نه** توجیهی برای
> هیچ آستانه‌ای؛ با اطمینان **یک‌طرفهٔ ۹۵٪**، چون پرسش جهت‌دار است نه تخمین متقارن. **تعداد ثابت، مشتق‌شده:**
> `P(≥۱ | p=0.05, n) = 1 − 0.95^n ≥ 0.95` ⟵ `n ≥ log(0.05)/log(0.95) = 58.4039748143197` ⟵ **`n = 59`
> تکرار معتبر مستقل**؛ بررسی مرزی: `n=58` ‏`94.895313%` (ناکافی) و `n=59` ‏`95.150547%`. اگر هر ۵۹ معتبر
> باشند و هیچ شکست واجد شرایطی نباشد، کران بالای دقیق **Clopper–Pearson یک‌طرفهٔ ۹۵٪** برابر
> `1 − 0.05^(1/59) ≈ 4.9508%` است — درست زیر ۵٪ (در `n=58` همان کران `5.033934%` و **بالای** حساسیت طراحی).
> تقریب نرمال، توان Post-hoc، بازهٔ دوطرفه، توقف اختیاری و هر عدد دیگری صریحاً کنار گذاشته شدند. **طراحی
> ثابت:** ۵۹ Slot، **همه** اجرا می‌شوند فارغ از نتیجهٔ بقیه؛ بی توقف زودهنگام (موفقیت یا بی‌ثمری)، بی تمدید
> نتیجه‌محور، بی اجرای دوبارهٔ اثبات شکست‌خورده، بی Retry در هیچ سطح، و بی جایگزینی/حذف/شماره‌گذاری دوباره؛
> اگر حتی یک Slot ‏`INVALID`، `INCONCLUSIVE`، غایب، لغوشده، ناسازگار در Provenance یا بی‌Artifact باشد،
> کمپین برای هدف ۵٪/۹۵٪ **INCONCLUSIVE** است و **نرخ ریزش یا سیاست جایگزینی خودکار اختراع نشد**.
> **طبقه‌بندی پیش از داده:** واجد شرایط بودن = Control و Probe معتبر، اجرای واقعی Suite کاملِ دست‌نخورده،
> تأیید دقیق Image/توپولوژی/سهمیه پیش از اندازه‌گیری، و Artifact کامل؛ **رخداد واجد شرایط** = جفت `VALID` که
> Suite‌اش فقط با دسته‌های محیطی (`sqlstate57014` و/یا `jestTimeout`) شکسته و هر سه دستهٔ Assertion محصول
> صفرند؛ **غیررخداد** = Suite گذشته؛ و هر شکست Assertion محصول، مختلط، ناشناخته، Setup/Launcher/کران فرایند
> یا انحراف قرارداد یک **مسدودکننده** است — نه رخداد و نه شاهد ناتوانی. واژگان `VALID`/`INVALID`/`INCONCLUSIVE`
> دست‌نخورده ماند و `VALID_CAPABLE`/`VALID_INCAPABLE` ساخته **نشد**. **تفسیر Pre-Register شده:** با ≥۱ شکست
> واجد شرایط فقط «تکرار در اجرای تازه مشاهده شد» ثبت می‌شود (بی استنتاج آستانه و بی ادعای تخمین دقیق)؛ با صفر
> شکست در ۵۹ تکرار معتبر فقط «تکرار با احتمال ≥۵٪ در هدف یک‌طرفهٔ ۹۵٪ بازتولید نشد» ثبت می‌شود (بی ادعای
> ناممکن بودن)؛ هر حالت دیگر Inconclusive. در **هر سه** شاخه انتخاب Predictor، عدد مرز، حاشیهٔ ایمنی،
> نرخ‌های False-Capable/False-Incapable، پذیرش ADR و پیاده‌سازی **موکول** می‌مانند، و اگر شواهد سمت شکستِ
> نزدیکِ مرز کافی نباشد طراحی **Steady-State/نزدیکِ مرز** همچنان لازم است. **ممیزی مستقل Harness (بی تغییر
> کد):** `MIN_CALIBRATION_PAIRS = 1`، پذیرش `--pairs 1` و رد `0`/`21`، برنامهٔ Control سپس Probe→Suite کاملِ
> مجاور، رد Filter/`--passWithNoTests`/مجاورت شکسته و رد شش جهش مستقل ثابت‌های فشار، گزارش تجمیعیِ Redactشده،
> خروج غیرصفر برای Suite شکست‌خورده، کران ۳۰ دقیقه‌ای گام، و جایگاه دست‌نخوردهٔ فاز انحصاری — همه برقرارند.
> **یک یافتهٔ باریک ثبت و عمداً رفع نشد:** الگوی `/^--retry/` قرارداد `--retries` را نمی‌گیرد (`--retry` و
> `--retryTimes` را می‌گیرد)؛ مسدودکننده نیست چون فرمان Pre-Register شده هیچ Argument اضافه‌ای نمی‌دهد و
> برنامه ماشین‌ساخته است، ولی رفع جداگانه می‌خواهد. **شکل Workflow آیندهٔ موقت فقط توصیف شد و ساخته نشد:**
> Matrix ۵۹تایی `1..59`، `fail-fast: false`، یک Container سرویس PostgreSQL در هر Job، نام Artifact/گزارش
> یکتا با اندیس، `if: always()` برای Upload، بی پایگاه دادهٔ مشترک، بی Retry و بی `continue-on-error`، گرفتن
> و بازپرتاب خروج کمپین، `concurrency` با `cancel-in-progress: false`، Action های Pin شده،
> `permissions: contents: read`، بی یکپارچه‌سازی با CI معمول، و حذف Workflow در همان تکرار آینده؛ گام بازبینی
> باید هر ۵۹ Slot را از **محتوای Artifact** بشمارد نه از نتیجهٔ Job، چون شکست واجد شرایط خودش Job را قرمز
> می‌کند و قرمز بودن نه «غایب» است نه «سبز». **هزینه، از شواهد اندازه‌گیری‌شده بازمحاسبه شد (نه ضرب بودجهٔ
> ۲۰ جفتی):** Setup ۶۱ و ۷۲ ثانیه (اجراهای `35045042687` و `35048202361`)، Teardown ۵ و ۶ ثانیه، سربار
> غیرفشارِ هر جفت ۵٫۷۶ ثانیه (`(3940 − 1200 − 10 − 2614.8) / 20`)، بدترین `stress_wall_s` در همین شرط ۲۷۱٫۳
> ثانیه؛ هزینهٔ مورد انتظار هر Job ≈۴۲۵٫۰۶ ثانیه و بدترین حالتِ کاملاً کراندار ۲۳۰۸ ثانیه، پس مهلت Job
> **۴۵ دقیقه** مشتق شد تا کران ۳۰ دقیقه‌ای خودِ Harness (نه مهلت Job) متوقف‌کننده باشد و Artifact نوشته شود.
> مجموع زمان Job ≈۶ ساعت و ۵۸ دقیقه در هزینهٔ مورد انتظار و سقف مطلق ۲۶۵۵ دقیقهٔ Job؛ **زمان دیوار به سطح
> هم‌زمانی بستگی دارد و ادعا نشد**، و سطح هم‌زمانی، زمان صف، سقف اندازهٔ Matrix، پایداری Image، سهمیهٔ
> صورت‌حساب و در دسترس بودن Download باید پیش از اجرا راستی‌آزمایی شوند. ناتوانی تاریخی میزبان محلی در
> Download از `*.blob.core.windows.net` یک **ریسک بازیابی شواهد** با Fallback از پیش اعلام‌شده است (استخراج
> همان متن از Log همان اجرا، بی هیچ ویرایش عددی، با همان اعتبارسنجی و همان شمارش کامل ۵۹ Slot) — در این
> تکرار نه اجرا شد و نه حل شد. **حکمرانی:** این تصمیم عمداً در `docs/24-open-questions.md` ثبت **نشد**، چون
> یک تصمیم کالیبراسیون مهندسی است نه قاعدهٔ کسب‌وکاری؛ `planning/backlog.json`، امتیازها، وضعیت‌ها، کد،
> Scriptها، تست‌ها، Package، `ci.yml`، Workflowها، ثابت‌های فشار و هر پنج Artifact شواهد دست نخوردند.
> **هنوز نیست:** عدد آستانه، حاشیهٔ ایمنی، Classifier توانایی، Preflight فاز، دروازهٔ Fail-Fast و
> یکپارچه‌سازی CI؛ کران ۲۹٫۲ همچنان بی Provenance. `COM-009` همچنان `READY`/۱۳، ADR-053 و ADR-055 همچنان
> `Proposed`؛ AUD-004 باز است.
>
> **به‌روزرسانی 2026-09-16 (ADR-055 — بستن رخنهٔ `--retries` در قرارداد کالیبراسیون؛ اصلاح باریک
> Defence-in-Depth):** بازبینی امکان‌سنجی همان روز یک یافتهٔ باریک ثبت کرده بود و عمداً رفع نکرده بود:
> نگهبان Retry در `validateCalibrationContract` با الگوی `/^--retry/` نوشته شده بود، پس `--retry` و
> `--retryTimes` را می‌گرفت ولی **`--retries` را نه**، و آزمون موجود فقط `--retry=2` را می‌آزمود — یعنی
> منفیِ کاذب **آزموده‌نشده** بود. هر دو واقعیت پیش از تغییر روی خودِ فایل‌ها تأیید شدند. **اکنون بسته شد:**
> الگو به `/^--retr(?:y|ies)/` تغییر کرد — یک **اَبَرمجموعه** از الگوی قبلی، پس هیچ پوششی تنگ نشد — و آزمون
> به یک جدول هفت‌سطری گسترش یافت که هر شکل را **مستقل** اثبات می‌کند: `--retry`، `--retry=2`،
> `--retryTimes`، `--retryTimes=3`، `--retries`، `--retries=2`، و `--retries 2` به‌صورت دو Token جدا (خودِ
> Token پرچم گرفته می‌شود، پس مقدار جدا هم پوشش دارد). **و اثبات شد که نگهبان سرریز نمی‌کند:** دو Assertion
> منفی روی همسایه‌های `--retrieve` و `--retro` نشان می‌دهند که صرفاً هر Argument با پیشوند `--retr` رد
> نمی‌شود. آزمون تازه پیش از اصلاح روی `3eb7019` **دقیقاً روی `["--retries"]` شکست می‌خورد** (تأییدشده با
> اجرای همان آزمون روی نسخهٔ قدیمی کتابخانه) و پس از اصلاح سبز است؛ و یک بررسی مکانیکی قبل/بعد هر هفت Token
> را جدا شمرد (پیش: سه شکل `--retries` پذیرفته می‌شدند؛ پس: هر هفت رد می‌شوند و هر دو همسایه پذیرفته).
> **آنچه دست نخورد:** نگهبان جداگانهٔ سطح-Source در `validateStressSpecContract`
> (`/retryTimes|\.retry\(/`) — این تکرار دربارهٔ Argumentهای برنامهٔ کالیبراسیون است نه بازنویسی سیاست
> Retry — و نیز پیام خطا، معناشناسی قرارداد، و آزمون‌های موجودِ مجاورت/Filter/`--passWithNoTests`/شکل
> برنامه/تشخیص Retry در Spec. **ثبت تاریخی رخنه در Artifact طراحی (§ ۸٫۲) عمداً ویرایش یا حذف نشد** — آن
> سند می‌گوید در زمان ممیزی چه چیزی درست بود. **هیچ کمپینی اجرا نشد، هیچ اندازه‌گیری تازه‌ای گرفته نشد، هیچ
> Workflowی ساخته نشد، هیچ Docker/PostgreSQL روشن یا دست‌کاری نشد، و طراحی آماری و شمار ثابت ۵۹ Slot دست
> نخورد.** هیچ آستانه، حاشیهٔ ایمنی، Classifier توانایی، Preflight فاز، دروازهٔ Fail-Fast، Bypass، Retry،
> Skip-Green، سیاست زمان اجرا یا یکپارچه‌سازی CI/`pnpm verify` اضافه نشد؛ `docs/14-testing-strategy.md`،
> `docs/24-open-questions.md`، `planning/backlog.json`، `ci.yml`، Workflowها، کد سرویس‌ها، Packageها، Spec
> فشار و هر شش Artifact شواهد دست نخوردند. `COM-009` همچنان `READY`/۱۳، ADR-053 و ADR-055 همچنان
> `Proposed`؛ AUD-004 باز است. کمپین Pre-Register شدهٔ ۵۹ Slot همچنان **اجرا نشده** است.
>
> **به‌روزرسانی 2026-09-16 (ADR-055 — دروازهٔ آمادگی اجرای کمپین ۵۹ Slot؛ فقط‌خواندنی، نتیجه NO-GO):** پیش از
> هر اجرا، پیش‌شرط‌های عملیاتی با Probeهای فقط‌خواندنی بررسی شدند و در
> [`docs/evidence/adr-055/fresh-run-campaign-launch-readiness-2026-09-16.md`](docs/evidence/adr-055/fresh-run-campaign-launch-readiness-2026-09-16.md)
> ثبت شدند. **قاعدهٔ Fail-Closed از پیش:** فقط اگر هر ۱۲ سطر `VERIFIED` باشند GO. **نتیجه: NO-GO.** `VERIFIED`:
> احراز هویت (`gh auth status` سالم؛ Scopeهای `repo`/`workflow`، بی `user`)، هویت شاخه/Commit (`HEAD` = upstream =
> Head ‏PR #44 = `3f5cd8b`)، فعال بودن Actions، و پشتیبانی Matrix ۵۹تایی (سقف مستند GitHub ۲۵۶ Job در هر اجرا).
> `BLOCKED`: شبکه (`api.github.com` پنج از پنج Probe و همهٔ فراخوان‌های فراداده سالم، ولی
> `*.blob.core.windows.net` در `gh run download`، Zip ‏Artifact و Log تک‌Job هر سه Timeout اتصال)، صورت‌حساب
> (Endpointهای Billing کاربر HTTP 404 به‌دلیل نبود Scope ‏`user`؛ Scope درخواست نشد؛ مجوز صاحب حساب برای هزینه
> ثبت نشده)، و بازیابی Artifact. `UNVERIFIED`: هم‌زمانی مؤثر (Plan حساب `null`؛ جدول مستند فقط سقف هر Plan است)،
> رفتار صف (بزرگ‌ترین هم‌زمانی ثبت‌شده ۵ Job با تأخیر صف ۱–۲ ثانیه)، هم‌سنجی Image (همهٔ Jobهای امروز روی
> `20260907.300.1`، ولی انتشار هفتگی و بی Pin نسخه)، منع Retry در سطح Job (Workflow هنوز وجود ندارد؛ Harness ‏۵۲/۵۲)،
> و شمارش ۵۹ اندیس از محتوا (متن گزارش کالیبراسیون **اندیس Slot ندارد**). **Fallback بازیابی از Log:** آرشیو Log
> سطح Run اجرای `35048202361` دانلود شد و متن بازیابی‌شده با `induced-calibration-0015cpu-github-2026-09-16.txt`
> **بایت‌به‌بایت** یکی بود (SHA-256 ‏`06150071…`)، اما چون آن فایل خودش از Log بازیابی شده بود این فقط تکرارپذیری
> است، و مرز پایان گزارش از فایل مرجع آمد؛ پس Fallback همچنان تأییدنشده است. **هزینه بازمحاسبه شد:** انتظار
> `59 × 425.06 s ≈ 417.98` دقیقهٔ Job، بدترین حالت کراندار Harness ‏`2269.53`، سقف `2655` دقیقهٔ Job. پوشهٔ موقت
> دانلود بیرون از Repository ساخته و دقیقاً همان حذف شد. **هیچ کمپین، Workflow، اندازه‌گیری، Rerun، Docker/PostgreSQL
> یا تغییر Credential رخ نداد**؛ طراحی Pre-Register شده، Artifactهای شواهد، Scriptها، `ci.yml`،
> `docs/14-testing-strategy.md`، `docs/24-open-questions.md` و `planning/backlog.json` دست نخوردند. سرتیتر ADR-055
> که هنوز «۳۶ آزمون» می‌گفت به **۵۲** (۳۶ Helper + ۱۶ CLI) اصلاح شد؛ شمارش‌های تاریخ‌دار حفظ شدند. `COM-009` همچنان
> `READY`/۱۳، ADR-053 و ADR-055 همچنان `Proposed`؛ AUD-004 باز است.
>
> **به‌روزرسانی 2026-09-16 (ADR-055 — اتصال گزارش کالیبراسیون به Slot کمپین و شمارش Fail-Closed؛ سطر ۱۲
> دروازه، حکم همچنان NO-GO):** `--calibrate` اکنون `--slot <1..59>` را الزامی می‌داند (بدون `--calibrate` رد
> می‌شود). غایب/تکراری/خالی/علامت‌دار/اعشاری/صفر پیشرو/صفر/بیرون از بازه پیش از هر بررسی پیش‌نیاز رد می‌شود.
> `--pairs` و بازهٔ ۱..۲۰ دست نخوردند. هر گزارش کالیبراسیون (ردشده یا اندازه‌گیری‌شده) سطر سوم
> `campaign_slot=<n>` را دقیقاً یک بار دارد و گزارش Legacy ‏evidence بایت‌به‌بایت همان است (SHA-256 رندر
> پیش از تغییر). ابزار تازهٔ `pnpm run account:aggregation-campaign`
> (`scripts/aggregation-campaign-accounting.mjs` + کتابخانهٔ خالص) هر اندیس `1..59` را فقط از محتوا به
> non-event / event / blocker / missing (§§ 5.2 و 8.4 طراحی) می‌برد. Slot غایب/تکراری/بدشکل/بیرون از بازه،
> گزارش ناقص یا ویرایش‌شده، ورودی اضافه و ناسازگاری Commit یا Topology به missing یا ورودی ردشده می‌رسند.
> ترتیب و نام فایل اثری ندارد، نتیجهٔ Job خوانده نمی‌شود، `sum == 59` چاپ و بررسی می‌شود، و خروج `0` فقط برای
> کمپین کامل و سازگار بی Blocker و بی Missing است. `otherDatabaseError` صریحاً blocker (طبقه‌بندی‌نشده) خوانده
> شد، نه رخداد. بازخوانی سهمیه هنوز در محتوای گزارش نیست (Job بی گزارش ← missing). آزمون‌ها: مجموعهٔ
> `test:aggregation-evidence-lib` از ۵۲ به **۵۷/۵۷** (۳۷ Helper + ۲۰ CLI) و مجموعهٔ تازهٔ
> `scripts/aggregation-campaign-accounting.test.mjs` ‏**۱۷/۱۷** (بیرون از `pnpm verify` و CI). ۱۴ جهش دستی
> روی منطق شمارش اجرا شد: ۱۳ شکار شد و تنها بازمانده یک نگهبان خط‌پایانِ زائد بود که بررسی Footer هم آن را
> پوشش می‌دهد. سند Preregistration فقط در Invocation (§ 7، § 8.3) و توصیف فرمان شمارش (§ 8.4) به‌روز شد و هیچ
> مقدار طراحی تغییر نکرد. سطر ۱۲ سند آمادگی `VERIFIED` شد؛ سطرهای ۲ و ۶ تا ۱۱ حل‌نشده‌اند، پس **NO-GO**. هیچ
> کمپین، Workflow، اندازه‌گیری، فراخوان GitHub، Docker/PostgreSQL، `ci.yml`، فازهای تست یا Backlog تغییر نکرد.
> `COM-009` همچنان `READY`/۱۳، ADR-053 و ADR-055 همچنان `Proposed`؛ AUD-004 باز است.
>
> **به‌روزرسانی 2026-09-16 (ADR-055 — پیش‌نویس غیراجرایی Workflow کمپین ۵۹ Slot و بررسی ایستای منع Retry؛ سطر
> ۱۱ همچنان `UNVERIFIED`، حکم NO-GO):** پیش‌نویس
> `docs/evidence/adr-055/fresh-run-campaign-workflow-draft-2026-09-16.yaml.txt` بیرون از `.github/workflows/`
> است و پسوند `.yaml.txt` دارد، پس قابل کشف نیست. محتوایش: یک Job، Matrix لفظی `1..59`، `fail-fast: false`،
> `ubuntu-24.04`، ۴۵ دقیقه، `contents: read`، `cancel-in-progress: false`، و گام نخستی که پیش از Checkout خارج
> می‌شود مگر `github.run_attempt == 1`. بعد یک اجرای `--pairs 1 --slot "${{ matrix.slot }}"` با کد خروج
> بازگردانده، Upload با `if: always()` و Actionهای Pin شده به SHA کامل. ابزار دستی
> `pnpm run check:aggregation-campaign-workflow -- <draft>` (`scripts/aggregation-campaign-workflow.mjs` +
> کتابخانهٔ خالص) با Parser باریک همان زیرمجموعه کار می‌کند و کلید تکراری یا ساختار ناآشنا را رد می‌کند. کل
> قرارداد را معنایی بررسی می‌کند؛ خروج `0/1/2` است و مسیر چاپ نمی‌شود. آزمون تازهٔ
> `scripts/aggregation-campaign-workflow.test.mjs` ‏**۱۷/۱۷** است و بیرون از `pnpm verify` و CI می‌ماند. ۳۱ جهش
> دستی روی کتابخانه اجرا شد: ۳۰ شکار شدند و تنها بازمانده (بررسی مسیر Trigger) با دو آزمون تازه شکار شد. سطر
> ۱۱ **`UNVERIFIED` می‌ماند** به سه دلیل: Workflow نصب‌شده بازبینی نشده، Retry درونی GitHub ایستا اثبات‌پذیر
> نیست، و Push دوم `run_attempt` را دوباره `1` می‌کند. سطرهای ۲ و ۶ تا ۱۱ حل‌نشده‌اند، پس **NO-GO**. § 8.3 طراحی
> فقط به پیش‌نویس و فرمان اشاره می‌کند و هیچ مقدار طراحی تغییر نکرد. هیچ کمپین، نصب Workflow، اندازه‌گیری،
> فراخوان API ‏GitHub، Docker/PostgreSQL، `ci.yml`، فازهای تست یا Backlog تغییر نکرد. `COM-009` همچنان
> `READY`/۱۳، ADR-053 و ADR-055 همچنان `Proposed`؛ AUD-004 باز است.
>
> **به‌روزرسانی 2026-09-16 (ADR-055 — بازیابی آفلاین و بی‌مرجع گزارش کالیبراسیون از Log ‏Job؛ سطر ۱۰ همچنان
> `BLOCKED`، حکم NO-GO):** ابزار دستی `pnpm run recover:aggregation-campaign-logs -- <job-log> …`
> (`scripts/aggregation-campaign-log-recovery.mjs` + کتابخانهٔ خالص) گزارش‌ها را فقط میان Header و Footer
> کالیبراسیون پیدا می‌کند و به طول سطر مرجع، نام، ترتیب، نتیجهٔ Job یا رنگ کاری ندارد. فقط پیشوند
> `YYYY-MM-DDThh:mm:ss.fffffffZ ` (یکنواخت، بی اختلاط) و CR ِ CRLF را حذف می‌کند و Newline پایانی را بازمی‌گرداند.
> Footer یتیم، Header تودرتو، گزارش ناتمام، Timestamp بدشکل/تکراری/مخلوط، مرز در قاب ناشناخته و کاراکتر کنترلی
> (ANSI/NUL/Tab/BOM) را رد می‌کند. سقف‌های نام‌دار `LOG_RECOVERY_LIMITS` (۱۲۸ Log، ۶۴/۲۵۶ MiB، ۵۹ گزارش، ۲۰۰ سطر/۳۲
> KiB) هرگز نمی‌برند و فقط رد می‌کنند. هر نامزد از `parseSlotReport` بی‌تغییر می‌گذرد و نتیجه به `accountCampaign`
> و `formatAccounting` بی‌تغییر می‌رود. خروج `0` فقط با صفر رد و شمارش کامل است (`1` برای بقیه، `2` خطای
> استفاده) و مسیر یا محتوای Log چاپ نمی‌شود. آزمون تازه ‏**۱۷/۱۷** (قاب Log **ساختگی**، نه نمایش روی اجرای
> واقعی) و بیرون از `pnpm verify` و CI است. ۲۶ جهش دستی زده شد: ۲۵ شکار شد و بازماندهٔ مرتب‌سازی با Assertion
> تازه شکار شد. نقطه‌گذاری تصادفی `yet.;` سطر ۱۱ اصلاح شد. سطر ۱۰ **`BLOCKED` می‌ماند**: برابری با بایت‌های
> Artifact، نمایش روی آرشیو واقعی چند-Job، دسترس‌پذیری آینده و دانلود مستقیم Artifact هنوز باز است. سطرهای ۲ و ۶
> تا ۱۱ حل‌نشده‌اند، پس **NO-GO**. هیچ دانلود، فراخوان شبکه/GitHub، Workflow، کمپین، Docker/PostgreSQL، `ci.yml`،
> فازهای تست یا Backlog تغییر نکرد. `COM-009` همچنان `READY`/۱۳، ADR-053 و ADR-055 همچنان `Proposed`؛ AUD-004 باز
> است.
>
> **به‌روزرسانی 2026-09-16 (ADR-055 — قرارداد بازبینی Cohort ‏Runner/Image؛ سطر ۹ همچنان `UNVERIFIED`، حکم
> NO-GO):** ابزار دستی `pnpm run review:aggregation-campaign-image-cohort -- <review-manifest> <report> …`
> (`scripts/aggregation-campaign-image-cohort.mjs` + کتابخانهٔ خالص) دو نیمهٔ جدا دارد: (۱) Manifest ‏JSON پیش از
> اجرا با ۹ فیلد ثابت (`schema` ‏`adr-055-image-cohort-review/v1`، `observed_at`، `runner_label` ‏`ubuntu-24.04`،
> Release و زمان انتشار فعلی و قبلی `ubuntu24/…`، تأیید `true` برای Branch C در ناسازگاری Topology، و
> `campaign_commit`) که فقط شکل و ترتیب زمانی درونی‌اش بررسی می‌شود (UTC ثانیه‌ای، نه پس از زمان بازبینی، قبلی <
> فعلی ≤ مشاهده؛ فیلد تکراری در متن خام/ناشناخته/غایب/نوع نادرست رد؛ بدون نسخه، پنجرهٔ Rollout یا بیشینهٔ عمر در
> کد)؛ (۲) عبور ۵۹ گزارش از `accountCampaign`/`parseSlotReport` بی‌تغییر و الزام شمارش کامل، یک Commit برابر
> Manifest و یک Topology اندازه‌گرفته. فقط آن‌گاه `COHORT: CONSISTENT` (خروج `0`)، وگرنه `COHORT: BRANCH C` (`1`)
> و خطای استفاده `2`. مسیر، مقدار Manifest و شمار رخداد چاپ نمی‌شود و کتابخانهٔ شمارش تغییری نکرد. آزمون تازه
> ‏**۱۵/۱۵** (Manifest **ساختگی**) با Assertionهای جهش‌گونه برای فیلد بی‌اعتنا و رأی اکثریت؛ ۲۲ جهش دستی، ۲۰ شکار،
> یک بازمانده با Assertion تازه شکار و یکی هم‌ارز. بیرون از `pnpm verify` و CI. سطر ۹ **`UNVERIFIED` می‌ماند**:
> Snapshot واقعی پیش از اجرا و بررسی ۵۹ گزارش واقعی هنوز انجام نشده، برابری Manifest با وضعیت واقعی GitHub اثبات‌پذیر
> نیست، Image قابل Pin نیست و ۵۹ سطر یکسان `runner_image=unknown` هم یک Topology شمرده می‌شود. سطرهای ۲ و ۶ تا ۱۱
> حل‌نشده‌اند، پس **NO-GO**. هیچ دانلود، فراخوان شبکه/GitHub، Workflow، کمپین، Docker/PostgreSQL، `ci.yml`، فازهای
> تست یا Backlog تغییر نکرد. `COM-009` همچنان `READY`/۱۳، ADR-053 و ADR-055 همچنان `Proposed`؛ AUD-004 باز است.
>
> **به‌روزرسانی 2026-09-16 (ADR-055 — قرارداد بستهٔ Preflight اجرا با پیوند بایتی؛ حکم NO-GO):** ابزار دستی
> `pnpm run check:aggregation-campaign-preflight -- <launch-record> <workflow-snapshot> <image-cohort-manifest>`
> (`scripts/aggregation-campaign-preflight.mjs` + کتابخانهٔ خالص) دقیقاً سه فایل را پس از بررسی اندازه بایتی
> می‌خواند و چیزی نمی‌نویسد. Launch Record ‏JSON تخت با ۱۰ فیلد ثابت است (`schema`
> ‏`adr-055-launch-preflight-record/v1`، `campaign_commit`، SHA-256 ِ Workflow و Manifest، `primary_retrieval`
> ‏`per-slot-uploaded-artifacts` و پنج تأیید `true` برای `run_attempt == 1`، نااهلی Rerun/Retry/Re-dispatch، Fallback
> آرشیو Log، نابرابری اثبات‌نشدهٔ آن با بایت Artifact و اثبات‌نشدگی دسترس‌پذیری بازیابی) و با Scanner خام Manifest
> ‏Cohort (صادرات تازهٔ `parseFlatJsonObject`) خوانده می‌شود. `PREFLIGHT: COMPLETE` (خروج `0`) فقط با Record پذیرفته،
> برابری SHA-256 بایت‌های دقیق هر دو فایل (بی نرمال‌سازی)، گذر `validateWorkflowDraft` و `validateCohortManifest`
> بی‌تغییر در زمان اجرای فرمان، و برابری Commit ِ Record با Manifest؛ وگرنه `PREFLIGHT: REJECTED` (`1`) و خطای
> استفاده `2`. مسیر، Digest، Commit، زمان یا محتوا چاپ نمی‌شود. آزمون تازه **۱۲/۱۲** با پیش‌نویس ثبت‌شده و Record/
> Manifest **ساختگی**؛ ۱۴ جهش منبع (پیوندهای Digest، Hash نرمال‌شده، پیوند Commit، دو اعتبارسنج، تأییدها) شکار شد؛
> از ۱۲ جهش دستی دیگر ۱۱ شکار و یکی هم‌ارز. بیرون از `pnpm verify` و CI. هیچ Launch Record یا Manifest واقعی وجود
> ندارد و نصب Snapshot، Retry درونی GitHub، `run_attempt` واقعی، دسترس‌پذیری Artifact/آرشیو و برابری بایتی بازیابی
> اثبات نشده است. سطر ۹ `UNVERIFIED`، سطر ۱۰ `BLOCKED`، سطر ۱۱ `UNVERIFIED`، سطرهای ۲/۶/۷/۸ حل‌نشده، پس **NO-GO**.
> هیچ دانلود، فراخوان شبکه/GitHub، نصب یا اجرای Workflow، کمپین، Docker/PostgreSQL، `ci.yml`، فازهای تست یا Backlog
> تغییر نکرد. `COM-009` همچنان `READY`/۱۳، ADR-053 و ADR-055 همچنان `Proposed`؛ AUD-004 باز است.
>
> **به‌روزرسانی 2026-09-17 (ADR-055 — اصلاح سند Rollout و Runbook اجرای کمپین؛ فقط سند، حکم NO-GO):** بخش Rollout
> ‏ADR-055 دیگر نمی‌گوید «Preflight ساخته نشده» بی‌تفکیک: Preflight فاز (§ ۲ تا § ۴) همچنان ساخته نشده، ابزارهای دستی/
> آفلاین کمپین (از جمله بستهٔ Preflight اجرای `130b056`) وجود دارند، هیچ‌کدام دروازهٔ خودکار CI/زمان اجرا نیست یا چیزی
> نصب/اجرا نمی‌کند، و Fail-Fast همچنان به پذیرش ADR و شواهد کالیبره وابسته است. سند آمادگی § ۱۳ یک Runbook ترتیبی و
> Fail-Closed گرفت: Gate 0 (شواهد زندهٔ تازه و `VERIFIED` برای سطرهای ۲/۶/۷/۸: مجوز Scope از مالک، Billing، مجوز
> سقف ۲۶۵۵ Job-Minute، هم‌روندی مؤثر، صف، مسیر بازیابی از محیط اجرا)، Gate 1 (تصمیم ثبت‌شده)، گام‌های L1 تا L15 با
> فرمان‌های دقیق `package.json` و برچسب `[manual/live]` برای هر عمل بی‌ابزار، قواعد Abort و ماتریس شواهد. یافتهٔ
> بازرسی: گزارش `commit=` را از `git rev-parse HEAD` می‌گیرد، پس `campaign_commit` همان Commit محلیِ Push‌نشده‌ای است که
> Workflow را می‌افزاید و Manifest/Record پس از آن ساخته می‌شوند؛ و چون بازیابی Log فایل گزارش نمی‌نویسد، Slot ِ
> وابسته به Fallback با ابزارهای موجود به Branch A/B نمی‌رسد. هیچ واقعیت زنده‌ای ثابت نشد و هیچ وضعیتی تغییر نکرد:
> سطر ۹ `UNVERIFIED`، سطر ۱۰ `BLOCKED`، سطر ۱۱ `UNVERIFIED`، سطرهای ۲/۶/۷/۸ حل‌نشده، **NO-GO**. کد، Workflow، آزمون،
> Preregistration و Backlog دست نخوردند. `COM-009` همچنان `READY`/۱۳، ADR-053 و ADR-055 همچنان `Proposed`؛ AUD-004 باز است.
>
> **به‌روزرسانی 2026-09-17 (ADR-055 — نوشتن اختیاری گزارش‌های بازیابی‌شده از Log؛ حکم NO-GO):** فرمان
> `recover:aggregation-campaign-logs` شکل اختیاری `--output-dir <new-directory>` گرفت. شکل فقط‌خواندنی بی‌تغییر است
> و چیزی نمی‌نویسد. فقط با بازیابی تمیز و شمارش کامل ۵۹ Slot، فایل‌های `slot-01.txt` تا `slot-59.txt` نوشته
> می‌شوند: نام از Slot پذیرفته‌شدهٔ `parseSlotReport`، بایت دقیقاً همان رشتهٔ بازیابی‌شده. مقصد موجود به هر شکل
> (فایل، پوشه، Link یا Junction) رد می‌شود. نوشتن در Staging یکتا درون والد، با ایجاد انحصاری `wx`، خواندن دوباره و
> یک `rename` انجام می‌شود. در شکست فقط وضعیت خود فرمان پاک می‌شود و هیچ مقصدی بازنویسی یا حذف نمی‌شود؛ رقابت پوشهٔ
> خالی روی POSIX ثبت شد. آزمون Log-Recovery ‏**۲۶/۲۶** (۱۷ پیشین + ۹ تازه، با Fake فایل‌سیستم تزریقی و CLI واقعی در
> پوشهٔ موقت). آزمون سرتاسری **ساختگی** نشان داد شمارش (`COMPLETE`) و بازبینی Cohort با Manifest ساختگی
> (`COHORT: CONSISTENT`) فایل‌ها را بی‌تغییر می‌پذیرند. پنج فایل آزمون کمپین **۸۷/۸۷**. Runbook § ۱۳ (L11، L12،
> Abort، ماتریس) و § ۱۴ سند آمادگی به‌روز شدند. برابری بایتی با Artifact، دسترس‌پذیری آرشیو واقعی و بازیابی واقعی
> ۵۹ Job همچنان اثبات‌نشده‌اند. سطر ۹ `UNVERIFIED`، سطر ۱۰ `BLOCKED`، سطر ۱۱ `UNVERIFIED`، سطرهای ۲/۶/۷/۸
> حل‌نشده، **NO-GO**. هیچ Workflow، کمپین، دانلود، فراخوان GitHub/شبکه، `ci.yml`، فاز تست یا Backlog تغییر نکرد.
> `COM-009` همچنان `READY`/۱۳، ADR-053 و ADR-055 همچنان `Proposed`؛ AUD-004 باز است.
>
> **به‌روزرسانی 2026-09-17 (ADR-055 — مقایسهٔ اختیاری بایتی بازیابی Artifact و Fallback؛ حکم NO-GO):** فرمان دستی و
> فقط‌خواندنی `compare:aggregation-campaign-retrievals -- --artifacts <report> ... --fallback <report> ...` افزوده شد.
> هر دسته جداگانه با `accountCampaign`/`parseSlotReport` بی‌تغییر سنجیده می‌شود (۵۹ ورودی، شمارش کامل، یک Commit، یک
> Topology، پیوند یک‌به‌یک Slot) و سپس بایت‌های دقیق هر Slot با `Buffer.equals` مقایسه می‌شوند؛ بدون نرمال‌سازی و بی‌توجه به
> نام یا ترتیب فایل. `MATCH` خروج `0`، `DIFFERENT` و `REJECTED` خروج `1`، خطای استفاده `2` پیش از هر خواندن. خروجی فقط
> شمارش و جمله‌های ثابت است. `MATCH` فقط برابری بایت‌های ارائه‌شده است، نه اصالت یا دسترس‌پذیری منبع. Runbook § ۱۳
> (L11 تا L13، Abort، ماتریس) و § ۱۵ سند آمادگی و ADR-055 به‌روز شدند: مقایسه اختیاری است و اگر اجرا شود، نتیجهٔ غیر
> `MATCH` با آمیختن منابع ترمیم نمی‌شود و به Branch A/B نمی‌رسد. آزمون تازه **۱۲/۱۲** و شش فایل آزمون کمپین **۹۹/۹۹**،
> همه ساختگی؛ **هیچ مقایسهٔ زندهٔ Artifact/Log انجام نشد.** روی Windows، ۱۱۸ مسیر بلند ممکن است از سقف خط فرمان `cmd.exe`
> در `pnpm run` بگذرد؛ آنگاه `node scripts/aggregation-campaign-retrieval-comparison.mjs` مستقیم اجرا شود. سطر ۹
> `UNVERIFIED`، سطر ۱۰ `BLOCKED`، سطر ۱۱ `UNVERIFIED`، سطرهای ۲/۶/۷/۸ حل‌نشده، **NO-GO**. هیچ Workflow، کمپین، دانلود،
> فراخوان GitHub/شبکه، `ci.yml`، فاز تست، آستانه یا Backlog تغییر نکرد. `COM-009` همچنان `READY`/۱۳، ADR-053 و ADR-055
> همچنان `Proposed`؛ AUD-004 باز است.
>
> **به‌روزرسانی 2026-09-17 (ADR-055 — Manifestهای کراندار برای مقایسه‌گر بازیابی؛ حکم NO-GO):** برای رفع سقف ۸۱۹۱
> نویسهٔ `cmd.exe` در `pnpm run` روی Windows، `compare:aggregation-campaign-retrievals` شکل
> `--artifacts-manifest <file> --fallback-manifest <file>` گرفت و شکل مسیرهای صریح حفظ شد (آمیختن دو شکل خروج `2`).
> Manifest: UTF-8 سخت بدون BOM، حداکثر ۶۰٬۴۷۵ بایت، دقیقاً ۵۹ خط LF‌دار، هر خط یک مسیر ۱ تا ۱۰۲۴ بایتی بدون CR/کنترل،
> فاصلهٔ حاشیه، `-`/`#`/نقل‌قول، URL یا `C:name`. خط نسبی نسبت به پوشهٔ همان Manifest resolve می‌شود. اندازه پیش و پس از
> خواندن سنجیده می‌شود و هر شکست Manifest با پیام ثابت و بدون خواندن هیچ گزارشی خروج `2` می‌دهد. مسیر تکراری درون یک
> دسته (برای مسیرهای صریح تازه) یا مشترک میان دو دسته در هر دو شکل خروج `2` می‌دهد؛ روی Windows بی‌اعتنا به بزرگی حروف و
> نقطه/فاصلهٔ پایانی، بدون بررسی هویت فایل‌سیستمی. اعتبارسنجی دسته‌ها و `Buffer.equals` بی‌تغییرند. Manifest فقط انتقال
> مسیر است، نه شاهد. آزمون **۲۱/۲۱** (۱۲ + ۹) و شش فایل آزمون کمپین **۱۰۸/۱۰۸**، همه ساختگی. اجرای واقعی
> `pnpm run` در شکل Manifest با ۱۱۸ مسیر بلند (حدود ۲۱ هزار نویسه اگر یک‌به‌یک داده می‌شد) `MATCH`، `DIFFERENT` یک‌بایتی،
> `REJECTED`، و خروج `2` برای Manifest خراب و آمیختن دو شکل داد، بی‌تغییر فایل و بی‌نشت. **هیچ Manifest یا مقایسهٔ واقعی
> وجود ندارد.** Runbook § ۱۳ (L11، ماتریس)، § ۱۶ سند آمادگی و ADR-055 به‌روز شدند. سطر ۹ `UNVERIFIED`، سطر ۱۰
> `BLOCKED`، سطر ۱۱ `UNVERIFIED`، سطرهای ۲/۶/۷/۸ حل‌نشده، **NO-GO**. هیچ Workflow، کمپین، دانلود، فراخوان GitHub/شبکه،
> `ci.yml`، فاز تست، آستانه یا Backlog تغییر نکرد. `COM-009` همچنان `READY`/۱۳، ADR-053 و ADR-055 همچنان `Proposed`؛
> AUD-004 باز است.
>
> **به‌روزرسانی 2026-09-13 (Seriesهای صفر برای هشدارهای شمارنده — رفع نقطهٔ کور نخستین افزایش):** `prom-client` Series
> برچسب‌دار را فقط با نخستین مقدار صادر می‌کند، پس نخستین رخدادِ هر ترکیب پس از شروع فرایند با ۱ متولد و از `increase` پنهان
> می‌ماند. اکنون هر ترکیب کرانداری که هشداری را می‌راند با `inc(labels, 0)` از پیش با صفر صادر می‌شود (صفر اضافه می‌کند، پس
> شمارش واقعی را پاک نمی‌کند؛ محل‌های افزایش واقعی دست نخوردند): `initializeAuditAlertSeries()` در
> `services/audit-service/src/observability/metrics.ts` هنگام بار شدن ماژول — ۸ مقدار `INGESTION_FAILURE_REASONS` و ۶ × ۲
> ترکیب `DIVERGENCE_REASON_VALUES` × `VERIFICATION_SCOPE_LABELS` (`organization|platform`؛ Import یک‌طرفه از
> `audit.verification.view.ts`)؛ `initializeSecurityEventAlertSeries()` در `identity-service` — فقط `failed`/`timeout` و هر دو
> `SECURITY_EVENT_PUBLISH_FAILURE_REASONS`؛ و `EventConsumer` مشترک در Constructor، **فقط با `deadLetterTopic`** —
> `clientId` × هر Topic مبدأ × پنج `DLQ_REASONS`، بی اتصال Kafka. آزمون‌ها Exposition واقعی (`metricsText()`/Registry) را
> می‌خوانند: audit ۳ آزمون (۲۲ مجموعه / ۶۲۱)، identity فایل تازهٔ `security-event.metrics.spec.ts` با ۳ آزمون (۱۹ / ۷۱۲)،
> nest-common ۳ آزمون (۸ / ۱۴۳) — صفرِ دقیق هر ترکیب، نبود Series برای مصرف‌کنندهٔ بی DLQ، و پاک نشدن شمارش واقعی با
> مقداردهی دوباره؛ پنج جهش (حذف هر فراخوان، مقداردهی بی DLQ، حذف پیش از مقداردهی) هر پنج را شکست دادند. Fixture
> `promtool` اکنون `scope` کوچک تولیدی را به کار می‌برد و گروه تازهٔ «صفر → نخستین رخداد» هر پنج هشدار شمارنده را اثبات
> می‌کند (و یک کنترلِ Series متولدشده با ۱ که هشدار نمی‌دهد)؛ بی صفرِ پیشین همان پنج ارزیابی شکست خوردند. قواعد، آستانه‌ها و
> Annotationها بی‌تغییرند. **هنوز نیست:** Alertmanager و تحویل اعلان، داشبورد، Scrape محیط واقعی، هشدار Lag کافکا یا عمق
> Topic DLQ (Lag دو گروه `audit-service.*` و عمق نگه‌داشتهٔ `rasta.audit.v1.dlq` در به‌روزرسانی بالاتر همان روز افزوده شدند)،
> ابزار بازپخش و تشخیص رکورد غایب؛ S-06، AUD-004 و COM-009 بسته نمی‌شوند (`COM-009` همچنان `READY`/۱۳ و ADR-053
> `Proposed`).
>
> **به‌روزرسانی 2026-09-13 (قواعد هشدار Prometheus زنجیرهٔ شواهد حسابرسی — فقط محلی):** فایل
> `infrastructure/docker/prometheus/rules/rasta-audit-alerts.yml` (گروه `rasta-audit-evidence`) با `rule_files` در
> `prometheus.yml` بار و پوشهٔ `rules` فقط‌خواندنی در سرویس `prometheus` Compose (همان `prom/prometheus:v3.1.0`) Mount شد.
> شش هشدار، هرکدام با `severity`، `summary`/`description` و Annotation `runbook` نسبی به مخزن:
> `RastaDeadLetterMessagePublished` (`warning`، `sum by (service, topic, reason) (increase(rasta_dlq_messages_total[5m])) > 0`)،
> `RastaAuditIngestionFailure` (`warning`، `sum by (reason)` روی `rasta_audit_ingestion_failures_total`)،
> `RastaAuditChainDivergence` (`critical`، `sum by (reason, scope)` روی `rasta_audit_chain_verification_failures_total`)،
> `RastaSecurityEventCaptureGap` (`critical`، `sum by (outcome)` روی `rasta_security_event_captures_total{outcome=~"failed|timeout"}`)،
> `RastaSecurityEventClosedBacklogStale` (`warning`، `rasta_security_event_outbox_closed_backlog_age_seconds > 60` — نه
> `pending_age`) و `RastaSecurityEventPublishFailure` (`warning`، `sum by (reason)` روی
> `rasta_security_event_publish_failures_total`). هشدارهای شمارنده `increase(…[5m]) > 0` و بی `for`اند؛ هیچ Label یا
> Annotation شناسهٔ مستأجر/Actor/منبع/رویداد/Correlation/Partition/Offset یا متن خطا ندارد. **شواهد:**
> `promtool check config` → `SUCCESS: 1 rule files found` و `SUCCESS: 6 rules found`، خروج ۰؛
> `promtool test rules infrastructure/docker/prometheus/tests/rasta-audit-alerts.test.yml` (هفت گروه آزمون: شش هشدار با افزایش
> واقعی شمارنده، Labelهای دقیق، رفع پس از خروج از پنجره، و کنترل‌های منفی شمارندهٔ ثابتِ غیرصفر، `recorded`/`skipped`، سن ≤ ۶۰
> و `pending_age` کهنه) → `SUCCESS`، خروج ۰؛ هشت جهش عمدی قاعده (حذف فیلتر `outcome`، `>= 60`، `pending_age`، شمارندهٔ مطلق
> در دو هشدار، Label اضافه/کم، شدت غلط) هر هشت را آزمون گرفت؛ حذف فایل قاعده `check config` را با خروج ۱ شکست داد؛ و
> Prometheus زندهٔ Compose هر شش قاعده را از `/etc/prometheus/rules/rasta-audit-alerts.yml` با `health=ok` بار کرد و
> `activeAlertmanagers` تهی بود. Job مستقل CI `prometheus-rules` هر دو فرمان `promtool` را روی PR و `main` اجرا می‌کند.
> **محدودیت تأییدشده:** Series برچسب‌دار `prom-client` با مقدار ۱ متولد می‌شود، پس نخستین رخدادِ هر ترکیب Label پس از شروع
> فرایند هشدار نمی‌دهد (مقداردهی صفر در کد، گامی جدا — در به‌روزرسانی بعدی همان روز انجام شد). **هنوز نیست:** Alertmanager و هر تحویل اعلان، داشبورد، Scrape محیط
> واقعی، هشدار Lag کافکا یا عمق Topic DLQ (برای دو گروه حسابرسی و `rasta.audit.v1.dlq` بعدتر همان روز افزوده شد)، ابزار
> بازپخش DLQ و تشخیص رکورد حسابرسیِ غایب. این گام S-06، AUD-004، COM-009 یا
> عملیات‌پذیری محیط واقعی را نمی‌بندد؛ `COM-009` همچنان `READY`/۱۳ و ADR-053 `Proposed`.
>
> **به‌روزرسانی 2026-09-12 (Phase C10 — محل رد نهم، نخستین تصمیم‌گیرندهٔ غیر از دامنه و `RolesGuard`):**
> `identity-service` اکنون **دقیقاً نُه** محل رد دارد. محل تازه ردِ خودِ `AuthGuard` پلتفرم است: Token تأییدشده‌ای که با
> `X-Organization-Id` سازمانی بیرون از عضویت‌هایش را می‌خواهد (`action = identity.tenant_context.select`،
> `resourceType = User`، `resourceId` = شناسهٔ خودِ فراخوان، `organizationId` = **سازمان فعالِ Token** و هرگز Headerِ
> ردشده — تصمیم موقت **Q-52**). **چرا فقط Catch کافی نبود:** این رد پیش از مقداردهی `request.rastaAuth` و پیش از ارتقای
> Context پرتاب می‌شود، پس یک Wrapper هیچ Actor یا مستأجر قابل‌اعتمادی در دست ندارد و تنها مقادیر در دسترسش ورودی مهاجم‌اند.
> پس `packages/nest-common` یک **درز عمومی و اختیاری** گرفت (`AuthGuardOptions.onUserTenantMismatch`): Guard مشترک از
> Tokenی که خودش تأیید کرده می‌گوید چه کسی را رد کرد، و بس. Guard مشترک همچنان تنها مرجع احراز هویت و حل مستأجر است، هیچ
> سرویس دیگری این فیلد را ست نمی‌کند، و همهٔ سیاست حسابرسی در identity ماند (A-03). محل **Route-agnostic** است چون این
> تصمیم پیش از مجوزدهی Controller و روی هر Route محافظت‌شده رخ می‌دهد؛ فیلتر تنها برای همین محل بررسی Route را رد می‌کند و
> بدون انتساب مورد اعتماد چیزی ثبت نمی‌شود. پاسخ `403` بی‌تغییر است (مقایسهٔ مستقیم با `AuthGuard` خام + برابری پاسخ
> `AllExceptionsFilter`). **نکتهٔ توپولوژی:** `api-gateway` همان Guard را یک Hop زودتر اجرا می‌کند و فقط مستأجرِ حل‌شده را
> جلو می‌فرستد، پس Header ناهم‌خوان از راه Gateway اصلاً به identity نمی‌رسد؛ Gateway هنوز Producer نیست (R-2). ثبت،
> تجمیع، Relay، Contract و `audit-service` بی‌تغییرند؛ بدون Migration. **هنوز نیست:**
> `SERVICE_TENANT_CONTEXT_INVALID`/`FORBIDDEN`، ردهای متوقف‌شده در Gateway، رول‌اوت به سرویس‌های دیگر، فرمان اصلاح،
> صادرات، Purge، هشدار Prometheus. `COM-009` همچنان `READY` با ۱۳ امتیاز و ADR-053 `Proposed` است.
>
> **به‌روزرسانی 2026-09-12 (Phase C9 — محل رد هشتم):** `identity-service` اکنون **دقیقاً هشت** محل رد دارد و هیچ Route دارای
> `@Roles` در آن ابزارگذاری‌نشده نمانده. محل تازه: `POST /v1/registration-requests/:id/reject` که `RolesGuard` پلتفرم با
> `403 INSUFFICIENT_ROLE` رد می‌کند (`action = identity.registration_requests.reject`، `resourceType = RegistrationRequest`،
> `resourceId` = شناسهٔ خودِ فراخوان — تصمیم موقت **Q-51**؛ فعل از تأیید جداست). فقط یک ورودی ثابت تازه
> (`REJECT_REGISTRATION_REQUEST`)؛ Guardها، تجمیع، Relay، Contract و `audit-service` بی‌تغییرند؛ بدون Migration. چون دیگر ردِ
> ثبت‌نشده‌ای برای مقایسه نمانده، شاهد «پاسخ بی‌تغییر» اکنون مقایسهٔ مستقیم `RolesGuard` و `IdentityRolesGuard` (همان خطا، همان
> پاسخ HTTP فیلتر پلتفرم، تنها علامت `WeakMap` متفاوت) و سنجش پاسخ دقیق تثبیت‌شده در Integration/E2E است. بودجهٔ Gateway برای
> `registration-requests`: `province.auditor` ۵، `dehyari.admin` ۵، `dehyari.admin.b` ۴. **هنوز نیست:**
> `TENANT_MISMATCH`/`SERVICE_TENANT_CONTEXT_INVALID`/`FORBIDDEN` خودِ AuthGuard، رول‌اوت به سرویس‌های دیگر، فرمان اصلاح،
> صادرات، Purge، هشدار Prometheus. `COM-009` همچنان `READY` با ۱۳ امتیاز و ADR-053 `Proposed` است.
>
> ۲. **هیچ ارائه‌دهندهٔ ایمیل Production و هیچ هویت فرستنده‌ای انتخاب نشده** و تا امروز هیچ پرسش بازی پوششش نمی‌داد (Q-15
> دربارهٔ پیامک است). اکنون **Q-37**. این **انتشار ایمیل واقعی** را مسدود می‌کند، نه پیاده‌سازی و نه نیمهٔ In-App را.
>
> ۳. **کامنت `insurance.service.ts:239-243` غلط است.** ادعا می‌کند تکرار هشدار «با Dedupe خودِ Outbox» جلوگیری می‌شود؛
> `enqueueEvent` یک `create` ساده با ULID تازه می‌زند و `OutboxMessage` هیچ محدودیت یکتایی روی `(aggregateId, eventName)`
> ندارد. Sweep هر ۶ ساعت روی پنجرهٔ ۳۰ روزه یعنی حدود **۱۲۰ `eventId` متمایز برای یک واقعیت**. ADR-054 Dedupe محتوامحور را
> به همین دلیل یک الزام صحت می‌داند، نه یک سخت‌سازی.
>
> `COM-008` و `COM-009` هر دو `READY` با **۱۳ امتیاز** ماندند؛ `planning/backlog.json` و درصدهای پیشرفت دست نخوردند.
>
> **پیشین (2026-08-31):** **Q-18 بسته شد: ClamAV اسکنر بدافزار پلتفرم
> است، و دانلود سند برای نخستین بار کار می‌کند.**
>
> شاخهٔ `feat/document-clamav-scanner` روی `main` (`3b4df26`) ساخته شد و
> **CI هنوز رویش اجرا نشده**. ADR-049 ClamAV خودمیزبان را به‌عنوان Sidecar انتخاب
> می‌کند — پین‌شده به Digest تغییرناپذیر، غیر-root، پشت همان `MALWARE_SCANNER` Port که
> از روز اول برای همین ساخته شده بود.
>
> پیش از این، `NoOpMalwareScanner` هیچ محتوایی باز نمی‌کرد و `NOT_SCANNED` ثبت می‌کرد،
> و `canDownload` فقط `CLEAN` را مجاز می‌شمرد — پس **هیچ سندی در هیچ استقراری قابل
> دانلود نبود**. آن محدودیت عمدی بود، و آنچه هرگز رخ نداد ثبت یک `CLEAN` دروغین بود.
> اکنون اسکن ناهمزمان است (ADR-014 گام ۴): سند `PENDING` ثبت می‌شود، یک Worker شیء را
> از MinIO به clamd جریان می‌دهد، و تنها یک `CLEAN` معتبر دانلود را مجاز می‌کند.
>
> **۳۸۴ تست** در ۱۸ Suite (۲۵۵ واحد + ۱۲۹ یکپارچگی)، Coverage **۹۰٫۲۳٪ Statement /
> ۸۱٫۹۶٪ Branch** در برابر دروازهٔ **بدون‌تغییر** ۷۵٪. EICAR روی **ClamAV واقعی**
> تشخیص داده می‌شود و غیرقابل‌دانلود می‌ماند. E2E محلی **۷۵/۷۵** سبز.
>
> **سه نقص واقعی را همین تست‌ها پیدا کردند** — یکی از آن‌ها Fail-Open بود: خواندن
> محدودشده دقیقاً `maxBytes` می‌خواست، پس یک شیء بزرگ‌تر پیشوند بریده‌ای می‌داد که
> اسکنر `OK` اش می‌کرد. جزئیات در بخش ۷-د.
>
> **یک نقص جدا هم پیدا شد و رفع شد (D-022):** نگهبان تنانت `document-service` نام
> مدل‌های marketplace را داشت، پس هیچ‌چیز را Scope نمی‌کرد. هیچ نشتی از این راه قابل
> دسترس نبود — بررسی‌های صریح پوشش می‌دادند — اما لایه‌ای که A-04 می‌خواهد بی‌اثر بود.
>
> **پیشین (2026-08-30):** بازارگاه و دروازه Coverage آن روی `main`؛ سنجش رسمی پیشرفت
> Repositoryمحور شد.
>
> PR #7 با Merge Commit معمولی وارد `main` شد (`34c37ed`) و شاخهٔ
> `feat/marketplace-service` محلی و Remote حذف شد. CI روی خود `main` کامل سبز است:
> کیفیت، امنیت، Integration، **۶۴ سناریوی E2E** و ساخت/Trivy هر هفت Image، از جمله
> بازارگاه (Run `33278828355`).
>
> `marketplace-service` کاتالوگ، عرضه، سفارش و **نخستین Workflow واقعی Temporal**
> پلتفرم را دارد (ADR-039). پیش از Merge، ۴ Suite و ۴۴ تست یکپارچگی مخصوص بازارگاه
> روی PostgreSQL واقعی سبز شد. E2E چرخهٔ خرید، اعتراض، لغو، جداسازی مستأجر، همبستگی
> رویداد و تسویه را روی Gateway + economic + marketplace + PostgreSQL + Kafka +
> Temporal + Keycloak واقعی اجرا می‌کند.
>
> **شکاف Coverage بازارگاه روی `main` بسته شد (PR #9، Merge Commit `b7513c3`).**
> نخستین اندازه‌گیری واقعی این سرویس، Branch را روی **۴۰٫۰۵٪** نشان داد — نه
> `jest.config.js` اش آستانه‌ای داشت و نه هیچ Job ی در CI با `--coverage` اجرا
> می‌شد. اکنون **۷۷٫۶۲٪** با دروازهٔ اجرایی ۷۵٪، و ۳۶۵ تست به‌جای ۱۹۹. سه نقص
> واقعی را همین تست‌ها پیدا کردند (لغو پیش از Fund، هدر `Idempotency-Key` منتشرنشده
> در OpenAPI، و استثنای دست‌نیافتنی اپراتور پلتفرم). جزئیات در بخش
> «بستن شکاف Coverage بازارگاه».
>
> ADR-044 تا ADR-048 با PR #8 روی `main` هستند و مقصد ۲۲سرویسی، خطوط کسب‌وکار
> کارمزد، بیمهٔ تجاری/Claim، نظام مشارکت/پاداش/رتبه‌بندی و لجستیک معکوس را ثبت
> می‌کنند. هر API، Event یا Workflow تازه در این بخش تا زمان داشتن Evidence در
> Backlog همچنان **PLANNED** است. `design/claude-design` دست‌نخورده است.
>
> **Baseline رسمی پیشرفت:** `planning/backlog.json` نسخه **۲** است و ۴۷ Feature در
> ۱۲ Epic به‌همراه یک لایه **User Story** نگه می‌دارد. Baseline با تأیید مالک محصول
> `APPROVED` شده است. فقط `ACCEPTED` همراه Evidence امتیاز می‌گیرد؛ MVP و محصول
> کامل جدا محاسبه می‌شوند و CI گزارش stale یا Backlog نامعتبر را رد می‌کند.
> واحد حسابداری، **Delivery Unit** است: Feature تجزیه‌شده امتیازش را از راه
> Story‌هایش می‌دهد و هرگز دوباره خودش شمرده نمی‌شود — مجموع امتیاز Story‌ها باید
> دقیقاً برابر برآورد تأییدشدهٔ Feature باشد، پس تجزیه مخرج تأییدشده را تغییر
> نمی‌دهد (`docs/25-progress-governance.md`).
>
> `COM-004` با رویداد `ITEM_DECOMPOSED` و ارجاع تأیید مالک محصول به پنج Story
> تجزیه شد: `DOC-001`..`DOC-005` با ۳+۳+۳+۲+۲ = **۱۳** امتیاز، دقیقاً برابر برآورد
> خود `COM-004`. هر پنج Story و خودِ `COM-004` اکنون `IN_PROGRESS`اند و
> **صفر امتیاز** می‌گیرند؛ پذیرش، تصمیم جداگانهٔ مالک محصول پس از Merge است.
>
> ---
>
> **پیشین — 2026-08-30:** بازارگاه روی شاخهٔ موقت ساخته شده بود، اما هنوز Merge
> نشده بود. این وضعیت با شواهد بالا جایگزین شد.
>
> ---
>
> **پیشین — 2026-08-29 (چهارم):** Q-28 روی `main` رفت، و Q-26 و Q-27 بسته شدند.
>
> PR #5 با یک Merge Commit معمولی وارد `main` شد (`98dd7c0`، هر ۶ Commit اتمیک
> حفظ شد) و CI روی `main` کامل سبز بود — هر ۱۰ Job شامل Trivy روی هر شش Image
> (Run `33259888563`). Branch ‏`fix/internal-tenant-context` محلی و Remote حذف
> شد؛ فقط `main` و `design/claude-design` باقی‌اند.
>
> سپس Q-26 پاسخ گرفت (ADR-036): هویت Aggregate و کلید ترتیب پارتیشن دو مفهوم
> جدا شدند، و هر رویداد متعلق به چرخه‌عمر یک تراکنش کلید `transactionId`
> می‌گیرد. Q-27 هم با یک **سیاست موقت محصول** بسته شد و عمداً هیچ کدی را عوض
> نکرد. کار روی `fix/economic-event-ordering` است و **هنوز Merge نشده**.
>
> ---
>
> **پیشین — 2026-08-29 (سوم):** فاز اقتصادی روی `main` رفت (PR #4، `32a6453`،
> Run `33253629911`) و `economic-service` به `READY_FOR_NEXT_PHASE` رسید. سپس
> Q-28 پاسخ گرفت (ADR-035): تنانت یک فراخوان سرویس‌به‌سرویس از یک Claim امضاشده
> می‌آید، نه از Header.
>
> ---
>
> **پیشین — 2026-08-29 (دوم):** شکاف E2E فاز اقتصادی بسته شد.
> ورودی پیشین این فایل `READY_FOR_NEXT_PHASE` می‌گفت در حالی که `tests/e2e`
> پوشه‌ای خالی بود و `AGENTS.md` § ۷ برای این دامنه E2E سبز می‌خواهد. آن ادعا
> نادرست بود و اکنون اصلاح شده — همراه با سه چیز دیگر که همین کار پیدا کرد:
> آستانه پوشش هرگز سنجیده نمی‌شد (عدد واقعی ۴۴٫۸۴٪ شاخه بود)، هیچ Down
> Migration هرگز اجرا نشده بود، و `purgeExpired` در هر اجرا بی‌صدا شکست
> می‌خورد.
>
> | سطح           | شاهد                                                                     |
> | ------------- | ------------------------------------------------------------------------ |
> | **E2E**       | **۳۷ سناریو** — Gateway + economic + PostgreSQL + Kafka + Keycloak واقعی |
> | **TESTED**    | **۳۰۸** واحد + **۲۵۵** یکپارچگی در economic (پیش‌تر ۲۳۹ + ۱۰۰)           |
> | **COVERAGE**  | Branches **۹۰٫۱۳٪** (آستانه ۹۰٪) · Statements ۹۳٫۸۰٪ · Lines ۹۵٫۷۷٪      |
> | **MIGRATION** | up → down → up، با ادعا بین هر گام                                       |
> | **CI**        | ✅ روی `main`: Run `33253629911`، Commit `32a6453`، هر ۱۰ Job سبز        |
>
> ---
>
> **پیشین — 2026-08-29 (اول):** فاز `economic-service` ساخته شد. هفتمین سرویس،
> و حساس‌ترین دامنه پلتفرم:
>
> | سطح             | شاهد                                                                                              |
> | --------------- | ------------------------------------------------------------------------------------------------- |
> | IMPLEMENTED     | Wallet · Hold · Ledger · Journal · Transaction · PaymentIntent · Commission · Reward · Settlement |
> | TESTED          | **۲۳۹** تست واحد در economic؛ **۶۵۴** در کل Monorepo                                              |
> | INTEGRATION     | **۱۰۰** تست روی PostgreSQL و Kafka **واقعی** — ۹ Suite (مجموع پلتفرم: ۱۷۳)                        |
> | LIVE VERIFIED   | **۲۶ سناریو** از راه Gateway با توکن واقعی Keycloak (بخش ۲۱-ج)                                    |
> | **CI VERIFIED** | **Run `33219920446`، Commit `a36a2cf` روی `main`، هر ۹ Job سبز**                                  |
>
> پنج ADR تازه (۰۳۰ تا ۰۳۴) و چهار بدهی ثبت‌شده (D-013 تا D-016).
>
> **این فاز یک تناقض در خودِ سند معماری پیدا کرد.** `docs/10` § ۱۰٫۳ می‌گوید
> `available = ledger − pending`، و § ۱۰٫۴ یک Journal برای Hold می‌نویسد که حساب
> کیف پول را بدهکار می‌کند. هر دو با هم یعنی مبلغ **دو بار** شمرده می‌شود و
> مانده در دسترس برای کیف پولی سالم منفی می‌شود. حل شد با امانت به‌ازای هر
> سازمان (ADR-034)، و رابطه اکنون یک `CHECK` در پایگاه داده است، نه یک قاعده کد.
>
> **و سه نقص را تست‌ها گرفتند، نه بازبینی:** یک تراکنش تودرتوی Prisma که روی
> دو Connection اجرا می‌شد و Deadlock می‌ساخت؛ یک نمای «دریافت‌کننده» که Filter
> نگهبان مستأجر را با Filter دریافت‌کننده AND می‌کرد و همیشه خالی برمی‌گشت؛ و
> گزارش شکست ناخوانا برای هر ادعای `bigint`.
>
> **نکته‌ای که این فاز اثبات کرد:** وقتی یک Invariant را می‌توان به یک محدودیت
> پایگاه داده تبدیل کرد، باید کرد. `ck_wallet_balances` — نه بررسی Application —
> است که خرج بیش از موجودی را غیرممکن می‌کند؛ بررسی کد فقط پیام خطای خوانا
> می‌سازد.
>
> ---
>
> **پیشین — 2026-08-28:** فاز `maintenance-service` بسته شد. ششمین سرویس، با هر
> پنج سطح تأیید:
>
> | سطح             | شاهد                                                                        |
> | --------------- | --------------------------------------------------------------------------- |
> | IMPLEMENTED     | Schedule · Request · RepairOrder · PartUsage · LaborEntry · MaintenanceCost |
> | TESTED          | ۱۰۲ تست واحد در maintenance؛ **۴۱۵** در کل Monorepo                         |
> | INTEGRATION     | ۴۱ تست روی PostgreSQL و Kafka **واقعی** — بدون Mock (مجموع پلتفرم: ۷۳)      |
> | LIVE VERIFIED   | **۳۵ سناریو** از راه Gateway با توکن واقعی Keycloak (بخش ۲۱-ب)              |
> | **CI VERIFIED** | **Run `33172549841`، Commit `24bef76`، هر ۸ Job سبز (۱۲م ۴۴ث)**             |
>
> سه ADR تازه (۰۲۷، ۰۲۸، ۰۲۹)، دو Open Question تازه (Q-24، Q-25) و دو بدهی ثبت‌شده
> (D-011، D-012).
>
> **دو مسیر مرده پلتفرم زنده شدند.** `fleet-service` از روز نخست
> `USAGE_RECORDED` منتشر می‌کرد **بدون هیچ مصرف‌کننده‌ای**، و
> `MAINTENANCE_STARTED`/`MAINTENANCE_COMPLETED` را مصرف می‌کرد **بدون هیچ
> تولیدکننده‌ای**؛ جدول Projection در `asset-service` هم از قبل ردیف‌های نگهداری
> داشت. هر سه، امروز زنده تأیید شدند (بخش ۲۱-ب).
>
> **نکته‌ای که این فاز اثبات کرد و باید نگه داشته شود:** یک تست همروندی واقعی، یک
> Lost Update را می‌گیرد که هیچ تست تک‌نخی نمی‌تواند. ده ثبت هزینه هم‌زمان روی یک
> دستور تعمیر، پیاده‌سازی «مجموع را افزایش بده» را قابل‌اعتماد می‌شکند و
> پیاده‌سازی «از خطوط بازمحاسبه کن» را نه.

---

## ۱. Project Mission

**رستا** پلتفرمی چندمستأجری برای مدیریت ناوگان، زنجیره تأمین، خدمات و عملیات
عمرانی ۳۲۸ دهیاری استان یزد است. اصول بنیادین (`AGENTS.md`):

- **Asset-Centric** — دارایی، نه کاربر، موجودیت مرکزی است.
- **Organization-Agnostic** — هیچ‌جا «دهیاری» فرض ساختاری نیست؛ `OrganizationType` باز است.
- **Multi-Tenant by Default** — جداسازی در API، DB، Cache، Event.
- **Event-Driven با Transactional Outbox** — بدون Publish مستقیم به Kafka.
- **Database Ownership per Service** — بدون جدول مشترک، بدون Join میان‌سرویسی.
- **Financial Integrity** — دفتر کل دوطرفه، تغییرناپذیر و متوازن — پیاده‌شده در
  `economic-service` (بخش ۷-ج).
- **Configurable Governance** — نرخ کارمزد و مرجع موافقت از پیکربندی، نه Hard-Code.

نقشه کامل: [`AGENTS.md`](AGENTS.md) (قواعد الزام‌آور) و [`CLAUDE.md`](CLAUDE.md)
(راهنمای عملیاتی).

---

## ۲. Current Development Phase

**فاز:** پیاده‌سازی MVP، با ۲۴ سند معماری و ۴۹ ADR ثبت‌شده؛ پنج ADR آخر روی شاخهٔ
مستندات جاری‌اند و هنوز Merge نشده‌اند.

**ترتیب واقعی ساخت تا امروز** (از Git History، نه از برنامه‌ریزی اولیه):

```
1. Monorepo foundation (pnpm + Turborepo + TS strict)
2. packages/contracts, config, logging
3. packages/nest-common (context, auth, tenancy, outbox)
4. Infrastructure (docker-compose: Postgres/Redis/Kafka/Keycloak/MinIO/Temporal)
5. identity-service  ← کامل
6. organization-service  ← کامل
7. CI pipeline + Dockerfiles  ← نوشته شد؛ از 2026-08-27 روی GitHub سبز (بخش ۱۹)
8. api-gateway  ← کامل
9. asset-service  ← کامل (آخرین سرویس ساخته‌شده)
10. packages/nest-common: EventConsumer  ← کامل (زیرساخت مصرف رویداد)
11. سخت‌سازی پیش از fleet: D-005 (CI سبز شد) + D-007 (ثبت‌نام گمنام)
12. fleet-service  ← کامل: کد، تست، و تأیید زنده End-to-End
13. maintenance-service  ← کامل: نخستین سرویسی که هر دو سرِ مسیر رویدادش از قبل منتظر بود
14. economic-service  ← کامل: حساس‌ترین دامنه؛ نخستین سرویسی که یک تناقض در سند
    معماری پیدا کرد و آن را با ADR حل کرد، نه با حدس
15. marketplace-service ← هسته کامل؛ Workflow واقعی Temporal و اتصال اقتصادی
16. marketplace coverage gate ← روی `main` فعال و بالاتر از آستانه ۷۵٪
```

**گام اجرایی بعدی:** فعال‌کردن دروازه Coverage واقعی `economic-service` بدون
کاهش آستانه‌های موجود؛ سپس همگام‌سازی طراحی Economic + Marketplace با Commit دقیق
`main`. اولویت‌های پس از آن از Backlog `planning/backlog.json` خوانده می‌شوند، نه
از یک پاراگراف ثابت در این فایل.

---

## ۳. Current Verified State

این فایل پنج سطح را از هم جدا نگه می‌دارد و هرگز یکی را به‌جای دیگری
نمی‌نویسد:

| سطح               | معنا                                                    |
| ----------------- | ------------------------------------------------------- |
| **IMPLEMENTED**   | کد وجود دارد                                            |
| **TESTED**        | تست خودکار روی آن هست و سبز است                         |
| **LIVE VERIFIED** | در برابر Stack واقعی اجرا و پاسخش مشاهده شد — بدون Mock |
| **CI VERIFIED**   | روی Runner واقعی GitHub Actions اجرا شد و سبز بود       |
| **NOT VERIFIED**  | شواهد غیرمستقیم داریم اما تأیید مثبت نداریم             |
| **PLANNED**       | تصمیم گرفته شده، کد نوشته نشده                          |

| Feature                                                          |                      Implemented                      |      Automated Tests       | Live Verified (2026-08-27)                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | :---------------------------------------------------: | :------------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant Isolation (API)                                           |                          ✅                           |             ✅             | ✅ (403 TENANT_MISMATCH زنده گرفته شد)                                                                                                                                                                                                                                     |
| Tenant Isolation (Database)                                      |                          ✅                           |             —              | ✅ (`permission denied for database` زنده گرفته شد)                                                                                                                                                                                                                        |
| Cross-tenant read → 404                                          |                          ✅                           |             ✅             | ✅                                                                                                                                                                                                                                                                         |
| RBAC (Roles Guard)                                               |                          ✅                           |             ✅             | ✅ (Auditor → 403 روی POST)                                                                                                                                                                                                                                                |
| JWT verification (Keycloak/JWKS)                                 |                          ✅                           |             ✅             | ✅ (۴ کاربر Seed، توکن واقعی گرفته شد)                                                                                                                                                                                                                                     |
| Transactional Outbox → Kafka                                     |                          ✅                           |             ✅             | ✅ (Asset ساخته شد → Outbox → Kafka، Correlation تطبیق)                                                                                                                                                                                                                    |
| Event Consumer / Dossier Projector                               |                          ✅                           |        ✅ (18 تست)         | ✅ (رویداد ساختگی maintenance → یک خط Timeline، Replay دوباره = بدون تکرار)                                                                                                                                                                                                |
| API Gateway routing + circuit breaker                            |                          ✅                           |        ✅ (21 تست)         | ✅ (مسیر به سرویس نساخته‌شده fleet → 503 تمیز)                                                                                                                                                                                                                             |
| Redis Rate Limiting (منطق)                                       |                          ✅                           |         ✅ (واحد)          | ⚠️ **مسدود شده توسط تداخل Port میزبان — بخش ۲۲.۳ D-006**                                                                                                                                                                                                                   |
| Anonymous public endpoint (self-registration) از راه Gateway     |                          ✅                           |        ✅ (17 تست)         | ✅ **`201` زنده گرفته شد — D-007 رفع شد**                                                                                                                                                                                                                                  |
| CI/CD روی GitHub Actions                                         |                          ✅                           |             —              | ✅ **CI VERIFIED** — Run `33219920446`، Commit `a36a2cf`، هر **۹** Job سبز (فاز اقتصادی)                                                                                                                                                                                   |
| Docker Build (identity, organization)                            |                          ✅                           |             —              | ✅ **CI VERIFIED** — Build + Trivy Scan هر دو Image روی Runner سبز                                                                                                                                                                                                         |
| Docker Build (asset, fleet, maintenance)                         |                  ✅ Dockerfile دارند                  |             —              | ✅ **CI VERIFIED** — Build + Trivy روی Runner برای هر سه؛ maintenance محلی هم اجرا شد (uid=100)                                                                                                                                                                            |
| Docker Build (economic)                                          |                  ✅ Dockerfile دارد                   |             —              | ✅ **CI VERIFIED** — Build + Trivy روی Runner سبز؛ محلی هم: `uid=100(rasta)`، `npm` حذف‌شده، Trivy ۰ CRITICAL/HIGH                                                                                                                                                         |
| Docker Build (api-gateway)                                       |                  ❌ Dockerfile ندارد                  |             —              | ❌ باز (بخش ۲۲)                                                                                                                                                                                                                                                            |
| **fleet-service — Driver/Assignment/Usage/Availability**         |                          ✅                           |        ✅ (۸۸ تست)         | ✅ زنده + **CI VERIFIED**                                                                                                                                                                                                                                                  |
| **Assignment Exclusivity (Partial Unique Index)**                |                          ✅                           |      ✅ (Integration)      | ✅ زنده: راننده مشغول → `422 DRIVER_ALREADY_ASSIGNED`                                                                                                                                                                                                                      |
| **Fleet → Kafka → Asset Projector**                              |                          ✅                           |        ✅ (۳۲ تست)         | ✅ **زنده** — Timeline پر شد، وضعیت `IDLE→ASSIGNED→ACTIVE`                                                                                                                                                                                                                 |
| **Idempotency (ثبت آفلاین + Replay مصرف‌کننده)**                 |                          ✅                           |             ✅             | ✅ زنده: ارسال دوباره = همان رکورد؛ Replay کافکا = بدون اثر دوم                                                                                                                                                                                                            |
| **correlationId در کل زنجیره**                                   |                          ✅                           |             ✅             | ✅ زنده: HTTP → Outbox → Header کافکا → Timeline، یکسان                                                                                                                                                                                                                    |
| **maintenance — Schedule/Request/RepairOrder/Cost**              |                          ✅                           |        ✅ (۱۰۲ تست)        | ✅ زنده + **CI VERIFIED**                                                                                                                                                                                                                                                  |
| **سررسید مشتق‌شده (نه Flag ذخیره‌شده)**                          |                          ✅                           |        ✅ (۱۴ تست)         | ✅ زنده: گریدر `OVERDUE on HOURS`، کنتور ۴۳۸۶٫۵۰ در برابر سررسید ۴۳۷۰٫۵۰                                                                                                                                                                                                   |
| **منع درخواست تکراری (Partial Unique Index)**                    |                          ✅                           |      ✅ (Integration)      | ✅ زنده: درخواست دوم → `422 DUPLICATE_OPEN_REQUEST`                                                                                                                                                                                                                        |
| **اتمیک بودن هزینه زیر همروندی**                                 |                          ✅                           |      ✅ (Integration)      | ✅ ده ثبت هم‌زمان → مجموع دقیقاً برابر `SUM` پایگاه داده                                                                                                                                                                                                                   |
| **تأیید پیش از تسویه (کنترل سند محصول)**                         |                          ✅                           |             ✅             | ✅ زنده: تأیید زودهنگام `409`، مبلغ کهنه `422`، تأیید دوباره `409`                                                                                                                                                                                                         |
| **Fleet USAGE_RECORDED → Maintenance (مسیر مرده پیشین)**         |                          ✅                           |        ✅ (۴۱ تست)         | ✅ **زنده** — کنتور ۴۳۸۰٫۵۰ → ۴۳۸۶٫۵۰، سپس `MAINTENANCE_DUE`                                                                                                                                                                                                               |
| **Maintenance → Kafka → Asset Timeline + Fleet Replica**         |                          ✅                           |             ✅             | ✅ **زنده** — ۳ خط Timeline، `IN_MAINTENANCE` → `ACTIVE`، `inMaintenance` روشن و خاموش                                                                                                                                                                                     |
| **economic — Wallet/Hold/Ledger/Journal/Transaction**            |                          ✅                           |        ✅ (۲۳۹ تست)        | ✅ زنده (۲۶ سناریو، بخش ۲۱-ج)                                                                                                                                                                                                                                              |
| **تغییرناپذیری دفتر کل (Trigger پایگاه داده)**                   |                          ✅                           |      ✅ (Integration)      | ✅ **از SQL خام** — `UPDATE`/`DELETE` روی `ledger_entry` و `journal` هر دو رد شدند                                                                                                                                                                                         |
| **توازن هر Journal (Trigger معوق در COMMIT)**                    |                          ✅                           |      ✅ (Integration)      | ✅ تراز آزمایشی زنده: `balanced: true`، ۱۳۶٬۰۰۰٬۰۰۰ = ۱۳۶٬۰۰۰٬۰۰۰                                                                                                                                                                                                          |
| **`available = ledger − pending` (CHECK پایگاه داده)**           |                          ✅                           |      ✅ (Integration)      | ✅ زنده: Hold ۱۲م → available ۷۶م، pending ۱۲م، مجموع ۸۸م                                                                                                                                                                                                                  |
| **همروندی کیف پول — ۱۰۰ برداشت موازی**                           |                          ✅                           |      ✅ (Integration)      | ✅ دقیقاً ۱۰ موفق از ۱۰۰ برای موجودی ۱۰ واحدی؛ هرگز مانده منفی                                                                                                                                                                                                             |
| **Idempotency واقعی (کلید ذخیره‌شده + Hash بدنه)**               |                          ✅                           |        ✅ (۱۳ تست)         | ✅ زنده: کلید تکراری → همان پاسخ؛ بدنه متفاوت → `409`؛ بدون کلید → `400`                                                                                                                                                                                                   |
| **تسویه اتمیک — شکست میانی چیزی باقی نمی‌گذارد**                 |                          ✅                           |      ✅ (Integration)      | ✅ تزریق خطا پس از Post شدن Journal → صفر Journal، صفر تغییر مانده، وجه در Hold                                                                                                                                                                                            |
| **اعتراض → توقف کامل تسویه**                                     |                          ✅                           |             ✅             | ✅ زنده: تسویه پیش از تأیید `409`؛ ماشین حالت یال DISPUTED→SETTLED ندارد                                                                                                                                                                                                   |
| **`AUDITOR` هیچ دسترسی اقتصادی ندارد**                           |                          ✅                           |             ✅             | ✅ زنده با توکن واقعی: کیف پول `403`، تراکنش `403`، تراز آزمایشی `403`                                                                                                                                                                                                     |
| **Maintenance → Kafka → economic (مسیر مرده پیشین)**             |                          ✅                           |         ✅ (۹ تست)         | ✅ **زنده** — `MAINTENANCE_APPROVED` → تعهد `PENDING_SETTLEMENT`، و **صفر حرکت پول**                                                                                                                                                                                       |
| **پرداخت شبیه‌سازی‌شده، با اعلام صریح**                          |                          ✅                           |             ✅             | ✅ زنده: `simulated: true` روی پاسخ، ردیف و رویداد؛ شکست قابل تحریک → `INSUFFICIENT_FUNDS`                                                                                                                                                                                 |
| Frontend (`apps/web`, `apps/admin`)                              |                          ❌                           |             —              | NOT_STARTED — پوشه خالی                                                                                                                                                                                                                                                    |
| Integration Tests (`*.int-spec.ts`)                              | ✅ ۳۰ Suite (fleet ۴، maintenance ۵، **economic ۲۱**) |             —              | ✅ **۳۲۸** — ۷۳ پیشین + ۲۵۵ economic                                                                                                                                                                                                                                       |
| E2E Tests (`tests/e2e`, Playwright)                              |                          ✅                           |       ✅ (۶۴ سناریو)       | ✅ **زنده** — Gateway + economic + marketplace + PostgreSQL + Kafka + Temporal + توکن واقعی Keycloak                                                                                                                                                                       |
| marketplace-service                                              |                          ✅                           | ✅ ۲۲۴ واحد + ۱۴۱ یکپارچگی | ✅ ۱۷ سناریوی E2E؛ Branch Coverage ۷۷٫۶۲٪ با دروازه ۷۵٪ در CI                                                                                                                                                                                                              |
| **document-service — Upload Intent/Document/AccessGrant/ClamAV** |                          ✅                           | ✅ ۲۵۵ واحد + ۱۲۹ یکپارچگی | ✅ زنده (۱۱ سناریوی E2E روی Stack واقعی + ClamAV واقعی)؛ Coverage ۹۰٫۲۳٪ Statement / ۸۱٫۹۶٪ Branch با دروازهٔ بدون‌تغییر ۷۵٪ — CI هنوز روی شاخهٔ ClamAV اجرا نشده                                                                                                          |
| **آپلود مستقیم: فایل هرگز از سرویس عبور نمی‌کند (ADR-014)**      |                          ✅                           |             ✅             | ✅ **زنده** — `PUT` از کلاینت مستقیم به MinIO، بدون هیچ Credential پلتفرمی                                                                                                                                                                                                 |
| **دانلود Fail-Closed: فقط `CLEAN` مجاز است**                     |                          ✅                           |             ✅             | ✅ **زنده** — سند تازه `PENDING` است و `422` می‌گیرد؛ پس از یک `CLEAN` معتبر بایت‌ها بازمی‌گردند. هیچ متغیر محیطی این را عوض نمی‌کند                                                                                                                                       |
| **بررسی Magic Number روی بایت‌های واقعی**                        |                          ✅                           |             ✅             | ✅ زنده: HTML آپلودشده زیر ادعای PDF → `422`                                                                                                                                                                                                                               |
| **اسکن بدافزار واقعی (ClamAV)**                                  |                          ✅                           |  ✅ واحد + یکپارچگی + E2E  | ✅ **زنده** — ClamAV 1.5.4 پین‌شده، ناهمزمان، EICAR روی موتور واقعی تشخیص داده شد (ADR-049، Q-18 بسته)                                                                                                                                                                     |
| **supplier-service — فاز ۱: پروفایل/صلاحیت/تعلیق/فهرست**         |                          ✅                           | ✅ ۴۱۷ واحد + ۱۲۶ یکپارچگی | ✅ **Merge شد** روی `main` (`36d718cf`، 2026-09-06)؛ Coverage ۹۲٫۰۸٪ Statement / ۸۴٫۲۵٪ Branch با دروازهٔ ۷۵٪ در CI. امتیاز عملکرد همچنان پیاده **نشد**: Q-12 در 2026-09-07 بسته شد (ADR-052) ولی **Phase 2 شروع نشده**. `COM-005` همچنان IN_PROGRESS و بدون امتیاز Story. |
| procurement/inventory/construction/…                             |                          ❌                           |             —              | مطابق فازبندی؛ وضعیت هر قابلیت در `docs/17`                                                                                                                                                                                                                                |

---

## ۴. Architecture Summary

Microservices (NestJS 11) + Next.js 15 (برنامه‌ریزی‌شده، نساخته) + رویدادمحور
(Kafka 3.9 KRaft) + Workflow Engine (Temporal — هنوز در هیچ سرویسی استفاده
نشده). هر سرویس Prisma Client و Database مستقل خودش را دارد. `api-gateway`
بدون Database، فقط Routing/Rate-Limit/Circuit-Breaker/Auth-Forwarding.

مسیر یک درخواست کاربر واقعی:
`Client → api-gateway (auth+rate-limit+route) → <service> (auth دوباره،
tenant-scope، business logic) → Postgres (نوشتن + Outbox در یک Transaction)
→ OutboxRelay (Polling) → Kafka → EventConsumer سرویس‌های دیگر`

---

## ۵. Technology Stack

| لایه           | فناوری                                                                     |
| -------------- | -------------------------------------------------------------------------- |
| زبان           | TypeScript 5.9 strict، Node 22/24                                          |
| Backend        | NestJS 11، Zod برای Validation                                             |
| Frontend       | Next.js 15 (برنامه‌ریزی‌شده — کد نساخته)                                   |
| Database       | PostgreSQL 16 + PostGIS 3.4 + ltree + pg_trgm + pgcrypto، Prisma 6         |
| Message Bus    | Kafka 3.9 KRaft (`apache/kafka:3.9.0`)                                     |
| Cache          | Redis 7.4                                                                  |
| Identity       | Keycloak 26 (OIDC/OAuth2، JWKS، RS256)                                     |
| Workflow       | Temporal 1.26 (زیرساخت بالا هست؛ هیچ سرویسی هنوز استفاده نمی‌کند)          |
| Object Storage | MinIO (S3-compatible)                                                      |
| Observability  | OpenTelemetry + Prometheus + pino (ساختاریافته، با Redaction)              |
| Test           | Jest + @swc/jest (Unit و Integration)؛ **Playwright ۱٫۶۲ نصب‌شده و در CI** |
| Monorepo       | pnpm workspaces + Turborepo                                                |
| Container      | Docker multi-stage (`pnpm deploy --prod --legacy`)                         |

---

## ۶. Repository Structure

```
services/
  api-gateway/           IMPLEMENTED — بدون Database
  identity-service/       IMPLEMENTED
  organization-service/   IMPLEMENTED
  asset-service/          IMPLEMENTED
  fleet-service/          IMPLEMENTED — کد، تست و تأیید زنده کامل
  maintenance-service/    IMPLEMENTED — کد، تست و تأیید زنده کامل
  economic-service/       IMPLEMENTED — کد، تست و تأیید زنده کامل
  (9 سرویس دیگر)          NOT_STARTED — حتی پوشه هم وجود ندارد

packages/
  contracts/    شیء‌های مشترک: ID، Money، Error، Event Envelope
  config/       بارگذاری/اعتبارسنجی Env
  logging/      pino + Redaction
  observability/ OTel + Prometheus
  nest-common/  Context، Auth Guard، Tenant Guard، Outbox، EventConsumer
  testing/      Matcher/Context مشترک برای تست (کم‌استفاده)

apps/
  web/    NOT_STARTED — پوشه خالی
  admin/  NOT_STARTED — پوشه خالی

tests/
  e2e/    IMPLEMENTED — @rasta/e2e: Playwright Config، Global Setup،
          ۶۴ سناریو روی Stack واقعی (بدون Browser تا ساخته‌شدن apps/web)

infrastructure/
  docker/   Postgres Init، Kafka Topics، Keycloak Realm — IMPLEMENTED
  k8s/      NOT_STARTED — پوشه خالی

docs/       ۲۴ سند + ۴۹ ADR + events/api/database/security/deployment/runbooks
scripts/
  copy-prisma-client.mjs   کپی Prisma Client تولیدشده به dist/
  prisma.mjs               Wrapper که DATABASE_URL_<SERVICE> را به Prisma CLI می‌دهد (این جلسه اضافه شد)
```

---

## ۷. Service Inventory

| Service                | Port        | Status                                                   | DB                   | Tests                                   | Docker                                                          |
| ---------------------- | ----------- | -------------------------------------------------------- | -------------------- | --------------------------------------- | --------------------------------------------------------------- |
| `api-gateway`          | 3000/3010\* | IMPLEMENTED                                              | — (بدون Database)    | 30 Unit                                 | ❌ Dockerfile ندارد                                             |
| `identity-service`     | 3101        | IMPLEMENTED                                              | `rasta_identity`     | 14 Unit                                 | ✅ در CI Matrix                                                 |
| `organization-service` | 3102        | IMPLEMENTED                                              | `rasta_organization` | 21 Unit                                 | ✅ در CI Matrix                                                 |
| `asset-service`        | 3103        | IMPLEMENTED (با یک Gap — بخش ۱۸)                         | `rasta_asset`        | 74 Unit                                 | ✅ **در CI Matrix**                                             |
| `fleet-service`        | 3104        | IMPLEMENTED · TESTED · LIVE VERIFIED · **CI VERIFIED**   | `rasta_fleet`        | **88 Unit + 32 Integration**            | ✅ **در CI Matrix**، Build+Trivy سبز                            |
| `maintenance-service`  | 3105        | IMPLEMENTED · TESTED · LIVE VERIFIED · **CI VERIFIED**   | `rasta_maintenance`  | **102 Unit + 41 Integration**           | ✅ **در CI Matrix**، Build+Trivy سبز                            |
| `economic-service`     | **3112**    | IMPLEMENTED · TESTED · LIVE VERIFIED · **CI VERIFIED**   | `rasta_economic`     | **308 Unit + 255 Integration + 37 E2E** | ✅ **در CI Matrix**، Build+Trivy سبز (۰ CRITICAL/HIGH، uid=100) |
| `document-service`     | **3114**    | IMPLEMENTED · TESTED · LIVE VERIFIED (CI هنوز اجرا نشده) | `rasta_document`     | **۲۵۵ Unit + ۱۲۹ Integration + ۱۱ E2E** | ✅ Dockerfile در CI Matrix (هشت Image) · ClamAV Sidecar بیرونی  |
| ۸ سرویس دیگر           | 3106–3116   | NOT_STARTED                                              | —                    | ۰                                       | —                                                               |

\* پورت داکیومنت‌شده در `CLAUDE.md`/`docs` **۳۰۰۰** است؛ در `.env` محلی فعلی
روی **۳۰۱۰** تنظیم شده چون یک Container نامرتبط (`purchase-workflow-system-app-1`)
پورت ۳۰۰۰ را در این ماشین توسعه گرفته است. این یک تنظیم محلی است، نه تغییر
معماری — `PORT_API_GATEWAY` در `.env` (ریشه) کنترل می‌کند.

برای هر سرویس پیاده‌شده، Authentication/Authorization/Tenant Isolation همگی
Implemented + Tested + Live Verified هستند (بخش ۳).

---

## ۷-الف. fleet-service — ورودی کامل حافظه

> نوشته‌شده در پایان دروازه انتشار فاز ناوگان (2026-08-28). هر ادعا شاهد دارد.

| بُعد           | مقدار                                                                  |
| -------------- | ---------------------------------------------------------------------- |
| Service        | `fleet-service` (`@rasta/fleet-service`)                               |
| Status         | **IMPLEMENTED · TESTED · LIVE VERIFIED · CI VERIFIED**                 |
| Port           | `3104` (`PORT_FLEET`)                                                  |
| Database       | `rasta_fleet` — نقش اختصاصی، بدون دسترسی به پایگاه داده هیچ سرویس دیگر |
| Topic تولیدی   | `rasta.fleet.v1` (+ `.retry`, `.dlq`)                                  |
| Topic مصرفی    | `rasta.asset.v1` · `rasta.insurance.v1` · `rasta.maintenance.v1`       |
| Consumer Group | `fleet-service.asset-sync` (از Offset صفر)                             |

### مالکیت دامنه

**مالک است:** `Driver` · `Assignment` · `UsageRecord` · `AvailabilityWindow`
و نمای مشتق `Utilization`.

**مالک نیست — و این مرز اجرا می‌شود:**

> `Asset` در مالکیت `asset-service` باقی می‌ماند. `fleet-service` دارایی را
> **فقط با شناسه ارجاع می‌دهد** و هرگز داده اصلی دارایی را مالک نمی‌شود.

تأییدشده با بازرسی، نه با ادعا:

- صفر `import` از `services/asset-service/**` (`grep` اجرا شد)
- صفر ارجاع به `DATABASE_URL_ASSET` یا `rasta_asset`
- هیچ Foreign Key میان‌پایگاه‌داده‌ای؛ `assetId` یک ستون `String` است
- جدول `asset_ref` یک **Replica فقط‌خواندنی** از رویدادهاست (الگوی `docs/03` § ۳٫۶)
  و **هرگز** مبنای تصمیم مجوزدهی نیست

### رویدادها — تولیدشده روی `rasta.fleet.v1`

همه با Envelope استاندارد (`eventId`، `eventVersion`، `producer`،
`aggregateType`، `aggregateId`، `tenantId`، `correlationId`، `causationId`،
`traceparent`، `actor`، `payload`) و **کلید پارتیشن `assetId`**.

| رویداد                  | v   | Aggregate          | مصرف‌کنندگان                                   | هدف                            |
| ----------------------- | --- | ------------------ | ---------------------------------------------- | ------------------------------ |
| `DRIVER_REGISTERED`     | 1   | Driver             | audit · analytics                              | ثبت راننده تازه                |
| `DRIVER_STATUS_CHANGED` | 1   | Driver             | audit · analytics                              | تعلیق/فعال‌سازی — قابل حسابرسی |
| `ASSET_ASSIGNED`        | 1   | Assignment         | **asset** (پرونده + وضعیت) · analytics         | راننده دستگاه را تحویل گرفت    |
| `ASSIGNMENT_ENDED`      | 1   | Assignment         | **asset** (پرونده + بازگشت) · analytics        | دستگاه آزاد شد                 |
| `USAGE_RECORDED`        | 1   | UsageRecord        | **maintenance** · asset · economic · analytics | محرک نگهداری کارکردمحور        |
| `AVAILABILITY_CHANGED`  | 1   | AvailabilityWindow | construction · analytics                       | اعلام دستی در دسترس بودن       |

`MISSION_STARTED` / `MISSION_COMPLETED`: **DEFERRED** — به
`construction-service` گره خورده که وجود ندارد (ADR-026).

### مسیر رویداد — **LIVE VERIFIED**

```
HTTP (Gateway، توکن واقعی Keycloak)
  → fleet-service
  → PostgreSQL (تغییر وضعیت + Outbox در یک تراکنش)
  → OutboxRelay
  → Kafka (rasta.fleet.v1، کلید = assetId)
  → asset-service TimelineConsumer
  → asset_timeline_entry + تغییر OperationalStatus
```

این **دقیقاً همین مسیر** اجرا شد (بخش ۲۱، ردیف ۴ تا ۸): دارایی
`IDLE → ASSIGNED → ACTIVE` رفت، دو خط Timeline ساخته شد، و `correlationId`
از درخواست HTTP تا Header کافکا تا Timeline یکسان ماند.

### تست

| دسته             | تعداد | وضعیت                                                          |
| ---------------- | ----- | -------------------------------------------------------------- |
| Unit             | 88    | سبز — ۷ فایل                                                   |
| Integration      | 32    | سبز — ۴ Suite روی PostgreSQL و Kafka **واقعی**، بدون Mock      |
| Security/AuthZ   | —     | داخل دو دسته بالا؛ Tenant Isolation و مجوزدهی Suite جدا ندارند |
| E2E (Playwright) | ۰     | Harness از 2026-08-29 هست؛ سناریوهایش فقط دامنه اقتصادی است    |

### محدودیت‌های شناخته‌شده

- `mission` پیاده نشده (**DEFERRED**، ADR-026)
- `asset_ref` در نهایت سازگار است — پنجره‌ای هست که fleet نمی‌داند دستگاهی
  تازه اسقاط شده (**OPEN**، پذیرفته‌شده در ADR-026)
- انحصار دارایی، شیفت‌بندی را ممنوع می‌کند (**OPEN** — Q-23)
- اعتبار گواهینامه ثبت می‌شود ولی اجرا نمی‌شود (**OPEN** — Q-22)
- `DELETE /v1/assignments/{id}` چیزی حذف نمی‌کند؛ مترادف `end` است

---

## ۷-ب. maintenance-service — ورودی کامل حافظه

> نوشته‌شده در پایان دروازه انتشار فاز نگهداری (2026-08-28). هر ادعا شاهد دارد.

| بُعد            | مقدار                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Service         | `maintenance-service` (`@rasta/maintenance-service`)                                                                     |
| Status          | **IMPLEMENTED · TESTED · LIVE VERIFIED · CI VERIFIED**                                                                   |
| Port            | `3105` (`PORT_MAINTENANCE`)                                                                                              |
| Database        | `rasta_maintenance` — نقش اختصاصی، بدون دسترسی به پایگاه داده هیچ سرویس دیگر                                             |
| Topic تولیدی    | `rasta.maintenance.v1` (+ `.retry`, `.dlq`)                                                                              |
| Topic مصرفی     | `rasta.fleet.v1` (کارکرد) · `rasta.asset.v1` (Replica مرجع)                                                              |
| Consumer Groups | `maintenance-service.usage` · `maintenance-service.asset-sync` — هر دو از Offset صفر                                     |
| Gateway         | **بدون تغییر.** ردیف‌های `maintenance-requests`، `maintenance-schedules` و `repair-orders` از قبل در جدول مسیریابی بودند |

### مالکیت دامنه

**مالک است:** `MaintenanceSchedule` · `MaintenanceRequest` · `RepairOrder` ·
`PartUsage` · `LaborEntry` · `MaintenanceCost` — دقیقاً همان شش جدولی که
`docs/04` § ۴٫۷ نوشته.

**مالک نیست — و این مرزها اجرا می‌شوند:**

| واقعیت           | مالک                | چطور به maintenance می‌رسد                     |
| ---------------- | ------------------- | ---------------------------------------------- |
| خود دارایی       | `asset-service`     | رویداد → `asset_ref` (Replica فقط‌خواندنی)     |
| رکورد کارکرد     | `fleet-service`     | رویداد → `asset_usage_meter` (کنتور مشتق‌شده)  |
| پروفایل تعمیرگاه | `supplier-service`  | فقط یک ارجاع `workshopOrganizationId` — نساخته |
| موجودی قطعه      | `inventory-service` | فقط `sourceReference` روی مصرف قطعه — نساخته   |
| هر حرکت پول      | `economic-service`  | `MAINTENANCE_APPROVED` — **زنده** (بخش ۷-ج)    |

تأییدشده با بازرسی، نه با ادعا:

- صفر `import` از `services/*/src/**` دیگر
- صفر ارجاع به `DATABASE_URL_ASSET`، `DATABASE_URL_FLEET` یا نام پایگاه داده دیگری
- هیچ `wallet`، `ledger`، `commission` یا `settlement` **پیاده نشده** — این
  کلمات فقط در کامنت‌هایی ظاهر می‌شوند که همین مرز را توضیح می‌دهند، و در نام یک
  تست قرارداد. (`grep` اجرا شد و خروجی‌اش خط‌به‌خط بررسی شد؛ ادعای «صفر ارجاع»
  نادرست می‌بود.)
- هیچ Foreign Key میان‌پایگاه‌داده‌ای؛ `assetId` یک ستون `String` است
- `asset_ref` و `asset_usage_meter` **هرگز** مبنای تصمیم مجوزدهی نیستند

**`asset_usage_meter` یک کپی از `UsageRecord` نیست.** تنها عدد مشتق‌شده‌ای است که
یک برنامه کارکردمحور لازم دارد — کنتور فعلی — که بدون پرسیدن از `fleet-service` در
هر ارزیابی، از هیچ راه دیگری به‌دست نمی‌آید. رکوردهای کارکرد خودشان هرگز کپی
نمی‌شوند.

### رویدادها — تولیدشده روی `rasta.maintenance.v1`

همه با Envelope استاندارد و **کلید پارتیشن `assetId`** (همان استثنای آگاهانه fleet).

| رویداد                  | v   | Aggregate           | مصرف‌کنندگان                                                    | هدف                          |
| ----------------------- | --- | ------------------- | --------------------------------------------------------------- | ---------------------------- |
| `MAINTENANCE_DUE`       | 1   | MaintenanceSchedule | notification · fleet · analytics                                | سررسید سرویس                 |
| `BREAKDOWN_REPORTED`    | 1   | MaintenanceRequest  | notification · asset · analytics                                | «چیزی خراب شد»               |
| `MAINTENANCE_CREATED`   | 1   | MaintenanceRequest  | **asset** (پرونده)                                              | «کاری وجود دارد»             |
| `WORKSHOP_ASSIGNED`     | 1   | RepairOrder         | notification · supplier                                         | ارجاع به تعمیرگاه            |
| `MAINTENANCE_STARTED`   | 1   | MaintenanceRequest  | **asset** (`IN_MAINTENANCE`) · **fleet** (`inMaintenance=true`) | خروج از سرویس                |
| `REPAIR_COMPLETED`      | 1   | RepairOrder         | asset · supplier (امتیاز)                                       | سهم یک تعمیرگاه، با هزینه‌اش |
| `MAINTENANCE_COMPLETED` | 1   | MaintenanceRequest  | **asset** (`ACTIVE`) · **fleet** (رفع مسدودی)                   | بازگشت دستگاه                |
| `MAINTENANCE_APPROVED`  | 1   | MaintenanceRequest  | **economic (مجوز تسویه)**                                       | **کنترل اجباری سند محصول**   |
| `MAINTENANCE_CANCELLED` | 1   | MaintenanceRequest  | asset · notification · audit                                    | افزوده این فاز — بخش زیر     |

**`MAINTENANCE_CANCELLED` تنها رویداد فراتر از کاتالوگ است، و قاعده‌اش این بود:**
رویداد تازه فقط برای **درست نگه داشتن ادعایی که قبلاً منتشر شده**. بدون آن، هر
مصرف‌کننده‌ای که `MAINTENANCE_CREATED` را دیده تا ابد باور می‌کند کار باز است.
برنامه سرویس رویداد ندارد، چون ساختش هرگز منتشر نشده — و همین شکاف به‌عنوان D-011
ثبت شده، نه پنهان.

**هزینه به‌صورت `totalCostMinor` (رشته، واحد فرعی) منتقل می‌شود، نه
`{ amountMinor, currency }`.** انحراف آگاهانه از قاعده پول کاتالوگ:
`TimelineConsumer` در `asset-service` پیش از ساخت این سرویس نوشته شده و فیلد مسطح
را می‌خواند و هر چیز دیگری را `null` می‌گیرد. شکل تودرتو یعنی پرونده هر دستگاه،
هزینه هر تعمیر را صفر ثبت می‌کرد.

### مسیر رویداد — **LIVE VERIFIED، هر دو جهت**

```
FLOW A  (مسیری که از روز نخست fleet مرده بود)
HTTP (Gateway، توکن واقعی Keycloak) → fleet-service
  → PostgreSQL + Outbox (یک تراکنش) → OutboxRelay → Kafka (rasta.fleet.v1)
  → maintenance-service UsageConsumer
  → asset_usage_meter (۴۳۸۰٫۵۰ → ۴۳۸۶٫۵۰) + ارزیابی برنامه
  → MAINTENANCE_DUE منتشر شد

FLOW B  (مسیری که مصرف‌کننده‌اش از روز نخست منتظر بود)
HTTP → maintenance-service
  → PostgreSQL + Outbox (یک تراکنش) → OutboxRelay → Kafka (rasta.maintenance.v1)
  → asset-service TimelineConsumer → ۳ خط Timeline + وضعیت IN_MAINTENANCE → ACTIVE
  → fleet-service AssetSyncConsumer → asset_ref.inMaintenance = true → false
```

هر دو **دقیقاً همین‌طور** اجرا شدند (بخش ۲۱-ب).

### تصمیم‌های معماری این فاز

| ADR | تصمیم                                                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ |
| ۰۲۷ | سررسید **در هر خواندن مشتق می‌شود**، ذخیره نمی‌شود. اعلام کارکردمحور رویدادمحور؛ اعلام زمان‌محور یک Scan محافظت‌شده به‌جای Temporal. |
| ۰۲۸ | هر خط هزینه **مبدأ** دارد؛ مجموع‌ها زیر قفل ردیف از خطوط بازمحاسبه می‌شوند؛ `MAINTENANCE_APPROVED` تفکیک حمل می‌کند.                 |
| ۰۲۹ | قواعد سطح Object برای `OPERATOR` و `WORKSHOP` **باریک‌سازی** شدند، نه تقریب — و در جهت امن.                                          |

### تست

| دسته             | تعداد | وضعیت                                                                        |
| ---------------- | ----- | ---------------------------------------------------------------------------- |
| Unit             | 102   | سبز — ۸ فایل                                                                 |
| Integration      | 41    | سبز — ۵ Suite روی PostgreSQL و Kafka **واقعی**، بدون Mock                    |
| Security/AuthZ   | —     | داخل دو دسته بالا؛ Tenant Isolation و باریک‌سازی سطح Object Suite جدا ندارند |
| E2E (Playwright) | ۰     | Harness از 2026-08-29 هست؛ سناریوهایش فقط دامنه اقتصادی است                  |

پنج Suite Integration: `tenant-isolation` · `request-lifecycle` · `cost-atomicity` ·
`outbox` · `event-flow`. `test:integration` **`--passWithNoTests` ندارد.**

### محدودیت‌های شناخته‌شده

- پورتال `WORKSHOP` پیاده نشده (**DEFERRED**، ADR-029، Q-25) — نقش `WORKSHOP` در
  باریک‌سازی می‌افتد و هیچ نمی‌بیند؛ امن به‌صورت پیش‌فرض
- احراز صلاحیت تعمیرگاه بررسی نمی‌شود (**OPEN** — Q-25) — پشت Port
  `WorkshopDirectory`، که نبودِ بررسی را Log می‌کند
- قاعده «فقط دارایی تخصیص‌یافته» برای اپراتور اجرا نمی‌شود (**OPEN** — Q-24) —
  باریک‌سازی جایگزین، در جهت امن
- `PAYMENT_COMPLETED` مصرف نمی‌شود (**DEFERRED**) — `economic-service` نیست
- `MaintenanceDueScanWorkflow` در Temporal نوشته نشده (**DEFERRED**، ADR-027) —
  Scan درون‌پردازه‌ای جایش را گرفته؛ وضعیت سررسید مشتق است، پس نبودش چیزی را
  نادرست گزارش نمی‌کند
- تغییر برنامه سرویس رویداد تولید نمی‌کند (**D-011**)
- کنتور کارکرد هرگز عقب نمی‌رود؛ تعویض کنتور نیازمند Anchor دوباره است (**D-012**)
- `GetWorkshopPerformance` پیاده نشد — مال `supplier-service` است

---

## ۷-ج. economic-service — ورودی کامل حافظه

> نوشته‌شده در پایان دروازه انتشار فاز اقتصادی (2026-08-29). هر ادعا شاهد دارد.

| بُعد            | مقدار                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Service         | `economic-service` (`@rasta/economic-service`)                                                                                      |
| Status          | **IMPLEMENTED · TESTED · LIVE VERIFIED · CI VERIFIED**                                                                              |
| Port            | `3112` (`PORT_ECONOMIC`)                                                                                                            |
| Database        | `rasta_economic` — نقش اختصاصی، بدون دسترسی به پایگاه داده هیچ سرویس دیگر                                                           |
| Topic تولیدی    | `rasta.economic.v1` (+ `.retry`, `.dlq`)                                                                                            |
| Topic مصرفی     | `rasta.maintenance.v1` (تأیید + محرک پاداش) · `rasta.fleet.v1` (محرک پاداش)                                                         |
| Consumer Groups | `economic-service.settlement-authority` · `economic-service.reward-trigger` — هر دو از Offset صفر                                   |
| Gateway         | ردیف‌های `wallets`، `transactions`، `settlements`، `commissions`، `rewards`، `ledger` از قبل بودند؛ **`payment-intents` افزوده شد** |

### مالکیت دامنه

**مالک است:** `Wallet` · `WalletHold` · `LedgerAccount` · `Journal` ·
`LedgerEntry` · `Transaction` · `TransactionLeg` · `PaymentIntent` ·
`CommissionRule` · `Commission` · `RewardRule` · `Reward` · `RewardLevel` ·
`RewardBalance` · `Settlement` · `IdempotencyKey` — همان فهرست `docs/04` § ۴٫۱۴.

**مالک نیست — و این مرزها اجرا می‌شوند:**

| واقعیت               | مالک                      | چطور به economic می‌رسد                                                  |
| -------------------- | ------------------------- | ------------------------------------------------------------------------ |
| سفارش                | `marketplace-service`     | فقط `sourceReference` — نساخته                                           |
| قرارداد و صورت‌وضعیت | `contract-service`        | فقط `sourceReference` — نساخته                                           |
| هزینه تعمیر          | `maintenance-service`     | `MAINTENANCE_APPROVED` → مبلغ تأییدشده، هرگز بازمحاسبه نمی‌شود (ADR-028) |
| هویت و سازمان        | `identity`/`organization` | فقط شناسه، هرگز ردیف                                                     |
| **پول واقعی**        | **هیچ‌کس**                | ارائه‌دهنده شبیه‌سازی‌شده است (ADR-024)                                  |

تأییدشده با بازرسی، نه با ادعا:

- صفر `import` از `services/*/src/**` دیگر
- صفر ارجاع به `DATABASE_URL_*` سرویس دیگری
- هیچ Foreign Key میان‌پایگاه‌داده‌ای
- **صفر ارجاع به Redis در کل سرویس** — انحراف آگاهانه از `docs/10` § ۱۰٫۵،
  دلیلش در ADR-031
- **صفر نرخ کارمزد یا نرخ تبدیل پاداش در کد یا Seed** — `grep` اجرا شد

### پنج ماژول ADR-013، به‌علاوه دو

`wallet` · `ledger` · `payment` · `commission` · `reward` — دقیقاً همان‌طور که
ADR-013 خواسته، هرکدام با Interface داخلی و بدون Join میان‌ماژولی. دو پوشه
افزوده:

- `transaction/` — تعهدی که هر پنج ماژول رویش کار می‌کنند، با ماشین حالت صریح
- `settlement/` — فرآیندی که ADR-031 حاکم بر آن است
- `shared/` — Value Objectهای مالی و Idempotency

اینها دامنه تازه نیستند؛ درزهایی‌اند که پیش‌تر بی‌نام بودند.

### تصمیم‌های معماری این فاز

| ADR | تصمیم                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ۰۳۰ | `ledger_entry` **پارتیشن‌بندی نشده**. جدول پارتیشن‌بندی‌شده بدون پارتیشن ماه جاری، `INSERT` را رد می‌کند و هیچ ساز‌و‌کار خودکار ساختش اینجا نیست. شرط فعال‌سازی یک **عدد** است، نه یادداشت.     |
| ۰۳۱ | تسویه **یک تراکنش ACID** است، نه Saga — چون خودِ `docs/10` جبران خودکار را ممنوع کرده. قفل کیف پول‌ها به ترتیب صعودی `id`؛ Deadlock ساختاراً غیرممکن. **Redis در هیچ مسیر مالی نیست.**          |
| ۰۳۲ | فقط رویدادهایی مصرف می‌شوند که قراردادشان واقعاً تعریف شده. `ORDER_*` موکول است — نه چون تولیدکننده نیست، بلکه چون نوشتنش یعنی اختراع Payload سرویس دیگری. **و یک تأیید، پول را حرکت نمی‌دهد.** |
| ۰۳۳ | پاداش همیشه امتیاز می‌دهد؛ ارزش ریالی فقط با `creditPerPointMinor` پیکربندی‌شده. پاداش امتیازی **هیچ Journal نمی‌زند** — یک ورودی صفر `CHECK` را می‌شکند و چیزی نمی‌گوید.                       |
| ۰۳۴ | **حل تناقض میان بند ۱۰٫۳ و بند ۱۰٫۴.** امانت به‌ازای هر سازمان (`LIAB-<ORG>-ESCROW`)، و هر سه مانده از دفتر کل بازمحاسبه می‌شوند، نه افزایش تدریجی.                                             |

### آنچه پایگاه داده تحمیل می‌کند، نه کد

این مهم‌ترین بخش این ورودی است. هرچه می‌شد به محدودیت تبدیل کرد، شد:

| محدودیت                                       | چه چیزی را غیرممکن می‌کند                                                                 |
| --------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `trg_ledger_entry_immutable`                  | `UPDATE`/`DELETE` روی ورودی Post‌شده — **حتی از SQL خام**                                 |
| `trg_journal_immutable`                       | همان، برای Header. افزوده بر `docs/05`: Header تغییرپذیر روی خطوط تغییرناپذیر یک شکاف است |
| `trg_journal_balanced` (معوق)                 | Journal نامتوازن یا تک‌خطی، در `COMMIT`. معوق، چون خطوط در چند دستور درج می‌شوند          |
| `ck_wallet_balances`                          | **خرج بیش از موجودی.** بررسی Application فقط پیام خطا می‌سازد                             |
| `fk_ledger_entry_account_identity`            | ورودی با ارز یا سازمانِ ناسازگار با حسابش — هر دو شکست بی‌صدا                             |
| `uq_wallet_hold_active_reference`             | دو Hold زنده برای یک تعهد؛ دو Retry هم‌زمان، یک Hold                                      |
| `journal_reverses_id_key`                     | معکوس کردن یک Journal دو بار                                                              |
| `ck_reward_monetisation`                      | پرچم `monetised` که دروغ بگوید                                                            |
| `ck_commission_rule_rate`                     | نرخ خارج از ۰ تا ۱۰٬۰۰۰ Basis Point                                                       |
| `transaction(organizationId, idempotencyKey)` | تراکنش تکراری با یک کلید                                                                  |

### رویدادها — تولیدشده روی `rasta.economic.v1`

هر یازده رویداد کاتالوگ (`docs/07` § ۷٫۵)، همه با Envelope استاندارد، همه
اعتبارسنجی‌شده **پیش از** رسیدن به Outbox، و همه در `NEVER_AUTO_REPLAY`:

`WALLET_OPENED` · `FUNDS_HELD` · `FUNDS_RELEASED` · `PAYMENT_AUTHORIZED` ·
`PAYMENT_COMPLETED` · `PAYMENT_FAILED` · `COMMISSION_APPLIED` ·
`REWARD_GRANTED` · `REWARD_LEVEL_CHANGED` · `SETTLEMENT_COMPLETED` ·
`JOURNAL_POSTED`

**کلید پارتیشن رویدادهای یک تراکنش، خودِ `transactionId` است** — نه شناسه
Commission یا Settlement — تا مصرف‌کننده‌ای که یک تراکنش را بازسازی می‌کند
ترتیب را از دست ندهد.

سه فیلد که در کاتالوگ اولیه نبودند و عمداً افزوده شدند، چون نبودشان مصرف‌کننده
را به حدس زدن وامی‌داشت:

- `simulated` روی هر رویداد پرداخت (ADR-024 — سکوت خودش یک ادعاست)
- `resolution` روی `FUNDS_RELEASED` (آزادسازی در برابر بازگشت وجه)
- `monetised` روی `REWARD_GRANTED` (امتیازی در برابر پولی‌شده)

### مصرف — فعال در برابر موکول (ADR-032)

**فعال:** `MAINTENANCE_APPROVED` (تعهد قابل تسویه، **بدون حرکت پول**) ·
`USAGE_RECORDED` و `MAINTENANCE_COMPLETED` (محرک پاداش).

**موکول و نام‌دار:** `ORDER_CREATED` · `ORDER_RECEIPT_CONFIRMED` ·
`ORDER_CANCELLED` · `ORDER_DISPUTED` · `STATEMENT_APPROVED` ·
`PURCHASE_ORDER_ISSUED` · `GOODS_RECEIVED`.

**هیچ‌کدام Stub ندارند.** یک Handler خالی در `processed_event` رد می‌گذارد و
دقیقاً شبیه یکی است که کار کرد. کل چرخه Hold ← تسویه ← کارمزد ← پاداش از راه
**API** در دسترس و تست‌شده است — که همان چیزی است که `docs/08` § ۸٫۶ به‌شکل
Activity می‌خواهد.

### مسیر رویداد — **LIVE VERIFIED، هر دو جهت**

```
FLOW A  (مسیری که از فاز نگهداری مرده بود)
HTTP (Gateway، توکن واقعی) → maintenance-service → Outbox → Kafka
  → economic-service SettlementAuthorityConsumer
  → Transaction(PENDING_SETTLEMENT)، صفر Journal، صفر تغییر مانده
  → Replay همان رویداد = بدون اثر دوم
  → انتشار دوباره با eventId تازه = همچنان یک تعهد

FLOW B  (مصرف‌کننده‌هایش هنوز ساخته نشده‌اند، اما قرارداد اکنون واقعی است)
HTTP → economic-service → PostgreSQL + Outbox (یک تراکنش) → OutboxRelay
  → Kafka (rasta.economic.v1): WALLET_OPENED، PAYMENT_AUTHORIZED،
    PAYMENT_COMPLETED، FUNDS_HELD، JOURNAL_POSTED، COMMISSION_APPLIED،
    FUNDS_RELEASED، SETTLEMENT_COMPLETED
```

### تست

| دسته             | تعداد   | وضعیت                                                                         |
| ---------------- | ------- | ----------------------------------------------------------------------------- |
| Unit             | **۳۰۸** | سبز — ۱۶ فایل                                                                 |
| Integration      | **۲۵۵** | سبز — ۲۱ Suite روی PostgreSQL **واقعی**، بدون Mock                            |
| API (Supertest)  | —       | داخل Integration؛ ۵ Suite که `AppModule` واقعی را Boot می‌کنند                |
| Security/AuthZ   | —       | داخل دو دسته بالا؛ `access.spec.ts`، `tenant-isolation`، `service-to-service` |
| E2E (Playwright) | **۳۷**  | سبز — از راه Gateway، با توکن واقعی Keycloak (`tests/e2e`)                    |
| **پوشش**         | —       | Statements ۹۳٫۸۰٪ · **Branches ۹۰٫۱۳٪** · Functions ۹۱٫۶۶٪ · Lines ۹۵٫۷۷٪     |

نُه Suite یکپارچگی، سازمان‌یافته حول جدول اجباری `docs/10` § ۱۰٫۱۲ — نه حول
ساختار کد، چون همان جدول دروازه Merge است: `ledger-immutability` ·
`financial-consistency` · `wallet-concurrency` · `idempotency` ·
`settlement-atomicity` · `reward-cap` · `outbox` · `tenant-isolation` ·
`event-flow`.

`test:integration` **`--passWithNoTests` ندارد.**

### سه نقصی که تست‌ها گرفتند، نه بازبینی

1. **تراکنش تودرتوی Prisma.** `TransactionService.create` وقتی کیف پول هنوز
   وجود نداشت، `getOrOpen` را **داخل** تراکنش صدا می‌زد؛ Prisma تراکنش تودرتو
   را روی Connection دیگری اجرا می‌کند، پس تراکنش داخلی روی قفل‌هایی که بیرونی
   گرفته منتظر می‌ماند. تست همروندی گرفتش.
2. **نمای دریافت‌کننده که همیشه خالی بود.** فهرست تسویه، Filter نگهبان مستأجر
   را با Filter دریافت‌کننده AND می‌کرد — یعنی تسویه‌ای می‌خواست که پرداخت‌کننده
   و دریافت‌کننده‌اش یکی باشند، که `ck_settlement_distinct_parties` غیرممکنش
   کرده.
3. **گزارش شکست ناخوانا.** `jest-worker` نتایج را با `JSON.stringify` می‌فرستد،
   پس نخستین ادعای شکست‌خورده روی پول به‌جای خودِ شکست، «cannot serialize a
   BigInt» گزارش می‌شد. در سرویسی که هر مبلغش `bigint` است، این یعنی نخستین
   Regression واقعی ناخوانا می‌رسید.

### محدودیت‌های شناخته‌شده

- **پرداخت شبیه‌سازی‌شده است** (ADR-024، Q-01، Q-14). هیچ بانک، هیچ PSP، هیچ
  نگهداری وجه. `simulated: true` روی هر ردیف، رویداد و پاسخ.
- **هیچ نرخ کارمزدی پیکربندی نشده** (Q-08) — هر تسویه با کارمزد صفر و
  `commissionRuleMatched: false` انجام می‌شود. این وضعیت **درست** MVP است.
- **هیچ نرخ تبدیل پاداشی پیکربندی نشده** (Q-09) — پاداش امتیازی است و Journal
  نمی‌زند (ADR-033).
- **سطوح پاداش هیچ مزیتی ندارند** (Q-13) — محاسبه می‌شوند، رویداد منتشر می‌شود،
  هیچ‌چیز اعطا نمی‌شود.
- `ledger_entry` **پارتیشن‌بندی نشده** (D-013، ADR-030)
- **تسویه در Temporal نیست** (D-014، ADR-031) — یک تراکنش ACID با ماشین حالت صریح
- **مصرف‌کننده‌های `ORDER_*` و `STATEMENT_APPROVED` موکول** (D-015، ADR-032)
- `LedgerBalanceAudit` **درون‌پردازه‌ای** است، نه `LedgerBalanceAuditWorkflow` در
  Temporal. **گزارش می‌دهد، هرگز اصلاح نمی‌کند** — کیف پولی که با دفتر کل
  نمی‌خواند، یک حادثه برای انسان است، نه عددی که بی‌صدا درست شود.
- **پاداش روی تسویه فعال نیست.** قلاب هست و صدا زده می‌شود، اما هیچ قاعده‌ای
  علیه `SETTLEMENT_COMPLETED` پیکربندی نشده، چون `docs/10` § ۱۰٫۸ «پول گرفتن» را
  در فهرست رفتارهای امتیازآور ندارد و اختراعش یعنی اختراع یک انگیزه.

---

## ۷-د. document-service — ورودی کامل حافظه

> **وضعیت:** IMPLEMENTED · TESTED · LIVE VERIFIED (2026-08-31) · CI هنوز روی شاخهٔ
> `feat/document-clamav-scanner` اجرا نشده. پورت **۳۱۱۴**، پایگاه داده
> `rasta_document`.
>
> **به‌روزرسانی 2026-08-31 — Q-18 بسته شد (ADR-049).** اسکن بدافزار دیگر Stub نیست:
> **ClamAV** خودمیزبان به‌صورت Sidecar، پین‌شده به Digest تغییرناپذیر، پشت همان
> `MALWARE_SCANNER` Port. دانلود سند برای **نخستین بار در تاریخ پلتفرم** ممکن شد —
> و فقط پس از یک `CLEAN` معتبر. جزئیات در بخش «اسکن بدافزار» پایین‌تر.

### آنچه واقعاً کار می‌کند

| عملیات                                  |           وضعیت           |
| --------------------------------------- | :-----------------------: |
| `POST /v1/documents/upload-url`         |            ✅             |
| آپلود مستقیم کلاینت → Object Storage    |            ✅             |
| `POST /v1/documents` (ثبت فراداده)      |            ✅             |
| `GET /v1/documents` و `GET /…/{id}`     |            ✅             |
| `DELETE /v1/documents/{id}` (Tombstone) |            ✅             |
| `POST /v1/documents/{id}/download-url`  | ✅ پس از یک `CLEAN` معتبر |
| اسکن بدافزار ناهمزمان (ClamAV)          |            ✅             |

### فایل هرگز از سرویس عبور نمی‌کند

قاعده مرکزی ADR-014، و دلیل نبودن Endpoint آپلود: کلاینت یک URL امضاشده
می‌گیرد و مستقیم به Object Storage آپلود می‌کند. تنها بایت‌هایی که این سرویس
لمس می‌کند، **۳۲ بایت نخست** شیء است که برای تشخیص Magic Number دوباره خوانده
می‌شود — یک Header، نه یک سند. `ObjectStorage` هیچ متد نوشتن ندارد، پس اضافه
کردن یک Route چندبخشی، یک تغییر Interface است نه یک تصمیم لحظه‌ای.

سناریوی E2E این را اثبات می‌کند: `PUT` به MinIO می‌رود، نه به هیچ پردازه رستا،
و هیچ Credential پلتفرمی همراه ندارد.

### دانلود Fail-Closed — مهم‌ترین Invariant این سرویس

`canDownload` تابعی خالص است و **فقط `CLEAN`** را مجاز می‌شمارد. `PENDING`،
`NOT_SCANNED`، `INFECTED`، `FAILED`، `QUARANTINED` و سند حذف‌شده رد می‌شوند؛
هر وضعیتی که بعداً به Enum اضافه شود، به‌صورت پیش‌فرض بسته است.

**هیچ متغیر محیطی این را عوض نمی‌کند.** `DOCUMENT_ALLOW_UNSCANNED_DOWNLOAD` که
پیش‌فرضش `true` بود حذف شد — نه اینکه `false` شود. `canDownload` هیچ آرگومان
پیکربندی نمی‌گیرد، و **هیچ‌یک از سیزده تنظیم اسکن که ADR-049 اضافه کرد آن را
بازنمی‌گرداند**: همه تنظیم می‌کنند اسکن _چگونه_ انجام شود.

### اسکن بدافزار — ClamAV (ADR-049، بستن Q-18)

**پیش از این:** `NoOpMalwareScanner` هیچ محتوایی باز نمی‌کرد و `NOT_SCANNED` ثبت
می‌کرد، پس **در هیچ استقرار MVP هیچ سندی قابل دانلود نبود**. محدودیت عمدی بود، نه نقص:
آنچه هرگز رخ نداد، ثبت یک `CLEAN` دروغین بود.

**اکنون:**

```
finalize  → سند PENDING ثبت می‌شود؛ DOCUMENT_UPLOADED با scanState=PENDING
ScanWorker → Claim (FOR UPDATE SKIP LOCKED + Lease) → Stream از MinIO → clamd INSTREAM
          → CLEAN | INFECTED | FAILED | PENDING(retry با Backoff نمایی)
          → DOCUMENT_SCANNED (+ VIRUS_DETECTED برای عفونت)
```

| موضوع         | واقعیت                                                                                  |
| ------------- | --------------------------------------------------------------------------------------- |
| Image         | `clamav/clamav@sha256:f0954d679017eb6d48221e2b2be3ac5457bf278a844f39b672376f55a085f591` |
| نسخه          | ClamAV 1.5.4، Alpine 3.24.1، amd64، ~۴۰۰MB                                              |
| امضا در Image | `main.cvd` v63 · `daily.cvd` v28108 · `bytecode.cvd` v339                               |
| Production    | Unix Socket؛ `DOCUMENT_CLAMAV_HOST` در Production **رد می‌شود و فرآیند خارج** (S-08)    |
| Local/CI      | TCP فقط روی `127.0.0.1`؛ CI روی لینوکس از Socket استفاده می‌کند                         |
| freshclam     | Container جداگانه، غیر-root، Volume ماندگار — **محلی تأیید شد: 28108 → 28109**          |
| تازگی امضا    | سقف ۴۸ ساعت؛ فراتر از آن اسکن **انجام نمی‌شود** و `STALE_SIGNATURES` ثبت می‌شود         |
| RAM           | ~۱ گیگابایت در حالت پایدار (پایگاه امضا در حافظه)                                       |

**تنها یک مسیر به `CLEAN` وجود دارد** و همه‌چیز را با هم می‌خواهد: پاسخی که Parse شده،
به‌صورت `OK`، از موتوری که نسخه‌اش خوانده شده، روی پایگاه امضایی درون پنجرهٔ تازگی.
Timeout، اتصال ردشده، پاسخ ناقص، خطای موتور، سقف اندازه، `Heuristics.Limits.Exceeded`
و امضای کهنه — همه `FAILED` با کد دلیل.

**سه نقص واقعی که تست‌ها پیدا کردند** (هر سه در همین شاخه رفع شد):

1. `openReadStream` دقیقاً `maxBytes` می‌خواست. این به سمت **باز** شکست می‌خورد: شیء
   بزرگ‌تر دقیقاً سقف را برمی‌گرداند، شمارنده هرگز رد نمی‌شود، و اسکنر یک پیشوند بریده
   را می‌خواند و دربارهٔ فایلی که فقط ابتدایش را دیده `OK` می‌گوید. حالا یک بایت **بیش
   از** سقف می‌خواهد تا «بیشتر از آنچه مجاز است وجود دارد» قابل مشاهده باشد.
2. Flag خاموشی Worker با `true` مقداردهی اولیه شده بود، پس Worker ای که با `tick()`
   رانده می‌شد — اپراتوری که صف را دستی تخلیه می‌کند — یک دسته Claim می‌کرد و همه را
   بدون اسکن رها می‌کرد.
3. رأی `INFECTED` از اسکنری که چیزی بازرسی نمی‌کند، درون تراکنش نوشتن `throw` می‌کرد و
   کل دسته را Rollback و سند را برای همیشه در `PENDING` پارک می‌کرد.

**سیاست قرنطینه.** شیء **حذف نمی‌شود** — مدرک است. `quarantined_at` و
`quarantine_reason` در همان نوشتنِ `INFECTED` ثبت می‌شوند و
`ck_document_infected_is_quarantined` این را از یک وعده به یک ویژگی سطر تبدیل می‌کند.

**آنچه ClamAV نمی‌دهد.** تشخیص کامل یا تضمین‌شده. `CLEAN` یعنی «چیزی که این پایگاه
می‌شناسد تطبیق نکرد» — نه «امن است». فهرست کامل محدودیت‌ها در ADR-049.

**EICAR.** آرتیفکت استاندارد و بی‌ضرر، **داخل یک DOCX**. تلاش نخست آن را در PDF جاسازی
کرد و ClamAV به‌درستی `OK` گفت: امضا فایل را به‌عنوان یک کل تطبیق می‌دهد. بایت‌ها در
حافظه از دو قطعهٔ base64 ساخته می‌شوند و **هرگز روی فایل‌سیستم میزبان نوشته نمی‌شوند**.

مسیر دانلود موفق در Suite های غیر-ClamAV با `AlwaysCleanScanner` تست می‌شود — یک
پیاده‌سازی **فقط-تستی** در `test/`، که `tsconfig.json` آن پوشه را از Build خارج می‌کند.
`fake-clamd.ts` هم به همان دلیل از `src/` به `test/` منتقل شد: زیر این tsconfig در
`dist` کامپایل می‌شد و درون Image تولیدی می‌رفت.

### کنترل‌های محتوا

- **Magic Number روی بایت‌های واقعی**، نه پسوند و نه Header اعلام‌شده. صفحه HTML
  آپلودشده زیر ادعای PDF در `finalize` رد می‌شود (`422`).
- **کلید شیء از ULID سرور** ساخته می‌شود: `documents/{orgId}/{class}/{ulid}`.
  کلاینت هرگز کلید نمی‌فرستد و با `uploadIntentId` بازخرید می‌کند، پس جایگزینی
  کلید ساختاراً ناممکن است نه صرفاً بررسی‌شده.
- **URL آپلود به Content-Type امضاشده مقید است** — با `signableHeaders`. پیش از
  این ادعا شده بود اما درست نبود: Presigner فقط `host` را امضا می‌کرد و یک URL
  صادرشده برای `application/pdf` آپلود `text/html` را با `200` می‌پذیرفت.
- **URL امضاشده کوتاه‌عمر**، پیش‌فرض ۳۰۰ ثانیه، سقف ۳۶۰۰. انقضا با تست واقعی
  اثبات شده (`403` پس از گذشت مهلت).
- **دانلود همیشه `attachment`** با Content-Type تشخیص‌داده‌شده — محتوا هرگز
  Render نمی‌شود.

### آنچه API هرگز برنمی‌گرداند

`objectKey`، نام Bucket، Endpoint و هیچ URL. کسی که کلید را بخواند می‌تواند با
Credential دیگری مستقیم سراغ شیء برود و تمام بررسی‌ها را دور بزند. رویدادها هم
همین‌طورند: `DOCUMENT_UPLOADED` هفت روز روی Topic می‌ماند که هر سرویسی می‌خواند.

### مجوزدهی

- `AUDITOR` هیچ دسترسی ندارد (`docs/09` § ۹٫۳) — در Gateway، در `@Roles` و در
  `access.ts` جداگانه رد می‌شود.
- خواندن میان‌مستأجری `404` می‌گیرد، نه `403` — یک رد، وجود سند را تأیید می‌کند.
- Intent آپلود حتی برای اپراتور پلتفرم قابل بازخرید میان‌مستأجری نیست.
- **هیچ Endpointی `@AllowService` ندارد** — هیچ سرویسی نمی‌تواند این API را صدا
  بزند. پیش‌فرض درست و بسته است، و یک Gap واقعی: بخش ۲۲.

### تست‌ها

| لایه                           | تعداد | یادداشت                                                                 |
| ------------------------------ | ----: | ----------------------------------------------------------------------- |
| Unit                           |   ۱۲۲ | Magic Number، Policy، ObjectKey، DownloadPolicy، DTO، OpenAPI، رویدادها |
| Integration (DB + MinIO واقعی) |    ۹۶ | چرخه کامل، API واقعی Nest، مرزهای Storage و Outbox                      |
| E2E (Playwright)               |    ۱۰ | Stack کامل با توکن واقعی Keycloak                                       |

Coverage: **۸۸٫۷۰٪ Statement، ۷۹٫۷۵٪ Branch، ۸۴٫۵۶٪ Function، ۹۰٫۰۰٪ Line**
در برابر دروازه مستندشده ۷۵٪ (`docs/14` § ۱۴٫۲) که حالا در CI اجرا می‌شود.

Migration با `node scripts/verify-migration-reversible.mjs document` واقعاً
برگردانده شد: up → down → up در ۱۴٫۲ ثانیه.

### آنچه ساخته نشده — صادقانه

- ~~**اسکن بدافزار واقعی** (Q-18)~~ — **ساخته شد (2026-08-31، ADR-049).** ClamAV
  خودمیزبان، ناهمزمان، پین‌شده به Digest. آنچه باقی می‌ماند یک محدودیت است نه یک شکاف:
  ClamAV تک‌موتوره است و بدافزار بدون امضا را نمی‌یابد.
- **اشتراک‌گذاری میان‌مستأجری** (شکاف ثبت‌نشده — هیچ Q-ای برایش باز نیست) — جدول `AccessGrant` وجود دارد اما فقط
  Subjectهای **درون** سازمان مالک را می‌پذیرد. تأمین‌کننده‌ای که مجوزش باید برای
  خریدار دیده شود، هنوز طراحی ندارد؛ اختراعش یعنی اختراع قاعده کسب‌وکار.
- **هیچ Consumer رویدادی** — `docs/04` برای این سرویس رویداد مصرفی فهرست نکرده،
  پس جدول `processed_event` هم ساخته نشد (ADR-032: داربستی که کار به نظر برسد).
- **پاکسازی دوره‌ای اشیاء یتیم** — هزینه‌ای که خود ADR-014 نام می‌برد: آپلود و
  ثبت فراداده اتمیک نیستند.
- **Versioning و Replication** — ADR-014 صریحاً در MVP خارج از Scope گذاشته.

---

## ۸. Domain Ownership

| دامنه                                   | سرویس مالک             | یادداشت                                                 |
| --------------------------------------- | ---------------------- | ------------------------------------------------------- |
| User، Membership، Role                  | `identity-service`     | User مستأجر-محدود **نیست**؛ Membership هست              |
| Organization، Hierarchy، Policy         | `organization-service` | `ltree` برای سلسله‌مراتب                                |
| Asset، Insurance، Inspection، Timeline  | `asset-service`        | مرکز الگوی Asset-Centric (ADR-012)                      |
| Driver، Assignment، Usage، Availability | `fleet-service`        | نخستین مصرف‌کننده واقعی رویدادهای Asset                 |
| Schedule، Request، RepairOrder، Cost    | `maintenance-service`  | نخستین سرویسی که مبلغی می‌سازد که کسی بابتش پول می‌گیرد |
| ۱۰ دامنه دیگر                           | سرویس‌های نساخته       | نگاه کنید `docs/04-service-decomposition.md`            |

**مالکیت «در دسترس بودن» تقسیم‌شده است** (ADR-026). `fleet-service` آن را
**ترکیب می‌کند، نه مالکیت**:

| واقعیت                    | مالک                  | چطور به fleet می‌رسد                                               |
| ------------------------- | --------------------- | ------------------------------------------------------------------ |
| وضعیت چرخه عمر دارایی     | `asset-service`       | رویداد → `asset_ref.status`                                        |
| بیمه منقضی / معاینه مردود | `asset-service`       | رویداد → `dispatchBlockedReason`                                   |
| دستگاه در تعمیرگاه        | `maintenance-service` | رویداد → `inMaintenance` — **از 2026-08-28 تولیدکننده واقعی دارد** |
| تخصیص فعال                | `fleet-service`       | جدول `assignment` خودش                                             |
| اعلام دستی                | `fleet-service`       | جدول `availability_window`                                         |

`GET /v1/fleet/availability` برای هر مانع **مالکش را نام می‌برد**، تا اپراتور
بداند به تعمیرگاه زنگ بزند یا بیمه را تمدید کند.

قاعده تغییرناپذیر: **یک سرویس هرگز پایگاه داده سرویس دیگر را نمی‌خواند.**
تأیید زنده: `psql` با نقش `rasta_asset` تلاش برای اتصال به `rasta_organization`
→ `permission denied for database` (بخش ۳).

---

## ۹. Data Ownership

هر سرویس پیاده‌شده پایگاه داده و نقش PostgreSQL اختصاصی خودش را دارد
(`infrastructure/docker/postgres/00-init-databases.sh` — ۱۶ نقش/پایگاه‌داده
برای همه ۱۶ سرویس، از قبل ساخته شده، حتی برای سرویس‌های نساخته). `REVOKE ALL
FROM PUBLIC` روی هر پایگاه داده. Extension ها (`postgis`, `ltree`, `pg_trgm`,
`pgcrypto`) در `template1` نصب شده‌اند تا Shadow DB های Prisma هم آن‌ها را
داشته باشند.

Migration State: هر سه سرویس پیاده‌شده دقیقاً **یک** Migration دارند
(`..._init_<service>`) — یعنی Schema هرکدام یک‌باره کامل طراحی و اعمال شده،
هنوز هیچ Migration تکاملی (`add_*`) روی هیچ‌کدام اجرا نشده.

---

## ۱۰. Multi-Tenancy Model

مکانیزم: Prisma Client Extension (`createTenantGuardExtension`,
`packages/nest-common/src/tenancy/tenant-guard.extension.ts`) که خودکار
`organizationId` را به هر Query تزریق می‌کند. خروج از این محدودیت فقط با
`runUnscoped(reason, fn)` — با دلیل نوشته‌شده اجباری (حداقل ۱۰ کاراکتر) —
ممکن است، که هر مورد را Greppable می‌کند.

**قاعده پاسخ:** خواندن میان‌مستأجری → **۴۰۴**، نه ۴۰۳ — تا وجود رکورد در
مستأجر دیگر فاش نشود. Header نادرست `X-Organization-Id` → **۴۰۳
TENANT_MISMATCH** (چون کاربر می‌داند عضو کدام سازمان‌هاست، فقط اجازه یکی
غلط را ندارد).

**باگ کشف و رفع‌شده این جلسه (D-003، بخش ۲۳):** `runUnscoped` به‌خاطر تنبلی
Promise های Prisma، Scope را زودتر از موعد می‌بست و Query واقعاً بدون آن اجرا
می‌شد — شکست بی‌صدا. رفع شد؛ اکنون تست شده با یک Thenable ساختگی.

---

## ۱۱. Authentication & Authorization

- **احراز هویت کاربر:** Keycloak → JWT (RS256) → `TokenVerifier` با JWKS
  (`packages/nest-common/src/auth/token-verifier.ts`). ادعای سفارشی
  `rasta_uid` چون `sub` توکن، UUID کی‌کلوک است نه `User.id` داخلی.
- **احراز هویت سرویس‌به‌سرویس:** `x-internal-token` HS256، کوتاه‌عمر، به
  یک سرویس مقصد محدود (`InternalTokenService`). فقط روی Endpoint هایی که
  `@AllowService(...)` صریح دارند پذیرفته می‌شود؛ Endpoint بدون این
  Decorator، حتی با توکن معتبر، `403 "not callable by another service"`
  می‌دهد (Zero Trust، ADR-020).
- **RBAC:** `RolesGuard` + `@Roles(...)` سطح Endpoint (فیلتر درشت)؛
  هر سرویس دوباره در سطح Object بررسی می‌کند (`AGENTS.md` A-10).
- **Purpose توکن داخلی (رفع D-007، 2026-08-27):** توکن داخلی یک Claim
  `purpose` دارد با دو مقدار:
  - **`RELAY`** — `api-gateway` درخواست کسی دیگر را Forward می‌کند.
    Gateway **همیشه** همین را صادر می‌کند و هرگز از طرف خودش عمل نمی‌کند.
    `AuthGuard` این توکن را کامل اعتبارسنجی می‌کند اما آن را «اثبات Hop»
    می‌خواند نه «هویت بازیگر»؛ پس اگر درخواست اصلی Bearer نداشته،
    **گمنام** می‌ماند و `@Public()` درباره‌اش تصمیم می‌گیرد.
  - **`SERVICE`** — سرویس A از طرف خودش سرویس B را صدا می‌زند. همان قاعده
    قبلی: `@AllowService(...)` لازم است، وگرنه `403`. توکن بدون Claim هم
    `SERVICE` خوانده می‌شود (سازگاری رو به عقب، سخت‌گیرانه‌ترین قرائت).

  این تفکیک، Zero Trust را **سفت‌تر** کرد نه شل‌تر: توکن `RELAY` هرگز
  `@AllowService` را ارضا نمی‌کند، Gateway دیگر نمی‌تواند توکنی با اقتدار
  سرویس بسازد، و توکن داخلی حتی روی Endpoint عمومی هم اعتبارسنجی می‌شود —
  یک توکن جعلی روی `POST /v1/registration-requests` اکنون
  `401 TOKEN_INVALID` می‌گیرد. جزئیات کامل و جدول تأیید زنده: `docs/23`
  بخش D-007.

---

## ۱۲. Event Architecture

- Envelope واحد (`packages/contracts/src/events/envelope.ts`):
  `eventId, eventName, eventVersion, occurredAt, producer, aggregateType,
aggregateId, tenantId, correlationId, causationId, traceparent, actor, payload`.
- Topic هر دامنه: `rasta.<domain>.v1` (+ `.retry` و `.dlq`). امروز
  `asset`, `insurance`, `fleet` و **`maintenance`** تولیدکننده واقعی دارند؛
  `marketplace` و `construction` هنوز فقط مصرف‌شونده‌اند (توسط asset-service). ۴۹ Topic از قبل در Kafka ساخته شده
  (`infrastructure/docker/kafka/create-topics.sh`) — بقیه خالی منتظرند.
- کاتالوگ کامل رویدادها: [`docs/events/README.md`](docs/events/README.md) —
  این جلسه با کد Sync شد (۵ رویداد گم‌شده اضافه، نام فیلدهای غلط اصلاح).

---

## ۱۳. Outbox / DLQ

- **Producer:** `buildOutboxRow` + جدول `outbox_message` در همان Transaction
  نوشتن دامنه؛ `OutboxRelay` با Polling، `FOR UPDATE SKIP LOCKED`، منتشر به
  Kafka با `acks=-1`، `idempotent=true`، `maxInFlightRequests=1`.
- **Consumer (این جلسه اضافه شد):** `EventConsumer`
  (`packages/nest-common/src/consumer/event-consumer.ts`) — At-Least-Once؛
  پیام غیرقابل‌تجزیه یا نامعتبر مستقیم به DLQ؛ Handler شکست‌خورده تا ۳ بار
  Retry با Backoff، سپس DLQ با Header های `x-dlq-reason/original-topic/
attempts/error/first-failed-at`. هرگز Offset را بدون رسیدگی Commit
  نمی‌کند — یک Partition گیر‌کرده قابل مشاهده و بازیابی است؛ یک رویداد مالی
  گم‌شده نیست.
- **Idempotency سمت مصرف:** جدول `processed_event` + `markEventProcessed`
  در همان Transaction اثر کسب‌وکاری — زنده تأیید شد (بخش ۳: Replay رویداد
  یکسان → دقیقاً یک خط Timeline).

---

## ۱۴. Asset-Centric Model

جزئیات کامل در بخش ۱۸ (Asset Service Memory).

---

## ۱۵. Current API Surface

### identity-service (`3101`)

```
GET    /v1/users/me
POST   /v1/users/me/active-organization
GET    /v1/users              GET /v1/users/:id
POST   /v1/users              PATCH /v1/users/:id
POST   /v1/users/:id/memberships
POST   /v1/memberships/:id/roles      POST /v1/memberships/:id/revoke
POST   /v1/registration-requests (Public)
POST   /v1/registration-requests/:id/approve   .../reject
```

### organization-service (`3102`)

```
GET  /v1/organizations                GET /v1/organizations/nearby
GET  /v1/organizations/:id            GET /v1/organizations/:id/children
GET  /v1/organizations/:id/ancestors  GET /v1/organizations/:id/subtree
GET  /v1/organizations/:id/policies
POST /v1/organizations                PATCH /v1/organizations/:id
POST /v1/organizations/:id/move       POST /v1/organizations/:id/status
POST /v1/organizations/:id/policies   POST /v1/organizations/:id/locations
POST /v1/organizations/:id/contacts
```

### asset-service (`3103`)

```
GET  /v1/assets                       GET /v1/assets/nearby
GET  /v1/assets/:id                   GET /v1/assets/:id/dossier
GET  /v1/assets/:id/timeline          GET /v1/assets/:id/insurance-policies
GET  /v1/assets/:id/inspections
POST /v1/assets                       PATCH /v1/assets/:id
POST /v1/assets/:id/activate          POST /v1/assets/:id/status
POST /v1/assets/:id/transfer          POST /v1/assets/:id/decommission
POST /v1/assets/:id/locations         POST /v1/assets/:id/documents
POST /v1/assets/:id/insurance-policies
POST /v1/assets/:id/inspections
```

هیچ Endpoint ای برای `InsuranceClaim` نیست — جدول در Migration هست، بدون
Controller/Service (بخش ۱۸، Gap).

### fleet-service (`3104`)

```
POST /v1/drivers                     GET  /v1/drivers
GET  /v1/drivers/me                  GET  /v1/drivers/:id
PATCH /v1/drivers/:id                POST /v1/drivers/:id/status
GET  /v1/drivers/:id/assignments

POST /v1/assignments                 GET  /v1/assignments
GET  /v1/assignments/:id             POST /v1/assignments/:id/end
DELETE /v1/assignments/:id           (مترادف end)

POST /v1/usage-records               GET  /v1/usage-records
GET  /v1/usage-records/:id

GET  /v1/fleet/availability          POST /v1/fleet/availability
POST /v1/fleet/availability/:id/revoke
GET  /v1/fleet/utilization
```

**انحراف آگاهانه از `docs/04` § ۴٫۶** (ADR-026): آن سند
`POST /v1/assets/{id}/assignments` و `.../usage` را نوشته بود، اما Gateway از
**نخستین قطعه مسیر** مسیریابی می‌کند و `assets/` مال `asset-service` است. منابع
به Prefix های خود fleet منتقل شدند؛ یک ردیف به جدول مسیریابی Gateway افزوده شد
(`usage-records`).

### maintenance-service (`3105`)

```
POST  /v1/maintenance-schedules        GET   /v1/maintenance-schedules
GET   /v1/maintenance-schedules/due    GET   /v1/maintenance-schedules/:id
PATCH /v1/maintenance-schedules/:id    POST  /v1/maintenance-schedules/:id/status

POST  /v1/maintenance-requests         GET   /v1/maintenance-requests
GET   /v1/maintenance-requests/:id
POST  /v1/maintenance-requests/:id/assign
POST  /v1/maintenance-requests/:id/approve
POST  /v1/maintenance-requests/:id/cancel

GET   /v1/repair-orders                GET   /v1/repair-orders/:id
POST  /v1/repair-orders/:id/start      POST  /v1/repair-orders/:id/complete
POST  /v1/repair-orders/:id/cancel
POST  /v1/repair-orders/:id/parts      POST  /v1/repair-orders/:id/labour
POST  /v1/repair-orders/:id/costs
```

**بدون هیچ تغییری در `api-gateway`.** برخلاف fleet که یک ردیف مسیریابی لازم داشت،
هر سه Prefix این سرویس (`maintenance-schedules`، `maintenance-requests`،
`repair-orders`) از زمان نوشتن جدول مسیریابی در آن بودند. «تاریخچه نگهداری یک
دستگاه» یک مسیر جدا ندارد؛ `GET /v1/maintenance-requests?assetId=` همان است — چون
Gateway از نخستین قطعه مسیر مسیریابی می‌کند و `assets/` مال `asset-service` است
(همان استدلال ADR-026).

### api-gateway (`3010` محلی)

یک مسیر Catch-all (`ALL /v1/*path`) که طبق `ROUTES` در
`services/api-gateway/src/config/routes.ts` به سرویس درست Forward می‌کند.
جدول کامل ۳۲ Prefix برای ۱۶ سرویس در آن فایل — اکثر آن‌ها به سرویسی اشاره
می‌کنند که هنوز وجود ندارد (به‌درستی `503 UPSTREAM_UNAVAILABLE` می‌دهد،
زنده تأیید شد).

منبع واقعی API: خود کد Controller بالا؛ `docs/api/README.md` فقط ساختار
تولید OpenAPI را توضیح می‌دهد، فایل‌های `*.openapi.json` تولید نشده‌اند.

---

## ۱۶. Current Database State

۵ پایگاه داده فعال با داده واقعی (از `pnpm db:seed`):

- `rasta_identity` — ۴ کاربر Seed + Membership + Role
- `rasta_organization` — ۵ سازمان (Province → Union/County → 2× Dehyari)
- `rasta_asset` — ۵ دارایی، ۳ بیمه‌نامه، ۲ معاینه فنی
- `rasta_fleet` — راننده، تخصیص، کارکرد و Replica دارایی
- `rasta_maintenance` — ۳ برنامه سرویس، ۲ درخواست (یکی تأییدشده با ۵ خط هزینه)،
  ۳ کنتور کارکرد، ۴ ردیف Replica دارایی

مدل‌های هر Schema: بخش ۷ Service Inventory بالا برای شمارش کلی؛ فهرست کامل
مدل‌ها در `prisma/schema.prisma` هر سرویس.

**۱۱ پایگاه داده دیگر** طبق `00-init-databases.sh` ساخته شده‌اند (نقش +
Database خالی، بدون Schema) — منتظر سرویس‌های نساخته.

---

## ۱۷. Infrastructure

`docker-compose.yml` — پیش‌فرض (`pnpm infra:up`) این‌ها را بالا می‌آورد:
`postgres, redis, kafka, kafka-init, keycloak, minio, minio-init, temporal,`
**`clamav, clamav-freshclam`** (ADR-049، افزوده‌شده 2026-08-31).

**ClamAV:** پین‌شده به Digest تغییرناپذیر، غیر-root (uid 100)، Rootfs فقط-خواندنی،
TCP فقط روی `127.0.0.1:3310`. `clamav-freshclam` Container جداگانه‌ای است که روی Volume
ماندگار `clamav-signatures` می‌نویسد؛ Docker آن Volume را در نخستین ساخت از خود Image
پُر می‌کند، پس شروع سرد ۱۱۰ مگابایت دانلود نمی‌کند. **Healthcheck از `clamdscan --ping`
استفاده می‌کند نه از `clamdcheck.sh` خود Image**: آن اسکریپت `nc localhost 3310` می‌زند
و Resolver آلپاین اول `::1` را جواب می‌دهد، که clamd (روی `0.0.0.0`) گوش نمی‌دهد — یعنی
روی یک Daemon کاملاً سالم «Unable to contact server» گزارش می‌کرد.
دو Profile اختیاری: `tools` (kafka-ui, temporal-ui, mailpit) و
`observability` (otel-collector, prometheus, grafana) + `search`
(opensearch) — همگی پیاده‌سازی‌شده اما پیش‌فرض بالا نمی‌آیند.

**⚠️ یافته جدید این جلسه (D-006، بخش ۲۳):** یک نصب **Native Redis روی
Windows** (`C:\Program Files\Redis\redis-server.exe`) هم‌زمان روی پورت
`6379` گوش می‌دهد — دقیقاً همان الگوی تصادم پورتی که قبلاً برای PostgreSQL
مستند شده بود (D-002 قدیمی، حل‌شده با انتقال به ۵۴۳۳). این یکی حل نشده.
شواهد کامل و اثر آن روی Rate Limiting در بخش ۲۳.

**وضعیت مشاهده‌شده زیرساخت (2026-08-28، `docker ps`):**

| سرویس    | وضعیت       | یادداشت                                           |
| -------- | ----------- | ------------------------------------------------- |
| postgres | **HEALTHY** | ۵ ساعت پایدار                                     |
| redis    | **HEALTHY** | مصرف‌کننده: فقط `api-gateway`                     |
| kafka    | **HEALTHY** | ۶ Topic ناوگان/دارایی ساخته شده                   |
| keycloak | **HEALTHY** | ۴ کاربر Seed؛ `dehyari.admin` بازیابی شد (بخش ۲۲) |
| minio    | **HEALTHY** | **NOT USED** — هیچ سرویسی هنوز لمسش نمی‌کند       |
| temporal | **HEALTHY** | **NOT USED** — هیچ Workflow ای نوشته نشده         |

**✅ D-009 رفع شد (2026-08-28).** `rasta-temporal` اکنون `healthy` است با
`FailingStreak: 0`، و — که مهم‌تر است — `docker exec rasta-temporal temporal
--version` دیگر Hang نمی‌کند و پاسخ می‌دهد:

```
temporal version 0.0.0-DEV (Server 1.26.2-125.1, UI 2.32.0)
```

یعنی ثبت پیشین که «باینری `temporal` داخل Image روی این میزبان اجرا نمی‌شود»
**پیامد خرابی محیط Docker بود (D-010)، نه نقص Image**. پس از بازسازی محیط، هم
Healthcheck و هم CLI درست کار می‌کنند. این بار **مثبتاً تأیید شده**، نه
مشاهده‌شده.

پنج سرویس دیگر (`postgres, redis, kafka, keycloak, minio`) `healthy` بودند
و ۱۷+ ساعت پایدار ماندند.

---

## ۱۸. Observability

`packages/observability` — OpenTelemetry (`RastaSampler` هرگز Span های
علامت‌خورده مالی را Drop نمی‌کند)، Prometheus (`prom-client`,
`normalizeRoute` برای جمع کردن ID ها)، pino با Redaction
(`packages/logging`, `SENSITIVE_KEYS`). هر ۴ سرویس پیاده‌شده `/health/live`
و `/health/ready` و `/metrics` دارند — زنده تأیید شد (بخش ۳).

Stack مشاهده‌پذیری (Grafana/Prometheus/OTel Collector) پیاده‌سازی شده اما
Profile اختیاری است و در این Audit بالا آورده **نشد** — بنابراین Dashboard
های واقعی مشاهده نشده‌اند؛ فقط `/metrics` خام هر سرویس بررسی شد.

---

## ۱۹. Testing State

### 2026-08-31 — پس از فاز `document-service`

| دسته                       | عدد                                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------------------- |
| Unit در `document-service` | **۱۲۲**                                                                                        |
| Integration در `document`  | **۹۶** — روی PostgreSQL **و MinIO واقعی**                                                      |
| Suiteهای Integration       | ۳ (چرخه کامل، API واقعی Nest، مرزهای Storage و Outbox)                                         |
| **E2E (Playwright)**       | **۱۰ سناریوی تازه** — Project جدید `document-api`                                              |
| پوشش `document`            | Statements ۸۸٫۷۰٪ · Branches ۷۹٫۷۵٪ · Functions ۸۴٫۵۶٪ · Lines ۹۰٫۰۰٪ (دروازه ۷۵٪، حالا در CI) |
| Migration Reversibility    | ✅ up → down → up در ۱۴٫۲ ثانیه روی Schema یک‌بارمصرف                                          |

**سه چیز که این فاز درباره خودِ کد پیدا کرد — هر سه با نوشتن تست:**

۱. **URL آپلود به Content-Type مقید نبود، هرچند کامنت ادعا می‌کرد هست.**
Presigner فقط `host` را در `X-Amz-SignedHeaders` می‌گذارد، پس گذاشتن
`ContentType` روی Command هیچ چیزی امضا نمی‌کرد: URLی که برای
`application/pdf` صادر شده بود، `PUT` با Header ‏`text/html` را با `200`
پذیرفت. یک ادعای نادرست درباره یک کنترل، از نبودِ کنترل بدتر است — خواننده
بعدی دفاع‌هایش را حول آن می‌چیند. با `signableHeaders` واقعی شد.

۲. **Gateway بدنه هر `DELETE` را بی‌صدا دور می‌ریخت.** `document-service` برای
هر حذف «دلیل» می‌خواهد؛ سرویس یک شیء تهی می‌گرفت و `400` می‌داد، در حالی که
کلاینت دلیل را فرستاده بود و هیچ‌جا نمی‌گفت کجا رفت.

۳. **سقف ۲۰ آپلود در ساعت روی خواندن هم می‌نشست.** `docs/06` § ۶٫۹ سقف را
برای **آپلود سند** تعریف کرده، اما جدول مسیریابی روی Prefix تطبیق می‌دهد، پس
یک کاربر با یک صفحه از فهرست اسناد خودش بودجه یک ساعتش را تمام می‌کرد.

### 2026-08-29 (دوم) — پس از بستن شکاف E2E

| دسته                 | عدد                                                                       |
| -------------------- | ------------------------------------------------------------------------- |
| Unit در کل Monorepo  | **۷۲۴** (۴۱۶ پیشین + ۳۰۸ economic)                                        |
| Integration در کل    | **۳۲۸** (۷۳ پیشین + ۲۵۵ economic) — روی PostgreSQL و Kafka واقعی          |
| Suiteهای Integration | ۳۰ (fleet ۴، maintenance ۵، **economic ۲۱**)                              |
| **E2E (Playwright)** | **۳۷** — روی Gateway، economic، PostgreSQL، Kafka و Keycloak واقعی        |
| پوشش `economic`      | Statements ۹۳٫۸۰٪ · **Branches ۹۰٫۱۳٪** · Functions ۹۱٫۶۶٪ · Lines ۹۵٫۷۷٪ |

**دو چیز که این فاز درباره خودِ سنجش پیدا کرد:**

۱. **آستانه پوشش هرگز سنجیده نمی‌شد.** هر دو Project در `jest.config.js`
`rootDir` را روی پوشه تست خودشان می‌گذاشتند، و Jest الگوهای
`collectCoverageFrom` را نسبت به همان `rootDir` حل می‌کند — پس `src/**`
می‌شد `src/src/**` و `test/src/**`. هیچ فایلی مطابقت نمی‌کرد،
`--coverage` گزارش می‌داد `All files | 0 | 0 | 0 | 0`، و چون فایلی برای
داوری نبود، آستانه ۹۰٪ هرگز شکست نمی‌خورد. عدد واقعی پس از رفع: **۴۴٫۸۴٪
شاخه**.

۲. **`purgeExpired` هرگز اجرا نشده بود.** یک `deleteMany` مستأجر-محدود از
Timer نگهداری، که خارج از هر درخواستی اجرا می‌شود؛ نگهبان مستأجر ردش
می‌کرد و خطا داخل `catch`ی می‌افتاد که عمداً همه‌چیز را می‌بلعد.

سرویس‌هایی که `test:integration` شان `--passWithNoTests` **ندارد**: `fleet`،
`maintenance`، `economic`. **`test:e2e` هم ندارد** — Playwright به‌صورت
پیش‌فرض روی «هیچ تستی پیدا نشد» شکست می‌خورد و همان پیش‌فرض نگه داشته شده.

### واقعی، از اجرای پیشین `pnpm verify` (نه از حافظه سند قدیمی):

```
@rasta/config                11 تست
@rasta/logging                9 تست
@rasta/observability         10 تست
@rasta/nest-common           56 تست
@rasta/api-gateway           30 تست
@rasta/identity-service      14 تست
@rasta/organization-service  21 تست
@rasta/asset-service         74 تست
@rasta/fleet-service         88 تست
@rasta/maintenance-service  102 تست   ← فاز نگهداری
———————————————————————————————
مجموع Unit                  415 تست، همه سبز
مجموع Integration            73 تست، همه سبز (fleet ۳۲، maintenance ۴۱)
E2E                           NOT IMPLEMENTED — بدون Playwright، پوشه خالی
```

از `pnpm verify` و `pnpm --filter @rasta/<service> test:integration`، اجراشده در
2026-08-28. اعداد از خروجی واقعی گرفته شده، نه از گزارش پیشین.

هر ۴۱۵ عدد روی Runner واقعی GitHub هم دیده شد — **Run `33172549841`،
Commit `24bef76`** — پس این شمارش دیگر فقط محلی نیست.

**Integration Tests — دو سرویس.** `fleet-service` (۴ Suite) و
`maintenance-service` (۵ Suite):

| Suite                                | چه چیزی را ثابت می‌کند                                                     |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `tenant-isolation.int-spec.ts`       | Extension واقعاً `where` را بازنویسی می‌کند؛ نوشتن میان‌تنانتی رد می‌شود   |
| `assignment-concurrency.int-spec.ts` | Partial Unique Index وجود دارد و دو درخواست هم‌زمان را به یکی می‌رساند     |
| `usage-outbox.int-spec.ts`           | تغییر وضعیت و Outbox با هم Commit می‌شوند؛ Replay رویداد دوم منتشر نمی‌کند |
| `event-flow.int-spec.ts`             | مسیر کامل تا Kafka و بازگشت از Consumer، با Envelope و correlationId       |

و در `services/maintenance-service/test/`:

| Suite                           | چه چیزی را ثابت می‌کند                                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `tenant-isolation.int-spec.ts`  | Extension واقعاً `where` را بازنویسی می‌کند؛ نوشتن میان‌تنانتی رد می‌شود؛ **اپراتور گزارش همکارش را در همان تنانت نمی‌بیند** |
| `request-lifecycle.int-spec.ts` | منع درخواست تکراری زیر مسابقه واقعی؛ دو تأیید هم‌زمان → یک رویداد؛ گذارهایی که جدول ممنوع کرده                               |
| `cost-atomicity.int-spec.ts`    | **ده ثبت هزینه هم‌زمان، مجموع دقیقاً برابر `SUM` پایگاه داده**؛ `ck_cost_provenance` خط بی‌مبدأ را رد می‌کند                 |
| `outbox.int-spec.ts`            | تغییر وضعیت و Outbox با هم Commit می‌شوند؛ Rollback هر دو را می‌برد؛ تفکیک هزینه روی رویداد تأیید                            |
| `event-flow.int-spec.ts`        | پیام واقعی `USAGE_RECORDED` روی Topic واقعی fleet → کنتور → `MAINTENANCE_DUE`؛ و تعمیر از Outbox تا Consumer کافکا           |

دو تغییر عمدی در Script ها:

- **`test:integration` در fleet `--passWithNoTests` ندارد.** حذف آخرین فایل
  `test/` از این پس Build را می‌شکند — دقیقاً همان شکستی که این Repository
  قبلاً تجربه کرد.
- **`test` در fleet فقط Project `unit` را اجرا می‌کند**، تا `pnpm verify` روی
  ماشین بدون Docker قابل اجرا بماند. Suite Integration یک دروازه جدا است که CI
  صریحاً در برابر سرویس‌های Provision‌شده اجرا می‌کند.

**وضعیت اجرا:** **۷۳ از ۷۳ سبز** روی PostgreSQL و Kafka واقعی (2026-08-28).

Suite ناوگان در نخستین اجرای واقعی‌اش **پنج باگ** گرفت که هیچ‌کدام با تست واحد
پیدا نمی‌شد — سه‌تا در کد تولیدی و دوتا در خود تست‌ها. فهرست کامل در بخش ۲۲.

Suite نگهداری در نخستین اجرا **هیچ باگ تولیدی نگرفت** — چون درس‌های همان پنج باگ
از ابتدا اعمال شده بودند: هیچ ستون زمانی کسب‌وکاری `@default(now())` ندارد، ترجمه
نقض Constraint روی **نام ستون** تطبیق می‌دهد نه نام Index، و `asActor` از همان روز
اول `async () => fn()` بود. **این نبودِ باگ، شاهدِ کارکردنِ حافظه پروژه است، نه
شاهدِ تست ضعیف‌تر:** تنها شکست آن اجرا یک ادعای نادرست در خودِ تست بود
(`dueBy` باید هنگام `NOT_DUE` هم گزارش شود).
همچنین هر دو Partial Unique Index و هر شش CHECK Constraint با پرس‌وجوی مستقیم
از `pg_indexes` و `pg_constraint` در پایگاه داده دیده شدند.

**E2E Tests:** `tests/e2e/` اکنون Package ‏`@rasta/e2e` است — با
`playwright.config.ts`، یک Global Setup که هر وابستگی را **مثبت** بررسی
می‌کند، و ۳۷ سناریو. `pnpm test:e2e` واقعاً اجرا می‌کند و اگر هیچ تستی پیدا
نشود شکست می‌خورد.

**چرا API و نه Browser:** `apps/web` پوشه خالی است. تست Browser باید صفحه‌ای
را Drive کند که وجود ندارد. `APIRequestContext` همان Stack واقعی را می‌زند و
Harness برای Browser آماده است (یک Project دوم در همان Config).

### ✅ CI/CD — **CI VERIFIED** (به‌روزشده برای فاز اقتصادی)

**آخرین اجرا: Run `33219920446`، Commit `a36a2cf` روی `main`، هر ۹ Job سبز.**

```
✓ Lint, types and unit tests            2m33s
✓ Security scans                        1m13s
✓ Integration and security tests        4m18s
✓ Build and scan images (identity)      3m51s
✓ Build and scan images (organization)  4m29s
✓ Build and scan images (fleet)         3m47s
✓ Build and scan images (maintenance)   3m51s
✓ Build and scan images (asset)         4m44s
✓ Build and scan images (economic)      4m58s   ← افزوده این فاز
```

**یک نقص در خودِ CI که این فاز پیدا کرد.** این نخستین اجرای CI روی یک
Pull Request در این Repository بود. `gitleaks` برای تصمیم‌گیری درباره اینکه چه
چیزی را Scan کند، Commitهای PR را از API می‌خواند — و Job دسترسی
`pull-requests: read` نداشت، چون تا امروز فقط روی Push به `main` اجرا شده بود و
آنجا این فراخوانی اصلاً انجام نمی‌شود. نتیجه `403 Resource not accessible by
integration` بود که **دقیقاً شبیه یافتن یک Secret به نظر می‌رسید**. هیچ Secret ی
پیدا نشده بود؛ Scan اصلاً شروع نشده بود.

### پیشین — فاز ناوگان

**نخستین Run سبز روی کد کامل ناوگان: `33147827056`، Commit `d2f82f8`،
success در ۱۱ دقیقه.** این همان Commit ای است که آخرین تغییر کد فاز را دارد؛
Commit های پس از آن فقط مستندات‌اند.

| Run           | Commit    | محتوا                          | نتیجه                                               |
| ------------- | --------- | ------------------------------ | --------------------------------------------------- |
| `33147388059` | `97430e7` | کد کامل ناوگان                 | **failure** — Race در Group Coordinator کافکا (زیر) |
| `33147827056` | `d2f82f8` | + رفع همان Race                | success                                             |
| `33161899302` | `99ee98a` | فقط مستندات (پایان فاز ناوگان) | success                                             |
| `33172549841` | `24bef76` | **کد کامل نگهداری + مستندات**  | **success — هر ۸ Job، ۱۲ دقیقه و ۴۴ ثانیه**         |

**قاعده به‌روزرسانی:** این جدول فقط وقتی تغییر می‌کند که **کد** عوض شود؛ Commit
مستنداتیِ بعدی لازم نیست اینجا ثبت شود.

فاز نگهداری در **نخستین اجرا** سبز شد — برخلاف فاز ناوگان که یک بار شکست. هر
**هشت** Job سبز: پنج Image به‌جای چهار، و ۷۳ تست Integration به‌جای ۳۲.

| Job                            | مراحلی که واقعاً اجرا شدند                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------------- |
| Lint, types and unit tests     | install · db:generate · Format · Lint · Typecheck · **۴۱۵ تست واحد** · Build                    |
| Security scans                 | Gitleaks · `pnpm audit --audit-level=high` · Semgrep                                            |
| Integration and security tests | Postgres + Redis + **Kafka** · ساخت ۸ Topic · Migration · **۷۳ تست Integration** · Tenant/AuthZ |
| Build and scan images × **۵**  | identity · organization · asset · fleet · **maintenance** — هرکدام Build + Trivy                |

**شواهد اینکه دروازه‌ها واقعاً چیزی را اجرا کردند** (نه اینکه تهی سبز شوند) — همه
از Log خود Runner، نه از وضعیت سبز:

- تست واحد: ده خط `Tests: N passed`، که جمعشان دقیقاً ۴۱۵ می‌شود
  (۱۰۲ تای آن `maintenance`).
- Integration: `PASS integration test/cost-atomicity.int-spec.ts`،
  `PASS integration test/event-flow.int-spec.ts (17.187 s)` و
  `Tests: 41 passed, 41 total` برای نگهداری، `32 passed` برای ناوگان.
- مرحله Tenant/AuthZ: الگوی نام حالا `duplicate` و `provenance` را هم می‌گیرد و
  روی نگهداری **۱۲ تست** و روی ناوگان **۱۹ تست** واقعاً اجرا شد — یعنی الگو
  چیزی را Match کرد، نه اینکه با صفر تست سبز شود.
- Trivy روی Image نگهداری: `Detected OS family="alpine" version="3.24.1"`،
  `os_version="3.24" pkg_num=18`، `Number of language-specific files num=1` —
  با شدت `CRITICAL,HIGH` و `exit-code: 1`، بدون یافته گذشت.

**نخستین اجرا (Run `33147388059`) شکست خورد — و درست شکست خورد.**
یک Race واقعی را پیدا کرد که هیچ اجرای محلی نمی‌توانست: Broker تازه‌راه‌افتاده به
`kafka-topics --list` پاسخ می‌دهد (که Healthcheck همان را می‌پرسد) در حالی که
`__consumer_offsets` هنوز بارگذاری می‌شود، پس Consumer تست «group coordinator is
not available» می‌گیرد و در پس‌زمینه Retry می‌کند — بی‌آنکه `run()` خطا بدهد.
تست آن‌گاه روی Topic ای منتشر می‌کرد که کسی نمی‌خواند. روی ماشین توسعه Broker
ساعت‌هاست بالاست، پس این هرگز دیده نمی‌شد.

**دو هشدار صادقانه که نباید با «سبز» اشتباه شوند:**

1. **`--passWithNoTests` هنوز در چهار سرویس دیگر هست** — `identity`,
   `organization`, `asset`, `api-gateway`. هر چهار Project Integration شان
   **تهی** است، پس سهم آن‌ها از مرحله Integration همچنان یعنی «چیزی نشکست».
   تنها `fleet-service` این Flag را ندارد. بستن این شکاف برای هر سرویس، کار
   همان سرویس است، نه فاز ناوگان.
2. مرحله «Tenant isolation and authorization» دو فرمان اجرا می‌کند؛ فرمان اول
   روی Project های Unit با Name Pattern فیلتر می‌شود و در بعضی سرویس‌ها صفر تست
   می‌ماند (`11 skipped`). شاهد واقعی، فرمان دوم روی Project Integration ناوگان
   است.

---

## ۲۰. Security State

| مکانیزم                               | Implemented | Tested |                  Live Verified                  | یادداشت                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------- | :---------: | :----: | :---------------------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Authentication (JWT/JWKS)             |     ✅      |   ✅   |                       ✅                        | زنده دوباره تأیید شد: `200` با JWT کی‌کلوک از راه Gateway                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Authorization (RBAC سطح Endpoint)     |     ✅      |   ✅   |                       ✅                        | زنده: `province.auditor` → `POST /v1/users` → `403 INSUFFICIENT_ROLE`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Tenant Isolation (API + DB)           |     ✅      |   ✅   |                       ✅                        | زنده: `X-Organization-Id` بیگانه → `403 TENANT_MISMATCH`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Service-to-Service Auth (Zero Trust)  |     ✅      |   ✅   |                       ✅                        | D-007 رفع شد؛ Claim `purpose` — RELAY در برابر SERVICE (بخش ۱۱)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Rate Limiting (منطق Redis)            |     ✅      |   ✅   |                    ⚠️ مسدود                     | D-006: تصادم پورت Redis                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Input Validation (Zod در مرز)         |     ✅      |   ✅   |                       ✅                        |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Object-level Authorization (BOLA)** |     ✅      |   ✅   |                       ✅                        | **IMPLEMENTED در fleet و maintenance.** fleet (`src/fleet/access.ts`): `DRIVER`/`OPERATOR` فقط رکورد خود و دستگاهی که در دست دارند. maintenance (`src/maintenance/access.ts`): اپراتور فقط گزارش‌های خودش — **باریک‌تر از قاعده مستند، و در جهت امن** (ADR-029، Q-24/Q-25). سه سرویس دیگر هنوز ندارند.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Non-disclosure میان تنانتی**        |     ✅      |   ✅   |                       ✅                        | زنده: منبع تنانت دیگر → **`404`**، هرگز `403` — روی Driver، Assignment و UsageRecord آزموده شد                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Audit Trail                           |   ⚠️ جزئی   |   ✅   |                       نشد                       | **AUD-001:** Projector مسیر A — ده Topic دامنه‌ای در `audit_event` فقط‌الحاقی. **AUD-002:** API خواندن مستأجر-امن — `GET /v1/audit-events` و `/{id}`، پنجرهٔ اجباری با سقف `AUDIT_MAX_QUERY_WINDOW_DAYS`، صفحه‌بندی Cursor، زیردرخت `UNION_ADMIN` از Projection محلی `organization_ref` با Fail-Closed. **AUD-003 (نیمهٔ شواهد دست‌نخوردگی، 2026-09-10):** زنجیرهٔ Hash به‌ازای `(organizationId، ماه UTC)` در همان تراکنش درج، جدول `audit_chain_head` با Trigger «فقط رو به جلو»، و `GET /v1/audit-events/verify` — روی PostgreSQL واقعی اثبات شده. زنجیره **Tamper-Evident** است نه Tamper-Proof و **امضا ندارد**. هنوز بدون رکورد جبرانی (`audit.correction` — نیمهٔ دوم AUD-003، وابسته به مسیر B)، بدون صادرات و بدون مصرف‌کنندهٔ `rasta.audit.trail.v1` (AUD-004). **AUD-004 Phase A (2026-09-11):** فقط قرارداد — `packages/contracts/src/events/audit-trail.ts`، `AUDIT_EVENT_RECORDED` نسخهٔ ۱؛ مالکیت هر دو Producer آینده به `identity-service` تصمیم گرفته شد. **AUD-004 Phase B (2026-09-11):** Consumer مسیر B — `AuditTrailConsumer` با گروه ثابت `audit-service.trail` روی `rasta.audit.trail.v1`؛ Envelope، نام/نسخه، Payload و توافق مستأجر پیش از نوشتن بررسی می‌شوند و پیام ردشده نه ردیف می‌سازد نه نشانگر `processed_event`؛ اصلاح ردیف تازه با `correction_of` است؛ روی PostgreSQL و Kafka واقعی تست شده. **AUD-004 Phase C1 (2026-09-11):** نخستین Producer — `identity-service` برای یک رد (`POST /v1/users/me/active-organization` → `403 TENANT_MISMATCH`) از راه `security_event_outbox` محلی و Relay دوم ADR-050؛ ثبت best-effort و کراندار، پاسخ `403` هرگز تغییر نمی‌کند؛ سرتاسری تا `audit_event` روی PostgreSQL و Kafka واقعی آزموده شد. **AUD-004 Phase C2 (2026-09-11):** تجمیع پنجره‌ای همان رد — ردهای یکسان در یک پنجرهٔ UTC (پیش‌فرض ۶۰ ثانیه) یک ردیف با `occurrenceCount` می‌شوند و فقط پس از بسته‌شدن پنجره منتشر می‌شوند؛ اتمیک زیر هم‌زمانی و ایمن در برابر مسابقه با Claim، روی PostgreSQL و Kafka واقعی و Black-Box آزموده شد. **AUD-004 Phase C3 (2026-09-12):** محل رد دوم — `GET /v1/users` → `403 INSUFFICIENT_ROLE` از `RolesGuard`، با Guard محلی `IdentityRolesGuard` و همان تجمیع؛ روی PostgreSQL، Kafka و Black-Box آزموده شد. **AUD-004 Phase C4 (2026-09-12):** محل رد سوم — `POST /v1/users` → `403 INSUFFICIENT_ROLE` از `RolesGuard`، فقط یک ورودی ثابت تازه (`identity.users.create`، Q-46)؛ روی PostgreSQL، Kafka و Black-Box آزموده شد. **AUD-004 Phase C5 (2026-09-12):** محل رد چهارم — `POST /v1/users/:id/memberships` → `403 INSUFFICIENT_ROLE` از `RolesGuard`، فقط یک ورودی ثابت تازه (`identity.memberships.create`، Resource همیشه فراخوان، Q-47)؛ روی PostgreSQL، Kafka و Black-Box آزموده شد. **AUD-004 Phase C6 (2026-09-12):** محل رد پنجم — `POST /v1/memberships/:id/roles` → `403 INSUFFICIENT_ROLE` از `RolesGuard`، فقط یک ورودی ثابت تازه (`identity.memberships.roles.replace`، Resource همیشه فراخوان، Q-48)؛ روی PostgreSQL، Kafka و Black-Box آزموده شد. **AUD-004 Phase C7 (2026-09-12):** محل رد ششم — `POST /v1/memberships/:id/revoke` → `403 INSUFFICIENT_ROLE` از `RolesGuard`، فقط یک ورودی ثابت تازه (`identity.memberships.revoke`، Resource همیشه فراخوان، Q-49)؛ روی PostgreSQL، Kafka و Black-Box آزموده شد. **AUD-004 Phase C8 (2026-09-12):** محل رد هفتم — `POST /v1/registration-requests/:id/approve` → `403 INSUFFICIENT_ROLE` از `RolesGuard`، فقط یک ورودی ثابت تازه (`identity.registration_requests.approve`، Resource همیشه فراخوان، Q-50)؛ روی PostgreSQL، Kafka و Black-Box آزموده شد. **AUD-004 Phase C9 (2026-09-12):** محل رد هشتم و آخرین Route دارای `@Roles` — `POST /v1/registration-requests/:id/reject` → `403 INSUFFICIENT_ROLE` از `RolesGuard`، فقط یک ورودی ثابت تازه (`identity.registration_requests.reject`، Resource همیشه فراخوان، Q-51)؛ روی PostgreSQL، Kafka و Black-Box آزموده شد. **AUD-004 Phase C10 (2026-09-12):** محل رد نهم — `403 TENANT_MISMATCH`ِ خودِ `AuthGuard` پلتفرم برای `X-Organization-Id` بیرون از عضویت‌های Token تأییدشده؛ تنها محل Route-agnostic (`identity.tenant_context.select`، مستأجر = سازمان فعالِ Token و نه Headerِ ردشده، Q-52)؛ یک درز عمومی و اختیاری در `AuthGuardOptions` انتساب مورد اعتماد را می‌دهد و سیاست حسابرسی در identity می‌ماند؛ بدون سازمان فعال Fail-Closed؛ روی PostgreSQL، Kafka و Black-Box آزموده شد. **AUD-003 نیمهٔ اصلاح (2026-09-12):** فرمان `POST /v1/audit-corrections` در `identity-service` (فقط `SYSTEM_ADMIN`، `Idempotency-Key` الزامی، اثبات هدف از Endpoint داخلی `audit-service`) یک `AUDIT_EVENT_RECORDED` v1 از `outbox_message` استاندارد منتشر می‌کند؛ رکورد تازهٔ زنجیرشده با `correctionOf`، اصل دست‌نخورده، و `correctionOf`/`correctedBy[]` در خواندن. هنوز بدون `SERVICE_TENANT_CONTEXT_INVALID`/`FORBIDDEN`، ردهای متوقف‌شده در Gateway، رول‌اوت به سرویس‌های دیگر، صادرات و Purge |
| Secrets فقط از Env                    |     ✅      |   —    | ✅ (`.env` بررسی شد؛ Secret واقعی در Repo نیست) |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Security Headers (helmet)             |     ✅      |   —    |                       ✅                        | CSP، HSTS، Referrer-Policy                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| mTLS بین سرویس‌ها                     |     ❌      |   —    |                        —                        | **PLANNED** — صفر ارجاع در کد (`grep` تأیید شد). Production-only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Database RLS                          |     ❌      |   —    |                        —                        | **PLANNED** — صفر Migration دارد. Tenant Isolation فعلاً **فقط لایه Application** است                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

**وضعیت High-risk items پس از Task سخت‌سازی 2026-08-27:**

- ✅ **D-005 رفع شد** — CI روی GitHub Actions سبز است (**CI VERIFIED**).
- ✅ **D-007 رفع شد** — ثبت‌نام گمنام از راه Gateway کار می‌کند
  (**LIVE VERIFIED**)، بدون تضعیف Zero Trust.
- ✅ **D-010 رفع شد** — Docker بازیابی شد؛ ریشه: Socket های یتیم (بخش ۲۲).
- ⏳ **D-006 باز است** — تصادم پورت Redis روی این ماشین توسعه.
- 🆕 **D-008 باز است** — سه قاعده Supply-Chain که Lockfile فعلی رد می‌کند.
- ✅ **D-009 رفع شد** — Temporal `healthy` است و CLI داخل Image پاسخ می‌دهد.

**تفکیک IMPLEMENTED از PLANNED — تأییدشده با بازرسی کد، نه با سند:**

| کنترل                                              | وضعیت واقعی                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Keycloak / OIDC / JWKS                             | **IMPLEMENTED** + LIVE VERIFIED                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| اعتبارسنجی JWT (`iss`, `exp`)                      | **IMPLEMENTED** + LIVE VERIFIED — Container توکن با `iss` نامنطبق را رد کرد                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Tenant Isolation سطح Application                   | **IMPLEMENTED** + LIVE VERIFIED + CI VERIFIED                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Object-level Authorization                         | **IMPLEMENTED** در fleet و maintenance؛ سه سرویس دیگر **NOT IMPLEMENTED**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| پورتال `WORKSHOP` (میان‌تنانتی)                    | **DEFERRED** — مدل دسترسی میان‌تنانتی وجود ندارد؛ نقش `WORKSHOP` هیچ نمی‌بیند (ADR-029)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| احراز صلاحیت تعمیرگاه                              | **NOT IMPLEMENTED** — `supplier-service` نیست؛ Port نام‌گذاری‌شده که نبودِ بررسی را Log می‌کند                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Database RLS                                       | **PLANNED** — صفر Migration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| mTLS سرویس‌به‌سرویس                                | **PLANNED** — صفر ارجاع در کد                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Audit Trail ماندگار                                | **PARTIAL** — AUD-001 (Projector ده Topic) + AUD-002 (API خواندن مستأجر-امن) + نیمهٔ شواهد دست‌نخوردگی AUD-003 (زنجیرهٔ Hash، `audit_chain_head`، `GET /v1/audit-events/verify` — اثبات‌شده روی PostgreSQL، بدون امضا) + AUD-004 Phase A (فقط قرارداد `AUDIT_EVENT_RECORDED` v1 در `packages/contracts`؛ مالکیت Producer آینده به `identity-service` تصمیم گرفته شد) + AUD-004 Phase B (Consumer مسیر B، گروه `audit-service.trail`، اعتبارسنجی Fail-Closed و Idempotent — تست‌شده روی PostgreSQL و Kafka واقعی) + AUD-004 Phase C1 (Producer مرجع در `identity-service` برای یک رد، با `security_event_outbox` و Relay دوم ADR-050 — سرتاسری روی PostgreSQL و Kafka واقعی) + AUD-004 Phase C2 (تجمیع پنجره‌ای همان رد با `occurrenceCount`، Configurable، اتمیک و ایمن در برابر Claim) + AUD-004 Phase C3 (محل رد دوم: `GET /v1/users` → `INSUFFICIENT_ROLE` از `RolesGuard`) + AUD-004 Phase C4 (محل رد سوم: `POST /v1/users` → `INSUFFICIENT_ROLE` از `RolesGuard`) + AUD-004 Phase C5 (محل رد چهارم: `POST /v1/users/:id/memberships` → `INSUFFICIENT_ROLE` از `RolesGuard`) + AUD-004 Phase C6 (محل رد پنجم: `POST /v1/memberships/:id/roles` → `INSUFFICIENT_ROLE` از `RolesGuard`) + AUD-004 Phase C7 (محل رد ششم: `POST /v1/memberships/:id/revoke` → `INSUFFICIENT_ROLE` از `RolesGuard`) + AUD-004 Phase C8 (محل رد هفتم: `POST /v1/registration-requests/:id/approve` → `INSUFFICIENT_ROLE` از `RolesGuard`) + AUD-004 Phase C9 (محل رد هشتم: `POST /v1/registration-requests/:id/reject` → `INSUFFICIENT_ROLE` از `RolesGuard`؛ هیچ Route دارای `@Roles` باقی نمانده) + AUD-004 Phase C10 (محل رد نهم: `TENANT_MISMATCH`ِ خودِ `AuthGuard`، Route-agnostic، با انتساب مورد اعتماد از درز عمومی `AuthGuardOptions`) + **نیمهٔ اصلاحِ AUD-003 (فرمان `audit.correction`)**: `POST /v1/audit-corrections` در identity با اثبات هدف از راه Endpoint داخلی audit، یک ردیف Outbox استاندارد، Idempotency واقعی در `audit_correction_command`، و `correctionOf`/`correctedBy[]` در خواندن؛ صادرات، Purge، امضا، `403`های دیگر و رول‌اوت به سرویس‌های دیگر (بقیهٔ AUD-004 و R-2) هنوز نیستند |
| ریشه، خرابی محیط Docker بود (D-010)، نه نقص Image. |

---

## ۲۱. Current Runtime State

در لحظه تأیید زنده (2026-08-28)، هر ۶ سرویس پیاده‌شده از حالت تمیز بالا آمدند و
سالم گزارش دادند:

```
api-gateway           :3010   {"status":"ok","checks":{"redis":true}}
identity-service      :3101   {"status":"ok","checks":{"database":true,"kafka":true}}
organization-service  :3102   {"status":"ok","checks":{"database":true,"kafka":true}}
asset-service         :3103   {"status":"ok","checks":{"database":true,"kafka":true}}
fleet-service         :3104   {"status":"ok","checks":{"database":true,"kafka":true}}
maintenance-service   :3105   {"status":"ok","checks":{"database":true,"kafka":true}}
```

Infra Docker: `postgres, redis, kafka, keycloak, minio` همه `healthy`.
**`temporal` سالم است و این بار مثبتاً تأیید شد** — هم Healthcheck
(`FailingStreak: 0`) و هم `temporal --version` داخل Image. D-009 رفع شد؛ ریشه،
خرابی محیط Docker بود (D-010).

### جدول شواهد تأیید زنده — `fleet-service`

هر ردیف یک فرمان واقعی از راه Gateway (`:3010`) با توکن واقعی Keycloak است.

| #   | آنچه آزموده شد                      | نتیجه واقعی                                                                             |
| --- | ----------------------------------- | --------------------------------------------------------------------------------------- |
| ۱   | درخواست بدون توکن                   | `401` — Endpoint پیش‌فرض بسته                                                           |
| ۲   | توکن `dehyari.admin` (ORG-DEH-0001) | `200`، Claim ها: `rasta_uid`، `org_id`، ۳ نقش                                           |
| ۳   | `GET /v1/fleet/availability`        | هر مانع با **مالکش**: `ACTIVE_ASSIGNMENT(fleet-service)`، `ASSET_STATUS(asset-service)` |
| ۴   | `POST /v1/assignments`              | `201`، `active=true`، `assignedBy=USR-SEED-DEHYARI-ADMIN`                               |
| ۵   | Outbox → Kafka                      | ردیف `outbox_message` با `topic=rasta.fleet.v1`, `key=AST-SEED-0002`, منتشر             |
| ۶   | **Asset Projector**                 | خط `تخصیص به راننده` در Timeline دارایی، `sourceService=fleet-service`                  |
| ۷   | وضعیت دارایی                        | `IDLE → ASSIGNED` (توسط `ASSET_ASSIGNED`)                                               |
| ۸   | `correlationId`                     | `e2e-…` یکسان در: درخواست HTTP، `outbox.correlation_id`، Header کافکا                   |
| ۹   | Idempotency ثبت کارکرد              | دو ارسال با `clientReference` یکسان → **همان `USG_…`**                                  |
| ۱۰  | Idempotency مصرف‌کننده              | همان رویداد دوباره روی کافکا منتشر شد → Timeline **بدون خط دوم**                        |
| ۱۱  | انحصار دارایی                       | `422 BUSINESS_RULE_VIOLATION` — «machine in state ASSIGNED»                             |
| ۱۲  | انحصار راننده                       | `422` — «This driver already holds an active assignment»                                |
| ۱۳  | پایان تخصیص                         | `ASSIGNMENT_ENDED` → دارایی به `ACTIVE` بازگشت، خط Timeline ثبت شد                      |
| ۱۴  | Tenant Isolation (خواندن تخصیص)     | `union.admin` → **`404`**، نه ۴۰۳                                                       |
| ۱۵  | Tenant Isolation (خواندن راننده)    | `union.admin` → **`404`**                                                               |
| ۱۶  | مجوز سطح نقش                        | `province.auditor` → `POST /v1/drivers` → `403 INSUFFICIENT_ROLE`                       |
| ۱۷  | مجوز سطح Object                     | `province.auditor` → فهرست راننده‌ها **خالی** (به رکورد خودش محدود شد)                  |
| ۱۸  | انقضای توکن                         | توکن منقضی → `401 TOKEN_EXPIRED`                                                        |
| ۱۹  | Docker Image                        | Build شد، اجرا شد، `uid=100(rasta)`، بدون `npm/npx/corepack`                            |
| ۲۰  | E2E از داخل **Container**           | تخصیص از Container → Kafka → Timeline دارایی                                            |

**یک یافته امنیتی مثبت در همین مسیر:** Container با `OIDC_ISSUER_URL` داخلی
(`keycloak:8080`) توکنی با `iss=localhost:8080` را **رد کرد** (`TOKEN_INVALID`).
یعنی بررسی `iss` واقعاً اجرا می‌شود (S-04)، نه اینکه فقط امضا بررسی شود.

Kafka Consumer Group های فعال: `asset-service.timeline`،
`fleet-service.asset-sync`، `maintenance-service.usage` و
`maintenance-service.asset-sync`.

---

### جدول شواهد تأیید زنده — `maintenance-service` (بخش ۲۱-ب)

هر ردیف یک فرمان واقعی از راه Gateway (`:3010`) با توکن واقعی Keycloak است، مگر
جایی که صریحاً «پایگاه داده» یا «کافکا» نوشته شده. اجراشده در 2026-08-28 با هر شش
سرویس بالا.

| #   | آنچه آزموده شد                            | نتیجه واقعی                                                                                           |
| --- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| ۱   | درخواست بدون توکن                         | `401` — Endpoint پیش‌فرض بسته                                                                         |
| ۲   | توکن منقضی/نامعتبر                        | `401 TOKEN_INVALID`                                                                                   |
| ۳   | `GET /v1/maintenance-schedules/due`       | گریدر: **`OVERDUE` on `HOURS`**، کنتور `4380.50`، سررسید `4370.50` — **محاسبه‌شده، نه ذخیره‌شده**     |
| ۴   | `…/due?includeNotDue=true`                | برنامه دوم: `NOT_DUE` on `TIME`، `dueBy=2027-02-14` — هر دو پاسخ در یک فراخوان                        |
| ۵   | پیوند برنامه ↔ درخواست باز                | `openRequestId=MNT-SEED-0002` — بدون N+1، یک Query برای کل صفحه                                       |
| ۶   | `POST /v1/maintenance-requests`           | `201`، `status=OPEN`، `reportedBy=USR-SEED-DEHYARI-ADMIN`                                             |
| ۷   | **منع درخواست تکراری**                    | `422 BUSINESS_RULE_VIOLATION` — «This machine already has an open request of that kind»               |
| ۸   | `POST …/{id}/assign`                      | `201`، دستور تعمیر ساخته شد، `WORKSHOP_ASSIGNED` منتشر شد                                             |
| ۹   | `POST /v1/repair-orders/{id}/start`       | `200` — و اینجاست که دستگاه از سرویس خارج می‌شود                                                      |
| ۱۰  | ثبت دو قطعه، دستمزد و یک هزینه مستقیم     | ۴ ردیف؛ `2 × 850000 = 1700000`، `12.5 × 320000 = 4000000`، `6.5 × 900000 = 5850000`                   |
| ۱۱  | **مبدأ هر خط هزینه**                      | دو خط `PART` → `PTU_…`، یک `LABOUR` → `LBR_…`، یک `SERVICE` → «واردشده توسط `USR-SEED-DEHYARI-ADMIN`» |
| ۱۲  | مجموع‌ها                                  | `parts 5700000 + labour 5850000 + other 1200000 = 12750000` — بازمحاسبه‌شده از خطوط                   |
| ۱۳  | **fleet دستگاه در تعمیرگاه را رد می‌کند** | `POST /v1/assignments` → `422` «This machine is in maintenance and cannot be assigned»                |
| ۱۴  | تأیید پیش از اتمام کار                    | `409 INVALID_STATE_TRANSITION` — «cannot move from IN_PROGRESS to APPROVED»                           |
| ۱۵  | `POST /v1/repair-orders/{id}/complete`    | `200`؛ `REPAIR_COMPLETED` و `MAINTENANCE_COMPLETED` هر دو منتشر شدند                                  |
| ۱۶  | تأیید با مبلغ کهنه                        | `422` — «The cost has changed since it was shown to you»                                              |
| ۱۷  | تأیید با مبلغ درست                        | `200`، `status=APPROVED`، `approvedBy` ثبت شد                                                         |
| ۱۸  | تأیید دوباره                              | `409` — «This maintenance request is already APPROVED»                                                |
| ۱۹  | **پرونده دارایی (پایگاه داده asset)**     | سه خط Timeline از `maintenance-service`: گزارش خرابی · ثبت درخواست · شروع تعمیر                       |
| ۲۰  | **وضعیت دارایی**                          | `ACTIVE → IN_MAINTENANCE → ACTIVE` — هر دو گذار از رویداد، نه از API                                  |
| ۲۱  | **Replica ناوگان (پایگاه داده fleet)**    | `in_maintenance` روشن شد و پس از پایان تعمیر خاموش شد                                                 |
| ۲۲  | Outbox                                    | هر ۷ رویداد یک درخواست، همه با `partition_key = AST-SEED-0002` و همه `published`                      |
| ۲۳  | **کافکا (خواندن واقعی از Topic)**         | `MAINTENANCE_APPROVED` روی `rasta.maintenance.v1` با `totalCostMinor="12750000"` و تفکیک سه‌خطی       |
| ۲۴  | `correlationId`                           | `live-mnt-…` یکسان در: درخواست HTTP، `outbox.correlation_id`، و Envelope روی کافکا                    |
| ۲۵  | **downtime**                              | `3180` دقیقه — از `outOfServiceAt` (۲۶ مرداد ۰۸:۰۰)، نه از شروع تعمیر                                 |
| ۲۶  | **FLOW A زنده**                           | ثبت کارکرد در fleet → کافکا → کنتور `4380.50 → 4386.50` → `MAINTENANCE_DUE` منتشر شد                  |
| ۲۷  | Idempotency ثبت کارکرد                    | دو ارسال با `clientReference` یکسان → **همان `USG_…`**؛ کنتور یک‌بار شمرد (`43 → 44`)                 |
| ۲۸  | **اعلام یک‌بار در هر چرخه**               | خواندن دوم کارکرد → `MAINTENANCE_DUE` **دوباره منتشر نشد** (همچنان ۱ ردیف)                            |
| ۲۹  | Tenant Isolation (خواندن درخواست)         | `union.admin` → **`404`**، نه ۴۰۳                                                                     |
| ۳۰  | Tenant Isolation (خواندن دستور تعمیر)     | `union.admin` → **`404`**                                                                             |
| ۳۱  | Tenant Isolation (فهرست برنامه‌ها)        | `union.admin` → فهرست **خالی**، در حالی که دو برنامه در تنانت دیگر وجود دارد                          |
| ۳۲  | مجوز سطح نقش                              | `province.auditor` → ثبت درخواست، ارجاع و ساخت برنامه → هر سه `403 INSUFFICIENT_ROLE`                 |
| ۳۳  | Docker Image                              | Build شد، اجرا شد، `uid=100(rasta)`، بدون `npm/npx/corepack`، Healthcheck `healthy`                   |
| ۳۴  | آمادگی از داخل Container                  | `200 {"checks":{"database":true,"kafka":true}}` — و هر دو Consumer به Group پیوستند                   |
| ۳۵  | متریک‌ها                                  | ۹ سری با داده واقعی، از جمله Histogram توقف (۵۳ ساعت، سطل `72`)                                       |

**یک یافته مثبت در همین مسیر:** پیش از اینکه `MAINTENANCE_STARTED` منتشر شود،
`fleet-service` تخصیص راننده به همان دستگاه را می‌پذیرفت؛ پس از انتشار، `422` داد.
یعنی Replica ناوگان واقعاً از رویداد به‌روز می‌شود، نه از یک فرض.

---

---

### جدول شواهد تأیید زنده — `economic-service` (بخش ۲۱-ج)

اجرا شده 2026-08-29 روی Stack واقعی: PostgreSQL، Kafka، Keycloak و
`api-gateway` روی `localhost:3010`. هر درخواست با **توکن واقعی Keycloak** از
`rasta-web` و با `X-Correlation-Id` مشخص. هیچ Mock ی در مسیر نیست جز
ارائه‌دهنده پرداخت، که خودش موضوع ADR-024 است.

| #   | سناریو                                     | نتیجه مشاهده‌شده                                                                                                 |
| --- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| ۱   | اعلام ارائه‌دهنده پرداخت                   | `{"provider":"mock","simulated":true,"notice":"Simulated payment provider. No bank connection, no real funds…"}` |
| ۲   | `GET /v1/wallets/me` — نخستین استفاده      | کیف پول `WLT_01M1584GV0…` ساخته شد؛ هر سه مانده صفر                                                              |
| ۳   | شارژ **بدون** `Idempotency-Key`            | `400 VALIDATION_FAILED` روی `headers.idempotency-key`                                                            |
| ۴   | شارژ با کلید                               | `201`، `status: CAPTURED`، `simulated: true`، مانده ۵۰٬۰۰۰٬۰۰۰                                                   |
| ۵   | همان کلید، همان بدنه                       | `201` با **دقیقاً همان** `paymentIntentId` و `journalId` — بدون شارژ دوم                                         |
| ۶   | همان کلید، بدنه متفاوت                     | `409 IDEMPOTENCY_KEY_REUSED`                                                                                     |
| ۷   | مانده پس از یک شارژ (نه دو)                | ۵۰٬۰۰۰٬۰۰۰ — تأیید اینکه Replay شارژ دوم نزد                                                                     |
| ۸   | شکست تحریک‌شده ارائه‌دهنده                 | `status: FAILED`، `failureReason: INSUFFICIENT_FUNDS`، `transactionId: null`، `journalId: null`                  |
| ۹   | مانده پس از پرداخت شکست‌خورده              | **تغییر نکرد** — کیف پول فقط در Capture بستانکار می‌شود، نه در Authorize                                         |
| ۱۰  | ثبت تراکنش با Hold                         | `201`، `status: HELD`، دو Leg (PAYER/PAYEE)                                                                      |
| ۱۱  | کیف پول پس از Hold                         | مجموع ۱۰۰م، **در امانت ۱۲م، در دسترس ۸۸م** — پول ناپدید نشد، تعهد شد                                             |
| ۱۲  | تسویه **پیش از** تأیید دریافت              | `409 INVALID_STATE_TRANSITION` — «A HELD transaction cannot be settled»                                          |
| ۱۳  | تأیید دریافت                               | `200`، `status: PENDING_SETTLEMENT`                                                                              |
| ۱۴  | تسویه                                      | `201`، ناخالص ۱۲م، کارمزد **۰**، خالص ۱۲م، `commissionRuleMatched: false`                                        |
| ۱۵  | کیف پول پرداخت‌کننده پس از تسویه           | مجموع ۸۸م، در امانت ۱۲م (Hold قدیمی‌تر)، در دسترس ۷۶م                                                            |
| ۱۶  | نمای دریافت‌کننده (`includeIncoming=true`) | تراکنش `SETTLED` را می‌بیند — همان چیزی که Filter تک‌مستأجری پنهانش می‌کرد                                       |
| ۱۷  | کیف پول دریافت‌کننده                       | **۱۲٬۰۰۰٬۰۰۰ بستانکار شد**                                                                                       |
| ۱۸  | `AUDITOR` روی کیف پول                      | `403 INSUFFICIENT_ROLE`                                                                                          |
| ۱۹  | `AUDITOR` روی تراکنش‌ها                    | `403 INSUFFICIENT_ROLE`                                                                                          |
| ۲۰  | `AUDITOR` روی تراز آزمایشی                 | `403 FORBIDDEN`                                                                                                  |
| ۲۱  | خواندن میان‌مستأجری کیف پول با شناسه       | **`404 NOT_FOUND`**، نه ۴۰۳ — وجود رکورد فاش نمی‌شود                                                             |
| ۲۲  | تراز آزمایشی به‌عنوان `UNION_ADMIN`        | **`balanced: true`** — بدهکار ۱۳۶٬۰۰۰٬۰۰۰ = بستانکار ۱۳۶٬۰۰۰٬۰۰۰ روی ۴ حساب                                      |
| ۲۳  | تراز آزمایشی به‌عنوان `ORGANIZATION_ADMIN` | `403 FORBIDDEN` — در Gateway                                                                                     |
| ۲۴  | نمودار حساب‌های سازمان                     | دقیقاً دو حساب: `LIAB-ORG-UNION-YAZD-WALLET` و `…-ESCROW` (ADR-034)                                              |
| ۲۵  | قواعد کارمزد                               | **`{"items":[]}`** — وضعیت درست MVP؛ Q-08 باز است و هیچ نرخی Seed نمی‌شود                                        |
| ۲۶  | پاداش کاربر                                | `{"balance":null,"rewards":[]}` — هیچ قاعده‌ای پیکربندی نشده                                                     |

**تراز آزمایشی زنده، خط‌به‌خط:**

```
ASST-ORG-PLATFORM-PAYMENT_CLEARING   ASSET       100,000,000
LIAB-ORG-DEH-0001-WALLET             LIABILITY    12,000,000
LIAB-ORG-UNION-YAZD-ESCROW           LIABILITY    12,000,000
LIAB-ORG-UNION-YAZD-WALLET           LIABILITY    76,000,000

76,000,000 + 12,000,000 + 12,000,000 = 100,000,000  ✓
```

**رویدادهای منتشرشده روی `rasta.economic.v1`** (خوانده‌شده با
`kafka-console-consumer`، ۲۶۲ رویداد در کل، هر یازده نوع حاضر):

```
live-verify-2   WALLET_OPENED         actor=USR-SEED-UNION-ADMIN
live-verify-4   PAYMENT_AUTHORIZED    actor=USR-SEED-UNION-ADMIN
live-verify-4   PAYMENT_COMPLETED     simulated=True amount=50000000
live-verify-4   JOURNAL_POSTED
live-verify-8   PAYMENT_FAILED        reason=INSUFFICIENT_FUNDS simulated=True
live-verify-10  FUNDS_HELD            amount=12000000
live-verify-10  JOURNAL_POSTED
live-verify-14  COMMISSION_APPLIED
live-verify-14  FUNDS_RELEASED        resolution=RELEASED
live-verify-14  SETTLEMENT_COMPLETED  gross=12000000 comm=0 net=12000000
live-verify-14  JOURNAL_POSTED
live-verify-17  WALLET_OPENED         actor=USR-SEED-DEHYARI-ADMIN
```

**`correlationId` از HTTP تا Kafka دست‌نخورده می‌رسد** — هر رویداد بالا با
همان `X-Correlation-Id` که درخواست HTTP فرستاده برچسب خورده، و `actor` هم از
توکن Keycloak آمده.

**تأییدهای بیرون از Gateway:**

| بررسی                    | نتیجه                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------- |
| Container غیر‌Root       | `uid=100(rasta) gid=101(rasta)` — و `npm` از Image حذف شده                         |
| Trivy روی Image          | **۰ یافته CRITICAL/HIGH**، خروج ۰                                                  |
| Health/Readiness         | `{"status":"ok","checks":{"database":true,"kafka":true},"degraded":[]}`            |
| مصرف‌کننده‌ها هنگام Boot | هر دو Group به `rasta.maintenance.v1` و `rasta.fleet.v1` متصل شدند                 |
| تغییرناپذیری از SQL خام  | `UPDATE`/`DELETE` روی `ledger_entry` و `journal` هر دو `restrict_violation` گرفتند |
| Migration                | `migrate deploy` روی پایگاه داده تمیز اجرا شد؛ `down.sql` نوشته و بازبینی شده      |

---

## ۲۲. Known Issues

> **به‌روزرسانی 2026-08-29 (دوم).** بدهی E2E بسته شد: `tests/e2e` اکنون
> ۳۷ سناریو روی Stack واقعی اجرا می‌کند و در CI Job جداگانه دارد. آستانه
> پوشش هم برای نخستین بار واقعاً سنجیده می‌شود (بخش ۱۹). سه یافته تازه —
> هر سه، درزی میان لایه‌هایی که جداگانه درست‌اند — در جدول زیر آمده و در
> `docs/24` به‌عنوان Q-26، Q-27 و Q-28 ثبت شده‌اند.

### فعال (رفع‌نشده)

| #     | مسئله                                                                            | شدت                             | تأثیر                                                                                                                                          | راه‌حل موقت                                                                                                                                                                                                                                                                                                                                        |
| ----- | -------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-006 | Redis محلی Windows روی پورت ۶۳۷۹ با Redis داکری تصادم دارد                       | بالا (فقط محیط توسعه این ماشین) | تست زنده Rate Limiting/Idempotency از راه `localhost:6379` غیرقابل‌اعتماد                                                                      | استفاده از `docker exec rasta-redis redis-cli` مستقیم؛ یا تغییر `REDIS_PORT` مثل الگوی Postgres                                                                                                                                                                                                                                                    |
| D-008 | سه قاعده Supply-Chain که Lockfile فعلی رد می‌کند                                 | متوسط                           | پنجره نصب نسخه تازه‌منتشرشده مخرب باز است؛ ۴ هشدار Trust بررسی‌نشده                                                                            | Semgrep با `--exclude-rule` نام‌دار عبور می‌کند؛ بررسی کامل یک Task مستقل است                                                                                                                                                                                                                                                                      |
| —     | چهار سرویس دیگر هنوز `--passWithNoTests` دارند و Project Integration شان تهی است | متوسط                           | سهم آن‌ها از مرحله Integration در CI یعنی «چیزی نشکست»، نه «مسیر داده تست شد»                                                                  | برای هر سرویس، کار همان سرویس است؛ `fleet` الگو را نشان داده                                                                                                                                                                                                                                                                                       |
| —     | `api-gateway` هیچ Dockerfile ندارد                                               | متوسط                           | نمی‌توان آن را Containerize کرد                                                                                                                | نوشتن Dockerfile لازم است                                                                                                                                                                                                                                                                                                                          |
| D-011 | تغییر برنامه سرویس در `maintenance` هیچ رویدادی تولید نمی‌کند                    | متوسط (امروز پایین)             | خاموش کردن بی‌صدای یک برنامه سرویس را `audit-service` هرگز نمی‌بیند                                                                            | دلیل در ستون `notes` می‌ماند؛ هنگام ساخت `audit-service` رویداد لازم است                                                                                                                                                                                                                                                                           |
| D-012 | کنتور کارکرد هرگز عقب نمی‌رود                                                    | پایین                           | پس از تعویض کنتور، برنامه‌های کارکردمحور جلوتر از عدد روی دستگاه‌اند                                                                           | مسیر پشتیبانی‌شده: `PATCH /v1/maintenance-schedules/{id}` با `lastServicedHourMeter`                                                                                                                                                                                                                                                               |
| —     | `fleet` و `maintenance` هنوز `partitionKey` را در Call Site می‌نویسند            | پایین                           | قاعده ترتیب آنجا توصیه است نه قاعده — رویداد تازه بی‌صدا کلید Aggregate می‌گیرد                                                                | ADR-036 الگو را نشان داد (`events/routing.ts`)؛ اعمالش روی آن دو، Task جدا                                                                                                                                                                                                                                                                         |
| D-027 | ترتیب معنایی هر جریان (`topic + partitionKey`) تضمین نشده                        | متوسط                           | **شش** مسیر مستقل وارونگی، اندازه‌گیری‌شده (پایین). برخورد میلی‌ثانیه‌ای کوچک‌ترین‌شان است؛ مهم‌ترین، واگرایی ترتیب Commit از `created_at` است | [ADR-051](docs/adr/ADR-051-outbox-semantic-ordering.md) **`Accepted`** (2026-09-04) و **Q-36 بسته شد**؛ **B1 (Schema)، B2 (ابزار Backfill) و B3 (تخصیص سمت تولیدکننده) پیاده شدند (2026-09-05)**، ولی **B4–B6 نه** — هیچ مصرف‌کننده یا Claim ای `stream_seq` را اجبار نمی‌کند، پس هیچ تضمین ترتیبی در زمان اجرا برقرار نیست و این مورد باز می‌ماند |
| D-021 | هیچ Endpoint در `document-service` `@AllowService` ندارد                         | متوسط                           | `asset`، `contract` و `construction` شناسه سند نگه می‌دارند اما فراداده‌اش را نمی‌توانند بخوانند                                               | پیش‌فرض بسته درست است؛ باز کردنش یعنی افزودن آگاهانه یک Allowlist به‌ازای هر Endpoint با تست خودش                                                                                                                                                                                                                                                  |
| —     | `openapi/zod-schema.ts` در سه سرویس بایت‌به‌بایت تکرار شده                       | پایین                           | یک اصلاح باید سه‌جا اعمال شود                                                                                                                  | Utility خالص و بدون دانش دامنه است، پس جایش `packages/` است (A-03)؛ استخراجش سه سرویس را هم‌زمان لمس می‌کند                                                                                                                                                                                                                                        |
| —     | `InsuranceClaim` جدول بدون API                                                   | پایین                           | داده قابل‌ثبت نیست از راه سرویس                                                                                                                | Controller/Service لازم است، هروقت claim-flow اولویت شد                                                                                                                                                                                                                                                                                            |
| —     | `mission` و رویدادهای `MISSION_*` پیاده نشدند                                    | پایین                           | تحلیل «ناوگان داخلی در برابر برون‌سپاری» هنوز داده مأموریت ندارد                                                                               | عمدی — به `construction-service` گره خورده که وجود ندارد؛ ADR-026 § Consequences                                                                                                                                                                                                                                                                   |

### D-026 — `FOR UPDATE SKIP LOCKED` رزرو بادوام نمی‌سازد — بسته شد با پذیرش ADR-050 (2026-09-03) ✅

**بسته شد.** ADR-050 از `Proposed` به `Accepted` رفت و این مورد بسته شد، بر
پایهٔ:

- **PR #23** (`feat/outbox-durable-claim`) Merge شد؛
- **Merge Commit** `04bc6d8b5d4869538b6675cf5b15a42fb775f893` روی `main`، با
  دقیقاً دو Parent: `main` قبلی `b1e658bfeffa76ed1e4302f3222ef2bac7e7325e` و
  سر تأییدشدهٔ PR `5063a8bbc174040c3405a2f40abd0db850378879` (نیای `main`)؛
- اجرای کامل CI روی `main` —
  [Run 33754946545](https://github.com/marabi766/RASTA/actions/runs/33754946545)
  — با **۱۳ از ۱۳ Job سبز**: Lint/Type/Unit، Security Scans، ClamAV،
  Integration and Security Tests، E2E، و هر **هشت** جفت Build/Trivy Image
  (`identity`، `organization`، `asset`، `fleet`، `maintenance`، `economic`،
  `marketplace`، `document`)؛
- بازگشت‌پذیری Migration (`up → down → up`) روی **هر هشت** پایگاه داده، برای
  هر دو Migration ADR-050 (`20260902120000_outbox_durable_claim` و
  `20260902130000_outbox_claim_stream_indexes`) — هفده شیء در هر کدام؛
- رفتار پیاده‌شده و آزموده: Fencing با `claim_token` یکتا (UUIDv4 در هر تلاش
  Claim)، تمدید دوره‌ای Lease (`interval = lease/4`)، Backoff نمایی سقف‌دار با
  ساعت پایگاه داده، پروتکل خاموشی سه‌حالته، و پنج Metric رصدی؛
- شواهد پروتکل/هم‌ارزی/Contention که در بخش «Phase B — پیاده‌سازی» پایین ثبت
  شده: بیست‌وچهار آزمون پروتکل الزامی + پنج آزمون هم‌ارزی بازنویسی شرط واجد
  شرایط بودن + شش آزمون Contention با قفل واقعی نگه‌داشته‌شده روی یک اتصال
  دیگر.

**آنچه این پذیرش حل نمی‌کند:** ترتیب معنایی رویدادهای یک Aggregate —
**D-027** جداگانه ثبت شده و **همچنان باز می‌ماند**. تحویل همچنان
**At-Least-Once** است، نه Exactly-Once؛ A-09 (ایدمپوتنسی مصرف‌کننده) الزامی
می‌ماند. هزینهٔ اندازه‌گیری‌شدهٔ Index (چهار Index تازه، ≈۸ MB روی Fixture
۲۰۰ هزارتایی) و تقویت قفل در بدترین حالت (`۴ × limit`، اندازه‌گیری‌شده ۴۰۰ قفل
برای ۱۰۰ Claim) هر دو در [طرح اجرا](adr/ADR-050-implementation-plan.md) و در
ADR-050 § Consequences ثبت‌اند.

### D-027 — ترتیب معنایی هر جریان تضمین نشده — **باز**، با شواهد اندازه‌گیری‌شده (2026-09-04)

**این مورد باز است.** [ADR-051](docs/adr/ADR-051-outbox-semantic-ordering.md)
در ۲۰۲۶-۰۹-۰۴ **`Accepted`** شد، ولی آنچه پذیرفته شد **طراحی** است و **هیچ کدی
پیاده نشده**. پذیرش معماری، رفتار سیستم را عوض نمی‌کند: هر شش مسیر وارونگی که
پایین اندازه‌گیری شده، امروز همچنان باز است.

**توصیف قبلی ناکامل بود.** تا امروز D-027 این‌طور ثبت شده بود: «دو رویداد یک
Aggregate در یک میلی‌ثانیه می‌توانند وارونه برسند». بازتولید روی PostgreSQL و
Kafka واقعی نشان داد آن جمله درست ولی کوچک‌ترین بخش مسئله است — **شش** مسیر
مستقل وارونگی وجود دارد:

| #   | مسیر                            | اندازه‌گیری                                                                                               |
| --- | ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| ۱   | برخورد درون یک میلی‌ثانیه       | ۳۲٬۵۵۱ جفت وارون از ۶۶٬۰۰۰ — **۴۹٫۳۲٪**؛ با `monotonicFactory` صفر                                        |
| ۲   | سبقت Retry                      | سرصف در Backoff، Claim فقط رویداد **بعدی** را برگرداند                                                    |
| ۳   | رقابت دو Relay روی یک Partition | **۸ وارونگی از ۲۰ آزمون** با Kafka واقعی؛ هر ۸ مورد وقتی Relayِ کندتر رویداد قدیمی‌تر را داشت (۱۰۰٪ شرطی) |
| ۴   | **واگرایی ترتیب Commit**        | ترتیب انتشار وارونهٔ `created_at` شد — چون `created_at` **پیش از** Commit در JavaScript گرفته می‌شود      |
| ۵   | Lease زندهٔ Relay Crash کرده    | رویداد بعدی تا **۵۹ ثانیه** جلو افتاد؛ `leaseSeconds` = حداکثر پنجرهٔ وارونگی                             |
| ۶   | بازپخش دستی DLQ                 | `DLQ_HEADERS` و `processed_event` هیچ متادادهٔ ترتیبی ندارند ⇒ رویداد کهنه **قابل تشخیص نیست**            |

**مسیر ۴ مهم‌ترین است**، چون یک **دستهٔ کامل از راه‌حل‌ها** را حذف می‌کند: هر
مکانیزمی که شماره را پیش از Commit تخصیص دهد — ULID یکنواخت، `BIGSERIAL`
سراسری، یا `aggregateVersion` سمت تولیدکننده — همان‌جا می‌شکند. راه‌حل موقتِ
قبلی در همین جدول (`BIGSERIAL` یا `aggregate_sequence`) با این شواهد **رد شد**.

**اصلاح واحد ترتیب.** عنوان قبلی «هر Aggregate» می‌گفت. شواهد C-7 در ADR-051
نشان داد واحد درست **`topic + partitionKey`** است: زیر ADR-036، `fleet`،
`maintenance` و بخش تراکنشی `economic` عمداً رویدادهای چند Aggregate را روی یک
کلید می‌نشانند.

**تصمیم محصول (Q-36، 2026-09-04) — رسید و ثبت شد، پیاده نشد.** پرسش این بود که
جریان‌های `fleet` و `maintenance` ترتیب اکید لازم دارند یا تشخیص شکاف. پاسخ:
**هر دو STRICT** — `rasta.fleet.v1 + assetId` و `rasta.maintenance.v1 + assetId`.
دلیل ثبت‌شده: رویداد بی‌ترتیب روی یک دستگاه می‌تواند Projection عملیاتی ناامن
بسازد (در دسترس بودن، تخصیص، خروج/بازگشت تعمیر، نگهداری کارکردمحور، چرخه‌عمر
سفارش تعمیر). هزینهٔ پذیرفته‌شده: سریالایز شدن تراکنش‌های یک دستگاه، و امکان
توقف جریان بر اثر سرصف مسموم با بازیابی صریح و هرگز خودکار.

**مرز این تصمیم — صریح.** واحد ترتیب همان `topic + partitionKey` است، پس ترتیب
اکید **درون هر جریان** برقرار می‌شود و **میان آن دو Topic برقرار نمی‌شود**، حتی
با `assetId` یکسان: دو پایگاه دادهٔ مستقل، دو شمارندهٔ مستقل، بدون هیچ قفل یا
تراکنش مشترک (A-01).

**پذیرش معماری (2026-09-04).** ADR-051 به **`Accepted`** رفت. هر دو دروازهٔ
تصمیمی — پذیرش ADR و پاسخ Q-36 — باز شده‌اند.

**Phase B1 پیاده و تأیید شد (2026-09-05).** با اجازهٔ صریح صاحب محصول، **فقط
B1**: Schema افزایشی و بی‌اثر روی هر هشت سرویس — سه Migration یکسان
(`20260905090000_outbox_stream_sequence`،
`20260905090100_outbox_stream_seq_columns`،
`20260905090200_outbox_stream_head_indexes`)، هرکدام با `down.sql`. محتوا: جدول
`outbox_stream_sequence` با کلید اصلی `(topic, partition_key)`؛ دو ستون
`stream_seq BIGINT NULL` و `is_stream_head BOOLEAN NOT NULL DEFAULT false`؛
Index یکتای **جزئی** `ux_outbox_stream_seq`؛ و چهار Index سرصف
`ix_outbox_head_{fresh,lease,retry,both}`.

شواهد: Verifier موجود گسترش یافت و روی **هر هشت پایگاه داده** up → down → up سبز
شد، با ادعای **سطح Catalog** (نوع، Nullability، Default، کلید اصلی مرکب، و تعریف
کامل هر پنج Index) به‌علاوهٔ یک ادعای **بی‌اثری روی داده**: هیچ سرصفی علامت
نخورده، هیچ توالی تخصیص نیافته، جدول شمارنده خالی است.

**Phase B2 پیاده و تأیید شد (2026-09-05).** با اجازهٔ صریح صاحب محصول، **فقط
B2**: یک **ابزار عملیاتی** — نه Migration. B2 هیچ Migration تازه‌ای نساخت و هیچ
DML ای در Migration موجود نگذاشت؛ آنچه افزود
`scripts/outbox-b2-backfill.mjs` است (به‌همراه
`outbox-b2-lib.mjs`، `outbox-b2-prisma-port.mjs`، `outbox-b2-fixture.mjs`، دو
فایل آزمون و
[Runbook](docs/runbooks/outbox-b2-backfill.md)). ابزار ردیف‌های **منتشرنشدهٔ**
بدون توالی را در دسته‌های حداکثر ۵٬۰۰۰ تایی شماره می‌زند با
`row_number() OVER (PARTITION BY topic, partition_key ORDER BY created_at, id)`،
`outbox_stream_sequence` را از وضعیت واقعی همان جریان می‌سازد
(`next_seq = max + 1`، `published_seq = سرصف - 1`، هر دو با `GREATEST`)، و
`is_stream_head` را فقط برای پایین‌ترین توالی منتشرنشدهٔ هر جریان می‌گذارد.
میان دسته‌ها `VACUUM (ANALYZE)` می‌زند و شکستش را خطای عملیاتی می‌شمارد.

قفل‌های ایمنی، همه Fail-Closed: هدف صریح (`--service`/`--all`، بدون پیش‌فرض) ·
نوشتن فقط با `--apply` · رد `NODE_ENV=production` و هر `NODE_ENV` ناشناخته ·
فقط `DATABASE_URL_<SERVICE>` و هرگز بازگشت به `DATABASE_URL` مشترک (A-01) ·
اندازهٔ دسته ≤ ۵٬۰۰۰ · بررسی Schema B1 با **تعریف**، نه نام. **هیچ Migration،
مسیر راه‌اندازی، Job CI، مرحلهٔ `pnpm verify` یا Hook استقراری این ابزار را صدا
نمی‌زند** و یک آزمون همین را ادعا می‌کند. خروجی NDJSON فقط شمارش است — بدون
Payload، Credential یا رشتهٔ اتصال.

**شرط سکون، تشخیص‌داده‌شده نه ادعاشده.** چون `created_at` پیش از COMMIT از ساعت
JavaScript گرفته می‌شود (§ R4)، ردیفی که حین Backfill نوشته شود می‌تواند پیش از
ردیفی که شماره گرفته مرتب شود. ابزار همان حالت را در هر دسته می‌شمارد و اگر
ببیند **کل دسته را Rollback می‌کند** و می‌ایستد؛ ادعا نمی‌کند در برابر
تولیدکنندهٔ زنده امن است.

شواهد: `pnpm test:outbox-b2-pg` — ۲۲ آزمون روی PostgreSQL واقعی، هرکدام در
Schema یک‌بارمصرفی که از فایل‌های Migration واقعی ساخته می‌شود. پوشش: تفکیک‌کنندهٔ
`(created_at, id)`؛ جریان ۵٬۲۰۰ ردیفی روی سقف ۵٬۰۰۰ بدون تکرار/شکاف/وارونگی؛
چند جریان در یک دسته؛ ردیف‌های منتشرشدهٔ دست‌نخورده؛ یک سرصف در هر جریان و هیچ
سرصف برای جریان کاملاً منتشرشده؛ شمارنده‌های منطبق با D-4؛ از سرگیری بدون
شماره‌گذاری مجدد؛ اجرای دوم No-Op؛ Dry-Run بدون تغییر؛ و امتناع‌ها (Schema
معیوب، ردیف تازه حین اجرا، شکست `VACUUM`، گزینهٔ نامعتبر). **جداسازی مستأجر** با
دو پایگاه دادهٔ سرویسِ متفاوت و داده‌های یکسان آزموده شد. هیچ آزمونی `sleep`
ندارد. `pnpm test:migration` روی هر هشت پایگاه داده همچنان سبز است.

**اصلاح پس از بازبینی (2026-09-05).** نخستین نسخهٔ CLI خروجی
`runServiceBackfill()` را نادیده می‌گرفت، پس `--apply --max-batches N` که کار
ناتمام می‌گذاشت با کد خروج **۰** برمی‌گشت — یعنی Backfill نیمه‌تمام از
تمام‌شده قابل تشخیص نبود. اصلاح شد: رویداد `incomplete` (جدا از `refused`)،
شمارنده‌های جدا در `summary` (`ok`/`incomplete`/`refused`)، و **کد خروج ۰ فقط
با همگرایی هر سرویس انتخاب‌شده**. یک برش مرزدار عمداً کد ۱ می‌دهد. سه آزمون
CLI واقعی با Spawn فرآیند این را ثابت می‌کنند.

**دروازهٔ عملیاتی B2 روی محیط توسعهٔ محلی (2026-09-05) — یک No-Op اثبات‌شده.**
هر هشت پایگاه دادهٔ محلی با تولیدکنندهٔ ساکن (هیچ سرویس یا Relay رستا در حال
اجرا نبود) یک‌به‌یک Apply شدند. نتیجه: هر هشت `converged: true` با **صفر دسته**،
`counters.written = 0`، `heads.changed = 0`، و هر ۳۲ Query اعتبارسنجی (چهار
Query × هشت پایگاه داده) برابر **صفر**. اثر انگشت هر هشت پایگاه داده پیش و پس
از اجرا **بیت‌به‌بیت یکسان** ماند. ۳۲۳ ردیف منتشرشدهٔ `marketplace` و ۲۱۶ ردیف
`document` کاملاً دست‌نخورده ماندند (`stream_seq IS NULL`،
`is_stream_head = false`، فیلدهای انتشار بدون تغییر).

آن اجرا هیچ ردیفی را عوض نکرد، **با آنکه در حالت Apply بود** — و همان‌جا معلوم
شد رویداد `done` عدد `mutated: true` را Hard-Code می‌کرد. آن مقدار «حالت Apply
مجاز شد» را می‌گفت، نه «پایگاه داده عوض شد»، و برای شواهد عملیاتی گمراه‌کننده
بود. اصلاح شد: `mutated` اکنون از شمارش نوشتن‌های واقعی مشتق می‌شود —
`batch.updated`، `counters.written`، `heads.changed`. **شواهد اندازه‌گیری‌شدهٔ آن
دروازه بازنویسی نشده‌اند؛ فقط برچسبش درست شد.** اگر همان دروازه دوباره اجرا
شود، همان No-Op را با `mutated: false` گزارش می‌کند.

**Phase B3 پیاده و تأیید شد (2026-09-05).** تخصیص توالی سمت تولیدکننده، درون
همان تراکنش دامنه. یک اولیهٔ مشترک `allocateStreamSeqSql(tx, topic,
partitionKey)` در `packages/nest-common` دقیقاً SQL § D-2 را اجرا می‌کند
(`ON CONFLICT DO UPDATE SET next_seq = next_seq + 1 RETURNING next_seq - 1`).
تراکنش را **فراخوان** می‌دهد؛ این بسته هیچ Prisma Client سرویسی Import
نمی‌کند. قفل ردیف شمارنده تا Commit فراخوان نگه داشته می‌شود — تنها چیزی که
§ R4 را می‌بندد و تنها نقطهٔ سریالایز `fleet` و `maintenance` روی مرز
`assetId`.

Envelope دو فیلد **اختیاری** `streamSeq` (عدد) و `streamKey` گرفت، به‌علاوهٔ
Header `x-stream-seq`. `eventVersion` عوض نشد. ستون `BIGINT` است، پس تبدیل در
مرز سیم بررسی‌شده است و اگر نمایش‌پذیر نباشد بلند شکست می‌خورد؛ هیچ `bigint` ای
هرگز به JSON نمی‌رود.

**هر هشت سرویس یکپارچه شدند.** پنج سرویسی که تصمیم کلید را در ۱۵ محل فراخوانی
می‌گرفتند اکنون `routing.ts` سرویس‌محلی دارند — تخصیص کلاس رویداد به
`@rasta/nest-common` منتقل **نشد**. هیچ Topic، کلید Partition، Schema رویداد یا
رفتار دامنه‌ای عوض نشد.

شواهد: `pnpm test:outbox-b3` — ۹ آزمون قطعی روی PostgreSQL واقعی، بدون `sleep`
و بدون Mock کردن قفل تراکنش، شامل **آزمون منفی** نبود ترتیب میان `fleet` و
`maintenance` برای یک `assetId`. به‌علاوه هر هشت سرویس شواهد Integration خودش
را دارد. Migration تازه‌ای لازم نبود.

**آنچه B3 نمی‌کند:** `claimPending`، `markPublished`، Relay، Retry، DLQ و
مصرف‌کننده‌ها دست‌نخورده‌اند. **هیچ تضمین ترتیبی تازه‌ای در زمان اجرا برقرار
نشده** و **D-027 باز می‌ماند**.

**مرز Rollback ــ B2.** `down.sql` های B1 داده B2 را بازنمی‌گردانند؛ ستون‌ها را
حذف می‌کنند و توالی‌ها با آن‌ها می‌روند. Rollback امن این است که داده افزایشی
**بی‌اثر رها شود** و فازهای برنامه‌ای برگردند. بازگردانی خودِ داده رویه‌ای
جداگانه و بازبینی‌شده می‌خواهد که هنوز طراحی نشده.

**آنچه هنوز نرسیده.** **D-027 باز می‌ماند** — B1 هیچ تضمین ترتیبی نمی‌سازد.
`claimPending`، Relay، تولیدکننده، مصرف‌کننده، Envelope، Header، Routing و
Feature Flag دست‌نخورده‌اند، و B2 هم هیچ‌کدام را لمس نکرد: هیچ مسیر اجرایی
`stream_seq` یا `is_stream_head` را نمی‌خواند. **B3 تا B6 پیاده نشده‌اند** و
هرکدام دستور اجرای صریح و جداگانهٔ خودش را می‌خواهد. بستن D-027 هر سه را با هم
می‌خواهد: (۱) اجرای Phase B؛ (۲) سبز شدن همهٔ دروازه‌های پذیرش طرح اجرا § ۸ —
آزمون قطعی روی PostgreSQL و Kafka واقعی، آستانه‌های کارایی، برگشت‌پذیری
Migration روی هر هشت پایگاه داده، جداسازی مستأجر، Runbook «جریان مسدود»، و CI
کامل `main`؛ (۳) یک **ثبت پذیرش دوم صاحب محصول** روی شواهد اجرا. تحویل همچنان
**At-Least-Once** است، نه Exactly-Once؛ A-09 الزامی می‌ماند.

**دو یافتهٔ جانبی، خارج از دامنهٔ آن بررسی و گزارش‌شده، نه اصلاح‌شده:**

- `docs/runbooks/replay-dlq.md` اجرای `dist/scripts/replay-dlq.js` را دستور
  می‌دهد، ولی آن Script در مخزن **وجود ندارد**؛
- Comment در `services/economic-service/src/outbox/kafka.publisher.ts:30-34`
  می‌گوید `marketplace-service` هنوز وجود ندارد و Q-26 باز است — امروز هر دو
  نادرست‌اند (سرویس مستقر است، Q-26 با ADR-036 بسته شده).

---

**یافته بازبینی محصول روی PR #21 (تاریخچه — پیش از رفع).** توضیحی که در همان PR نوشته شده بود ادعا
می‌کرد `SKIP LOCKED` اجازه می‌دهد چند Replica هم‌زمان رله کنند «بدون آنکه دو
تای‌شان یک ردیف را منتشر کنند». این ادعا با پیاده‌سازی فعلی برقرار **نیست** و
در PR #21 اصلاح شد.

**چرا برقرار نیست.** `claimPending()` یک `$queryRaw` مستقل است. توالی رله در
`packages/nest-common/src/outbox/outbox.ts` این است:

```ts
const batch = await store.claimPending(batchSize); // تراکنش اینجا تمام می‌شود
await publisher.publish(batch); // I/O بیرونی، بدون قفل
await store.markPublished(batch.map((r) => r.id)); // عملیات جدا
```

قفل سطری در PostgreSQL فقط تا پایان تراکنشِ نگهدارنده‌اش زنده است. با
بازگشتِ `claimPending()` تراکنش تمام شده و همه قفل‌ها آزادند — یعنی از آن
لحظه تا `markPublished()`، ردیف‌ها با هیچ سازوکار بادواری رزرو نشده‌اند.
`this.running` در رله فقط از Tickهای هم‌پوشان **درون یک پروسه** جلوگیری
می‌کند و درباره Replicaها چیزی نمی‌گوید.

**بازتولید قطعی — بدون Sleep، بدون Timing، بدون Kafka.** دو `PrismaService`
مستقل (دو اتصال، مثل دو Replica)، ۱۰ ردیف منتشرنشده با شناسه یکتا:

| گام                                              | نتیجه           |
| ------------------------------------------------ | --------------- |
| Store A → `claimPending(10)`                     | ۱۰ ردیف         |
| Store B → `claimPending(10)` **پیش از** Mark شدن | ۱۰ ردیف         |
| **اشتراک شناسه‌ها**                              | **۱۰ از ۱۰** ❌ |
| پس از `markPublished` توسط A، دوباره B           | ۰ ردیف ✅       |

یعنی هر دو رله همان ۱۰ رویداد را به Kafka می‌دادند. تنها چیزی که واقعاً یک
ردیف را از Claim بعدی خارج می‌کند `published_at` است، آن هم فقط پس از
نوشته‌شدنش.

**دامنه (وضعیت هنگام کشف، پیش از Phase B):** **هر هشت** Outbox Store
پیاده‌شده دقیقاً همین الگوی SELECT مستقل را داشتند — `asset`، `document`،
`economic`، `fleet`، `identity`، `maintenance`، `marketplace`،
`organization`. هیچ‌کدام `$transaction` نداشتند و هیچ مدل `OutboxMessage`
ستون Lease/Claim نداشت. **Phase B هر هشت را اصلاح کرد** (بالا). (برای مقایسه: مسیر Scan در
`document-service` عمداً Lease بادوام دارد — `scan_lease_owner` و
`scan_lease_expires_at` — پس پلتفرم این الگو را بلد است و اینجا انتخاب نکرده.)

**چرا Consumer ایدمپوتنت کافی نیست.** A-09 مصرف‌کننده ایدمپوتنت می‌خواهد و آن
اثر **تجاری** تکراری را مهار می‌کند؛ اما انتشار تکراری در Kafka، بار اضافه روی
Broker و مصرف‌کننده‌ها، و ریسک **ترتیب** را حذف نمی‌کند. دو رله که یک Batch را
هم‌زمان منتشر می‌کنند می‌توانند رویدادهای یک Aggregate را با ترتیب درهم به
Partition برسانند.

**و حتی با طراحی بادوام، تحویل تکراری هنگام Crash ذاتی می‌ماند.** اگر رله پس
از `publish` و پیش از `markPublished` بمیرد، رویداد منتشر شده و ردیف هنوز
منتشرنشده است؛ تلاش بعدی دوباره منتشرش می‌کند. این at-least-once است، نه
نقصِ قابل‌رفع — هر طراحی Claim فقط پنجره را کوچک می‌کند، نه صفر.

**رفع نیازمند ADR است** که دست‌کم این سه گزینه را مقایسه کند:

1. **وضعیت Claim/Lease با انقضا و بازیابی** — ستون مالک و زمان انقضا، مثل
   الگوی Scan؛ نیازمند Migration روی هشت پایگاه داده و معنای بازیابی پس از
   Crash.
2. **قفل سطری نگه‌داشته‌شده در تراکنش** — درست، اما تراکنش را روی I/O بیرونی
   (Kafka) باز نگه می‌دارد؛ اتصال و قفل به مدت یک رفت‌وبرگشت شبکه اشغال
   می‌شود و یک Broker کند به Connection Pool سرایت می‌کند.
3. **Claim اتمی در پایگاه داده و سپس انتشار** — یک `UPDATE ... RETURNING` که
   ردیف را در همان جمله به Claim‌کننده نسبت می‌دهد؛ ساده‌تر، اما رفتار
   Crash-Recovery باید صریح تعریف شود.

**ترتیب قطعی برای `created_at`های برابر هم باید در همان ADR بررسی شود:**
`ORDER BY created_at` بدون Tie-Break، برای ردیف‌هایی که در یک میلی‌ثانیه ساخته
شده‌اند ترتیب دلخواه می‌دهد — که هم برای صفحه‌بندی Claim و هم برای ترتیب
رویدادهای یک Aggregate اهمیت دارد.

**در PR #21 هیچ کد اجرایی، Migration یا قرارداد رویدادی تغییر نکرد.** فقط
ادعاهای نادرست در Commentها و مستندات اصلاح شدند و این مورد ثبت شد.

---

**Phase B — پیاده‌سازی (2026-09-02).** کد، Migration و آزمون‌ها نوشته و اجرا
شدند. **این مورد بسته شد و ADR-050 اکنون `Accepted` است** (2026-09-03؛ جزئیات
پذیرش در ابتدای همین بخش D-026 بالا).

آنچه واقعاً هست:

- `claimPending` یک `UPDATE … RETURNING` روی زیرپرسش `FOR UPDATE SKIP LOCKED`
  است. Token تازه (UUIDv4) در **هر تلاش Claim**، خوانده‌شده از `RETURNING`.
- Ack، `markFailed`، `release` و `renew` همگی مشروط بر `claim_token`اند و هیچ‌کدام
  `claim_expires_at` را شرط نمی‌کنند. هر چهار، تعداد ردیف لمس‌شده را برمی‌گردانند.
- تمدید دوره‌ای با `interval = lease/4` و `statement_timeout = min(interval/2, 30s)`؛
  تمدید **شناسه‌ها** را برمی‌گرداند، پس تمدید جزئی بازماندگان را رها نمی‌کند.
- پروتکل خاموشی سه‌حالته؛ ردیف «در پرواز با نتیجهٔ نامعلوم» **Release نمی‌شود**.
- Backoff نمایی سقف‌دار، تماماً با `now()` پایگاه داده.
- **پنج ستون، پنج CHECK و در مجموع هفت Index تازه** روی **هر هشت** پایگاه
  داده، از دو Migration: `20260902120000_outbox_durable_claim` (ستون‌ها،
  CHECK ها و **سه** Index اولیهٔ Claim/رصد) و
  `20260902130000_outbox_claim_stream_indexes` (**چهار** Index جریان واجد
  شرایط بودن). `up → down → up` روی هر هشت سبز، هفده شیء در هر کدام.
- بیست‌وچهار آزمون قطعی روی PostgreSQL واقعی، در Schema ایزوله، به‌علاوهٔ پنج
  آزمون هم‌ارزی برای بازنویسی شرط واجد شرایط بودن و شش آزمون Contention با قفل
  واقعی نگه‌داشته‌شده روی یک اتصال دیگر.

**معیار کارایی ADR اکنون برقرار است.** نسخهٔ اول این Phase شرط واحد ADR را
اجرا می‌کرد و در وضعیت‌های «اکثراً Lease فعال» و «اکثراً در Backoff»
**۱۹۰٬۰۰۰** ردیف را با Filter دور می‌ریخت — در برابر سقف ۱٬۰۰۰. علت نبودِ Index
نبود: `now()` در PostgreSQL `stable` است نه `immutable`، پس Planner برای
`<= now()` گزینش‌پذیری پیش‌فرض ۳۳٪ می‌گذارد و با `LIMIT` همیشه خروج زودهنگام از
Index ترتیب را برمی‌دارد. حتی Index عبارتی که واقعاً آمار می‌گیرد
(`n_distinct = 2`) این را عوض نکرد.

**راه‌حل: چهار جریان `UNION ALL` که در هرکدام واجد شرایط بودن یا ایستاست یا
بازه‌ای روی ستون پیشروی همان Index است.** حالا در **هر شش وضعیت** rows removed
by filter **صفر** است، Sort در حافظه می‌ماند، و میانهٔ زمان اجرا ۰٫۱۰۸ تا ۵٫۱
میلی‌ثانیه است. هم‌ارزی با شرط اصلی برای هر نُه حالت (شامل مرز برابری با
`now()`) با آزمون اثبات شد.

**و یک نقص که همین بازنویسی ساخت:** اگر قفل فقط پس از ادغام گرفته شود، دو مدعی
همان پنجرهٔ پیش‌محدودشده را می‌سازند و دومی همه را قفل‌شده می‌بیند —
اندازه‌گیری‌شده: ۳۰۰ ردیف واجد شرایط، صد ردیف قدیمی‌تر قفل،
`claimPending(100)` → **۰ ردیف**. اصلاح: هر جریان
`FOR UPDATE SKIP LOCKED` را **پیش از** `LIMIT` خودش می‌گیرد. شش آزمون
Contention با قفل واقعی و بدون Sleep این را می‌بندند.

هزینه: چهار Index تازه، **7.87 MB** روی Fixture ۲۰۰ هزارتایی با هر چهار جریان
پر (**+۲۸٫۳٪** حجم Index)، و تقویت قفل تا **۴ × limit** در بدترین حالت
(اندازه‌گیری‌شده ۴۰۰ قفل / ۱۰۰ Claim) که فقط تا پایان همان یک جمله زنده است.
جزئیات و اعداد در
[طرح اجرا § شواهد Phase B](docs/adr/ADR-050-implementation-plan.md).

**Phase A — طراحی و شواهد (2026-09-02).** زمینهٔ تاریخی؛ آنچه پایین می‌آید
وضعیت **پیش از** پیاده‌سازی را ثبت می‌کند، نه وضعیت امروز را. Phase A طراحی
پیشنهادی و شواهد بازتولید را تولید کرد؛ Phase B (بالا) پیاده، با CI تأیید، به
`main` Merge و توسط صاحب محصول پذیرفته شد. **ADR-050 اکنون `Accepted` است و
D-026 بسته شد** (2026-09-03).

[**ADR-050**](adr/ADR-050-outbox-durable-claim.md) با وضعیت `Proposed` نوشته شد و
Option A را پیشنهاد می‌کند: Claim بادوام با Lease دارای انقضا، هم‌الگو با Lease
اسکن بدافزار که `document-service` از پیش دارد (ADR-049).

بازتولید مستقل با دو اتصال Prisma روی پایگاه داده واقعی، چهار اندازه‌گیری:

| #   | سناریو                      | نتیجه                   |
| --- | --------------------------- | ----------------------- |
| M1  | دو Store، پیش از Mark       | اشتراک **۱۰ از ۱۰**     |
| M2  | پس از `markPublished`       | **۰**                   |
| M3  | مدعی پیش از Publish می‌میرد | **۱۰** — بازیابی می‌شود |
| M4  | Publish موفق، Mark ناموفق   | **۱۰** قابل انتشار مجدد |

M3 نکته‌ای را روشن کرد که در ثبت اولیه نبود: بازیابی امروز **رایگان** است، اما
فقط به این دلیل که هیچ رزروی وجود ندارد. هر Claim بادوامی که M1 را ببندد،
خودبه‌خود به M3 بدهکار می‌شود — و این دلیل الزامی‌بودن Expiry است، نه یک
جزئیات پیکربندی.

**ترتیب — اثبات‌شده، نه فرض‌شده.** `created_at` از نوع `timestamp(3)` است و
ULID با `ulid()` ساده تولید می‌شود (`monotonicFactory` هیچ‌جا استفاده نشده).
اندازه‌گیری: میان ۱۲ ULID هم‌میلی‌ثانیه، **۶ وارونگی**؛ میان میلی‌ثانیه‌ها
ترتیب حفظ می‌شود. پس ULID درون یک میلی‌ثانیه ترتیب ساخت **نمی‌دهد**.
ADR-050 `ORDER BY created_at, id` را انتخاب می‌کند که ترتیب را **قطعی** می‌کند
اما درون میلی‌ثانیه دلخواه می‌ماند؛ ترتیب معنایی به‌ازای Aggregate باز است و
ADR خودش را می‌خواهد.

**دامنه فاز اجرا:** هشت Store، هشت Schema و Migration، `OutboxStore` مشترک،
`OutboxRelay`، پنج Metric، و اصلاح ادعای نادرست در هشت Docstring Store به
علاوهٔ قرارداد `OutboxStore` و یک Runbook.

**بازبینی محصول روی نسخهٔ اول ADR — دو نقص جدی (2026-09-02).**

۱. **Fencing غلط بود.** نسخهٔ اول مالکیت را با `claim_owner` (شناسهٔ پروسه) و
شرط `claim_expires_at > now()` تعریف کرده بود. هر دو نادرست: Owner در سطح
پروسه است و دو Claim پیاپی یک پروسه را از هم تفکیک نمی‌کند؛ و انقضا به‌عنوان
شرط Ack، مالک قانونیِ پس‌گرفته‌نشده را هم مسدود می‌کند. اکنون هر تلاش Claim یک
`claim_token` یکتا می‌سازد که **تنها Fence** است؛ `claim_owner` فقط فراداده
تشخیصی است؛ انقضا فقط «واجد شرایط پس‌گرفتن» را تعیین می‌کند.

۲. **ادعای «انتشار در حد میلی‌ثانیه» اندازه‌گیری نشده و غلط بود.** با
پیکربندی واقعی KafkaJS این Repository (`retries: 8`، `requestTimeout` پیش‌فرض
۳۰s، `maxRetryTime` ۳۰s، `acks: -1`):

| مسیر                               | کران بالا       |
| ---------------------------------- | --------------- |
| یک `sendBatch`                     | **۳۷۹ ثانیه**   |
| `publishIndividually` با Batch ۱۰۰ | **≈ ۱۰٫۵ ساعت** |
| با Batch ۱۰۰۰ (حداکثر مجاز)        | **≈ ۱۰۵ ساعت**  |

یعنی انتشار به‌طور مفید کران‌دار نیست و **تمدید Lease اجباری است**؛ بررسی
انقضا پیش از Publish کافی نیست چون انقضا در حین I/O رخ می‌دهد. Lease پیش‌فرض
**۶۰ ثانیه** پس از این تحلیل انتخاب شد، با Heartbeat هر `Lease/4` و کمینهٔ Lease **۲۰ ثانیه**.

**تناقض Backoff هم رفع شد:** نسخهٔ اول Backoff را از `attempts` ادعا می‌کرد اما
شرط Claim هیچ فیلد زمانی نداشت. ستون `next_attempt_at` اضافه می‌شود و در شرط
Claim می‌آید.

**`CREATE INDEX CONCURRENTLY` آزمایش شد، نه فرض:** Prisma Migrate هر فایل را
در تراکنش می‌پیچد و `CONCURRENTLY` با `P3018` / SQLSTATE `25001` شکست می‌خورد.
تصمیم: Index بدون `CONCURRENTLY`، با توجیه کوچک‌ماندن جدول به‌خاطر
`purgePublished`.

**Metricها اصلاح شدند:** «Conflict یعنی تکرار قطعی» یک استنباط بود، نه
اندازه‌گیری. اکنون `ack_fenced_total` فقط رویداد Fencing را می‌شمارد و متن
Alert صریح می‌گوید تحویل تکراری در سمت Producer **قابل تأیید نیست**.

**G5 دیگر در متن رها نیست:** به‌عنوان **D-027** بالا ثبت شد.

**بازبینی محصول، دور دوم (2026-09-02) — هشت مورد، همه اصلاح شد.**

۱. **تمدید جزئی مالکیت معتبر را رها می‌کرد.** متن قبلی می‌گفت اگر تمدید کمتر از
انتظار برگرداند، رله «هیچ Mutation دیگری روی **هیچ** ردیفی نمی‌زند». اگر از صد
ردیف نود‌تا هنوز با Token تطبیق داشته باشند، آن نود قانوناً مال ما هستند و
Ack نکردنشان یک بازپخش کاملاً غیرلازم را تضمین می‌کند. اکنون تمدید **شناسه‌ها**
را برمی‌گرداند، رله `ownedUnacknowledgedIds` نگه می‌دارد، فقط `lost` کنار
گذاشته می‌شود و Heartbeat برای بازماندگان ادامه می‌یابد.

۲. **پروتکل خاموشی ناقص بود.** «منتظر Batch بمان و Release کن» برای درخواستی که
ممکن است ساعت‌ها در پرواز و با نتیجهٔ نامعلوم بماند کافی نیست. سه حالت صریح شد:
نفرستاده → Release امن؛ نتیجهٔ معلوم → Ack/Fail؛ **در پرواز/نامعلوم → Release
نکن**، مالکیت را تا `OUTBOX_SHUTDOWN_GRACE_SECONDS` نگه دار، سپس بگذار Lease
طبیعی منقضی شود. خاموشی هرگز بی‌نهایت منتظر نمی‌ماند.

۳. **زمان‌بندی Heartbeat اثبات نشده بود.** با `Lease/3`، کف ۵ ثانیه و کمینهٔ
Lease ده ثانیه، تلاش دوم دقیقاً روی لحظهٔ انقضا می‌افتاد — تحمل صفر، نه یک.
فرمول به `Lease/4` تغییر کرد، کمینه به **۲۰ ثانیه** رفت، و جدول زمان‌بندی برای
کمینه/پیش‌فرض/بیشینه اضافه شد: سه تلاش پیش از انقضا، یعنی **دو** تمدید
ازدست‌رفته قابل تحمل. مهلت هر فراخوان با `statement_timeout` اعمال می‌شود و
`ownershipUnknownAt` تعریف شد.

۴. **ثابت‌های پایگاه داده ناقص بودند.** اکنون هر سه ستون Claim با هم NULL یا با
هم پر هستند (`num_nonnulls(...) IN (0,3)`)، ردیف منتشرشده `claim_owner` را هم
نگه نمی‌دارد، و `next_attempt_at` فقط روی ردیف منتشرنشده با `attempts >= 1`
مجاز است. پنج CHECK.

۵. **شمارش‌ها ناسازگار بودند.** پنج ستون، سه Index، **پنج** CHECK،
**بیست‌وچهار** آزمون — در همه‌جا یکسان شد. (Compliance قبلاً «یازده آزمون»
می‌گفت درحالی‌که ماتریس شانزده‌تا داشت.) — این شمارش **Phase A** است؛ Phase B
چهار Index جریان را افزود و مجموع نهایی **هفت** Index شد (بالا).

۶. **Preflight اضافه شد:** جدول هشت‌تایی با `total_rows`، `pending_rows`،
`table_size`، `index_size` و `oldest_pending_seconds`؛ آستانهٔ مسیر دستی
(یک‌میلیون ردیف یا ۱GB)؛ و تأیید Index با `pg_get_indexdef` — ستون، ترتیب و
Predicate، نه فقط نام. SQL نمایش‌داده‌شده هم `CREATE INDEX IF NOT EXISTS` شد تا
با ادعای «Migration از رویش عبور می‌کند» یکی باشد.

۷. **پذیرش کارایی اضافه شد:** `EXPLAIN (ANALYZE, BUFFERS)` برای شش وضعیت، با
معیار قابل بازبینی. **فرض نشده** که سه Index جدا شرط `OR` روی دو ستون Nullable
را کارآمد پوشش می‌دهند؛ نام Index انتخابی Planner باید در PR نوشته شود و اگر
دو Index دیگر هرگز انتخاب نشدند، تصمیم دربارهٔ حذفشان صریح گرفته شود.

۸. **هشت آزمون تازه** برای تمدید جزئی، تمدید صفر، خطای گذرا و بازیابی، سه حالت
خاموشی، Fence شدن یک ردیف در Fallback، و پاک‌سازی Timer در هر مسیر پایانی.

### D-025 — فرض عضویت در پنجره `claimPending(100)` — رفع شد (2026-09-02) ✅

آزمون `storage-and-outbox.int-spec.ts` یک ردیف تازه می‌کاشت، `claimPending(100)`
را صدا می‌زد و انتظار داشت ردیف خودش در نتیجه باشد:

```ts
const [id] = await seed(1);
const claimed = await store.claimPending(100);
expect(claimed.find((c) => c.id === id)).toBeDefined();
```

**این خاصیتِ پیاده‌سازی نیست.** پرس‌وجو **قدیمی‌ترین** ردیف‌های منتشرنشده کل
جدول را برمی‌دارد:

```sql
WHERE published_at IS NULL ORDER BY created_at LIMIT <limit> FOR UPDATE SKIP LOCKED
```

پس یک ردیف تازه‌نوشته‌شده — که **جدیدترین** ردیف در انتظار است — تنها زمانی در
پنجره است که پایگاه داده مشترک کمتر از `limit` ردیف قدیمی‌تر داشته باشد. با
بیشتر، **نبودنش یعنی پرس‌وجو درست کار می‌کند**. D-024 همین اشتباه روی `COUNT`
بود؛ این یکی روی `ORDER BY` و `LIMIT`.

**بازتولید قطعی (دو بار):**

| Backlog قدیمی‌تر | نتیجه `claimPending(100)`                                                               | ردیف تازه در پنجره؟ |
| ---------------- | --------------------------------------------------------------------------------------- | ------------------- |
| ۱۵۰ ردیف         | دقیقاً ۱۰۰ ردیف، همه منتشرنشده، مرتب از قدیمی‌ترین                                      | ❌ خیر              |
| ۱۲۰۰ ردیف        | آزمون **اصلاح‌نشده** روی `expect(row).toBeDefined()` افتاد؛ ۲۰ آزمون دیگر همان فایل سبز | ❌ خیر              |

**رفع — تفکیک Mapping از عضویت در پنجره:**

1. **Mapping** به `src/outbox/outbox.store.spec.ts` منتقل شد و علیه یک ردیف خام
   کنترل‌شده بررسی می‌شود: هر ستون snake_case، به‌علاوه شاخه `headers = null`.
   `claimPending` SQL خام روی نام‌های snake_case است و `toOutboxRow` همه را
   تغییر نام می‌دهد؛ یک لغزش آنجا رویدادی با فیلد گم‌شده منتشر می‌کند و رله
   بدون اعتراض آن را به Kafka می‌دهد. این اثبات به پایگاه داده نیاز ندارد.
2. همان آزمون واحد بندهای تعریف‌کننده پنجره را هم تثبیت می‌کند: فیلتر
   منتشرنشده، ترتیب قدیمی‌ترین‌اول، و کران — با `limit` به‌صورت پارامتر و
   **بدون** فیلتر سازمان. `FOR UPDATE SKIP LOCKED` صرفاً به‌عنوان SQL موجود
   بررسی می‌شود و هیچ تضمینی از آن ادعا نمی‌شود؛ دلیلش در D-026 پایین‌تر.
3. **آزمون Integration** فقط درباره ردیف‌هایی ادعا می‌کند که واقعاً برگشته‌اند:
   حداکثر `limit` تا، همه منتشرنشده، صعودی بر حسب `createdAt`، و هر فیلد
   Mapped موجود و از نوع درست.
4. **Fixture رگرسیون:** ۱۲۰۰ ردیف با تاریخ سال ۲۰۰۰، که ترتیب و کران را روی
   Backlogـی بزرگ‌تر از پنجره اثبات می‌کند — و شکست قدیمی را به‌عنوان خاصیت
   نگه می‌دارد: ردیف تازه **به‌درستی** بیرون از صد ردیف نخست است و هم‌زمان در
   انتظار می‌ماند.

**آنچه Fixture عمداً ادعا نمی‌کند:** اینکه مالک قدیمی‌ترین صد ردیف پلتفرم است —
و نه حتی اینکه **یک** ردیفش وارد پنجره می‌شود.

این در دو مرحله اصلاح شد. نسخه اول ادعا می‌کرد هر ردیف بازگشتی مال Fixture
است؛ با یک Backlog باستانی بیگانه افتاد. نسخه دوم ضعیف‌تر شد اما هنوز
`expect(mine.length).toBeGreaterThan(0)` داشت — که همچنان فرضِ عضویت در پنجره
سراسری بود. بازبینی محصول آن را گرفت و به‌صورت قطعی بازتولید شد: با ۱۲۰۰ ردیف
بیگانه به تاریخ ۱۹۹۰ — قدیمی‌تر از تک‌تک ردیف‌های Fixture در سال ۲۰۰۰ —
`mine.length === 0` می‌شود و آن ادعا می‌افتد، درحالی‌که پرس‌وجو کاملاً درست
کار می‌کند.

اکنون ادعا **مشروط** است: _اگر_ ردیفی از Fixture در پنجره باشد، قدیمی‌ترین‌های
خودش‌اند و پیوسته — ردیف n تنها وقتی داخل است که هر ردیف قدیمی‌تر از آن هم
داخل باشد. اگر هیچ‌کدام نباشند، فهرست تهی به‌طور بدیهی با پیشوند خودش برابر
است و آزمون سبز می‌ماند.

**بدون** افزایش `limit`، حذف `LIMIT`، فیلتر سازمان، تغییر ترتیب، `TRUNCATE`،
حذف یا Publish ردیف آزمون دیگر، Sleep، Retry یا ترتیب‌دهی.

**Production دست‌نخورده:** SQL، رله، معنای متریک، قواعد تنانت و قراردادهای
رویداد، هیچ‌کدام عوض نشدند.

**پایداری — ۵۰ اجرا، ۰ شکست:**

- ۲۰ اجرا با Fixture ۱۲۰۰ ردیفی درون‌سوئیتی: **۲۰ موفق**
- ۲۰ اجرا با یک Backlog باستانی **بیگانه** ۱۲۰۰ ردیفی که در تمام مدت حاضر بود:
  **۲۰ موفق**
- ۱۰ اجرای تأییدی روی فایل نهایی: **۱۰ موفق**

### D-024 — آزمون ناپایدار `pendingCount()` در `document-service` — رفع شد (2026-09-02) ✅

> این مورد هرگز در جدول بالا ثبت نشده بود؛ در چند Task پیاپی به‌عنوان
> «بدهی شناخته‌شده» شفاهی منتقل می‌شد. اینجا ثبت و بسته می‌شود.

آزمون `storage-and-outbox.int-spec.ts` دو شمارش سراسری را دور دو Insert
می‌گرفت و اختلاف را دقیقاً `۲` می‌خواست:

```ts
const before = await store.pendingCount();
await seed(2);
expect(await store.pendingCount()).toBe(before + 2);
```

**این خاصیتِ پیاده‌سازی نیست.** `pendingCount()` عمداً بدون Scope است — گِیج
`rasta_outbox_pending_total` کل Backlog رله را گزارش می‌کند — پس مقدارش به
ردیف‌های همه Suiteهایی که این پایگاه داده را share می‌کنند بستگی دارد. آنچه
واقعاً ادعا می‌شد این بود: «بین این دو خط، هیچ‌کس دیگری روی `outbox_message`
ننوشت» — چیزی که هیچ‌جا تضمین نشده.

**بازتولید قطعی، نه انتظار برای شکست تصادفی.** با یک تغییر کنترل‌شده بین دو
اندازه‌گیری، در حالی که رفتار Production کاملاً درست بود:

| تغییر همزمان توسط Suite دیگر | `before` | `after` | انتظار آزمون قدیمی |
| ---------------------------- | -------- | ------- | ------------------ |
| ساخت یک ردیف                 | ۰        | ۳       | ۲ ❌               |
| Publish کردن ردیف خودش       | ۴        | ۵       | ۶ ❌               |
| حذف ردیف خودش                | ۶        | ۷       | ۸ ❌               |

**رفع — آنچه اکنون ادعا می‌شود:**

1. `src/outbox/outbox.store.spec.ts` پرس‌وجو را **دقیق** تثبیت می‌کند:
   `count({ where: { publishedAt: null } })`، به‌صورت Argument دقیق، و
   کلیدهای `where` بررسی می‌شوند تا افزودن یک فیلتر تنانت بدون شکست ممکن
   نباشد. پیاده‌سازی‌ای که ردیف‌های Publish‌شده را بشمارد یا Predicate اشتباه
   بزند، همچنان می‌افتد.
2. آزمون Integration فقط ردیف‌هایی را ادعا می‌کند که مالکشان است — **با
   شناسه**، نه صرفاً با `organizationId`، چون هر آزمون این فایل زیر همان
   Organization دانه می‌کارد و «ردیف‌های در انتظارِ سازمان من» ردیف‌های
   آزمون‌های قبلی را هم می‌شمارد. برای گِیج سراسری فقط کران پایین ادعا می‌شود،
   که تنها چیزی است که واقعاً برقرار است.
3. آزمون دوم، دلیلِ نادرستیِ ادعای قدیمی را به‌عنوان خاصیت واقعی ثبت می‌کند:
   گِیج پلتفرمی است، پس ردیف سازمان دیگر هم با همان Predicate تطبیق می‌خورد.

**بدون** Sleep، Retry، ترتیب‌دهی، تأخیر دلخواه یا `TRUNCATE`. هیچ ردیفی که
مال آزمون دیگری باشد Publish یا حذف نمی‌شود.

**Production دست‌نخورده:** `pendingCount()` سراسری ماند، بدون
`organizationId`؛ رله تغییر نکرد؛ معنای `rasta_outbox_pending_total` عوض نشد —
و اکنون به‌جای عرف، با دو آزمون تثبیت شده است.

**پایداری (همان فایل، همان ماشین، همان پایگاه داده):**

- ۱۵ اجرای متوالی: **۱۵ موفق، ۰ ناموفق**
- ۱۰ اجرا زیر یک نویسنده همزمان که پیوسته ردیف می‌سازد، Publish و حذف می‌کند:
  **۱۰ موفق، ۰ ناموفق**
- ادعای **قدیمی**، بازگردانده‌شده و زیر همان Churn: **۰ موفق، ۱۰ ناموفق**

**یافته جانبی (آن زمان ثبت شد، اصلاح نشد):** زیر Churn مصنوعی سنگین (۱۰۷۴
ردیف در انتظار)، آزمون `claims pending rows` می‌افتاد — چون `claimPending(100)`
یک `LIMIT` دارد و ردیف تازه بیرون از پنجره می‌ماند. همان خانواده فرض است، اما
روی `LIMIT` به‌جای `COUNT`. **در D-025 پایین‌تر رفع شد.**

### D-023 — سه پارامتر Query که `"false"` را `true` می‌خواندند — رفع شد (2026-09-02) ✅

آخرین بازماندگان همان نقص D-020، اما روی مرز HTTP. `z.coerce.boolean()` تابع
`Boolean()` را اعمال می‌کند و هر رشته ناتهی `true` است، پس `?flag=false` دقیقاً
عکس درخواست را اجرا می‌کرد — و بی‌صدا، چون پاسخ یک خطا نبود، یک فهرست معتبر
اما اشتباه بود.

| پارامتر           | Endpoint                | پیش‌فرض | رفتار پیشین با `=false`                    |
| ----------------- | ----------------------- | ------- | ------------------------------------------ |
| `availableOnly`   | `GET /v1/assets/nearby` | `false` | فهرست به دارایی‌های قابل‌اعزام محدود می‌شد |
| `incoming`        | `GET /v1/settlements`   | `false` | نمای Payee به‌جای نمای Payer سرو می‌شد     |
| `includeIncoming` | `GET /v1/transactions`  | `false` | خواندن از نگهبان تنانت عبور می‌کرد         |

**رفع:** هر سه به `queryBoolean` منتقل شدند — همان Parser زمان اجرای
`booleanEnv`، با یک نشانه‌گذاری اضافه برای OpenAPI (پایین‌تر). پیش‌فرض هر سه
`false` بود و `false` ماند. مقدار نامعتبر اکنون `400 VALIDATION_FAILED` با نام
فیلد برمی‌گرداند، نه یک حدس.

**نشت داده رخ نداده بود.** دو عبور از نگهبان تنانت (`incoming` و
`includeIncoming`) همیشه به شناسه خودِ فراخوان محدود بودند، پس ردیف مستأجر
دیگری هرگز قابل‌دسترس نبود. اشکال این بود که _گشوده‌شدن دامنه_ به‌جای درخواست
کاربر، با ناتوانی Parser در خواندن کلمه «false» تصمیم‌گیری می‌شد. آزمون‌های
تازه همین را هم تثبیت می‌کنند.

**چرا نقص زنده مانده بود:** هر سه آزمون موجود فقط `=true` را اجرا می‌کردند.
زیر Coercion، `true` و `false` هر دو `true` می‌دهند، پس آزمونی که فقط `true`
را می‌آزماید پیش و پس از رفع یکسان سبز است.

**آزمون‌ها:** برای هر پارامتر یک آزمون مرزی روی `zodPipe` واقعی، به‌علاوه
آزمون رفتاری روی سطح واقعی: دو مورد اقتصادی روی HTTP واقعی
(`api-transaction.int-spec.ts`) و `availableOnly` روی PostGIS واقعی
(`asset-service/test/nearby.int-spec.ts` — نخستین آزمون Integration این
سرویس؛ Project آن تا امروز تهی بود).

**نقص دوم، در قرارداد منتشرشده — یافته بازبینی محصول (2026-09-02).** نخستین
اصلاح، زمان اجرا را درست کرد و قرارداد را خراب گذاشت. `queryBoolean` در زمان
اجرا `boolean | string` می‌پذیرد — چون Boolean در Query String به‌صورت متن
می‌رسد — و Converter این Union را عیناً منتشر می‌کرد:
`anyOf: [boolean, string]`. یعنی سند به Client می‌گفت پارامتر هر رشته‌ای را
می‌پذیرد، درحالی‌که Parser جز هشت املا همه را با `400` رد می‌کند؛ و Client
تولیدشده به‌جای `boolean` یک `string` می‌گرفت. OpenAPI خودش تعریف کرده Boolean
چگونه در Query String حمل می‌شود، پس `type: boolean` هم درست است هم کافی.

بدتر از خودِ Union، توجیه اولیه بود: «`includeDeleted` هم همین را منتشر
می‌کند.» یک نقص موجود، مجوز نقص تازه نیست. `includeDeleted` همان نقص را داشت و
در همین تغییر اصلاح شد، نه ثبت به‌عنوان بدهی.

**رفع:** `queryBoolean` علاوه بر Parser، یک نشانه (Symbol) روی خود Schema
می‌گذارد که می‌گوید «منطقاً Boolean، با این پیش‌فرض». Converterها آن را
می‌خوانند و `{ type: 'boolean', default }` منتشر می‌کنند. ورودی پذیرفته‌شده و
خروجی منتشرشده از **یک فراخوان** می‌آیند، پس مثل دو تعریف دست‌نویس از هم دور
نمی‌افتند.

**هر سه پارامتر اکنون در سند نهایی منتشر می‌شوند:**

| Endpoint                | پارامتر           | Schema منتشرشده                     |
| ----------------------- | ----------------- | ----------------------------------- |
| `GET /v1/assets/nearby` | `availableOnly`   | `{ type: boolean, default: false }` |
| `GET /v1/settlements`   | `incoming`        | `{ type: boolean, default: false }` |
| `GET /v1/transactions`  | `includeIncoming` | `{ type: boolean, default: false }` |

`GET /v1/settlements` اصلاً در هیچ Query Map نبود، پس `incoming` روی هر
درخواست Parse می‌شد و هیچ‌جا توصیف نشده بود؛ Schema آن از Controller به
`settlement/dto.ts` منتقل شد. `asset-service` سند خود را فقط از Decoratorها
می‌سازد و جست‌وجوی شعاعی هیچ پارامتری اعلام نکرده بود — `ApiQueryFromSchema`
آن‌ها را از همان Schema‌ای می‌سازد که `zodPipe` اعتبارسنجی می‌کند، تا دو توصیف
از یک پارامتر وجود نداشته باشد.

**آزمون‌ها روی سند نهایی، نه روی `toJsonSchema`.** فاصله میان این دو، دقیقاً
جایی بود که نقص زندگی می‌کرد. برای `economic` در
`api-operability.int-spec.ts` روی سندی که از اپلیکیشن واقعی ساخته می‌شود، و
برای `asset` روی خروجی `SwaggerModule.createDocument` — همان فراخوانی که
`main.ts` می‌زند.

### D-022 — نگهبان تنانت `document-service` نام مدل‌های سرویس دیگری را داشت — رفع شد (2026-08-31) ✅

`TENANT_SCOPED_MODELS` در `document-service` نام مدل‌های **marketplace** را داشت —
`Product`، `Offer`، `Order`، `OrderLine`، `Fulfillment`، `Review` — که هیچ‌کدام در آن
پایگاه داده وجود ندارند. `createTenantGuardExtension` هر مدلی را که نمی‌شناسد
دست‌نخورده رد می‌کند، پس نگهبان نصب بود، چیزی Log نمی‌کرد و **هیچ‌چیز را Scope
نمی‌کرد**: هر Query روی `Document`، `UploadIntent` و `AccessGrant` بدون فیلتر اجرا
می‌شد، و هر `runUnscoped(...)` در Repository عبور از مرزی را علامت می‌زد که وجود نداشت.

**هیچ خواندن میان‌مستأجری از این راه قابل دسترس نبود** — `list` خودش در Query با
`organizationId` فیلتر می‌کند و جست‌وجوهای شناسه‌محور سطر را مستقیم به `access.ts`
می‌دهند که برای بیگانه `404` می‌گوید. به همین دلیل هر ۹۶ تست یکپارچگی، چه با نگهبان
فعال و چه بدون آن، سبز بودند.

آنچه غایب بود، همان لایه‌ای است که A-04 می‌خواهد: Scope **اعمال‌شده**، نه به‌خاطر
سپرده‌شده. دفاعی که بی‌اثر است ولی حاضر به نظر می‌رسد، از دفاع غایب بدتر است — چون
Query بعدی که اینجا نوشته شود توسط هیچ‌کس بررسی نمی‌شد.

**رفع:** فهرست به مدل‌های خود این سرویس اصلاح شد. `markDeleted` حالا صریحاً از نگهبان
عبور می‌کند — اپراتور پلتفرم می‌تواند سند سازمان دیگری را حذف کند
(`assertDocumentWritable` که Scope پلتفرمی را می‌پذیرد)، و با فیلتر شدن بر اساس سازمان
خودِ فراخوان، آن `UPDATE` صفر سطر می‌گرفت و به‌صورت شکست قفل خوش‌بینانه ظاهر می‌شد —
پاسخ اشتباه به عملی مجاز.

**و نمی‌تواند دوباره رخ دهد:** `tenant-scope.spec.ts` مجموعهٔ درست را از خود
`schema.prisma` **مشتق می‌کند** به‌جای تکرار کردنش. هر مدلی که `organizationId` دارد یا
باید محافظت شود یا به‌عنوان استثنا نوشته شود.

### D-020 — Flagهای محیطی Boolean که خاموش نمی‌شدند — رفع شد (2026-09-01) ✅

`z.coerce.boolean()` تابع `Boolean()` جاوااسکریپت را اعمال می‌کند، و در آن
**هر رشته ناتهی `true` است** — از جمله رشته `"false"`، و همچنین `"0"`،
`"no"` و `"off"`. یعنی این Flagها را نمی‌شد خاموش کرد. اپراتور مقدار را
می‌گذاشت، پیکربندی خودش را می‌خواند، و باور می‌کرد قابلیت غیرفعال است. یک Flag
که خاموش نمی‌شود، از نبودن Flag بدتر است.

**بازرسی کامل Repository، فهرست ثبت‌شده را کامل نکرد.** سه Flag دیگر هم
Parser دست‌ساز داشتند — `z.string().transform((v) => v !== 'false')` و
`v === 'true'` — که همان نقص با ظاهری دیگر است: هرکدام تنها **یک** املا را
می‌پذیرفت و برای بقیه بی‌صدا حدس می‌زد. پس دامنه واقعی هشت Flag بود، نه پنج.

**هر هشت Flag متأثر، با پیش‌فرض حفظ‌شده:**

| متغیر                              | فایل                                             | Parser پیشین                    | پیش‌فرض |
| ---------------------------------- | ------------------------------------------------ | ------------------------------- | ------- |
| `OTEL_TRACES_ENABLED`              | `packages/config/src/env.ts` (`baseEnvSchema`)   | `z.coerce.boolean()`            | `true`  |
| `KAFKA_SCHEMA_STRICT`              | `packages/config/src/env.ts` (`kafkaEnvSchema`)  | `z.coerce.boolean()`            | `true`  |
| `GATEWAY_RATE_LIMIT_FAIL_OPEN`     | `services/api-gateway/src/config/env.ts`         | `z.coerce.boolean()`            | `true`  |
| `KEYCLOAK_SYNC_ENABLED`            | `services/identity-service/src/config/env.ts`    | `z.coerce.boolean()`            | `true`  |
| `MARKETPLACE_TEMPORAL_ENABLED`     | `services/marketplace-service/src/config/env.ts` | `z.coerce.boolean()`            | `true`  |
| `ECONOMIC_REWARD_CASHBACK_ENABLED` | `services/economic-service/src/config/env.ts`    | `transform(v => v === 'true')`  | `false` |
| `ECONOMIC_BALANCE_AUDIT_ENABLED`   | `services/economic-service/src/config/env.ts`    | `transform(v => v !== 'false')` | `true`  |
| `MAINTENANCE_DUE_SCAN_ENABLED`     | `services/maintenance-service/src/config/env.ts` | `transform(v => v !== 'false')` | `true`  |

**رفع:** هر هشت مورد به `booleanEnv` — همان Parser مشترک و آزمون‌شده در
`@rasta/config` — منتقل شدند. Parser تازه‌ای ساخته نشد؛ کار یکسان‌سازی بود.
هیچ پیش‌فرضی عوض نشد.

**مقادیر پذیرفته‌شده (پس از Trim، بی‌اعتنا به بزرگی و کوچکی حروف):**

- `true` ← `true`، `1`، `yes`، `on`
- `false` ← `false`، `0`، `no`، `off`، و **مقدار تهی**
- هر چیز دیگر → خطای اعتبارسنجی و توقف سرویس هنگام Boot، نه حدس بی‌صدا.

**ارزیابی تغییر رفتار پیش از استقرار — آنچه فردا معنایش عوض می‌شود:**

1. هر محیطی که امروز یکی از این هشت متغیر را روی `false`، `0`، `no` یا `off`
   گذاشته، تا دیروز آن قابلیت **روشن** بوده و از این Commit به بعد واقعاً
   خاموش می‌شود. این همان نیت اپراتور است، اما تغییر رفتار واقعی است.
   حساس‌ترین مورد `GATEWAY_RATE_LIMIT_FAIL_OPEN` است: استقراری که
   Fail-Closed خواسته بود، از این پس با قطع Redis واقعاً ترافیک را رد می‌کند.
2. `ECONOMIC_BALANCE_AUDIT_ENABLED=` و `MAINTENANCE_DUE_SCAN_ENABLED=`
   (مقدار تهی) تا دیروز `true` خوانده می‌شدند و اکنون `false` هستند —
   `booleanEnv` مقدار تهی را انتخاب عمدی اپراتور می‌داند، نه «تنظیم‌نشده».
3. `ECONOMIC_REWARD_CASHBACK_ENABLED` در جهت عکس حرکت می‌کند: `1`، `yes` و
   `on` تا دیروز بی‌صدا `false` بودند و اکنون Cashback را باز می‌کنند.
4. هر مقدار نامعتبر — از جمله غلط تایپی `ture` — که تا دیروز بی‌صدا به یک
   پیش‌فرض می‌افتاد، اکنون سرویس را هنگام Boot متوقف می‌کند.

`.env.example` هر سه Flag ثبت‌نشده را گرفت و مقادیر مجاز در سرصفحه فایل
مستند شد.

**آزمون‌ها:** هر هشت Flag در مرز پیکربندی **سرویس مالک خودش** آزمون دارد —
`"true"`، `"false"`، پیش‌فرض در غیاب متغیر، و رد مقدار نامعتبر. برای
`GATEWAY_RATE_LIMIT_FAIL_OPEN` یک آزمون رفتاری هم اضافه شد
(`services/api-gateway/src/proxy/rate-limiter.spec.ts`): پیکربندی از
`loadGatewayEnv` به `RateLimiter` می‌رود، Redis از دسترس خارج می‌شود، و
درخواست باید **رد** شود. این آزمون‌ها روی پیاده‌سازی پیشین می‌افتند.

**پارامترهای Query — بسته شد (2026-09-01).** سه پارامتر باقی‌مانده هم به
`booleanEnv` منتقل شدند: `availableOnly` در `asset-service` و
`incoming`/`includeIncoming` در `economic-service`. جزئیات در D-023 پایین‌تر.

### D-017 — تنانتِ فراخوان سرویس‌به‌سرویس (Q-28) — رفع شد (2026-08-29) ✅

`AuthGuard.authenticateInternal` هیچ `organizationId` تفکیک نمی‌کرد، پس هر **۱۰**
Handler دارای `@AllowService` روی نخستین خواندن مستأجر-محدود `500` می‌داد.
Fail-Closed بود، اما مسیر Activity در `docs/08` § ۸٫۶ کار نمی‌کرد.

**رفع (ADR-035):** تنانت از Claim امضاشده `org_id` داخل توکن داخلی می‌آید.
`X-Organization-Id` فقط اجازه دارد موافقت کند؛ ناهم‌خوانی و نبودِ Claim روی
عملیات مستأجر-محدود هر دو `403 SERVICE_TENANT_CONTEXT_INVALID` می‌گیرند. بدون
Fallback.

**یک یافته جانبی که همین کار پیدا کرد:** `economic-service/src/access/access.ts`
برای هر فراخوان سرویسی بررسی سطح Object را کنار می‌گذاشت
(`if (context.authType === 'SERVICE') return;` در سه تابع). تا وقتی سرویس
تنانتی نداشت قابل دفاع بود؛ با تنانت امضاشده یک خواندن میان‌مستأجری می‌شد. حالا
سرویس هم همان بررسی را می‌گیرد: توکن سازمان A رکورد سازمان B را نمی‌بیند
(`404`) و نمی‌تواند تعهدش را ببندد (`403 TENANT_MISMATCH`).

> **تصحیح عددی.** گزارش پیشین «۲۶ Endpoint» گفته بود. آن `grep` کامنت‌ها و
> Specها را هم می‌شمرد؛ عدد واقعی **۱۰** است.

### D-019 — کلید پارتیشن رویدادهای اقتصادی (Q-26) — رفع شد (2026-08-29) ✅

`LedgerService.enqueue` کلید را از `aggregateId` می‌گرفت مگر جایی که Call Site
صریحاً `partitionKey` می‌داد. نتیجه: رویدادهای یک تراکنش روی تا **چهار** پارتیشن
پخش می‌شدند و مصرف‌کننده‌ای که تراکنش را بازسازی می‌کرد می‌توانست
`SETTLEMENT_COMPLETED` را پیش از `FUNDS_HELD` ببیند.

**رفع (ADR-036):** هویت Aggregate در Envelope و کلید ترتیب پارتیشن از هم جدا
شدند. چهار رویداد کلیدشان عوض شد — `FUNDS_HELD`، `FUNDS_RELEASED`،
`PAYMENT_COMPLETED` و `JOURNAL_POSTED`ِ دارای تراکنش — و همه به `transactionId`
رسیدند. `aggregateType`/`aggregateId` هیچ‌کدام تغییر نکرد.

قاعده یک Mapped Type روی اتحاد نام رویدادهاست
(`src/events/routing.ts`)، پس **افزودن رویداد بدون تصمیم درباره ترتیب Compile
نمی‌شود** — با یک رویداد آزمایشی تأیید شد: `Property 'PROBE_EVENT' is missing`.
`enqueue` دیگر پارامتر `partitionKey` ندارد، پس Policy توصیه نیست.

`PAYMENT_AUTHORIZED` و `PAYMENT_FAILED` عمداً تراکنشی **نشدند**:
`PaymentIntent.transaction_id` هنگام Capture نوشته می‌شود و یک پرداخت
شکست‌خورده هرگز تراکنشی نخواهد داشت. هزینه پذیرفته‌شده: ترتیب میان دو فاز یک
Intent دیگر تضمین نمی‌شود، و در ADR مستند است.

بدون تغییر Payload، بدون `eventVersion` جدید، بدون Migration.

### D-018 — دسترسی خواندنی دفتر کل از Gateway (Q-27) — بسته شد با سیاست محصول (2026-08-29) ✅

وضعیت عوض **نشد** و این خودش تصمیم است: Journal خام از Gateway عمومی در دسترس
نیست. کاربر مستأجر نماهای امنِ تراکنشی (`/v1/transactions`، `/v1/wallets/me`)
را مصرف می‌کند، و دسترسی به Journal خام در آینده نیازمند یک **مجوز مالی
اختصاصی** است نه بازکردن یک Prefix برای نقش‌های موجود.

هیچ ردیفی در `routes.ts`، هیچ `@Roles` و هیچ تستی عوض نشد.

### D-010 — Docker Desktop از کار افتاد و رفع شد (2026-08-28) ✅

**ریشه، به ترتیب کشف:**

1. `com.docker.service` (سرویس ویندوزی که Engine لینوکسی به آن وابسته است)
   متوقف بود.
2. پس از Start شدن آن، Named Pipe همچنان ساخته نمی‌شد چون Docker Desktop خطای
   `initializing Ingest server` می‌داد.
3. علت واقعی: چهار **Socket یتیم** در
   `%LOCALAPPDATA%\Docker
un\` — فایل‌های صفر-بایتی از نوع ReparsePoint که از
   Process کشته‌شده قبلی مانده بودند. Docker نمی‌توانست حذف و بازسازی‌شان کند، و
   API فایل ویندوز هم نمی‌توانست بازشان کند («The file cannot be accessed by
   the system»).

**رفع:** تغییر نام پوشه `run` (غیرمخرب — نسخه قدیمی به‌عنوان `run.stale-*` ماند)
و راه‌اندازی دوباره Docker Desktop. Docker پوشه را از نو ساخت و همه کانتینرها
سالم بالا آمدند.

**درس عملیاتی — این اشتباه در همین Task رخ داد.** Engine API از ابتدای جلسه
خطای ۵۰۰ می‌داد **اما کانتینرها کار می‌کردند** و پورت‌ها پاسخ می‌دادند. Restart
کردن Docker Desktop، یک Stack کارکن ولی غیرقابل‌مدیریت را به یک Stack خاموش
تبدیل کرد و ساعت‌ها وقت گرفت. **اول پورت‌ها را بررسی کن؛ اگر پاسخ می‌دهند، با
همان کار کن.**

**نکته جانبی — D-009 هم با همین رفع بسته شد.** پس از بازسازی محیط،
`rasta-temporal` هم `healthy` شد و هم `temporal --version` داخل Image پاسخ
داد. یعنی «باینری CLI اجرا نمی‌شود» پیامد همین خرابی بود، نه نقص Image.

### فاز نگهداری (2026-08-28) — هیچ باگ تولیدی نگرفت، و چرا

نخستین اجرای Suite Integration نگهداری **صفر باگ تولیدی** پیدا کرد. این ادعا فقط
وقتی معنا دارد که کنارش گفته شود چه چیزی آزموده شد: منع درخواست تکراری زیر مسابقه
واقعی، ده ثبت هزینه هم‌زمان، Rollback تراکنش Outbox، و یک پیام واقعی روی Topic
واقعی fleet. تنها شکست، یک **ادعای نادرست در خودِ تست** بود (`dueBy` باید هنگام
`NOT_DUE` هم گزارش شود — رفتار کد درست بود).

دلیلش ساده است: **هر پنج تله فاز ناوگان از روز اول بسته بودند** —

- هیچ ستون زمانی کسب‌وکاری `@default(now())` ندارد،
- ترجمه نقض Constraint روی **نام ستون** تطبیق می‌دهد، نه نام Index،
- `asActor` از ابتدا `async () => fn()` است،
- Invariant ها در پایگاه داده‌اند، نه فقط در لایه Application،
- و رویدادها `assetId` حمل می‌کنند چون Projector مقصد بدون آن Skip می‌کند.

### رفع‌شده در Task ناوگان (2026-08-28)

- **صفر فایل `*.int-spec.ts` — رفع شد.** چهار Suite واقعی در
  `services/fleet-service/test/`، و `test:integration` دیگر
  `--passWithNoTests` ندارد.
- **`asset-service` در CI Container Matrix نبود — رفع شد.** هم `asset-service`
  و هم `fleet-service` به Matrix افزوده شدند. (`api-gateway` همچنان
  Dockerfile ندارد و باز است.)
- **شش باگ که تست‌های Integration و CI گرفتند** — همه رفع شدند. هیچ‌کدام با
  تست واحد پیدا نمی‌شد؛ سه‌تا نیازمند پایگاه داده واقعی، دوتا نیازمند اجرای
  واقعی خود تست، و یکی **فقط روی Runner واقعی CI** قابل مشاهده بود.

  **در کد تولیدی:**

  1. **`AssetSyncConsumer` — تنانت پاک می‌شد.** یک کلید `patch` با مقدار
     `undefined` سازمان حل‌شده را بازنویسی می‌کرد. اثر: `ASSET_CREATED` که
     سازمانش فقط روی Envelope بود، ردیفی بدون سازمان می‌نوشت.

  2. **`AssignmentService` — ترجمه خطای انحصار هرگز کار نمی‌کرد.** کد روی
     **نام Index** تطبیق می‌داد (`ux_assignment_active_driver`)، اما Prisma در
     `P2002` **نام ستون** را در `meta.target` می‌گذارد (`driver_id`). پس هر
     مسابقه واقعی به مسیر عمومی `ALREADY_EXISTS` می‌افتاد. Invariant همیشه
     برقرار بود — چیزی که می‌شکست، وعده ADR-025 بود که «مسابقه از تعارض عادی
     قابل تشخیص نیست»: فراخوان ترتیبی `422` با نام قاعده می‌گرفت و فراخوان
     همزمان `409` بی‌نام.

  3. **`Assignment.startedAt` — دو ساعت روی یک ردیف.** ستون
     `@default(now())` داشت (ساعت PostgreSQL) در حالی که `ended_at` همیشه از
     Node می‌آید، و `ck_assignment_period` آن دو را مقایسه می‌کند. روی این
     ماشین PostgreSQL در WSL2 **۱۴ تا ۵۶ میلی‌ثانیه جلوتر** از میزبان است، پس
     تخصیصی که در همان پنجره ساخته و بسته شود، Constraint خودش را نقض می‌کند.
     مسیر تولیدی امن بود (همه جا `startedAt` صریح داده می‌شود)، ولی Default ای
     که هیچ‌کس استفاده نمی‌کند و فقط می‌تواند ساعت دوم وارد کند، یک تله است.
     حذف شد.

  4. **Race در Group Coordinator کافکا — فقط CI پیدایش کرد.** Broker
     تازه‌راه‌افتاده به Healthcheck پاسخ می‌دهد در حالی که
     `__consumer_offsets` هنوز بارگذاری می‌شود؛ `connect()`، `subscribe()` و
     `run()` همگی موفق برمی‌گردند اما Consumer به Group نپیوسته. تست روی
     Topic ای منتشر می‌کرد که کسی نمی‌خواند و با Timeout ای شکست می‌خورد که
     نام اشتباهی می‌برد. رفع با انتظار روی `GROUP_JOIN` (در تست) و گرم کردن
     Coordinator (در CI) — دو محافظ مستقل.

  **در خود تست‌ها:**

  4. **`test/helpers.ts` — همان تله D-003 در فایلی تازه.** Query تنبل Prisma
     **پس از** بسته شدن Context اجرا می‌شد، یعنی بدون هیچ Tenant Scope.

  5. **`usage-outbox.int-spec.ts` — خواندن خارج از Context.** یک `findMany`
     روی مدل Scope‌دار بیرون از `asActor`. Tenant Guard **درست** خطا داد — که
     خودش شاهدی است بر اینکه Guard کار می‌کند.

### یافته‌های دروازه انتشار (Release Gate، 2026-08-28)

سه مورد در Audit رسمی پیدا و رفع شد — هیچ‌کدام باگ رفتاری نبود، اما هر سه
ادعایی را که این Repository درباره خودش می‌کند نقض می‌کردند:

- **N+1 در گزارش بهره‌برداری.** برای هر دارایی یک Query جدا می‌زد تا نام را
  اضافه کند — تا ۲۰۰ رفت‌وبرگشت برای گزارشی که داده‌اش از دو Query می‌آمد.
  تنها Query سرویس که با اندازه ناوگان رشد می‌کرد، نه با اندازه صفحه.
- **یک عبور از مرز تنانت که Greppable نبود.** شمارنده تخصیص‌های فعال با Raw SQL
  میان‌تنانتی می‌شمرد. خود شمارش درست بود (Gauge است و هیچ تنانتی نمی‌بیندش)،
  اما Raw SQL را Extension رهگیری نمی‌کند، پس نه در `grep -r runUnscoped`
  دیده می‌شد و نه در Log حسابرسی. داستان حسابرسی فقط وقتی برقرار است که **هر**
  عبور قابل شمارش باشد، حتی بی‌ضررها.
- **OpenAPI هیچ Schema ای نداشت.** هر Endpoint نوشتنی با یک Summary و بدون
  Request Body منتشر می‌شد. علت ساختاری بود: پلتفرم با Zod اعتبارسنجی می‌کند و
  `@nestjs/swagger` از Class های Decorate شده Schema می‌سازد. یک Converter
  کوچک و بدون وابستگی نوشته شد که از **همان** Schema هایی که سرویس با آن‌ها
  اعتبارسنجی می‌کند، JSON Schema تولید می‌کند — پس سند نمی‌تواند واگرا شود.

### رفع‌شده در جلسه پیشین (برای شفافیت ثبت شده، نه به‌عنوان کار باقی‌مانده)

- D-003: `runUnscoped` دامنه‌اش را از دست می‌داد (Prisma Promise تنبل) —
  رفع در `packages/nest-common`.
- D-004: `pnpm db:migrate` بدون `DATABASE_URL` صریح کار نمی‌کرد —
  `scripts/prisma.mjs` اضافه شد.
- **D-005: CI هرگز روی GitHub سبز نشده بود — رفع و CI VERIFIED**
  (Run `33076090420`). ریشه: تصادم نسخه pnpm. در مسیر رفع، شش نقص واقعی
  دیگر هم آشکار و رفع شد که هیچ‌کدام محلی دیده نمی‌شدند — از جمله یک
  دروازه Semgrep که سبز گزارش می‌داد بی‌آنکه چیزی Scan کند.
- **D-007: Gateway مسیر عمومی را می‌شکست — رفع و LIVE VERIFIED**
  (`201` زنده). ریشه: توکن داخلی دو معنا را با یک شکل حمل می‌کرد؛ با Claim
  `purpose` تفکیک شد (بخش ۱۱).

### قدیمی (از پیش مستند، هنوز صادق)

- D-001: هشدار `TimeoutNegativeWarning` از kafkajs — فقط نویز Log.
- D-002: قفل Prisma Engine در ویندوز حین `generate` — سرویس باید متوقف شود.

جزئیات کامل هرکدام: [`docs/23-risks-and-tradeoffs.md`](docs/23-risks-and-tradeoffs.md)
بخش ۲۳٫۵-الف.

---

## ۲۳. Technical Debt

جدا از Known Issues (که رفتار غلط تولید می‌کنند)، این‌ها تصمیم‌های آگاهانه
با هزینه پذیرفته‌شده‌اند:

- T-01 تا T-05 در `docs/23-risks-and-tradeoffs.md` (Microservices در مقیاس
  کوچک، Kafka برای حجم کم، Temporal سنگین، رد Kong/APISIX، Prisma به‌ازای سرویس).
- Testcontainers نصب نشده — تست‌های Integration به‌جایش روی Stack ‏`infra:up`
  و روی Service Container های CI اجرا می‌شوند. تصمیم آگاهانه، نه شکاف.
- **Playwright نصب شد** (2026-08-29). Project ‏`web` تا ساخته‌شدن `apps/web`
  اضافه نمی‌شود؛ Harness آماده است.
- Production mTLS و Database RLS — Planned، نه Implemented (بخش ۲۰).

---

## ۲۴. Open Questions

**هیچ‌کدام در فاز اقتصادی هم حل نشدند — و این عمدی است.** آنچه عوض شد این است
که حالا **پاسخ هر کدام یک درج یا به‌روزرسانی رکورد است، نه تغییر کد**:

| پرسش           | پاسخ‌دادنش امروز چقدر کار دارد                                                                     |
| -------------- | -------------------------------------------------------------------------------------------------- |
| **Q-08**       | یک `POST /v1/commissions/rules`. تا آن روز: کارمزد صفر و `commissionRuleMatched: false`            |
| **Q-09**       | یک `PATCH /v1/rewards/rules/{id}` با `creditPerPointMinor`. تا آن روز: پاداش امتیازی، بدون Journal |
| **Q-07**       | یک تغییر پرچم. تا آن روز: ساختن قاعده `CASHBACK` با `422` **رد** می‌شود                            |
| **Q-13**       | درج در `reward_level.benefits`. تا آن روز: سطح محاسبه می‌شود، مزیتی اعطا نمی‌شود                   |
| **Q-01، Q-14** | یک کلاس تازه `PaymentProvider` و یک شاخه پیکربندی. Domain Core دست نمی‌خورد                        |

همگی هنوز باز و در
[`docs/24-open-questions.md`](docs/24-open-questions.md) هستند:

- نرخ کارمزد پلتفرم (۲۴٫۲)
- مرجع موافقت زنجیره تأیید مناقصه/قرارداد (۲۴٫۱، ۲۴٫۲)
- الزامات حقوقی کیف پول/نگهداری وجوه (۲۴٫۱)
- یکپارچگی ملی (شاهکار، ثبت‌احوال و…) (۲۴٫۳)
- نگهداشت داده و حریم خصوصی (۲۴٫۱)
- برند و محصول نهایی (۲۴٫۴)

**دو پرسش تازه از فاز نگهداری (۲۴٫۶)، هر دو 🟠 و هر دو در ADR-029:**

- **Q-24** — قاعده «فقط دارایی تخصیص‌یافته» برای `OPERATOR` چگونه اجرا شود؟
  واقعیتش نزد `fleet-service` است و به شکلی که با یک توکن تطبیق بخورد در دسترس
  نیست. تصمیم موقت: اپراتور در سازمان خودش گزارش می‌دهد و فقط گزارش‌های خودش را
  می‌بیند — باریک‌تر در هر جهتی جز آن یکی که یک گزارش ایمنی را خفه می‌کرد.
- **Q-25** — مدل دسترسی تعمیرگاه چیست؟ خدمت‌رسانی به `WORKSHOP` یعنی خواندن
  میان‌تنانتی، که این پلتفرم ندارد. تصمیم موقت: پورتال به تعویق؛ نقش `WORKSHOP` در
  باریک‌سازی می‌افتد و هیچ نمی‌بیند.

**یک پرسش از فاز اسناد — ✅ بسته شد (2026-08-31):**

- **Q-18 — سرویس اسکن بدافزار.** پاسخ: **ClamAV خودمیزبان** (ADR-049). دقیقاً همان
  شکلی را داشت که این سند پیش‌بینی کرده بود — یک کلاس پشت `MalwareScanner` و یک خط در
  `app.module.ts`، بدون هیچ تغییری در Domain.

  **آنچه عوض شد:** اسناد دیگر `NOT_SCANNED` نمی‌گیرند؛ `PENDING` ثبت می‌شوند و یک
  Worker ناهمزمان آن‌ها را به `CLEAN`، `INFECTED` یا `FAILED` می‌برد. **دانلود سند برای
  نخستین بار در تاریخ پلتفرم کار می‌کند** — و فقط پس از یک `CLEAN` معتبر.

  **آنچه عوض نشد:** `canDownload` هنوز فقط `CLEAN` را مجاز می‌شمارد و هیچ آرگومان
  پیکربندی نمی‌گیرد. سطرهای `NOT_SCANNED` دست‌نخورده ماندند — «هیچ‌چیز به این بایت‌ها
  نگاه نکرد» با «منتظر نگاه‌کردن است» یکی نیست، و بازبینی دوباره‌شان یک Backfill صریح
  اپراتور است (`docs/runbooks/malware-scanner-down.md` § ۷).

  اگر مالکیت محصول پیش از وجود اسکنر به فایل قابل‌دانلود نیاز دارد، آن یک تصمیم
  صریح محصول و امنیت است و به **اصلاحیه ADR-014** نیاز دارد. از راه یک پیش‌فرض
  محیطی سهل‌گیرانه وارد نمی‌شود — و اکنون نمی‌تواند، چون چنین متغیری وجود ندارد.

هیچ‌کدام با حدس پر نشدند، طبق دستور صریح کاربر در همه Prompt های قبلی.

---

## ۲۵. Architecture Decisions

**به‌روزرسانی 2026-09-07 — ۵۴ ADR موجود (`ADR-001` تا `ADR-054`).** شمارش پایین‌تر در این بخش کهنه است و به فاز اقتصادی
تعلق دارد؛ فهرست معتبر همیشه `docs/21-adr-list.md` است.

دو ADR تازه، هر دو **`Proposed`** و هیچ‌کدام پیاده نشده:

- **ADR-053 — سرویس حسابرسی، شواهد فقط‌الحاقی.** دو مسیر ورودی (Projector روی هر ده Topic دامنه‌ای + قرارداد صریح
  `AUDIT_EVENT_RECORDED` روی `rasta.audit.trail.v1`)؛ فقط‌الحاقی با سه لایه (REVOKE، Trigger، زنجیرهٔ Hash به‌ازای
  `(organizationId, ماه)`)؛ حسابرسی ردها از راه یک `security_event_outbox` محلی و ناهمزمان، پس مسیر مجوزدهی هرگز به
  حسابرسی وابسته نمی‌شود؛ اصلاح فقط با رکورد جبرانی؛ بدون API نوشتن؛ امضای رمزنگارانه موکول، چون مدیریت کلید لازمش در این
  مخزن وجود ندارد.
- **ADR-054 — سرویس اعلان، تحویل و ترجیحات.** حل گیرنده از راه `GET /v1/users` با Token داخلی `SERVICE` و `org_id`
  امضاشده، سپس **Snapshot**؛ Dedupe **محتوامحور** با باندبندی `daysRemaining` به `{30, 14, 7, 3, 1}`؛ نردبان ترجیحات با
  سیاست اعلان الزامی بالای آن و رد صریح `422` به‌جای پذیرشِ خاموش؛ ساعات سکوت **تعویق** می‌اندازند نه حذف و `CRITICAL` از
  آن‌ها عبور می‌کند؛ کانال پشت Port با Adapter توسعهٔ Mailpit.

**آنچه ادعا نمی‌شود:** هیچ کدی نوشته نشده، هیچ ایمیلی ارسال نشده، هیچ رکورد حسابرسی وجود ندارد، و پوشش حسابرسی حتی پس از
پیاده‌سازی **کامل نخواهد بود** — یک تغییر وضعیت که رویدادی منتشر نمی‌کند نامرئی می‌ماند تا جداگانه اصلاح شود.

**یک تغییر مشترک که باید اتمیک و پیش از هر دو فرود بیاید:** ثبت هر دو سرویس در `.github/workflows/ci.yml`،
`scripts/verify-outbox-claim-migration.mjs` و زنجیرهٔ `test:migration` در ریشهٔ `package.json`. `scripts/ci-image-matrix.mjs`
مجموعهٔ منتظر را از `git ls-files services/*/Dockerfile` استخراج می‌کند و اگر ماتریس Workflow نخواند Job را می‌شکند، پس
Dockerfile و ردیف ماتریسش نمی‌توانند جدا فرود بیایند. **آن PR در این Task ساخته نشد.**

---

**پیشین (فاز اقتصادی).** **۳۴** ADR موجود (`docs/adr/ADR-001` تا `ADR-034`)، فهرست کامل در
`docs/21-adr-list.md`. پنج تای آخر از فاز اقتصادی‌اند: **۰۳۰** (پارتیشن‌بندی
دفتر کل، موکول با شرط عددی)، **۰۳۱** (تسویه بدون Temporal و بدون Redis)،
**۰۳۲** (مرز مصرف رویداد، و اینکه یک تأیید پول را حرکت نمی‌دهد)، **۰۳۳**
(پولی‌سازی پاداش)، **۰۳۴** (امانت به‌ازای هر سازمان — حل یک تناقض در خودِ
`docs/10`).

پیشین: ۲۹ ADR (`ADR-001` تا `ADR-029`). سه تای آخر از فاز نگهداری‌اند: **۰۲۷** (سررسید مشتق‌شده،
Temporal موکول)، **۰۲۸** (مبدأ هزینه و درز اقتصادی)، **۰۲۹** (دسترسی تعمیرگاه و
مجوزدهی سطح Object). هیچ ADR جدیدی در این Audit لازم نبود — دو رفع باگ
(D-003, D-004) تصمیم معماری نبودند (اصلاح رفتار در برابر تصمیم موجود)، و
الگوی مصرف رویداد (`EventConsumer`) از قبل زیر چتر **ADR-021 (Outbox
Pattern)** پوشش داده شده (بخش «At-Least-Once + Idempotent Consumer» را
صریح ذکر کرده).

ADR های مرتبط با کاری که واقعاً ساخته شده:
ADR-001 (Microservices)، ADR-004/005 (Database + Ownership)، ADR-006
(Kafka)، ADR-007 (Redis)، ADR-008 (Keycloak)، ADR-009 (Gateway)، ADR-011
(Multi-Tenancy)، ADR-012 (Asset-Centric)، ADR-018 (Monorepo)، ADR-020
(Service-to-Service Auth)، ADR-021 (Outbox)، ADR-022 (Money).

---

## ۲۶. Completed Work

- ۲۴ سند معماری + ۲۴ ADR + AGENTS.md/CLAUDE.md/README.md
- Monorepo کامل با TS strict، ESLint، Prettier، Turborepo
- ۶ Package مشترک (`contracts, config, logging, observability, nest-common, testing`)
- Infrastructure کامل (Postgres+PostGIS، Redis، Kafka، Keycloak Realm با
  ۴ کاربر Seed، MinIO، Temporal) — با Runbook برای هر مشکل واقعی برخورده‌شده
- ۶ سرویس Backend کامل: `identity, organization, asset, api-gateway, fleet, maintenance`
- ۴۱۵ تست واحد + ۷۳ تست Integration، همه سبز — محلی و روی Runner واقعی
- **۹ Suite تست Integration واقعی** — ۴ در fleet، ۵ در maintenance
- Kafka Consumer عمومی (`EventConsumer`) + Projector واقعی (`asset-service`
  Timeline از رویدادهای سرویس‌های دیگر)
- **CI Pipeline سبز روی GitHub Actions** (۴ Job، ۸ اجرا با Matrix) —
  **CI VERIFIED** تا Commit `24bef76`، Run `33172549841` (بخش ۱۹)
- **fleet-service:** Driver · Assignment (با Invariant انحصار در پایگاه داده) ·
  UsageRecord (Idempotent برای ثبت آفلاین) · Availability (ترکیبی، با نام مالک هر
  مانع) · Utilization · Consumer دوطرفه با asset-service
- **maintenance-service:** MaintenanceSchedule (سه محرک، سررسید مشتق‌شده) ·
  MaintenanceRequest (با کنترل منع درخواست تکراری در پایگاه داده) · RepairOrder ·
  PartUsage · LaborEntry · MaintenanceCost (هر خط با مبدأ) · دو Consumer با دو
  Group · دروازه تأیید پیش از تسویه
- **دو مسیر مرده پلتفرم زنده شدند:** `USAGE_RECORDED` مصرف‌کننده گرفت، و
  `MAINTENANCE_STARTED`/`MAINTENANCE_COMPLETED` تولیدکننده — هر دو زنده تأیید شدند
- ۵ ADR تازه (۰۲۵ انحصار تخصیص، ۰۲۶ مرز fleet↔asset، ۰۲۷ سررسید مشتق‌شده،
  ۰۲۸ مبدأ هزینه، ۰۲۹ دسترسی تعمیرگاه) + ۴ Open Question (Q-22 تا Q-25)
- **رفع D-005 و D-007** با تأیید زنده و CI (بخش ۲۲؛ جزئیات در `docs/23`)
- Git History تمیز: هر Commit اتمیک، Conventional Commits

---

## ۲۷. Not Yet Implemented

> **به‌روزرسانی 2026-09-07.** فهرست پیشین کهنه بود: `marketplace`، `document` و `supplier` از آن زمان Merge شده‌اند.
> **باقی‌ماندهٔ درست: `procurement` · `inventory` · `construction` · `contract` · `notification` · `audit` ·
> `analytics`**، و هر دو Frontend.
>
> این تصحیح برای برنامه‌ریزی ADR-053 لازم بود: مجموعهٔ سرویس‌هایی که **امروز رویداد منتشر می‌کنند** تعیین می‌کند
> Projector حسابرسی در روز نخست چه چیزی می‌تواند مصرف کند — **ده Topic دامنه‌ای و ۷۵ نام رویداد**، شمرده از ده مجموعهٔ
> `*_EVENTS` در کد.
>
> **پیشین (2026-08-29):** `economic-service` از این فهرست خارج شد.

- Frontend (`apps/web`, `apps/admin`) — پوشه خالی، هیچ خط کدی نیست
- ۷ سرویس Backend باقی‌مانده: `procurement`، `inventory`، `construction`،
  `contract`، `notification`، `audit`، `analytics`
- `notification-service` و `audit-service` — تصمیم معماری‌شان ثبت شد (ADR-054 و
  ADR-053، هر دو `Proposed`)؛ **هیچ کدی نوشته نشده**
- E2E **Browser** (Playwright هست و ۳۷ سناریو API اجرا می‌شود؛ Project ‏`web`
  وقتی `apps/web` ساخته شود اضافه می‌شود — `tests/e2e/playwright.config.ts`)
- `mission` و رویدادهای `MISSION_*` در fleet — عمداً موکول شد (ADR-026)
- Kubernetes manifests (`infrastructure/k8s/` خالی)
- Temporal Workflow واقعی (زیرساخت هست، هیچ Workflow نوشته نشده) — نخستین سرویسی
  که به یکی نیاز داشت `maintenance` بود و آگاهانه یک Scan محافظت‌شده جایش گذاشت
  (ADR-027)
- پورتال `WORKSHOP` و احراز صلاحیت تعمیرگاه (Q-25) — Port نام‌گذاری شده، بدون
  پیاده‌سازی
- Dockerfile برای `api-gateway`

---

## ۲۸. Current Roadmap

ترتیب واقعی طبق Domain Ownership (Asset باید قبل از Fleet/Maintenance
بیاید چون آن‌ها روی رویدادهای Asset تکیه می‌کنند):

```
✅ identity → ✅ organization → ✅ api-gateway → ✅ asset → ✅ fleet → ✅ maintenance
      ↓
   marketplace-service   ← NEXT / RECOMMENDED — شروع نشده (بخش ۲۹)
      ↓
   economic-service
      ↓
   construction-service → contract-service
      ↓
   procurement, supplier, inventory, notification, document, audit, analytics
      ↓
   Frontend (apps/web, apps/admin)
```

این ترتیب از `docs/17-mvp-scope.md` و توالی واقعی Git History استخراج شده؛
هیچ تغییری در تاریخ یا دامنه این Roadmap داده نشده.

**وضعیت هر گام (2026-08-28):**

| سرویس           | وضعیت                                                  |
| --------------- | ------------------------------------------------------ |
| identity        | IMPLEMENTED · TESTED · LIVE VERIFIED · CI VERIFIED     |
| organization    | IMPLEMENTED · TESTED · LIVE VERIFIED · CI VERIFIED     |
| api-gateway     | IMPLEMENTED · TESTED · LIVE VERIFIED (بدون Dockerfile) |
| asset           | IMPLEMENTED · TESTED · LIVE VERIFIED · CI VERIFIED     |
| fleet           | IMPLEMENTED · TESTED · LIVE VERIFIED · CI VERIFIED     |
| **maintenance** | **IMPLEMENTED · TESTED · LIVE VERIFIED · CI VERIFIED** |
| marketplace     | **NEXT / RECOMMENDED — NOT_STARTED**                   |
| ۹ سرویس دیگر    | NOT_STARTED                                            |
| Frontend        | NOT_STARTED — UI پشت دروازه تأیید صریح کاربر است       |

---

## ۲۹. Immediate Next Task

### به‌روزرسانی 2026-09-07 — گام بعدیِ توصیه‌شده

**۱. PR ثبت مشترک (`chore/`، بدون Story Point، باید اتمیک باشد).** هر دو سرویس را در `.github/workflows/ci.yml`،
`scripts/verify-outbox-claim-migration.mjs` و زنجیرهٔ `test:migration` ثبت می‌کند و دو پوشهٔ خالی سرویس با Dockerfile
می‌سازد. **در این Task ساخته نشد** و باید پیش از هر شاخهٔ Feature فرود بیاید، وگرنه دو شاخه در یک Script گیت‌کنندهٔ Build
تصادم می‌کنند.

**۲. `COM-009` (`audit-service`) نخست.** سه دلیل، همه از خود مخزن: S-06 امروز برآورده نمی‌شود و این آن را می‌بندد؛
حسابرسی هیچ وابستگی بیرونی ندارد؛ و حسابرسی وابستهٔ هیچ‌چیز نیست، پس ساختنش کار پایین‌دستی تحمیل نمی‌کند. برنامه در
[ADR-053 implementation plan](docs/adr/ADR-053-implementation-plan.md).

**۳. `COM-008` (`notification-service`) موازی، در شاخهٔ جدا.** پس از گام ثبت مشترک، دو دامنه هیچ جدول، Topic، گروه
مصرف‌کننده یا مفهوم مشترکی ندارند. برنامه در
[ADR-054 implementation plan](docs/adr/ADR-054-implementation-plan.md).

**پیش از پذیرش، دو پاسخ محصول لازم است:** Q-38 (بازنویسی اعلان الزامی) پیش از پذیرش داستان ترجیحات، و Q-37
(ارائه‌دهندهٔ ایمیل) پیش از هرگونه انتشار ایمیل واقعی.

---

### پیشین — فاز اقتصادی — **READY_FOR_NEXT_PHASE**

> **این بخش پیش‌تر `READY_FOR_NEXT_PHASE` می‌گفت در حالی که `tests/e2e` پوشه‌ای
> خالی بود و `AGENTS.md` § ۷ برای این دامنه E2E سبز می‌خواهد.** آن شکاف بسته
> شد (PR #4، `32a6453`، Run `33253629911`).
>
> **به‌روزرسانی 2026-08-29 (چهارم).** Q-28 هم روی `main` رفت: PR #5 با یک Merge
> Commit معمولی (`98dd7c0`) و CI کامل سبز روی `main` — هر ۱۰ Job شامل Trivy
> روی هر شش Image (Run `33259888563`). **`READY_FOR_NEXT_PHASE` پابرجاست.**
>
> Q-26 و Q-27 هم بسته شدند و روی `fix/economic-event-ordering` منتظر بازبینی
> صاحب محصول‌اند — **هنوز Merge نشده**.

**یافته‌ای که خودِ CI گرفت، نه اجرای محلی.** اجرای کامل Integration سبز بود و
اجرای دوم با `--testNamePattern` نبود: الگو «capped» را می‌گرفت و «accepts» را
نه، پس تستی که `ruleId` را می‌ساخت Filter می‌شد و تست بعدی روی `undefined`
می‌رفت. مرحله دوم دقیقاً برای همین وجود دارد، و `AGENTS.md` § ۵ همین را
ممنوع کرده: هیچ تستی نباید به ترتیب اجرا وابسته باشد.

| سطح           | شاهد                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------- |
| IMPLEMENTED   | Wallet · Hold · Ledger · Journal · Transaction · Payment · Commission · Reward · Settlement   |
| TESTED        | **۳۳۶** تست واحد در economic، **۷۷۸** در Monorepo                                             |
| INTEGRATION   | **۲۶۸** تست روی PostgreSQL و Kafka واقعی، **۲۱** Suite، بدون Mock                             |
| **E2E**       | **۴۷ سناریو** روی Gateway + economic + PostgreSQL + Kafka + Keycloak واقعی                    |
| **COVERAGE**  | Statements ۹۳٫۷۶٪ · **Branches ۹۰٫۲۸٪** · Functions ۹۱٫۸۸٪ · Lines ۹۵٫۸۱٪ — ۶۰۴ تست، ۳۸ Suite |
| **MIGRATION** | up → down → up روی Schema یک‌بارمصرف، با ادعا بین هر گام (`pnpm test:migration`)              |
| LIVE VERIFIED | ۲۶ سناریو پیشین (بخش ۲۱-ج) + ۴۷ سناریو E2E                                                    |
| CI VERIFIED   | ✅ روی `main`: Run `33259888563`، Commit `98dd7c0` — هر **۱۰** Job سبز، شامل Trivy شش Image   |

**هر سه یافته‌ای که این فاز پیدا کرد اکنون بسته‌اند.** D-017/Q-28 (تنانتِ
فراخوان سرویس‌به‌سرویس، ADR-035) روی `main` است. D-019/Q-26 (کلید پارتیشن
رویدادهای یک تراکنش، ADR-036) و D-018/Q-27 (دسترسی خواندنی دفتر کل — بسته با
سیاست موقت محصول، بدون تغییر کد) روی `fix/economic-event-ordering` منتظر
بازبینی‌اند.

هر دو پیش‌نیاز `marketplace-service` بودند و پیش از آن انجام شدند.
**`READY_FOR_MARKETPLACE` در 2026-08-30 اعلام شد**، پس از Merge شدن PR #6
(`4ebdfc0`) و سبز شدن کامل CI روی `main` (Run `33267994013`).

### `marketplace-service` — ساخته شد (2026-08-30) ✅

پورت ۳۱۰۶، پایگاه داده `rasta_marketplace`، Topic `rasta.marketplace.v1`، صف
Temporal ‏`rasta-order`.

| سطح           | شاهد                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------- |
| IMPLEMENTED   | Product · Offer · Order · OrderLine · Fulfillment · Dispute · Review · OrderStatusHistory     |
| ADR           | **هفت** ADR، همه پیش از کد: ADR-037 تا ADR-043                                                |
| TESTED        | **۱۰۹** تست واحد (شامل ۹ تست Workflow روی Temporal با ساعت زمان‌پرش)                          |
| INTEGRATION   | **۴۴** تست روی PostgreSQL واقعی — Overselling، Deadlock، Idempotency، جداسازی مستأجر          |
| **E2E**       | **۱۷ سناریو** روی Gateway + marketplace + economic + PostgreSQL + Kafka + Temporal + Keycloak |
| **MIGRATION** | up → down → up در ۱۲۲۲۱ms، با ادعا روی چهار `CHECK` مالی                                      |
| TEMPORAL      | نخستین مصرف واقعی پلتفرم. جبران پیش از تسویه؛ پس از آن **هرگز خودکار**                        |

**چهار نقصی که خودِ تست‌ها پیدا کردند** (هیچ‌کدام از تست واحد قابل دیدن نبود):

1. **خریدار می‌توانست از اعتراض خودش بیرون بیاید.** جدول گذار
   `DISPUTED → RECEIPT_CONFIRMED` را مجاز می‌داند چون اپراتور از آن استفاده
   می‌کند — و `ConfirmReceipt` خریدار همان یال را می‌رفت. حالا هر فرمان
   وضعیت‌های مبدأ خودش را اعلام می‌کند.
2. **اعتراض هرگز به `economic-service` نمی‌رسید.** ADR-040 § ۵ می‌گفت هر دو طرف
   باید بدانند؛ Activity اش نام‌برده شده بود و نوشته نشده بود. حالا هست، و
   بازتاب تصمیمِ حل اعتراض هم — بدون آن، اعتراضی که به نفع فروشنده حل شود هرگز
   تسویه نمی‌شد.
3. **مسیرهای گذار `201` برمی‌گرداندند** در حالی که بازپخش Idempotent شان `200`
   ثبت شده بود، پس Retry با کدی متفاوت پاسخ می‌گرفت.
4. **شناسه تسویه `settlement.id` خوانده می‌شد** و `economic-service`
   `settlementId` برمی‌گرداند — سفارشی `COMPLETED` بدون چیزی برای تطبیق، که
   `ck_order_completed_has_settlement` ردش کرد.

**سه شکاف نام‌دار و ادعانشده (ADR-041):**

| سرویس نبوده    | آنچه هست                               | آنچه **ادعا نمی‌شود**                       |
| -------------- | -------------------------------------- | ------------------------------------------- |
| `supplier`     | هویت از توکن تأییدشده                  | صلاحیت، مجوز، امتیاز، تعلیق — `UNAVAILABLE` |
| `inventory`    | `offer.availableQuantity` زیر قفل ردیف | هیچ رزروی در هیچ انباری                     |
| `notification` | رویدادهای دامنه‌ای واقعی منتشر می‌شوند | هیچ اعلانی تحویل داده نمی‌شود               |

### بستن شکاف Coverage بازارگاه (2026-08-30) ✅

سرویس ساخته شده بود و تست هم داشت، اما **هیچ‌کس هرگز اندازه نگرفته بود**:
نه `jest.config.js` این سرویس `coverageThreshold` داشت و نه هیچ Job ی در CI
با `--coverage` اجرا می‌شد. اولین اندازه‌گیری واقعی، عدد را نشان داد:

| سنجه       | پیش از این | پس از این  | آستانه `docs/14` § ۱۴٫۲ |
| ---------- | ---------- | ---------- | ----------------------- |
| Statements | ۵۴٫۱۶٪     | **۸۶٫۴۰٪** | ۷۵٪                     |
| **Branch** | **۴۰٫۰۵٪** | **۷۷٫۶۲٪** | **۷۵٪**                 |
| Functions  | ۵۱٫۵۶٪     | **۸۹٫۴۴٪** | ۷۵٪                     |
| Lines      | ۵۶٫۳۰٪     | **۸۸٫۱۶٪** | ۷۵٪                     |

۱۹۹ تست → **۳۶۵ تست**. هیچ فایل دامنه‌ای از سنجش کنار گذاشته نشد، هیچ آستانه‌ای
پایین نیامد، و رفتار محصول برای آسان‌شدن تست تغییر نکرد.

**دلیل واقعی شکاف:** هر دو Controller، همه نگاشت‌های View و خودِ Composition Root
روی صفر بودند. هیچ تست API ای وجود نداشت — مسیرهایی که خطای دامنه را به کد وضعیت
تبدیل می‌کنند (تفاوت ۴۰۴ و ۴۰۳ روی خواندن میان‌مستأجری) فقط در E2E دیده می‌شدند،
جایی که شکست، نام کل Stack را می‌برد نه نام آن خط را.

**سه نقص دیگر که همین تست‌ها پیدا کردند:**

1. **خریدار نمی‌توانست سفارشی را که هنوز Fund نشده لغو کند.** قید
   `ck_order_held_has_transaction` گذار `PENDING → CANCELLING` را رد می‌کرد و
   کاربر ۵۰۰ می‌گرفت. Migration جدید (`20260830103500_cancel_before_hold`) قید را
   گشاد کرد — و تست ثابت می‌کند قید هنوز پوچ نشده است.
2. **قرارداد OpenAPI هدر `Idempotency-Key` را اصلاً منتشر نمی‌کرد** و کران‌های
   آرایه را هم نه. کلاینتی که علیه این قرارداد Generate می‌کرد، هدر اجباری را
   نمی‌فرستاد.
3. **استثنای اپراتور پلتفرم در `assertOfferOwner` دست‌نیافتنی بود.** بررسی دسترسی
   عبور می‌داد و نوشتنِ بلافاصله پس از آن هنوز به سازمان خود Caller محدود بود،
   هیچ ردیفی نمی‌یافت و ۵۰۰ می‌شد.

**`temporal/workflows.ts` عمداً از سنجش کنار گذاشته نشد.** Temporal کد Workflow را
از یک Bundle وبپکی داخل یک Context ایزوله V8 اجرا می‌کند که Istanbul به آن نمی‌رسد،
پس ۳۱ Branch اش «پوشش‌نیافته» گزارش می‌شود هرچند `workflows.spec.ts` آن‌ها را روی
یک سرور واقعی Temporal با ساعت زمان‌پرش اجرا می‌کند. کنار گذاشتنش عدد را با پنهان
کردن یک محدودیت ابزار بالا می‌برد — و اگر روزی تست‌هایش حذف شوند، همان کنارگذاری
آن را هم پنهان می‌کند. آستانه **با ماندن این فایل در سنجش** برآورده شده است.

### گام بعدی پس از این

پورت ۳۱۰۶، پایگاه داده `rasta_marketplace`، Topic `rasta.marketplace.v1`.

**و این بار ابهامی که حافظه پیشین ثبت کرده بود وجود ندارد.** آن نوشته بود
«Marketplace بدون `economic-service` نیمه‌کاره است» و یک تصمیم انسانی
می‌خواست. `economic-service` اکنون هست، و همه‌چیزی که سفارش لازم دارد آماده
است:

| نیاز سفارش                     | چیزی که آماده است                                                        |
| ------------------------------ | ------------------------------------------------------------------------ |
| `ORDER_CREATED` باید Hold بزند | `POST /v1/transactions` با `holdFunds: true` — یک تراکنش، بدون پنجره باز |
| تأیید دریافت                   | `POST /v1/transactions/{id}/authorise-settlement`                        |
| تسویه + کارمزد                 | `POST /v1/settlements` — هر سه در یک Journal متوازن                      |
| لغو                            | `POST /v1/transactions/{id}/refund`                                      |
| اعتراض                         | `POST /v1/transactions/{id}/dispute` — توقف کامل، بدون حرکت خودکار       |
| پاداش                          | موتور قاعده‌محور، منتظر پیکربندی                                         |

همه با `@AllowService('marketplace-service')`، که همان چیزی است که `docs/08`
§ ۸٫۶ به‌شکل Activity می‌خواهد. **marketplace باید تصمیم بگیرد** چه چیزی
فراخوانی است و چه چیزی رویداد — ADR-032 عمداً پیش‌داوری نکرده.

**الگویی که در این فاز کار کرد و باید تکرار شود:**

1. **هر Invariant که می‌تواند یک محدودیت پایگاه داده باشد، باید باشد.**
   `ck_wallet_balances` است که خرج بیش از موجودی را غیرممکن می‌کند؛ بررسی کد
   فقط پیام خطا می‌سازد. همین برای توازن Journal، تغییرناپذیری، و یکتایی Hold.
2. **وقتی دو بند سند با هم نمی‌خوانند، ADR بنویس — حدس نزن.** تناقض بند ۱۰٫۳ و
   ۱۰٫۴ با یک انتخاب دلبخواهی هم «حل» می‌شد؛ ADR-034 توضیح می‌دهد کدام نیمه
   درست بود و چرا.
3. **تست همروندی واقعی، سه نقص گرفت که هیچ بازبینی‌ای نمی‌گرفت.**
4. **وضعیت مشتق‌شده را بازمحاسبه کن، افزایش نده.** افزایش تدریجی یک
   Read-Modify-Write است.
5. **شکاف را نام‌گذاری کن، Stub نساز.** مصرف‌کننده‌های موکول هیچ Handler خالی
   ندارند، چون یک Handler خالی در `processed_event` رد می‌گذارد و شبیه کارکرده
   به نظر می‌رسد.
6. **تأیید زنده، سه چیز پیدا کرد که تست‌ها نگرفتند** — یک Endpoint که Gateway
   ردش می‌کرد، ردیف‌های بازمانده از اجراهای شکست‌خورده، و یک پورت رزروشده
   ویندوز.

### کارهای مستقل و کوچک‌تر

| کار                                            | چرا                                          |
| ---------------------------------------------- | -------------------------------------------- |
| Dockerfile برای `api-gateway`                  | تنها سرویسی که ندارد                         |
| Dockerfile برای `api-gateway`                  | تنها سرویسی که ندارد                         |
| حذف `--passWithNoTests` از سه سرویس باقی‌مانده | Project Integration شان تهی است              |
| D-008 (Supply-Chain)                           | سه قاعده Semgrep که Lockfile رد می‌کند       |
| پاسخ Q-08 و Q-09                               | تصمیم کارگروه راهبری؛ یک `POST` و یک `PATCH` |

---

### پیشین — فاز نگهداری بسته شد

هر پنج سطح تأیید کامل است و هیچ نقص بازِ مسدودکننده‌ای در `maintenance-service`
نمانده:

| سطح           | شاهد                                                                        |
| ------------- | --------------------------------------------------------------------------- |
| IMPLEMENTED   | Schedule · Request · RepairOrder · PartUsage · LaborEntry · MaintenanceCost |
| TESTED        | ۱۰۲ تست واحد در maintenance، ۴۱۵ در Monorepo — `pnpm verify` سبز            |
| INTEGRATION   | ۴۱ تست روی PostgreSQL و Kafka واقعی، بدون Mock                              |
| LIVE VERIFIED | ۳۵ سناریو از راه Gateway با توکن واقعی Keycloak (بخش ۲۱-ب)                  |
| CI VERIFIED   | Run `33172549841`، Commit `24bef76`، هر ۸ Job سبز                           |

### گام بعدی: `marketplace-service`

پورت ۳۱۰۶، پایگاه داده `rasta_marketplace`، Topic `rasta.marketplace.v1`.

`asset-service` هم‌اکنون `ORDER_COMPLETED` را در جدول Projection خودش دارد و منتظر
تولیدکننده است — همان الگویی که نگهداری با `USAGE_RECORDED` دید. اما یک تفاوت مهم
با فاز نگهداری وجود دارد و باید پیش از شروع دیده شود:

> **Marketplace بدون `economic-service` نیمه‌کاره است.** `ORDER_CREATED` باید
> Hold بزند و `ORDER_RECEIPT_CONFIRMED` باید تسویه کند؛ هر دو مال `economic` اند.
> نگهداری توانست مرزش را تمیز نگه دارد چون فقط **یک** رویداد به economic می‌دهد و
> هیچ‌چیز از آن نمی‌گیرد. سفارش این‌طور نیست.

پس پیش از شروع، یک تصمیم انسانی لازم است: **`marketplace` اول یا `economic` اول؟**
هیچ‌کدام در این حافظه پیش‌فرض ندارد.

**الگویی که در این فاز کار کرد و باید تکرار شود:**

1. **درس‌های فاز قبل را از روز اول اعمال کن.** Suite Integration نگهداری هیچ باگ
   تولیدی نگرفت — نه چون ضعیف‌تر بود، بلکه چون هر پنج تله فاز ناوگان از ابتدا
   بسته بودند. حافظه پروژه وقتی ارزش دارد که **قبل** از نوشتن کد خوانده شود.
2. **تست همروندی واقعی بنویس.** ده نوشتن هم‌زمان روی یک ردیف، یک Lost Update
   می‌گیرد که هیچ تست تک‌نخی نمی‌تواند.
3. **وضعیت مشتق‌شده را ذخیره نکن** اگر شکستِ محاسبه‌اش «همه‌چیز سالم است» گزارش
   می‌کند.
4. **شکاف را نام‌گذاری کن، نه Stub.** یک Port با یک پیاده‌سازی صادق، از یک پرچم
   پیکربندی خاموش بهتر است — چون دومی کنترلی را ادعا می‌کند که ندارد.
5. **CI را واقعاً اجرا کن.** در فاز ناوگان، CI باگی گرفت که هیچ اجرای محلی
   نمی‌توانست.

### کارهای مستقل و کوچک‌تر

| کار                                                         | چرا                                     |
| ----------------------------------------------------------- | --------------------------------------- |
| Dockerfile برای `api-gateway`                               | تنها سرویسی که ندارد؛ در CI Matrix نیست |
| حذف `--passWithNoTests` از چهار سرویس دیگر                  | Project Integration شان تهی است         |
| D-008 (Supply-Chain)                                        | سه قاعده Semgrep که Lockfile رد می‌کند  |
| D-006 (تصادم پورت Redis روی این ماشین)                      | فقط محیط توسعه                          |
| D-011 (رویداد نداشتن تغییر برنامه سرویس)                    | هنگام ساخت `audit-service` باید حل شود  |
| `InsuranceClaim` بدون API در `asset-service`                | جدول هست، Controller نیست               |
| Q-24 / Q-25 — تصمیم انسانی درباره دسترسی اپراتور و تعمیرگاه | هر دو مسدودکننده پورتال تعمیرگاه‌اند    |

**هیچ‌کدام از این‌ها را خودکار شروع نکن.**

---

## ۳۰. Rules for Future AI Agents

**قواعد عمومی (تخطی‌ناپذیر):**

- هرگز مرز سرویس را دور نزن — بدون Import میان‌سرویسی، بدون Join
  میان‌پایگاه‌داده، فقط REST یا Event.
- هرگز مستقیم به پایگاه داده سرویس دیگر متصل نشو.
- هرگز Tenant Isolation را دور نزن؛ خروج از Scope فقط با `runUnscoped` +
  دلیل نوشته‌شده.
- هرگز نیاز کسب‌وکاری یا واقعیت مقرراتی اختراع نکن؛ ابهام → `docs/24-open-questions.md`.
- هرگز قابلیت تأییدنشده را «پیاده‌شده» اعلام نکن — سه سطح Implemented/
  Tested/Live Verified را جدا نگه دار (بخش ۳).
- از `AGENTS.md` (قواعد الزام‌آور) و ADR ها (`docs/adr/`) پیروی کن.
- بعد از هر تغییر معماری مهم، این فایل را به‌روزرسانی کن (بخش «Memory
  Update Protocol» زیر).
- پیش از اعلام «انجام شد»، تست کن؛ برای رفتار میان‌سرویسی، Live Verification
  زنده انجام بده — یک ادعای «قبلاً تست شد» بدون Evidence تازه در Repository،
  کافی نیست.
- بدون تأیید صریح کاربر، UI پیاده نکن.
- **پیش از شروع هر کار غیرپیش‌پاافتاده، این فایل (`PROJECT_MEMORY.md`) و
  سند معماری مرتبط را بخوان.**

**قواعد خاص این Repository (از کد و تجربه واقعی استخراج شده):**

- سرویس‌ها باید قبل از `prisma generate` روی ویندوز متوقف شوند (قفل DLL — D-002).
- برای اجرای محلی یک سرویس: `node -r @swc-node/register --env-file=../../.env src/main.ts`
  از پوشه همان سرویس (نه `tsx`/esbuild — `design:paramtypes` را از دست
  می‌دهد و DI را بی‌صدا می‌شکند).
- `pnpm db:migrate` اکنون (پس از D-004) از یک Shell تمیز کار می‌کند —
  `scripts/prisma.mjs` خودش `DATABASE_URL_<SERVICE>` درست را پیدا می‌کند.
- هرگز نتیجه تست Redis محلی روی این ماشین را بدون تأیید `docker exec
rasta-redis redis-cli` (نه `localhost:6379` از میزبان) قطعی نگیر — D-006.
- پیش از هر ادعا درباره CI، `gh run list` را واقعاً اجرا کن — فرض «CI سبز
  است» چون فایل Workflow وجود دارد، اشتباه اثبات‌شده در این Repository است (D-005).
- **یک دروازه سبز لزوماً یعنی دروازه کار کرد، نه اینکه چیزی را بررسی کرد.**
  در همین Repository، Semgrep ماه‌ها `0` برمی‌گرداند بی‌آنکه یک فایل را
  Scan کند، و مرحله «Integration tests» امروز هم با صفر تست سبز می‌شود.
  پیش از اتکا به یک دروازه، Log خروجی‌اش را بخوان و ببین واقعاً چند چیز را
  دید (D-005).
- Healthcheck داکر را به‌عنوان حقیقتِ سلامت نخوان — در هر دو جهت. `rasta-temporal`
  ماه‌ها `unhealthy` بود و Server سالم بود؛ ریشه در محیط Docker میزبان بود، نه
  در Image (D-009/D-010). سبز بودن Healthcheck هم اثبات سلامت نیست: Broker
  کافکا به `--list` پاسخ می‌دهد در حالی که Group Coordinator هنوز بالا نیامده.

**قواعد افزوده در Task ناوگان (2026-08-28):**

- **Prisma نام Index را در خطای یکتایی گزارش نمی‌کند** — نام **ستون** را در
  `meta.target` می‌گذارد. هر کدی که نقض Constraint را به خطای کسب‌وکاری ترجمه
  می‌کند باید روی ستون تطبیق دهد، نه نام Index. این باگ در `fleet` بی‌صدا زنده
  بود تا نخستین تست Integration واقعی.
- **هرگز Default پایگاه داده و مقدار برنامه را در یک CHECK مقایسه نکن.**
  PostgreSQL در WSL2 روی این ماشین ۱۴–۵۶ میلی‌ثانیه از میزبان جلوتر است. اگر
  یک ستون `@default(now())` دارد و ستون دیگری از `new Date()` می‌آید و
  Constraint آن دو را مقایسه می‌کند، ردیف Constraint خودش را نقض می‌کند.
- **تست Integration را از روز اول بنویس، نه بعداً.** در `fleet` پنج باگ گرفت
  که هیچ‌کدام با تست واحد پیدا نمی‌شد — سه‌تا در کد تولیدی. تست واحد نمی‌تواند
  شکل خطای Prisma، انحراف ساعت، یا رفتار Tenant Guard را بسنجد؛ فقط پایگاه
  داده واقعی می‌تواند.
- **Docker Desktop خراب را Restart نکن اگر کانتینرها هنوز کار می‌کنند.**
  در این Task، Engine API از ابتدا خطای ۵۰۰ می‌داد ولی Runtime سالم بود و
  Migration و تست اجرا می‌شد. Restart، Stack کارکن را کشت و Engine هم
  برنگشت (D-010). اول بررسی کن پورت‌ها پاسخ می‌دهند یا نه؛ اگر می‌دهند، با
  همان کار کن. اگر ناچار شدی: ریشه معمولاً Socket های یتیم در
  `%LOCALAPPDATA%\Docker
un\` است — تغییر نام آن پوشه رفعش می‌کند.
- **PUT روی کاربر Keycloak، نمایش کامل را جایگزین می‌کند.** فرستادن فقط
  `{"attributes": …}` فیلدهای `email`/`firstName`/`lastName` را پاک کرد و کاربر
  با «Account is not fully set up» از کار افتاد. همیشه نمایش کامل را بفرست —
  `infrastructure/docker/keycloak/rasta-realm.json` منبع درست آن است.
- **Prisma نمی‌تواند Partial Index یا CHECK را بیان کند.** هر دو در SQL
  دست‌نویس انتهای Migration زندگی می‌کنند. اگر `prisma migrate dev` پیشنهاد
  `DROP` روی `ux_assignment_*` یا `ck_*` داد، **آن Hunk را رد کن** — Drift
  واقعی نیست، Prisma فقط نمی‌بیندشان.
- **تله Prisma Promise تنبل دوباره ظاهر می‌شود.** D-003 آن را در
  `runUnscoped` رفع کرد، ولی همان اشتباه در `test/helpers.ts` تازه تکرار شد:
  اگر Callback را non-async بنویسی، Query **بعد از** بسته شدن Context اجرا
  می‌شود. هر تابعی که یک Callback را داخل `AsyncLocalStorage` اجرا می‌کند،
  باید `async () => fn()` بنویسد نه `fn`.
- **رویدادی که یک Projector مصرف می‌کند، باید کلید Aggregate مقصد را حمل کند.**
  `timelineSourceSchema` در `asset-service` هر رویداد بدون `assetId` را بی‌صدا
  Skip می‌کند. ستون «Payload کلیدی» در کاتالوگ **خلاصه است، نه کامل** — پیش از
  اتکا به آن، Consumer واقعی را بخوان.
- **`--passWithNoTests` را به Suite Integration برنگردان.** در `fleet-service`
  عمداً حذف شده تا حذف آخرین تست، Build را بشکند. اگر `pnpm verify` روی ماشین
  بدون Docker شکست، راه‌حل این است که `test` فقط Project `unit` را اجرا کند —
  نه اینکه Flag برگردد.
- **مالکیت وضعیت را تقسیم کن و نامش را ببر.** «در دسترس بودن» از واقعیت چهار
  سرویس ساخته می‌شود؛ هیچ‌کدام را کپی نکن، و در پاسخ API مالک هر مانع را
  صریح بگو (ADR-026).

**قواعد افزوده در Task نگهداری (2026-08-28):**

- **حافظه پروژه را پیش از نوشتن کد بخوان، نه بعدش.** Suite Integration نگهداری
  هیچ باگ تولیدی نگرفت — نه چون ضعیف‌تر بود، بلکه چون هر پنج تله فاز ناوگان از روز
  اول بسته بودند. این تنها موردی است که «صفر باگ» یک شاهد مثبت است.
- **وضعیت مشتق‌شده را ذخیره نکن اگر شکستِ محاسبه‌اش «همه‌چیز سالم است» می‌گوید.**
  یک ستون `due` که Job شبانه پرش می‌کند، وقتی Job اجرا نشود هر دستگاه
  سررسیدگذشته را «سالم» گزارش می‌کند و هیچ‌چیز غلط به نظر نمی‌رسد. سامانه‌ای که
  سکوتش از خبر خوب قابل تشخیص نیست، از نبودش بدتر است.
- **مجموع را از اجزایش بازمحاسبه کن، هرگز افزایش نده.** افزایش یک
  Read-Modify-Write است. ده ثبت هزینه هم‌زمان روی یک دستور تعمیر، پیاده‌سازی
  افزایشی را قابل‌اعتماد می‌شکند — و **هیچ تست تک‌نخی این را نمی‌گیرد**. قفل ردیف
  والد پیش از جمع زدن، کل راه‌حل است.
- **تست همروندی واقعی بنویس، نه فقط تست ترتیبی.** `Promise.allSettled` روی ده
  فراخوان، ارزان‌ترین تستی است که یک Lost Update را می‌گیرد.
- **شکاف را نام‌گذاری کن، Stub نکن.** یک پرچم پیکربندی خاموش با شاخه‌ای که هرگز
  اجرا نمی‌شود، کنترلی را ادعا می‌کند که وجود ندارد. یک Port با یک پیاده‌سازی صادق
  (`WorkshopDirectory`) هم `grep` می‌شود و هم Log می‌دهد. و حکمش دو فیلد جدا دارد:
  `permitted` و `verified` — «مجاز چون واجد شرایط است» و «مجاز چون کسی نمی‌تواند
  تشخیص دهد» دو واقعیت متفاوت‌اند.
- **مجوزدهی را به‌صورت باریک‌سازی بنویس، نه گشاده‌سازی.** «اگر Supervisor است اجازه
  بده» یعنی نقشی که فردا به Keycloak اضافه می‌شود، به دسترسی کامل می‌افتد. جهت
  درست: همه باریک‌اند مگر آنکه صریحاً Supervisor باشند.
- **وقتی یک قاعده مستند قابل اجرا نیست، باریک‌ترش کن و ثبتش کن — تقریبش نزن.** و
  جهت باریک‌سازی را از روی **حالت شکست** انتخاب کن: رد کردن یک گزارش خرابی به‌خاطر
  Replica کهنه، بدتر از مزاحمتی است که قاعده جلویش را می‌گیرد.
- **رویداد تازه فراتر از کاتالوگ فقط برای درست نگه داشتن ادعایی که قبلاً منتشر
  شده.** `MAINTENANCE_CANCELLED` افزوده شد چون `MAINTENANCE_CREATED` قبلاً گفته بود
  کاری وجود دارد. `MAINTENANCE_SCHEDULE_CREATED` افزوده **نشد** چون هیچ ادعایی
  برای اصلاح نبود — و همان شکاف به‌عنوان D-011 ثبت شد، نه پنهان.
- **پیش از طراحی Payload، مصرف‌کننده موجود را بخوان.** `TimelineConsumer` در
  `asset-service` هزینه را از یک فیلد **مسطح** `totalCostMinor` می‌خواند و هر شکل
  دیگری را `null` می‌گیرد؛ شکل تودرتوی کاتالوگ، هزینه هر تعمیر را صفر ثبت می‌کرد.
  ستون «Payload کلیدی» کاتالوگ خلاصه است، نه قرارداد.
- **Heredoc طولانی در این محیط قابل اعتماد نیست.** نوشتن فایل‌های بزرگ با
  `cat <<'EOF'` گاهی نیمه‌کاره قطع می‌شود و Backslash ها را می‌خورد
  (یک Backslash دوتایی به یکی تبدیل می‌شود، و یکی در Template Literal اصلاً
  Backslash نیست — یعنی الگویی که هیچ‌چیز را Match نمی‌کند و هیچ خطایی هم نمی‌دهد).
  فایل‌های بزرگ را با ابزار نوشتن فایل بنویس، نه با Heredoc.
- **`docker exec` در Git Bash روی ویندوز مسیرها را تبدیل می‌کند.**
  `docker exec x /opt/kafka/bin/…` به `C:/Program Files/Git/opt/…` تبدیل می‌شود.
  `MSYS_NO_PATHCONV=1` جلویش را می‌گیرد.

---

## Memory Update Protocol

این فایل باید با هرکدام از این تغییرات به‌روز شود:

- افزودن یا حذف یک Service
- افزودن یک Event جدید (Producer یا Consumer)
- تغییر در Domain Ownership یا مرز Database
- تغییر در مدل Security/Authentication/Authorization
- تغییر در Database Ownership یا Schema اصلی یک سرویس
- افزودن/تغییر یک Integration بین سرویس‌ها
- کشف یا رفع یک Known Issue بحرانی

به‌روزرسانی یعنی: بخش مربوطه در همین فایل ویرایش شود (نه فقط یک خط اضافه
در انتها)، و جدول بخش ۳ (Current Verified State) با شواهد تازه هم‌راستا
بماند.

---

_آخرین Audit کامل: 2026-08-27. آخرین به‌روزرسانی: 2026-08-30 (Baseline سنجش پیشرفت).
برای جزئیات هر یافته، به `docs/23-risks-and-tradeoffs.md` بخش ۲۳٫۵-الف مراجعه کنید._
