# Runbook: استقرار marketplace-service — تخلیهٔ Saga سفارش (D-053)

**شدت:** ⚪ عملیاتی
**هشدار محرک:** ندارد — هر استقرار marketplace-service که یک طرفش نسخه‌ای بی D-053 است (بی جدول `saga_step`، پیش از #283):
نخستین استقرار #283، استقرار محیطی که از روی نسخه‌ای قدیمی‌تر جلو می‌رود، و بازگشت به نسخه‌ای قدیمی‌تر. اگر نمی‌دانی نسخهٔ
در حال اجرا D-053 دارد یا نه، ندارد.
**دامنه:** Worker ـِ Saga سفارش (`orderSaga` روی Task Queue ـِ `MARKETPLACE_TEMPORAL_TASK_QUEUE`، پیش‌فرض `rasta-order`).

---

## چرا

Worker ـِ Saga درون فرایند خود سرویس اجرا می‌شود: هر نمونه با `MARKETPLACE_TEMPORAL_ENABLED=true` آن را دارد. Activity ـی که
Worker قدیمی اثرش را Commit کرده و تکمیلش به Temporal نرسیده، پس از استقرار به Worker تازه Retry می‌شود. Worker قدیمی رسید
`saga_step` نمی‌نویسد؛ Worker تازه چنین اثری را فقط از روی تاریخچهٔ سفارش می‌شناسد، و آن مسیر بر ساعت تکیه دارد
(`SAGA_CLOCK_SKEW_MS`، ۵ ثانیه — [`docs/23`](../23-risks-and-tradeoffs.md) D-053). با اختلاف بیشتر میان ساعت Temporal و
نویسندهٔ تاریخچه، Retry رد می‌شود و Saga با وجه در Hold پایان می‌یابد (Codex دور ۲ روی #283، بازتولیدشده). بازگشت به نسخهٔ
قدیمی همان را وارونه دارد: کد قدیمی رسید را نمی‌خواند.

پس **استقرار فقط وقتی مجاز است که ثابت شده باشد هیچ Workflow سفارشی Activity در انتظار ندارد.** استثنایی نیست: نتوانستن
از بررسی هم استقرار را متوقف می‌کند.

## توالی حصاردار

| گام | کار                                                                                                                   | بررسی                                               |
| --- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| ۱   | Migration را اجرا کن (`pnpm --filter @rasta/marketplace-service db:migrate`)؛ کد قدیمی به جدول `saga_step` کاری ندارد | `20261015120000_saga_step` اعمال شده است            |
| ۲   | **همهٔ** نمونه‌های قدیمی marketplace-service را متوقف کن (Scale به صفر با SIGTERM؛ نه Rolling Update)                 | هیچ نمونه‌ای از نسخهٔ قدیمی اجرا نمی‌شود            |
| ۳   | Gate را اجرا کن (پایین)                                                                                               | خروجی `OK` و کد خروج `0` — و فقط همین               |
| ۴   | نسخهٔ جدید را بالا بیاور                                                                                              | `Order saga worker polling <queue>` در Log هر نمونه |

- گام ۲ را با `MARKETPLACE_TEMPORAL_ENABLED=false` انجام نده: نمونه‌ای که Temporal را خاموش دارد سفارش می‌سازد ولی Saga ـش
  را آغاز نمی‌کند، و آن سفارش هرگز از `PENDING` جلو نمی‌رود. نمونه باید متوقف باشد.
- میان گام ۲ و ۴ marketplace-service در دسترس نیست (سفارشی ثبت نمی‌شود). این بهای Gate است.
- خروجی گام ۳ (متن و کد خروج) و زمانش را در Change Record استقرار ثبت کن.

### گام ۳ — Gate

از ریشهٔ مخزن، با همان مقادیری که سرویس با آن‌ها اجرا می‌شود؛ هر سه اجباری‌اند و پیش‌فرض ندارند (بررسی Namespace یا Queue
اشتباه چیزی نمی‌یابد و می‌گذشت). TLS یا API Key: متغیرهای `TEMPORAL_*` خود CLI ـِ `temporal`، که به آن می‌رسند.

```bash
TEMPORAL_ADDRESS='<as the service>' TEMPORAL_NAMESPACE='<as the service>' \
  MARKETPLACE_TEMPORAL_TASK_QUEUE='<as the service>' \
  node scripts/marketplace-saga-drain-check.mjs
```

Gate دقیقاً این‌ها را می‌پرسد (همان Query ـِ Visibility؛ Visibility فعالیت در انتظار را نمایه نمی‌کند، پس هر Workflow جدا
`describe` می‌شود):

```bash
Q='WorkflowType="orderSaga" AND ExecutionStatus="Running"'
C=(--address "$TEMPORAL_ADDRESS" --namespace "$TEMPORAL_NAMESPACE")
temporal task-queue describe "${C[@]}" --task-queue "$MARKETPLACE_TEMPORAL_TASK_QUEUE" --output json  # .pollers باید null یا [] باشد
temporal workflow count "${C[@]}" --query "$Q" --output json                                          # n
temporal workflow list "${C[@]}" --query "$Q" --output json                                           # باید دقیقاً n اجرای یکتا باشد، بی تکرار
temporal workflow describe "${C[@]}" --workflow-id <id> --run-id <runId> --output json                 # هر ردیف یک بار: .pendingActivities نیست یا []
temporal workflow count "${C[@]}" --query "$Q" --output json                                          # باز همان n
```

Gate هیچ پاسخی را پیش از سنجیدن شکلش تفسیر نمی‌کند؛ شکل‌ها همان خروجی CLI ـِ Image سنجاق‌شده (`temporalio/auto-setup:1.26.2`)
روی سرور توسعه‌اند. هر شکل دیگر کد ۲ است (Codex دور ۳ روی #283):

| فرمان                 | تنها شکل پذیرفته                                                                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow count`      | `{"count": "<n>"}` (رشتهٔ رقمی) یا `{"count": <n>}` (عدد صحیح نامنفی)، و `{}` برای صفر (CLI صفر را نمی‌نویسد)؛ هیچ کلید دیگری نه                                                          |
| `task-queue describe` | شیئی با کلید `pollers` (`null` یا فهرست) و `stats` (فهرست)                                                                                                                                |
| `workflow list`       | فهرستی که هر ردیفش `execution.workflowId` و `execution.runId` و نوع `orderSaga` دارد و هیچ جفت (`workflowId`، `runId`) در آن دو بار نیست (Codex دور ۴)                                    |
| `workflow describe`   | `workflowExecutionInfo.execution` با همان `workflowId` **و** همان `runId` ردیف فهرست، نوع `orderSaga`، `executionConfig.taskQueue.name` همان Queue؛ `pendingActivities` نیست یا فهرست است |

| کد خروج | معنا                                                                                                                                                                                                                          | استقرار      |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `0`     | هیچ Poller روی Queue، شمار و فهرست یکی، هیچ Activity در انتظار                                                                                                                                                                | مجاز (گام ۴) |
| `1`     | Poller یا Activity در انتظار یافت شد (هر کدام نام برده می‌شود: Workflow، نوع Activity، وضعیت، تلاش)                                                                                                                           | **متوقف**    |
| `2`     | `cannot verify — deployment blocked`: تنظیمی نیست، CLI نیست یا شکست خورد، پاسخی با شکلی جز جدول بالا، اجرایی دو بار فهرست شده، شمار و اجراهای یکتای فهرست نمی‌خوانند، شمار در حین بررسی عوض شد، Workflow ـی روی Queue ـی دیگر | **متوقف**    |

### اگر Gate متوقف کرد

- **Poller (کد ۱).** یا نمونه‌ای از نسخهٔ قدیمی هنوز اجرا می‌شود (پیدا و متوقفش کن)، یا Temporal Worker ـِ متوقف‌شده را هنوز
  فهرست می‌کند — Temporal یک Poller را تا حدود پنج دقیقه پس از آخرین Poll فهرست می‌کند (روی سرور توسعه: ۵ دقیقه و ۹ ثانیه پس از
  کشتن Worker).
  صبر کن و گام ۳ را تکرار کن. تا Poller فهرست می‌شود، نسخهٔ جدید بالا نمی‌آید.
- **Activity در انتظار (کد ۱).** نسخهٔ جدید را بالا **نیاور.** نسخهٔ قدیمی را (همان Image) دوباره بالا بیاور تا کد قدیمی
  Activity ـِ خودش را به پایان برساند، صبر کن، و از گام ۲ تکرار کن. اگر آن Activity زیر نسخهٔ قدیمی هم تمام نمی‌شود (مثلاً
  economic-service در دسترس نیست)، اول همان را رفع کن؛ استقرار منتظر می‌ماند. Workflow را برای گذشتن از Gate هرگز
  `terminate` یا `reset` نکن: وجه در Hold می‌ماند و مسیر جبرانی ندارد ([`docs/24`](../24-open-questions.md) Q-118).
- **بررسی ممکن نشد (کد ۲).** دسترسی را درست کن (CLI، نشانی، TLS، Namespace) و گام ۳ را تکرار کن. راه «با این حال مستقر کن»
  نیست و یادداشت استثنا جای Gate را نمی‌گیرد.

## خودکارسازی

مخزن اسکریپت یا Job استقراری برای marketplace-service ندارد (`.github/workflows/ci.yml` فقط می‌سازد و می‌آزماید؛ Manifest
استقراری در مخزن نیست)، پس Gate فعلاً گامی دستی است. هر خط استقرار که ساخته شود باید همین اسکریپت را میان گام ۲ و ۴
اجرا کند و با هر کد خروج غیرصفر متوقف شود. رفتار Gate را `scripts/marketplace-saga-drain-check.test.mjs` در Job `quality`
ـِ CI می‌آزماید (`pnpm run test:marketplace-saga-drain-check`).
