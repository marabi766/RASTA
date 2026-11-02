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

## Durable start delivery (task 1214 A)

Placement commits its start intent on the order row. The immediate post-commit
start and the ten-second reconciliation sweep share the same fenced claim.
Each sweep claims at most four due rows in `(next_attempt_at, id)` order,
using the partial due index and `SKIP LOCKED`; retries advance their due key
by thirty seconds so one failed order cannot monopolize the head. A thirty-second
lease exceeds the bounded start RPC (five seconds, plus a one-second connect).
An expired claimant cannot acknowledge a newer claim. The receipt is retained
with the order; neither idempotency expiry nor outbox purge removes it.

Only accepted starts and `AlreadyStarted` acknowledge delivery. Disabled Temporal
and transport failures leave an intent pending. Recovery includes `CANCELLING`:
the workflow reads the committed cancellation, checks for an existing obligation,
and cancels without first creating a hold. Started-but-failed workflows require
operator reconciliation; the starter never deliberately creates a replacement.

Legacy rows have no requested timestamp. Their first possible start is conservatively
the order creation time. For any unacknowledged start older than the namespace's
current history retention (queried from Temporal, with a one-minute safety margin),
the starter describes the deterministic workflow id. Intent age is measured by the
database clock, so a worker clock skew cannot turn expired history into proof of absence. An existing execution, including
a closed/failed one, establishes delivery. Missing history is ambiguous and stays
pending: do not clear an intent or invent a receipt to silence the alert. Reconcile
Temporal archival/deployment records and economic ownership before an operator
chooses a recovery. The same protection covers acceptance followed by a crash before
acknowledgment, including a crash lasting beyond history retention. A deployment
that shortens retention after deleting older history also requires operator review.

`rasta_marketplace_saga_start_backlog` and
`rasta_marketplace_saga_start_backlog_age_seconds` expose counts/age only.
`RastaMarketplaceSagaStartBacklogAging` fires after age exceeds five minutes for
two minutes. Local Prometheus loads the rule; external notification routing remains
a deployment responsibility. Starter shutdown aborts active RPCs, joins database
work and stops polling before Prisma disconnects.

## Bounded transport and long waits (task 1214 B)

Every economic response, including refusals and obligation lookup pages, is read
into a buffer capped at 1 MiB. The shared exchange deadline remains active through
the stream read and JSON parse; a monotonic check refuses a parse that completes
after the deadline. Invalid JSON, invalid UTF-8, oversized bodies and malformed
refusal envelopes return fixed platform errors without copying body fragments.
No transport abort proves that a financial command did not commit: deterministic
order/operation keys and economic-service reconciliation remain authoritative.

Patched activities have a ten-second heartbeat timeout. They heartbeat immediately
and once per second while running; the production worker caps heartbeat throttling
at one second. Temporal's activity cancellation signal cancels the HTTP exchange,
and cancellation remains a `CancelledFailure`. Heartbeat intervals and exchange
listeners are removed on exit. Legacy activities without a heartbeat timeout do
not heartbeat. A cancelled transport neither reverses money nor marks an order
failed from transport evidence.

The workflow checks for rollover between waiting iterations, after all activities
have completed. It continues as new at 2,000 history events, 2 MiB, or an earlier
server suggestion. The assumed server defaults are hard limits of 51,200 events /
50 MiB, warnings at 10,240 events / 10 MiB, and suggestions at 4,096 events /
4 MiB. These are the [Temporal 1.26.2 defaults](https://github.com/temporalio/temporal/blob/v1.26.2/common/dynamicconfig/constants.go#L351),
matching the version pinned by Compose,
not verified production settings: this repository establishes no deployed history
overrides. Verify them when deploying. The
[SDK suggestion](https://typescript.temporal.io/api/namespaces/workflow/interfaces/WorkflowInfo)
is honored where available; the count/size bounds also work without that hint.
The internal test threshold can only lower the event ceiling.

A rollover carries both dispute identities, absolute reminder deadlines, status
and counters, and the monotonic activity sequence. Financial effects are already
recorded by their owner before a checkpoint; the new run re-reads that owner state.
It does not repeat initial hold placement. New activity receipt keys derive from
the order workflow id and a sequence carried across runs, never the new run id.
Financial HTTP keys remain derived from the order and operation/dispute identity.
Legacy numeric activity ids retain their previous receipt keys.

`order-saga-durable-rollover-v1` gates new activity options/identities and rollover.
Pre-change history replays the original commands; an existing live run can adopt
the patch at a later checkpoint. The checked-in synthetic 49-event pre-change
history and newly captured pre/post rollover histories are explicitly replayed
with `Worker.runReplayHistory` in the workflow test suite.
