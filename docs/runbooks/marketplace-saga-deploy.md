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
انتشار هدف اجرا نکن. با همان مقادیری که سرویس با آن‌ها اجرا می‌شود؛ هر شش اجباری‌اند و پیش‌فرض ندارند (بررسی Namespace یا Queue
اشتباه چیزی نمی‌یابد و می‌گذشت). TLS یا API Key: متغیرهای `TEMPORAL_*` خود CLI ـِ `temporal`، که به آن می‌رسند.

```bash
TEMPORAL_ADDRESS='<as the service>' TEMPORAL_NAMESPACE='<as the service>' \
  MARKETPLACE_TEMPORAL_TASK_QUEUE='<as the service>' \
  MARKETPLACE_TARGET_PACKAGE_JSON='<package.json extracted from target image>' \
  MARKETPLACE_STOPPED_PACKAGE_JSON='<package.json extracted from the image just stopped>' \
  MARKETPLACE_SAGA_STOP_TIME='<recorded UTC time>' \
  DATABASE_URL_MARKETPLACE='<as the service>' \
  node scripts/marketplace-saga-drain-check.mjs
```

پس از همهٔ پرسش‌های Temporal، Gate جدول `saga_unconfirmed_call` را می‌خواند (FU-221، D-151): **هر** رکورد باز، با هر عملیات
(`createObligation`، `authoriseSettlement`، `settle`، `compensate`، `resolveObligationDispute`)، استقرار را متوقف می‌کند. Temporal
چنین رکوردی را نشان نمی‌دهد: مجوزی که سفارش حصارش کرده Saga را بی Activity ـِ در انتظار تمام می‌کند و رکوردش باز می‌ماند، و
فراخوانی‌ای که economic-service هنوز پاسخش را نداده شاید فقط از نسخه‌ای که آن را فرستاده پاسخ بگیرد. خواندن با `psql` ـِ روی PATH
است، از راه `scripts/psql-prisma-url.mjs` (گذرواژه در `PGPASSWORD`، نه در argv)، با همان نقش زمان اجرای سرویس که پایش سرویس
همین جدول را با آن می‌خواند (جدول RLS ندارد؛ اگر روزی داشته باشد Gate رد می‌کند، چون پاسخ خالی آن‌گاه از Policy است نه از جدول).
جدول با Schema ـِ نشانی (`?schema=`) نام برده می‌شود، پس Pooler ـی که `search_path` را دور بریزد Schema ـِ دیگری را نمی‌خواند.
یک تراکنش `READ ONLY` با `statement_timeout` ده ثانیه و `lock_timeout` پنج ثانیه؛ ردیف‌ها از Index ـِ جزئی
`ix_saga_unconfirmed_call_open` خوانده می‌شوند و تاریخچهٔ بسته‌شده پیموده نمی‌شود. نشانی تنها ورودی اتصال است (#947): باید Host،
Port و نام پایگاه را صریح داشته باشد؛ پارامتری که اتصال را جابه‌جا می‌کند (`service`، `hostaddr`، `host`، `port`، `dbname`، `user`
و هر پارامتر libpq بیرون از فهرست مجاز Gate) رد می‌شود؛ هیچ متغیر `PG*` ـِ محیط (`PGHOSTADDR`، `PGPORT`، `PGDATABASE`، `PGSERVICE`،
`PGPASSFILE`، `PGSSLMODE` و …) به `psql` نمی‌رسد، پس تنظیم TLS هم باید در خود نشانی باشد، همان‌جا که سرویس آن را می‌خواند. همان
دستور `current_database()` و `inet_server_port()` را هم برمی‌گرداند؛ اگر با نشانی نخوانند، Gate رد می‌کند (کد ۱، `cannot verify`)؛
پس Port ـِ نشانی باید Port ـی باشد که خود PostgreSQL روی آن گوش می‌دهد، نه Port ـِ نگاشت‌شده یا Pooler.

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
# خواندن saga_unconfirmed_call (بالا)، سپس:
temporal task-queue describe "${C[@]}" --task-queue "$MARKETPLACE_TEMPORAL_TASK_QUEUE" --output json  # دوباره: .pollers باید null یا [] باشد
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
| `0`     | هیچ Poller روی Queue، هر دو شمار و فهرست یکی، اجرای جاری بررسی شده، هیچ Activity در انتظار، هیچ رکورد فراخوانی باز                                                                                                            | مجاز (گام ۴) |
| `1`     | Poller (پیش یا پس از خواندن جدول)، Activity در انتظار یا رکورد فراخوانی باز (`open saga call record: order …`) یافت شد؛ جزئیات خروجی CLI چاپ نمی‌شود                                                                          | **متوقف**    |
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
  Image سازگار بیاور یا اصلاحی روبه‌جلو منتشر کن. `unknown compatibility marker`، `unknown continuation state`، `invalid start input`، `unknown activity result`، `unreadable activity result` یا `an activity result without its scheduling`
  یعنی این Gate آن تاریخچه را نمی‌شناسد: Gate را از جدیدترین انتشار اجرا کن. Manifest را برای گذشتن از Gate هرگز دستی تغییر نده.
- **رکورد فراخوانی باز (کد ۱، `open saga call record`).** نسخهٔ جدید را بالا **نیاور.** سطر سفارش، سازمان، عملیات، `subject`،
  `generation` و سنّ رکورد را نام می‌برد. با economic-service تطبیقش بده، همان‌طور که
  [`marketplace-saga-liveness`](marketplace-saga-liveness.md) § «The drain gate refuses: an open call record» می‌گوید؛ رکورد را
  هرگز برای گذشتن از Gate، با گذشت زمان، نگه‌داری کلید یا وضعیت سفارش، دستی نبند (D-135، #836 N1). `unknown operation` یعنی
  نسخه‌ای تازه‌تر از این Gate آن را نوشته است: Gate را از جدیدترین انتشار اجرا کن.
- **بررسی ممکن نشد (کد ۱).** دسترسی را درست کن (CLI، نشانی، TLS، Namespace) و گام ۳ را تکرار کن. راه «با این حال مستقر کن»
  نیست و یادداشت استثنا جای Gate را نمی‌گیرد.

## خودکارسازی

مخزن اسکریپت یا Job استقراری برای marketplace-service ندارد (`.github/workflows/ci.yml` فقط می‌سازد و می‌آزماید؛ Manifest
استقراری در مخزن نیست)، پس Gate فعلاً گامی دستی است. هر خط استقرار که ساخته شود باید همین اسکریپت را میان گام ۲ و ۴
از جدیدترینِ انتشار در حال اجرا و انتشار هدف با همهٔ متغیرهای گام ۳ اجرا کند و با هر کد خروج غیرصفر متوقف شود. رفتار Gate را `scripts/marketplace-saga-drain-check.test.mjs` در Job `quality`
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
sample withdraws the series rather than keeping its last value (#770 r2 F3). An older economic-service causes it too: no saga starts until
`GET /v1/transactions/capabilities` says yes (outcome `economic_not_ready` on
`rasta_marketplace_saga_start_deliveries_total`), and those orders stay unclaimed and
start by themselves after the upgrade (ADR-040). Local Prometheus loads the rule; external notification routing remains
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
never use the target checkout when rolling back. Use the six-variable invocation
in step 3 above, including `MARKETPLACE_TARGET_PACKAGE_JSON` and
`MARKETPLACE_STOPPED_PACKAGE_JSON`.

Extract `services/marketplace-service/package.json` from the **immutable target
image** as `MARKETPLACE_TARGET_PACKAGE_JSON`, never from the operator checkout.
`name` must be `@rasta/marketplace-service`. `marketplaceSagaProtocol` declares
support (this build: 12); an absent field means protocol **0**, the strictest legacy
capability, so pre-protocol images are checked without modifying their manifests.
Unreadable manifests, wrong names and malformed/unknown protocol values block
even an empty queue.

`MARKETPLACE_STOPPED_PACKAGE_JSON` is the same file from the image of the release just
stopped, read the same way. **Rollback floor (D-150):** when the stopped release declares
protocol **11** or more, the gate refuses every target below 11, even with no saga running.
It sees only that release: a rollback done without the gate leaves nothing for a later run
of it to see, which is why economic-service's refusal below, not the floor, is what keeps
an older build's send from landing.
That release counts each hold send on the order row (`hold_send_claims`), and writes 0 on
an order it places: an order placed and not yet started has no saga for the gate to inspect,
and a build below 11 would send its hold uncounted. A stopped release newer than the gate's
checkout is refused too: run the gate from the newest release. An incompatible
target blocks regardless of pending activities. Missing/malformed markers,
unsupported payload encodings and incomplete histories (event sequence/length
checked against describe) also block. Never add protocol 1 to an old build to
bypass the gate: it must preserve both continuation state and patched commands.

Each later `patched()` id raises the protocol (`PATCH_PROTOCOL` in the gate):
`dispute-settle-resumes-order` requires **2**, `dispute-release-durable-wait-v1`
**3**, `economic-call-durable-wait-v1` **4**, `economic-sibling-call-durable-wait-v1`
**5**, `saga-owed-work-durable-v1` **6**, `authorisation-order-fence-v1` **7**, `economic-hold-call-durable-wait-v1` **8**, `economic-hold-refusal-exit-v1` **9**, `economic-hold-send-fence-v1` **10**, `economic-hold-fence-on-order-v1` **11**, `economic-refusal-reconciles-held-v1` **12**. A marker the gate does not list blocks every target until the gate learns
it; a continuation's `resume` fields prove the same before its first marker
(`reminderDue`: 2, `releaseRounds`: 3, `unconfirmedCall`: 4, `siblingCall`: 5, `outstandingWork`: 6, `holdCall`: 8, `lateHoldWatch`: 9, `holdNotAfter`: 10; any unlisted field blocks; so does an
unlisted start input field). A target must declare at least what any inspected
history requires. A recorded result counts as well, whether or not a workflow task has
read it (`resultProtocol`): stop the workers right after an authorisation completes
and the next worker reads the answer first, with no marker yet. An `authoriseSettlement`
answer of `{fenced, status, inDoubt}` requires **7**, because a build below it reads it
as "authorised".

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
release an older build scheduled, whose last attempt failed just as workers stopped, has
no marker yet, so a protocol-2 target passes the gate and then ends that saga as before
this wait. One a protocol-6 build scheduled carries the protocol-6 marker from the start.

## Unconfirmed economic call (FU-103)

`RastaMarketplaceSagaEconomicCallUnconfirmed` is the same wait for another economic
call, labelled `operation`, with the same limit: it counts rounds, so it clears
with workers stopped. Those calls are `createObligation` (phase `HOLD_UNCONFIRMED`),
`authoriseSettlement` (`AUTHORISATION_UNCONFIRMED`), `settle` (`SETTLEMENT_UNCONFIRMED`),
`disputeObligation` (`DISPUTE_UNCONFIRMED`) and `compensate` (`COMPENSATION_UNCONFIRMED`).
Except for `disputeObligation`, which has no call record yet, the call's open
`saga_unconfirmed_call` row does not clear with workers stopped: it keeps
`RastaMarketplaceSagaFinancialEpisodeOverdue` (reason `UNCONFIRMED_CALL`) firing once it is
an hour old, until economic-service answers (FU-145). economic-service gave no answer proving the
call changed nothing, so it may have committed; the call is repeated under the same key,
doubling from one minute to one hour, and nothing settles meanwhile. After restoring
economic-service, try now with the same signal, which keeps its name:
`--name retryDisputeRelease`.

Each authorisation goes out with the order's row held (`FOR SHARE`, for at most 2 s;
D-138), after the row as it stands has been checked. An order no longer in
`RECEIPT_CONFIRMED` or `SETTLING` is not sent for, on any attempt or round: the saga
follows the order, and this writes a warning naming the status, not an alert. So a
dispute or an operator's decision can wait up to 2 s behind a send in progress. When
economic-service is that slow, the call goes unconfirmed here and the next attempt
reads the obligation first. A party's command that times out behind the lock is a 5xx
it can retry under its own key.

Only a refusal the activity marks as proof says the call changed nothing: its own refusal,
by the receipt guard or the send, with a code in `PROVEN_REFUSALS` (`economic-refusal.ts`),
on the first attempt this run scheduled. It no longer ends the saga while the money may be
held (protocol 12, D-127; see "Refused on its first attempt" below). A `temporal workflow
reset` starts a new run with first attempts and no memory of the old ones, so read the
obligation before resetting such a saga. A code
says nothing of the attempts before it, so once any attempt went unconfirmed no code
ends the wait: not a listed 4xx, not a routing or configuration fault, not a failed
read of the order or of the obligation (`RECONCILIATION_READ_FAILED`). From then on
each failed send reads the obligation.
Its effect (`PENDING_SETTLEMENT`, `SETTLED`, or disputed after this saga's own
authorisation) is the answer and the saga goes on. `REFUNDED`, `CANCELLED` or `FAILED`
is an answer too, since no late request can move them; see "Owed work" below.
Anything else stays in this phase, `HELD` included: an earlier request can still
commit, so `HELD` proves nothing.

The filing and the refund (FU-117) follow the same rules with their own effects:
`DISPUTED` with this dispute's words for the filing, `REFUNDED` for the refund. Every
other terminal status (`SETTLED` included) is the same kind of answer. While an
authorisation the saga moved on from is still in doubt, even their first attempt's
refusal does not end it. A filing is sent until answered even once the order has left
that dispute, because filed unseen it would leave the obligation `DISPUTED` with nothing
to release it; once answered, the saga mirrors the decision before anything else.

The hold (FU-117) has no transaction to read, so its only answers are a request
answered or the order's obligation found, asked after every failed send. An empty lookup
ends nothing unless the send was refused on its first attempt: a request still on its way
can commit after the lookup, and `FAILED` would leave those funds held with nothing to
release them. Under this wait the order stays `PENDING`, or `CANCELLING` if the buyer
cancels. The saga goes on sending even then, because only an answered key fences a late
request off; if the send is then answered, the saga refunds it. An obligation found that
is not `HELD` or not on the order's terms stops the saga as it always did
(`OBLIGATION_NOT_HELD`, `OBLIGATION_TERMS_MISMATCH`). With economic-service down, a lookup that cannot answer
counts as a round.

A refusal that persists, an empty wallet say, ends this wait only behind a fence
(protocol 10, D-132). The saga's first send fixes a deadline, 24 h on (`HOLD_FENCE` in
`economic-refusal.ts`), and every request under the key carries it as `holdNotAfter`,
across rollovers too. economic-service judges it by its own database clock, in the
transaction that writes the claim and again in the hold's own, as the last thing before its
answer. Past it, `422 HOLD_DEADLINE_PASSED` with nothing recorded or held, and the key answers
that from then on, whenever a stalled request arrives and whatever
`ECONOMIC_IDEMPOTENCY_TTL_HOURS` says: a purged record is claimed anew and refused again.
A transaction that passed that last check and then sits idle for 30 s is ended by
PostgreSQL, so it cannot commit later.

The saga closes the order only on all three together: a request **sent** more than the
margin (1 h, the same constant) past the deadline, that refusal to it, and an empty lookup
after it. A 5xx, a timeout or any other code keeps the saga here with the alert on,
past the deadline too, as does a guard refusing before the key is reached. So a hold in doubt
ends within about 26 h of its first send once economic-service answers, and an outage that long
fails the order instead of placing the hold when the service returns. A pod that dies holding the
claim leaves it `IN_PROGRESS`, answering `CONFLICT` until it expires, so retention can still
delay this end (up to `ECONOMIC_IDEMPOTENCY_TTL_HOURS` after that claim), though it no longer
decides whether a hold can land. The order closes
`FAILED`, or `CANCELLED` if the buyer cancelled, which returns its stock, and the saga sends
nothing more. For one more margin the phase is `LATE_HOLD_WATCH`: the saga asks at most
hourly and refunds a hold that was already committing, and the order stays closed; a failed
lookup or refund counts as a `compensate` round, and a status no refund can reach stays in
`OBLIGATION_RECONCILIATION`. A closed order cannot move, so reconciliation on one does not
clear by itself: once the obligation is settled by hand, terminate that saga. **Do not
terminate or cancel a saga in this wait** to clear the alert: check the obligation at
economic-service and escalate.

**The fence is on the order row, so no run has to remember it (protocol 11, D-144).** A run
cannot know what an earlier run sent. Before each send the activity counts it in
`hold_send_claims` and, on the first, fixes `hold_not_after`, one statement committed before the
request exists; the deadline never moves, and a trigger refuses any writer that tries. Every
request carries the row's deadline, whichever run sends it. So after a Temporal reset, or for
any run that finds the row so:

- A refusal is proof only for the first send there has ever been, on its first attempt, and only
  once `hold_sends_closed_at` is set. An older run's attempt arriving after that sends nothing;
  one that claimed in between keeps the refusal from being proof.
- An empty lookup is proof only if `noHoldCanLand` says so from the row: no send ever began, the
  sends are closed, or the database's clock is past `hold_not_after` plus the margin.
- A run that first reads `CANCELLING` waits there, sending nothing, with the alert on, until then.
  One that first reads `FAILED` or `CANCELLED` watches until then and refunds a hold that lands.

Resetting a saga whose order this build placed is therefore safe for the money. It is still no way to clear an alert: the
replacement waits out the same deadline.

**An older build's send cannot land (D-150).** A build below protocol 11 sends the hold
counting nothing on the row and carrying no deadline, so the row cannot know of it. So
economic-service refuses every `ORDER` hold without `holdNotAfter`, whoever sends it:
`422 HOLD_DEADLINE_REQUIRED`, nothing held or recorded, the key left free
(`refuseUnfencedOrderHold`). An answer already stored under the key is still replayed: that
hold exists, and the saga finds it. What the row says of earlier sends is therefore true of
every hold that can still land, whichever build sent it, and no marketplace-service rollback
can make it false. It does depend on economic-service itself running this build or a later
one (below). The cost is fail-closed: from the moment economic-service
runs this build, a marketplace-service build below 11 places no hold at all, so its orders fail
at the hold, nothing held, until workers of this build run. Keep that window short. The rollback
floor above is a second line: it keeps such a build from following this one through the gate,
so a rollback of economic-service alone still meets only counted sends.

**Migrate marketplace-service before its new workers (`20261107120000_order_hold_fence`).** Only
additive. Its `down.sql` refuses while a deadline is still in use: on any order not ended, or on
a closed order with no obligation whose sends are open and whose deadline and margin have not
passed. It needs code below protocol 11, which the gate refuses after this build (the floor):
only for an environment where this build never served traffic.

**Deploy economic-service first.** Its request schema is strict, so a build without the
fence refuses `holdNotAfter` with `400 VALIDATION_FAILED` rather than ignoring it. That
keeps the fence fail-closed through a rollback: a saga in doubt goes on waiting. But a new
marketplace-service ahead of it fails each new order on its first send, nothing held. Do not
roll economic-service back below this build either: an older one holds a send without a
deadline again (above).

**The row is proof only while economic-service says so (FU-233).** `GET
/v1/transactions/capabilities` answers `orderHoldDeadlineRequired: true` only from a build that
refuses an `ORDER` hold without its deadline (the answer is asked of `refuseUnfencedOrderHold`
itself). The saga asks it each time it would trust the row: before it counts and sends a hold,
before a refusal or `HOLD_DEADLINE_PASSED` becomes proof, in `noHoldCanLand`, and when it reads a
closed order with no obligation. It trusts the row on an explicit `true` only. An explicit no is
`false`, or `heldProven: true` without the field (a build before D-150). An outage, a timeout or
a body no release sends (`{}`, an array, a field that is not a boolean) is no answer, never a
lasting no. Each question is asked three times, 250 ms and 1 s apart, inside the activity's
heartbeat, before it counts as unanswered. Without a yes, it sends nothing and counts nothing
(`ECONOMIC_HOLD_RULE_UNCONFIRMED`, not retried within the attempt's scheduling, so the hold's
next round sends on a first attempt, with the `createObligation` alert on). It takes no refusal
and no empty lookup as proof. A first send's refusal heard while the question goes unanswered
is kept on the row (sends closed), and the next round's yes ends the order on it; an explicit no
leaves the sends open (review of #948 r1, F1). Either way the hold's call record (FU-145) stays
open: only a refusal proven on the yes asked after the send confirms it. On an explicit no it
reads a closed order's row as if it were from before the fence, so it keeps watching and refunds a hold that lands. With no
answer at all, that read is retried until an answer comes, so a blip leaves nothing behind. So
if economic-service is rolled back below D-150 while this build runs, orders stall with the
alert on, and no hold is left stranded (review of
#812 r4, N1 trigger a). That is an outage, not a deploy step. A closed order read during it
stays in `LATE_HOLD_WATCH` with no deadline even after economic-service is back: a person ends
that saga once the lookup shows nothing held.

What this does not cover:

- The answer is point-in-time, from one replica. A mixed-version economic-service, or both
  services rolled back and forward again in the time between a saga's decision and a late send,
  is still prevented only by the deploy order below.
- Unreleased heads at protocol 9–10 send a deadline without counting it (r4 N1 b). economic-service
  accepts their sends and truthfully answers yes, so only the gate's floor stops them.
- A late-hold watch with a deadline ends at the deadline and margin without asking again (review
  of #948 r1, L3): economic-service's fence on the deadline is what refuses a later counted send.
  A send without a deadline landing after that needs economic-service rolled back below D-150
  during the watch, which is the point-in-time case above.

**Rollback order.** It is the reverse of the deploy order, and both halves are required:

1. Roll marketplace-service back first, through this gate. The gate refuses a target below 11
   once the stopped build reached 11 (the floor), so this applies only where that build never
   served traffic. Otherwise roll forward.
2. Roll economic-service back below D-150 only after that, once no marketplace-service build at
   11 or above is running or can start. A build at 11 or above stalls on the missing capability
   (above). A build below 11 is never safe beside an economic-service below D-150 once orders
   counted on the row exist: that pair is the original r3 F1.

The gate sees only marketplace-service's manifests, so it does not check step 2. A gate on
economic-service deploys that reads marketplace-service's running protocol is proposed as a
stacked follow-up (FU-233 STATUS).

A saga whose first send predates protocol 10 carries no deadline, and economic-service now
refuses such a request (above), so its hold never lands, but the saga cannot know that from its
row: nothing can prove it will not land, so that saga never
takes this exit and waits as protocol 8 did. This is safe only because the platform has not
launched: no real money waits on such a run. Before launch, drain them: every new send of
theirs is refused, so each one not yet held waits for good with the alert on (fail-closed:
nothing more is held for it; a hold it already placed is still found and followed). `hold_send_claims` defaults to 1 with no deadline, on every
order the migration finds and any an older build places during the rollout (only `place` of this
build writes 0), so a later run of such an order gets no deadline either, and nothing on its row
proves absence: it waits with the alert on, and one that finds such an order closed stays in
`LATE_HOLD_WATCH`. A protocol-9 `LATE_HOLD_WATCH`, which has no deadline to pass, no longer ends when its time is up:
it stays with the alert on (`createObligation`, "A hold sent with no deadline"), and an order it
had not yet closed stays open. It ends when a hold lands and is refunded, or the obligation is found
terminal with nothing to refund; otherwise check the obligation at economic-service, then terminate
it as part of the drain. Its input may still carry `economicKeyRetentionHours`
from protocol 9; it decides nothing live. That exit is kept for replay alone, and a history
that took it replays it. `HOLD_FENCE` decides what a live history does: changing it needs a new patch.

**Operator check: a hold on a closed order.** No longer the only guarantee: the fence is what
stops a late request, and this check is a second look at it. Run it after an incident in this wait, and for
sagas closed by an older build, which had no fence; no automatic detector exists yet (FU-167).
Compare the two services (separate databases, no join): `SELECT id, source_reference FROM
"transaction" WHERE source_type = 'ORDER' AND status = 'HELD';` at economic-service, then
`SELECT id, status FROM "order" WHERE id = ANY($1) AND status IN ('FAILED', 'CANCELLED');` at
marketplace-service with those `source_reference` values. Any row is money held for an
order that has ended, including the accepted cutover edge of a protocol-5 saga past its
decision that closed as cancelled on an empty lookup: refund that obligation under the
platform's refund procedure and record why.

A wait that will not clear shows why in the log line's code: fix the route or
configuration and signal. For a real refusal at `HELD` (a persistent
`IDEMPOTENCY_KEY_REUSED`, say) read the transaction at economic-service and reconcile
by hand before terminating anything. For `BUSINESS_RULE_VIOLATION` on an order with no
receipt, follow `marketplace-receipt-evidence.md`. A dispute also takes the saga out of
the wait; the doubt goes with it, so if the order comes back to settlement the call
is sent as in doubt, not as new, and a failure returns to this phase.

Each round of an authorisation reads the order first, and a party's signal starts one
early; a filing's or refund's round does neither, and only the signal above starts one.
Once a dispute is raised or decided the authorisation stops being sent, but the saga stays
in this phase until economic-service answers a read of the obligation; only then
does it file the dispute or refund. One rollback edge, as for the release: a call an older
build scheduled, whose last attempt failed just as workers stopped, has no marker yet, so a
target one protocol below it (3 for an authorisation, 4 for a filing or refund, 7 for the
hold) passes the gate and ends that saga as before this wait.

Protocol 5 is forward-only like the others, with its own marker: a protocol-4 history
carrying `economic-call-durable-wait-v1` from an authorisation may have ended at a
filing or refund, and replays that end. A protocol-4 saga still running when this build
deploys takes the new wait at its next such call.

Protocol 8 is the hold's, with its own marker and its own resume field (`holdCall`), so that
the gate refuses a lower target for a saga in that wait: that build has no such wait,
ends the same history in `FAILED`, and refuses a resumed run at `PENDING`. A saga
a lower protocol started takes the wait if its hold is still unanswered when this build deploys; a
history in which a lower protocol already recorded `FAILED` replays that end.

Protocol 9 is the exit from that wait, with its own marker and its own resume field
(`lateHoldWatch`), so that the gate refuses a lower target for a saga that gave its hold up:
that build would send the hold again, or close without the watch. Retired by protocol 10: no
live run takes it, and a history that recorded it replays it.

Protocol 10 is the fence, with its own marker at the first send and its own resume field
(`holdNotAfter`), so that the gate refuses a lower target for a saga whose requests carry a
deadline: that build would send under the same key without one, and be refused for ever.

### Owed work (FU-117, protocol 6)

The saga no longer ends with financial work outstanding on a refused read, lookup or
local step. It stays and reports rounds on the same alert, under the operation it owes:

| Phase                                                        | What it means                                                                                                                                                                                          | What ends it                                                                                     |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `SETTLEMENT_NOT_RECORDED`                                    | `markSettling`, `markSettlementFailed`, `markObligationDisputed` or `markCompleted` was refused; the log names the step                                                                                | the step answering; fix the order's refusal, then send the signal above                          |
| `CANCELLATION_NOT_RECORDED`                                  | `markCancelled` was refused after the refund, so availability and `ORDER_CANCELLED` are still to come                                                                                                  | the same                                                                                         |
| `COMPENSATION_UNCONFIRMED`, before any refund                | a cancelled order with no recorded transaction, whose lookup was refused or incomplete                                                                                                                 | the lookup answering                                                                             |
| `COMPENSATION_UNCONFIRMED`, a round saying "does not show"   | a continued run's lookup came back empty, with no proof its hold is not on its way                                                                                                                     | the obligation being found, or a person who has shown no hold exists correcting the order        |
| `ORDER_UNREADABLE`                                           | a read of the order was refused past the saga's first read, with no other work owed                                                                                                                    | the read answering                                                                               |
| `OBLIGATION_NOT_HELD`, `OBLIGATION_MISMATCH` at `CANCELLING` | the lookup found an obligation the saga cannot refund: other terms, or a status such as `SETTLED`, `DISPUTED`, `PENDING_SETTLEMENT` or `CREATED`                                                       | a person reconciling it                                                                          |
| `OBLIGATION_RECONCILIATION`                                  | the owner's status is terminal and the order cannot follow it: a refund told `SETTLED`, a filing told final with the order still `DISPUTED`, an authorisation told `REFUNDED`, `CANCELLED` or `FAILED` | the order leaving that status (an operator's decision, or a person's correction at `CANCELLING`) |
| `OBLIGATION_RECONCILIATION`, a round naming a refusal code   | the refund, filing or authorisation was refused on its first attempt with the money possibly held (D-127, below)                                                                                       | the call answering, or the owner's terminal status as above                                      |

The owner's status decides, and only for a refund or a filing that can no longer land.
`REFUNDED`, `CANCELLED` or `FAILED` at a cancellation means no money is left to return,
so `markCancelled` runs, restoring availability and publishing `ORDER_CANCELLED`.
`SETTLED`, or a status nobody listed, never cancels the order: read the settlement and
reconcile by hand. A filing told final mirrors nothing, because there is nothing to release,
and a release told final ends its wait for the same reason.

A settlement attempt that failed puts everything after it in doubt, across rollovers:
a filing's or refund's first-attempt refusal then waits for the owner, as above. Five
failed attempts still end the saga with `SETTLEMENT_EXHAUSTED` for a human
(`docs/08` § 8.4). A refused `recordReminder` holds nothing up: it is reported, and the
next window records one. Only a refused first read, with nothing yet sent, still ends
the saga.

### Refused on its first attempt (D-127, protocol 12)

A refund, filing or authorisation refused on its first attempt (`FORBIDDEN`, `NOT_FOUND`,
`BUSINESS_RULE_VIOLATION` or another code in `PROVEN_REFUSALS`) changed nothing, but that
does not return the money. The saga reads the order's obligation once. Only if it is that
transaction, terminal, with its funds `RETURNED` or `NEVER_HELD` (`CREATED` excluded), does
the refusal still end the saga as before. Anything else waits: `HELD`, `SETTLED`, another
transaction, none at all, other terms, or a lookup that fails. The phase is
`OBLIGATION_RECONCILIATION`, each round is counted under the call's `operation` on
`RastaMarketplaceSagaEconomicCallUnconfirmed` with the refusal code in the log, and each
round sends the call again under the same key, in doubt. So a refusal whose cause a person
removes (a role, a rule) is answered on the next round or at the signal above. Once the
obligation is terminal, its status decides as in the table: a refund confirmed (`REFUNDED`),
or funds returned or never held, lets `markCancelled` run; `SETTLED`, or any other status,
never cancels the order. The doubt is carried across a rollover, so no later round ends on
a code. **Do not terminate a saga in this wait** to clear the alert: read the obligation at
economic-service, remove the refusal's cause or settle it by hand, then send the signal;
for an order `RECEIPT_CONFIRMED` with no receipt, follow `marketplace-receipt-evidence.md`
instead and settle nothing. A build below protocol 12 that picks up a run continued from
this wait keeps waiting in doubt, showing the call's `*_UNCONFIRMED` phase.
A history from before protocol 12 that ended on such a refusal replays that end
(fixtures `pre-fu158-*`).

Protocol 6 is forward-only like the others. Every exit above replays its old end from a
history without `saga-owed-work-durable-v1` (fixtures `pre-fu117r2-*`). A refund, filing,
authorisation or release can answer with a final status, which a workflow below protocol 6
would read as the call's own effect (`markCancelled` on a paid-out order), so nothing
reaches such a workflow, by two fences (PR-796 r2 F5):

- A live workflow asks the marker right before scheduling one of these calls and declares
  that it reads the answer (`FINAL_ANSWER_CONTRACT`), so the marker commits with the
  command. Any run that has sent one of them on this build needs protocol 6. A call that
  declared nothing gets the refusal it got before this release: the activity's original
  refusal, or for an authorisation in doubt the marked `OBLIGATION_ALREADY_FINAL`.
- The gate also reads every activity result recorded in each saga's current run: a final
  answer requires protocol 6 with or without a marker. For those four calls, a result in
  no known shape blocks every target. An activity it does not list blocks every target too,
  and any other call's result may not carry a final answer; those calls' results did not
  change, so the gate does not pin their shapes.

The requirement is per run. A run continued past an answer it has dealt with needs protocol
6 only if it carries that work (`outstandingWork`); otherwise it holds no such answer, and
on an older build it sends the older calls and gets the older refusals.

## رکورد فراخوانی‌های تأییدنشده (FU-104)

`saga_unconfirmed_call` رکورد پایدار فراخوانی‌هایی به economic-service است که نتیجه‌شان تأیید نشده است. ردیف پیش از فراخوانی نوشته می‌شود،
هر تلاش تازه آن را دوباره باز می‌کند و `generation` را جلو می‌برد، و فقط تأیید همان تلاش آن را می‌بندد؛ پس تأیید دیرهنگام تلاشی قدیمی‌تر چیزی را نمی‌بندد،
و ردیف با توقف Worker یا پایان Saga از بین نمی‌رود. آزادسازی (`resolveObligationDispute`) و نیز مجوز تسویه (`authoriseSettlement`)، تسویه (`settle`) و بازپرداخت (`compensate`) ثبت می‌شوند (FU-145)، که `subject` آن سه شناسهٔ تراکنش است؛ ردیف بسته فقط تأیید همان فراخوانی است. بازپرداخت تأییدشده ردیف‌های باز مجوز و تسویهٔ همان تراکنش را هم می‌بندد، چون `REFUNDED` پایانی است. ایجاد تعهد (`createObligation`، که `subject` آن شناسهٔ سفارش است) هم پیش از ارسال ثبت می‌شود و فقط با پاسخ خودش، با ردی که ثابت می‌کند چیزی نگه داشته نشده (فقط برای نخستین ارسالِ همان دوره، در نخستین تلاشِ همان زمان‌بندی، و فقط وقتی این نخستین ارسالی باشد که ردیف سفارش تاکنون شمرده و ارسال‌ها بسته شده باشند (D-144)، چون رد کلید را آزاد می‌کند و تلاش Worker قدیمی‌تر رکوردی ننوشته است؛ رد `HOLD_DEADLINE_PASSED` آن را نمی‌بندد)، یا با جست‌وجویی که تعهد خود سفارش را بیابد بسته می‌شود؛ جست‌وجوی خالی آن را نمی‌بندد (#836 r1). هر ردیف فرمان زمان‌بندی‌شده‌ای را که مالک آن است نام می‌برد (`command`)، و تلاشِ فرمانی قدیمی‌تر پیش از فراخوانی رد می‌شود (`SAGA_CALL_SUPERSEDED`)، پس پاسخ آن هرگز ردیف فرمانی تازه‌تر را نمی‌بندد.
این جدول فقط ثبت می‌کند و تصمیمی نمی‌گیرد. `RastaMarketplaceSagaFinancialEpisodeOverdue` ردیف باز را یک ساعت پس از تصمیم اختلافش (یا پس از نخستین بازشدن، اگر اختلافی پشتش نباشد) دیرکرد می‌شمارد، با هر وضعیتی که سفارش داشته باشد ([`marketplace-saga-liveness`](marketplace-saga-liveness.md)).
برای دیدن ردیف‌های باز این پرس‌وجو را اجرا کن (`opened_at` زمان نخستین بازشدن است و تا ردیف باز است با تلاش تازه جلو نمی‌رود؛ فراخوانی تأییدشده‌ای که دوباره انجام شود از نو آغاز می‌شود):

```sql
SELECT organization_id, order_id, operation, subject AS dispute_id, generation, opened_at
FROM saga_unconfirmed_call WHERE confirmed_at IS NULL ORDER BY opened_at;
```

ردیف باز ثابت نمی‌کند وجه هنوز در Hold است؛ ثابت می‌کند که کسی خلافش را ثابت نکرده است. پس آن را با economic-service تطبیق بده (اختلاف باز هنوز چیزی برای آزادسازی ندارد).
ردیف را فقط با تصمیم ثبت‌شدهٔ تطبیق ببند، آن هم فقط وقتی economic-service اثر همان فراخوانی را نشان دهد، و با همان `generation` که خوانده‌ای، تا تلاشی که پس از خواندن تو آغاز شده بسته نشود. نبودِ تراکنش در جست‌وجو، وضعیت پایانی سفارش، یا گذشت زمان (حتی بیش از مدت نگه‌داری کلید، که از لحظهٔ Claim شمرده می‌شود) هرگز دلیل بستن نیست (D-135). ردیف `createObligation` را هرگز دستی نبند: تا حصار زمان Claim در economic-service (D-132) روی main نیامده، چیزی ثابت نمی‌کند ایجادی که دیر رسیده بعداً ثبت نشود ([`marketplace-saga-liveness`](marketplace-saga-liveness.md) گام ۷؛ بستن پس از آن حصار FU-161 است). اگر `UPDATE 0` برگشت، دوباره بخوان و دوباره تطبیق بده:

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
