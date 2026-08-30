# ۲۵ — حاکمیت Backlog و سنجش پیشرفت

> **وضعیت:** اجرایی · **منبع محاسبه:** `planning/backlog.json` · **گزارش تولیدشده:** `docs/25-project-progress.md`

این سند پاسخ می‌دهد که «رستا چند درصد پیش رفته است؟» از این پس چگونه بدون قضاوت لحظه‌ای، شمارش سرویس‌ها یا ادعای شفاهی پاسخ داده می‌شود.

## ۲۵٫۱ اصل اندازه‌گیری

واحد سنجش، **Story Point پذیرفته‌شده** است. Story Point زمان یا نفر-ساعت نیست؛ اندازه نسبی پیچیدگی، ریسک، ابهام و تلاش لازم برای رسیدن به معیار پذیرش است.

```text
Progress = accepted story points / active committed story points × 100
```

- فقط وضعیت `ACCEPTED` امتیاز کسب می‌کند.
- `IN_PROGRESS` حتی اگر «تقریباً تمام» باشد، صفر امتیاز کسب می‌کند.
- `CANCELLED` از صورت و مخرج حذف می‌شود؛ حذف Scope باید در Change Log دلیل و مرجع تصویب داشته باشد.
- Design، Code، Test یا CI به‌تنهایی Done نیستند؛ همه معیارهای پذیرش آیتم و Definition of Done در `AGENTS.md` باید برقرار باشند.
- MVP فقط آیتم‌های `scope=MVP` را می‌سنجد. Full Product تمام آیتم‌های فعال MVP و Post-MVP را می‌سنجد.

این مدل عمداً «درصد تکمیل هر آیتم» ندارد. ثبت ۸۰٪ برای Story باعث می‌شود کارهای ناتمام ارزش تحویل‌شده نشان داده شوند و جمع درصدها قابل حسابرسی نباشد.

## ۲۵٫۲ منبع حقیقت

| فایل                           | نقش                                            |
| ------------------------------ | ---------------------------------------------- |
| `planning/backlog.json`        | Backlog مرجع و تنها ورودی محاسبه               |
| `planning/backlog.schema.json` | قرارداد ماشین‌خوان برای Editor و ابزارها       |
| `scripts/progress-lib.mjs`     | اعتبارسنجی قواعد و محاسبه                      |
| `scripts/progress.mjs`         | رابط Validate، تولید گزارش و کنترل Staleness   |
| `scripts/progress.test.mjs`    | آزمون قواعد اصلی سنجش                          |
| `docs/25-project-progress.md`  | Snapshot خواندنی و خودکار؛ ویرایش مستقیم ممنوع |

اگر سند دیگری عدد متفاوتی نشان دهد، عدد تولیدشده از Backlog مرجع است؛ البته تا وقتی Baseline در حالت `PROVISIONAL` است، Story Pointها هنوز تعهد تأییدشده مالک محصول نیستند.

## ۲۵٫۳ سلسله‌مراتب و فیلدها

```text
Product horizon (MVP / POST_MVP)
└── Epic
    └── Backlog item
        ├── Story Points
        ├── Priority (P0..P3)
        ├── Acceptance Criteria
        ├── Dependencies
        ├── Source references
        └── Evidence
```

هر Backlog Item باید:

1. یک خروجی قابل‌پذیرش داشته باشد، نه فعالیت مبهمی مانند «کار روی Supplier»؛
2. حداقل یک معیار پذیرش قابل آزمون داشته باشد؛
3. به سند Scope، ADR یا الزام Repository ارجاع دهد؛
4. فقط از مقیاس Fibonacci یعنی `1, 2, 3, 5, 8, 13, 21` استفاده کند؛
5. اگر بزرگ‌تر از ۲۱ است، پیش از Ready شدن شکسته شود؛
6. وابستگی‌ها را صریح و بدون چرخه ثبت کند.

## ۲۵٫۴ گردش وضعیت

| وضعیت         | معنا                                              | امتیاز کسب‌شده |
| ------------- | ------------------------------------------------- | -------------: |
| `PROPOSED`    | در نقشه محصول وجود دارد، اما برای اجرا آماده نیست |              ۰ |
| `READY`       | Scope، معیار پذیرش و وابستگی روشن است             |              ۰ |
| `IN_PROGRESS` | اجرای واقعی شروع شده است                          |              ۰ |
| `BLOCKED`     | به تصمیم انسانی یا وابستگی خارجی نیاز دارد        |              ۰ |
| `ACCEPTED`    | معیارها و DoD با Evidence پذیرفته شده‌اند         | کل Story Point |
| `CANCELLED`   | با تصمیم ثبت‌شده از Scope فعال خارج شده است       | خارج از محاسبه |

گذار معمول:

```text
PROPOSED → READY → IN_PROGRESS → ACCEPTED
                     ↕
                   BLOCKED
```

بازگرداندن `ACCEPTED` به وضعیت دیگر فقط برای اصلاح یک پذیرش اشتباه مجاز است و باید با `STATUS_CORRECTED` در Change Log ثبت شود.

## ۲۵٫۵ Definition of Ready و Definition of Accepted

### Ready

- ارزش یا خروجی محصول روشن است؛
- معیار پذیرش آزمون‌پذیر است؛
- مالک دامنه، Scope و Priority مشخص‌اند؛
- وابستگی و Open Question مسدودکننده نام‌گذاری شده است؛
- Story Point در جلسه برآورد تعیین شده است.

### Accepted

- تمام Acceptance Criteria همان آیتم برقرار است؛
- Definition of Done در `AGENTS.md` متناسب با دامنه پاس شده است؛
- حداقل یک Evidence معتبر ثبت شده است؛
- برای قابلیت دارای داده مستأجر، Tenant Isolation Test وجود دارد؛
- برای دامنه حساس، تست‌های مالی/امنیتی/E2E لازم سبزند؛
- نتیجه توسط مالک محصول یا نماینده صریحاً مجاز او پذیرفته شده است.

Evidence معتبر شامل Commit، PR، CI، Test، Live Runtime یا سند ثبت‌کننده Evidence است. صرف نوشتن عبارت «Done» یا `READY_FOR_NEXT_PHASE` Evidence نیست.

## ۲۵٫۶ برآورد و تغییر Scope

Baseline نخست از Scope رسمی `docs/17` و ADR-044 تا ADR-048 ساخته شده، اما برای جلوگیری از جعل تصمیم انسانی با وضعیت `PROVISIONAL` ثبت شده است. تبدیل آن به `APPROVED` نیازمند این دو تغییر هم‌زمان است:

1. `governance.baselineState = APPROVED` و ثبت نام/نقش تأییدکننده در `approvedBy`؛
2. افزودن `BASELINE_APPROVED` با `approvalRef` به `changeLog`.

پس از شروع یک آیتم، Story Point آن برای بهتر نشان دادن Velocity یا درصد تغییر نمی‌کند. اگر Scope واقعاً عوض شد:

- کار جدید به آیتم جدا تبدیل می‌شود؛ یا
- تغییر Point با `POINTS_CHANGED`، دلیل، تاریخ و Approval Reference ثبت می‌شود.

افزودن یا حذف Scope نیز باید `SCOPE_ADDED` یا `SCOPE_REMOVED` داشته باشد. آیتم حذف‌شده پاک نمی‌شود؛ `CANCELLED` می‌شود تا Audit Trail باقی بماند.

## ۲۵٫۷ Iteration، Velocity و پیش‌بینی

- برنامه هر Iteration در آرایه `iterations` ثبت می‌شود و آیتم هدف `targetIteration` می‌گیرد.
- Velocity هر Iteration فقط مجموع Point آیتم‌هایی است که در همان Iteration به `ACCEPTED` رسیده‌اند.
- تا کمتر از دو Iteration واقعی بسته شده باشد، سیستم عمداً Velocity و تاریخ پایان ارائه نمی‌کند.
- پس از آن نیز Average Velocity «تعهد زمانی» نیست؛ فقط throughput تاریخی است.
- Story Point تیم‌های متفاوت مستقیماً با هم مقایسه نمی‌شود. Baseline فعلی در سطح یک تیم/جریان محصول واحد تعریف شده است.

## ۲۵٫۸ نقش‌ها و چرخه به‌روزرسانی

| نقش                        | مسئولیت                                        |
| -------------------------- | ---------------------------------------------- |
| Product Owner              | Scope، Priority، پذیرش و تغییر Baseline        |
| Technical Lead             | شکستن آیتم، وابستگی، ریسک و Evidence فنی       |
| Delivery Agent / Developer | تغییر Status و ثبت Evidence در همان PR         |
| CI                         | رد Backlog نامعتبر، گزارش stale یا آزمون شکسته |

در هر PR مرتبط با قابلیت:

1. شناسه Backlog Item در توضیح PR ذکر می‌شود؛
2. Status و Evidence هم‌زمان با واقعیت تغییر می‌کند؛
3. `asOf` به تاریخ تغییر Backlog به‌روزرسانی می‌شود؛
4. گزارش دوباره تولید می‌شود؛
5. CI تطابق گزارش و Backlog را کنترل می‌کند.

## ۲۵٫۹ فرمان‌های عملیاتی

```bash
pnpm progress:validate  # فقط اعتبارسنجی Backlog و روابط
pnpm progress:report    # بازتولید گزارش خواندنی
pnpm progress:check     # اعتبارسنجی + رد گزارش stale
pnpm test:progress      # آزمون موتور محاسبه و قواعد ضد دستکاری
```

`pnpm verify` نیز دو کنترل آخر را اجرا می‌کند. GitHub Actions آن‌ها را پیش از Lint در Job کیفیت اجرا می‌کند.

## ۲۵٫۱۰ Baseline آغازین

Baseline مورخ ۲۰۲۶-۰۸-۳۰ شامل ۴۷ آیتم و ۱۲ Epic است. قابلیت‌های پیاده‌شده فقط زمانی `ACCEPTED` شده‌اند که در `PROJECT_MEMORY.md` یا CI اصلی شاهد قابل‌ردیابی دارند. موارد طراحی‌شده اما فاقد UI تولیدی، و سرویس‌های برنامه‌ریزی‌شده، امتیاز کسب نکرده‌اند.

عدد جاری همیشه از [گزارش تولیدشده](25-project-progress.md) خوانده می‌شود. این بخش عمداً درصد ثابت ندارد تا با تغییر Backlog stale نشود.
