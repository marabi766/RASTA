/**
 * The domain-projector consumer group. Also the `processed_event` key.
 *
 * A module of its own, importing nothing, because `config/env` needs it for the
 * `KAFKA_CONSUMER_GROUP` default and `main.ts` loads the environment before
 * `initTelemetry()`. Read from `audit.mapper`, it brought `@rasta/nest-common`
 * — and kafkajs behind it — into that prologue, so kafkajs loaded before the
 * instrumentation hooked require() and was never traced; nothing in the
 * service requires it again later to be patched then.
 * `scripts/service-telemetry-order.test.mjs` holds every built service to it.
 */
export const DOMAIN_PROJECTOR_CONSUMER = 'audit-service.domain-projector';
