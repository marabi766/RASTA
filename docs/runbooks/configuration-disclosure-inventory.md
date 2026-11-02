# Configuration disclosure inventory (task 1202, PR A)

PR A covers storage/endpoint SDK diagnostics and database connection boundaries (items 1+2).
PR B is the required follow-up for reporting sinks and their blanket guard (items 3+4).
The remaining entries below are not safety exemptions or a claim that the class is closed.
PR B can start from main: it must classify failures at its sinks independently of PR A.

## Boundaries covered by PR A

| Client / entry points                                                                                                  | Setting                                 | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document S3 construction, upload/download signing, copy, head, prefix, stream, remove, health                          | `S3_ENDPOINT`                           | Disable S3 Express session auth at client construction; refuse directory buckets (`--x-s3`) and Express access-point aliases (`--xa-s3`). No session-credential background work is supported. Validate http(s) without userinfo before SDK construction; fresh storage category and allowlisted code. Delayed stream failures cross a sanitizing bridge; 404/412, range/byte limits, backpressure and socket cleanup stay intact.                                                                                                                                                              |
| Gateway Redis construction, error events, consume, health, close                                                       | `REDIS_URL`                             | Refuse DEBUG ioredis tracing families (including wildcards) before client construction in every environment; validate Redis URL before SDK use; fixed construction errors and closed names/codes for logs. Reduce the INFO/NOPERM diagnostic before the SDK writes it directly; its existing ready-check decision is preserved. Health remains false; close failures remain swallowed as before. Credential-bearing Redis URLs remain supported.                                                                                                                                               |
| Marketplace Temporal client/worker construction, start, signal, run, close and SDK/Core diagnostics                    | `TEMPORAL_ADDRESS`                      | Install fixed-message grpc-js logging and ERROR verbosity on the declared grpc-js instance, verified against both Temporal client and worker native-connection paths before every connection, including after runtime installation. This contains GRPC_NODE_TRACE/GRPC_NODE_VERBOSITY aliases and ordinary error diagnostics (pings, proxy, metadata); legacy GRPC_TRACE/GRPC_VERBOSITY remain refused. Core uses the forwarded runtime logger. Closed categories/codes; discard SDK text/JSON/metadata/stack/cause. Duplicate-start/not-found branches and REJECT_DUPLICATE remain unchanged. |
| Notification SMTP construction/send, health, close                                                                     | `SMTP_HOST`                             | Send/health already return closed outcomes/reasons; close now throws a fresh fixed category/code. Nodemailer debug logging is disabled by default.                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Every PrismaService: construction, explicit/lazy connect, queries, transaction begin, disconnect                       | Per-service registered database setting | One shared `createSafePrismaClient` boundary. Connection-acquisition failures (P10xx, P2024, P2037) are replaced independently of initialization, on model/raw queries and interactive/batch transactions. Other query/domain errors retain their identity; no retry or SQL/transaction-option changes.                                                                                                                                                                                                                                                                                        |
| Portal unresolved-request Redis (`apps/web/src/server/unresolved-request.ts`, defaultStore)                            | `WEB_REDIS_URL`                         | Same construction-time DEBUG tracing refusal and INFO/NOPERM protection as the gateway; existing unavailable-store behavior is retained.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Portal refresh-coordinator Redis (`apps/web/src/server/session-refresh.ts`, defaultCoordinator)                        | `WEB_REDIS_URL`                         | Same construction-time DEBUG tracing refusal and INFO/NOPERM protection as the gateway; existing bounded command timeouts are retained.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Shared runtime-role preflight                                                                                          | Per-service registered database setting | Replaces regex-shaped codes with a closed allowlist. Existing role refusals and cleanup policy are preserved.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| jose JWKS client (`packages/nest-common/src/auth/token-verifier.ts`)                                                   | `OIDC_JWKS_URI`                         | Existing `readUrl` fixed refusal and `mapJoseError` fixed platform errors; auth code is outside this task and unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| OpenTelemetry exporters (`packages/observability/src/telemetry.ts`)                                                    | Registered OTEL endpoint settings       | Existing SDK construction/start/shutdown replacement boundary from #426; unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Kafka broker clients and shared logger (`packages/nest-common/src/kafka/log-creator.ts`, service publishers/consumers) | `KAFKA_BROKERS`, SASL settings          | Host:port configuration rather than a URL endpoint. Existing broker-shape restrictions do not prove diagnostic safety. Broader raw Kafka reporting is recorded for PR B; no closed-class claim.                                                                                                                                                                                                                                                                                                                                                                                                |

All 16 service factories are covered; each is probed through the actual built generated client, including lazy/transaction/disconnect paths. Each of the 80 lifecycle phases asserts its own sanitized failure and constructor/engine invocation; analytics uses onApplicationShutdown, and identity asserts its undrained close plus the sanitized log:

- `services/analytics-service/src/prisma/prisma.service.ts:40` — `DATABASE_URL_ANALYTICS`.
- `services/asset-service/src/prisma/prisma.service.ts:59` — `DATABASE_URL_ASSET`.
- `services/audit-service/src/prisma/prisma.service.ts:47` — `DATABASE_URL_AUDIT`.
- `services/construction-service/src/prisma/prisma.service.ts:87` — `DATABASE_URL_CONSTRUCTION`.
- `services/contract-service/src/prisma/prisma.service.ts:69` — `DATABASE_URL_CONTRACT`.
- `services/document-service/src/prisma/prisma.service.ts:70` — `DATABASE_URL_DOCUMENT`.
- `services/economic-service/src/prisma/prisma.service.ts:91` — `DATABASE_URL_ECONOMIC`.
- `services/fleet-service/src/prisma/prisma.service.ts:64` — `DATABASE_URL_FLEET`.
- `services/identity-service/src/prisma/prisma.service.ts:152` — `DATABASE_URL_IDENTITY`.
- `services/inventory-service/src/prisma/prisma.service.ts:70` — `DATABASE_URL_INVENTORY`.
- `services/maintenance-service/src/prisma/prisma.service.ts:69` — `DATABASE_URL_MAINTENANCE`.
- `services/marketplace-service/src/prisma/prisma.service.ts:67` — `DATABASE_URL_MARKETPLACE`.
- `services/notification-service/src/prisma/prisma.service.ts:98` — `DATABASE_URL_NOTIFICATION`.
- `services/organization-service/src/prisma/prisma.service.ts:30` — `DATABASE_URL_ORGANIZATION`.
- `services/procurement-service/src/prisma/prisma.service.ts:58` — `DATABASE_URL_PROCUREMENT`.
- `services/supplier-service/src/prisma/prisma.service.ts:96` — `DATABASE_URL_SUPPLIER`.

## Reporting follow-up: every service CLI sink found

These seven handlers stay unchanged in PR A. Their original error exits remain in force; PR B must reduce every foreign failure, including cleanup failures, without claiming prior batches rolled back.

| Sink                                                                            | Error exit | Disposition                                                    |
| ------------------------------------------------------------------------------- | ---------- | -------------------------------------------------------------- |
| `services/fleet-service/src/fleet/clear-transferred.cli.ts:66`                  | 2          | PR B: fixed reporting and regression/mutant coverage required. |
| `services/fleet-service/src/fleet/drain-check.cli.ts:66`                        | 2          | PR B: fixed reporting and regression/mutant coverage required. |
| `services/identity-service/src/keycloak/projection.cli.ts:122`                  | 2          | PR B: fixed reporting and regression/mutant coverage required. |
| `services/asset-service/src/insurance/reproject.cli.ts:67`                      | 2          | PR B: fixed reporting and regression/mutant coverage required. |
| `services/asset-service/src/insurance/drain-check.cli.ts:52`                    | 2          | PR B: fixed reporting and regression/mutant coverage required. |
| `services/asset-service/src/outbox/flush.cli.ts:109`                            | 2          | PR B: fixed reporting and regression/mutant coverage required. |
| `services/economic-service/src/transaction/resolved-dispute-backfill.cli.ts:44` | 1          | PR B: fixed reporting and regression/mutant coverage required. |

Asset/fleet drain-check still distinguish drained (0), undrained (1), and error (2). Economic backfill still exits 1 on failure. No CLI source or exit decision is changed in PR A.

## Script reporting sweep

The broad sweep searches every `scripts/*.mjs` for error-message/string/stack and child-stderr references. The table records every candidate in non-`*.test.mjs` files, including false positives; it does not silently mark a candidate safe. Test files are assertion/fixture surfaces, not operational diagnostic sinks. `refusal-probes.mjs` deliberately inspects complete errors so regressions fail.

```sh
rg -n '(error|err|e)\.message|String\((error|err|e)\)|\.stderr|\.stack' scripts -g '*.mjs' -g '!*.test.mjs'
```

| Site                                                        | Disposition / reason                                                                                        |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `scripts/verify-grafana-dashboard-probe.mjs:263`            | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/kafka-outbox-tables.mjs:64`                        | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/disposable-broker.mjs:29`                          | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/aggregation-campaign-log-recovery-lib.mjs:216`     | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/aggregation-campaign-accounting-lib.mjs:153`       | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/check-kafka-topic-limits.mjs:56`                   | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/verify-migration-reversible-lib.mjs:4222`          | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/verify-migration-reversible-lib.mjs:4551`          | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/verify-migration-reversible.mjs:265`               | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/verify-migration-reversible.mjs:267`               | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/ci-image-matrix.mjs:50`                            | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/ci-image-matrix.mjs:51`                            | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/ci-image-matrix.mjs:60`                            | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/replay-dlq-lib.mjs:750`                            | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/replay-dlq-lib.mjs:762`                            | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/replay-dlq-lib.mjs:767`                            | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/refusal-probes.mjs:29`                             | Test helper: inspect whole errors to detect disclosure; never an operational reporter.                      |
| `scripts/refusal-probes.mjs:30`                             | Test helper: inspect whole errors to detect disclosure; never an operational reporter.                      |
| `scripts/ci-trivy-db-lib.mjs:421`                           | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/ci-trivy-db-lib.mjs:869`                           | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/ci-trivy-db-lib.mjs:1231`                          | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/ci-trivy-db-lib.mjs:1425`                          | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/ci-trivy-db-lib.mjs:1550`                          | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/ci-trivy-db-lib.mjs:1660`                          | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/ci-trivy-db-lib.mjs:1693`                          | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/testing-dev-only-source.mjs:849`                   | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/testing-dev-only-source.mjs:1666`                  | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/aggregation-evidence.mjs:244`                      | Child-output capture/cleanup; PR B must audit every downstream reporting use.                               |
| `scripts/aggregation-evidence.mjs:251`                      | Stream cleanup/error listener; does not print the foreign data.                                             |
| `scripts/aggregation-evidence.mjs:272`                      | Stream cleanup/error listener; does not print the foreign data.                                             |
| `scripts/aggregation-evidence.mjs:274`                      | Stream cleanup/error listener; does not print the foreign data.                                             |
| `scripts/service-env-withheld-base.mjs:66`                  | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/service-env-withheld-base.mjs:119`                 | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/prisma.mjs:99`                                     | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/prisma.mjs:123`                                    | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/backup-restore-drill.mjs:9`                        | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/container-scope-proof.mjs:18`                      | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/container-scope-proof.mjs:50`                      | Fixed literal argument/test-count refusal; no foreign diagnostic.                                           |
| `scripts/container-scope-buildx.mjs:24`                     | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/backup-restore-drill-test-support.mjs:607`         | Test-only process/fixture diagnostics; keep failure evidence for assertions.                                |
| `scripts/backup-restore-drill-test-support.mjs:646`         | Test-only process/fixture diagnostics; keep failure evidence for assertions.                                |
| `scripts/backup-restore-drill-test-support.mjs:689`         | Test-only process/fixture diagnostics; keep failure evidence for assertions.                                |
| `scripts/check-kafka-credential-scope.mjs:34`               | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/progress.mjs:18`                                   | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/outbox-b2-backfill.mjs:229`                        | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/outbox-b2-backfill.mjs:253`                        | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/container-scope-lib.mjs:90`                        | Comment only; no runtime output.                                                                            |
| `scripts/container-scope-lib.mjs:92`                        | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/run-test-phases.mjs:36`                            | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/run-test-phases.mjs:57`                            | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/progress-schema.mjs:25`                            | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/container-scope.mjs:84`                            | Fixed literal argument/test-count refusal; no foreign diagnostic.                                           |
| `scripts/verify-security-event-outbox-migration.mjs:168`    | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/marketplace-saga-drain-check.mjs:70`               | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/marketplace-saga-drain-check.mjs:245`              | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/verify-grafana-dashboard-isolation-lib.mjs:35`     | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/verify-grafana-dashboard-isolation-lib.mjs:39`     | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/verify-test-independence.mjs:141`                  | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/verify-test-independence.mjs:152`                  | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/verify-test-independence.mjs:224`                  | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/verify-test-independence.mjs:234`                  | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/outbox-b2-vacuum.mjs:168`                          | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/outbox-b2-vacuum.mjs:182`                          | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/check-unit-step-concurrency-lib.mjs:705`           | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/check-unit-step-concurrency-lib.mjs:901`           | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/check-unit-step-concurrency-lib.mjs:909`           | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/verify-outbox-claim-migration.mjs:288`             | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/verify-outbox-claim-migration.mjs:345`             | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/verify-outbox-claim-migration.mjs:364`             | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/check-db-runtime-privileges.mjs:53`                | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/check-db-runtime-privileges.mjs:66`                | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/check-db-runtime-privileges.mjs:70`                | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/verify-audit-correction-command-migration.mjs:134` | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/ci-trivy-db.mjs:30`                                | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/ci-trivy-db.mjs:38`                                | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/check-kafka-credential-scope-lib.mjs:190`          | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/runtime-preflight.e2e.mjs:371`                     | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/runtime-preflight.e2e.mjs:525`                     | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/kafka-acl.mjs:54`                                  | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/kafka-acl.mjs:64`                                  | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/kafka-acl.mjs:78`                                  | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/kafka-acl.mjs:82`                                  | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/kafka-acl.mjs:135`                                 | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/kafka-acl.mjs:146`                                 | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/backup-restore-drill-main.mjs:90`                  | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/backup-restore-drill-main.mjs:106`                 | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/backup-restore-drill-main.mjs:119`                 | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/backup-restore-drill-main.mjs:135`                 | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/backup-restore-drill-main.mjs:163`                 | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/backup-restore-drill-main.mjs:164`                 | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/backup-restore-drill-main.mjs:194`                 | Stream cleanup/error listener; does not print the foreign data.                                             |
| `scripts/backup-restore-drill-main.mjs:231`                 | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/backup-restore-drill-main.mjs:294`                 | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/backup-restore-drill-main.mjs:314`                 | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/backup-restore-drill-main.mjs:464`                 | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/backup-restore-drill-main.mjs:522`                 | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/backup-restore-drill-main.mjs:761`                 | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/backup-restore-drill-main.mjs:814`                 | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/backup-restore-drill-main.mjs:831`                 | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/backup-restore-drill-main.mjs:897`                 | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/ci-integration-split-lib.mjs:343`                  | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/ci-integration-split-lib.mjs:741`                  | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/check-test-phases.mjs:105`                         | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/backup-restore-drill-lib.mjs:1267`                 | Stream cleanup/error listener; does not print the foreign data.                                             |
| `scripts/backup-restore-drill-lib.mjs:1290`                 | Stream cleanup/error listener; does not print the foreign data.                                             |
| `scripts/backup-restore-drill-lib.mjs:1319`                 | Child-output capture/cleanup; PR B must audit every downstream reporting use.                               |
| `scripts/replay-dlq.mjs:72`                                 | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/replay-dlq.mjs:88`                                 | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/replay-dlq.mjs:107`                                | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/replay-dlq.mjs:124`                                | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/replay-dlq.mjs:434`                                | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/replay-dlq.mjs:454`                                | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/replay-dlq.mjs:455`                                | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/testing-dev-only.mjs:77`                           | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/testing-dev-only.mjs:185`                          | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/testing-dev-only.mjs:280`                          | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/verify-grafana-dashboard-live.mjs:60`              | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/verify-grafana-dashboard-live.mjs:62`              | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/verify-grafana-dashboard-live.mjs:76`              | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/verify-grafana-dashboard-live.mjs:79`              | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/verify-grafana-dashboard-live.mjs:234`             | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/verify-grafana-dashboard-live.mjs:311`             | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/verify-grafana-dashboard-live.mjs:324`             | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/verify-grafana-dashboard-live.mjs:327`             | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/verify-seed-guard.mjs:115`                         | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/verify-seed-guard.mjs:146`                         | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/verify-seed-guard.mjs:164`                         | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/verify-seed-guard.mjs:168`                         | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/verify-seed-guard.mjs:213`                         | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/aggregation-evidence-lib.mjs:1258`                 | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/check-grafana-dashboard-lib.mjs:689`               | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/check-dockerfile-pins-lib.mjs:488`                 | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/check-dockerfile-pins-lib.mjs:729`                 | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/outbox-b2-lib.mjs:746`                             | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |
| `scripts/aggregation-campaign-workflow-lib.mjs:292`         | PR B provenance audit/reduction required; deferred by the prescribed 1+2 / 3+4 split, not exempted as safe. |

PR B must also cover indirect Temporal child JSON/stack at `scripts/marketplace-saga-drain-check.mjs:92,:245`, not only stderr, and first-connection/cleanup failures in both outbox B2 CLIs. Preserve fail-closed deployment gates, partial-work reporting, and all exits (outbox B2 and saga gate errors: 1).

## Preserved business behavior

Only connection/reporting infrastructure changes. The settlement authority, reward-trigger and statement-settlement consumers are unchanged (`settlement-authority.consumer.ts:137`, `reward-trigger.consumer.ts:610,:622`, `statement-settlement.consumer.ts:121` in economic-service). Maintenance command bodies, tenant context, replay IDs, pagination/resume and under-lock rechecks are unchanged (`reproject.command.ts:24–40,:138–147`, `clear-transferred.command.ts:102–140`). No new product or governance decision.
