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

| #   | سناریو                                                                                      | فاز |
| --- | ------------------------------------------------------------------------------------------- | --- |
| ۱   | ورود · انتخاب سازمان · مشاهده داشبورد                                                       | P0  |
| ۲   | ثبت دارایی → تخصیص راننده → ثبت کارکرد → مشاهده در پرونده                                   | P0  |
| ۳   | ثبت خرابی → ارجاع تعمیرگاه → اتمام تعمیر → تأیید کاربر → تسویه                              | P0  |
| ۴   | **جریان کامل Marketplace:** جست‌وجو → سفارش → Hold → تحویل → تأیید → تسویه → کارمزد → پاداش | P0  |
| ۵   | **جریان کامل عمران:** پروژه → موافقت → مناقصه → پیشنهاد → ارزیابی → قرارداد → پیشرفت        | P0  |
| ۶   | صورت‌وضعیت → تأیید فنی → تأیید مالی → پرداخت                                                | P1  |
| ۷   | تجمیع تقاضا → RFQ → پیشنهاد قیمت → سفارش خرید                                               | P1  |
| ۸   | **Tenant Isolation از دید UI** — کاربر A داده B را نمی‌بیند                                 | P0  |
| ۹   | اعتراض روی سفارش → توقف تسویه                                                               | P1  |
| ۱۰  | هشدار انقضای بیمه → تمدید                                                                   | P1  |

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
- [ ] تست Migration — اجرا و بازگشت
- [ ] پوشش بالای آستانه سرویس
- [ ] OpenAPI تولید و Commit شده
- [ ] مستندات به‌روز

برای `economic-service` علاوه بر بالا: **همه تست‌های یکپارچگی مالی § ۱۰٫۱۲** سبز.

**وضعیت 2026-08-29.** ۲۳۹ تست واحد و ۱۰۰ تست یکپارچگی (۹ Suite) روی PostgreSQL
و Kafka **واقعی**، بدون Mock. `test:integration` این سرویس
`--passWithNoTests` **ندارد**. Suiteها حول جدول اجباری § ۱۰٫۱۲ سازمان یافته‌اند،
نه حول ساختار کد — چون همان جدول است که دروازه Merge است. سه نقص را همین
تست‌ها گرفتند، نه بازبینی: یک تراکنش تودرتوی Prisma که Deadlock می‌ساخت، یک
نمای دریافت‌کننده که همیشه خالی برمی‌گشت، و گزارش شکست ناخوانا برای هر ادعای
`bigint`.

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

**در CI:** Unit و Contract موازی روی هر Push · Integration و Security روی هر PR ·
E2E روی `main` پس از استقرار Staging · Load شبانه.
