# Consumer crash loop

A terminal KafkaJS `CRASH` (`restart=false`) makes `EventConsumer.isRunning()` false,
marks the service's readiness and liveness unavailable, counts `rasta_consumer_crashes_total`, and
starts the existing graceful shutdown with a non-zero exit. The total fatal shutdown
budget, including telemetry, is `SHUTDOWN_TIMEOUT_MS`. During bootstrap, before shutdown
can be installed, the process exits non-zero immediately. Liveness reports this internal terminal failure too; process exit is the restart
mechanism. An unhealthy Docker healthcheck does not restart a container.

KafkaJS emits STOP and DISCONNECT before CRASH even when it will restart. Those events
alone do not trigger exit. `restart=true` stays running through reconnection. Normal
shutdown and consumers disabled by configuration never request a fatal exit.

The crash counter has only `service`, `group` and the closed `reason` values
`message_too_large`, `protocol_error`, `connection_error`, `other`. Every reason starts
at zero. The terminal log contains that classification and, when a message failed,
its topic, partition and offset. It contains no error message, arbitrary error name,
payload, record key, record bytes or headers. One instance crashing stops all of its
assigned partitions; another member may acquire them after rebalance.

1. Inspect `RastaConsumerCrash`, `RastaConsumerServiceRestartLoop`, service metrics loss,
   `RastaConsumerLag`, `RastaConsumerOffsetsMissing` and `RastaKafkaExporterUnavailable`.
   Read supervisor exit/restart history and the terminal log for the service and group.
   Find the original record using the logged topic, partition and offset through an
   authorized operator reader. Treat its contents as sensitive; do not paste it into logs.
2. Check every partition assigned to that instance and the group's committed offsets.
   A failed record is **never committed or skipped** by crash recovery. A handler whose
   database effect committed before the offset may run again; its transactional marker,
   source uniqueness or convergent write must absorb that replay. Existing tenant and
   source-owner checks still apply before any new financial effect.
3. Repair the source of the crash (including broker/topic sizing when appropriate), then
   let the supervisor restart with backoff. Do not reset, delete or advance offsets.
   Use the [existing DLQ triage/replay procedure](replay-dlq.md) for records already in a
   DLQ, preserving its refusal and owner-review requirements. An oversized rejected dead
   letter is still on the source, **not** in a new DLQ or a new skip path: fix admission
   first; the replay tool cannot recover a record never published to its DLQ.
4. Intervene before source retention expires. The default is seven days
   (`KAFKA_TOPIC_RETENTION_MS=604800000` in `create-topics.sh`); verify the actual topic
   retention and oldest retained offset. An uncommitted offset does not protect a source
   record from retention. Escalate an expired record for reconciliation, never claim it
   can still be replayed.

A supervisor restart policy is required: Docker `restart: on-failure`, or Kubernetes
`restartPolicy: Always` with its crash backoff. Apply an operational restart budget and
escalation; for a service manager configure a delay such as `RestartSec=30s` and a start
limit. Docker health status alone is insufficient. Backoff bounds restart frequency;
it never bounds attempts by dropping a record. No executable application deployment is
provided here: compose runs infrastructure and docs/12 contains deployment examples.

Prometheus directly scrapes all twelve consumer services. `RastaConsumerCrash` also
checks a positive counter during the process's first five minutes so a first sample
born at one is visible. After that, only a recent increase alerts: a recovered retriable
crash does not leave a permanent alert. A counter increment
can still disappear if the entire process incarnation occurs between scrapes. The
restart alert uses the actual `rasta_process_start_time_seconds` metric (default metrics
are prefixed), and catches more than two **observed** changes per target in 30 minutes.
It cannot count incarnations it never scraped; supervisor history is authoritative for
fast loops, and metrics-loss alerts cover longer blind windows. Production must retain
supervisor restart telemetry and route alerts to a person; this repository's local
Prometheus has no Alertmanager.

Generic lag is gated by the fixed groups in `TOPIC_CONSUMERS.groups` and the enabled
subscriptions each constructed consumer exports. Disabled consumers export no gate;
ephemeral groups cannot opt in. Positive lag for five minutes alerts. Missing offsets
or exporter `-1` values alert only when the source has retained records. An explicit
`-1` is checked against that same partition: an empty partition stays quiet even when
other partitions have traffic. A missing whole subscription uses topic retention. An exporter outage raises its separate absent/down
alert. Missing offsets are an observation gap, not a measured lag count. Per-partition
missing-series diagnosis, historical gate retention during service outages, and
non-default notification group aliases are deferred; inspect those with the broker
and supervisor while a service metrics-loss alert fires.

Fleet's asset-sync is an EventConsumer and follows this same terminal-crash path. Its
parked dead-letter **outbox** is separate: enqueue counts its DLQ metric, failed
publication is retried, and unpublished rows survive purge. A relay publication failure
is not a Kafka consumer crash; this change does not alter those semantics.
