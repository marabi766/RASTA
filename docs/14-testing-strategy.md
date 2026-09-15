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

**آدرس PostgreSQL سمت میزبان در اجرای محلی (2026-09-14).** URLهای PostgreSQL که از میزبان به Listener یا Forwarder
فقط-IPv4 می‌رسند باید `127.0.0.1` باشند؛ پیش‌فرض‌های `.env.example` همین‌اند (`POSTGRES_HOST` و هر `DATABASE_URL_*`، از جمله
Migrator). اگر URL به هر دلیل `localhost` است، هر Forwarder موقت باید **هر دو** `127.0.0.1` و `[::1]` را منتشر کند؛ وگرنه
URL باید صریحاً IPv4 باشد. **نشانه:** Prisma `P2028` (`Unable to start a transaction in the given time` یا تراکنش منقضی) در
حدود `maxWait` دوثانیه‌ای تراکنش تعاملی، فقط زیر هم‌زمانی و فقط وقتی Pool اتصال تازه باز می‌کند؛ اتصال تکی کند (~۲ ثانیه) و
تراکنش بدیهی موازی هم همان خطا را می‌گیرد. **تمایز از Lock Contention برنامه:** در Lock Contention تراکنش‌ها **شروع
می‌شوند** و روی یک Query منتظر می‌مانند؛ در این حالت اصلاً شروع نمی‌شوند چون اتصالی نیست، و تغییر URL به `127.0.0.1` خطا را
بی هیچ تغییر کدی برطرف می‌کند (تشخیص اصلی در `PROJECT_MEMORY.md`، به‌روزرسانی 2026-09-14). `pnpm test:local-postgres-config`
و `pnpm check:local-postgres-config` این قرارداد را فقط به‌صورت متنی روی `.env.example` می‌سنجند (نه Probe شبکه، بی خواندن
`.env`، بی چاپ مقدار) و در `pnpm verify` و Job `quality` در CI اجرا می‌شوند؛ URLهای Service Container خودِ CI جدا و دست‌نخورده‌اند.
این قاعده فقط پیش‌فرض محلی توسعه است؛ سیاست Production برای `connection_limit`، `pool_timeout` یا گرم کردن Pool تصمیمی جدا
در سطح ADR است.

**اثبات فشار تجمیع رد در فاز انحصاری (2026-09-14).** `pnpm test` و `pnpm test:integration` دیگر مستقیم `turbo run` نیستند؛
`scripts/run-test-phases.mjs` آنها را در دو فاز اجرا می‌کند: (۱) **فاز Workspace** — همان `turbo run <task>` موازی برای همهٔ
بسته‌ها، که Project ‏`integration` در `identity-service` در آن `security-event-aggregation.int-spec.ts` را کنار می‌گذارد؛ (۲) **فاز
انحصاری** — فقط پس از پایان فاز ۱ (حتی اگر شکست خورده باشد، تا شکستی نامرتبط شاهد فشار را پنهان نکند؛ کد خروج همان نخستین شکست است)، `turbo run test:aggregation-stress --filter=@rasta/identity-service` که Project ‏Jest
`aggregation-stress` را با `--runInBand`، بی `--passWithNoTests` و بی Cache ‏Turbo اجرا می‌کند. هر فاز با زمان UTC در Log اعلام
می‌شود. آرگومان‌های پس از `--` (مثل `--testNamePattern` گام امنیتی CI) به هر دو فاز می‌رسند؛ گزینهٔ پیش از `--` (مثل `--filter`)
رد می‌شود، چون تصمیم می‌گرفت فاز انحصاری اجرا شود یا نه — اجرای فیلترشده بی فاز انحصاری `pnpm exec turbo run <task> --filter …`
است، و خودِ اثبات به‌تنها `pnpm test:aggregation-stress`. **چرا:** دو اثبات ۵۰۰-نوشتنی این Spec روی یک ردیف داغ سریال می‌شوند، پس
سرعتشان تأخیر Commit پایگاه داده است. به‌تنها هر Burst حدود ۲۲ ثانیه با ~۲۲ ‏WAL Sync بر ثانیه و بی Capture بالای ۵ ثانیه بود؛ کنار
Suiteهای Integration سرویس‌های دیگر روی همان PostgreSQL، ۴۲ تا ۱۲۴ ثانیه، WAL Sync تا ~۷ بر ثانیه افتاد، Captureها مرز
`statement_timeout` پنج‌ثانیه‌ای را رد کردند (`57014`) یا Burst از مرز پنجرهٔ ۶۰ ثانیه‌ای گذشت. انتظارها روی Row Lock پشت نگه‌دارنده‌ای
بود که روی WAL/I/O ایستاده بود، نه روی گرفتن اتصال از Pool. `atFreshWindow` فقط **حاشیهٔ شروع** می‌دهد، نه تضمین پایان. پنجرهٔ
پیش‌فرض ۶۰ ثانیه، مرز پنج‌ثانیه‌ای Capture، Pool، SQL و هر دو Assertion ‏۵۰۰ دست نخوردند؛ این Spec معیار Throughput یا SLA نیست.
`pnpm test:test-phases` و `pnpm check:test-phases` (ایستا، بی پایگاه داده) در `pnpm verify` و Job ‏`quality` در CI تضمین می‌کنند که
Spec از فاز موازی بیرون، دقیقاً یک بار در فاز انحصاری، و گام‌های `Integration tests` و امنیتی CI همچنان از Orchestrator می‌گذرند.

**شواهد نرخ Commit برای همان اثبات (2026-09-14، دستی).** `scripts/aggregation-evidence.mjs` (منطق خالص در
`scripts/aggregation-evidence-lib.mjs`) روی یک PostgreSQL تنها اجرا می‌کند: یک Control فقط‌خواندنی و یک Probe ‏WAL تک‌Committer
اعتبارسنجی‌شده (`pgbench -c 1 -j 1` با `pg_logical_emit_message(true, …)`؛ از `pg_stat_wal` باید تقریباً یک `wal_sync` در هر Commit
دیده شود، و `txid_current()` یا تراکنش فقط‌خواندنی رد می‌شود) پیش و پس از Jest، پنج فرایند تازهٔ Jest فقط برای اثبات «۵۰۰ Capture
از چهار Client» با `--testNamePattern` دقیق (۱ اجرا، ۲۱ فیلترشده)، و یک اجرای کامل `pnpm test:aggregation-stress`. فقط آمار تجمیعی
می‌نویسد، بی Retry و بی آستانهٔ نرخ Commit، و ثابت‌های فشار (۵۰۰، چهار Client، `LANES_PER_CLIENT = 2`، مرز ۵۰۰۰ms، پنجرهٔ ۶۰s) را
با قرارداد ایستا می‌پاید. خودِ اندازه‌گیری در CI اجرا نمی‌شود؛ فقط آزمون‌های Parser، اعتبارسنجی Probe و قرارداد
(`pnpm test:aggregation-evidence-lib`) در `pnpm verify` و Job ‏`quality` هستند. **نتیجه:** روی Runner بومی Ubuntu 24.04 در GitHub (۴ CPU،
همان `postgis/postgis:16-3.4`، `fsync=on`، `synchronous_commit=on`، `wal_sync_method=fdatasync`) هر دو Probe شصت‌ثانیه‌ای حدود
۴٬۶۰۰ Commit معتبر بر ثانیه بودند، بی هیچ بازهٔ یک‌ثانیه‌ای بی Commit؛ هر پنج اجرای نام‌دار (هر کدام ~۰٫۵۴ ثانیه و ~۵۰۱ ‏`wal_sync`) و
کل Project ‏(۲۲/۲۲) سبز شدند. همان Probe روی Docker Desktop محلی ۱۴٫۶ تا ۲۹٫۲ بود. پس شکست‌های محلی از محیط‌اند، نه از اثبات. Runner
حدود ۲۰۰ برابر سریع‌تر است و این اثبات را نزدیک مرزش نمی‌آزماید؛ آستانهٔ هر پیش‌شرط Fail-Fast هنوز تعیین نشده است.

**طراحی پیش‌شرط، بر پایهٔ همین شواهد — [ADR-055](adr/ADR-055-aggregation-stress-environment-capability.md) (Proposed، 2026-09-14).**
ADR-055 پیش‌شرط توانایی محیط را برای همین فاز انحصاری **طراحی** می‌کند: تفکیک **اعتبار Probe** از **توانایی محیط**، سه حالت
خروج (`VALID_CAPABLE` ادامه، `VALID_INCAPABLE` شکستِ محیط، `INVALID`/`INCONCLUSIVE` خطای زیرساخت)، رفتار Fail-Closed برای هر
خطای زیرساخت، و همان گزارش تجمیعی و Redaction این Harness — بی ساختن Probe دوم. **و عمداً هیچ آستانه‌ای تعیین نمی‌کند و هیچ
دروازه‌ای را فعال نمی‌کند:** امروز نه Preflight هست، نه Classifier، نه تغییری در `pnpm verify` یا CI. عدد آستانه موکول به
شواهد کالیبراسیون جفت‌شده است (Preflight و اجرای دست‌نخوردهٔ Suite روی همان پایگاه داده و پشت‌سرهم، شامل هر دو سمت گذشتن و
شکستنِ ناشی از محیط)، و ثابت‌های فشار در هیچ حالتی تغییر نمی‌کنند.

**ابزار کالیبراسیون جفت‌شده — دستی و فقط‌گزارش (2026-09-14).** همان Harness اکنون یک Mode دوم دارد که نمونه‌های جفت‌شدهٔ ADR-055 § ۶ را
تکرارپذیر می‌کند. **فراخوانی:** `pnpm run calibrate:aggregation-stress -- --pairs <۱..۲۰> <مسیر-گزارش>` (یا مستقیم
`node scripts/aggregation-evidence.mjs --calibrate --pairs <N> <مسیر-گزارش>`). هر **نمونه** دقیقاً یک Probe ‏WAL شصت‌ثانیه‌ای
اعتبارسنجی‌شده است و **بلافاصله** پس از آن یک اجرای تازهٔ **کل Project دست‌نخوردهٔ** `aggregation-stress` از راه `pnpm test:aggregation-stress`
(بی Retry، بی `--passWithNoTests`، با `--runInBand`)؛ یک Control فقط‌خواندنی پیش از نمونه‌ها شمارنده را تأیید می‌کند و **هیچ گام دیگری
میان Probe یک جفت و Suite همان جفت نمی‌آید** — قرارداد ایستا همین مجاورت را می‌پاید. خروجی فقط تجمیعی است: به‌ازای هر جفت اعتبار Probe و
ارقامش، نتیجهٔ Suite، و توزیع‌ها (تعداد، کمینه، میانه، بیشینه) برای TPS ‏Probe، کمینهٔ TPS بازه، بلندترین وقفه و زمان دیوار Suite؛ نمونهٔ
شکست‌خورده از مخرج حذف نمی‌شود. **مرزها:** برچسب‌ها فقط `VALID`/`INVALID`/`INCONCLUSIVE`اند — **هیچ `VALID_CAPABLE`/`VALID_INCAPABLE`، هیچ
«کند»، هیچ آستانه و هیچ حاشیه‌ای**؛ خطاهای زیرساخت به دسته‌های محدود و امن طبقه‌بندی می‌شوند و هیچ URL، Credential، Token، ردیف، شناسهٔ
تست یا خروجی خام فرایند فرزند چاپ یا ذخیره نمی‌شود. **فقط‌گزارش یعنی به هیچ دروازه‌ای وصل نیست** (نه `pnpm test`، نه `pnpm test:integration`،
نه `pnpm verify`، نه CI — و `pnpm check:test-phases` همین را اجبار می‌کند)؛ یعنی **نه** اینکه شکست سبز شود: Probe نامعتبر، Suite شکست‌خورده،
فرایندی که بالا نمی‌آید یا گزارشی که نوشته نمی‌شود، همچنان خروج غیرصفر می‌دهند. **هنوز جمع نشده:** مجموعه‌دادهٔ دوطرفه (نمونه‌های گذشتن
**و** شکستن ناشی از محیط) — و تا آن زمان هیچ عددی پیشنهاد نمی‌شود.

**انتقال ساخت‌یافتهٔ تشخیص در همان Harness (2026-09-15).** جملهٔ بالا دربارهٔ «طبقه‌بندی به دسته‌های محدود» دربارهٔ **واژگان**
درست بود، ولی **مسیر اجرای واقعی** دسته را از دست می‌داد: `psql()` دسته را داخل یک جمله می‌نوشت، `summarizeCalibration()` همان
جمله را دوباره طبقه‌بندی می‌کرد، و چون طبقه‌بندِ نثرمحور نام‌های خودش را نمی‌شناخت هر دسته‌ای به `harnessError` فرومی‌ریخت
(بازتولیدشده: `connectionFailure`، `permissionDenied` و بالا نیامدن Docker، هر سه ← `harnessError`). اکنون دسته **یک بار**،
همان‌جا که خروجی خام فرزند هنوز در دست است، تثبیت می‌شود و از آن به بعد فقط نام‌های ثابتِ یک **واژگان یکتای صادرشده**
(`INFRASTRUCTURE_CATEGORY`) با یک **مسیر یکتای نرمال‌سازی/شمارش** (`normalizeCategories`/`countCategories`) سفر می‌کنند؛
طبقه‌بندِ نثرمحور حذف شد. نتیجهٔ زیرفرایند کراندار سه پایان را از هم تفکیک می‌کند (بالا نیامدن Launcher، خروج غیرصفر، عبور از
مهلت) و **کدام** Launcher ثابت (`docker`/`pnpm`/`jest`/`git`) و **کدام** ابزار درون‌تصویری (`psql`/`pgbench`) درخواست شده بود را
نگه می‌دارد — بی آرگومان، بی محیط، بی داده اتصال و بی متن خطای سیستم‌عامل. Suiteای که گزارش Jest تولید کرده و تستی در آن شکسته
**دستهٔ زیرساختی نمی‌گیرد**؛ تشخیص Controlها در یک **جمع صریح جداگانه** (`controlInfrastructure`) می‌آید و هر جفتِ تلاش‌شده در
مخرج می‌ماند. هیچ شیء نگه‌داشته‌شده یا متن گزارشی خروجی خام فرزند، URL، رمز، Token، نام کاربر، Host، IP، ردیف، شناسهٔ تست یا
پیام پرتاب‌شدهٔ دلخواه ندارد و `redact` ضعیف نشد. آزمون‌ها با تزریق یک زیرفرایند ساختگی، **خودِ این مسیر** را بی Docker و بی
PostgreSQL اجرا می‌کنند (`pnpm test:aggregation-evidence-lib` ‏۳۲/۳۲). افزون بر این، `pnpm check:test-phases` حالا **نبودِ**
Script ریشهٔ `calibrate:aggregation-stress` را هم نقض قرارداد می‌شمارد. هیچ آستانه، حاشیه، Classifier توانایی، Preflight یا
دروازه‌ای اضافه نشد و ADR-055 همچنان `Proposed` است.

**حالت صریح اعتبار: `INVALID` در برابر `INCONCLUSIVE` (2026-09-15).** گام قبلی **دسته** را درست کرد ولی **حکم** را نه:
نتیجهٔ Probe حالت صریحی نداشت و `summarizeCalibration()` هر `probe.valid === false` را `INVALID` می‌نامید، پس شکست اتصال،
نبودِ Docker/`psql`/`pgbench`، Timeout و `pg_stat_wal` ناخوانا همگی «نمونه‌ای که سنجیده شد و رد شد» گزارش می‌شدند — در حالی
که ADR-055 §§ ۳–۴ آن‌ها را `INCONCLUSIVE` می‌داند (بازتولید: `connectionFailure` با `outcome = INVALID`). اکنون خودِ نتیجهٔ
Probe یک حالت صریح از همان سه برچسب حمل می‌کند (`probe.outcome`؛ هیچ برچسب توانایی اضافه نشد)، `summarizeCalibration()`
آن را **می‌خواند** و دیگر از `problems` یا از `valid: false` استنتاج نمی‌کند، و `probe.valid` مشتقِ آن است (`true` تنها برای
`VALID`). نگاشت از یک جدول یکتا می‌آید (`CATEGORY_VALIDITY`، بی هیچ Regex): **`INCONCLUSIVE`** برای `missingEnvironment`،
`dockerUnavailable`، `pgbenchUnavailable`، `psqlUnavailable`، `connectionFailure`، `statsUnreadable`، `timeout`،
`harnessError` و هر شکست طبقه‌بندی‌نشده (`other`)؛ **`INVALID`** برای `permissionDenied`، `statsReset`،
`failedTransactions`، `controlContamination`، `backgroundWalContamination` و `noProgress`؛ و **`VALID`** تنها با نبودِ هر
تشخیص. اگر هر دو نوع هم‌زمان باشند **`INCONCLUSIVE` برنده است** و ترتیب ورود تشخیص‌ها پاسخ را عوض نمی‌کند. Probeای که اندازه
نگرفت **هیچ عدد ساختگی** ندارد (همهٔ میدان‌های عددی `null`، نه `0`)، ولی جفت در مخرج همهٔ توزیع‌ها با `available=0`
می‌ماند؛ در همین گام یک نشتِ عددی واقعی هم رفع شد که خروجی ناقص یک `pgbench` ناتمام را به‌شکل `longest_zero_commit_s = 0`
وارد توزیع می‌کرد. Control هم حالت صریح دارد و Controlِ اجرانشده `INCONCLUSIVE` است، نه `valid=no`. کران‌های عددی اعتبار،
SQL ‏Probe، ثابت‌های فشار، مجاورت جفت، نبود Retry، دستی‌بودن و معنای خروج غیرصفر **تغییر نکردند**، و
`pnpm test:aggregation-evidence-lib` اکنون ۳۶/۳۶ است.

**رد پیش‌شرط در سطح کمپین در برابر نامعتبری در سطح Probe (2026-09-15).** دو گام قبلی **دسته** و **حکم** را درست کردند،
ولی مسیر واقعی CLI به هیچ‌کدام نمی‌رسید: نقطهٔ ورود متغیرهای لازم را پیش از ساختن کمپین بررسی می‌کرد و بی‌درنگ با کد ۲
برمی‌گشت، پس گزارشِ **درخواست‌شده** هرگز نوشته نمی‌شد (بازتولید روی `5e51889`: `exit=2`، Artifact هیچ). اکنون این دو رویداد
صریحاً از هم جدا شده‌اند. **نامعتبری سطح Probe** یعنی اندازه‌گیری‌ای انجام شد و از کران‌های `PROBE_VALIDITY` افتاد؛ **رد
پیش‌شرط سطح کمپین** یعنی هیچ گامی اصلاً ساخته نشد — نبودِ `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`/
`DATABASE_URL_IDENTITY` یا Launcherِ jest که Resolve نمی‌شود. برای درخواست کالیبراسیونِ معتبر با مسیر خروجی نوشتنی، رد
پیش‌شرط **همچنان Artifact تجمیعی می‌نویسد** و **همچنان غیرصفر خارج می‌شود**: Control و هر جفتِ درخواست‌شده `INCONCLUSIVE`،
هر گام `not run`، `topology: measured=no`، هیچ عدد ساختگی، و هر جفت در مخرج همهٔ توزیع‌ها با `available=0`. **مخرج جمع
دسته:** جمع Preflight دامنهٔ **کمپین** دارد (`denominator=1 campaign`) و هرگز در سطرهای جفت کپی نمی‌شود — یک متغیر غایب یک
رویداد است، نه یکی به‌ازای هر جفت؛ گزارش چهار دامنهٔ متمایز نگه می‌دارد: Preflight کمپین، Control، جمع جفت‌ها و تشخیص‌های
Suite فشار. **معنای CLI تغییر نکرد:** آرگومان بدشکل یا نبودِ مسیر گزارش همچنان Usage و خروج ۲ بی Artifact است (هدف خروجی
معتبری وجود ندارد)، و شکست نوشتن گزارش غیرصفر می‌ماند بی فاش کردن مسیر، Credential، مقدار محیطی، خروجی خام فرزند یا متن
دلخواه استثنا. حالت `evidence` قدیمی و Schema گزارشش دست نخورد. برای آزمون‌پذیری قطعی، `runEvidenceCli({ argv, env, deps })`
صادر شد و نقطهٔ ورود **محافظت‌شده** است، پس Import کردن ماژول هیچ چیز را علیه زیرساخت اجرا نمی‌کند؛ آزمون‌های تازه
(`scripts/aggregation-evidence-cli.test.mjs`، بی Docker و بی PostgreSQL، فرایندهای فرزندِ کراندار با محیط ساخته‌شده از صفر)
ثابت می‌کنند نیمهٔ اندازه‌گیر در مسیر رد اصلاً صدا زده نمی‌شود. `pnpm test:aggregation-evidence-lib` اکنون **۴۲/۴۲** است.
هیچ آستانه، حاشیه، Classifier توانایی، Preflight در `run-test-phases.mjs`، دروازهٔ Fail-Fast یا اجرای کالیبراسیون در CI
معمول اضافه نشد و **هیچ نمونهٔ زنده‌ای جمع نشد**.

**کامل شدن مرز رد پیش از اندازه‌گیری (2026-09-15).** بند بالا ادعا کرد «رد پیش‌شرط همچنان Artifact تجمیعی می‌نویسد»،
ولی آن گام فقط دو علت را پوشش داده بود (نام‌های غایب محیط، و Launcher ‏jest). سه مسیر دیگر هنوز پیش از هر اندازه‌گیری
و **بی Artifact** رد می‌کردند: خواندن Spec فشار و ساخت Plan (پرتاب به `catch` بالایی)، قرارداد ایستا (`return 1` بی
نوشتن گزارش) و ساخت پوشهٔ موقت. **بازتولید روی `5e949a3`:** با محیط کامل و Specِ ناخوانا، `THREW=yes`، `EXIT=1`،
`ARTIFACT=none`. اکنون آماده‌سازی **یک مرز صریح** است: `prepareCampaign()` در یک گذر محیط، Launcher، Spec، Plan،
قرارداد ایستا و در آخر پوشهٔ موقت را می‌سنجد و یا **Planِ اعتبارسنجی‌شده** را تحویل می‌دهد یا تشخیص‌های سطح‌کمپین را؛
`runMeasuredCampaign()` همان Plan را می‌گیرد و نه دوباره Plan می‌سازد و نه قرارداد را دوباره می‌سنجد (قرارداد دقیقاً یک
بار)، و نخستین دستورش نخستین اندازه‌گیری است — پس نیمهٔ اندازه‌گیر پس از هر رد دست‌نیافتنی است. هر رد همان Artifact
گام قبل را می‌نویسد (`0 attempted`، Control و هر جفت `INCONCLUSIVE`، همه `not run`، `topology: measured=no`، هر جفت در
مخرج با `available=0`، بی عدد ساختگی) و غیرصفر می‌ماند. **یک کمپینِ رد شده یک رویداد است:** چند Finding قرارداد **یک**
`harnessError` می‌شود، نه چند تا، با نقل‌قول کراندار (≤۵ Finding، ≤۲۰۰ نویسه) از جمله‌های ثابت خود Repository — بی
محتوای Spec، بی مسیر، بی متن استثنا — و مخرجش همچنان یک کمپین است. رد قرارداد **نه `INVALID` است و نه شکست تست
محصول**. کدهای خروج معنادار و دست‌نخورده‌اند: `2` پیش‌شرط کمپین، `1` قرارداد ایستای Repository. پوشهٔ موقت آخر ساخته
و در `finally` پس از موفقیت و شکست آزاد می‌شود. `pnpm test:aggregation-evidence-lib` اکنون **۴۹/۴۹** است (۳۶ Helper +
۱۳ CLI/Runner). هیچ آستانه، حاشیه، Classifier توانایی، Preflight فاز، دروازهٔ Fail-Fast یا اجرای کالیبراسیون در CI
اضافه نشد و **هیچ نمونهٔ زنده‌ای جمع نشد**.

**نخستین مجموعهٔ جفت‌شدهٔ آرام — و چرا هنوز آستانه نمی‌دهد (2026-09-15).** همهٔ گام‌های بالا ابزار ساختند و هیچ‌کدام
نمونه‌ای جمع نکرد. اکنون نخستین مجموعه هست. **روی میزبان محلی جمع نشد** و نباید می‌شد: Stack ‏Compose موجود `rasta`
شانزده سرویس با `restart: unless-stopped` دارد و روشن کردن Daemonِ خاموشِ Docker، `rasta-postgres` و همسایه‌هایش را
دوباره راه می‌انداخت — و اندازه‌گیری نرخ Commit کنار Kafka/Keycloak/Temporalِ زنده روی یک VM و یک دیسک، آرام نیست
(۱۴٫۶–۲۳٫۰ روی Volume مشترک در برابر ۲۶٫۰–۲۶٫۶ روی نمونهٔ یک‌بارمصرف، همان Probe). پس یک **Workflow موقت و
فقط‌شاخه‌ای** روی Runner ‏**بومی Ubuntu** با **دقیقاً یک** Service Container (`postgis/postgis:16-3.4`، بی Kafka،
Redis، Keycloak، Temporal یا هر سرویس برنامه) یک کمپین **۲۰ جفتی** گرفت و **در همان تکرار حذف شد**؛ `ci.yml`، فازهای
تست، `pnpm verify` و Harness دست نخوردند. مبدأ: Commit ‏`89ebe99`، اجرای `34989897833` (تلاش ۱، `success`)، گام کمپین
‏۳۹ دقیقه و ۳۸ ثانیه، خروج ۰. محیط: ‏`Ubuntu 24.04.5 LTS`/`ubuntu24/20260907.300.1`، ۴ CPU، ۱۵٫۶GiB، `overlay2`،
PostgreSQL ‏۱۶٫۴، `fsync=on`، `synchronous_commit=on`، `wal_sync_method=fdatasync`، `shared_buffers=128MB`.
**نتیجه** (`docs/evidence/adr-055/quiet-calibration-github-2026-09-15.txt`): `VALID=20`، `INVALID=0`،
`INCONCLUSIVE=0`؛ Control ‏`VALID`؛ Suite فشار **۲۰/۲۰ گذشته** (هر اجرا ۱/۱ Suite، ۲۲/۲۲ تست)؛ `probe_tps`
‏۲٬۴۹۴٫۸ / ۳٬۲۶۸٫۲۳ / ۳٬۷۹۷٫۵۱ (کمینه/میانه/بیشینه)، `probe_min_interval_tps` ‏۴۰۵ / ۱٬۰۱۳٫۹۵ / ۲٬۱۷۴٫۳،
`probe_longest_stall_s` همگی ۰، `stress_wall_s` ‏۲۰٫۴۱ / ۵۷٫۶۴ / ۵۹٫۷۸؛ و **۰** تشخیص زیرساختی در هر چهار دامنه.
Artifact پیش از ورود به Git با ۴۸ بررسی مستقل سنجیده شد (واژگان، ۲۰ سطر با شناسهٔ یکتا، مجاورت Probe→Stress، تطابق همهٔ
جمع‌ها و توزیع‌های بازمحاسبه‌شده با سطرها، جدایی چهار دامنه، و نبود URL/Credential/Token/مسیر مطلق/نام کاربر یا
میزبان/IP/متن خام استثنا/ردیف/شناسهٔ تست). **یک محدودیت صریح:** شبکهٔ میزبان `*.blob.core.windows.net` را مسدود می‌کند،
پس `gh run download` ممکن نشد و متن از **Log همان اجرا** استخراج شد — همان رشته‌ای که Harness پیش از نوشتن فایل چاپ
می‌کند — تنها با حذف پیشوند زمانی GitHub؛ هیچ عددی دست‌کاری نشد. **و چرا این هنوز آستانه نمی‌دهد:** این توزیع، محیطی را
نشان می‌دهد که اثبات در آن همیشه و با فاصله گذشته (کمترین `probe_tps` هنوز ۲٬۴۹۴٫۸، بی هیچ وقفه)، پس فقط می‌گوید مرز
«خیلی پایین‌تر» است. **نمونهٔ شکستِ ناشی از محیط وجود ندارد**، ADR-055 § ۶ همچنان هیچ عددی را مجاز نمی‌کند، و کران
بی‌Provenance ۲۹٫۲ سر جایش است. هیچ آستانه، حاشیه، Classifier توانایی، Preflight فاز، دروازهٔ Fail-Fast، Bypass، Retry،
Skip-Green، بار القایی یا اجرای کالیبراسیون در CI معمول اضافه نشد.

**نخستین تلاش القایی برای سمت شکست — ناتمام، و مسدودکننده‌اش (2026-09-15).** نیمهٔ دوم مجموعه‌دادهٔ ADR-055 § ۶
(نمونهٔ شکستِ **ناشی از محیط**) تلاش شد و **جمع نشد**. یک Workflow موقت و فقط‌شاخه‌ای
(`aggregation-stress-induced-calibration.yml`) روی Commit ‏`9b03ac0`، با همان توپولوژی کمپین آرام — Runner بومی
Ubuntu یک‌بارمصرف، **دقیقاً یک** Service Container ‏`postgis/postgis:16-3.4`، بی هر سرویس دیگر — پس از Provisioning
و Migration همان یک Container را با فیلتر دقیق تصویر یافت و یک **سهمیهٔ CFS ثابت و بیرونی** روی آن گذاشت:
`CPU_PERIOD_US=1000000`، `CPU_QUOTA_US=5000` (**۰٫۰۰۵ CPU**)، بازخوانده و **دقیقاً تأییدشده** با یک
`docker inspect --format` دو‌فیلدی (`applied_cpu_period_us=1000000`، `applied_cpu_quota_us=5000`). نه بار SQL، نه
بار جانبی، نه WAL پس‌زمینه، نه Pause/Kill، نه تغییر تنظیم PostgreSQL، و بدون تغییر در Spec، Probe،
`PROBE_VALIDITY`، Selectorها، Timeoutها یا Harness. هیچ Docker یا PostgreSQL محلی لمس نشد.
**نتیجه:** اجرای `34997524401` (تلاش ۱) — گام‌های ۱..۱۲ `success`، گام کمپین `16:51:55Z` تا `19:51:01Z` با **مهلت
۱۸۰ دقیقه‌ای Job** کشته شد (`cancelled`)، و Upload با `if-no-files-found: error` شکست خورد چون **فایلی نوشته نشده
بود**. **هیچ Artifact‌ی تولید، اعتبارسنجی یا Commit نشد.** Control ‏`PASS` و `pair-1-probe` ‏**`PASS`** (۶۷ ثانیه) —
یعنی Probe زیر این سهمیه همچنان **معتبر** ماند — ولی `pair-1-stress` از `16:53:18Z` **۲ ساعت و ۵۷ دقیقه و ۴۳ ثانیه**
هیچ خروجی نداد. **دو مسدودکنندهٔ مستقل:** (۱) یک اجرای دست‌نخوردهٔ Suite زیر این سهمیه از کران ۳۰ دقیقه‌ای Harness
می‌گذرد (۲۲ تست — `testTimeout` پیش‌فرض ۶۰ ثانیه با Overrideهای ۱۵s تا ۱۲۰s — روی پایگاه داده‌ای با ۵ms CPU در هر
ثانیه)، پس ۲۰ جفت در ۱۸۰ دقیقه جا نمی‌شود؛ و (۲) آن کران در عمل خاتمه نمی‌دهد — `runBounded` فقط `child.kill('SIGKILL')` روی خودِ `pnpm` می‌زند، نوه‌ها
(`turbo`/`jest`) همان `stdout`/`stderr` را نگه می‌دارند، و رویداد `close` که Promise با آن حل می‌شود هرگز نمی‌آید.
این نقص در کمپین آرام پنهان بود چون بیشینهٔ `stress_wall_s` آنجا ۵۹٫۷۸ ثانیه بود. اصلاح کران، گامی **جدا** و
پیش‌شرط هر کمپین القایی بعدی است. **شمار جفت‌های `VALID` با Suite شکست‌خورده: صفر؛ الزام سمت شکستِ § ۶ برآورده
نشد.** Workflow موقت **در همان تکرار حذف شد**؛ `ci.yml`، فازهای تست، `pnpm verify` و Harness دست نخوردند و هیچ
آستانه، حاشیه، Classifier توانایی، Preflight فاز، دروازهٔ Fail-Fast، Bypass، Retry یا Skip-Green اضافه نشد.

**ماه اختصاصی اجرا برای زنجیرهٔ Platform در Fixtureهای audit (2026-09-14).** کلید زنجیرهٔ Tenant شناسهٔ سازمانِ دارای `RUN_TAG`
را دارد و خودبه‌خود به هر اجرا اختصاص دارد؛ کلید زنجیرهٔ Platform ‏(`PLATFORM/(platform)/<ماه>`) هیچ Tag یا Tenantی ندارد. پس
هر Suite ‏Integration در `audit-service` که ردیف `organizationId: null` می‌نویسد باید زمان آن را از یک Slot اختصاصی
`runMonth(slot)` با `instantIn` بگیرد (Slotهای فعلی: `ingestion` ۰، `hash-chain` و `trail-ingestion` ۱، `correction-linkage` ۷،
`tenant-isolation` ۸) و پنجره‌های Query را هم از همان ماه بسازد، نه از ساعت دیوار. پنجرهٔ ثابت `2026-10` در `fixtures.ts`
(`at()`/`queryWindow()`) فقط برای Suiteهایی درست است که زنجیرهٔ Platform مشترک نمی‌سازند یا مالکیت انحصاری را جداگانه ثابت
می‌کنند. **نشانه:** اجرای هم‌زمان یا نیمه‌کارهٔ دو فرایند در یک ماه ثابت ردیف بیگانه در زنجیرهٔ Platform یکدیگر می‌گذارد و
`cleanupRun` هر دو را (به‌درستی) رد می‌کند؛ راه حل ماه اختصاصی است، نه ضعیف کردن آن رد.

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
pnpm test:integration           # نیازمند Docker (دو فاز: موازی، سپس اثبات فشار تجمیع به‌تنها)
pnpm test:aggregation-stress    # فقط اثبات فشار تجمیع identity، به‌تنها (§ ۱۴٫۳)
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

**قرارداد داشبورد محلی Grafana (2026-09-13).** `scripts/check-grafana-dashboard-lib.mjs` (فقط Node built-in) با CLI
`pnpm run check:grafana-dashboard` و آزمون‌های `node:test` در `pnpm run test:grafana-dashboard-lib` در `pnpm verify` و گام
«Grafana dashboard contract» در Job ‏`quality` CI اجرا می‌شود (آزمون‌های Checker اول). Checker روی داشبورد
`Rasta Audit Evidence` و Provisioning آن با خروج غیرصفر و پیام مشخص رد می‌کند: JSON نامعتبر؛ UID/عنوان/Tag نادرست؛ نبودن
بازهٔ زمانی یا Refresh صریح؛ ID غیرمثبت یا تکراری Panel، Panel بیرون از شبکهٔ ۲۴ ستونی یا هم‌پوشان؛ هر `datasource` که دقیقاً
`{"type":"prometheus","uid":"rasta-prometheus"}` نباشد (از جمله نام، متغیر Datasource، `${DS_…}`، `__inputs` و نوع دیگر) و هر URL
بیرونی؛ Target پنهان، Query خالی یا Panel بی Query؛ هر Label گروه‌بندی/Join/Matcher یا Legend بیرون از فهرست بستهٔ Labelهای
کراندار؛ هر شناسهٔ ممنوع (tenant، actor، resource، event/correlation id، partition، offset، error/message) در Query یا Legend و شکل
snake/camel آن‌ها در عنوان و توضیح؛ استفادهٔ `rasta_security_event_outbox_pending_age_seconds` یا `rasta_audit_partition_rows`؛
نبودن چهار عبارت مرز (local development telemetry، no Alertmanager، no notification delivery، absence of alerts is not proof…) در
Panel متن **و** توضیح داشبورد؛ و نبودن هر خانوادهٔ سیگنال لازم با **عبارت دقیق** هشدار متناظر. نام هشدارها و Recording Rule از خود
`rasta-audit-alerts.yml` خوانده می‌شود، پس هشدار تازه‌ای که به Query ‏`ALERTS` افزوده نشود دروازه را شکست می‌دهد؛ Provider
(`type: file`، پوشهٔ `Rasta`، `disableDeletion: true`، `allowUiUpdates: false`، مسیر `/etc/grafana/dashboards`)، UID و URL
Datasource و Mount فقط‌خواندنی Compose هم سنجیده می‌شوند. ۲۱ آزمون جهش‌محور روی کپی تازهٔ همان JSON واقعی اثبات می‌کنند Checker
می‌گیرد: ID تکراری و صفر، Panelهای هم‌پوشان و بیرون از شبکه، UID نادرست Target، Datasource با نام/متغیر/نوع دیگر و URL بیرونی،
Target پنهان/Query خالی/Panel بی Query، حذف یک هشدار از `ALERTS` و هشدار تازهٔ Rules، ده جهش خانوادهٔ سیگنال (Job، Throughput،
p95، گروه `trail`، Recording Rule، `scope` زنجیره، `failed|timeout`، سن پشتهٔ بسته، Gate تولیدکننده، Selector ‏DLQ)، `tenant_id`
در `by`، `{{actor_id}}` در Legend، Matcher ‏`partition`، `correlationId` در توضیح، `pending_age`، حذف عبارت مرز از Panel و توضیح،
پنج جهش Provisioning، و CLI روی JSON نامعتبر (خروج ۱) و ریشهٔ سالم (خروج ۰).

**قرارداد راه‌اندازی Grafana محلی (2026-09-13).** همان Checker (`checkGrafanaStartup`) رد می‌کند: نبودن، مقدار ناامن، مقدار بی
Quote یا تکرار هر یک از پنج متغیر `GF_ANALYTICS_REPORTING_ENABLED`، `GF_ANALYTICS_CHECK_FOR_UPDATES`،
`GF_ANALYTICS_CHECK_FOR_PLUGIN_UPDATES`، `GF_NEWS_NEWS_FEED_ENABLED` (`'false'`) و `GF_PLUGINS_PREINSTALL_DISABLED` (`'true'`)
در بلوک `environment` خودِ سرویس `grafana` (همان متغیر روی سرویس دیگر پذیرفته نیست)؛ نبودن، خالی بودن یا محتوای دیگر
`provisioning/plugins/rasta.yml` (دقیقاً `apiVersion: 1` و `apps: []`) و `provisioning/alerting/rasta.yml` (دقیقاً
`apiVersion: 1`) — از جمله هر App، `groups`، `contactPoints`، `policies`، `templates`، `muteTimes`، `deleteRules` یا
`resetPolicies` — و هر فایل دیگر (مثلاً `.gitkeep` یا YAML دوم) در آن دو پوشه. هفت آزمون تازه (روی هم ۲۸) حالت مثبت، ۲۰ جهش
Compose (چهار حالت برای هر متغیر)، متغیر روی سرویس دیگر و سرویس `grafana` غایب، پنج جهش فایل Plugins، دو App اعلام‌شده، هشت
اعلان Alerting و فایل اضافه/غایب را پوشش می‌دهند؛ خاموش کردن هر یک از سه بخش Checker به ترتیب ۲، ۳ و ۱ آزمون را شکست داد.
از 2026-09-14 متغیر ششم `GF_PLUGINS_PUBLIC_KEY_RETRIEVAL_DISABLED` (`'true'`) هم در همان فهرست است، پس همان حلقه ۲۴ جهش Compose
می‌سازد (هنوز ۲۸ آزمون)؛ نخستین اجرای زندهٔ بی مسیر بیرونی (پایین) نشان داد بدون آن Grafana برای دانلود کلیدهای امضای Plugin از
grafana.com یک خط `level=error` از `plugin.signature.key_retriever` Log می‌کند.

**اعتبارسنجی زندهٔ Provisioning و PromQL، روی شبکهٔ بی مسیر بیرونی (از 2026-09-14).** `pnpm run verify:grafana-dashboard-live`
(دستی، Docker لازم، بیرون از `pnpm verify`) Prometheus `v3.1.0` و Grafana `11.5.1` را با نام‌های یکتای `rasta-dashcheck-<suffix>-*`
و Mount فقط‌خواندنی پیکربندی واقعی مخزن روی شبکهٔ یکتای `docker network create --internal` و **بی هیچ Port منتشرشده** بالا
می‌آورد، پس به Stack Compose توسعه‌دهنده دست نمی‌زند. Docker Desktop 29.7.2/WSL2 برای Containerی که فقط به شبکهٔ Internal وصل است
Port میزبان منتشر نمی‌کند (آزمایش 2026-09-13)، پس Assertionهای HTTP در `scripts/verify-grafana-dashboard-probe.mjs` داخل Container
کوتاه‌عمر `node:22-alpine` روی همان شبکه اجرا می‌شوند که مخزن را فقط‌خواندنی به‌عنوان Working Directory دارد، با `--user node`،
`--read-only`، `--cap-drop ALL` و `no-new-privileges`، بی Socket ‏Docker، و فقط از راه Aliasهای `http://prometheus:9090` و
`http://grafana:3000` (Probe هر URL جز `http://<alias>:<port>` را رد می‌کند؛ گذرواژهٔ تصادفی Grafana فقط با نام `-e` به CLI ‏Docker
داده می‌شود و در Argv یا خروجی نمی‌آید). هر سه Image پیش از ساخت شبکه موجود یا Pull می‌شوند و Containerها با `--pull never`
ساخته می‌شوند. Orchestrator میزبان از `scripts/verify-grafana-dashboard-isolation-lib.mjs` (Docker تزریقی) اثبات می‌کند: `docker network
inspect` دقیقاً یک شبکه با همان نام و `Internal` بولی `true` برمی‌گرداند؛ و `docker container inspect` هر سه Container را فقط به همان
شبکه (و `NetworkMode` همان) وصل و بی هیچ Binding در `HostConfig.PortBindings`، `NetworkSettings.Ports` یا `PublishAllPorts`
نشان می‌دهد — یک بار پیش از شروع Probe و دوباره، همراه با Inspect دوبارهٔ شبکه، پس از خروج آن؛ Probe باید با کد خروج `0` تمام شود
و Prometheus و Grafana هنوز در حال اجرا باشند. Probe اثبات می‌کند: Prometheus سیزده هشدار و یک Recording Rule را بار کرد؛ Datasource با UID ‏`rasta-prometheus`، URL
`http://prometheus:9090`، پیش‌فرض و `proxy` است و Health آن از Grafana `OK` است؛ داشبورد با UID و عنوان دقیق، `provisioned=true`،
در پوشهٔ `Rasta` با تعداد Panel/Target فایل برمی‌گردد و هر Target برگشتی همان UID را دارد؛ `DELETE` داشبورد با `400` رد می‌شود و
داشبورد می‌ماند؛ هر ۱۴ Query (با جایگزینی `$__rate_interval` با `5m` فقط در Harness) در `/api/v1/query` Prometheus و از راه
`/api/ds/query` Grafana موفق است (نتیجهٔ خالی پذیرفته است، خطای Parser نه)؛ `GET /d/rasta-audit-evidence` → `200`؛ هیچ App
Plugin غیرهسته‌ای نصب نیست، Grafana هیچ Alert Rule ندارد و هیچ Contact Point یا Policy آن Provision نشده است. سپس Orchestrator
(نه Probe، که به Docker دسترسی ندارد) نشان می‌دهد Log Grafana
**صفر** خط `level=error` یا `level=crit` و صفر خط نصب Plugin دارد و شاهد مثبت پایان Provisioning Datasource (با UID)، داشبورد و
Alerting را نشان می‌دهد (از 2026-09-13؛ پیش از آن دو خطای پوشهٔ غایب `plugins`/`alerting` پذیرفته می‌شد). Harness متغیرهای
بی‌تماس بیرونی Compose را از `EXPECTED.grafanaNoOutboundEnv` می‌خواند. کنترل منفی: با برداشتن موقت دو پوشه، Harness با دقیقاً همان
دو خطا شکست خورد. Harness دقیقاً سه Container (با Volumeهای بی‌نامشان) و شبکهٔ خودش را در
هر حالت حذف و نبودن Container، شبکه و آن Volumeها را گزارش می‌کند. Rendering پیکسلی سنجیده نمی‌شود (Image Renderer نصب نیست) و
دادهٔ واقعی سرویس‌ها در این اجرا Scrape نشد.

**شواهد اجرای بی مسیر بیرونی (2026-09-14).** نخستین اجرا روی شبکهٔ Internal با وجود عبور هر ۱۴+۱۴ Query شکست خورد: یک خط
`level=error` از `plugin.signature.key_retriever` (`Get "https://grafana.com/api/plugins/ci/keys": … server misbehaving`)؛ پاک‌سازی
کامل بود. پس از افزودن `GF_PLUGINS_PUBLIC_KEY_RETRIEVAL_DISABLED` به Compose و ثابت مشترک، اجرا سبز شد: `internal=true`، سه
Container فقط روی همان شبکه و `publishedPorts=0` پیش و پس از Probe، Probe به هر دو Alias رسید و با `0` خارج شد، ۱۴ Query مستقیم و
۱۴ Query از Grafana، ۰ خط خطا و ۰ خط نصب Plugin، و پاک‌سازی بی Container، شبکه یا Volume باقی. `pnpm run
test:grafana-live-isolation-lib` (`scripts/verify-grafana-dashboard-isolation.test.mjs`، ۱۰ آزمون با Docker جعلی، در `pnpm verify`
و گام «Grafana dashboard contract» در CI) آرگومان `--internal`، رد `Internal=false`/`"true"`/خروجی خالی، ناقص، چندتایی یا نام
دیگر/شکست Inspect، شبکهٔ اضافه، اشتباه یا غایب، Binding منتشرشده، URLهای غیر Alias در Probe، و Wiring خودِ `verifyLive` (Inspect
پیش و پس از Probe، بی `-p`، بی گذرواژه در Argv، پاک‌سازی در هر شکست) را می‌پوشاند. این آزمون‌ها Docker واقعی اجرا **نمی‌کنند**.
کنترل‌های منفی: حذف `--internal` ۴ آزمون، دور زدن Inspect دقیق شبکه ۴، یک Binding ساختگی در Fixture جعلی ۴، دور زدن بررسی Port
۲ و دور زدن Helper در Orchestrator ۳ آزمون را شکست داد. **مرز:** این فقط اثبات می‌کند همین Stack یک‌بارمصرف بی مسیر بیرونی بالا
می‌آید و بررسی‌هایش را کامل می‌کند؛ اثبات نمی‌کند شبکهٔ Compose توسعه محدود است، و سیاست شبکهٔ Production نیست.

**در CI:** Unit و Contract موازی روی هر Push · Integration و Security روی هر PR ·
E2E روی `main` پس از استقرار Staging · Load شبانه.
