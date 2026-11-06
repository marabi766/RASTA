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
- میان گام ۲ و ۴ هیچ نمونه‌ای گزارش نمی‌دهد و هیچ Worker ـی Poll نمی‌کند، پس `RastaMarketplaceSagaNoLiveWorker`،
  `RastaMarketplaceSagaStartBacklogAging` و `RastaMarketplaceSagaFinancialEpisodeOverdue` فعال می‌شوند. این انتظار می‌رود:
  فقط برای همین بازه، با شناسهٔ Change Record و پایانی معین، Silence کن ([`marketplace-saga-liveness`](marketplace-saga-liveness.md)).

### گام ۳ — Gate

پیش از گام ۲ زمان UTC را با `date -u +%Y-%m-%dT%H:%M:%S.000Z` ثبت کن و در همهٔ تکرارهای Gate
همان مقدار را در `MARKETPLACE_SAGA_STOP_TIME` نگه دار؛ زمان را به جلو نبر. بررسی باید پیش از انقضای
Retention تاریخچه و Visibility انجام شود؛ پس از آن، تطبیق عملیاتی لازم است.

Gate همیشه از ریشهٔ مخزن **جدیدترینِ انتشار در حال اجرا و انتشار هدف** اجرا می‌شود؛ در Rollback هرگز از Checkout
انتشار هدف اجرا نکن. با همان مقادیری که سرویس با آن‌ها اجرا می‌شود؛ هر پنج اجباری‌اند و پیش‌فرض ندارند (بررسی Namespace یا Queue
اشتباه چیزی نمی‌یابد و می‌گذشت). TLS یا API Key: متغیرهای `TEMPORAL_*` خود CLI ـِ `temporal`، که به آن می‌رسند.

```bash
TEMPORAL_ADDRESS='<as the service>' TEMPORAL_NAMESPACE='<as the service>' \
  MARKETPLACE_TEMPORAL_TASK_QUEUE='<as the service>' \
  MARKETPLACE_TARGET_PACKAGE_JSON='<package.json extracted from target image>' \
  MARKETPLACE_SAGA_STOP_TIME='<recorded UTC time>' \
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
temporal workflow show "${C[@]}" --workflow-id <id> --run-id <runId> --output json --no-json-shorthand-payloads # سازگاری نسخه
CQ="WorkflowType=\"orderSaga\" AND ExecutionStatus=\"ContinuedAsNew\" AND CloseTime >= \"$MARKETPLACE_SAGA_STOP_TIME\""
temporal workflow count "${C[@]}" --query "$CQ" --output json                                         # c
temporal workflow list "${C[@]}" --query "$CQ" --output json                                          # دقیقاً c اجرای یکتا
temporal workflow describe "${C[@]}" --workflow-id <id> --output json                                # اجرای جاری هر workflowId، بدون run-id
temporal workflow show "${C[@]}" --workflow-id <id> --run-id <currentRunId> --output json --no-json-shorthand-payloads # شناسهٔ اجرای پاسخ describe
temporal workflow count "${C[@]}" --query "$CQ" --output json                                         # باز همان c
temporal workflow count "${C[@]}" --query "$Q" --output json                                          # باز همان n
```

Gate هیچ پاسخی را پیش از سنجیدن شکلش تفسیر نمی‌کند؛ شکل‌ها همان خروجی CLI ـِ Image سنجاق‌شده (`temporalio/auto-setup:1.26.2`)
روی سرور توسعه‌اند. هر شکل دیگر کد ۱ است (Codex دور ۳ روی #283):

| فرمان                 | تنها شکل پذیرفته                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow count`      | `{"count": "<n>"}` (رشتهٔ رقمی) یا `{"count": <n>}` (عدد صحیح نامنفی)، و `{}` برای صفر (CLI صفر را نمی‌نویسد)؛ هیچ کلید دیگری نه                                                                                    |
| `task-queue describe` | شیئی با کلید `pollers` (`null` یا فهرست) و `stats` (فهرست)                                                                                                                                                          |
| `workflow list`       | فهرستی که هر ردیفش `execution.workflowId` و `execution.runId` و نوع `orderSaga` دارد و هیچ جفت (`workflowId`، `runId`) در آن دو بار نیست (Codex دور ۴)                                                              |
| `workflow describe`   | `workflowExecutionInfo.execution` با همان `workflowId` (و برای اجرای سنجاق‌شده همان `runId`)، وضعیت شناخته‌شده، نوع `orderSaga`، `executionConfig.taskQueue.name` همان Queue؛ `pendingActivities` نیست یا فهرست است |

| کد خروج | معنا                                                                                                                                                                                                                          | استقرار      |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `0`     | هیچ Poller روی Queue، هر دو شمار و فهرست یکی، اجرای جاری بررسی شده، هیچ Activity در انتظار                                                                                                                                    | مجاز (گام ۴) |
| `1`     | Poller یا Activity در انتظار یافت شد؛ جزئیات خروجی CLI چاپ نمی‌شود                                                                                                                                                            | **متوقف**    |
| `1`     | `cannot verify — deployment blocked`: تنظیمی نیست، CLI نیست یا شکست خورد، پاسخی با شکلی جز جدول بالا، اجرایی دو بار فهرست شده، شمار و اجراهای یکتای فهرست نمی‌خوانند، شمار در حین بررسی عوض شد، Workflow ـی روی Queue ـی دیگر | **متوقف**    |

### اگر Gate متوقف کرد

- **Poller (کد ۱).** یا نمونه‌ای از نسخهٔ قدیمی هنوز اجرا می‌شود (پیدا و متوقفش کن)، یا Temporal Worker ـِ متوقف‌شده را هنوز
  فهرست می‌کند — Temporal یک Poller را تا حدود پنج دقیقه پس از آخرین Poll فهرست می‌کند (روی سرور توسعه: ۵ دقیقه و ۹ ثانیه پس از
  کشتن Worker).
  صبر کن و گام ۳ را تکرار کن. تا Poller فهرست می‌شود، نسخهٔ جدید بالا نمی‌آید.
- **Activity در انتظار (کد ۱).** نسخهٔ جدید را بالا **نیاور.** نسخهٔ قدیمی را (همان Image) دوباره بالا بیاور تا کد قدیمی
  Activity ـِ خودش را به پایان برساند، صبر کن، و از گام ۲ تکرار کن. اگر آن Activity زیر نسخهٔ قدیمی هم تمام نمی‌شود (مثلاً
  economic-service در دسترس نیست)، اول همان را رفع کن؛ استقرار منتظر می‌ماند. Workflow را برای گذشتن از Gate هرگز
  `terminate` یا `reset` نکن: وجه در Hold می‌ماند و مسیر جبرانی ندارد ([`docs/24`](../24-open-questions.md) Q-118).
- **Protocol ناسازگار یا نشانهٔ ناشناس (کد ۱).** `requires saga protocol N` یعنی Image هدف Protocol لازم را اعلام نکرده است:
  Image سازگار بیاور یا اصلاحی روبه‌جلو منتشر کن. `unknown compatibility marker`، `unknown continuation state` یا `invalid start input`
  یعنی این Gate آن تاریخچه را نمی‌شناسد: Gate را از جدیدترین انتشار اجرا کن. Manifest را برای گذشتن از Gate هرگز دستی تغییر نده.
- **بررسی ممکن نشد (کد ۱).** دسترسی را درست کن (CLI، نشانی، TLS، Namespace) و گام ۳ را تکرار کن. راه «با این حال مستقر کن»
  نیست و یادداشت استثنا جای Gate را نمی‌گیرد.

## خودکارسازی

مخزن اسکریپت یا Job استقراری برای marketplace-service ندارد (`.github/workflows/ci.yml` فقط می‌سازد و می‌آزماید؛ Manifest
استقراری در مخزن نیست)، پس Gate فعلاً گامی دستی است. هر خط استقرار که ساخته شود باید همین اسکریپت را میان گام ۲ و ۴
از جدیدترینِ انتشار در حال اجرا و انتشار هدف با هر چهار متغیر گام ۳ اجرا کند و با هر کد خروج غیرصفر متوقف شود. رفتار Gate را `scripts/marketplace-saga-drain-check.test.mjs` در Job `quality`
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
two minutes, or when no replica reports the backlog for two minutes: a failed
sample withdraws the series rather than keeping its last value (#770 r2 F3). Local Prometheus loads the rule; external notification routing remains
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
It does not repeat initial hold placement. Activity receipt keys are run-scoped:
workflow id / run id / activity id, including legacy numeric activity ids. Patched
activity ids use a sequence carried across runs. Financial HTTP idempotency keys
remain derived from the order and operation/dispute identity, unchanged by rollover.

`order-saga-durable-rollover-v1` gates new activity options/identities and rollover.
Pre-change history replays the original commands; an existing live run can adopt
the patch at a later checkpoint. The checked-in synthetic 49-event pre-change
history and newly captured pre/post rollover histories are explicitly replayed
with `Worker.runReplayHistory` in the workflow test suite.

### Forward-only worker compatibility boundary

After adoption of `order-saga-durable-rollover-v1`, the minimum compatible worker
protocol is **1**. Draining activities does not make a downgrade safe. The gate
reads complete durable histories for the executions it inspects with `workflow show
--output json --no-json-shorthand-payloads` (the pinned CLI supports this flag;
[CLI reference](https://docs.temporal.io/cli/workflow#show)). It requires at least protocol 1
for either a recorded `core_patch` rollover marker or a start input carrying
`resume`, including a continued run before its first workflow task/activity;
later markers and `resume` fields require more (below).
Durable history proves protocol requirements for a discovered run; it does not
discover runs or establish visibility completeness. It adds no workflow commands.

Always run the gate from the **newest of the running and target releases**;
never use the target checkout when rolling back. Use the five-variable invocation
in step 3 above, including `MARKETPLACE_TARGET_PACKAGE_JSON`.

Extract `services/marketplace-service/package.json` from the **immutable target
image** as `MARKETPLACE_TARGET_PACKAGE_JSON`, never from the operator checkout.
`name` must be `@rasta/marketplace-service`. `marketplaceSagaProtocol` declares
support (this build: 3); an absent field means protocol **0**, the strictest legacy
capability, so pre-protocol images are checked without modifying their manifests.
Unreadable manifests, wrong names and malformed/unknown protocol values block
even an empty queue. An incompatible
target blocks regardless of pending activities. Missing/malformed markers,
unsupported payload encodings and incomplete histories (event sequence/length
checked against describe) also block. Never add protocol 1 to an old build to
bypass the gate: it must preserve both continuation state and patched commands.

Each later `patched()` id raises the protocol (`PATCH_PROTOCOL` in the gate):
`dispute-settle-resumes-order` requires **2**, `dispute-release-durable-wait-v1`
**3**. A marker the gate does not list blocks every target until the gate learns
it; a continuation's `resume` fields prove the same before its first marker
(`reminderDue`: 2, `releaseRounds`: 3; any unlisted field blocks; so does an
unlisted start input field). A target must declare at least what any inspected
history requires.

A build of #625 alone declares 1 although it writes the protocol-2 marker. Once a
saga holds that marker, the gate refuses that image as a target, rollback or
redeploy, even though it could replay the history: go forward to a build declaring
2 instead, and never edit its manifest. Rolling back from it, run the gate from a
build that has this table, not from #625's own checkout, whose gate reads a
continuation's `reminderDue` as protocol 1.

Use this gate for **every** deployment, including rollback. Once a running saga
requires a protocol, restore only a compatible image or ship a forward fix. Never
reset/terminate a saga to downgrade. Keep the stopped-worker/no-new-start window
above; a history change during inspection requires another drain/check.

## Unconfirmed dispute release (FU-080)

`RastaMarketplaceSagaFinancialEpisodeOverdue`
([`marketplace-saga-liveness`](marketplace-saga-liveness.md), reason
`DISPUTE_RELEASE`) fires once a release has been owed for an hour. It reads the
dispute's open `saga_unconfirmed_call` row, so it does not clear when the rounds
stop, the saga ends or no worker runs; it replaces the alert on
`rasta_marketplace_saga_release_unconfirmed_total`, which did (#792 r1). The
counter still counts rounds, for diagnosis. A decided dispute's
resolution has not been confirmed by economic-service: the obligation stays
DISPUTED and its funds held. The saga does not end. It waits in phase
`RELEASE_UNCONFIRMED` (`workflow query --name status`) and calls again with the
same idempotency key, doubling from one minute to one hour between rounds, so a
release that did commit is recognized and never repeated. Nothing is authorised,
settled or refunded for that order until it is confirmed, even if the buyer has
confirmed receipt; the saga then reads the order again and carries on.

The log line names the order and the last failure's code and words: read them
before deciding anything. `rasta_marketplace_economic_calls_total` does not
separate an outage from a refusal: its `REFUSED` counts every non-2xx answer, a
5xx or an in-flight conflict included. After restoring economic-service, try now
instead of waiting for the next round:

```bash
temporal workflow signal "${C[@]}" --workflow-id order-<orderId> --name retryDisputeRelease
```

A refusal that names the dispute can persist: economic-service holds a dispute
other than the one decided here, and the release must not clear it. Deciding that
dispute there does
not make this release confirmable: the order then needs a person's reconciliation,
with the funds still held. Terminating the saga belongs to that recorded decision,
never to silencing the alert or passing the gate. A waiting saga does not block the
gate, but its call in flight is a pending activity: with workers stopped it stays
pending, so follow the gate's pending-activity case above. One rollback edge: a
release whose last attempt failed just as workers stopped has no marker yet, so a
protocol-2 target passes the gate and then ends that saga as before this wait.

## رکورد فراخوانی‌های تأییدنشده (FU-104)

`saga_unconfirmed_call` رکورد پایدار فراخوانی‌هایی به economic-service است که نتیجه‌شان تأیید نشده است. ردیف پیش از فراخوانی نوشته می‌شود،
هر تلاش تازه آن را دوباره باز می‌کند و `generation` را جلو می‌برد، و فقط تأیید همان تلاش آن را می‌بندد؛ پس تأیید دیرهنگام تلاشی قدیمی‌تر چیزی را نمی‌بندد،
و ردیف با توقف Worker یا پایان Saga از بین نمی‌رود. فعلاً فقط `resolveObligationDispute` ثبت می‌شود، پس ردیف بسته فقط تأیید همان آزادسازی است و ثابت نمی‌کند بازپرداخت یا تسویهٔ پس از آن هم انجام شده است.
این جدول فقط ثبت می‌کند و تصمیمی نمی‌گیرد. `RastaMarketplaceSagaFinancialEpisodeOverdue` ردیف باز را یک ساعت پس از تصمیم اختلافش (یا پس از نخستین بازشدن، اگر اختلافی پشتش نباشد) دیرکرد می‌شمارد، با هر وضعیتی که سفارش داشته باشد ([`marketplace-saga-liveness`](marketplace-saga-liveness.md)).
برای دیدن ردیف‌های باز این پرس‌وجو را اجرا کن (`opened_at` زمان نخستین بازشدن است و با تلاش تازه جلو نمی‌رود):

```sql
SELECT organization_id, order_id, operation, subject AS dispute_id, generation, opened_at
FROM saga_unconfirmed_call WHERE confirmed_at IS NULL ORDER BY opened_at;
```

ردیف باز ثابت نمی‌کند وجه هنوز در Hold است؛ ثابت می‌کند که کسی خلافش را ثابت نکرده است. پس آن را با economic-service تطبیق بده (اختلاف باز هنوز چیزی برای آزادسازی ندارد).
ردیف را فقط با تصمیم ثبت‌شدهٔ تطبیق ببند، و با همان `generation` که خوانده‌ای، تا تلاشی که پس از خواندن تو آغاز شده بسته نشود. اگر `UPDATE 0` برگشت، دوباره بخوان و دوباره تطبیق بده:

```sql
UPDATE saga_unconfirmed_call SET confirmed_at = now()
WHERE organization_id = '<org>' AND order_id = '<order>' AND operation = 'resolveObligationDispute'
  AND subject = '<dispute>' AND generation = <generation> AND confirmed_at IS NULL;
```

### پرکردن گذشته

Migration برای **هر** اختلافی که سفارشش `COMPLETED` یا `CANCELLED` نیست ردیف می‌نویسد، چه اختلاف باز باشد چه تصمیم‌گرفته، چه Saga ـش زنده باشد چه بسته. هیچ رسید و هیچ زمانی
این را تغییر نمی‌دهد: رسید آزادسازی نمی‌گوید پاسخ کدام اختلاف است، زمانش با ساعت دیگری از زمان تصمیم ثبت می‌شود، و ممکن است دیر برسد یا هرگز نوشته نشود. پس آزادسازی‌ای که واقعاً
انجام شده هم ردیف می‌گیرد: Saga ـی که منتظر است ردیف خود را با تلاش بعدی‌اش می‌بندد (در فاز `RELEASE_UNCONFIRMED`، `retryDisputeRelease` آن را زودتر می‌کند)، و بقیه را با economic-service تطبیق بده، با همان مسیر بالا ببند و ثبت کن.
پس پس از نخستین استقرار `RastaMarketplaceSagaFinancialEpisodeOverdue` برای این ردیف‌ها فعال می‌شود؛ این انتظار می‌رود و تا بسته‌شدن آخرین ردیف دیرکرد فعال می‌ماند.

Migration پیش از توقف نسخهٔ قدیمی اجرا می‌شود (گام ۱) و آن نسخه تا گام ۲ هنوز می‌تواند اختلافی را ثبت کند. پس **در هر تلاش استقرار، میان گام ۲ و ۴ این پرکردن را دوباره اجرا کن**، از جمله پس از Rollback: `db:migrate` دوم کاری نمی‌کند، و اختلافی که نسخهٔ قدیمی در این میان ثبت کرده ردیف نمی‌گیرد؛
همان عبارت Migration است، تکرارش بی‌خطر است و ردیف موجود را تغییر نمی‌دهد. از ریشهٔ مخزن اجرا کن. کد خروج غیرصفر (از جمله وقتی عبارتی پیدا نشود) استقرار را متوقف می‌کند،
و سطر `INSERT 0 <n>` در Change Record ثبت می‌شود:

```bash
set -o pipefail
sed -n '/^-- BACKFILL BEGIN/,/^-- BACKFILL END/p' \
  services/marketplace-service/prisma/migrations/20261105130000_saga_unconfirmed_call/migration.sql |
  node scripts/psql-prisma-url.mjs DATABASE_URL_MARKETPLACE_MIGRATOR -X -v ON_ERROR_STOP=1 -f - |
  grep -E '^INSERT 0 [0-9]+$'
```

`scripts/psql-prisma-url.mjs` تنها تبدیل نشانی Prisma به libpq است: `psql` پارامتر `?schema=` را نمی‌پذیرد، و این ابزار آن را به `search_path` تبدیل می‌کند، پس Schema ـی غیر از `public` هم از دست نمی‌رود. نشانی مبهم یا پارامتری که شاید گذرواژه داشته باشد (مانند `sslpassword`) رد می‌شود. این تبدیل از راه `PGOPTIONS` است، پس Migrator باید مستقیم به PostgreSQL وصل شود، چون PgBouncer آن را دور می‌ریزد (FU-144).

`down.sql` این Migration رکورد فراخوانی‌های باز را از بین می‌برد: پیش از اجرایش همین فهرست را ثبت کن.

## Continued-as-new visibility gap (FU-046)

The gate uses continued-as-new predecessors closed at or after the recorded stop
time, then describes each distinct workflow's **current** run by workflow id
without a run id. This preserves deployment with idle running sagas while checking
successors that RUNNING visibility may not have indexed. Both lists must contain
unique executions and match their counts; count changes, partial pagination,
unknown output/status, and describe failures block. A current running successor
absent from the running list also blocks, even with no pending activities.

Exit 0 proves only the observations made during this check: no listed poller,
complete count-matched lists, and no pending activities in the inspected listed
and current runs. It does not prove zero running workflows, completed settlements,
or that held funds cannot move after workers resume. All old replicas must remain
stopped, no other worker may poll this queue, and the stop timestamp must precede
the shutdown and remain within history/visibility retention. This is not an atomic
snapshot or an independent guarantee that Temporal visibility is fully up to date.
