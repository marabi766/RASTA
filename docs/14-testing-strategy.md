# ۱۴ — Testing Strategy

> تست شرط Done است، نه فعالیت جداگانه پس از توسعه.
> هیچ Feature‌ای بدون تست‌های الزامی‌اش Merge نمی‌شود.

---

## ۱۴٫۱ هرم تست

```
                  ╱╲
                 ╱E2E╲          ~۲۰ سناریو — فقط مسیرهای بحرانی
                ╱──────╲
               ╱ API/   ╲       ~۲۰۰ — هر Endpoint، شامل مسیرهای خطا
              ╱Component ╲
             ╱────────────╲
            ╱ Integration  ╲    ~۳۰۰ — Repository، Consumer، Workflow
           ╱────────────────╲
          ╱      Unit        ╲  ~۱٬۰۰۰+ — Domain Service، محاسبات، Guard
         ╱────────────────────╲
        ╱  Contract + Security ╲ عرضی — روی همه لایه‌ها
       ╱────────────────────────╲
```

| لایه            | ابزار                        | سرعت  | نیاز به زیرساخت |
| --------------- | ---------------------------- | ----- | --------------- |
| Unit            | Jest + @swc/jest             | ms    | ❌              |
| Integration     | Jest + Testcontainers        | ثانیه | ✅ (خودکار)     |
| Contract        | Zod + OpenAPI Validator      | ms    | ❌              |
| API / Component | Jest + Supertest             | ثانیه | ✅              |
| E2E             | Playwright                   | دقیقه | ✅ (کل Stack)   |
| Load            | k6                           | دقیقه | ✅              |
| Security        | Jest + Semgrep + Trivy + ZAP | متغیر | جزئی            |

---

## ۱۴٫۲ تست واحد

**چه چیزی تست می‌شود:** منطق دامنه، محاسبات، گذارهای وضعیت، Guardها، Mapperها.
**چه چیزی نه:** فریم‌ورک، ORM، کتابخانه شخص ثالث.

```typescript
describe('applyBasisPoints', () => {
  it('محاسبه دقیق کارمزد ۲٫۵٪ بدون خطای اعشار', () => {
    expect(applyBasisPoints(money(10_000_000n), 250)).toEqual(money(250_000n));
  });

  it('گرد کردن نیم به بالا، به‌صورت قطعی', () => {
    expect(applyBasisPoints(money(101n), 250)).toEqual(money(3n)); // 2.525 → 3
  });

  it('رد کردن Basis Point منفی', () => {
    expect(() => applyBasisPoints(money(100n), -1)).toThrow(RangeError);
  });
});
```

**قواعد:** هر تست مستقل · بدون وابستگی به ترتیب اجرا · بدون I/O واقعی ·
نام تست جمله‌ای است که رفتار را توصیف می‌کند، نه نام متد.

**آستانه پوشش:**

| بخش                                  | حداقل پوشش شاخه |
| ------------------------------------ | --------------- |
| `economic-service` (منطق مالی)       | **۹۰٪**         |
| `identity-service` (مجوزدهی)         | **۹۰٪**         |
| `construction-service` (گذار مناقصه) | **۸۵٪**         |
| بقیه سرویس‌ها                        | ۷۵٪             |
| `packages/*`                         | ۸۵٪             |

پوشش هدف است، نه معیار موفقیت. ۱۰۰٪ پوشش با Assertهای بی‌معنا بدتر از ۷۰٪ معنادار است.

### ۱۴٫۲٫۱ تست اسکنر بدافزار — ADR-049

سه لایه، و هر کدام چیزی را اثبات می‌کند که دیگری نمی‌تواند.

**واحد — پروتکل روی رشته.** جایی که یک اسکنر رأی را اشتباه می‌گیرد، و هیچ‌یک از
حالت‌های جالبش را نمی‌توان از یک clamd سالم درخواست کرد: پاسخ ناقص، پاسخ نسخهٔ آینده،
امضایی که نامش `Doc.Dropper.OK-Agent` است، خطای موتوری که نام فایل را ذکر می‌کند.
`protocol.spec.ts` جدولی از ۹ پاسخ نامعتبر دارد و اثبات می‌کند **هیچ‌کدام `CLEAN`
نمی‌شوند**.

**واحد — انتقال روی Socket واقعی.** `clamav.scanner.spec.ts` یک Server TCP واقعی بالا
می‌آورد که هر پاسخی را که تست بخواهد می‌دهد. Socket شبیه‌سازی‌شده هیچ‌یک از این‌ها را
ندارد: اتصال ردشده، همتایی که می‌پذیرد و هرگز جواب نمی‌دهد، پاسخی که در دو بسته می‌رسد،
Stream ای که سقف اندازه قطعش می‌کند.

**یکپارچگی — موتور واقعی.** `test/clamav-scan.int-spec.ts` روی **ClamAV واقعی،
PostgreSQL واقعی و MinIO واقعی**. هیچ‌چیز روی مسیر امنیتی جایگزین نشده: بایت‌ها با URL
امضاشده به MinIO می‌روند همان‌طور که مرورگر می‌فرستد، Worker آن‌ها را از Storage
Stream می‌کند و از INSTREAM عبور می‌دهد، و رأی زیر CHECK Constraint های Migration نوشته
می‌شود. Suite ای که پاسخ `FOUND` جعلی تزریق کند، Mock را اثبات می‌کند.

**EICAR — و چرا شکل دارد.** آرتیفکت استاندارد و بی‌ضرر EICAR، اما **داخل یک DOCX**.
تلاش نخست آن را در بدنهٔ یک PDF جاسازی کرد و ClamAV به‌درستی `OK` گفت: امضای
`Eicar-Test-Signature` فایل را **به‌عنوان یک کل** تطبیق می‌دهد، پس PDF ای که صرفاً آن ۶۸
بایت را در خود دارد EICAR نیست. DOCX یک ZIP است، ClamAV آرشیو را باز می‌کند، و عضوی که
محتوایش دقیقاً EICAR است دقیقاً EICAR است — که شکل صادقانه‌تر تهدید هم هست.

**ایمنی EICAR:**

- بایت‌ها در **حافظه** از دو قطعهٔ base64 ساخته می‌شوند و **هرگز روی فایل‌سیستم میزبان
  نوشته نمی‌شوند**. روی یک ماشین ویندوزی این یعنی ندادن فایلی به Defender که موظف است
  قرنطینه‌اش کند.
- در Repository به‌صورت قابل‌اسکن Commit نمی‌شود: کل هدف آن رشته این است که اسکنرها
  تطبیقش دهند، پس نسخهٔ ساده در مخزن یعنی مخزنی که آنتی‌ویروس دسکتاپ هنگام Clone
  قرنطینه‌اش می‌کند.
- اسکن واقعی درون Container لینوکسی ClamAV رخ می‌دهد.
- شیء در پایان Suite از Bucket حذف می‌شود.

**پوشش `document-service`:** بند ۷۵٪ جدول بالا، بدون تغییر. هیچ فایل دامنه‌ای از
اندازه‌گیری کنار گذاشته نشده و `collectCoverageFrom` همچنان در ریشهٔ بسته لنگر دارد.

---

## ۱۴٫۳ تست یکپارچگی

با **Testcontainers** — PostgreSQL، Redis و Kafka واقعی در Container، نه Mock.

**وضعیت واقعی (2026-08-28).** دو سرویس تست Integration واقعی دارند:

| سرویس                 | Suite | تست | چه چیزی را ثابت می‌کند                                                                                                                          |
| --------------------- | ----- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `fleet-service`       | ۴     | ۳۲  | Tenant Isolation · انحصار تخصیص زیر مسابقه واقعی · Outbox · مسیر رویداد تا کافکا و بازگشت                                                       |
| `maintenance-service` | ۵     | ۴۱  | Tenant Isolation و باریک‌سازی سطح Object · کنترل منع درخواست تکراری · **اتمیک بودن هزینه زیر ده نوشتن هم‌زمان** · Outbox · دو مسیر رویداد واقعی |

روی PostgreSQL و Kafka **واقعی**، بدون Mock. Testcontainers استفاده **نشد**؛
به‌جایش زیرساخت موجود (`pnpm infra:up` محلی، Service Container ها در CI) به‌کار
رفت — همان نتیجه بدون Docker-in-Docker.

**چرا اینها با تست واحد جایگزین نمی‌شوند.** هر کدام یک واقعیت را می‌سنجند که فقط
پایگاه داده واقعی تولیدش می‌کند: شکل خطای `P2002` در Prisma (که **نام ستون**
می‌دهد، نه نام Index)، انحراف ساعت میان میزبان و PostgreSQL، رفتار Tenant Guard
روی Query تنبل، و — تازه‌ترین — **Lost Update**. تست همروندی هزینه در نگهداری، ده
ثبت قطعه هم‌زمان می‌زند و مجموع را با `SUM` خود پایگاه داده تطبیق می‌دهد؛
پیاده‌سازی‌ای که مجموع را افزایش می‌دهد به‌جای بازمحاسبه، اینجا کم می‌آورد و در تست
تک‌نخی هرگز کم نمی‌آورد.

دو قاعده که از فاز ناوگان درآمد و در نگهداری هم رعایت شد:

- **`--passWithNoTests` روی Project Integration ممنوع.** حذف آخرین تست باید
  Build را بشکند. چهار سرویس دیگر (`identity`، `organization`، `asset`،
  `api-gateway`) هنوز این Flag را دارند و Project شان تهی است.
- **`test` فقط Project Unit را اجرا کند**، تا `pnpm verify` روی ماشین بدون
  Docker قابل اجرا بماند. Suite Integration یک دروازه جداست که CI صریحاً در
  برابر سرویس‌های Provision‌شده اجرا می‌کند.

```typescript
describe('AssetRepository (integration)', () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgis/postgis:16-3.4').start();
    await runMigrations(container.getConnectionUri());
  }, 60_000);

  afterAll(() => container.stop());

  it('همه Queryها را به سازمان جاری محدود می‌کند', async () => {
    await repo.create(assetFor('ORG_A'));
    const result = await repo.findAll({ organizationId: 'ORG_B' });
    expect(result.items).toHaveLength(0);
  });
});
```

**چرا Testcontainers و نه SQLite/Mock؟** چون رفتارهایی که واقعاً باگ می‌سازند — Trigger
تغییرناپذیری، `FOR UPDATE`، Unique Index جزئی، رفتار PostGIS — فقط در PostgreSQL واقعی
ظاهر می‌شوند. Mock کردن پایگاه داده یعنی تست کردن Mock، نه کد.

**پوشش الزامی:** هر Repository (شامل Scope مستأجر) · هر Consumer رویداد (شامل Idempotency)
· هر Activity ی Temporal · هر Migration (اجرا و بازگشت) · Outbox Relay.

### ۱۴٫۳٫۱ پروتکل Claim بادوام Outbox — ADR-050

`services/document-service/test/outbox-durable-claim.int-spec.ts` — بیست‌وچهار
آزمون الزامی ADR-050 روی PostgreSQL واقعی، به‌علاوهٔ پنج آزمون **هم‌ارزی** برای
بازنویسی شرط واجد شرایط بودن به چهار جریان، شش آزمون **Contention** با قفل
واقعی، و سه آزمون دیگر (CHECK ها، ردیف منتشرشده، ساعت پایگاه داده).

**چرا Mock جواب نمی‌دهد.** Fence همان `claim_token = $token` **درون** جملهٔ
`UPDATE` است، Backoff همان `now()` **درون** `SET` است، و مقایسهٔ انقضا مال خود
PostgreSQL است. هر سهٔ این‌ها در SQL زندگی می‌کنند، پس آزمون در برابر یک Fake
فقط خودِ Fake را اثبات می‌کند.

**همه قطعی — بدون Sleep و بدون رقابت با ساعت دیوار.** انقضا با
`leaseSeconds = 0` یا با بردن `claim_expires_at` به گذشته ساخته می‌شود؛ انتشار
طولانی با Publisher ای که تا آزادسازی صریح برنمی‌گردد.

**Schema اختصاصی، نه `public`.** `claimPending` عمداً بدون Scope مستأجر است و
**قدیمی‌ترین** ردیف‌های جدول را برمی‌گرداند. روی Schema مشترک، «دو مدعی Batch
مجزا می‌گیرند» یا «دقیقاً `limit` ردیف برمی‌گردد» ادعایی دربارهٔ باقی‌ماندهٔ
Suiteهای دیگر می‌شد، نه دربارهٔ پروتکل — دقیقاً همان وابستگی‌ای که
[`AGENTS.md § 5`](../AGENTS.md) ممنوع می‌کند. جدول با
`LIKE public.outbox_message INCLUDING ALL` ساخته می‌شود تا همان Index ها و
CHECK هایی را داشته باشد که Migration واقعاً ساخت.

**آزمون‌های Contention با قفل واقعی، نه با Sleep.** یک اتصال دوم دقیقاً همان
قفل‌هایی را می‌گیرد که سناریو می‌خواهد و تا پایان آزمون نگه می‌دارد. این‌ها
خاصیتی را می‌سنجند که آزمون ترتیبی نمی‌تواند: وقتی پیشوندی قفل است، آیا
`SKIP LOCKED` واقعاً از رویش رد می‌شود و Batch را پر می‌کند؟ پیش از اصلاح،
با ۳۰۰ ردیف واجد شرایط و صد ردیف قفل، `claimPending(100)` **صفر** برمی‌گرداند.

**آزمون ۱۵ چیزی را ادعا می‌کند که ADR تضمین می‌کند**، نه بیشتر: مجموعهٔ
شناسه‌های یکتای رسیده به Broker برابر مجموعهٔ ورودی است و **صفر** گم‌شده — در حالی
که تعداد کل تلاش‌ها می‌تواند از N بیشتر باشد. «دقیقاً N منتشر شد» با تضمین
At-Least-Once خودِ ADR در تناقض بود.

**بازگشت‌پذیری Migration:** `node scripts/verify-outbox-claim-migration.mjs --in-place`
روی هر هشت پایگاه داده، بخشی از `pnpm test:migration`.

**نکته 2026-09-12 — `test:migration` سه شکل Verifier دارد، و هر Migration تازه باید
در یکی‌شان ثبت شود.** (۱) `verify-migration-reversible.mjs <svc>` کل زنجیرهٔ یک سرویس
را برمی‌گرداند و برای **هر** Migration آن سرویس یک `down.sql` می‌خواهد — پس سرویسی که
Migration نخستش `down.sql` ندارد (مثل `identity`) از این راه پوشش نمی‌گیرد.
(۲) `verify-outbox-claim-migration.mjs` سرویس‌ها را با Convention کشف می‌کند
(`model OutboxMessage`) و Migrationها را نام‌به‌نام می‌شناسد. (۳) Verifier مستقل برای
یک Migration معیّن: `verify-security-event-outbox-migration.mjs` و
`verify-audit-correction-command-migration.mjs`. **هیچ‌یک از این سه، Migrationی را که
در آن ثبت نشده کشف نمی‌کند** — و Migrationی که هیچ Harness اجرایش نمی‌کند، `down.sql`اش
یک فایل است، نه یک Rollback. برای شکل ۱، افزودن اشیاء تازه به نگاشت `EXPECTED` هم لازم
است؛ Migrationی که فقط یک Index می‌سازد و نامش در آن نگاشت نیست، **به‌کلی** نامرئی است.

---

## ۱۴٫۴ تست قرارداد

### قرارداد رویداد

هر رویداد منتشرشده در برابر Schema اعتبارسنجی می‌شود — هم در تست، هم در **زمان اجرا**.

```typescript
describe('ORDER_COMPLETED contract', () => {
  it('Payload تولیدشده با Schema منتشرشده مطابقت دارد', () => {
    const event = buildOrderCompletedEvent(sampleOrder);
    expect(() => orderCompletedSchema.parse(event.payload)).not.toThrow();
  });

  it('همه مصرف‌کننده‌های ثبت‌شده Payload را می‌پذیرند', () => {
    for (const consumer of CONSUMERS_OF.ORDER_COMPLETED) {
      expect(() => consumer.inputSchema.parse(event.payload)).not.toThrow();
    }
  });
});
```

### قرارداد API

- OpenAPI تولیدشده در `docs/api/*.openapi.json` **Commit** می‌شود.
- CI بررسی می‌کند فایل Commit‌شده با کد همگام است — انحراف = شکست Build.
- تغییر شکننده در Schema بدون افزایش نسخه = شکست Build.

**چرا این مهم است؟** بدون آن، یک تغییر بی‌خطر در DTO می‌تواند Frontend یا یک سرویس مصرف‌کننده
را در Production بشکند، و کسی تا لحظه وقوع نمی‌فهمد.

---

## ۱۴٫۵ تست API

با Supertest روی اپلیکیشن کامل Nest.

```typescript
describe('POST /v1/orders', () => {
  it('سفارش را با Idempotency-Key معتبر ایجاد می‌کند', async () => {
    const res = await request(app.getHttpServer())
      .post('/v1/orders')
      .set('Authorization', `Bearer ${buyerToken}`)
      .set('Idempotency-Key', ulid())
      .send(validOrder)
      .expect(201);
    expect(res.body.status).toBe('PENDING');
  });

  it('کلید تکراری با بدنه متفاوت را رد می‌کند', async () => {
    const key = ulid();
    await post('/v1/orders', validOrder, key).expect(201);
    await post('/v1/orders', differentOrder, key).expect(409);
  });

  it('بدون احراز هویت ۴۰۱ می‌دهد', async () => {
    await request(app.getHttpServer()).post('/v1/orders').send(validOrder).expect(401);
  });
});
```

**پوشش الزامی به‌ازای هر Endpoint:** مسیر موفق · ورودی نامعتبر (۴۰۰) · بدون توکن (۴۰۱) ·
نقش ناکافی (۴۰۳) · **منبع مستأجر دیگر (۴۰۴)** · تخلف قاعده کسب‌وکار (۴۲۲) ·
Idempotency (اگر کاربرد دارد).

---

## ۱۴٫۶ تست‌های امنیتی — اجباری

### Tenant Isolation (به‌ازای هر سرویس دارای داده مستأجر)

```typescript
describe('Tenant isolation — asset-service', () => {
  it.each([
    ['GET', (id) => `/v1/assets/${id}`],
    ['PATCH', (id) => `/v1/assets/${id}`],
    ['DELETE', (id) => `/v1/assets/${id}`],
    ['GET', (id) => `/v1/assets/${id}/dossier`],
  ])('%s روی منبع مستأجر دیگر ۴۰۴ می‌دهد', async (method, path) => {
    const asset = await createAssetAs(tenantA);
    await request(app)[method.toLowerCase()](path(asset.id)).set('Authorization', `Bearer ${tenantBToken}`).expect(404); // ۴۰۴ نه ۴۰۳ — وجود منبع نباید لو برود
  });

  it('فهرست هرگز داده مستأجر دیگر را برنمی‌گرداند', async () => {
    await createAssetAs(tenantA);
    const res = await get('/v1/assets').as(tenantB).expect(200);
    expect(res.body.items).toHaveLength(0);
  });
});
```

### دسترسی Endpoint عمومی (اجباری برای هر `@Public()`)

هر Endpoint ای که `@Public()` می‌گیرد باید ثابت کند که یک در است، نه یک
سوراخ. این مجموعه پس از D-007 اجباری شد و در
`packages/nest-common/src/guards/auth.guard.access.spec.ts` زندگی می‌کند:

| باید                                                                     | چون                                                |
| ------------------------------------------------------------------------ | -------------------------------------------------- |
| درخواست گمنام Relay‌شده از Gateway به Endpoint عمومی برسد                | این تنها مسیر ورود کاربر جدید است                  |
| درخواست گمنام مستقیم هم به همان Endpoint برسد                            | رفتار نباید به عبور از Gateway وابسته باشد         |
| درخواست گمنام Relay‌شده به Endpoint محافظت‌شده **نرسد**                  | `@Public` نباید به یک Bypass عمومی تبدیل شود       |
| توکن `RELAY` هرگز `@AllowService` را ارضا نکند                           | Relay اقتدار کمتری می‌دهد، نه بیشتر                |
| توکن `SERVICE` معتبر روی Endpoint بدون `@AllowService` رد شود            | Zero Trust: Callee تصمیم می‌گیرد (ADR-020)         |
| توکن `SERVICE` معتبر روی Endpoint **عمومیِ** بدون `@AllowService` رد شود | عمومی بودن، مجوز سرویس‌به‌سرویس نمی‌دهد            |
| توکن داخلی جعلی یا Malformed رد شود — حتی روی Endpoint عمومی             | توکن همیشه اعتبارسنجی می‌شود                       |
| توکن Relay صادرشده برای سرویس دیگر رد شود                                | `aud` باید Scope داشته باشد، وگرنه قابل Replay است |
| توکن بدون Claim `purpose` به‌عنوان `SERVICE` خوانده شود                  | سازگاری رو به عقب با سخت‌گیرانه‌ترین قرائت         |
| JWT کاربر معتبر، حتی همراه توکن Relay، مسیر عادی USER را برود            | رفع نباید مسیر کاربر احراز هویت‌شده را تغییر دهد   |
| JWT کاربر **نامعتبر** رد شود حتی وقتی توکن Relay معتبر همراهش است        | Relay نباید یک توکن بد را نجات دهد                 |

**قاعده.** افزودن `@Public(reason)` به یک Endpoint جدید بدون افزودن به این
مجموعه، ناقص است.

### مجوزدهی

```typescript
describe('Authorization matrix', () => {
  it.each([
    ['DRIVER', 'POST /v1/assets', 403],
    ['DRIVER', 'POST /v1/assets/:id/usage', 201],
    ['FLEET_MANAGER', 'POST /v1/assets', 201],
    ['AUDITOR', 'GET  /v1/wallets/me', 403], // الزام سند محصول
    ['AUDITOR', 'GET  /v1/transactions', 403], // الزام سند محصول
    ['AUDITOR', 'GET  /v1/dashboards/governance', 200],
    ['SUPPLIER', 'GET  /v1/orders/:otherOrderId', 404],
  ])('%s روی %s باید %d بگیرد', async (role, route, expected) => {
    /* ... */
  });
});
```

### یکپارچگی مالی

```typescript
describe('Financial integrity', () => {
  it('هر Journal متوازن است', async () => {
    const unbalanced = await db.$queryRaw`
      SELECT journal_id FROM ledger_entry
      GROUP BY journal_id, currency
      HAVING SUM(CASE WHEN direction='DEBIT' THEN amount_minor ELSE -amount_minor END) <> 0`;
    expect(unbalanced).toHaveLength(0);
  });

  it('UPDATE روی ورودی دفتر کل غیرممکن است', async () => {
    await expect(db.$executeRaw`UPDATE ledger_entry SET amount_minor = 1 WHERE id = ${entryId}`).rejects.toThrow(
      /append-only/,
    );
  });

  it('۱۰۰ برداشت موازی هرگز مانده را منفی نمی‌کند', async () => {
    await topUp(wallet, 10_000n);
    const results = await Promise.allSettled(Array.from({ length: 100 }, () => withdraw(wallet, 1_000n)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10);
    expect((await getWallet(wallet)).availableBalanceMinor).toBe('0');
  });

  it('تسویه بدون تأیید دریافت غیرممکن است', async () => {
    const order = await createOrder();
    await expect(settle(order.id)).rejects.toThrow('INVALID_STATE_TRANSITION');
  });
});
```

### Idempotency

```typescript
it('پردازش دو باره یک رویداد اثر دوم ندارد', async () => {
  await consumer.handle(orderCompletedEvent);
  await consumer.handle(orderCompletedEvent); // همان eventId
  expect(await countCommissionsFor(orderId)).toBe(1);
});
```

**CONSTRAINT.** این چهار دسته تست هرگز `--skip` نمی‌شوند و شکستشان هرگز به‌عنوان
«تست شکننده» نادیده گرفته نمی‌شود. هرکدام یک نشتی داده یا یک باگ مالی را نشان می‌دهد.

---

## ۱۴٫۷ تست E2E

با Playwright روی Stack کامل.

**وضعیت 2026-08-30.** `tests/e2e` اکنون Package ‏`@rasta/e2e` است: یک
`playwright.config.ts` واقعی، یک Global Setup که هر وابستگی را **مثبت** بررسی
می‌کند و با پیام قابل‌اقدام شکست می‌خورد، و **۶۴ سناریو** در دو Project روی
`api-gateway` + `economic-service` + `marketplace-service` + PostgreSQL + Kafka

- Temporal + توکن واقعی Keycloak.

Project ‏`marketplace-api` به `economic-api` وابسته است، تا شکستن مسیر مالی
همان‌جا خودش را نام ببرد نه به‌صورت سفارشی که هرگز تکمیل نشد.
`pnpm test:e2e` واقعاً اجرا می‌کند و اگر هیچ تستی پیدا نشود شکست می‌خورد —
`--pass-with-no-tests` در هیچ‌جای این Repository نیست. در CI یک Job جدا
(`e2e`) هر وابستگی‌اش را خودش تأمین می‌کند.

**API، نه Browser — و چرا.** `apps/web` و `apps/admin` پوشه‌های خالی‌اند. تست
Browser باید صفحه‌ای را Drive کند که وجود ندارد؛ ساختن صفحه برای تست یعنی
تستِ Fixture خودمان. `APIRequestContext` همان Stack واقعی را می‌زند —
Routing، Rate Limit، اجبار `Idempotency-Key`، تأیید JWT، تفکیک مستأجر، دامنه،
پایگاه داده و Broker — و هیچ‌کدام Mock نیست. وقتی `apps/web` ساخته شد، یک
Project دوم کنار همین یکی اضافه می‌شود.

**نیمه Marketplace دیگر حذف نیست (2026-08-30).** قرارداد `ORDER_*` را مالکش
تعریف کرد و ۱۷ سناریو تازه مسیر بحرانی خرید را می‌آزمایند: انتشار عرضه، سفارش
با قیمت سمت سرور، Hold، تحویل، تأیید صریح خریدار، تسویه، و مانده‌های واقعی کیف
پول در سه نقطه.

بیشتر ادعاهای آن سناریوها درباره چیزی است که **نباید** رخ دهد: قیمت در بدنه رد
می‌شود (نه نادیده گرفته)، `sort=RATING` رد می‌شود چون `supplier-service` وجود
ندارد، تأمین‌کننده نمی‌تواند تحویل خودش را تأیید کند، اعتراض تسویه را روی هر دو
سرویس غیرممکن می‌کند، و لغو تا بازگشت واقعی وجه `CANCELLING` می‌ماند.

دو انتظار در این سناریوها Poll می‌کنند نه Sleep: Saga سفارش را از داخل یک
Activity جلو می‌برد، و اعتراض را هم از یک Activity دیگر روی تراکنش بازتاب
می‌دهد. هر دو مرز ناهمگام واقعی‌اند.

| #   | سناریو                                                                                                             | فاز |
| --- | ------------------------------------------------------------------------------------------------------------------ | --- |
| ۱   | ورود · انتخاب سازمان · مشاهده داشبورد                                                                              | P0  |
| ۲   | ثبت دارایی → تخصیص راننده → ثبت کارکرد → مشاهده در پرونده                                                          | P0  |
| ۳   | ثبت خرابی → ارجاع تعمیرگاه → اتمام تعمیر → تأیید کاربر → تسویه                                                     | P0  |
| ۴   | **جریان کامل Marketplace:** جست‌وجو → سفارش → Hold → تحویل → تأیید → تسویه → کارمزد → پاداش                        | P0  |
|     | ↳ نیمه مالی‌اش **پیاده و سبز** است: کیف پول → شارژ → تعهد + Hold → Replay → تأیید → تسویه → دفتر متوازن → مانده‌ها | ✅  |
| ۵   | **جریان کامل عمران:** پروژه → موافقت → مناقصه → پیشنهاد → ارزیابی → قرارداد → پیشرفت                               | P0  |
| ۶   | صورت‌وضعیت → تأیید فنی → تأیید مالی → پرداخت                                                                       | P1  |
| ۷   | تجمیع تقاضا → RFQ → پیشنهاد قیمت → سفارش خرید                                                                      | P1  |
| ۸   | **Tenant Isolation از دید UI** — کاربر A داده B را نمی‌بیند                                                        | P0  |
|     | ↳ از دید API **پیاده و سبز**: کیف پول، تراکنش و تسویه سازمان دیگر → ۴۰۴؛ `AUDITOR` → ۴۰۳                           | ✅  |
| ۹   | اعتراض روی سفارش → توقف تسویه                                                                                      | P1  |
| ۱۰  | هشدار انقضای بیمه → تمدید                                                                                          | P1  |

| ۱۱ | **فراخوان سرویس‌به‌سرویس با تنانت امضاشده** — Hold → تأیید → تسویه از یک Activity | ✅ |

**قواعد:** هر تست داده خودش را می‌سازد و پاک می‌کند · بدون `sleep` ثابت (انتظار روی شرط) ·
اجرا روی Staging در CI · شکست E2E روی مسیر بحرانی = مسدود کردن انتشار.

---

## ۱۴٫۸ تست بار

با k6 — پس از Day 20.

| سناریو                   | هدف                            | آستانه قبولی                       |
| ------------------------ | ------------------------------ | ---------------------------------- |
| فهرست دارایی             | ۵۰ کاربر همزمان، ۵ دقیقه       | p95 < ۳۰۰ms                        |
| جست‌وجوی Marketplace     | ۱۰۰ کاربر همزمان               | p95 < ۵۰۰ms                        |
| ثبت سفارش                | ۲۰ سفارش/ثانیه                 | p95 < ۱s، خطا < ۰٫۱٪               |
| ثبت کارکرد (نوشتن‌سنگین) | ۱۰۰ ثبت/ثانیه                  | p95 < ۵۰۰ms                        |
| **همزمانی کیف پول**      | ۵۰ عملیات موازی روی یک کیف پول | **بدون مانده منفی، بدون Deadlock** |
| مصرف رویداد              | ۱٬۰۰۰ رویداد/ثانیه             | تأخیر < ۳۰s                        |

---

## ۱۴٫۹ داده تست

| نوع         | کاربرد             | مکان                              |
| ----------- | ------------------ | --------------------------------- |
| Factory     | Unit و Integration | `packages/testing/src/factories/` |
| Fixture     | تست API            | `<service>/test/fixtures/`        |
| Seed نمایشی | توسعه و Demo       | `<service>/prisma/seed.ts`        |
| Seed E2E    | Playwright         | `tests/e2e/fixtures/`             |

**Dataset نمایشی (الزام Day 10):** ۳ سازمان · ۲۰+ ماشین‌آلات · ۱۰ کاربر · چند راننده ·
چند تعمیرگاه · چند تأمین‌کننده · چند کالا · چند سفارش · چند تراکنش · چند پروژه عمرانی ·
چند مناقصه · چند قرارداد.

**CONSTRAINT.** داده Seed **قطعی** است (Seed ثابت برای ULIDها) تا تست‌ها تکرارپذیر بمانند،
و هرگز شامل داده شخصی واقعی نیست.

---

## ۱۴٫۱۰ Definition of Done — به‌ازای هر سرویس

یک سرویس تنها زمانی Done است که:

- [ ] تست واحد برای هر Domain Service و هر محاسبه
- [ ] تست یکپارچگی برای هر Repository و هر Consumer
- [ ] **تست Tenant Isolation** — CRUD کامل روی مستأجر دیگر → ۴۰۴
- [ ] **تست ماتریس مجوزدهی** — هر نقش، مثبت و منفی
- [ ] تست API برای هر Endpoint شامل همه مسیرهای خطا
- [ ] تست قرارداد برای هر رویداد منتشرشده
- [ ] تست Idempotency برای هر Endpoint و Consumer مربوطه
- [ ] تست Migration — اجرا و بازگشت (`pnpm test:migration`: up → down → up
      روی Schema یک‌بارمصرف، با ادعا بین هر گام)
- [ ] پوشش بالای آستانه سرویس
- [ ] OpenAPI تولید و Commit شده
- [ ] مستندات به‌روز

برای `economic-service` علاوه بر بالا: **همه تست‌های یکپارچگی مالی § ۱۰٫۱۲** سبز.

**وضعیت 2026-08-29 (دوم).** **۳۰۸** تست واحد، **۲۵۵** تست یکپارچگی (۲۱ Suite)
روی PostgreSQL و Kafka **واقعی**، و **۳۷ سناریو E2E**. نه `test:integration`
و نه `test:e2e` این سرویس `--passWithNoTests` ندارند.

**پوشش، برای نخستین بار واقعاً سنجیده‌شده:** Statements ۹۳٫۸۰٪ ·
**Branches ۹۰٫۱۳٪** · Functions ۹۱٫۶۶٪ · Lines ۹۵٫۷۷٪ — بالای آستانه § ۱۴٫۲.

> پیش از این، آستانه هرگز سنجیده نمی‌شد. هر دو Project در `jest.config.js`
> ‏`rootDir` را روی پوشه تست خودشان می‌گذاشتند و Jest الگوهای
> `collectCoverageFrom` را نسبت به همان حل می‌کند، پس `src/**` می‌شد
> `src/src/**`. هیچ فایلی مطابقت نمی‌کرد، `--coverage` صفر گزارش می‌داد، و
> آستانه ۹۰٪ روی مجموعه تهی هرگز شکست نمی‌خورد. عدد واقعی پس از رفع:
> **۴۴٫۸۴٪ شاخه**.

**آنچه شاخه‌های باقی‌مانده هستند.** از ۷۳ شاخه پوشش‌نیافته، **۴۶ مورد
ساختاراً غیرقابل‌دسترس‌اند**: ردیفی که دو خط بالاتر قفل شده، حالتی که یک
Constraint ممنوع کرده، ارائه‌دهنده‌ای که Boot ردش می‌کند. رسیدن به آن‌ها
یعنی خراب کردن پایگاه داده برای بالا بردن یک عدد — که § ۱۴٫۲ صریحاً
می‌گوید بدتر از پوشش کمتر ولی معنادار است.

**وضعیت 2026-08-30 — آستانه سرانجام اجرایی شد.** عدد سنجیده می‌شد، اما هیچ‌چیز
آن را **اعمال** نمی‌کرد: هیچ Job ی در CI ‏`jest` را با `--coverage` اجرا نمی‌کرد،
و دستور دستی‌ای که خودِ توضیح `jest.config.js` نام می‌برد
(`pnpm --filter @rasta/economic-service coverage`) به Script ی اشاره داشت که
هرگز تعریف نشده بود. هر دو نیمهٔ دستورالعمل بی‌اثر بودند.

| سنجه       | پیش (2026-08-29) | پس (2026-08-30) | آستانه  |
| ---------- | ---------------- | --------------- | ------- |
| Statements | ۹۳٫۸۰٪           | **۹۴٫۲۳٪**      | ۹۰٪     |
| **Branch** | **۹۰٫۱۳٪**       | **۹۱٫۳۱٪**      | **۹۰٪** |
| Functions  | ۹۱٫۶۶٪           | **۹۲٫۱۰٪**      | ۹۰٪     |
| Lines      | ۹۵٫۷۷٪           | **۹۶٫۲۹٪**      | ۹۰٪     |

۶۰۴ → **۶۱۵ تست** در **۴۰ Suite**. هیچ آستانه‌ای پایین نیامد و هیچ فایل دامنه‌ای
کنار گذاشته نشد. § ۱۴٫۲ برای این سرویس **۹۰٪ شاخه** را الزام می‌کند؛ سه سنجهٔ دیگر
هم روی ۹۰ نگه داشته شده‌اند که سخت‌گیرانه‌تر از جدول است — چون هر چهار عبور می‌کنند
و پایین آوردن آستانه‌ای که عبور می‌کند، همان فرسایشی است که این کار برای رفعش انجام شد.

> **حاشیه، در زمان اجرایی‌شدن: یک شاخه.** ‏۶۰۴ از ۶۶۹ شاخه پوشش داشت و ۹۰٪ به
> ۶۰۳ نیاز داشت. دروازه‌ای که با نخستین Commit بعدی می‌افتد، دروازه‌ای است که
> کسی خاموشش می‌کند؛ پس حاشیه با تست‌های واقعی روی همان مسیرهایی که § ۱۰٫۱۲
> اولویت می‌داند به **۸ شاخه** رسانده شد، نه با دست‌کاری آستانه.

**یک نقص واقعی را همین تست‌ها گرفتند.** `resolveAccount` مسیر بازیابیِ رقابت را
با `catch` روی نقض Unique پیاده کرده بود — داخل تراکنش Interactive فراخوان. در
PostgreSQL آن نقض کل تراکنش را Abort می‌کند و هر دستور بعدی `25P02` می‌گیرد، پس
خودِ Query بازیابی جزو دستورهای ردشده بود. آن شاخه وجود داشت، مستند بود، و یک
رقابتِ قابل‌بازیابی را به شکست قطعی تبدیل می‌کرد. نخستین تستی که دو درخواست
هم‌زمان را روی یک سازمان اجرا کرد، همان‌جا شکست.

سه نقص را تست‌های پیشین گرفتند (تراکنش تودرتوی Prisma، نمای دریافت‌کننده
همیشه‌خالی، و گزارش شکست ناخوانا برای `bigint`). این دور سه چیز دیگر گرفت:
آستانه‌ای که سنجیده نمی‌شد، `purgeExpired`ی که هرگز اجرا نشده بود، و سه درز
میان لایه‌ها که در `docs/24` به‌عنوان Q-26 تا Q-28 ثبت شدند.

---

## ۱۴٫۱۱ اجرای تست‌ها

```bash
pnpm test                       # همه
pnpm test:unit                  # سریع، بدون زیرساخت
pnpm test:integration           # نیازمند Docker
pnpm test:e2e                   # نیازمند Stack کامل
pnpm --filter @rasta/economic-service test -- --coverage
pnpm --filter @rasta/asset-service test -- --testNamePattern="tenant isolation"
pnpm verify                     # دروازه کامل کیفیت
```

**پیکربندی و قواعد هشدار Prometheus.** Job مستقل `prometheus-rules` در CI (روی هر PR و `main`، بی وابستگی Node و بیرون از
Job سریع `quality`) همان Image سرویس `prometheus` در `docker-compose.yml` را با کل پوشهٔ
`infrastructure/docker/prometheus` به‌صورت فقط‌خواندنی در `/etc/prometheus` اجرا می‌کند؛ پس مسیر `rule_files` همان است که در
زمان اجرا. `check config` نحو پیکربندی و قواعد را با هم و وجود فایل نام‌برده را می‌سنجد؛ `test rules` رفتار سیزده هشدار و یک Recording Rule (چهارده قاعده) را،
با افزایش واقعی شمارنده (نه مقدار مطلق) و کنترل‌های منفی (`outcome="recorded"`/`"skipped"` هشدار نمی‌دهد، سن پشتهٔ بسته ≤ ۶۰
هشدار نمی‌دهد، `pending_age` ورودی هشدار نیست)، گذار Series صادرشده با صفر به نخستین رخداد (که هشدار می‌دهد) و Labelهای
دقیق هر هشدار. برای Kafka همان Fixture با نام و Labelهای واقعی `danielqsj/kafka-exporter:v1.9.0`
(`kafka_consumergroup_lag{consumergroup,partition,topic}`، `kafka_topic_partition_current_offset`/`_oldest_offset{partition,topic}`)
اثبات می‌کند: `RastaAuditConsumerLag` برای هر دو گروه `audit-service.domain-projector` و `audit-service.trail` در ۴ دقیقه نمی‌سوزد و
در ۵ دقیقه با Label و Annotation دقیق می‌سوزد، `-1` (Partition بی Commit) جمع را کم نمی‌کند، با رسیدن Lag به صفر برطرف می‌شود، و Lag
صفر، Lag گذرای کمتر از ۵ دقیقه، یک صفرِ میانی (که ۵ دقیقه را از نو آغاز می‌کند) و گروه غیرحسابرسی (`maintenance-service.usage`،
`audit-itest-trail-…`) هشدار نمی‌دهند. `RastaKafkaExporterUnavailable`: با `up{job="kafka-exporter"}=0` در ۱ دقیقه `pending`
است (از راه `promql_expr_test` روی `ALERTS`، چون `alert_rule_test` فقط `firing` را می‌بیند) و در ۲ دقیقه فقط با Label
`job`/`severity` می‌سوزد و با بازگشت `up=1` رفع می‌شود؛ `up` یک Job دیگر، خرابی گذرای کمتر از ۲ دقیقه و `up=1` پایدار نمی‌سوزند؛
و نبودن کامل Series `up{job="kafka-exporter"}` هم در ۲ دقیقه با همان Labelها می‌سوزد. `RastaAuditConsumerGroupMetricsMissing`:
با Exporter سالم، نبودن هر یک از دو گروه (و هر دو، روی Broker تازه) پس از ۵ دقیقه یک هشدار با Label `consumergroup` همان گروه
می‌دهد و در ۴ دقیقه نه؛ هر دو گروه موجود با مقدار صفر و `-1` نمی‌سوزند؛ گروه‌های `audit-itest-…`، `audit-itest-trail-…` و
`maintenance-service.usage` جای گروه ثابت را نمی‌گیرند؛ Exporter خاموش یا بی Series `up` این هشدار را خاموش می‌کند؛ و گروهی
که کمتر از ۵ دقیقه ناپدید می‌شود (با نشانگر `stale` واقعی Prometheus) نمی‌سوزد و بازگشتش ۵ دقیقه را از نو آغاز می‌کند. جهش‌های
حذف شاخهٔ `absent(up…)`، حذف شرط سلامت Exporter (یا `== 1` → `>= 0`)، ضعیف کردن تطابق دقیق گروه به Regex (سه شکل)، حذف
`min by (job)` و کوتاه کردن هر `for` هر کدام Fixture را شکست دادند. `RastaAuditIngestionLagHigh` با Seriesهای انباشتی واقعی
`rasta_audit_ingestion_lag_seconds_bucket{source_topic,le}` روی همان مرزهای سرویس (`1 … 3600`، `+Inf`) و Labelهای
`job`/`instance`/`environment` Scrape اثبات می‌شود: p95 پیوسته ۶۵٫۴۵ روی دو Instance از ۱ دقیقه درست است، در ۵ دقیقه `pending`
(از راه `ALERTS`) و در ۶ دقیقه دقیقاً **یک** هشدار با فقط `source_topic`/`severity` و Annotation دقیق؛ Topic دوم که از ۴ دقیقه بالا
می‌رود مستقل در ۹ دقیقه می‌سوزد؛ p95 دقیقاً روی مرز ۶۰ و p95 برابر ۲۹٫۲۵ نمی‌سوزند؛ Topic با یک Instance کند و یک Instance پرشمار
سریع (p95 جمع‌شده ۹٫۶۹) نمی‌سوزد؛ Series صادرشده با صفر بی مشاهده (`NaN`) و نبودن کامل Histogram ساکت‌اند؛ و بازهٔ بالای گذرا
(۱–۳ دقیقه، سپس ۱۰۰۰۰ رکورد سریع) `for` را از نو آغاز می‌کند و فقط در ۱۳ دقیقه می‌سوزد، نه ۶. جهش‌های Quantile ‏`0.5` و `0.99`،
`by (le)`، `by (source_topic)`، `by (le, source_topic, instance)`، حذف `sum by`، آستانهٔ `> 59` و `> 66`، و `for: 4m` هر نُه
Fixture را شکست دادند. آزمون‌های واحد `audit-service` (`metrics.spec.ts` و دو Spec مصرف‌کننده) مرزهای دقیق Bucket، ۱۱ Topic مشتق از
`DOMAIN_TOPICS` و `AUDIT_TRAIL_TOPIC`، Exposition صفرِ `_bucket`/`_sum`/`_count` پیش از نخستین رکورد، مقداردهی با `zero()` بی
فراخوان `observe`، و برای مسیر A و B یک مشاهدهٔ دقیق با `Date.now()` ثابت (Bucket درست، `_sum` دقیق)، Clamp ساعت جلوتر به Bucket
صفر، و نبودن مشاهده برای `DUPLICATE`، رد و شکست پایگاه داده را اثبات می‌کنند. `RastaAuditServiceMetricsUnavailable` با Seriesهای واقعی `up{job,instance,environment}` در شش گروه اثبات می‌شود: Target اختصاصی
`audit-service` که در ۲ دقیقه قطع می‌شود در ۲ و ۳ دقیقه `pending` (از راه `ALERTS`) و دقیقاً در ۴ دقیقه **یک** هشدار با فقط
`job`/`severity` و Annotation دقیق است، با بازگشت در ۶ دقیقه رفع می‌شود و قطع دوم از ۸ دقیقه باز ۲ دقیقه می‌خواهد (Firing در ۱۰)؛
Targetهای `rasta-services` و `identity-service` همان میزبان (همیشه خاموش، همیشه روشن، متناوب) و Exporter خاموش نه آن را می‌سوزانند نه سرکوب
می‌کنند، و audit-service سالم با دو Replica هرگز نمی‌سوزد؛ نبودن کامل `up{job="audit-service"}` در ۰ و ۱ دقیقه `pending` و در ۲
دقیقه Firing است و `rasta-services` یا `identity-service` سالم جایش را نمی‌گیرد؛ Target برداشته‌شده (نشانگر `stale`) در ۴ دقیقه می‌سوزد؛ از دو Replica
شکست فقط یکی در ۴ دقیقه می‌سوزد و با شکست هر دو هنوز یک هشدار بی `instance` است؛ و شکست‌های کوتاه‌تر از ۲ دقیقه هرگز نمی‌سوزند.
هشت جهش در کپی موقت Fixture را شکست دادند: حذف شاخهٔ `absent`، حذف شاخهٔ `== 0`، Selector ‏`rasta-services`، حذف Selector،
`min by (job, instance)`، `max by (job)`، حذف `for` و `for: 1m`. `RastaIdentityServiceMetricsUnavailable` به همان شکل با
Seriesهای واقعی `up{job,instance,environment}` در شش گروه اثبات می‌شود: Target اختصاصی `identity-service` که در ۲ دقیقه قطع
می‌شود در ۲ و ۳ دقیقه `pending` (از راه `ALERTS`) و دقیقاً در ۴ دقیقه **یک** هشدار با فقط `job`/`severity` و Annotation دقیق
است، در ۶ دقیقه رفع و در ۶ و ۷ دقیقه بی `pending` است و قطع دوم از ۸ دقیقه باز ۲ دقیقه می‌خواهد (Firing در ۱۰)، در حالی که
Target همیشه خاموش و Target متناوب `rasta-services` و audit-service سالم نه آن را می‌سوزانند نه سرکوب می‌کنند؛ identity-service
سالم با دو Replica در ۲، ۵ و ۱۰ دقیقه هرگز نمی‌سوزد، هرچند همهٔ Targetهای `rasta-services`، audit-service و Exporter خاموش‌اند؛
نبودن کامل `up{job="identity-service"}` در ۰ و ۱ دقیقه `pending` و در ۲ دقیقه Firing است و Targetهای سالم `rasta-services`
(حتی ۳۱۰۱ زیر پیکربندی قدیمی `rasta-services`) و audit-service جایش را نمی‌گیرند؛ Target برداشته‌شده (نشانگر `stale` در ۲ دقیقه)
در ۲ و ۳ دقیقه `pending` و در ۴ دقیقه Firing است؛ از دو Replica شکست فقط یکی از ۲ دقیقه در ۴ دقیقه می‌سوزد و با شکست هر دو
(۷ دقیقه) هنوز یک هشدار بی `instance` است و با بازگشت هر دو در ۹ دقیقه رفع می‌شود؛ و شکست‌های کوتاه‌تر از ۲ دقیقه (در ۴ و ۶ دقیقه
`pending`، در ۵ و ۷ دقیقه پاک) هرگز نمی‌سوزند. Seriesهای Fixture سه هشدار صف ردها اکنون Labelهای Scrape
`job="identity-service"` دارند (مقدار و انتظارها بی تغییر؛ Label کامل `RastaSecurityEventClosedBacklogStale` هم همین `job` را
نشان می‌دهد)، و Seriesهای `up` نشانی ۳۱۰۱ در گروه‌های audit-service و Exporter هم به همین Job رفتند. به همین شکل، هر ۱۳۲
Series ورودی با Label Scrape که خروجی audit-service را مدل می‌کند — ۱۳۰ Series `rasta_audit_*` (روی `host.docker.internal:3115`،
`audit-b.internal:3115` و Replica ساختگی `host.docker.internal:4115`) و دو Series `rasta_dlq_messages_total{service="audit-service"}`
— Label واقعی Job اختصاصی `job="audit-service"` دارند؛ چهار Series عمداً کمینه (سه `rasta_audit_*` و یک `rasta_dlq_messages_total`)
همچنان بی Label Scrape‌اند. قواعد این متریک‌ها `job`/`instance`/`environment` را عمداً با `sum by`/`max by` کنار می‌گذارند؛ در یک
کپی موقت، جایگزینی `job` همین ۱۳۲ Series با یک Job نگهبان یکتا (بی دست زدن به هیچ Series `up`) `promtool test rules` را با همان
انتظارها سبز نگه داشت. هشت جهش در کپی موقت
پوشهٔ Prometheus Fixture را شکست دادند: حذف شاخهٔ `absent`، حذف شاخهٔ `== 0`، Selector ‏`rasta-services`، حذف Selector،
`min by (job, instance)`، `max by (job)`، حذف `for` و `for: 1m`. `RastaAuditProducerSilent` با `rasta_audit_expected_active_producer{source_service}` و `rasta_audit_records_ingested_total`
واقعی (Labelهای Scrape روی دو Instance، چند Topic و Outcome) در چهار گروه اثبات می‌شود: تولیدکنندهٔ مورد انتظار و ساکت از ۰ تا ۳۵۹
دقیقه نه `pending` است نه `firing` (Startup: `offset 6h` هنوز نمونه ندارد)، در ۳۶۰ و ۳۸۹ دقیقه `pending` (از راه `ALERTS`) و دقیقاً در ۳۹۰
دقیقه **یک** هشدار با فقط `source_service`/`severity` و Annotation دقیق؛ سرویس پیکربندی‌نشده با شمارندهٔ قدیمی یا صفر، Label
`unknown` و تولیدکننده‌ای که از ۳۰۰ دقیقه پیکربندی شده نمی‌سوزند؛ دو تولیدکننده مستقل‌اند (یکی در ۳۹۰ می‌سوزد، دیگری با ردیف ۱۰۰
دقیقه‌ای روی Topic/Outcome/Instance دیگر تا ۴۵۹ ساکت می‌ماند)؛ ردیف ۴۵۰ دقیقه‌ای هشدار روشن را برطرف و ردیف ۴۷۰ دقیقه‌ای `pending`
را از نو آغاز می‌کند (در ۴۸۹ نمی‌سوزد)؛ Reset شمارنده در Restart بی ردیف (۷→۰) ساکت است و می‌سوزد، ولی ردیف پیش از نخستین Scrape
(۷→۱) شمرده می‌شود؛ تولیدکنندهٔ پیکربندی‌شده بی Series شمارنده می‌سوزد؛ Gate که ناپدید شده و نبودن کامل Gate هیچ‌کدام نمی‌سوزند.
نُه جهش در کپی موقت Fixture را شکست دادند: حذف Gate (`== 0` تنها روی شمارنده)، حذف Gate `offset 6h`، `unless on ()`،
`sum by (source_topic)`، `max by (source_service, instance)`، پنجرهٔ `1h` و `5h`، حذف `for` و `for: 5m`. آزمون‌های واحد `audit-service`
توپولوژی Frozen (ده Topic، نُه مالک، ۱۰ مقدار Label با `unknown`)، Label مسیر A و B برای تولیدکنندهٔ دلخواه، بلند، هم‌نام با حروف دیگر و
نام معتبر روی Topic غیرخودی (همه `unknown`)، ماندن ادعای تولیدکننده در رکورد ذخیره‌شده، کرانداری Label با ۵۰ تولیدکنندهٔ متمایز،
اعتبارسنجی `AUDIT_EXPECTED_ACTIVE_PRODUCERS` (پیش‌فرض خالی، Trim/Dedupe، رد نام ناشناخته و عنصر خالی بی بازگویی متن)، و
Exposition دقیق Gate و Tupleهای صفر (۱۲ برای identity+asset، ۳۳ برای همه، `inc(…, 0)` بی پاک کردن شمارش واقعی، امن پس از
`reset()`، پیش از شروع Consumerها) را می‌سنجند؛ ده جهش TypeScript (بازگشت هر دو مسیر به `record.sourceService`، نادیده گرفتن تطابق
مالک، `inc(…, 1)`، حذف Seeding، حذف فراخوان `AppModule`، ردنکردن نام ناشناخته، پیش‌فرض همهٔ سرویس‌ها، Reset نکردن Gate) هر کدام
دست‌کم یک آزمون را شکست دادند. `promql_expr_test` Recording Rule `topic:kafka_topic_retained_records:sum` را روی سه Partition
(۱۰۵، سپس ۱۱۵ پس از نوشتن تازه، سپس ۳۵ پس از حذف به‌دست Retention)، نادیده ماندن Topic DLQ دیگر، و Clamp (Partition با Offsetهای
متقاطع صفر است و از Partition دیگر کم نمی‌کند) می‌سنجد. `pnpm verify` این دروازه را اجرا نمی‌کند، چون Docker
می‌خواهد. فرمان محلی (در Git Bash روی ویندوز `MSYS_NO_PATHCONV=1` لازم است):

```bash
docker run --rm -v "$PWD/infrastructure/docker/prometheus:/etc/prometheus:ro" \
  --entrypoint promtool prom/prometheus:v3.1.0 check config /etc/prometheus/prometheus.yml
docker run --rm -v "$PWD/infrastructure/docker/prometheus:/etc/prometheus:ro" \
  --entrypoint promtool prom/prometheus:v3.1.0 test rules /etc/prometheus/tests/rasta-audit-alerts.test.yml
```

**در CI:** Unit و Contract موازی روی هر Push · Integration و Security روی هر PR ·
E2E روی `main` پس از استقرار Staging · Load شبانه.
